import { createHash } from 'node:crypto'
import type { WorkspaceFs } from './types'
import { WorkspaceFsRefusalError } from './workspace-fs'

// Snapshot/undo engine (M2.8; docs/03 §7-8, docs/07 §2 undo matrix).
//
// Storage-free by contract (AGENTS.md rule 1): the engine operates on a plain
// checkpoint view + the injected WorkspaceFs facade, so the full undo matrix
// runs in plain vitest with a fake store and a real temp workspace —
// better-sqlite3 is Electron-ABI and cannot load under vitest (M2.2
// precedent). The durable adapter (three functions in
// `src/main/storage/checkpoints.ts`, wired in `src/main/ipc/changes.ts`)
// maps rows to UndoCheckpoint.
//
// Undo is itself undoable: every successful restore first captures the
// pre-undo state as a NEW checkpoint row and marks the undone row reverted
// (append-only — docs/03 §8). Undo is blocked mid-run by the IPC layer.

export interface UndoCheckpoint {
  id: string
  sessionId: string
  toolCallId: string | null
  path: string
  destPath: string | null
  existed: boolean
  isDir: boolean
  content: string | null
  sha256: string | null
  revertedAt: string | null
}

export interface UndoStore {
  getCheckpoint(id: string): UndoCheckpoint | undefined
  /** Newest-first, for undo-all replay order. */
  activeCheckpoints(sessionId: string): UndoCheckpoint[]
  markReverted(id: string, at: string): void
  appendUndoRow(input: {
    sessionId: string
    toolCallId: string | null
    path: string
    existed: boolean
    isDir: boolean
    content: string | null
  }): UndoCheckpoint
}

export type UndoResult =
  | { ok: true; checkpointId: string; undoneId: string; action: string }
  | { ok: false; checkpointId: string; error: string }

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function refusal(checkpointId: string, error: string): UndoResult {
  return { ok: false, checkpointId, error }
}

// The stored snapshot's own integrity gate (docs/03 §8): the content we are
// about to write back must hash to the row's sha — otherwise we refuse
// rather than restore bytes we cannot vouch for.
function verifyStoredContent(cp: UndoCheckpoint): string | null {
  if (cp.content === null) return 'evicted'
  if (cp.sha256 !== null && sha256Hex(cp.content) !== cp.sha256) return 'corrupt'
  return null
}

const EVICTED_COPY =
  'The snapshot for that change is no longer kept (it grew past the per-file or per-session cap and was evicted) — I cannot restore what I no longer have. Nothing was changed.'

/**
 * Undo one checkpoint: capture the pre-undo state as a new row, perform the
 * inverse mutation through the fs facade, mark the row reverted. Never
 * fabricates: evicted snapshots and corrupt rows refuse with plain language.
 */
export function undoCheckpoint(
  store: UndoStore,
  fs: WorkspaceFs,
  checkpointId: string
): UndoResult {
  const cp = store.getCheckpoint(checkpointId)
  if (!cp)
    return refusal(
      checkpointId,
      "I couldn't find that change — it may belong to another conversation. Nothing was changed."
    )
  if (cp.revertedAt !== null) {
    return refusal(checkpointId, 'That change was already restored. Nothing was changed.')
  }

  // Static refusal pre-checks run BEFORE the undo row is appended, so a
  // refused undo leaves no stray row in the Changes feed. Only the
  // existed-file restore needs stored content: a null there means the
  // snapshot was evicted (refuse, never fabricate), a sha mismatch means
  // corruption (refuse rather than write back bytes we cannot vouch for).
  const destAlive = cp.destPath !== null && fs.existsSync(cp.destPath)
  if (!destAlive && cp.existed && !cp.isDir) {
    const problem = verifyStoredContent(cp)
    if (problem === 'evicted') return refusal(checkpointId, EVICTED_COPY)
    if (problem === 'corrupt') {
      return refusal(
        checkpointId,
        'The stored snapshot for that change failed its integrity check, so I refused to write it back. Nothing was changed.'
      )
    }
  }

  // Capture the pre-undo state FIRST (the undo's own undo). Directories
  // carry no content — the row records dir-ness only.
  const targetIsDir = fs.isDirectory(cp.path)
  const targetExisted = fs.existsSync(cp.path)
  let preContent: string | null = null
  if (targetExisted && !targetIsDir) {
    try {
      preContent = fs.readFileSync(cp.path)
    } catch {
      return refusal(
        checkpointId,
        `I could not read the current state of that path, so I won't guess at restoring it. Nothing was changed.`
      )
    }
  }
  const undone = store.appendUndoRow({
    sessionId: cp.sessionId,
    toolCallId: cp.toolCallId,
    path: cp.path,
    existed: targetExisted,
    isDir: targetIsDir,
    content: preContent
  })

  const done = (action: string): UndoResult => {
    store.markReverted(cp.id, new Date().toISOString())
    return { ok: true, checkpointId, undoneId: undone.id, action }
  }

  try {
    // Moved → name restored (docs/03 §8): the dest goes back to the source.
    // When the dest is already gone (e.g. undo-all already replayed the dest
    // row, or the user deleted it), fall through to the content/dir cases.
    if (destAlive && cp.destPath) {
      fs.movePath(cp.destPath, cp.path)
      return done(`Restored the original name.`)
    }
    // Created by the agent → delete (undo deletes). Already gone is an
    // idempotent success.
    if (!cp.existed) {
      if (targetExisted) fs.deletePath(cp.path)
      return done('Removed what was created.')
    }
    // Existed as a directory → re-create (mkdir is an idempotent no-op when
    // the folder survived; the eviction question cannot arise — dir rows
    // never had content, and is_dir survives eviction).
    if (cp.isDir) {
      if (!targetExisted) fs.mkdir(cp.path)
      return done('Restored the folder.')
    }
    // Existed as a file → restore exact bytes (docs/03 §8). Reachability of
    // this branch implies the pre-check above already verified content + sha.
    fs.writeFileAtomic(cp.path, cp.content as string)
    return done('Restored the previous content.')
  } catch (error) {
    // The undo row stays (it honestly records the pre-undo state); the
    // original row is NOT marked reverted so the user can retry.
    if (error instanceof WorkspaceFsRefusalError) return refusal(checkpointId, error.message)
    throw error
  }
}

/**
 * Undo all active checkpoints (docs/03 §8), group-aware. Rows sharing a
 * toolCallId are one mutation (M2.7: a move lands a source row + a dest
 * row) and must replay OLDEST-first within the group: undoing a
 * move-onto-existing dest row first would overwrite the dest with its stale
 * content, destroying the moved bytes the source row needs to rename back.
 * Groups replay newest-group-first; singletons behave as before. Refusals
 * never stop the replay — an evicted snapshot must not block the rest — and
 * every per-item outcome is reported so the panel stays honest.
 */
export function undoAllCheckpoints(
  store: UndoStore,
  fs: WorkspaceFs,
  sessionId: string
): UndoResult[] {
  // activeCheckpoints arrives newest-first; snapshot the list (undo appends
  // rows as it goes, which must not join this replay).
  const all = store.activeCheckpoints(sessionId)
  const groups = new Map<string, UndoCheckpoint[]>()
  const order: string[] = []
  for (const cp of all) {
    const key = cp.toolCallId ?? `solo:${cp.id}`
    const group = groups.get(key)
    if (group) group.push(cp)
    else {
      groups.set(key, [cp])
      order.push(key)
    }
  }
  const results: UndoResult[] = []
  for (const key of order) {
    const group = groups.get(key) as UndoCheckpoint[]
    // Newest-first within the group → reverse into snapshot (oldest-first).
    for (let i = group.length - 1; i >= 0; i--) {
      results.push(undoCheckpoint(store, fs, (group[i] as UndoCheckpoint).id))
    }
  }
  return results
}
