import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { getSettings } from '../settings'
import { getCurrentWorkspace } from '../workspaces'
import { createSession, getSessionMessages, listSessions } from '../storage/sessions'
import type { SessionRow } from '../storage/sessions'
import { getUsageTotalsBySession } from '../storage/usage'

// Sessions contract (docs/03 §4 renderer→main; storage in docs/03 §8): plain
// invokes over the preload bridge; the DB is touched only by the storage
// repositories. Throwing keeps the established error path: the renderer's
// invoke promise rejects. The bridge carries the minimal SessionInfo shape —
// storage-only columns (workspace_path, mode, …) stay main-side until a
// feature needs them.
export interface CreateSessionPayload {
  title?: string
}

export interface SessionMessagesPayload {
  sessionId: string
}

// M1.5: per-session token totals, aggregated from usage_events in one grouped
// query — null until the session's first settled run records usage.
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`)
  }
  return value
}

function toSessionInfo(
  row: SessionRow,
  usage: SessionUsage | undefined
): {
  id: string
  title: string
  workspacePath: string
  createdAt: string
  updatedAt: string
  usage: SessionUsage | null
} {
  return {
    id: row.id,
    title: row.title,
    workspacePath: row.workspacePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    usage: usage ?? null
  }
}

export function registerSessionsIpc(): void {
  ipcMain.handle('session:create', (_event: IpcMainInvokeEvent, payload: CreateSessionPayload) => {
    // provider/model stamped from the same settings snapshot the chat
    // pipeline reads — nullable columns, useful from M1.5 (usage per
    // session) onward. M2.2: workspace_path stamps the picker's current
    // workspace (still the '' placeholder when none was ever picked).
    const { provider, model } = getSettings()
    const title =
      typeof payload?.title === 'string' && payload.title.trim() !== '' ? payload.title : undefined
    return toSessionInfo(
      createSession({ title, provider, model, workspacePath: getCurrentWorkspace() ?? undefined }),
      undefined
    )
  })
  ipcMain.handle('session:list', () => {
    const totals = getUsageTotalsBySession()
    return listSessions().map((row) => toSessionInfo(row, totals.get(row.id)))
  })
  ipcMain.handle(
    'session:messages',
    (_event: IpcMainInvokeEvent, payload: SessionMessagesPayload) =>
      getSessionMessages(requireString(payload?.sessionId, 'Session id'))
  )
}
