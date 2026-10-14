// Follows the trace file the Python tracer writes (resources/tracer/iris_tracer.py describes its lines)
// and turns new lines into updates for the tree, while the program is still running.
import { open } from 'fs/promises'
import { StringDecoder } from 'string_decoder'
import type { TraceFact, TraceFailure, TraceUpdate } from '../../shared/api'
import { isConfigFile } from './analyzer/resources'

const POLL_MS = 100
const MAX_CHUNK = 4 * 1024 * 1024

interface TraceLine {
  e: string
  traced?: boolean
  note?: string
  fn?: string
  from?: string | null
  at?: number
  cls?: string
  op?: 'open' | 'sqlite' | 'net' | 'env'
  target?: string
  rel?: string
  access?: 'read' | 'write'
  counts?: [string | null, string, number, string | null][]
  exit?: number | null
  error?: { type: string; msg: string; x?: number }
  x?: number
  line?: number
  type?: string
  msg?: string
  origin?: string
  args?: Record<string, string>
  locals?: Record<string, string>
  caller_locals?: Record<string, string>
}

interface ExceptionRecord {
  failure: TraceFailure
  /** Undefined while its fate is unknown; null when caught outside the project's code; else the function that caught it. */
  caughtBy: string | null | undefined
}

export class TraceTail {
  private position = 0
  private rest = ''
  private readonly decoder = new StringDecoder('utf8')
  private readonly seen = new Set<string>()
  private readonly exceptions = new Map<number, ExceptionRecord>()
  private order = 0
  private timer: NodeJS.Timeout | null = null
  private reading: Promise<unknown> | null = null
  private ended = false

  /** `send` should drop updates once a newer run has started. */
  constructor(
    private readonly file: string,
    private readonly send: (update: TraceUpdate) => void
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.reading ??= this.readMore().finally(() => (this.reading = null))
    }, POLL_MS)
  }

  /** Reads everything that is left once the program has exited, then reports the end if the tracer could not. */
  async finish(exitCode: number | null): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.reading
    while (await this.readMore()) {
      // keep going until the whole file has been read
    }
    if (!this.ended) {
      // Stopped, crashed or killed before the tracer could write its last line.
      this.ended = true
      this.send({ type: 'end', exitCode, error: null })
    }
  }

  /** Reads the next chunk of the file. Resolves to true if there may be more to read. */
  private async readMore(): Promise<boolean> {
    let handle
    try {
      handle = await open(this.file, 'r')
    } catch {
      return false // the tracer has not created it yet
    }
    try {
      const { size } = await handle.stat()
      if (size <= this.position) return false
      const buffer = Buffer.alloc(Math.min(size - this.position, MAX_CHUNK))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.position)
      this.position += bytesRead
      this.take(this.decoder.write(buffer.subarray(0, bytesRead)))
      return bytesRead > 0 && this.position < size
    } finally {
      await handle.close()
    }
  }

  private take(text: string): void {
    const lines = (this.rest + text).split('\n')
    this.rest = lines.pop() ?? '' // a line the tracer is still writing
    const facts: TraceFact[] = []
    const wrappers: string[] = []
    const hot: string[] = []
    let counts: [string | null, string, number, string | null][] = []
    let end: TraceLine | null = null
    let exceptionsChanged = false

    for (const line of lines) {
      if (!line.trim()) continue
      let event: TraceLine
      try {
        event = JSON.parse(line) as TraceLine
      } catch {
        continue
      }
      switch (event.e) {
        case 'start':
          this.send({ type: 'info', traced: event.traced !== false, note: event.note ?? null })
          break
        case 'call':
          if (event.fn) this.call(facts, event.from ?? null, event.fn, event.cls ?? null, event.at ?? null)
          break
        case 'new':
          if (event.cls && event.from) this.call(facts, event.from, event.cls, null, event.at ?? null)
          break
        case 'io':
          if (event.from && event.op && event.target) this.io(facts, event)
          break
        case 'wrapper':
          if (event.fn) wrappers.push(event.fn)
          break
        case 'hot':
          if (event.fn) hot.push(event.fn)
          break
        case 'counts':
          counts = counts.concat(event.counts ?? [])
          break
        case 'raise':
        case 'unwind':
        case 'handled':
          exceptionsChanged = this.exception(event) || exceptionsChanged
          break
        case 'end': {
          counts = counts.concat(event.counts ?? [])
          end = event
          const fatal = event.error?.x === undefined ? undefined : this.exceptions.get(event.error.x)
          if (fatal) {
            fatal.failure.fatal = true
            exceptionsChanged = true
          }
          break
        }
      }
    }

    if (facts.length || wrappers.length || hot.length) this.send({ type: 'facts', facts, wrappers, hot })
    if (counts.length) this.send({ type: 'counts', counts })
    if (exceptionsChanged) {
      const records = [...this.exceptions.values()]
      this.send({
        type: 'failures',
        failures: records.filter((record) => record.failure.fatal || record.caughtBy === null).map((record) => record.failure),
        caught: records.filter((record) => typeof record.caughtBy === 'string').length
      })
    }
    if (end) {
      this.ended = true
      this.send({
        type: 'end',
        exitCode: end.exit ?? null,
        error: end.error ? { type: end.error.type, message: end.error.msg } : null
      })
    }
  }

  /** Follows one exception from where it was raised to where it was caught. Resolves to true if anything changed. */
  private exception(event: TraceLine): boolean {
    if (event.x === undefined) return false
    if (event.e === 'raise') {
      if (!event.fn) return false
      this.exceptions.set(event.x, {
        caughtBy: undefined,
        failure: {
          id: event.x,
          type: event.type ?? 'Exception',
          message: event.msg ?? '',
          fn: event.fn,
          line: event.line ?? 0,
          origin: event.origin ?? null,
          args: event.args ?? {},
          locals: event.locals ?? {},
          caller: event.from ? { fn: event.from, line: event.at ?? null, locals: event.caller_locals ?? {} } : null,
          path: [event.fn],
          fatal: false,
          order: this.order++
        }
      })
      return false // not a failure until we know nobody caught it
    }
    const record = this.exceptions.get(event.x)
    if (!record) return false
    if (event.e === 'unwind') {
      const path = record.failure.path
      if (event.fn && path[path.length - 1] !== event.fn) path.push(event.fn)
      return false
    }
    record.caughtBy = event.fn ?? null
    return true
  }

  /** Only the first time each branch runs matters for the tree; the tracer repeats calls it records in detail. */
  private call(facts: TraceFact[], from: string | null, to: string, created: string | null, line: number | null): void {
    const key = `call|${from ?? ''}|${to}|${created ?? ''}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    facts.push({ type: 'call', from, to, created, line, order: this.order++ })
  }

  private io(facts: TraceFact[], event: TraceLine): void {
    const access = event.access === 'write' ? 'write' : 'read'
    const key = `io|${event.from}|${event.op}|${event.target}|${access}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    // Same rule as reading the code: reading a config-format file (or the environment) is config, anything else is data.
    const config = access === 'read' && (event.op === 'env' || (event.op === 'open' && isConfigFile(event.target!)))
    facts.push({
      type: 'io',
      from: event.from!,
      op: event.op!,
      target: event.target!,
      relative: event.rel ?? null,
      access,
      kind: config ? 'config' : 'data',
      line: event.at ?? null,
      order: this.order++
    })
  }
}
