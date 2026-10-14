import { ipcMain, nativeTheme, type BrowserWindow } from 'electron'
import { Channels, type AppSettings, type RunEvent, type TraceUpdate } from '../shared/api'
import { analyzeProject } from './services/analyzer'
import {
  createProjectFile,
  getProjectRoot,
  listProjectFiles,
  openLastProject,
  openProjectDialog,
  readProjectFile,
  refreshProject,
  resolveInProject,
  setEntryPoint,
  writeProjectFile
} from './services/project'
import { checkPython, pickPython } from './services/python'
import { startRun, stopRun } from './services/runner'
import { getPrefs, updatePrefs } from './services/settings'
import { resizeTerminal, startTerminal, writeTerminal } from './services/terminal'

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  ipcMain.handle(Channels.projectOpenDialog, () => {
    const window = getWindow()
    return window ? openProjectDialog(window) : null
  })
  ipcMain.handle(Channels.projectOpenLast, () => openLastProject())
  ipcMain.handle(Channels.projectRefresh, () => refreshProject())
  ipcMain.handle(Channels.projectReadFile, (_event, path: string) => readProjectFile(path))
  ipcMain.handle(Channels.projectWriteFile, (_event, path: string, content: string) => writeProjectFile(path, content))
  ipcMain.handle(Channels.projectCreateFile, (_event, path: string) => createProjectFile(path))
  ipcMain.handle(Channels.projectSetEntryPoint, (_event, path: string | null) => setEntryPoint(path))

  ipcMain.handle(Channels.graphAnalyze, async (_event, entryPoint: string) => {
    const root = getProjectRoot()
    if (!root) throw new Error('No project is open.')
    resolveInProject(entryPoint)
    return analyzeProject(root, await listProjectFiles(), entryPoint)
  })

  ipcMain.handle(Channels.terminalStart, (_event, cols: number, rows: number) =>
    startTerminal(getProjectRoot(), cols, rows, (data) => send(Channels.terminalData, data))
  )
  ipcMain.on(Channels.terminalWrite, (_event, data: string) => writeTerminal(data))
  ipcMain.on(Channels.terminalResize, (_event, cols: number, rows: number) => resizeTerminal(cols, rows))

  ipcMain.handle(Channels.runStart, (_event, path: string) =>
    startRun(
      path,
      (event: RunEvent) => send(Channels.runEvent, event),
      (update: TraceUpdate) => send(Channels.runTrace, update)
    )
  )
  ipcMain.handle(Channels.runStop, () => stopRun())

  ipcMain.handle(Channels.settingsGet, () => getPrefs())
  ipcMain.handle(Channels.settingsUpdate, async (_event, changes: Partial<AppSettings>) => {
    const prefs = await updatePrefs(changes)
    nativeTheme.themeSource = prefs.theme
    return prefs
  })
  ipcMain.handle(Channels.settingsPickPython, () => {
    const window = getWindow()
    return window ? pickPython(window) : null
  })
  ipcMain.handle(Channels.settingsCheckPython, (_event, path: string) => checkPython(String(path)))
}
