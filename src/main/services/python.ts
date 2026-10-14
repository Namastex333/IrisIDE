import { dialog, type BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import type { PythonCheck } from '../../shared/api'

export async function pickPython(window: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose the Python interpreter',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Python', extensions: ['exe'] }] : []
  })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

export function checkPython(path: string): Promise<PythonCheck> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim()
      const version = /Python (\d+)\.(\d+)\S*/.exec(output)
      if (error || !version) {
        const notFound = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
        resolve({ ok: false, message: notFound ? 'Not found.' : output || error?.message || 'Did not answer as Python.' })
      } else if (Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 12)) {
        resolve({ ok: true, message: `${version[0]} (works for Run; tracing will need 3.12 or newer)` })
      } else {
        resolve({ ok: true, message: version[0] })
      }
    })
  })
}
