import type { RunTrace } from '../tree/trace'

interface Props {
  trace: RunTrace
  /** Branches reachable from the entry point, and how many of them ran. Null when the run was not traced. */
  coverage: { ran: number; total: number } | null
  onShowRan(): void
  onReplay(): void
  onClear(): void
}

/** The line above the tree that says how the last run went. */
export function RunBar({ trace, coverage, onShowRan, onReplay, onClear }: Props) {
  let state: 'running' | 'failed' | 'stopped' | 'finished' | 'untraced'
  let text: string
  if (trace.traced === false) {
    state = 'untraced'
    text = `This run was not traced. ${trace.note ?? ''}`.trim()
  } else if (trace.status === 'running') {
    state = 'running'
    const ran = coverage?.ran ?? 0
    text = `Running… ${ran} ${ran === 1 ? 'branch' : 'branches'} so far`
  } else if (trace.error) {
    state = 'failed'
    text = `Run failed with ${trace.error.type}${trace.error.message ? `: ${trace.error.message}` : ''}`
  } else if (trace.stopped) {
    state = 'stopped'
    text = 'Run stopped'
  } else {
    state = 'finished'
    text = trace.exitCode ? `Run finished with exit code ${trace.exitCode}` : 'Run finished'
  }

  const never = coverage ? coverage.total - coverage.ran : 0
  return (
    <div className={`run-bar ${state}`}>
      <span className="run-dot" />
      <span className="run-text" title={text}>
        {text}
      </span>
      {coverage && trace.status === 'done' && (
        <span className="muted run-coverage">
          {coverage.ran} of {coverage.total} branches ran{never > 0 ? ` · ${never} did not` : ''}
        </span>
      )}
      <span className="spacer" />
      {coverage && <button onClick={onShowRan}>Show what ran</button>}
      {coverage && trace.status === 'done' && <button onClick={onReplay}>Replay</button>}
      <button className="icon-button" title="Clear the run from the tree" onClick={onClear}>
        ✕
      </button>
    </div>
  )
}
