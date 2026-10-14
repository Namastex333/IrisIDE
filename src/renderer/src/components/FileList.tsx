import { useEffect, useState } from 'react'
import type { FileNode } from '../../../shared/api'

// Temporary: Phase 2 replaces this list with the call-graph tree.

interface Props {
  tree: FileNode[]
  openPath: string | null
  entryPoint: string | null
  onOpen(path: string): void
  onSetEntryPoint(path: string): void
}

interface MenuState {
  x: number
  y: number
  path: string
}

export function FileList({ tree, openPath, entryPoint, onOpen, onSetEntryPoint }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const toggle = (path: string): void =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const renderNodes = (nodes: FileNode[], depth: number) =>
    nodes.map((node) => {
      const indent = { paddingLeft: 10 + depth * 14 }
      if (node.kind === 'dir') {
        const open = expanded.has(node.path)
        return (
          <div key={node.path}>
            <button className="file-row dir" style={indent} onClick={() => toggle(node.path)}>
              <span className="chevron">{open ? '▾' : '▸'}</span>
              {node.name}
            </button>
            {open && renderNodes(node.children ?? [], depth + 1)}
          </div>
        )
      }
      return (
        <button
          key={node.path}
          className={`file-row${node.path === openPath ? ' active' : ''}`}
          style={indent}
          title={node.path}
          onClick={() => onOpen(node.path)}
          onContextMenu={(event) => {
            if (!node.name.endsWith('.py')) return
            event.preventDefault()
            setMenu({ x: event.clientX, y: event.clientY, path: node.path })
          }}
        >
          <span className="chevron" />
          {node.name}
          {node.path === entryPoint && <span className="entry-badge">entry</span>}
        </button>
      )
    })

  return (
    <nav className="file-list">
      {tree.length === 0 ? <p className="muted pad">This folder is empty.</p> : renderNodes(tree, 0)}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => onSetEntryPoint(menu.path)}>Set as entry point</button>
        </div>
      )}
    </nav>
  )
}
