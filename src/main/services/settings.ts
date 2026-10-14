import { app } from 'electron'
import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { DEFAULT_SETTINGS, FONT_SIZE_RANGE, type AppSettings } from '../../shared/api'

interface Stored {
  lastProject: string | null
  /** Chosen entry point per project, keyed by the project's absolute path. */
  entryPoints: Record<string, string>
  /** What the Settings dialog edits. */
  prefs: AppSettings
}

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

const CHOICES = {
  theme: ['system', 'dark', 'light'],
  treeDirection: ['horizontal', 'vertical']
} as const

/** Copies the valid entries of `input` over `base`, ignoring anything unknown or of the wrong shape. */
function mergePrefs(base: AppSettings, input: unknown): AppSettings {
  const result: Record<string, unknown> = { ...base }
  if (!input || typeof input !== 'object') return base
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const value = (input as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (key in CHOICES) {
      if ((CHOICES[key as keyof typeof CHOICES] as readonly unknown[]).includes(value)) result[key] = value
    } else if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[key] = Math.min(Math.max(Math.round(value), FONT_SIZE_RANGE.min), FONT_SIZE_RANGE.max)
      }
    } else if (typeof fallback === 'string') {
      if (typeof value === 'string') result[key] = value.trim() || fallback
    } else if (typeof value === typeof fallback) {
      result[key] = value
    }
  }
  return result as unknown as AppSettings
}

let cached: Stored | null = null

export function getSettings(): Stored {
  if (cached) return cached
  cached = { lastProject: null, entryPoints: {}, prefs: { ...DEFAULT_SETTINGS } }
  try {
    const stored = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<Stored>
    if (typeof stored.lastProject === 'string') cached.lastProject = stored.lastProject
    if (stored.entryPoints && typeof stored.entryPoints === 'object') {
      cached.entryPoints = stored.entryPoints
    }
    cached.prefs = mergePrefs(cached.prefs, stored.prefs)
  } catch {
    // First launch, or an unreadable file: start from defaults.
  }
  return cached
}

export async function updateSettings(change: (settings: Stored) => void): Promise<void> {
  const settings = getSettings()
  change(settings)
  await mkdir(dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf8')
}

export function getPrefs(): AppSettings {
  return getSettings().prefs
}

export async function updatePrefs(changes: unknown): Promise<AppSettings> {
  await updateSettings((settings) => {
    settings.prefs = mergePrefs(settings.prefs, changes)
  })
  return getPrefs()
}
