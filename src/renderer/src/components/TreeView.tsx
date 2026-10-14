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
import { EDGE_COLORS, ERROR_EDGE_COLORS, IDLE_EDGE_COLORS, type Theme } from '../theme'
import {
  connectedTo,
  layoutTree,
  NODE_HEIGHT,
  NODE_WIDTH,
  outgoingEdges,
  pathTo,
  reachableFrom,
  unreachedDefinitions,
  visibleTree,
  type Direction
} from '../tree/layout'
import { nodesAlongRun, runCoverage, type RunTrace, type RunView } from '../tree/trace'
import { EyeIcon } from './icons'
import { RunBar } from './RunBar'

interface Props {
  graph: ProjectGraph | null
  analyzing: boolean
  entryPoint: string | null
  hasPythonFiles: boolean
  direction: Direction
  showInferred: boolean
  theme: Theme
  /** The latest run, while it is on show, and what it means for the tree. */
  trace: RunTrace | null
  runView: RunView | null
  onOpen(file: string, line: number | null): void
  onClearTrace(): void
  /** Opens the focus view on the error the run flagged. */
  onFocusError(): void
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
  /** Run view: the function that failed, or the one that called it. */
  flag: 'failing' | 'calling' | null
  /** Run view: the failing function is somewhere among this node's hidden branches. */
  hiddenError: boolean
}
type TreeFlowNode = Node<TreeNodeData, 'tree'>

const LEGEND: [GraphEdgeKind, string][] = [
  ['call', 'calls a function'],
  ['config', 'loads config'],
  ['data', 'reads or writes data'],
  ['import', 'imports a module that runs code']
]

const COUNTED = new Set(['function', 'method', 'class'])

interface Actions {
  toggle(id: string): void
  open(node: GraphNode): void
  focusError(): void
}
const TreeActions = createContext<Actions>({ toggle() {}, open() {}, focusError() {} })

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
  const flagClass = data.flag ? ` flag-${data.flag}` : ''
  return (
    <div className={`tree-node kind-${node.kind}${data.isRoot ? ' root' : ''}${data.selected ? ' selected' : ''}${flagClass}`}>
      <Handle type="target" position={data.horizontal ? Position.Left : Position.Top} isConnectable={false} />
      <div className="tree-node-text">
        <div className="tree-node-label" title={node.label}>
          {node.label}
        </div>
        <div className="tree-node-sub" title={node.file ? `${node.file}${text.includes('·') ? text.slice(text.indexOf(' ·')) : ''}` : text}>
          {text}
        </div>
      </div>
      {data.flag && (
        <button
          className="tree-eye nodrag nopan"
          title={data.flag === 'failing' ? 'It failed here. Focus on the error' : 'This called the function that failed. Focus on the error'}
          onClick={(event) => {
            event.stopPropagation()
            actions.focusError()
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <EyeIcon />
        </button>
      )}
      {data.branches > 0 && (
        <button
          className={`tree-toggle nodrag nopan${data.hiddenError ? ' has-error' : data.hiddenRan ? ' has-ran' : ''}`}
          title={
            data.expanded
              ? 'Collapse'
              : `Show ${data.branches} ${data.branches === 1 ? 'branch' : 'branches'}${
                  data.hiddenError ? ' (the error is in there)' : data.hiddenRan ? ' (some of them ran)' : ''
                }`
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
/** The same, with room for the run bar under the buttons. */
const FIT_PADDING_WITH_RUN_BAR = { ...FIT_PADDING, top: '112px' } as const

function TreeCanvas({
  graph,
  analyzing,
  entryPoint,
  hasPythonFiles,
  direction,
  showInferred,
  theme,
  trace,
  runView,
  onOpen,
  onClearTrace,
  onFocusError
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

  // The error the run flagged: it shows once the lighting-up reaches it.
  const failure = runView?.failure ?? null
  const flagged = !!failure && shownOrder >= failure.error.order
  const errorPath = useMemo(
    () => (failure?.failing && root ? (pathTo(root, failure.failing, outgoing) ?? []) : []),
    [failure, root, outgoing]
  )
  const errorAncestors = useMemo(() => new Set(errorPath.slice(0, -1)), [errorPath])

  // When a run fails, open the tree just enough to show where.
  const failureKey = failure ? `${traceId}:${failure.error.id}` : null
  useEffect(() => {
    if (!failureKey || errorPath.length < 2) return
    setExpanded((current) => new Set([...current, ...errorPath.slice(0, -1)]))
    // errorPath is read as it was when this failure first appeared; later changes must not reopen what the user closed.
  }, [failureKey])

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
        const flag = flagged ? (id === failure?.failing ? 'failing' : id === failure?.caller ? 'calling' : null) : null
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
              hiddenRan: !!runView && !expanded.has(id) && (outgoing.get(id) ?? []).some(edgeLit),
              flag,
              hiddenError: flagged && !expanded.has(id) && errorAncestors.has(id)
            }
          }
        ]
      })
    })
    // edgeLit and nodeLit only read runView, root and shownOrder, which are listed.
  }, [tree, positions, focus, nodeById, outgoing, expanded, selected, root, direction, runView, shownOrder, flagged, failure, errorAncestors, setNodes])

  const edges = useMemo(
    () =>
      (tree?.edges ?? []).map((edge): Edge => {
        const lit = edgeLit(edge)
        const idle = !!runView && !lit
        const broken = flagged && edge.id === failure?.edge
        const color = broken ? ERROR_EDGE_COLORS[theme] : idle ? IDLE_EDGE_COLORS[theme] : EDGE_COLORS[theme][edge.kind]
        // A likely link that the run saw happen is drawn solid; one that only counts because both ends ran stays dashed.
        const dashed = edge.inferred && !(lit && !runView?.indirect.has(edge.id))
        const classes = [
          focus && !(focus.has(edge.source) && focus.has(edge.target)) ? 'faded' : '',
          runView ? (lit ? 'ran' : 'idle') : '',
          broken ? 'error-branch' : ''
        ].filter(Boolean)
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          selectable: false,
          focusable: false,
          className: classes.join(' ') || undefined,
          style: { stroke: color, strokeWidth: broken ? 3 : lit ? 2.4 : 1.6, strokeDasharray: dashed && !broken ? '5 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 }
        }
      }),
    // edgeLit only reads runView and shownOrder, which are listed.
    [tree, focus, theme, runView, shownOrder, flagged, failure]
  )

  // Bring newly shown branches into view, keeping clear of the run bar while it is there.
  const showRunBar = !!trace && (trace.traced !== null || trace.status === 'running')
  const shape = `${direction}|${showRunBar}|${tree?.order.join('|') ?? ''}`
  useEffect(() => {
    const padding = showRunBar ? FIT_PADDING_WITH_RUN_BAR : FIT_PADDING
    const timer = window.setTimeout(() => void fitView({ padding, duration: 300, maxZoom: 1 }), 60)
    return () => window.clearTimeout(timer)
    // showRunBar is part of shape.
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
      },
      focusError: onFocusError
    }),
    [onOpen, onFocusError]
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
                canFocus={!!failure}
                onShowRan={() => runView && setExpanded(nodesAlongRun(root, outgoing, runView.ran))}
                onReplay={() => setShownOrder(-1)}
                onFocus={onFocusError}
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
            {flagged && (
              <span>
                <i style={{ background: ERROR_EDGE_COLORS[theme] }} />
                where it failed
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
