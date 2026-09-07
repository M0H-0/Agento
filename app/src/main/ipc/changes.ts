import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { countActiveCheckpoints, listCheckpoints } from '../storage/checkpoints'

// Changes contract (M2.5 stub; the full panel is M3): `changes:list` returns
// a session's checkpoints newest-first with plain-language fields for the
// stub list. The card-grade detail (excerpts) lives on the rows already —
// M3's ChangesPanel consumes the same feed.
export interface ChangesListPayload {
  sessionId: string
}

export interface ChangeEntry {
  id: string
  tool: string
  path: string
  // workspace-relative display path, computed main-side (the renderer never
  // sees the absolute root).
  relativePath: string
  existed: boolean
  size: number | null
  beforeExcerpt: string | null
  afterExcerpt: string | null
  revertedAt: string | null
  createdAt: string
}

export interface ChangesListResult {
  entries: ChangeEntry[]
  activeCount: number
}

function relativeTo(path: string, root: string): string {
  if (!root) return path
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const np = norm(path)
  const nr = norm(root).replace(/\/$/, '')
  if (np === nr) return '.'
  if (np.startsWith(`${nr}/`)) return np.slice(nr.length + 1)
  return path
}

export function registerChangesIpc(getCurrentWorkspace: () => string | null): void {
  ipcMain.handle(
    'changes:list',
    (_event: IpcMainInvokeEvent, payload: ChangesListPayload): ChangesListResult => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId.trim()) throw new Error('Session id is required.')
      const root = getCurrentWorkspace() ?? ''
      const rows = listCheckpoints(sessionId).map((row) => ({
        id: row.id,
        tool: row.tool,
        path: row.path,
        relativePath: relativeTo(row.path, root),
        existed: row.existed === 1,
        size: row.size,
        beforeExcerpt: row.beforeExcerpt,
        afterExcerpt: row.afterExcerpt,
        revertedAt: row.revertedAt,
        createdAt: row.createdAt
      }))
      return { entries: rows, activeCount: countActiveCheckpoints(sessionId) }
    }
  )
}
