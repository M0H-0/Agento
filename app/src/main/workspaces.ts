import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

// Workspace selection + recents (docs/03 §4 workspace/*). Plain Node, no
// Electron imports (AGENTS.md rule 1) — userDataDir is injected, and only the
// IPC layer (src/main/ipc/workspaces.ts) owns the native folder dialog.
//
// Persistence: one file, `<userDataDir>/workspaces.json` in the app data dir,
// written temp-file + atomic rename on the same volume (the M1.2 review nit
// — every NEW persistence code path uses atomic writes). Absent/corrupt file
// resets to the empty state, never crashes (settings.ts precedent).
//
// realpath on pick: the stored path is the *canonical* path (junction/symlink
// folded, Windows-cased), which is exactly what the M2.3 sandbox walk compares
// against when it realpaths the workspace root — picking through a junction
// cannot surprise the guard later.

export interface WorkspaceRecent {
  path: string
  lastOpenedAt: string
}

export interface WorkspaceSnapshot {
  current: string | null
  recents: WorkspaceRecent[]
}

interface PersistedState {
  version: number
  current: string | null
  recents: WorkspaceRecent[]
}

export const WORKSPACES_VERSION = 1
export const MAX_RECENTS = 10

let dataDir: string | undefined
let state: PersistedState = { version: WORKSPACES_VERSION, current: null, recents: [] }

function filePath(): string {
  return join(dataDir ?? '', 'workspaces.json')
}

function normalizeRecents(input: unknown): WorkspaceRecent[] {
  if (!Array.isArray(input)) return []
  const entries: WorkspaceRecent[] = []
  for (const item of input) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { path?: unknown }).path === 'string' &&
      (item as { path: string }).path.length > 0 &&
      typeof (item as { lastOpenedAt?: unknown }).lastOpenedAt === 'string'
    ) {
      entries.push({
        path: (item as { path: string }).path,
        lastOpenedAt: (item as { lastOpenedAt: string }).lastOpenedAt
      })
    }
  }
  return entries.slice(0, MAX_RECENTS)
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function load(): void {
  try {
    const raw = readFileSync(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    state = {
      version: WORKSPACES_VERSION,
      current:
        typeof parsed.current === 'string' && parsed.current.length > 0 ? parsed.current : null,
      recents: normalizeRecents(parsed.recents)
    }
  } catch {
    // Absent or corrupt — the empty state, never a crash (settings.ts precedent).
    state = { version: WORKSPACES_VERSION, current: null, recents: [] }
  }
}

function persist(): void {
  if (!dataDir) throw new Error('Workspaces not initialized — call initWorkspaces() first.')
  mkdirSync(dataDir, { recursive: true })
  const tmp = `${filePath()}.${randomBytes(6).toString('hex')}.agento-tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, filePath())
}

export function initWorkspaces(userDataDir: string): void {
  dataDir = userDataDir
  load()
}

export function getCurrentWorkspace(): string | null {
  return state.current
}

export function listRecentWorkspaces(): WorkspaceRecent[] {
  return [...state.recents]
}

// Validate against the real filesystem (a directory that exists), canonicalize
// via realpath (see the module docstring), then adopt + persist. Throws a
// plain-language Error when the path is not an accessible directory — the IPC
// layer decides how to surface that to the user.
export function setCurrentWorkspace(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (trimmed === '') throw new Error('Pick a folder first — I need a workspace to work in.')
  let resolved: string
  try {
    resolved = realpathSync(trimmed)
  } catch {
    throw new Error(`I could not open that folder: "${trimmed}" isn't accessible.`)
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`I could not use "${resolved}" — it isn't a folder.`)
  }
  state.current = resolved
  const now = new Date().toISOString()
  state.recents = [
    { path: resolved, lastOpenedAt: now },
    ...state.recents.filter((entry) => !samePath(entry.path, resolved))
  ].slice(0, MAX_RECENTS)
  persist()
  return resolved
}
