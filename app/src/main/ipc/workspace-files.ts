import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { getSession } from '../storage/sessions'
import { createWorkspaceFs } from '../agent/workspace-fs'
import { toRelativeEntries } from '../agent/workspace-listing'

// Workspace file listing for the renderer (composer @-mention / paperclip
// picker + contextual QuickActions, docs/03 §4 workspace/*): a read-only,
// sandboxed enumeration that returns workspace-RELATIVE paths only — the
// absolute root never crosses IPC (AGENTS.md rule 6, docs/06 §4).
export interface WorkspaceListFilesPayload {
  sessionId?: string
  /** Case-insensitive substring filter over the relative path. */
  prefix?: string
  limit?: number
}

export interface WorkspaceFileEntry {
  relativePath: string
  isDir: boolean
}

export interface WorkspaceListFilesResult {
  files: WorkspaceFileEntry[]
  truncated: boolean
}

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 1000

export function rootForSessionFiles(
  sessionId: string | undefined,
  getCurrentWorkspace: () => string | null
): string | null {
  if (sessionId && sessionId.trim()) {
    try {
      const row = getSession(sessionId)
      const stored = row?.workspacePath?.trim() ? row.workspacePath : null
      if (stored) return stored
    } catch {
      // Fall through to the current workspace.
    }
  }
  return getCurrentWorkspace()
}

export function registerWorkspaceFilesIpc(getCurrentWorkspace: () => string | null): void {
  ipcMain.handle(
    'workspace:list-files',
    (_event: IpcMainInvokeEvent, payload: WorkspaceListFilesPayload): WorkspaceListFilesResult => {
      const rawLimit =
        typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
          ? Math.floor(payload.limit)
          : DEFAULT_LIMIT
      const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
      const prefix = typeof payload?.prefix === 'string' ? payload.prefix.slice(0, 120) : ''
      const root = rootForSessionFiles(payload?.sessionId, getCurrentWorkspace)
      if (!root) return { files: [], truncated: false }
      let absolute: string[]
      try {
        absolute = createWorkspaceFs(root).walkFiles(root, MAX_LIMIT)
      } catch {
        return { files: [], truncated: false }
      }
      return toRelativeEntries(absolute, root, prefix, limit)
    }
  )
}
