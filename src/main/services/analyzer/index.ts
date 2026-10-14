// Builds the project graph for the tree view: which files and functions call which,
// and where config and data get loaded or written. Static analysis only; nothing is executed.
//
// Three passes over the parsed files:
//   1. collect every definition and import
//   2. note module-level variables (what class they hold, what file name they hold)
//   3. walk every call and link it to what it resolves to
import { readFile } from 'fs/promises'
import { join, posix } from 'path'
import type { Node, Parser, Tree } from 'web-tree-sitter'
import type { GraphEdge, GraphEdgeKind, GraphNode, ProjectGraph } from '../../../shared/api'
import { detectResource, filenameIn, type CallInfo, type ResourceUse } from './resources'

const MAX_PYTHON_FILES = 1500
const MAX_FILE_BYTES = 1_500_000
const IMPORT_FOLLOW_DEPTH = 5

/** Methods whose body runs when the class is instantiated, so their calls belong to the class node. */
const CONSTRUCTORS = new Set(['__init__', '__new__', '__post_init__'])

/** Decorators that only change how a function behaves, as opposed to registering it to be called by a framework. */
const PASSIVE_DECORATORS = new Set([
  'staticmethod', 'classmethod', 'property', 'setter', 'getter', 'deleter', 'wraps', 'dataclass',
  'lru_cache', 'cache', 'cached_property', 'abstractmethod', 'override', 'overload', 'final',
  'contextmanager', 'asynccontextmanager', 'total_ordering', 'singledispatch', 'singledispatchmethod'
])

/** Method names shared with built-in types, too ambiguous to match to a project method by name alone. */
const COMMON_METHODS = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'index', 'count', 'sort', 'reverse', 'copy',
  'get', 'items', 'keys', 'values', 'update', 'setdefault', 'add', 'discard', 'join', 'split', 'strip',
  'replace', 'format', 'startswith', 'endswith', 'lower', 'upper', 'encode', 'decode', 'read', 'write',
  'close', 'open', 'flush', 'seek', 'readline', 'readlines', 'send', 'put', 'find', 'exists', 'json'
])

let parserReady: Promise<Parser> | null = null

function getParser(): Promise<Parser> {
  parserReady ??= (async () => {
    const { Language, Parser } = await import('web-tree-sitter')
    await Parser.init()
    const parser = new Parser()
    parser.setLanguage(await Language.load(require.resolve('tree-sitter-python/tree-sitter-python.wasm')))
    return parser
  })().catch((error) => {
    parserReady = null
    throw error
  })
  return parserReady
}

interface Def {
  id: string
  kind: 'function' | 'method' | 'class'
  name: string
  qualname: string
  file: string
  line: number
  node: Node
}

/** What a name bound by an import statement refers to. `symbol` is null when the name is the module itself. */
interface ImportBinding {
  module: string
  level: number
  symbol: string | null
}

interface ImportRecord {
  module: string
  level: number
  symbols: string[]
  line: number
}

interface FileInfo {
  path: string
  dir: string
  tree: Tree
  moduleId: string
  defs: Map<string, Def>
  imports: Map<string, ImportBinding>
  starImports: ImportBinding[]
  importRecords: ImportRecord[]
  /** Module-level variables known to hold an instance of a project class. */
  vars: Map<string, Def>
  /** Module-level variables known to hold a file name. */
  strings: Map<string, string>
}

interface ModuleEntity {
  type: 'module'
  /** Path without extension: "pkg/mod" for pkg/mod.py, "pkg" for a package folder. */
  stem: string
  file: FileInfo | null
}

type Entity =
  | { type: 'def'; def: Def }
  | { type: 'instance'; cls: Def }
  | { type: 'super'; cls: Def }
  | ModuleEntity
  | { type: 'external'; name: string }

interface Scope {
  /** Graph node that calls made here belong to. */
  owner: string
  qual: string
  /** Qualified names of the enclosing functions, innermost first, for finding nested functions. */
  functionQuals: string[]
  /** Class whose method this is, for `self`, `cls` and `super()`. */
  cls: Def | null
  selfName: string | null
  /** Set while directly inside a class body. */
  classBody: Def | null
  vars: Map<string, Def>
  strings: Map<string, string>
  moduleLevel: boolean
}

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const joinPath = (base: string, parts: string[]): string => [base, ...parts].filter(Boolean).join('/')

class Analysis {
  readonly files = new Map<string, FileInfo>()
  readonly problems: ProjectGraph['problems'] = []
  private readonly dirs = new Set<string>([''])
  private readonly allFiles: Set<string>
  private readonly byBasename = new Map<string, string[]>()
  private readonly nodes = new Map<string, GraphNode>()
  private readonly edges = new Map<string, GraphEdge>()
  private readonly methodsByName = new Map<string, Def[]>()
  private readonly moduleCache = new Map<string, ModuleEntity | null>()
  private readonly baseCache = new Map<Def, Def[]>()
  private readonly attrCache = new Map<Def, Map<string, Def>>()
  private readonly entryDir: string

  constructor(
    allFiles: string[],
    private readonly entry: string
  ) {
    this.allFiles = new Set(allFiles)
    this.entryDir = dirOf(entry)
    for (const path of allFiles) {
      const matches = this.byBasename.get(baseOf(path))
      if (matches) matches.push(path)
      else this.byBasename.set(baseOf(path), [path])
    }
  }

  // ---------- Pass 1: definitions and imports ----------

  addFile(path: string, source: string, parser: Parser): void {
    const tree = parser.parse(source)
    if (!tree) {
      this.problems.push({ file: path, message: 'Could not be parsed.' })
      return
    }
    const file: FileInfo = {
      path,
      dir: dirOf(path),
      tree,
      moduleId: `mod:${path}`,
      defs: new Map(),
      imports: new Map(),
      starImports: [],
      importRecords: [],
      vars: new Map(),
      strings: new Map()
    }
    this.files.set(path, file)
    for (let dir = file.dir; dir; dir = dirOf(dir)) this.dirs.add(dir)
    if (tree.rootNode.hasError) {
      this.problems.push({ file: path, message: 'Has a syntax error, so some of its branches may be missing.' })
    }
    this.nodes.set(file.moduleId, { id: file.moduleId, kind: 'module', label: baseOf(path), file: path, line: 1 })
    this.collect(tree.rootNode, file, '', null)
  }

  private collect(node: Node, file: FileInfo, qual: string, classBody: Def | null): void {
    for (const child of node.namedChildren) {
      if (!child || child.namedChildCount === 0) continue
      switch (child.type) {
        case 'import_statement':
          this.collectImport(child, file)
          break
        case 'import_from_statement':
          this.collectFromImport(child, file)
          break
        case 'function_definition':
        case 'class_definition': {
          const name = child.childForFieldName('name')?.text
          if (!name) break
          const qualname = qual ? `${qual}.${name}` : name
          const isClass = child.type === 'class_definition'
          let def: Def | null = null
          if (!(classBody && !isClass && CONSTRUCTORS.has(name)) && !file.defs.has(qualname)) {
            const kind = isClass ? 'class' : classBody ? 'method' : 'function'
            def = { id: `def:${file.path}::${qualname}`, kind, name, qualname, file: file.path, line: child.startPosition.row + 1, node: child }
            file.defs.set(qualname, def)
            this.nodes.set(def.id, { id: def.id, kind, label: defLabel(def), file: file.path, line: def.line })
            if (kind === 'method') {
              const sameName = this.methodsByName.get(name)
              if (sameName) sameName.push(def)
              else this.methodsByName.set(name, [def])
            }
          }
          const body = child.childForFieldName('body')
          if (body) this.collect(body, file, qualname, isClass ? (def ?? file.defs.get(qualname) ?? null) : null)
          break
        }
        case 'expression_statement':
          break // Cannot contain definitions or imports.
        default:
          this.collect(child, file, qual, classBody)
      }
    }
  }

  private collectImport(node: Node, file: FileInfo): void {
    const line = node.startPosition.row + 1
    for (const item of node.childrenForFieldName('name')) {
      if (!item) continue
      if (item.type === 'aliased_import') {
        const module = item.childForFieldName('name')?.text
        const alias = item.childForFieldName('alias')?.text
        if (!module || !alias) continue
        file.imports.set(alias, { module, level: 0, symbol: null })
        file.importRecords.push({ module, level: 0, symbols: [], line })
      } else {
        // `import a.b.c` binds only `a`; the rest is reached through attribute access.
        const top = item.text.split('.')[0]
        file.imports.set(top, { module: top, level: 0, symbol: null })
        file.importRecords.push({ module: item.text, level: 0, symbols: [], line })
      }
    }
  }

  private collectFromImport(node: Node, file: FileInfo): void {
    const moduleNode = node.childForFieldName('module_name')
    let module = ''
    let level = 0
    if (moduleNode?.type === 'relative_import') {
      for (const part of moduleNode.namedChildren) {
        if (part?.type === 'import_prefix') level = part.text.trim().length
        else if (part?.type === 'dotted_name') module = part.text
      }
    } else if (moduleNode) {
      module = moduleNode.text
    }
    const symbols: string[] = []
    for (const item of node.childrenForFieldName('name')) {
      if (!item) continue
      const symbol = item.type === 'aliased_import' ? item.childForFieldName('name')?.text : item.text
      const bound = item.type === 'aliased_import' ? item.childForFieldName('alias')?.text : item.text
      if (!symbol || !bound) continue
      symbols.push(symbol)
      file.imports.set(bound, { module, level, symbol })
    }
    if (node.namedChildren.some((child) => child?.type === 'wildcard_import')) {
      file.starImports.push({ module, level, symbol: null })
    }
    file.importRecords.push({ module, level, symbols, line: node.startPosition.row + 1 })
  }

  // ---------- Resolving names ----------

  private stem(stem: string): ModuleEntity | null {
    const file = this.files.get(`${stem}.py`) ?? this.files.get(joinPath(stem, ['__init__.py']))
    if (file) return { type: 'module', stem, file }
    return this.dirs.has(stem) ? { type: 'module', stem, file: null } : null
  }

  /** Finds the project file or package an import refers to. Null means it is not part of the project. */
  private resolveModule(module: string, level: number, from: FileInfo): ModuleEntity | null {
    const key = `${level}|${module}|${from.dir}`
    const cached = this.moduleCache.get(key)
    if (cached !== undefined) return cached

    const parts = module ? module.split('.') : []
    let found: ModuleEntity | null = null
    if (level > 0) {
      let base: string | null = from.dir
      for (let up = 1; up < level && base !== null; up++) base = base ? dirOf(base) : null
      if (base !== null) found = this.stem(joinPath(base, parts))
    } else if (parts.length) {
      // Python looks next to the running script first; projects also commonly run from the root or use src/.
      for (const base of new Set([from.dir, this.entryDir, '', 'src'])) {
        found = this.stem(joinPath(base, parts))
        if (found) break
      }
    }
    this.moduleCache.set(key, found)
    return found
  }

  private resolveBinding(binding: ImportBinding, from: FileInfo, depth: number): Entity | null {
    const module = this.resolveModule(binding.module, binding.level, from)
    if (!module) {
      if (binding.level > 0) return null
      return { type: 'external', name: binding.symbol ? `${binding.module}.${binding.symbol}` : binding.module }
    }
    return binding.symbol === null ? module : this.moduleMember(module, binding.symbol, depth)
  }

  private moduleMember(module: ModuleEntity, name: string, depth: number): Entity | null {
    const { file } = module
    const def = file?.defs.get(name)
    if (def) return { type: 'def', def }
    const submodule = this.stem(joinPath(module.stem, [name]))
    if (submodule) return submodule
    if (!file) return null
    const instance = file.vars.get(name)
    if (instance) return { type: 'instance', cls: instance }
    if (depth >= IMPORT_FOLLOW_DEPTH) return null
    // Re-exports, e.g. a package __init__ doing `from .core import run`.
    const binding = file.imports.get(name)
    if (binding) return this.resolveBinding(binding, file, depth + 1)
    for (const star of file.starImports) {
      const source = this.resolveModule(star.module, star.level, file)
      const found = source && source.file !== file ? this.moduleMember(source, name, depth + 1) : null
      if (found) return found
    }
    return null
  }

  private lookupName(name: string, scope: Scope, file: FileInfo): Entity | null {
    if (scope.cls && name === scope.selfName) return { type: 'instance', cls: scope.cls }
    const local = scope.vars.get(name)
    if (local) return { type: 'instance', cls: local }
    for (const qual of scope.functionQuals) {
      const nested = file.defs.get(`${qual}.${name}`)
      if (nested) return { type: 'def', def: nested }
    }
    if (scope.classBody) {
      const sibling = file.defs.get(`${scope.classBody.qualname}.${name}`)
      if (sibling) return { type: 'def', def: sibling }
    }
    const def = file.defs.get(name)
    if (def) return { type: 'def', def }
    const binding = file.imports.get(name)
    if (binding) return this.resolveBinding(binding, file, 0)
    for (const star of file.starImports) {
      const source = this.resolveModule(star.module, star.level, file)
      const found = source ? this.moduleMember(source, name, 1) : null
      if (found) return found
    }
    const moduleVar = file.vars.get(name)
    if (moduleVar) return { type: 'instance', cls: moduleVar }
    // The one builtin that matters for the map. Any other unknown name is a local variable.
    return name === 'open' ? { type: 'external', name } : null
  }

  private moduleScope(file: FileInfo): Scope {
    return {
      owner: file.moduleId,
      qual: '',
      functionQuals: [],
      cls: null,
      selfName: null,
      classBody: null,
      vars: file.vars,
      strings: file.strings,
      moduleLevel: true
    }
  }

  private basesOf(cls: Def): Def[] {
    const cached = this.baseCache.get(cls)
    if (cached) return cached
    const bases: Def[] = []
    this.baseCache.set(cls, bases)
    const file = this.files.get(cls.file)
    const list = cls.node.childForFieldName('superclasses')
    if (file && list) {
      for (const base of list.namedChildren) {
        if (!base || base.type === 'keyword_argument') continue
        const entity = this.resolveExpr(base, this.moduleScope(file), file)
        if (entity?.type === 'def' && entity.def.kind === 'class') bases.push(entity.def)
      }
    }
    return bases
  }

  private findMethod(cls: Def, name: string, seen = new Set<Def>()): Def | null {
    if (seen.has(cls)) return null
    seen.add(cls)
    const own = this.files.get(cls.file)?.defs.get(`${cls.qualname}.${name}`)
    if (own) return own
    for (const base of this.basesOf(cls)) {
      const inherited = this.findMethod(base, name, seen)
      if (inherited) return inherited
    }
    return null
  }

  /** Attributes of a class known to hold an instance of a project class, e.g. `self.repo = Repo()`. */
  private attrTypes(cls: Def): Map<string, Def> {
    const cached = this.attrCache.get(cls)
    if (cached) return cached
    const types = new Map<string, Def>()
    this.attrCache.set(cls, types)
    const file = this.files.get(cls.file)
    const body = cls.node.childForFieldName('body')
    if (!file || !body) return types

    for (const statement of body.namedChildren) {
      const member = statement?.type === 'decorated_definition' ? statement.childForFieldName('definition') : statement
      if (member?.type === 'function_definition') {
        const scope: Scope = { ...this.moduleScope(file), vars: new Map(), cls, selfName: firstParameter(member) }
        this.scanParameters(member, scope, file)
        for (const assignment of member.descendantsOfType('assignment')) {
          const left = assignment?.childForFieldName('left')
          if (!assignment || left?.type !== 'attribute' || left.childForFieldName('object')?.text !== scope.selfName) continue
          const attr = left.childForFieldName('attribute')?.text
          const held = this.assignedClass(assignment, scope, file)
          if (attr && held) types.set(attr, held)
        }
      } else if (member?.type === 'expression_statement') {
        // Annotated class attributes, e.g. dataclass fields.
        const assignment = member.namedChildren[0]
        const left = assignment?.type === 'assignment' ? assignment.childForFieldName('left') : null
        const held = assignment && left?.type === 'identifier' ? this.assignedClass(assignment, this.moduleScope(file), file) : null
        if (left && held) types.set(left.text, held)
      }
    }
    for (const base of this.basesOf(cls)) {
      for (const [attr, held] of this.attrTypes(base)) if (!types.has(attr)) types.set(attr, held)
    }
    return types
  }

  private member(base: Entity, name: string): Entity | null {
    switch (base.type) {
      case 'module':
        return this.moduleMember(base, name, 0)
      case 'external':
        return { type: 'external', name: `${base.name}.${name}` }
      case 'def': {
        const method = base.def.kind === 'class' ? this.findMethod(base.def, name) : null
        return method ? { type: 'def', def: method } : null
      }
      case 'instance': {
        const method = this.findMethod(base.cls, name)
        if (method) return { type: 'def', def: method }
        const held = this.attrTypes(base.cls).get(name)
        return held ? { type: 'instance', cls: held } : null
      }
      case 'super': {
        for (const parent of this.basesOf(base.cls)) {
          // The parent's constructor body belongs to the parent's class node.
          if (CONSTRUCTORS.has(name)) return { type: 'def', def: parent }
          const method = this.findMethod(parent, name)
          if (method) return { type: 'def', def: method }
        }
        return null
      }
    }
  }

  private resolveExpr(node: Node, scope: Scope, file: FileInfo): Entity | null {
    switch (node.type) {
      case 'identifier':
        return this.lookupName(node.text, scope, file)
      case 'attribute': {
        const object = node.childForFieldName('object')
        const name = node.childForFieldName('attribute')?.text
        const base = object ? this.resolveExpr(object, scope, file) : null
        return base && name ? this.member(base, name) : null
      }
      case 'call': {
        const callee = node.childForFieldName('function')
        if (!callee) return null
        if (callee.type === 'identifier' && callee.text === 'super' && scope.cls) return { type: 'super', cls: scope.cls }
        const target = this.resolveExpr(callee, scope, file)
        if (target?.type === 'def') return target.def.kind === 'class' ? { type: 'instance', cls: target.def } : null
        // Keep the dotted name so chained calls still read as e.g. "pathlib.Path.read_text".
        return target?.type === 'external' ? target : null
      }
      case 'parenthesized_expression':
      case 'await': {
        const inner = node.namedChildren[0]
        return inner ? this.resolveExpr(inner, scope, file) : null
      }
      default:
        return null
    }
  }

  // ---------- Variables ----------

  /** The project class named in a type annotation, looking inside wrappers such as Optional[...]. */
  private resolveType(type: Node, scope: Scope, file: FileInfo): Def | null {
    for (const candidate of [...type.descendantsOfType('attribute'), ...type.descendantsOfType('identifier')]) {
      const entity = candidate ? this.resolveExpr(candidate, scope, file) : null
      if (entity?.type === 'def' && entity.def.kind === 'class') return entity.def
    }
    return null
  }

  /** The project class an assignment leaves in its target, from the annotation or the value. */
  private assignedClass(assignment: Node, scope: Scope, file: FileInfo): Def | null {
    const type = assignment.childForFieldName('type')
    const annotated = type ? this.resolveType(type, scope, file) : null
    if (annotated) return annotated
    const right = assignment.childForFieldName('right')
    const value = right ? this.resolveExpr(right, scope, file) : null
    return value?.type === 'instance' ? value.cls : null
  }

  private scanParameters(fn: Node, scope: Scope, file: FileInfo): void {
    for (const parameter of fn.childForFieldName('parameters')?.namedChildren ?? []) {
      if (parameter?.type !== 'typed_parameter' && parameter?.type !== 'typed_default_parameter') continue
      const name = parameter.childForFieldName('name') ?? parameter.namedChildren[0]
      const type = parameter.childForFieldName('type')
      const held = name?.type === 'identifier' && type ? this.resolveType(type, scope, file) : null
      if (name && held) scope.vars.set(name.text, held)
    }
  }

  /** Records what the variables assigned in this scope hold. Does not look inside nested functions or classes. */
  private scanAssignments(root: Node, scope: Scope, file: FileInfo): void {
    const pending: Node[] = [root]
    while (pending.length) {
      for (const child of pending.pop()!.namedChildren) {
        if (!child || child.namedChildCount === 0) continue
        if (child.type === 'function_definition' || child.type === 'class_definition' || child.type === 'lambda') continue
        if (child.type === 'assignment') {
          const left = child.childForFieldName('left')
          const right = child.childForFieldName('right')
          if (left?.type === 'identifier') {
            const held = this.assignedClass(child, scope, file)
            const filename = !held && right ? filenameIn(right) : null
            if (held) scope.vars.set(left.text, held)
            else if (filename) scope.strings.set(left.text, filename)
          }
        } else if (child.type === 'as_pattern') {
          // `with Thing() as name:`
          const value = child.namedChildren[0]
          const alias = child.childForFieldName('alias')?.namedChildren[0]
          const entity = value ? this.resolveExpr(value, scope, file) : null
          if (alias?.type === 'identifier' && entity?.type === 'instance') scope.vars.set(alias.text, entity.cls)
        }
        pending.push(child)
      }
    }
  }

  // ---------- Pass 2 ----------

  scanModuleVariables(): void {
    for (const file of this.files.values()) this.scanAssignments(file.tree.rootNode, this.moduleScope(file), file)
  }

  // ---------- Pass 3: calls ----------

  linkCalls(): void {
    for (const file of this.files.values()) this.walk(file.tree.rootNode, this.moduleScope(file), file)
  }

  private walk(node: Node, scope: Scope, file: FileInfo): void {
    for (const child of node.namedChildren) {
      if (!child || child.namedChildCount === 0) continue
      switch (child.type) {
        case 'import_statement':
        case 'import_from_statement':
          break
        case 'decorated_definition': {
          const definition = child.childForFieldName('definition')
          if (definition?.type === 'function_definition') this.enterFunction(definition, scope, file)
          else if (definition?.type === 'class_definition') this.enterClass(definition, scope, file)
          break
        }
        case 'function_definition':
          this.enterFunction(child, scope, file)
          break
        case 'class_definition':
          this.enterClass(child, scope, file)
          break
        case 'if_statement':
          // An imported module does not run its `if __name__ == "__main__":` block.
          if (scope.moduleLevel && file.path !== this.entry && isMainGuard(child)) break
          this.walk(child, scope, file)
          break
        case 'call':
          this.visitCall(child, scope, file)
          this.walk(child, scope, file)
          break
        default:
          this.walk(child, scope, file)
      }
    }
  }

  private enterFunction(node: Node, scope: Scope, file: FileInfo): void {
    const name = node.childForFieldName('name')?.text
    const body = node.childForFieldName('body')
    if (!name || !body) return
    const qualname = scope.qual ? `${scope.qual}.${name}` : name
    const isConstructor = !!scope.classBody && CONSTRUCTORS.has(name)
    const def = isConstructor ? scope.classBody : file.defs.get(qualname)
    if (!def) return

    const decorators = decoratorsOf(node)
    if (!isConstructor) this.linkDecorators(decorators, def, scope, file)

    const isStatic = decorators.some((decorator) => /^@\s*staticmethod\b/.test(decorator.text))
    const inner: Scope = {
      owner: def.id,
      qual: qualname,
      functionQuals: [qualname, ...scope.functionQuals],
      cls: scope.classBody ?? scope.cls,
      selfName: scope.classBody ? (isStatic ? null : firstParameter(node)) : scope.selfName,
      classBody: null,
      // A method starts clean; a nested function can see the variables of the function around it.
      vars: new Map(scope.classBody || scope.moduleLevel ? [] : scope.vars),
      strings: new Map(scope.classBody || scope.moduleLevel ? [] : scope.strings),
      moduleLevel: false
    }
    this.scanParameters(node, inner, file)
    this.scanAssignments(body, inner, file)
    this.walk(body, inner, file)
  }

  private enterClass(node: Node, scope: Scope, file: FileInfo): void {
    const name = node.childForFieldName('name')?.text
    const body = node.childForFieldName('body')
    const qualname = scope.qual ? `${scope.qual}.${name}` : name
    const def = qualname ? file.defs.get(qualname) : undefined
    if (!def || !body) return
    this.walk(body, { ...scope, owner: def.id, qual: def.qualname, classBody: def, vars: new Map(), strings: new Map(), moduleLevel: false }, file)
  }

  /** A decorator from a framework (`@app.route`, `@click.command`) means something else will call the function. */
  private linkDecorators(decorators: Node[], def: Def, scope: Scope, file: FileInfo): void {
    for (const decorator of decorators) {
      const expression = decorator.namedChildren[0]
      const callee = expression?.type === 'call' ? expression.childForFieldName('function') : expression
      if (!callee) continue
      const line = decorator.startPosition.row + 1
      const target = this.resolveExpr(callee, scope, file)
      if (target?.type === 'def') {
        this.addEdge(scope.owner, target.def.id, 'call', false, line)
        continue
      }
      const lastName = callee.text.slice(callee.text.lastIndexOf('.') + 1)
      if (!PASSIVE_DECORATORS.has(lastName)) this.addEdge(scope.owner, def.id, 'call', true, line)
    }
  }

  private visitCall(node: Node, scope: Scope, file: FileInfo): void {
    const callee = node.childForFieldName('function')
    if (!callee) return
    const line = node.startPosition.row + 1
    const argumentList = node.childForFieldName('arguments')
    const args: Node[] = []
    const keywords = new Map<string, Node>()
    if (argumentList?.type === 'argument_list') {
      for (const argument of argumentList.namedChildren) {
        if (!argument || argument.type === 'comment') continue
        if (argument.type === 'keyword_argument') {
          const key = argument.childForFieldName('name')?.text
          const value = argument.childForFieldName('value')
          if (key && value) keywords.set(key, value)
        } else {
          args.push(argument)
        }
      }
    }

    const target = this.resolveExpr(callee, scope, file)
    if (target?.type === 'def') {
      this.addEdge(scope.owner, target.def.id, 'call', false, line)
    } else if (target?.type === 'instance') {
      const callable = this.findMethod(target.cls, '__call__')
      if (callable) this.addEdge(scope.owner, callable.id, 'call', false, line)
    } else {
      const isMethod = callee.type === 'attribute'
      const method = isMethod ? (callee.childForFieldName('attribute')?.text ?? null) : null
      const info: CallInfo = {
        name: target?.type === 'external' ? target.name : null,
        method,
        receiver: isMethod ? callee.childForFieldName('object') : null,
        args,
        keywords,
        filename: (expression) => filenameIn(expression) ?? this.filenameFromVariables(expression, scope, file)
      }
      const resource = detectResource(info)
      if (resource) {
        this.addResource(resource, scope, file, line)
      } else if (!target && method && !COMMON_METHODS.has(method)) {
        // The object's type is unknown. If exactly one project method has this name, it is probably the one.
        const candidates = this.methodsByName.get(method)
        if (candidates?.length === 1) this.addEdge(scope.owner, candidates[0].id, 'call', true, line)
      }
    }

    // A project function handed over as an argument (a callback, a thread target) will probably be called.
    for (const value of [...args, ...keywords.values()]) {
      if (value.type !== 'identifier' && value.type !== 'attribute') continue
      const passed = this.resolveExpr(value, scope, file)
      if (passed?.type === 'def' && passed.def.kind !== 'class') this.addEdge(scope.owner, passed.def.id, 'call', true, line)
    }
  }

  private filenameFromVariables(expression: Node, scope: Scope, file: FileInfo): string | null {
    const names = expression.type === 'identifier' ? [expression] : expression.descendantsOfType('identifier')
    for (const name of names) {
      if (!name) continue
      const known = scope.strings.get(name.text) ?? file.strings.get(name.text)
      if (known) return known
      const binding = file.imports.get(name.text)
      const source = binding?.symbol ? this.resolveModule(binding.module, binding.level, file) : null
      const imported = source?.file?.strings.get(binding!.symbol!)
      if (imported) return imported
    }
    return null
  }

  // ---------- Graph building ----------

  private addEdge(source: string, target: string, kind: GraphEdgeKind, inferred: boolean, line: number, access?: 'read' | 'write'): void {
    if (source === target) return
    const id = `${source}->${target}:${kind}`
    const existing = this.edges.get(id)
    if (!existing) {
      this.edges.set(id, { id, source, target, kind, inferred, line, ...(access && { access }) })
      return
    }
    existing.inferred &&= inferred
    existing.line = Math.min(existing.line, line)
    if (access === 'write') existing.access = 'write'
  }

  private findProjectFile(filename: string, from: FileInfo): string | null {
    if (filename.includes('*')) return null
    const isAbsolute = filename.startsWith('/') || /^[A-Za-z]:/.test(filename) || filename.startsWith('~')
    if (!isAbsolute) {
      for (const base of new Set([from.dir, '', this.entryDir])) {
        const candidate = posix.normalize(joinPath(base, [filename]))
        if (this.allFiles.has(candidate)) return candidate
      }
    }
    const sameName = this.byBasename.get(baseOf(filename))
    return sameName?.length === 1 ? sameName[0] : null
  }

  private addResource(use: ResourceUse, scope: Scope, file: FileInfo, line: number): void {
    const projectFile = use.filename ? this.findProjectFile(use.filename, file) : null
    const id = projectFile
      ? `res:${projectFile}`
      : use.local
        ? `res:${use.kind}:${file.path}:${use.label}`
        : `res:${use.kind}:${use.filename ?? use.label}`
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, kind: use.kind, label: projectFile ? baseOf(projectFile) : use.label, file: projectFile, line: null })
    }
    this.addEdge(scope.owner, id, use.kind, false, line, use.access)
  }

  /**
   * Importing a module runs its top-level code. That only matters for the map when that code does something,
   * so a module gets an import branch only if it (or something it imports) has branches of its own.
   */
  linkImports(): void {
    const candidates: { source: string; target: string; line: number }[] = []
    for (const file of this.files.values()) {
      for (const record of file.importRecords) {
        const module = this.resolveModule(record.module, record.level, file)
        if (!module) continue
        const targets = [module.file, ...record.symbols.map((symbol) => this.stem(joinPath(module.stem, [symbol]))?.file)]
        for (const target of targets) {
          if (target && target !== file) candidates.push({ source: file.moduleId, target: target.moduleId, line: record.line })
        }
      }
    }
    const active = new Set([...this.edges.values()].map((edge) => edge.source).filter((id) => id.startsWith('mod:')))
    for (let changed = true; changed; ) {
      changed = false
      for (const { source, target, line } of candidates) {
        if (!active.has(target)) continue
        this.addEdge(source, target, 'import', false, line)
        if (!active.has(source)) {
          active.add(source)
          changed = true
        }
      }
    }
  }

  finish(): ProjectGraph {
    for (const file of this.files.values()) file.tree.delete()
    return {
      root: this.files.has(this.entry) ? `mod:${this.entry}` : null,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      problems: this.problems
    }
  }
}

function defLabel(def: Pick<Def, 'kind' | 'name' | 'qualname'>): string {
  if (def.kind === 'class') return def.name
  if (def.kind === 'method') return `${def.qualname.split('.').slice(-2).join('.')}()`
  return `${def.name}()`
}

function decoratorsOf(definition: Node): Node[] {
  const parent = definition.parent
  if (parent?.type !== 'decorated_definition') return []
  return parent.namedChildren.filter((child): child is Node => child?.type === 'decorator')
}

function firstParameter(fn: Node): string | null {
  const first = fn.childForFieldName('parameters')?.namedChildren[0]
  if (!first) return null
  if (first.type === 'identifier') return first.text
  const name = first.childForFieldName('name') ?? first.namedChildren[0]
  return name?.type === 'identifier' ? name.text : null
}

function isMainGuard(statement: Node): boolean {
  const condition = statement.childForFieldName('condition')?.text ?? ''
  return condition.includes('__name__') && condition.includes('__main__')
}

export async function analyzeProject(projectRoot: string, allFiles: string[], entry: string): Promise<ProjectGraph> {
  const parser = await getParser()
  const analysis = new Analysis(allFiles, entry)
  const pythonFiles = allFiles.filter((path) => path.endsWith('.py'))
  if (pythonFiles.length > MAX_PYTHON_FILES) {
    analysis.problems.push({ file: '', message: `Only the first ${MAX_PYTHON_FILES} Python files were analyzed.` })
  }

  for (const path of pythonFiles.slice(0, MAX_PYTHON_FILES)) {
    try {
      const bytes = await readFile(join(projectRoot, path))
      if (bytes.length > MAX_FILE_BYTES) {
        analysis.problems.push({ file: path, message: 'Too large to analyze.' })
        continue
      }
      analysis.addFile(path, bytes.toString('utf8'), parser)
    } catch {
      analysis.problems.push({ file: path, message: 'Could not be read.' })
    }
  }

  analysis.scanModuleVariables()
  analysis.linkCalls()
  analysis.linkImports()
  return analysis.finish()
}
