// The one interface between the UI and the desktop backend.
// The renderer only ever talks to `window.iris`, so swapping Electron for
// another shell (e.g. Tauri) means reimplementing this file's contract and nothing else.

export interface FileNode {
  name: string
  /** Path relative to the project root, always with forward slashes. */
  path: string
  kind: 'file' | 'dir'
  children?: FileNode[]
}

export interface ProjectInfo {
  /** Absolute path of the project folder. */
  root: string
  name: string
  tree: FileNode[]
  /** Entry point chosen by the user (relative path), or null if none was chosen. */
  entryPoint: string | null
}

export type RunEvent =
  | { type: 'start'; command: string }
  | { type: 'output'; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; code: number | null; stopped: boolean }
  | { type: 'error'; message: string }

// ---------- Project graph (the tree view) ----------

export type GraphNodeKind = 'module' | 'function' | 'method' | 'class' | 'config' | 'data'

/** What a branch means: a function call, importing a module that does work, loading config, or reading/writing data. */
export type GraphEdgeKind = 'call' | 'import' | 'config' | 'data'

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  label: string
  /** Project-relative file to open for this node, or null for things outside the project (network, environment). */
  file: string | null
  /** 1-based line of the definition inside `file`, if there is one. */
  line: number | null
  /** Last line of the definition, for showing just that function. */
  endLine?: number | null
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: GraphEdgeKind
  /** True when the link is a best guess: a callback passed as an argument, a decorator, or a method matched by name. */
  inferred: boolean
  /** 1-based line in the source node's file where this first happens. */
  line: number
  /** For config and data branches. */
  access?: 'read' | 'write'
  /** True for a branch that only showed up when the code ran; reading the code did not find it. */
  observed?: boolean
}

export interface ProjectGraph {
  /** Node id of the entry file, or null if it could not be analyzed. */
  root: string | null
  /** Every file, function and resource found, including ones the entry point never reaches. */
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Files that could not be read or contain syntax errors. */
  problems: { file: string; message: string }[]
}

// ---------- Run traces (the run view) ----------
// Code is named the way the Python tracer names it: "<path inside the project>::<qualified name>",
// for example "shop/pricing.py::total.<locals>.rounded". The renderer maps these names onto graph nodes.

export type TraceFact =
  | {
      type: 'call'
      /** The project code that made the call, or null for the first one (the entry point starting). */
      from: string | null
      to: string
      /** For a constructor: the subclass actually being created, when it is not the class that defines it. */
      created: string | null
      /** Line in `from` where the call happened. */
      line: number | null
      /** Position in the order things first happened, from 0. */
      order: number
    }
  | {
      type: 'io'
      from: string
      op: 'open' | 'sqlite' | 'net' | 'env'
      /** A file path, database, host name or environment variable name. */
      target: string
      /** For files inside the project, the path relative to it. */
      relative: string | null
      access: 'read' | 'write'
      kind: 'config' | 'data'
      line: number | null
      order: number
    }

/** An error the project's own code did not catch. Values are short descriptions written by the tracer. */
export interface TraceFailure {
  /** The exception's number within the run. */
  id: number
  type: string
  message: string
  /** The project function where it was raised (a lambda or comprehension counts as the function around it). */
  fn: string
  line: number
  /** When it started inside a library that function called, where: "decoder.py:raw_decode". */
  origin: string | null
  /** The function's parameters, and its other local variables, at the moment it failed. */
  args: Record<string, string>
  locals: Record<string, string>
  /** The function that called it, the line of that call, and the caller's variables at that moment. */
  caller: { fn: string; line: number | null; locals: Record<string, string> } | null
  /** Every project function the error passed through, from where it was raised outwards. */
  path: string[]
  /** True for the error that ended the run. */
  fatal: boolean
  /** Position in the run, comparable with TraceFact.order. */
  order: number
}

export type TraceUpdate =
  /** Whether this run can be traced at all, and why not. */
  | { type: 'info'; traced: boolean; note: string | null }
  /** Errors no project code caught, and how many errors project code did catch. */
  | { type: 'failures'; failures: TraceFailure[]; caught: number }
  /** Things that happened for the first time. `wrappers` are decorators' wrapper functions; `hot` stopped being counted. */
  | { type: 'facts'; facts: TraceFact[]; wrappers: string[]; hot: string[] }
  /** Times branches have run so far: [from, to, times, created]. */
  | { type: 'counts'; counts: [string | null, string, number, string | null][] }
  | { type: 'end'; exitCode: number | null; error: { type: string; message: string } | null }

// ---------- Settings ----------

export interface AppSettings {
  theme: 'system' | 'dark' | 'light'
  /** Which way the tree grows from the entry point. */
  treeDirection: 'horizontal' | 'vertical'
  /** Show best-guess links (dashed) in the tree. */
  showInferredLinks: boolean
  /** Show the plain file list beside the tree. */
  showFileList: boolean
  editorFontSize: number
  editorWordWrap: boolean
  editorMinimap: boolean
  terminalFontSize: number
  /** Python interpreter used by Run: a command on PATH or a full path. */
  pythonPath: string
  /** Run through the tracer so the tree lights up with what ran. */
  traceRuns: boolean
  reopenLastProject: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  treeDirection: 'horizontal',
  showInferredLinks: true,
  showFileList: false,
  editorFontSize: 14,
  editorWordWrap: false,
  editorMinimap: false,
  terminalFontSize: 13,
  pythonPath: 'python',
  traceRuns: true,
  reopenLastProject: true
}

export const FONT_SIZE_RANGE = { min: 9, max: 28 } as const

export interface PythonCheck {
  ok: boolean
  /** The version string when it works, otherwise why it does not. */
  message: string
}

// ---------- The API ----------

export type Unsubscribe = () => void

export interface IrisApi {
  project: {
    /** Shows the folder picker. Resolves to null if the user cancels. */
    openDialog(): Promise<ProjectInfo | null>
    /** Reopens the project from the previous session, if it still exists. */
    openLast(): Promise<ProjectInfo | null>
    /** Re-reads the file list of the open project. */
    refresh(): Promise<ProjectInfo | null>
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
    /** Creates an empty file, along with any missing folders in its path. Rejects if the file already exists. */
    createFile(path: string): Promise<void>
    setEntryPoint(path: string | null): Promise<void>
  }
  graph: {
    /** Reads the project's Python files and maps what the entry point calls, loads and writes. */
    analyze(entryPoint: string): Promise<ProjectGraph>
  }
  terminal: {
    /** Starts a shell in the project folder, replacing any shell already running. */
    start(cols: number, rows: number): Promise<void>
    write(data: string): void
    resize(cols: number, rows: number): void
    onData(listener: (data: string) => void): Unsubscribe
  }
  run: {
    /** Runs a Python file from the open project. Progress arrives through onEvent, and what ran through onTrace. */
    start(path: string): Promise<void>
    stop(): Promise<void>
    onEvent(listener: (event: RunEvent) => void): Unsubscribe
    onTrace(listener: (update: TraceUpdate) => void): Unsubscribe
  }
  settings: {
    get(): Promise<AppSettings>
    /** Saves the given settings and resolves to the full, validated result. */
    update(changes: Partial<AppSettings>): Promise<AppSettings>
    /** Shows a file picker for the Python interpreter. Resolves to null if the user cancels. */
    pickPython(): Promise<string | null>
    /** Tries to run the given interpreter and reports its version. */
    checkPython(path: string): Promise<PythonCheck>
  }
}

export const Channels = {
  projectOpenDialog: 'project:open-dialog',
  projectOpenLast: 'project:open-last',
  projectRefresh: 'project:refresh',
  projectReadFile: 'project:read-file',
  projectWriteFile: 'project:write-file',
  projectCreateFile: 'project:create-file',
  projectSetEntryPoint: 'project:set-entry-point',
  graphAnalyze: 'graph:analyze',
  terminalStart: 'terminal:start',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalData: 'terminal:data',
  runStart: 'run:start',
  runStop: 'run:stop',
  runEvent: 'run:event',
  runTrace: 'run:trace',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsPickPython: 'settings:pick-python',
  settingsCheckPython: 'settings:check-python'
} as const
