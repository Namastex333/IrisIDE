// Recognises calls that touch the outside world: config files, data files, databases, the network.
// Everything here is pattern matching on names, so it errs towards well-known libraries.
import type { Node } from 'web-tree-sitter'

export interface ResourceUse {
  kind: 'config' | 'data'
  access: 'read' | 'write'
  /** File name or path as written in the code, when it could be worked out. */
  filename: string | null
  /** What to call the resource in the tree. */
  label: string
  /** True when the label is just the text of a local expression (e.g. `path`), so it only means something in its own file. */
  local: boolean
}

export interface CallInfo {
  /** Dotted name when the callee is a known import or builtin, e.g. "pandas.read_csv" or "open". */
  name: string | null
  /** Final attribute when the callee is written as `something.method`. */
  method: string | null
  /** The object the method is called on. */
  receiver: Node | null
  args: Node[]
  keywords: Map<string, Node>
  /** Finds a file name in an expression: a literal, or a variable known to hold one. */
  filename(node: Node): string | null
}

const CONFIG_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties'])
const FILE_PATTERN = /^[\w\-.*/: ~]*\.[A-Za-z][A-Za-z0-9]{0,7}$/

const OPEN_FUNCTIONS = /^(open|io\.open|codecs\.open|gzip\.open|bz2\.open|lzma\.open)$/
const NOT_FILE_OPEN = /^(webbrowser|os|subprocess|socket)\./
const PATH_READERS = /^(read_text|read_bytes)$/
const PATH_WRITERS = /^(write_text|write_bytes)$/
const READERS =
  /^(read_csv|read_excel|read_json|read_parquet|read_pickle|read_table|read_feather|read_hdf|read_fwf|read_xml|loadtxt|genfromtxt|imread)$/
const WRITERS =
  /^(to_csv|to_excel|to_json|to_parquet|to_pickle|to_feather|to_hdf|to_html|to_markdown|savetxt|savefig|imwrite|imsave)$/
const SQL_METHODS = /^(read_sql|read_sql_query|read_sql_table|to_sql)$/
const NAMED_READERS = /^numpy\.load$/
const NAMED_WRITERS = /^(numpy\.(save|savez|savez_compressed)|shutil\.(copy|copy2|copyfile|move))$/
const DATABASES =
  /^(sqlite3\.connect|sqlalchemy\.create_engine|psycopg2?\.connect|pymysql\.connect|pymongo\.MongoClient|redis\.(Redis|from_url)|duckdb\.connect)$/
const HTTP = /^(?:requests|httpx|aiohttp)\.(?:\w+\.)*(get|post|put|patch|delete|head|request)$/
const ENVIRONMENT = /^os\.(getenv|environ\.(get|setdefault|pop))$/
const DOTENV = /^dotenv\.(load_dotenv|dotenv_values)$/
const CONFIG_LOADERS = /^(read|load|parse|from_)|(_load|_read)$/

/** The text of a string literal. Placeholders in f-strings become "*". */
export function stringValue(node: Node): string {
  let text = ''
  for (const part of node.namedChildren) {
    if (part?.type === 'string_content') text += part.text
    else if (part?.type === 'interpolation') text += '*'
  }
  return text.replace(/\\+/g, '/')
}

/** The last string literal inside `node` that reads like a file name or path. */
export function filenameIn(node: Node): string | null {
  const strings = node.type === 'string' ? [node] : node.descendantsOfType('string')
  for (let i = strings.length - 1; i >= 0; i--) {
    const literal = strings[i]
    if (!literal) continue
    const value = stringValue(literal).trim()
    if (value.length <= 200 && !/^\w+:\/\//.test(value) && FILE_PATTERN.test(value)) return value
  }
  return null
}

export function isConfigFile(filename: string): boolean {
  const base = filename.slice(filename.lastIndexOf('/') + 1).toLowerCase()
  return base.startsWith('.env') || CONFIG_EXTENSIONS.has(base.slice(base.lastIndexOf('.') + 1))
}

function describe(node: Node | null | undefined): string {
  const text = node?.text.replace(/\s+/g, ' ') ?? ''
  return text && text.length <= 28 ? text : 'a file'
}

/** Reading a config-format file counts as config; every other file access is data. */
function fileUse(access: 'read' | 'write', filename: string | null, described: Node | null | undefined): ResourceUse {
  const kind = access === 'read' && filename && isConfigFile(filename) ? 'config' : 'data'
  const label = filename ? filename.slice(filename.lastIndexOf('/') + 1) : describe(described)
  return { kind, access, filename, label, local: !filename }
}

function openMode(info: CallInfo): 'read' | 'write' {
  for (const candidate of [info.keywords.get('mode'), info.args[1], info.args[0]]) {
    if (candidate?.type !== 'string') continue
    const mode = stringValue(candidate)
    if (/^[rwaxbt+]{1,4}$/.test(mode)) return /[wax+]/.test(mode) ? 'write' : 'read'
  }
  return 'read'
}

function urlHost(info: CallInfo): string | null {
  for (const arg of [...info.args, ...info.keywords.values()]) {
    for (const literal of arg.type === 'string' ? [arg] : arg.descendantsOfType('string')) {
      if (!literal) continue
      try {
        const value = stringValue(literal)
        if (/^https?:\/\//.test(value)) return new URL(value.replace(/\*/g, 'x')).host
      } catch {
        // Not a complete URL; keep looking.
      }
    }
  }
  return null
}

export function detectResource(info: CallInfo): ResourceUse | null {
  const name = info.name ?? ''
  const last = info.method ?? name.slice(name.lastIndexOf('.') + 1)
  const first = info.args[0]
  const firstFile = first ? info.filename(first) : null
  const receiverFile = info.receiver ? info.filename(info.receiver) : null

  if (ENVIRONMENT.test(name)) {
    return { kind: 'config', access: 'read', filename: null, label: 'environment variables', local: false }
  }
  if (DOTENV.test(name)) {
    return { kind: 'config', access: 'read', filename: firstFile ?? '.env', label: '.env', local: false }
  }

  const http = HTTP.exec(name)
  if (http || name === 'urllib.request.urlopen') {
    const access = !http || http[1] === 'get' || http[1] === 'head' ? 'read' : 'write'
    return { kind: 'data', access, filename: null, label: urlHost(info) ?? 'web request', local: false }
  }

  if (DATABASES.test(name) || SQL_METHODS.test(last)) {
    const access = last === 'to_sql' ? 'write' : 'read'
    const database = DATABASES.test(name) ? firstFile : null
    return { kind: 'data', access, filename: database, label: database ?? 'database', local: false }
  }

  if (OPEN_FUNCTIONS.test(name)) return fileUse(openMode(info), firstFile, first)
  if (info.method === 'open' && !NOT_FILE_OPEN.test(name)) {
    return fileUse(openMode(info), firstFile ?? receiverFile, firstFile ? first : info.receiver)
  }

  // pathlib: the path is the object, the argument is the content.
  if (PATH_READERS.test(last)) return fileUse('read', receiverFile, info.receiver)
  if (PATH_WRITERS.test(last)) return fileUse('write', receiverFile, info.receiver)

  if (READERS.test(last) || NAMED_READERS.test(name)) return fileUse('read', firstFile, first)
  // to_json() and friends return a string when called without a destination.
  if ((WRITERS.test(last) && first) || NAMED_WRITERS.test(name)) {
    const target = NAMED_WRITERS.test(name) && name.startsWith('shutil.') ? info.args[1] : first
    return fileUse('write', target ? info.filename(target) : null, target)
  }

  // Loaders handed a config file directly, e.g. parser.read("settings.ini") or toml.load("pyproject.toml").
  if (CONFIG_LOADERS.test(last) && firstFile && isConfigFile(firstFile)) return fileUse('read', firstFile, first)

  return null
}
