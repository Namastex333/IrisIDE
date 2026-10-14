import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { monaco } from '../monaco-setup'
import { MONACO_THEMES, type Theme } from '../theme'

export interface EditorHandle {
  /** Saves the file if it has unsaved changes. Rejects if the save fails. */
  save(): Promise<void>
  /** Scrolls to a line (1-based) and puts the cursor there. */
  reveal(line: number): void
}

interface Props {
  ref?: Ref<EditorHandle>
  /** Project-relative path. Mount with `key={path}` so each file gets a fresh editor. */
  path: string
  /** File content at the time it was opened. */
  content: string
  /** Line to show first, e.g. the function that was clicked in the tree. */
  line: number | null
  fontSize: number
  wordWrap: boolean
  minimap: boolean
  theme: Theme
  onSave(content: string): Promise<void>
  onDirtyChange(dirty: boolean): void
}

export function EditorPane({ ref, path, content, line, fontSize, wordWrap, minimap, theme, onSave, onDirtyChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const callbacks = useRef({ onSave, onDirtyChange })
  callbacks.current = { onSave, onDirtyChange }

  const reveal = (target: number): void => {
    const editor = editorRef.current
    if (!editor) return
    editor.setPosition({ lineNumber: target, column: 1 })
    editor.revealLineNearTop(target)
    editor.focus()
  }

  useImperativeHandle(ref, () => ({ save: () => saveRef.current(), reveal }), [])

  useEffect(() => {
    // The file URI lets Monaco pick the language from the extension (.py → Python).
    const model = monaco.editor.createModel(content, undefined, monaco.Uri.file(path))
    const editor = monaco.editor.create(containerRef.current!, {
      model,
      theme: MONACO_THEMES[theme],
      automaticLayout: true,
      minimap: { enabled: minimap },
      wordWrap: wordWrap ? 'on' : 'off',
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize,
      scrollBeyondLastLine: false,
      padding: { top: 10 }
    })
    editorRef.current = editor

    let savedVersion = model.getAlternativeVersionId()
    const isDirty = (): boolean => model.getAlternativeVersionId() !== savedVersion

    saveRef.current = async () => {
      if (!isDirty()) return
      const version = model.getAlternativeVersionId()
      await callbacks.current.onSave(model.getValue())
      savedVersion = version
      callbacks.current.onDirtyChange(isDirty())
    }

    const changes = model.onDidChangeContent(() => callbacks.current.onDirtyChange(isDirty()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current().catch(() => {}) // The failure is reported by onSave's owner.
    })
    if (line) reveal(line)
    else editor.focus()

    return () => {
      changes.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
    }
    // Everything but `path` is only a starting value: edits live in the model, and the effects below follow the settings.
  }, [path])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, minimap: { enabled: minimap }, wordWrap: wordWrap ? 'on' : 'off' })
  }, [fontSize, minimap, wordWrap])

  useEffect(() => {
    monaco.editor.setTheme(MONACO_THEMES[theme])
  }, [theme])

  return <div className="editor-host" ref={containerRef} />
}
