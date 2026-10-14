import { app, BrowserWindow, Menu, nativeTheme } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { stopRun } from './services/runner'
import { getPrefs } from './services/settings'
import { stopTerminal } from './services/terminal'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'Iris',
    // Matches the page background so the window does not flash the wrong color while loading.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15151c' : '#fbfbfd',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = window

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // The app is a single local page: never open new windows or navigate away from it.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') window.webContents.toggleDevTools()
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// `npm run dev` keeps its own settings so it can run alongside the installed app
// (they would otherwise share one profile and one single-instance lock).
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'Iris (dev)'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    // Makes native parts of the window (scrollbars, dropdowns) follow the chosen theme too.
    nativeTheme.themeSource = getPrefs().theme
    registerIpc(() => mainWindow)
    createWindow()
  })

  app.on('window-all-closed', () => {
    stopRun()
    stopTerminal()
    app.quit()
  })
}
