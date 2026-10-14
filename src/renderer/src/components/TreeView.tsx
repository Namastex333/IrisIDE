import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { GraphEdge, GraphEdgeKind, GraphNode, ProjectGraph } from '../../../shared/api'
import { EDGE_COLORS, IDLE_EDGE_COLORS, type Theme } from '../theme'
import {
  connectedTo,
  layoutTree,
  NODE_HEIGHT,
  NODE_WIDTH,
  outgoingEdges,
  reachableFrom,
  unreachedDefinitions,
  visibleTree,
  type Direction
} from '../tree/layout'
import { nodesAlongRun, resolveTrace, runCoverage, type RunTrace } from '../tree/trace'
import { RunBar } from './RunBar'

interface Props {
  graph: ProjectGraph | null
  analyzing: boolean
  entryPoint: string | null
  hasPythonFiles: boolean
  direction: Direction
  showInferred: boolean
  theme: Theme
  /** The latest run, while it is on show. */
  trace: RunTrace | null
  onOpen(file: string, line: number | null): void
  onClearTrace(): void
}

type TreeNodeData = {
  node: GraphNode
  /** How many branches leave this node. */
  branches: number
  expanded: boolean
  selected: boolean
  isRoot: boolean
  horizontal: boolean
  /** Run view: times this ran, when known. */
  calls: number | null
  /** Run view: called so often that counting stopped. */
  busy: boolean
  /** Run view: some of this node's hidden branches ran. */
  hiddenRan: boolean
}
type TreeFlowNode = Node<TreeNodeData, 'tree'>

const LEGEND: [GraphEdgeKind, string][] = [
  ['call', 'calls a function'],
  ['config', 'loads config'],
  ['data', 'reads or writes data'],
  ['import', 'imports a module that runs code']
]

const COUNTED = new Set(['function', 'method', 'class'])

const TreeActions = createContext<{ toggle(id: string): void; open(node: GraphNode): void }>({ toggle() {}, open() {} })

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

function subtitle(node: GraphNode, isRoot: boolean, calls: number | null, busy: boolean): string {
  let text: string
  switch (node.kind) {
    case 'module':
      text = isRoot ? 'entry point' : 'module'
      break
    case 'config':
      text = node.file ? 'config file' : 'config'
      break
    case 'data':
      text = node.file ? 'data file' : 'data'
      break
    default:
      text = node.file ?? ''
  }
  if (calls && COUNTED.has(node.kind)) text += ` · ran ${calls.toLocaleString()}${busy ? '+' : ''}×`
  return text
}

const TreeNode = memo(function TreeNode({ id, data }: NodeProps<TreeFlowNode>) {
  const actions = useContext(TreeActions)
  const { node } = data
  const text = subtitle(node, data.isRoot, data.calls, data.busy)
  return (
    <div className={`tree-node kind-${node.kind}${data.isRoot ? ' root' : ''}${data.selected ? ' selected' : ''}`}>
      <Handle type="target" position={data.horizontal ? Position.Left : Position.Top} isConnectable={false} />
      <div className="tree-node-text">
        <div className="tree-node-label" title={node.label}>
          {node.label}
        </div>
        <div className="tree-node-sub" title={node.file ? `${node.file}${text.includes('·') ? text.slice(text.indexOf(' ·')) : ''}` : text}>
          {text}
        </div>
      </div>
      {data.branches > 0 && (
        <button
          className={`tree-toggle nodrag nopan${data.hiddenRan ? ' has-ran' : ''}`}
          title={
            data.expanded
              ? 'Collapse'
              : `Show ${data.branches} ${data.branches === 1 ? 'branch' : 'branches'}${data.hiddenRan ? ' (some of them ran)' : ''}`
          }
          onClick={(event) => {
            event.stopPropagation()
            actions.toggle(id)
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {data.expanded ? '−' : data.branches}
        </button>
      )}
      <NodeToolbar isVisible={data.selected && !!node.file} position={Position.Top} offset={6}>
        <button className="tree-open" onClick={() => actions.open(node)}>
          Open {node.file && baseName(node.file)}
          {node.line && node.line > 1 ? `:${node.line}` : ''}
        </button>
      </NodeToolbar>
      <Handle type="source" position={data.horizontal ? Position.Right : Position.Bottom} isConnectable={false} />
    </div>
  )
})

const NODE_TYPES = { tree: TreeNode }

/** Room left around the tree for the buttons (top), the legend (bottom) and the zoom controls (right). */
const FIT_PADDING = { top: '70px', right: '70px', bottom: '60px', left: '40px' } as const

function TreeCanvas({
  graph,
  analyzing,
  entryPoint,
  hasPythonFiles,
  direction,
  showInferred,
  theme,
  trace,
  onOpen,
  onClearTrace
}: Props) {
  const root = graph?.root ?? null
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [showUnreached, setShowUnreached] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<TreeFlowNode>([])
  const { fitView } = useReactFlow()

  // A new project or entry point starts with only its first level of branches open.
  useEffect(() => {
    setExpanded(new Set(root ? [root] : []))
    setSelected(null)
    setShowUnreached(false)
  }, [root])

  // Run view. A run that could not be traced has nothing to show on the tree.
  const runView = useMemo(
    () => (graph && trace && (trace.traced === true || (trace.traced === null && trace.status === 'running')) ? resolveTrace(graph, trace) : null),
    [graph, trace]
  )

  const nodeById = useMemo(
    () => new Map([...(graph?.nodes ?? []), ...(runView?.extraNodes ?? [])].map((node) => [node.id, node])),
    [graph, runView]
  )
  const outgoing = useMemo(
    () =>
      graph
        ? outgoingEdges([...graph.edges, ...(runView?.extraEdges ?? [])], showInferred, runView?.ran)
        : new Map<string, GraphEdge[]>(),
    [graph, runView, showInferred]
  )
  const tree = useMemo(() => (root ? visibleTree(root, outgoing, expanded) : null), [root, outgoing, expanded])
  const positions = useMemo(() => (tree ? layoutTree(tree, direction) : null), [tree, direction])
  const unreached = useMemo(() => (graph ? unreachedDefinitions(graph) : []), [graph])
  const coverage = useMemo(() => (runView && root ? runCoverage(root, outgoing, runView.ran) : null), [runView, root, outgoing])

  // Branches that ran light up one after another, in the order they first ran, up to this point in that order.
  const [shownOrder, setShownOrder] = useState(Infinity)
  const traceId = trace?.id
  useEffect(() => setShownOrder(-1), [traceId])
  const visibleOrders = useMemo(() => {
    if (!runView || !tree) return []
    const orders = new Set<number>()
    for (const edge of tree.edges) {
      const order = runView.ran.get(edge.id)
      if (order !== undefined) orders.add(order)
    }
    return [...orders].sort((a, b) => a - b)
  }, [runView, tree])
  const runFinished = trace?.status === 'done'
  useEffect(() => {
    if (!runView) return
    const next = visibleOrders.find((order) => order > shownOrder)
    if (next === undefined) {
      // Everything on screen has lit up. Once the run is over, branches opened later show as lit straight away.
      if (runFinished && shownOrder !== Infinity) setShownOrder(Infinity)
      return
    }
    // Long runs light up faster, so the whole thing takes a couple of seconds at most.
    const waiting = visibleOrders.filter((order) => order > shownOrder).length
    const timer = window.setTimeout(() => setShownOrder(next), Math.max(40, Math.min(180, 2400 / waiting)))
    return () => window.clearTimeout(timer)
  }, [runView, visibleOrders, shownOrder, runFinished])

  const edgeLit = (edge: GraphEdge): boolean => (runView?.ran.get(edge.id) ?? Infinity) <= shownOrder
  const nodeLit = (id: string): boolean => id === root || (runView?.nodeOrder.get(id) ?? Infinity) <= shownOrder

  // Focus mode: with a node selected, everything that neither leads to it nor follows from it fades out.
  const focus = useMemo(
    () => (selected && tree?.parent.has(selected) ? connectedTo(selected, tree.edges) : null),
    [selected, tree]
  )

  const measuredDirection = useRef(direction)
  useEffect(() => {
    // Branches attach to different sides of a node in each direction, so a change of direction needs a fresh measure.
    const remeasure = measuredDirection.current !== direction
    measuredDirection.current = direction
    setNodes((previous) => {
      if (!tree || !positions) return []
      // Otherwise, carrying the measured size over stops React Flow from re-measuring (and briefly hiding) nodes on every change.
      const measured = new Map(remeasure ? [] : previous.map((node) => [node.id, node.measured]))
      const horizontal = direction === 'horizontal'
      return tree.order.flatMap((id): TreeFlowNode[] => {
        const node = nodeById.get(id)
        const position = positions.get(id)
        if (!node || !position) return []
        const lit = runView ? nodeLit(id) : false
        const classes = [focus && !focus.has(id) ? 'faded' : '', runView ? (lit ? 'ran' : 'idle') : ''].filter(Boolean).join(' ')
        return [
          {
            id,
            type: 'tree',
            position,
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            measured: measured.get(id),
            draggable: false,
            selectable: false,
            className: classes || undefined,
            data: {
              node,
              branches: outgoing.get(id)?.length ?? 0,
              expanded: expanded.has(id),
              selected: id === selected,
              isRoot: id === root,
              horizontal,
              calls: lit ? (runView?.calls.get(id) ?? null) : null,
              busy: runView?.busy.has(id) ?? false,
              hiddenRan: !!runView && !expanded.has(id) && (outgoing.get(id) ?? []).some(edgeLit)
            }
          }
        ]
      })
    })
    // edgeLit and nodeLit only read runView, root and shownOrder, which are listed.
  }, [tree, positions, focus, nodeById, outgoing, expanded, selected, root, direction, runView, shownOrder, setNodes])

  const edges = useMemo(
    () =>
      (tree?.edges ?? []).map((edge): Edge => {
        const lit = edgeLit(edge)
        const idle = !!runView && !lit
        const color = idle ? IDLE_EDGE_COLORS[theme] : EDGE_COLORS[theme][edge.kind]
        // A likely link that the run saw happen is drawn solid; one that only counts because both ends ran stays dashed.
        const dashed = edge.inferred && !(lit && !runView?.indirect.has(edge.id))
        const classes = [
          focus && !(focus.has(edge.source) && focus.has(edge.target)) ? 'faded' : '',
          runView ? (lit ? 'ran' : 'idle') : ''
        ].filter(Boolean)
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          selectable: false,
          focusable: false,
          className: classes.join(' ') || undefined,
          style: { stroke: color, strokeWidth: lit ? 2.4 : 1.6, strokeDasharray: dashed ? '5 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 }
        }
      }),
    // edgeLit only reads runView and shownOrder, which are listed.
    [tree, focus, theme, runView, shownOrder]
  )

  // Bring newly shown branches into view.
  const shape = `${direction}|${tree?.order.join('|') ?? ''}`
  useEffect(() => {
    const timer = window.setTimeout(() => void fitView({ padding: FIT_PADDING, duration: 300, maxZoom: 1 }), 60)
    return () => window.clearTimeout(timer)
  }, [shape, fitView])

  const actions = useMemo(
    () => ({
      toggle: (id: string) =>
        setExpanded((current) => {
          const next = new Set(current)
          if (!next.delete(id)) next.add(id)
          return next
        }),
      open: (node: GraphNode) => {
        if (node.file) onOpen(node.file, node.line)
      }
    }),
    [onOpen]
  )

  const expandAll = (): void => {
    if (root) setExpanded(new Set([...reachableFrom(root, outgoing)].filter((id) => outgoing.has(id))))
  }

  let message: string | null = null
  if (!entryPoint) {
    message = hasPythonFiles
      ? 'Pick an entry point (the file you run) in the top bar to see its tree.'
      : 'No Python files in this folder yet. Use New File in the top bar to create one, for example main.py.'
  } else if (!graph) message = analyzing ? 'Reading the project…' : null
  else if (!root) message = `${entryPoint} was not found in this project. Pick another entry point in the top bar.`
  else if (!outgoing.has(root)) message = `${entryPoint} does not call anything Iris can follow yet.`

  const showRunBar = !!trace && (trace.traced !== null || trace.status === 'running')

  return (
    <TreeActions.Provider value={actions}>
      <ReactFlow
        className="tree-flow"
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_event, node) => setSelected(node.id)}
        onNodeDoubleClick={(_event, node) => actions.open(node.data.node)}
        onPaneClick={() => {
          setSelected(null)
          setShowUnreached(false)
        }}
        colorMode={theme}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        minZoom={0.15}
        maxZoom={1.75}
      >
        <Background gap={24} size={1} />
        <Controls position="bottom-right" showInteractive={false} />

        {root && (
          <Panel position="top-left" className="tree-panel">
            <button onClick={expandAll}>Expand all</button>
            <button onClick={() => setExpanded(new Set([root]))}>Collapse</button>
            {unreached.length > 0 && (
              <button
                className={showUnreached ? 'active' : undefined}
                title="Functions and classes the entry point never gets to"
                onClick={() => setShowUnreached((shown) => !shown)}
              >
                {unreached.length} not reached
              </button>
            )}
            {graph && graph.problems.length > 0 && (
              <span className="tree-warning" title={graph.problems.map((problem) => `${problem.file}: ${problem.message}`).join('\n')}>
                ⚠ {graph.problems.length}
              </span>
            )}
            {showRunBar && trace && (
              <RunBar
                trace={trace}
                coverage={coverage}
                onShowRan={() => runView && setExpanded(nodesAlongRun(root, outgoing, runView.ran))}
                onReplay={() => setShownOrder(-1)}
                onClear={onClearTrace}
              />
            )}
            {showUnreached && (
              <div className="tree-unreached">
                {unreached.map((node) => (
                  <button key={node.id} onClick={() => actions.open(node)}>
                    <span>{node.label}</span>
                    <span className="muted">
                      {node.file}:{node.line}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}

        {root && (
          <Panel position="bottom-left" className="tree-legend">
            {LEGEND.map(([kind, text]) => (
              <span key={kind}>
                <i style={{ background: EDGE_COLORS[theme][kind] }} />
                {text}
              </span>
            ))}
            {showInferred && (
              <span>
                <i className="dashed" />
                likely, not certain
              </span>
            )}
            {runView && (
              <span>
                <i style={{ background: IDLE_EDGE_COLORS[theme] }} />
                did not run
              </span>
            )}
          </Panel>
        )}
      </ReactFlow>
      {message && <div className="tree-message muted">{message}</div>}
    </TreeActions.Provider>
  )
}

/** The home screen: the project as a branching map that starts at the entry point. */
export function TreeView(props: Props) {
  return (
    <div className="tree-view">
      <ReactFlowProvider>
        <TreeCanvas {...props} />
      </ReactFlowProvider>
    </div>
  )
}
