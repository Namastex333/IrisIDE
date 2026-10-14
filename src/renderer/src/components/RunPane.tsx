import { useEffect, useRef } from 'react'
import { createTerminal, useTerminalLook, type TerminalHandle, type TerminalLook } from './xterm'

/** Read-only output of the most recent Run. */
export function RunPane({ fontSize, theme }: TerminalLook) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<TerminalHandle | null>(null)

  useEffect(() => {
    const handle = createTerminal(containerRef.current!, { fontSize, theme }, { disableStdin: true, convertEol: true, cursorStyle: 'bar' })
    handleRef.current = handle
    const { term } = handle
    term.write('\x1b[2mPress Run to start your project.\x1b[0m')
    const unsubscribe = window.iris.run.onEvent((event) => {
      switch (event.type) {
        case 'start':
          term.reset()
          term.write(`\x1b[2m> ${event.command}\x1b[0m\n`)
          break
        case 'output':
          term.write(event.data)
          break
        case 'exit': {
          const color = event.stopped ? '33' : event.code === 0 ? '32' : '31'
          const label = event.stopped ? 'stopped' : `exited with code ${event.code}`
          term.write(`\n\x1b[${color}m[${label}]\x1b[0m\n`)
          break
        }
        case 'error':
          term.write(`\n\x1b[31m${event.message}\x1b[0m\n`)
          break
      }
    })
    return () => {
      unsubscribe()
      handle.dispose()
      handleRef.current = null
    }
    // The look is only the starting point here; useTerminalLook applies later changes.
  }, [])

  useTerminalLook(handleRef, { fontSize, theme })

  return <div className="xterm-host" ref={containerRef} />
}
