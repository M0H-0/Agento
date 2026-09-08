import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  appendUndoRow,
  countActiveCheckpoints,
  getCheckpoint,
  listCheckpoints,
  markCheckpointReverted
} from '../storage/checkpoints'
import type { CheckpointRow } from '../storage/checkpoints'
import { createWorkspaceFs } from '../agent/workspace-fs'
import { undoAllCheckpoints, undoCheckpoint } from '../agent/undo'
import type { UndoCheckpoint, UndoResult, UndoStore } from '../agent/undo'

// Changes contract (M2.8 panel; docs/03 §4 + §7-8): `changes:list` returns a
// session's checkpoints newest-first with plain-language fields for the
// panel; `changes:undo` restores one checkpoint; `changes:undo-all` replays
// the session newest-first. The card-grade detail (excerpts) lives on the
// rows already. Undo is blocked mid-run (docs/03 §8) — the caller injects
// chat's run-active check (the agent tree stays Electron-free).
export interface ChangesListPayload {
  sessionId: string
}

export interface ChangeEntry {
  id: string
  tool: string
  /** The AI SDK toolCallId shared by a multi-row mutation (M2.7: a move lands
   * a source row + a dest row) — the panel groups these into one item. Null
   * for harness rows that carry none. */
  groupKey: string | null
  path: string
  // workspace-relative display path, computed main-side (the renderer never
  // sees the absolute root).
  relativePath: string
  /** Move destination, relative for display (M2.7 `dest_path`). */
  relativeDestPath: string | null
  existed: boolean
  isDir: boolean
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

export interface ChangesUndoPayload {
  checkpointId: string
}

export interface ChangesUndoAllPayload {
  sessionId: string
}

export interface ChangesUndoItem {
  checkpointId: string
  ok: boolean
  action?: string
  error?: string
}

export interface ChangesUndoResult {
  results: ChangesUndoItem[]
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

function toUndoCheckpoint(row: CheckpointRow): UndoCheckpoint {
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    path: row.path,
    destPath: row.destPath,
    existed: row.existed === 1,
    isDir: row.isDir === 1,
    content: row.content,
    sha256: row.sha256,
    revertedAt: row.revertedAt
  }
}

// The engine's durable adapter: three thin functions over the repos (the
// matrix proves the engine in vitest; this adapter is proven live at the M2
// milestone gate — better-sqlite3 cannot load under vitest, M2.2 precedent).
function durableStore(): UndoStore {
  return {
    getCheckpoint: (id) => {
      const row = getCheckpoint(id)
      return row ? toUndoCheckpoint(row) : undefined
    },
    activeCheckpoints: (sessionId) =>
      listCheckpoints(sessionId)
        .filter((row) => row.revertedAt === null)
        .map(toUndoCheckpoint),
    markReverted: (id, at) => markCheckpointReverted(id, at),
    // Undo rows are stored with a null toolCallId (their own "Restore
    // point" panel group — docs/04 §3.4): the engine's grouping key is only
    // meaningful for single tool calls that snapshot several paths.
    appendUndoRow: (input) =>
      toUndoCheckpoint(
        appendUndoRow({
          sessionId: input.sessionId,
          path: input.path,
          existed: input.existed,
          isDir: input.isDir,
          content: input.content
        })
      )
  }
}

function toItem(checkpointId: string, result: UndoResult): ChangesUndoItem {
  if (result.ok) return { checkpointId, ok: true, action: result.action }
  return { checkpointId, ok: false, error: result.error }
}

const MID_RUN_COPY =
  'A reply is still running in this conversation — wait until it finishes before undoing, so the restore cannot race the agent. Nothing was changed.'

// Undo is serialized main-side (M2.8 review fix): two concurrent
// `changes:undo`/`changes:undo-all` invokes would otherwise interleave their
// pre-undo state captures and restores — the engine is not transactional.
// The chain queues them so one restore finishes before the next begins. A
// failed restore surfaces to its own caller; it never poisons the chain.
let undoChain: Promise<void> = Promise.resolve()
function enqueueUndo<T>(work: () => Promise<T>): Promise<T> {
  const run = undoChain.then(work)
  undoChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function registerChangesIpc(
  getCurrentWorkspace: () => string | null,
  isSessionRunActive: (sessionId: string) => boolean
): void {
  const store = durableStore()
  const fsFor = (): ReturnType<typeof createWorkspaceFs> =>
    createWorkspaceFs(getCurrentWorkspace() ?? '')

  ipcMain.handle(
    'changes:list',
    (_event: IpcMainInvokeEvent, payload: ChangesListPayload): ChangesListResult => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId.trim()) throw new Error('Session id is required.')
      const root = getCurrentWorkspace() ?? ''
      const rows = listCheckpoints(sessionId).map((row) => ({
        id: row.id,
        tool: row.tool,
        groupKey: row.toolCallId,
        path: row.path,
        relativePath: relativeTo(row.path, root),
        relativeDestPath: row.destPath ? relativeTo(row.destPath, root) : null,
        existed: row.existed === 1,
        isDir: row.isDir === 1,
        size: row.size,
        beforeExcerpt: row.beforeExcerpt,
        afterExcerpt: row.afterExcerpt,
        revertedAt: row.revertedAt,
        createdAt: row.createdAt
      }))
      return { entries: rows, activeCount: countActiveCheckpoints(sessionId) }
    }
  )

  ipcMain.handle(
    'changes:undo',
    async (_event: IpcMainInvokeEvent, payload: ChangesUndoPayload): Promise<ChangesUndoResult> => {
      const checkpointId = typeof payload?.checkpointId === 'string' ? payload.checkpointId : ''
      if (!checkpointId.trim()) throw new Error('Checkpoint id is required.')
      const row = store.getCheckpoint(checkpointId)
      if (!row) {
        return {
          results: [
            {
              checkpointId,
              ok: false,
              error:
                "I couldn't find that change — it may belong to another conversation. Nothing was changed."
            }
          ]
        }
      }
      if (isSessionRunActive(row.sessionId)) {
        return { results: [{ checkpointId, ok: false, error: MID_RUN_COPY }] }
      }
      // Serialized behind any undo already in flight (no interleaved restores).
      return enqueueUndo(async () => ({
        results: [toItem(checkpointId, undoCheckpoint(store, fsFor(), checkpointId))]
      }))
    }
  )

  ipcMain.handle(
    'changes:undo-all',
    async (
      _event: IpcMainInvokeEvent,
      payload: ChangesUndoAllPayload
    ): Promise<ChangesUndoResult> => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId.trim()) throw new Error('Session id is required.')
      if (isSessionRunActive(sessionId)) {
        return { results: [{ checkpointId: '', ok: false, error: MID_RUN_COPY }] }
      }
      // Serialized behind any undo already in flight (no interleaved restores).
      return enqueueUndo(async () => {
        const results = undoAllCheckpoints(store, fsFor(), sessionId)
        return { results: results.map((result) => toItem(result.checkpointId, result)) }
      })
    }
  )
}
