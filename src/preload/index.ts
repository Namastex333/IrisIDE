import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channels, type IrisApi, type RunEvent, type TraceUpdate, type Unsubscribe } from '../shared/api'

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: IrisApi = {
  project: {
    openDialog: () => ipcRenderer.invoke(Channels.projectOpenDialog),
    openLast: () => ipcRenderer.invoke(Channels.projectOpenLast),
    refresh: () => ipcRenderer.invoke(Channels.projectRefresh),
    readFile: (path) => ipcRenderer.invoke(Channels.projectReadFile, path),
    writeFile: (path, content) => ipcRenderer.invoke(Channels.projectWriteFile, path, content),
    createFile: (path) => ipcRenderer.invoke(Channels.projectCreateFile, path),
    setEntryPoint: (path) => ipcRenderer.invoke(Channels.projectSetEntryPoint, path)
  },
  graph: {
    analyze: (entryPoint) => ipcRenderer.invoke(Channels.graphAnalyze, entryPoint)
  },
  terminal: {
    start: (cols, rows) => ipcRenderer.invoke(Channels.terminalStart, cols, rows),
    write: (data) => ipcRenderer.send(Channels.terminalWrite, data),
    resize: (cols, rows) => ipcRenderer.send(Channels.terminalResize, cols, rows),
    onData: (listener) => subscribe<string>(Channels.terminalData, listener)
  },
  run: {
    start: (path) => ipcRenderer.invoke(Channels.runStart, path),
    stop: () => ipcRenderer.invoke(Channels.runStop),
    onEvent: (listener) => subscribe<RunEvent>(Channels.runEvent, listener),
    onTrace: (listener) => subscribe<TraceUpdate>(Channels.runTrace, listener)
  },
  settings: {
    get: () => ipcRenderer.invoke(Channels.settingsGet),
    update: (changes) => ipcRenderer.invoke(Channels.settingsUpdate, changes),
    pickPython: () => ipcRenderer.invoke(Channels.settingsPickPython),
    checkPython: (path) => ipcRenderer.invoke(Channels.settingsCheckPython, path)
  }
}

contextBridge.exposeInMainWorld('iris', api)
