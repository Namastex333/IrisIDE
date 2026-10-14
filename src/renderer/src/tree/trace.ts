// Turns a run's trace into what the tree shows: which branches ran, in what order and how often,
// and which branches only showed up when the code ran. No React, no DOM.
import type { GraphEdge, GraphNode, ProjectGraph, TraceFact, TraceFailure, TraceUpdate } from '../../../shared/api'

export interface RunTrace {
  /** Different for every run, so the view can restart its animation. */
  id: number
  status: 'running' | 'done'
  /** Null until the tracer reports in; false when the run could not be traced. */
  traced: boolean | null
  note: string | null
  facts: TraceFact[]
  /** Decorators' wrapper functions. Calls into them are left out; the call to the wrapped function counts instead. */
  wrappers: ReadonlySet<string>
  /** Functions called so often that the tracer stopped counting them. */
  hot: ReadonlySet<string>
  /** Times each branch ran, keyed by countKey(). */
  counts: ReadonlyMap<string, number>
  exitCode: number | null
  stopped: boolean
  error: { type: string; message: string } | null
  /** Errors the project's own code did not catch. */
  failures: TraceFailure[]
  /** How many errors the project's own code caught along the way. */
  caught: number
}

let traces = 0

export function newTrace(): RunTrace {
  return {
    id: ++traces,
    status: 'running',
    traced: null,
    note: null,
    facts: [],
    wrappers: new Set(),
    hot: new Set(),
    counts: new Map(),
    exitCode: null,
    stopped: false,
    error: null,
    failures: [],
    caught: 0
  }
}

export const countKey = (from: string | null, to: string, created: string | null): string =>
  `${from ?? ''}|${to}|${created ?? ''}`

export function applyTraceUpdate(trace: RunTrace, update: TraceUpdate): RunTrace {
  switch (update.type) {
    case 'info':
      return { ...trace, traced: update.traced, note: update.note }
    case 'failures':
      return { ...trace, failures: update.failures, caught: update.caught }
    case 'facts':
      return {
        ...trace,
        facts: update.facts.length ? [...trace.facts, ...update.facts] : trace.facts,
        wrappers: update.wrappers.length ? new Set([...trace.wrappers, ...update.wrappers]) : trace.wrappers,
        hot: update.hot.length ? new Set([...trace.hot, ...update.hot]) : trace.hot
      }
    case 'counts': {
      const counts = new Map(trace.counts)
      for (const [from, to, times, created] of update.counts) counts.set(countKey(from, to, created), times)
      return { ...trace, counts }
    }
    case 'end':
      return { ...trace, status: 'done', exitCode: update.exitCode, error: update.error }
  }
}

export interface RunView {
  /** For each branch that ran, when it first ran (lower is earlier), by edge id. */
  ran: ReadonlyMap<string, number>
  /** Likely branches that count as run only because both ends ran: a callback handed over, then called elsewhere. */
  indirect: ReadonlySet<string>
  /** When each node first ran, by node id. */
  nodeOrder: ReadonlyMap<string, number>
  /** Times each function, method or class was called or created. */
  calls: ReadonlyMap<string, number>
  /** Nodes called so often that the tracer stopped counting. */
  busy: ReadonlySet<string>
  /** Branches and resources that only showed up when the code ran. */
  extraEdges: GraphEdge[]
  extraNodes: GraphNode[]
  /** The error to flag: the one that ended the run, or else the first one nothing caught. */
  failure: ResolvedFailure | null
}

export interface ResolvedFailure {
  error: TraceFailure
  /** The node where it failed (turns red) and the node that called it (turns orange), when the tree has them. */
  failing: string | null
  caller: string | null
  /** The branch between them. */
  edge: string | null
  /** Every node the error passed through, from where it failed outwards. */
  path: string[]
}

const NESTED_CODE = /^<(lambda|genexpr|listcomp|setcomp|dictcomp)>$/
const CONSTRUCTORS = new Set(['__init__', '__new__', '__post_init__'])
/** Resources the code names with an expression Iris could not read, e.g. open(path). See addResource in the analyzer. */
const PLACEHOLDER = /^res:(config|data):[^:]+\.pyw?:/
const ENVIRONMENT = 'res:config:environment variables'

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The graph node for a piece of code named the tracer's way ("shop/pricing.py::total.<locals>.rounded"). */
export function nodeIdFor(key: string, nodes: ReadonlyMap<string, GraphNode>): string | null {
  const split = key.indexOf('::')
  if (split < 0) return null
  const file = key.slice(0, split)
  const parts = key.slice(split + 2).split('.').filter((part) => part !== '<locals>')
  // Lambdas, comprehensions and generator expressions belong to the function they are written in.
  while (parts.length && NESTED_CODE.test(parts[parts.length - 1])) parts.pop()
  const moduleId = `mod:${file}`
  if (!parts.length || parts[0] === '<module>') return nodes.has(moduleId) ? moduleId : null
  // A constructor's work belongs to its class's node, as it does when reading the code.
  if (parts.length > 1 && CONSTRUCTORS.has(parts[parts.length - 1])) {
    const owner = `def:${file}::${parts.slice(0, -1).join('.')}`
    if (nodes.get(owner)?.kind === 'class') return owner
  }
  for (let length = parts.length; length > 0; length--) {
    const id = `def:${file}::${parts.slice(0, length).join('.')}`
    if (nodes.has(id)) return id
  }
  return null
}

type IoFact = Extract<TraceFact, { type: 'io' }>

/** Whether a resource node found by reading the code is the thing the program touched. */
function sameResource(node: GraphNode, fact: IoFact): boolean {
  switch (fact.op) {
    case 'env':
      return node.id === ENVIRONMENT
    case 'net':
      return node.label === fact.target || node.label === 'web request'
    case 'sqlite':
      if (node.label === 'database') return true
      return node.file !== null ? node.file === fact.relative : node.label === baseName(fact.target)
    case 'open':
      if (PLACEHOLDER.test(node.id)) return false
      return node.file !== null ? node.file === fact.relative : node.label === baseName(fact.target)
  }
}

/** The node for a resource that only showed up at run time. */
function observedResource(fact: IoFact): { id: string; label: string; file: string | null } {
  if (fact.op === 'env') return { id: ENVIRONMENT, label: 'environment variables', file: null }
  if (fact.op === 'net') return { id: `res:data:${fact.target}`, label: fact.target, file: null }
  if (fact.relative) return { id: `res:${fact.relative}`, label: baseName(fact.relative), file: fact.relative }
  if (fact.op === 'sqlite' && !/[/.]/.test(fact.target)) return { id: 'res:data:database', label: 'database', file: null }
  const name = baseName(fact.target)
  return { id: `res:${fact.kind}:${name}`, label: name, file: null }
}

export function resolveTrace(graph: ProjectGraph, trace: RunTrace): RunView {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]))
  const resourceEdges = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) {
    if (edge.kind !== 'config' && edge.kind !== 'data') continue
    const list = resourceEdges.get(edge.source)
    if (list) list.push(edge)
    else resourceEdges.set(edge.source, [edge])
  }

  const ran = new Map<string, number>()
  const nodeOrder = new Map<string, number>()
  const extraEdges = new Map<string, GraphEdge>()
  const extraNodes = new Map<string, GraphNode>()
  const earliest = (map: Map<string, number>, id: string, order: number): void => {
    const known = map.get(id)
    if (known === undefined || order < known) map.set(id, order)
  }
  const branch = (source: string, target: string, kind: GraphEdge['kind'], fact: TraceFact): void => {
    if (source === target) return
    const id = `${source}->${target}:${kind}`
    if (!edges.has(id) && !extraEdges.has(id)) {
      const access = fact.type === 'io' ? { access: fact.access } : {}
      extraEdges.set(id, { id, source, target, kind, inferred: false, line: fact.line ?? 0, observed: true, ...access })
    }
    earliest(ran, id, fact.order)
    earliest(nodeOrder, target, fact.order)
  }

  for (const fact of trace.facts) {
    if (fact.type === 'call') {
      if (trace.wrappers.has(fact.to)) continue
      const target = nodeIdFor(fact.to, nodes)
      if (!target) continue
      const source = fact.from === null ? null : nodeIdFor(fact.from, nodes)
      earliest(nodeOrder, target, fact.order)

      if (nodes.get(target)?.kind === 'module') {
        // A module's top-level code runs when something first imports it; that is a branch only if reading the code found one.
        const file = source ? nodes.get(source)?.file : null
        const id = `mod:${file}->${target}:import`
        if (file && edges.has(id)) earliest(ran, id, fact.order)
        continue
      }
      const created = fact.created ? nodeIdFor(fact.created, nodes) : null
      if (created && created !== target) {
        // Creating an object of a subclass ran its parent's constructor.
        if (source) branch(source, created, 'call', fact)
        branch(created, target, 'call', fact)
      } else if (source) {
        branch(source, target, 'call', fact)
      }
      continue
    }

    const source = nodeIdFor(fact.from, nodes)
    if (!source) continue
    const candidates = resourceEdges.get(source) ?? []
    const matches = candidates.filter((edge) => {
      const node = nodes.get(edge.target)
      return !!node && sameResource(node, fact)
    })
    for (const edge of matches) {
      earliest(ran, edge.id, fact.order)
      earliest(nodeOrder, edge.target, fact.order)
    }
    if (matches.length) continue
    if (fact.op === 'open' || fact.op === 'sqlite') {
      // The code named the file with an expression ("open(path)"). That branch ran, and the run says which file it was.
      for (const edge of candidates) {
        if (!PLACEHOLDER.test(edge.target)) continue
        earliest(ran, edge.id, fact.order)
        earliest(nodeOrder, edge.target, fact.order)
      }
    }
    const resource = observedResource(fact)
    if (!nodes.has(resource.id) && !extraNodes.has(resource.id)) {
      extraNodes.set(resource.id, { id: resource.id, kind: fact.kind, label: resource.label, file: resource.file, line: null })
    }
    branch(source, resource.id, fact.kind, fact)
  }

  // A likely link (a callback handed over, a method matched by name) whose two ends both ran is taken as having run.
  const indirect = new Set<string>()
  for (const edge of graph.edges) {
    if (!edge.inferred || ran.has(edge.id)) continue
    const from = nodeOrder.get(edge.source)
    const to = nodeOrder.get(edge.target)
    if (from === undefined || to === undefined) continue
    ran.set(edge.id, Math.max(from, to))
    indirect.add(edge.id)
  }

  const calls = new Map<string, number>()
  const add = (id: string | null, times: number): void => {
    if (id) calls.set(id, (calls.get(id) ?? 0) + times)
  }
  for (const [key, times] of trace.counts) {
    const [, to, created] = key.split('|')
    // A lambda or comprehension running is not another call of the function it is written in.
    if (trace.wrappers.has(to) || NESTED_CODE.test(to.slice(Math.max(to.lastIndexOf('.'), to.indexOf('::') + 1) + 1))) continue
    add(nodeIdFor(to, nodes), times)
    if (created) add(nodeIdFor(created, nodes), times)
  }
  const busy = new Set<string>()
  for (const key of trace.hot) {
    const id = nodeIdFor(key, nodes)
    if (id) busy.add(id)
  }

  let failure: ResolvedFailure | null = null
  const error = trace.failures.find((candidate) => candidate.fatal) ?? [...trace.failures].sort((a, b) => a.order - b.order)[0]
  if (error) {
    const failing = nodeIdFor(error.fn, nodes)
    const caller = error.caller ? nodeIdFor(error.caller.fn, nodes) : null
    let edge: string | null = null
    if (failing && caller && failing !== caller) {
      const callerFile = nodes.get(caller)?.file
      const viaImport = `mod:${callerFile}->${failing}:import`
      if (nodes.get(failing)?.kind === 'module' && edges.has(viaImport)) {
        edge = viaImport // it failed while being imported
      } else {
        edge = `${caller}->${failing}:call`
        if (!edges.has(edge) && !extraEdges.has(edge)) {
          extraEdges.set(edge, { id: edge, source: caller, target: failing, kind: 'call', inferred: false, line: error.caller?.line ?? 0, observed: true })
        }
        earliest(ran, edge, error.order)
      }
    }
    const path: string[] = []
    for (const key of error.path) {
      const id = nodeIdFor(key, nodes)
      if (id && path[path.length - 1] !== id) path.push(id)
    }
    failure = { error, failing, caller, edge, path }
  }

  return {
    ran,
    indirect,
    nodeOrder,
    calls,
    busy,
    extraEdges: [...extraEdges.values()],
    extraNodes: [...extraNodes.values()],
    failure
  }
}

/** How much of the entry point's tree the run covered, counting every branch reachable from it. */
export function runCoverage(root: string, outgoing: Map<string, GraphEdge[]>, ran: ReadonlyMap<string, number>): { ran: number; total: number } {
  const seen = new Set([root])
  const pending = [root]
  let total = 0
  let covered = 0
  while (pending.length) {
    for (const edge of outgoing.get(pending.pop()!) ?? []) {
      total++
      if (ran.has(edge.id)) covered++
      if (!seen.has(edge.target)) {
        seen.add(edge.target)
        pending.push(edge.target)
      }
    }
  }
  return { ran: covered, total }
}

/** The nodes to expand to show what ran: everything reached from the entry point along branches that ran. */
export function nodesAlongRun(root: string, outgoing: Map<string, GraphEdge[]>, ran: ReadonlyMap<string, number>): Set<string> {
  const expand = new Set([root])
  const pending = [root]
  while (pending.length) {
    for (const edge of outgoing.get(pending.pop()!) ?? []) {
      if (!ran.has(edge.id) || expand.has(edge.target)) continue
      expand.add(edge.target)
      pending.push(edge.target)
    }
  }
  return expand
}
