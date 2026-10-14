import { useEffect, useState, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, FONT_SIZE_RANGE, type AppSettings, type PythonCheck } from '../../../shared/api'

interface Props {
  settings: AppSettings
  /** Name of the open project, or null when none is open. */
  projectName: string | null
  entryPoint: string | null
  pythonFiles: string[]
  onChange(changes: Partial<AppSettings>): void
  onEntryPoint(path: string): void
  onClose(): void
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="settings-row">
      <span className="settings-label">
        {label}
        {hint && <small className="muted">{hint}</small>}
      </span>
      <span className="settings-control">{children}</span>
    </label>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange(checked: boolean): void }) {
  return <input type="checkbox" className="toggle" checked={checked} onChange={(event) => onChange(event.target.checked)} />
}

function FontSize({ value, onChange }: { value: number; onChange(value: number): void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return (
    <input
      type="number"
      min={FONT_SIZE_RANGE.min}
      max={FONT_SIZE_RANGE.max}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        const size = Number(event.target.value)
        if (Number.isInteger(size) && size >= FONT_SIZE_RANGE.min && size <= FONT_SIZE_RANGE.max) onChange(size)
      }}
      onBlur={() => setDraft(String(value))}
    />
  )
}

export function SettingsDialog({ settings, projectName, entryPoint, pythonFiles, onChange, onEntryPoint, onClose }: Props) {
  const [pythonDraft, setPythonDraft] = useState(settings.pythonPath)
  const [pythonCheck, setPythonCheck] = useState<PythonCheck | null>(null)

  useEffect(() => setPythonDraft(settings.pythonPath), [settings.pythonPath])

  // Shows whether the saved interpreter actually works, on open and after every change.
  useEffect(() => {
    let current = true
    setPythonCheck(null)
    window.iris.settings
      .checkPython(settings.pythonPath)
      .then((result) => current && setPythonCheck(result))
      .catch(() => current && setPythonCheck({ ok: false, message: 'Could not be checked.' }))
    return () => {
      current = false
    }
  }, [settings.pythonPath])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const commitPython = (): void => {
    const path = pythonDraft.trim() || DEFAULT_SETTINGS.pythonPath
    setPythonDraft(path)
    if (path !== settings.pythonPath) onChange({ pythonPath: path })
  }

  const browsePython = async (): Promise<void> => {
    const path = await window.iris.settings.pickPython()
    if (path) onChange({ pythonPath: path })
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <button className="icon-button" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="settings-body">
          <section>
            <h3>Appearance</h3>
            <Row label="Theme">
              <select value={settings.theme} onChange={(event) => onChange({ theme: event.target.value as AppSettings['theme'] })}>
                <option value="system">Match Windows</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </Row>
          </section>

          <section>
            <h3>Tree</h3>
            <Row label="Direction" hint="Which way the tree grows from the entry point">
              <select
                value={settings.treeDirection}
                onChange={(event) => onChange({ treeDirection: event.target.value as AppSettings['treeDirection'] })}
              >
                <option value="horizontal">Left to right</option>
                <option value="vertical">Top to bottom</option>
              </select>
            </Row>
            <Row label="Show likely links" hint="Dashed branches Iris is not certain about, such as callbacks">
              <Toggle checked={settings.showInferredLinks} onChange={(showInferredLinks) => onChange({ showInferredLinks })} />
            </Row>
            <Row label="Show file list" hint="A plain list of every file, beside the tree">
              <Toggle checked={settings.showFileList} onChange={(showFileList) => onChange({ showFileList })} />
            </Row>
          </section>

          <section>
            <h3>Editor</h3>
            <Row label="Font size">
              <FontSize value={settings.editorFontSize} onChange={(editorFontSize) => onChange({ editorFontSize })} />
            </Row>
            <Row label="Wrap long lines">
              <Toggle checked={settings.editorWordWrap} onChange={(editorWordWrap) => onChange({ editorWordWrap })} />
            </Row>
            <Row label="Minimap" hint="The zoomed-out overview on the right edge">
              <Toggle checked={settings.editorMinimap} onChange={(editorMinimap) => onChange({ editorMinimap })} />
            </Row>
          </section>

          <section>
            <h3>Terminal</h3>
            <Row label="Font size">
              <FontSize value={settings.terminalFontSize} onChange={(terminalFontSize) => onChange({ terminalFontSize })} />
            </Row>
          </section>

          <section>
            <h3>Python</h3>
            <Row label="Interpreter" hint="Used by Run. A command name or the full path to python.exe">
              <input
                type="text"
                className="wide"
                spellCheck={false}
                value={pythonDraft}
                onChange={(event) => setPythonDraft(event.target.value)}
                onBlur={commitPython}
                onKeyDown={(event) => event.key === 'Enter' && commitPython()}
              />
              <button onClick={browsePython}>Browse…</button>
            </Row>
            <p className={`settings-status ${pythonCheck ? (pythonCheck.ok ? 'ok' : 'bad') : 'muted'}`}>
              {pythonCheck ? `${pythonCheck.ok ? '✓' : '✕'} ${pythonCheck.message}` : 'Checking…'}
            </p>
            <Row label="Trace runs" hint="Lights up the tree with what ran. Needs Python 3.12 or newer">
              <Toggle checked={settings.traceRuns} onChange={(traceRuns) => onChange({ traceRuns })} />
            </Row>
          </section>

          <section>
            <h3>Project</h3>
            {projectName && (
              <Row label="Entry point" hint={`The file Run starts and the tree grows from, for ${projectName}`}>
                <select className="wide" value={entryPoint ?? ''} onChange={(event) => onEntryPoint(event.target.value)}>
                  {!entryPoint && <option value="">None</option>}
                  {pythonFiles.map((path) => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </select>
              </Row>
            )}
            <Row label="Reopen the last project on launch">
              <Toggle checked={settings.reopenLastProject} onChange={(reopenLastProject) => onChange({ reopenLastProject })} />
            </Row>
          </section>
        </div>

        <footer>
          <button onClick={() => onChange(DEFAULT_SETTINGS)}>Reset to defaults</button>
          <span className="spacer" />
          <span className="muted">Changes are saved as you make them.</span>
        </footer>
      </div>
    </div>
  )
}
