import type { RunTrace } from '../tree/trace'
import { EyeIcon } from './icons'

interface Props {
  trace: RunTrace
  /** Branches reachable from the entry point, and how many of them ran. Null when the run was not traced. */
  coverage: { ran: number; total: number } | null
  /** True when the run flagged an error that the focus view can show. */
  canFocus: boolean
  onShowRan(): void
  onReplay(): void
  onFocus(): void
  onClear(): void
}

/** The line above the tree that says how the last run went. */
export function RunBar({ trace, coverage, canFocus, onShowRan, onReplay, onFocus, onClear }: Props) {
  let state: 'running' | 'failed' | 'stopped' | 'finished' | 'untraced'
  let text: string
  const failure = trace.failures.find((candidate) => candidate.fatal) ?? trace.failures[0]
  if (trace.traced === false) {
    state = 'untraced'
    text = `This run was not traced. ${trace.note ?? ''}`.trim()
  } else if (trace.status === 'running') {
    state = failure ? 'failed' : 'running'
    const ran = coverage?.ran ?? 0
    text = failure
      ? `Running… an error was not caught: ${failure.type}`
      : `Running… ${ran} ${ran === 1 ? 'branch' : 'branches'} so far`
  } else if (trace.error || failure) {
    state = 'failed'
    const error = trace.error ?? { type: failure!.type, message: failure!.message }
    text = `${trace.error ? 'Run failed with' : 'An error was not caught:'} ${error.type}${error.message ? `: ${error.message}` : ''}`
  } else if (trace.stopped) {
    state = 'stopped'
    text = 'Run stopped'
  } else {
    state = 'finished'
    text = trace.exitCode ? `Run finished with exit code ${trace.exitCode}` : 'Run finished'
  }

  const never = coverage ? coverage.total - coverage.ran : 0
  const caught = trace.caught > 0 ? ` · ${trace.caught} ${trace.caught === 1 ? 'error' : 'errors'} handled by your code` : ''
  return (
    <div className={`run-bar ${state}`}>
      <span className="run-dot" />
      <span className="run-text" title={text}>
        {text}
      </span>
      {coverage && trace.status === 'done' && (
        <span className="muted run-coverage">
          {coverage.ran} of {coverage.total} branches ran{never > 0 ? ` · ${never} did not` : ''}
          {caught}
        </span>
      )}
      <span className="spacer" />
      {canFocus && (
        <button className="focus-button" title="Look at the failing function and its caller side by side" onClick={onFocus}>
          <EyeIcon /> Focus
        </button>
      )}
      {coverage && <button onClick={onShowRan}>Show what ran</button>}
      {coverage && trace.status === 'done' && <button onClick={onReplay}>Replay</button>}
      <button className="icon-button" title="Clear the run from the tree" onClick={onClear}>
        ✕
      </button>
    </div>
  )
}
