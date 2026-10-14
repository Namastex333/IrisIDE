import { useEffect, useRef, useState } from 'react'
import type { GraphNode } from '../../../shared/api'
import { monaco } from '../monaco-setup'
import { MONACO_THEMES, type Theme } from '../theme'
import type { ResolvedFailure } from '../tree/trace'
import { EyeIcon } from './icons'

interface Props {
  failure: ResolvedFailure
  /** Graph nodes by id, including ones that only showed up at run time. */
  nodes: ReadonlyMap<string, GraphNode>
  theme: Theme
  fontSize: number
  onOpen(file: string, line: number | null): void
  onClose(): void
}

/** A function this long or shorter is shown whole; a longer one is shown around the line that matters. */
const WHOLE_FUNCTION = 60
const CONTEXT = 12

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const fileOf = (key: string): string => key.slice(0, key.indexOf('::'))

/** The tracer's name for some code, made readable when the tree has no node for it. */
function readable(key: string): string {
  const name = key
    .slice(key.indexOf('::') + 2)
    .split('.')
    .filter((part) => part !== '<locals>')
    .join('.')
  return name === '<module>' ? baseName(fileOf(key)) : `${name}()`
}

interface Section {
  title: string
  values: Record<string, string>
}

interface PaneProps {
  role: 'failing' | 'calling'
  heading: string
  node: GraphNode | null
  code: string
  /** The line that matters: where it failed, or where the caller made the call. */
  line: number | null
  note: string | null
  sections: Section[]
  theme: Theme
  fontSize: number
  onOpen(file: string, line: number | null): void
}

function FocusPane({ role, heading, node, code, line, note, sections, theme, fontSize, onOpen }: PaneProps) {
  const file = node?.file ?? fileOf(code)
  const [source, setSource] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const codeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current = true
    setSource(null)
    setProblem(null)
    window.iris.project.readFile(file).then(
      (text) => current && setSource(text),
      () => current && setProblem(`${file} could not be read. It may have been moved or deleted since the run.`)
    )
    return () => {
      current = false
    }
  }, [file])

  useEffect(() => {
    if (source === null || !codeRef.current) return
    const lines = source.split(/\r?\n/)
    const target = line ?? node?.line ?? 1
    let start: number
    let end: number
    if (node && node.kind !== 'module' && node.line) {
      start = node.line
      end = node.endLine ?? node.line + CONTEXT * 2
    } else {
      start = target - CONTEXT
      end = target + CONTEXT
    }
    if (end - start + 1 > WHOLE_FUNCTION) {
      start = Math.max(start, target - CONTEXT)
      end = Math.min(end, target + CONTEXT)
    }
    start = Math.min(Math.max(start, 1), lines.length)
    end = Math.min(Math.max(end, start), lines.length)

    const model = monaco.editor.createModel(lines.slice(start - 1, end).join('\n'), 'python')
    const editor = monaco.editor.create(codeRef.current, {
      model,
      readOnly: true,
      domReadOnly: true,
      theme: MONACO_THEMES[theme],
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize,
      automaticLayout: true,
      minimap: { enabled: false },
      // The snippet starts partway through the file; number its lines as the file does.
      lineNumbers: (number) => String(number + start - 1),
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      contextmenu: false,
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 8,
      overviewRulerLanes: 0,
      wordWrap: 'on',
      padding: { top: 8, bottom: 8 },
      scrollbar: { alwaysConsumeMouseWheel: false }
    })
    // As tall as the code, so the values sit right under it (the stylesheet caps the height for long functions).
    const container = codeRef.current
    const fitHeight = (): void => {
      container.style.height = `${editor.getContentHeight()}px`
    }
    const sizing = editor.onDidContentSizeChange(fitHeight)
    fitHeight()
    const row = target - start + 1
    if (row >= 1 && row <= end - start + 1) {
      editor.createDecorationsCollection([
        {
          range: new monaco.Range(row, 1, row, 1),
          options: { isWholeLine: true, className: `focus-line-${role}`, linesDecorationsClassName: `focus-bar-${role}` }
        }
      ])
      editor.revealLineInCenterIfOutsideViewport(row)
    }
    return () => {
      sizing.dispose()
      editor.dispose()
      model.dispose()
    }
  }, [source, line, node, role, theme, fontSize])

  const shown = sections.filter((section) => Object.keys(section.values).length > 0)
  return (
    <section className={`focus-pane ${role}`}>
      <header>
        <span className={`focus-chip ${role}`}>{heading}</span>
        <span className="focus-name" title={file}>
          {node?.label ?? readable(code)}
        </span>
        <span className="spacer" />
        <button className="link-button" title="Open this file in the editor" onClick={() => onOpen(file, line)}>
          Open {baseName(file)}
          {line ? `:${line}` : ''}
        </button>
      </header>
      {note && <p className="focus-note">{note}</p>}
      {problem ? <p className="focus-problem muted">{problem}</p> : <div className="focus-code" ref={codeRef} />}
      <div className="focus-values">
        {shown.length === 0 && <p className="muted">No values were recorded here.</p>}
        {shown.map((section) => (
          <div key={section.title} className="focus-section">
            <h4>{section.title}</h4>
            <dl>
              {Object.entries(section.values).map(([name, value]) => (
                <div key={name} className="focus-value">
                  <dt>{name}</dt>
                  <dd title={value}>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The 👁 focus eye: the function that failed and the one that called it, side by side, with the values they held. */
export function FocusView({ failure, nodes, theme, fontSize, onOpen, onClose }: Props) {
  const { error } = failure

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  // Outermost first, the way the calls were made.
  const path = [...failure.path].reverse().map((id) => nodes.get(id)?.label ?? id)
  const failingNode = failure.failing ? (nodes.get(failure.failing) ?? null) : null
  const callerNode = failure.caller ? (nodes.get(failure.caller) ?? null) : null

  return (
    <div className="focus-view">
      <header className="focus-header">
        <button className="back-button" title="Back to the tree (Esc)" onClick={onClose}>
          ← Tree
        </button>
        <span className="focus-icon">
          <EyeIcon size={18} />
        </span>
        <div className="focus-title">
          <div className="focus-error">
            {error.type}
            {error.message ? `: ${error.message}` : ''}
          </div>
          {path.length > 1 && (
            <div className="focus-path muted" title="How the program got there">
              {path.join('  →  ')}
            </div>
          )}
        </div>
        {!error.fatal && <span className="focus-badge muted">The run carried on after this</span>}
      </header>
      <div className="focus-panes">
        {error.caller && (
          <FocusPane
            role="calling"
            heading="Called it"
            node={callerNode}
            code={error.caller.fn}
            line={error.caller.line}
            note={null}
            sections={[{ title: 'Its variables at that moment', values: error.caller.locals }]}
            theme={theme}
            fontSize={fontSize}
            onOpen={onOpen}
          />
        )}
        <FocusPane
          role="failing"
          heading="Failed here"
          node={failingNode}
          code={error.fn}
          line={error.line}
          note={error.origin ? `It started inside ${error.origin}, in a library this function called.` : null}
          sections={[
            { title: 'Passed in', values: error.args },
            { title: 'Other variables', values: error.locals }
          ]}
          theme={theme}
          fontSize={fontSize}
          onOpen={onOpen}
        />
      </div>
    </div>
  )
}
