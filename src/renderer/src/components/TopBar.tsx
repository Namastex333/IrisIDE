import { useState } from 'react'

interface Props {
  projectName: string | null
  entryPoint: string | null
  pythonFiles: string[]
  running: boolean
  showFileList: boolean
  onOpenFolder(): void
  /** Resolves to true once the file exists, false if it could not be created. */
  onNewFile(path: string): Promise<boolean>
  onToggleFileList(): void
  onEntryPoint(path: string): void
  onRun(): void
  onStop(): void
  onSettings(): void
}

function NewFile({ suggestion, onCreate }: { suggestion: string; onCreate(path: string): Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  const create = async (): Promise<void> => {
    const path = name.trim().replace(/\\/g, '/')
    if (path && (await onCreate(path))) setOpen(false)
  }

  return (
    <span className="new-file">
      <button
        className={open ? 'active' : undefined}
        onClick={() => {
          setName(suggestion)
          setOpen(!open)
        }}
      >
        New File
      </button>
      {open && (
        <form
          className="popover"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <input
            type="text"
            autoFocus
            spellCheck={false}
            placeholder="name.py or folder/name.py"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
          />
          <button type="submit" disabled={!name.trim()}>
            Create
          </button>
        </form>
      )}
    </span>
  )
}

export function TopBar(props: Props) {
  const { projectName, entryPoint, pythonFiles, running } = props
  // Keep showing a saved entry point even if its file has since gone missing.
  const choices = entryPoint && !pythonFiles.includes(entryPoint) ? [entryPoint, ...pythonFiles] : pythonFiles

  return (
    <header className="top-bar">
      <span className="brand">Iris</span>
      {projectName && <span className="project-name">{projectName}</span>}
      <button onClick={props.onOpenFolder}>Open Folder</button>
      {projectName && <NewFile suggestion={pythonFiles.includes('main.py') ? '' : 'main.py'} onCreate={props.onNewFile} />}
      {projectName && (
        <button className={props.showFileList ? 'active' : undefined} title="Show or hide the file list" onClick={props.onToggleFileList}>
          Files
        </button>
      )}
      <span className="spacer" />
      {projectName && (
        <label className="entry-picker" title="The file Run starts and the tree grows from">
          <span className="muted">Entry</span>
          <select value={entryPoint ?? ''} disabled={choices.length === 0} onChange={(event) => props.onEntryPoint(event.target.value)}>
            {!entryPoint && <option value="">{choices.length ? 'Choose a file…' : 'No Python files'}</option>}
            {choices.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        </label>
      )}
      {running ? (
        <button className="stop" onClick={props.onStop}>
          ■ Stop
        </button>
      ) : (
        <button className="run" onClick={props.onRun} disabled={!entryPoint}>
          ▶ Run
        </button>
      )}
      <button className="icon-button" title="Settings (Ctrl+,)" onClick={props.onSettings}>
        ⚙
      </button>
    </header>
  )
}
