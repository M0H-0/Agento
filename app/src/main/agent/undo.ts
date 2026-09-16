import { createHash } from 'node:crypto'
import type { WorkspaceFs } from './types'
import { decodeSnapshotContent, encodeSnapshotContent } from './snapshots'
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
  /** All rows newest-first (active + reverted) — undo-all needs the oldest
   * pre-conversation snapshot per path, which is usually already reverted
   * after per-item undos. Stores without history may return active only;
   * the engine falls back to the active set (legacy single-pass behavior
   * cannot hold in that case — see undoAllCheckpoints). */
  allCheckpoints(sessionId: string): UndoCheckpoint[]
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
  const raw = decodeSnapshotContent(content)
  return createHash('sha256')
    .update(raw ?? Buffer.from(content, 'utf8'))
    .digest('hex')
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
  // carry no content — the row records dir-ness only. Binary-safe: raw bytes
  // are re-encoded with the same b64: marker scheme as snapshots.
  const targetIsDir = fs.isDirectory(cp.path)
  const targetExisted = fs.existsSync(cp.path)
  let preContent: string | null = null
  if (targetExisted && !targetIsDir) {
    try {
      preContent = encodeSnapshotContent(fs.readFileBytes(cp.path))
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
    // Binary-safe: b64: rows decode to raw bytes; text rows write UTF-8.
    const raw =
      decodeSnapshotContent(cp.content as string) ?? Buffer.from(cp.content as string, 'utf8')
    fs.writeFileBytes(cp.path, raw)
    return done('Restored the previous content.')
  } catch (error) {
    // The undo row stays (it honestly records the pre-undo state); the
    // original row is NOT marked reverted so the user can retry.
    if (error instanceof WorkspaceFsRefusalError) return refusal(checkpointId, error.message)
    throw error
  }
}

/**
 * Undo all (docs/03 §8): restore every touched path to its pre-conversation
 * state — the OLDEST snapshot per path — regardless of intermediate per-item
 * undos/redos.
 *
 * Why not "revert every active row" (S5-002): per-item undo appends redoable
 * restore rows, so the newest active row per path is often a redo capture
 * (post-mutation state). Reverting it re-applies the mutation — and a second
 * undo-all then reverts the first's restore rows, deleting files. Instead:
 * for each path, compare the disk against the oldest row and restore only on
 * mismatch; when the disk already matches, consume the active rows with no
 * disk write (idempotent — a second undo-all is a no-op, never a delete).
 *
 * Move pairs stay atomic: a source row carrying destPath renames the dest
 * back first, so source paths process before their destinations. Refusals
 * never stop the replay and refused rows stay active (retryable).
 */
export function undoAllCheckpoints(
  store: UndoStore,
  fs: WorkspaceFs,
  sessionId: string
): UndoResult[] {
  // Full history newest-first (undo appends rows as it goes, which must not
  // join this replay — snapshot both lists up front).
  const history =
    typeof store.allCheckpoints === 'function'
      ? store.allCheckpoints(sessionId)
      : store.activeCheckpoints(sessionId)
  const active = store.activeCheckpoints(sessionId)
  const activeIdsByPath = new Map<string, string[]>()
  const activeOrder: string[] = []
  for (const cp of active) {
    const list = activeIdsByPath.get(cp.path)
    if (list) list.push(cp.id)
    else {
      activeIdsByPath.set(cp.path, [cp.id])
      activeOrder.push(cp.path)
    }
  }
  // Oldest row per path: history is newest-first, so the LAST occurrence
  // (earliest created) wins — always an original mutation, never an undo
  // row (undo rows are appended later for an already-touched path).
  const oldestByPath = new Map<string, UndoCheckpoint>()
  for (let i = history.length - 1; i >= 0; i--) {
    const cp = history[i] as UndoCheckpoint
    if (!oldestByPath.has(cp.path)) oldestByPath.set(cp.path, cp)
  }
  // Source paths (move rows carrying destPath) first so the rename lands
  // before the destination's own restore; remaining paths in newest-active
  // order for determinism.
  const sourcePaths: string[] = []
  const otherPaths: string[] = []
  const seen = new Set<string>()
  for (const path of activeOrder) {
    if (seen.has(path)) continue
    seen.add(path)
    const oldest = oldestByPath.get(path)
    if (oldest?.destPath) sourcePaths.push(path)
    else otherPaths.push(path)
  }
  for (const [path] of oldestByPath) {
    if (!seen.has(path) && activeIdsByPath.has(path)) {
      seen.add(path)
      const oldest = oldestByPath.get(path)
      if (oldest?.destPath) sourcePaths.push(path)
      else otherPaths.push(path)
    }
  }
  const results: UndoResult[] = []
  const markConsumed = (ids: string[]): void => {
    const at = new Date().toISOString()
    for (const id of ids) {
      try {
        store.markReverted(id, at)
      } catch {
        // Consume best-effort — the disk state is the arbiter.
      }
    }
  }
  const diskMatches = (oldest: UndoCheckpoint): boolean => {
    try {
      if (oldest.isDir) {
        if (!oldest.existed) return !fs.existsSync(oldest.path)
        return fs.isDirectory(oldest.path)
      }
      if (!oldest.existed) return !fs.existsSync(oldest.path)
      if (!fs.existsSync(oldest.path) || fs.isDirectory(oldest.path)) return false
      if (oldest.content === null || oldest.sha256 === null) return false
      const current = fs.readFileBytes(oldest.path)
      const encoded = encodeSnapshotContent(current)
      return sha256Hex(encoded) === oldest.sha256
    } catch {
      return false
    }
  }
  const restorePath = (oldest: UndoCheckpoint): UndoResult => {
    const ids = activeIdsByPath.get(oldest.path) ?? []
    const checkpointId = oldest.id
    // Already pre-conversation: consume redo rows, no disk write, no new row
    // (a second undo-all must be a no-op, never a delete).
    if (diskMatches(oldest)) {
      markConsumed(ids)
      return {
        ok: true,
        checkpointId,
        undoneId: ids[0] ?? oldest.id,
        action: 'Already restored.'
      }
    }
    // Capture pre-restore state so this undo-all stays undoable per item.
    const targetIsDir = (() => {
      try {
        return fs.isDirectory(oldest.path)
      } catch {
        return false
      }
    })()
    const targetExisted = (() => {
      try {
        return fs.existsSync(oldest.path)
      } catch {
        return false
      }
    })()
    let preContent: string | null = null
    if (targetExisted && !targetIsDir) {
      try {
        preContent = encodeSnapshotContent(fs.readFileBytes(oldest.path))
      } catch {
        return refusal(
          checkpointId,
          "I could not read the current state of that path, so I won't guess at restoring it. Nothing was changed."
        )
      }
    }
    // Refusal pre-checks mirror undoCheckpoint: evicted/corrupt snapshots
    // refuse with the row left active (retryable), never fabricating.
    const destAlive =
      oldest.destPath !== null &&
      (() => {
        try {
          return fs.existsSync(oldest.destPath as string)
        } catch {
          return false
        }
      })()
    if (!destAlive && oldest.existed && !oldest.isDir) {
      const problem = verifyStoredContent(oldest)
      if (problem === 'evicted') return refusal(checkpointId, EVICTED_COPY)
      if (problem === 'corrupt') {
        return refusal(
          checkpointId,
          'The stored snapshot for that change failed its integrity check, so I refused to write it back. Nothing was changed.'
        )
      }
    }
    let undoneId = ids[0] ?? oldest.id
    try {
      undoneId = store.appendUndoRow({
        sessionId: oldest.sessionId,
        toolCallId: null,
        path: oldest.path,
        existed: targetExisted,
        isDir: targetIsDir,
        content: preContent
      }).id
    } catch {
      // Append best-effort — still attempt the restore below.
    }
    try {
      if (destAlive && oldest.destPath) {
        fs.movePath(oldest.destPath, oldest.path)
        markConsumed(ids)
        return { ok: true, checkpointId, undoneId, action: 'Restored the original name.' }
      }
      if (!oldest.existed) {
        if (targetExisted) fs.deletePath(oldest.path)
        markConsumed(ids)
        return { ok: true, checkpointId, undoneId, action: 'Removed what was created.' }
      }
      if (oldest.isDir) {
        if (!targetExisted) fs.mkdir(oldest.path)
        markConsumed(ids)
        return { ok: true, checkpointId, undoneId, action: 'Restored the folder.' }
      }
      const raw =
        decodeSnapshotContent(oldest.content as string) ??
        Buffer.from(oldest.content as string, 'utf8')
      fs.writeFileBytes(oldest.path, raw)
      markConsumed(ids)
      return { ok: true, checkpointId, undoneId, action: 'Restored the previous content.' }
    } catch (error) {
      if (error instanceof WorkspaceFsRefusalError) return refusal(checkpointId, error.message)
      throw error
    }
  }
  for (const path of [...sourcePaths, ...otherPaths]) {
    const oldest = oldestByPath.get(path)
    if (!oldest) continue
    if (!activeIdsByPath.has(path)) continue
    results.push(restorePath(oldest))
  }
  return results
}
