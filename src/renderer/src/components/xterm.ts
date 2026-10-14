import { useEffect, type RefObject } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { TERMINAL_THEMES, type Theme } from '../theme'

export interface TerminalHandle {
  term: Terminal
  /** Resizes the terminal to its container. Does nothing while the container is hidden. */
  fit(): void
  dispose(): void
}

export interface TerminalLook {
  fontSize: number
  theme: Theme
}

/** Creates an xterm.js terminal that fills its container and refits whenever the container resizes. */
export function createTerminal(container: HTMLElement, look: TerminalLook, options: ITerminalOptions = {}): TerminalHandle {
  const term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: look.fontSize,
    scrollback: 5000,
    theme: TERMINAL_THEMES[look.theme],
    ...options
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)

  // A hidden tab has no size; fitting then would collapse the terminal to a few columns.
  const fit = (): void => {
    if (container.offsetWidth > 0 && container.offsetHeight > 0) fitAddon.fit()
  }
  fit()
  const observer = new ResizeObserver(fit)
  observer.observe(container)

  return {
    term,
    fit,
    dispose: () => {
      observer.disconnect()
      term.dispose()
    }
  }
}

/** Keeps a terminal's font size and colors in step with the settings. */
export function useTerminalLook(handle: RefObject<TerminalHandle | null>, { fontSize, theme }: TerminalLook): void {
  useEffect(() => {
    const current = handle.current
    if (!current) return
    current.term.options.fontSize = fontSize
    current.term.options.theme = TERMINAL_THEMES[theme]
    current.fit()
  }, [handle, fontSize, theme])
}
