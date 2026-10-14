import { BrowserWindow, dialog } from 'electron'
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import type { FileNode, ProjectInfo } from '../../shared/api'
import { getSettings, updateSettings } from './settings'

// Keep in step with IGNORED_DIRS in resources/tracer/iris_tracer.py. `.iris` holds Iris's own run traces.
const IGNORED_DIRS = new Set(['.git', '__pycache__', '.venv', 'venv', 'env', 'node_modules', '.pytest_cache', '.mypy_cache', '.idea', '.vscode', '.iris'])
const MAX_ENTRIES = 5000
const MAX_FILE_BYTES = 5 * 1024 * 1024

let root: string | null = null

export function getProjectRoot(): string | null {
  return root
}

/** Turns a project-relative path into an absolute one, refusing anything outside the project. */
export function resolveInProject(path: string): string {
  if (!root) throw new Error('No project is open.')
  const absolute = resolve(root, path)
  const fromRoot = relative(root, absolute)
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Path is outside the project: ${path}`)
  }
  return absolute
}

async function listDir(dir: string, prefix: string, budget: { left: number }): Promise<FileNode[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nodes: FileNode[] = []
  for (const entry of entries) {
    if (budget.left <= 0) break
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      budget.left--
      const children = await listDir(join(dir, entry.name), path, budget).catch(() => [])
      nodes.push({ name: entry.name, path, kind: 'dir', children })
    } else if (entry.isFile()) {
      budget.left--
      nodes.push({ name: entry.name, path, kind: 'file' })
    }
  }
  return nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
}

/** Every file in the open project as a flat list of relative paths. */
export async function listProjectFiles(): Promise<string[]> {
  if (!root) throw new Error('No project is open.')
  const paths: string[] = []
  const collect = (nodes: FileNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'file') paths.push(node.path)
      else collect(node.children ?? [])
    }
  }
  collect(await listDir(root, '', { left: MAX_ENTRIES }))
  return paths
}

async function describeProject(): Promise<ProjectInfo | null> {
  if (!root) return null
  return {
    root,
    name: basename(root),
    tree: await listDir(root, '', { left: MAX_ENTRIES }),
    entryPoint: getSettings().entryPoints[root] ?? null
  }
}

async function openProject(dir: string): Promise<ProjectInfo | null> {
  const info = await stat(dir)
  if (!info.isDirectory()) throw new Error(`Not a folder: ${dir}`)
  root = dir
  await updateSettings((settings) => {
    settings.lastProject = dir
  })
  return describeProject()
}

export async function openProjectDialog(window: BrowserWindow): Promise<ProjectInfo | null> {
  const result = await dialog.showOpenDialog(window, {
    title: 'Open project folder',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return openProject(result.filePaths[0])
}

export async function openLastProject(): Promise<ProjectInfo | null> {
  const { lastProject: last, prefs } = getSettings()
  if (!last || !prefs.reopenLastProject) return null
  try {
    return await openProject(last)
  } catch {
    return null // The folder was moved or deleted since last time.
  }
}

export function refreshProject(): Promise<ProjectInfo | null> {
  return describeProject()
}

export async function readProjectFile(path: string): Promise<string> {
  const absolute = resolveInProject(path)
  const info = await stat(absolute)
  if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is too large to open (over 5 MB).`)
  const bytes = await readFile(absolute)
  if (bytes.includes(0)) throw new Error(`${path} is not a text file.`)
  return bytes.toString('utf8')
}

export async function writeProjectFile(path: string, content: string): Promise<void> {
  await writeFile(resolveInProject(path), content, 'utf8')
}

export async function createProjectFile(path: string): Promise<void> {
  const absolute = resolveInProject(path)
  await mkdir(dirname(absolute), { recursive: true })
  try {
    await writeFile(absolute, '', { flag: 'wx' }) // "wx" refuses to overwrite an existing file
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${path} already exists.`)
    throw error
  }
}

export async function setEntryPoint(path: string | null): Promise<void> {
  const projectRoot = root
  if (!projectRoot) throw new Error('No project is open.')
  if (path !== null) resolveInProject(path)
  await updateSettings((settings) => {
    if (path === null) delete settings.entryPoints[projectRoot]
    else settings.entryPoints[projectRoot] = path
  })
}
