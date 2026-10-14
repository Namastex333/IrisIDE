import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readdir, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import type { RunEvent, TraceUpdate } from '../../shared/api'
import { getProjectRoot, resolveInProject } from './project'
import { getPrefs } from './settings'
import { TraceTail } from './trace-tail'

/** Trace files kept per project, in .iris/traces. */
const KEEP_TRACES = 10

let running: ChildProcess | null = null
let starting = false
let stopRequested = false
let runNumber = 0

export function stopRun(): void {
  const child = running
  if (!child?.pid) return
  stopRequested = true
  if (process.platform === 'win32') {
    // Kills the script and anything it spawned.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill()
  }
}

function tracerPath(): string {
  // Packaged, the tracer sits outside the app archive (extraResources in electron-builder.yml) so Python can read it.
  return app.isPackaged
    ? join(process.resourcesPath, 'tracer', 'iris_tracer.py')
    : join(app.getAppPath(), 'resources', 'tracer', 'iris_tracer.py')
}

/** Makes room in the project's .iris/traces folder and names the next trace file. */
async function nextTraceFile(root: string): Promise<string> {
  const iris = join(root, '.iris')
  const folder = join(iris, 'traces')
  const isNew = !existsSync(iris)
  await mkdir(folder, { recursive: true })
  if (isNew) {
    // Keeps Iris's working files out of the project's git history, and out of sight in Explorer.
    await writeFile(join(iris, '.gitignore'), '*\n').catch(() => {})
    if (process.platform === 'win32') execFile('attrib', ['+h', iris], { windowsHide: true }, () => {})
  }
  const older = (await readdir(folder)).filter((name) => name.endsWith('.jsonl')).sort()
  for (const name of older.slice(0, Math.max(0, older.length - KEEP_TRACES + 1))) {
    await unlink(join(folder, name)).catch(() => {})
  }
  return join(folder, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
}

export async function startRun(
  path: string,
  emit: (event: RunEvent) => void,
  emitTrace: (update: TraceUpdate) => void
): Promise<void> {
  if (running || starting) throw new Error('A run is already in progress.')
  const cwd = getProjectRoot()
  const script = resolveInProject(path)
  if (!cwd || !existsSync(script)) throw new Error(`Entry point not found: ${path}`)

  const { pythonPath: python, traceRuns } = getPrefs()
  const run = ++runNumber
  // A run that has been replaced by a newer one goes quiet, so the tree only ever shows one run.
  const sendTrace = (update: TraceUpdate): void => {
    if (run === runNumber) emitTrace(update)
  }

  let args = ['-u', script]
  let tail: TraceTail | null = null
  starting = true
  try {
    if (traceRuns) {
      const traceFile = await nextTraceFile(cwd)
      args = ['-u', tracerPath(), '--out', traceFile, '--root', cwd, '--', script]
      tail = new TraceTail(traceFile, sendTrace)
    }
    stopRequested = false
    running = spawn(python, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
    })
  } finally {
    starting = false
  }
  const child = running
  emit({ type: 'start', command: `${basename(python)} -u ${path}` })
  if (tail) tail.start()
  else sendTrace({ type: 'info', traced: false, note: 'Tracing is turned off in Settings.' })

  child.stdout?.setEncoding('utf8').on('data', (data: string) => emit({ type: 'output', stream: 'stdout', data }))
  child.stderr?.setEncoding('utf8').on('data', (data: string) => emit({ type: 'output', stream: 'stderr', data }))

  // 'error' fires instead of 'close' when Python can't be launched at all.
  child.on('error', (error: NodeJS.ErrnoException) => {
    running = null
    void tail?.finish(null)
    const message =
      error.code === 'ENOENT'
        ? `Python was not found at "${python}". Install Python 3.12+ or set its location in Settings.`
        : error.message
    emit({ type: 'error', message })
  })
  child.on('close', (code) => {
    if (running !== child) return
    running = null
    const stopped = stopRequested
    // Let the trace catch up first, so the tree has the whole run by the time it hears the run ended.
    void (tail ? tail.finish(code) : Promise.resolve()).then(() => emit({ type: 'exit', code, stopped }))
  })
}
