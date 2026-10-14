// Pure helpers that turn the project graph into what the tree view shows: which nodes are visible, where they sit,
// and what counts as "connected" for focus mode. No React, no DOM.
import type { GraphEdge, GraphNode, ProjectGraph } from '../../../shared/api'

export const NODE_WIDTH = 210
export const NODE_HEIGHT = 50

export type Direction = 'horizontal' | 'vertical'

/**
 * Outgoing branches of every node, in the order they appear in the code. Likely (dashed) links are left out
 * unless `showInferred` is on or a run showed that they happened.
 */
export function outgoingEdges(
  edges: Iterable<GraphEdge>,
  showInferred: boolean,
  ran?: ReadonlyMap<string, number>
): Map<string, GraphEdge[]> {
  const outgoing = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    if (edge.inferred && !showInferred && !ran?.has(edge.id)) continue
    const list = outgoing.get(edge.source)
    if (list) list.push(edge)
    else outgoing.set(edge.source, [edge])
  }
  for (const list of outgoing.values()) list.sort((a, b) => a.line - b.line)
  return outgoing
}

export interface VisibleTree {
  /** Visible node ids, in the order they were reached from the root. */
  order: string[]
  /** The node each visible node hangs under in the layout. The root maps to null. */
  parent: Map<string, string | null>
  /** Every branch between visible nodes, including extra links to nodes that hang under another parent. */
  edges: GraphEdge[]
}

/**
 * Walks out from the root, following branches only out of expanded nodes.
 * A function reached several ways appears once, under the closest caller.
 */
export function visibleTree(root: string, outgoing: Map<string, GraphEdge[]>, expanded: ReadonlySet<string>): VisibleTree {
  const order = [root]
  const parent = new Map<string, string | null>([[root, null]])
  const edges: GraphEdge[] = []
  for (let next = 0; next < order.length; next++) {
    const id = order[next]
    if (!expanded.has(id)) continue
    for (const edge of outgoing.get(id) ?? []) {
      edges.push(edge)
      if (parent.has(edge.target)) continue
      parent.set(edge.target, id)
      order.push(edge.target)
    }
  }
  return { order, parent, edges }
}

/** Tidy tree layout: each node is centred on its children, and leaves take one row (or column) each. */
export function layoutTree(tree: VisibleTree, direction: Direction): Map<string, { x: number; y: number }> {
  const children = new Map<string, string[]>()
  for (const id of tree.order) {
    const above = tree.parent.get(id)
    if (above == null) continue
    const siblings = children.get(above)
    if (siblings) siblings.push(id)
    else children.set(above, [id])
  }

  const depthStep = direction === 'horizontal' ? NODE_WIDTH + 90 : NODE_HEIGHT + 70
  const crossStep = direction === 'horizontal' ? NODE_HEIGHT + 18 : NODE_WIDTH + 26
  const positions = new Map<string, { x: number; y: number }>()
  let nextLeaf = 0

  const place = (id: string, depth: number): number => {
    const below = children.get(id) ?? []
    const slots = below.map((child) => place(child, depth + 1))
    const cross = slots.length ? (slots[0] + slots[slots.length - 1]) / 2 : nextLeaf++
    positions.set(
      id,
      direction === 'horizontal' ? { x: depth * depthStep, y: cross * crossStep } : { x: cross * crossStep, y: depth * depthStep }
    )
    return cross
  }
  if (tree.order.length) place(tree.order[0], 0)
  return positions
}

/** Everything that leads to the node plus everything it leads to, for focus mode. */
export function connectedTo(id: string, edges: GraphEdge[]): Set<string> {
  const connected = new Set([id])
  const spread = (from: 'source' | 'target', to: 'source' | 'target'): void => {
    const pending = [id]
    const seen = new Set(pending)
    while (pending.length) {
      const current = pending.pop()!
      for (const edge of edges) {
        if (edge[from] !== current || seen.has(edge[to])) continue
        seen.add(edge[to])
        connected.add(edge[to])
        pending.push(edge[to])
      }
    }
  }
  spread('source', 'target')
  spread('target', 'source')
  return connected
}

export function reachableFrom(root: string, outgoing: Map<string, GraphEdge[]>): Set<string> {
  const reached = new Set([root])
  const pending = [root]
  while (pending.length) {
    for (const edge of outgoing.get(pending.pop()!) ?? []) {
      if (reached.has(edge.target)) continue
      reached.add(edge.target)
      pending.push(edge.target)
    }
  }
  return reached
}

/** Functions, methods and classes the entry point never gets to, however indirectly. */
export function unreachedDefinitions(graph: ProjectGraph): GraphNode[] {
  if (!graph.root) return []
  const reached = reachableFrom(graph.root, outgoingEdges(graph.edges, true))
  return graph.nodes
    .filter((node) => (node.kind === 'function' || node.kind === 'method' || node.kind === 'class') && !reached.has(node.id))
    .sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0))
}
