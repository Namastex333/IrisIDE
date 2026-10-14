import { useEffect, useRef } from 'react'
import { createTerminal, useTerminalLook, type TerminalHandle, type TerminalLook } from './xterm'

interface Props extends TerminalLook {
  /** The shell restarts in the new folder whenever this changes. */
  projectRoot: string | null
}

export function TerminalPane({ projectRoot, fontSize, theme }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<TerminalHandle | null>(null)

  useEffect(() => {
    const handle = createTerminal(containerRef.current!, { fontSize, theme }, { cursorBlink: true })
    handleRef.current = handle
    const input = handle.term.onData((data) => window.iris.terminal.write(data))
    const resize = handle.term.onResize(({ cols, rows }) => window.iris.terminal.resize(cols, rows))
    const unsubscribe = window.iris.terminal.onData((data) => handle.term.write(data))
    return () => {
      input.dispose()
      resize.dispose()
      unsubscribe()
      handle.dispose()
      handleRef.current = null
    }
    // The look is only the starting point here; useTerminalLook applies later changes.
  }, [])

  useEffect(() => {
    const term = handleRef.current?.term
    if (!term) return
    term.reset()
    void window.iris.terminal.start(term.cols, term.rows)
  }, [projectRoot])

  useTerminalLook(handleRef, { fontSize, theme })

  return <div className="xterm-host" ref={containerRef} />
}
