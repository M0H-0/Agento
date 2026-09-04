import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { getSettings } from '../settings'
import { createSession, getSessionMessages, listSessions } from '../storage/sessions'
import type { SessionRow } from '../storage/sessions'

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

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`)
  }
  return value
}

function toSessionInfo(row: SessionRow): {
  id: string
  title: string
  createdAt: string
  updatedAt: string
} {
  return { id: row.id, title: row.title, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

export function registerSessionsIpc(): void {
  ipcMain.handle('session:create', (_event: IpcMainInvokeEvent, payload: CreateSessionPayload) => {
    // provider/model stamped from the same settings snapshot the chat
    // pipeline reads — nullable columns, useful from M1.5 (usage per
    // session) onward.
    const { provider, model } = getSettings()
    const title =
      typeof payload?.title === 'string' && payload.title.trim() !== '' ? payload.title : undefined
    return toSessionInfo(createSession({ title, provider, model }))
  })
  ipcMain.handle('session:list', () => listSessions().map(toSessionInfo))
  ipcMain.handle(
    'session:messages',
    (_event: IpcMainInvokeEvent, payload: SessionMessagesPayload) =>
      getSessionMessages(requireString(payload?.sessionId, 'Session id'))
  )
}
