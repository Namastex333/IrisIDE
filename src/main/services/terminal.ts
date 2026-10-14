import { homedir } from 'os'
import type { IPty } from 'node-pty'

let shell: IPty | null = null

export function stopTerminal(): void {
  const current = shell
  shell = null
  try {
    current?.kill()
  } catch {
    // Already exited.
  }
}

export async function startTerminal(
  cwd: string | null,
  cols: number,
  rows: number,
  onData: (data: string) => void
): Promise<void> {
  stopTerminal()
  try {
    const { spawn } = await import('node-pty')
    const started = spawn(process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash', [], {
      name: 'xterm-256color',
      cwd: cwd ?? homedir(),
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 1),
      env: process.env as Record<string, string>
    })
    shell = started
    started.onData(onData)
    started.onExit(() => {
      // Ignore the exit of a shell that was already replaced by a newer one.
      if (shell !== started) return
      shell = null
      onData('\r\n\x1b[2m[shell exited]\x1b[0m\r\n')
    })
  } catch (error) {
    onData(`\x1b[31mCould not start the terminal: ${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
  }
}

export function writeTerminal(data: string): void {
  shell?.write(data)
}

export function resizeTerminal(cols: number, rows: number): void {
  if (cols < 2 || rows < 1) return
  try {
    shell?.resize(cols, rows)
  } catch {
    // The shell exited between the resize request and now.
  }
}
