import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { DEFAULT_SETTINGS, type AppSettings, type FileNode, type ProjectGraph, type ProjectInfo } from '../../shared/api'
import { EditorPane, type EditorHandle } from './components/EditorPane'
import { FileList } from './components/FileList'
import { FocusView } from './components/FocusView'
import { EyeIcon } from './components/icons'
import { RunPane } from './components/RunPane'
import { SettingsDialog } from './components/SettingsDialog'
import { TerminalPane } from './components/TerminalPane'
import { TopBar } from './components/TopBar'
import { TreeView } from './components/TreeView'
import { useTheme } from './theme'
import { applyTraceUpdate, newTrace, resolveTrace, type RunTrace } from './tree/trace'

interface OpenFile {
  path: string
  content: string
  /** Line to show first, when the file was opened from a node in the tree. */
  line: number | null
}

type BottomTab = 'terminal' | 'run'

/** Strips the wrapper Electron adds around errors thrown by the backend. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function pythonFilesIn(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === 'dir' ? pythonFilesIn(node.children ?? []) : node.path.endsWith('.py') ? [node.path] : []))
}

export function App() {
  // `ready` flips once the last project has been restored, so the terminal starts in the right folder.
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [graph, setGraph] = useState<ProjectGraph | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [openFile, setOpenFile] = useState<OpenFile | null>(null)
  const [dirty, setDirty] = useState(false)
  const [running, setRunning] = useState(false)
  /** What the last run did, for the tree's run view. */
  const [trace, setTrace] = useState<RunTrace | null>(null)
  /** The 👁 focus view on the error the last run flagged. */
  const [focusOpen, setFocusOpen] = useState(false)
  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal')
  const [bottomHeight, setBottomHeight] = useState(240)
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<EditorHandle>(null)
  const analysisRun = useRef(0)
  const theme = useTheme(settings.theme)

  const pythonFiles = useMemo(() => pythonFilesIn(project?.tree ?? []), [project?.tree])

  // The user's choice wins; otherwise fall back to main.py, then to the Python file being edited.
  const entryPoint =
    project?.entryPoint ??
    (project?.tree.some((node) => node.kind === 'file' && node.path === 'main.py')
      ? 'main.py'
      : openFile?.path.endsWith('.py')
        ? openFile.path
        : null)

  const refreshTree = useCallback(async () => {
    const info = await window.iris.project.refresh().catch(() => null)
    if (info) setProject((current) => (current?.root === info.root ? { ...current, tree: info.tree } : current))
  }, [])

  const changeSettings = useCallback((changes: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...changes }))
    window.iris.settings
      .update(changes)
      .then(setSettings)
      .catch((caught) => setError(errorMessage(caught)))
  }, [])

  useEffect(() => {
    window.iris.settings
      .get()
      .then(setSettings)
      .catch(() => {})
    window.iris.project
      .openLast()
      .then(setProject)
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])

  useEffect(
    () =>
      window.iris.run.onEvent((event) => {
        if (event.type === 'start') {
          setRunning(true)
          setTrace(newTrace())
        }
        if (event.type === 'exit' || event.type === 'error') {
          setRunning(false)
          // The trace normally reports its own end; this covers runs that never got as far as tracing.
          setTrace((current) =>
            current && {
              ...current,
              status: 'done',
              stopped: event.type === 'exit' && event.stopped,
              exitCode: current.exitCode ?? (event.type === 'exit' ? event.code : null)
            }
          )
          void refreshTree() // The script may have created or removed files.
        }
      }),
    [refreshTree]
  )

  useEffect(
    () => window.iris.run.onTrace((update) => setTrace((current) => (current ? applyTraceUpdate(current, update) : current))),
    []
  )

  // Pick up files changed outside Iris when the window regains focus.
  useEffect(() => {
    window.addEventListener('focus', refreshTree)
    return () => window.removeEventListener('focus', refreshTree)
  }, [refreshTree])

  useEffect(() => {
    const openSettings = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key === ',') setSettingsOpen(true)
    }
    window.addEventListener('keydown', openSettings)
    return () => window.removeEventListener('keydown', openSettings)
  }, [])

  // Rebuilds the tree's data. Runs when the project, its files or the entry point change, and after each save.
  const projectRoot = project?.root ?? null
  const analyze = useCallback(async () => {
    const run = ++analysisRun.current
    if (!projectRoot || !entryPoint?.endsWith('.py')) {
      setGraph(null)
      setAnalyzing(false)
      return
    }
    setAnalyzing(true)
    try {
      const next = await window.iris.graph.analyze(entryPoint)
      if (run !== analysisRun.current) return
      // Keep the old object when nothing changed, so the tree does not redraw for no reason.
      setGraph((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next))
    } catch (caught) {
      if (run !== analysisRun.current) return
      setGraph(null)
      setError(errorMessage(caught))
    } finally {
      if (run === analysisRun.current) setAnalyzing(false)
    }
  }, [projectRoot, entryPoint])

  useEffect(() => {
    void analyze()
  }, [analyze, project?.tree])

  // A run belongs to one project and entry point.
  useEffect(() => setTrace(null), [projectRoot, entryPoint])

  // What the run means for the tree. A run that could not be traced has nothing to show there.
  const runView = useMemo(
    () => (graph && trace && (trace.traced === true || (trace.traced === null && trace.status === 'running')) ? resolveTrace(graph, trace) : null),
    [graph, trace]
  )
  const runNodes = useMemo(
    () => new Map([...(graph?.nodes ?? []), ...(runView?.extraNodes ?? [])].map((node) => [node.id, node])),
    [graph, runView]
  )
  const failure = runView?.failure ?? null
  useEffect(() => setFocusOpen(false), [trace?.id])
  const focusError = useCallback(() => setFocusOpen(true), [])

  const confirmDiscard = (): boolean =>
    !dirty || !openFile || window.confirm(`Discard unsaved changes to ${openFile.path}?`)

  const openFolder = async (): Promise<void> => {
    if (!confirmDiscard()) return
    try {
      const info = await window.iris.project.openDialog()
      if (!info) return
      if (running) await window.iris.run.stop()
      setProject(info)
      setGraph(null)
      setOpenFile(null)
      setDirty(false)
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const openPath = useCallback(
    async (path: string, line: number | null = null): Promise<void> => {
      if (path === openFile?.path) {
        if (line) editorRef.current?.reveal(line)
        return
      }
      if (dirty && openFile && !window.confirm(`Discard unsaved changes to ${openFile.path}?`)) return
      try {
        const content = await window.iris.project.readFile(path)
        setOpenFile({ path, content, line })
        setDirty(false)
        setError(null)
      } catch (caught) {
        setError(errorMessage(caught))
      }
    },
    [openFile, dirty]
  )

  const createFile = async (path: string): Promise<boolean> => {
    if (!confirmDiscard()) return false
    try {
      await window.iris.project.createFile(path)
      await refreshTree()
      setOpenFile({ path, content: '', line: null })
      setDirty(false)
      setError(null)
      return true
    } catch (caught) {
      setError(errorMessage(caught))
      return false
    }
  }

  const closeFile = (): void => {
    if (!confirmDiscard()) return
    setOpenFile(null)
    setDirty(false)
  }

  const saveFile = async (content: string): Promise<void> => {
    if (!openFile) return
    try {
      await window.iris.project.writeFile(openFile.path, content)
      setError(null)
      void analyze()
    } catch (caught) {
      setError(errorMessage(caught))
      throw caught
    }
  }

  const chooseEntryPoint = async (path: string): Promise<void> => {
    if (!path) return
    try {
      await window.iris.project.setEntryPoint(path)
      setProject((current) => current && { ...current, entryPoint: path })
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const run = async (): Promise<void> => {
    if (!entryPoint) return
    try {
      await editorRef.current?.save()
    } catch {
      return // saveFile already reported why; don't run stale code.
    }
    setBottomTab('run')
    try {
      await window.iris.run.start(entryPoint)
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const dragDivider = (event: PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const height = window.innerHeight - event.clientY
    setBottomHeight(Math.min(Math.max(height, 90), window.innerHeight - 200))
  }

  const terminalLook = { fontSize: settings.terminalFontSize, theme }

  return (
    <div className="app" style={{ gridTemplateRows: `44px minmax(0, 1fr) 5px ${bottomHeight}px` }}>
      <TopBar
        projectName={project?.name ?? null}
        entryPoint={entryPoint}
        pythonFiles={pythonFiles}
        running={running}
        showFileList={settings.showFileList}
        onOpenFolder={openFolder}
        onNewFile={createFile}
        onToggleFileList={() => changeSettings({ showFileList: !settings.showFileList })}
        onEntryPoint={chooseEntryPoint}
        onRun={run}
        onStop={() => void window.iris.run.stop()}
        onSettings={() => setSettingsOpen(true)}
      />

      <div className="workspace">
        {project && settings.showFileList && (
          <FileList
            tree={project.tree}
            openPath={openFile?.path ?? null}
            entryPoint={entryPoint}
            onOpen={openPath}
            onSetEntryPoint={chooseEntryPoint}
          />
        )}
        <main className="center">
          {error && (
            <button className="error-banner" title="Dismiss" onClick={() => setError(null)}>
              {error}
            </button>
          )}
          <div className="stage">
            {/* The tree is the home screen. It stays mounted under the editor so it is exactly as you left it. */}
            {project ? (
              <TreeView
                graph={graph}
                analyzing={analyzing}
                entryPoint={entryPoint}
                hasPythonFiles={pythonFiles.length > 0}
                direction={settings.treeDirection}
                showInferred={settings.showInferredLinks}
                theme={theme}
                trace={trace}
                runView={runView}
                onOpen={openPath}
                onClearTrace={() => setTrace(null)}
                onFocusError={focusError}
              />
            ) : (
              <div className="home">
                <h1>Iris</h1>
                {ready && (
                  <>
                    <p className="muted">Open a Python project folder to get started.</p>
                    <button className="primary" onClick={openFolder}>
                      Open Folder
                    </button>
                  </>
                )}
              </div>
            )}

            {focusOpen && failure && (
              <FocusView
                failure={failure}
                nodes={runNodes}
                theme={theme}
                fontSize={settings.editorFontSize}
                onOpen={(file, line) => {
                  setFocusOpen(false)
                  void openPath(file, line)
                }}
                onClose={() => setFocusOpen(false)}
              />
            )}

            {openFile && (
              <div className="editor-layer">
                <div className="tab-bar">
                  <button className="back-button" title="Close the file and go back to the tree" onClick={closeFile}>
                    ← Tree
                  </button>
                  <span className="tab active">
                    {openFile.path}
                    {dirty && <span className="dirty-dot" title="Unsaved changes (Ctrl+S to save)" />}
                  </span>
                  <span className="spacer" />
                  {failure && (
                    <button
                      className="focus-button"
                      title={`The last run failed with ${failure.error.type}. Look at where, side by side with its caller`}
                      onClick={focusError}
                    >
                      <EyeIcon /> Focus on the error
                    </button>
                  )}
                  <button className="icon-button" title="Close file" onClick={closeFile}>
                    ✕
                  </button>
                </div>
                <EditorPane
                  key={`${project?.root}:${openFile.path}`}
                  ref={editorRef}
                  path={openFile.path}
                  content={openFile.content}
                  line={openFile.line}
                  fontSize={settings.editorFontSize}
                  wordWrap={settings.editorWordWrap}
                  minimap={settings.editorMinimap}
                  theme={theme}
                  onSave={saveFile}
                  onDirtyChange={setDirty}
                />
              </div>
            )}
          </div>
        </main>
      </div>

      <div
        className="divider"
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={dragDivider}
      />

      <section className="bottom-panel">
        <div className="tab-bar">
          <button className={`tab${bottomTab === 'terminal' ? ' active' : ''}`} onClick={() => setBottomTab('terminal')}>
            Terminal
          </button>
          <button className={`tab${bottomTab === 'run' ? ' active' : ''}`} onClick={() => setBottomTab('run')}>
            Run
            {running && <span className="running-dot" />}
          </button>
        </div>
        <div className="bottom-body">
          <div className={`pane${bottomTab === 'terminal' ? '' : ' hidden'}`}>
            {ready && <TerminalPane projectRoot={project?.root ?? null} {...terminalLook} />}
          </div>
          <div className={`pane${bottomTab === 'run' ? '' : ' hidden'}`}>
            <RunPane {...terminalLook} />
          </div>
        </div>
      </section>

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          projectName={project?.name ?? null}
          entryPoint={entryPoint}
          pythonFiles={pythonFiles}
          onChange={changeSettings}
          onEntryPoint={chooseEntryPoint}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
