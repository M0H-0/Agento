import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { getSettings } from '../settings'
import { getCurrentWorkspace } from '../workspaces'
import {
  createSession,
  getSessionMessages,
  listSessions,
  normalizeSessionMode,
  setSessionMode
} from '../storage/sessions'
import type { SessionMode, SessionRow } from '../storage/sessions'
import { getLatestPlan } from '../storage/plan-steps'
import { getUsageTotalsBySession } from '../storage/usage'

// Sessions contract (docs/03 §4 renderer→main; storage in docs/03 §8): plain
// invokes over the preload bridge; the DB is touched only by the storage
// repositories. Throwing keeps the established error path: the renderer's
// invoke promise rejects. The bridge carries the minimal SessionInfo shape —
// workspace_path stays display-only upstream; mode is exposed because the
// composer tabs own it per session.
export interface CreateSessionPayload {
  title?: string
  mode?: SessionMode
}

export interface SetSessionModePayload {
  sessionId: string
  mode: SessionMode
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
  mode: SessionMode
  createdAt: string
  updatedAt: string
  usage: SessionUsage | null
} {
  return {
    id: row.id,
    title: row.title,
    workspacePath: row.workspacePath,
    mode: normalizeSessionMode(row.mode),
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
      createSession({
        title,
        provider,
        model,
        workspacePath: getCurrentWorkspace() ?? undefined,
        mode: normalizeSessionMode(payload?.mode)
      }),
      undefined
    )
  })
  ipcMain.handle(
    'session:set-mode',
    (_event: IpcMainInvokeEvent, payload: SetSessionModePayload) => {
      if (typeof payload?.sessionId !== 'string' || payload.sessionId.trim() === '') {
        throw new Error('Session id is required.')
      }
      const row = setSessionMode(payload.sessionId, payload?.mode)
      if (!row) throw new Error('The session for this conversation no longer exists.')
      return toSessionInfo(row, undefined)
    }
  )
  ipcMain.handle('session:list', () => {
    const totals = getUsageTotalsBySession()
    return listSessions().map((row) => toSessionInfo(row, totals.get(row.id)))
  })
  ipcMain.handle(
    'session:messages',
    (_event: IpcMainInvokeEvent, payload: SessionMessagesPayload) =>
      getSessionMessages(requireString(payload?.sessionId, 'Session id'))
  )
  ipcMain.handle('session:plan', (_event: IpcMainInvokeEvent, payload: SessionMessagesPayload) => {
    // Latest saved plan for the PlanPanel restore (docs/03 §2): the reviewed
    // plan survives restarts; Act's "go ahead" executes it from this same
    // source. Empty array when no plan was ever saved.
    const sessionId = requireString(payload?.sessionId, 'Session id')
    try {
      return getLatestPlan(sessionId)
    } catch (error) {
      console.error('[plan] loading saved plan failed:', error)
      return []
    }
  })
}
