import { useEffect, useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import type { AppSettings, GraphEdgeKind } from '../../shared/api'

export type Theme = 'dark' | 'light'

/** Turns the theme setting into the theme to draw, following the operating system when set to "system". */
export function useTheme(setting: AppSettings['theme']): Theme {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  const theme: Theme = setting === 'system' ? (systemDark ? 'dark' : 'light') : setting
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return theme
}

// These repeat values from styles.css for the libraries that take colors through JavaScript instead of CSS.

export const EDGE_COLORS: Record<Theme, Record<GraphEdgeKind, string>> = {
  dark: { call: '#4ade80', config: '#60a5fa', data: '#fb923c', import: '#8b8ba3' },
  light: { call: '#16a34a', config: '#2563eb', data: '#ea580c', import: '#8a8aa0' }
}

/** Run view: branches that did not run (or have not yet). */
export const IDLE_EDGE_COLORS: Record<Theme, string> = { dark: '#4a4a5c', light: '#c8c8d4' }

export const TERMINAL_THEMES: Record<Theme, ITheme> = {
  dark: { background: '#101016', foreground: '#d4d4e0', cursor: '#7dd3fc', selectionBackground: '#3a3a55' },
  light: {
    background: '#f6f6fa',
    foreground: '#24243a',
    cursor: '#2563eb',
    selectionBackground: '#c7d2fe',
    black: '#24243a',
    red: '#b91c1c',
    green: '#15803d',
    yellow: '#a16207',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0e7490',
    white: '#6b7280',
    brightBlack: '#6e6e85',
    brightRed: '#dc2626',
    brightGreen: '#16a34a',
    brightYellow: '#ca8a04',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#0891b2',
    brightWhite: '#374151'
  }
}

export const MONACO_THEMES: Record<Theme, string> = { dark: 'iris-dark', light: 'iris-light' }
