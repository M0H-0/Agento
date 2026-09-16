import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createWorkspaceFs } from './workspace-fs'
import type { WorkspaceFs } from './types'
import { undoAllCheckpoints, undoCheckpoint } from './undo'
import type { UndoCheckpoint, UndoStore } from './undo'
import { createTempWorkspace } from './testing/harness'
import type { TempWorkspace } from './testing/harness'

// Undo matrix (M2.8; docs/07 §2): create/edit/move/delete/dir, sha-mismatch
// refusal, undo-of-undo, evicted-snapshot refusal. The engine is
// storage-free, so the store is an in-memory fake while the fs is the REAL
// facade over a temp workspace (better-sqlite3 cannot load under vitest —
// M2.2 precedent; the durable adapter is three thin functions in
// storage/checkpoints.ts, proven live at the M2 milestone gate).

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

interface FakeRow extends UndoCheckpoint {
  order: number
}

function createFakeStore(): UndoStore & { rows: FakeRow[] } {
  const rows: FakeRow[] = []
  let seq = 0
  return {
    rows,
    getCheckpoint(id) {
      return rows.find((r) => r.id === id)
    },
    activeCheckpoints(sessionId) {
      return rows
        .filter((r) => r.sessionId === sessionId && r.revertedAt === null)
        .sort((a, b) => b.order - a.order)
    },
    allCheckpoints(sessionId) {
      return rows.filter((r) => r.sessionId === sessionId).sort((a, b) => b.order - a.order)
    },
    markReverted(id, at) {
      const row = rows.find((r) => r.id === id)
      if (row) row.revertedAt = at
    },
    appendUndoRow(input) {
      // Mirrors the durable adapter (storage/checkpoints.ts): undo rows are
      // stored with a null toolCallId — their own solo group, never merged
      // into the undone call's group (docs/04 §3.4 "restored" states).
      const stored = input.content
      const digest =
        stored === null
          ? null
          : stored.startsWith('b64:')
            ? createHash('sha256')
                .update(Buffer.from(stored.slice(4), 'base64'))
                .digest('hex')
            : sha(stored)
      const row: FakeRow = {
        id: `undo-${t()}`,
        sessionId: input.sessionId,
        toolCallId: null,
        path: input.path,
        destPath: null,
        existed: input.existed,
        isDir: input.isDir,
        content: stored,
        sha256: digest,
        revertedAt: null,
        order: t()
      }
      rows.push(row)
      return row
    }
  }

  function t(): number {
    seq += 1
    return seq
  }
}

function snap(
  store: UndoStore & { rows: FakeRow[] },
  partial: Partial<UndoCheckpoint> & { path: string }
): string {
  const id = `cp-${store.rows.length + 1}`
  store.rows.push({
    id,
    sessionId: 's1',
    toolCallId: null,
    destPath: null,
    existed: true,
    isDir: false,
    content: null,
    sha256: null,
    revertedAt: null,
    order: store.rows.length + 1,
    ...partial,
    path: partial.path
  })
  return id
}

describe('undo matrix', () => {
  let ws: TempWorkspace
  let fs: WorkspaceFs
  let store: UndoStore & { rows: FakeRow[] }

  const abs = (rel: string): string => join(ws.root, rel)

  beforeEach(() => {
    ws = createTempWorkspace()
    fs = createWorkspaceFs(ws.root)
    store = createFakeStore()
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('undoes a created file by deleting it', () => {
    ws.write('new.md', 'agent-made')
    const id = snap(store, { path: abs('new.md'), existed: false })
    const result = undoCheckpoint(store, fs, id)
    expect(result.ok).toBe(true)
    expect(fs.existsSync(abs('new.md'))).toBe(false)
    expect(store.getCheckpoint(id)?.revertedAt).not.toBeNull()
  })

  it('undoes an overwrite by restoring exact bytes', () => {
    ws.write('report.md', 'changed')
    const id = snap(store, {
      path: abs('report.md'),
      content: 'original\n',
      sha256: sha('original\n')
    })
    const result = undoCheckpoint(store, fs, id)
    expect(result.ok).toBe(true)
    expect(ws.read('report.md')).toBe('original\n')
  })

  it('undoes a delete by restoring the content', () => {
    const id = snap(store, { path: abs('gone.md'), content: 'come back', sha256: sha('come back') })
    const result = undoCheckpoint(store, fs, id)
    expect(result.ok).toBe(true)
    expect(ws.read('gone.md')).toBe('come back')
  })

  it('undoes a move by restoring the original name', () => {
    ws.write('backup.md', 'moved content')
    const fromId = snap(store, {
      path: abs('report.md'),
      destPath: abs('backup.md'),
      content: 'moved content',
      sha256: sha('moved content')
    })
    snap(store, { path: abs('backup.md'), existed: false })
    const result = undoCheckpoint(store, fs, fromId)
    expect(result.ok).toBe(true)
    expect(ws.read('report.md')).toBe('moved content')
    expect(fs.existsSync(abs('backup.md'))).toBe(false)
  })

  it('undo-all replays newest-first: dest row then source row', () => {
    ws.write('backup.md', 'moved content')
    const fromId = snap(store, {
      path: abs('report.md'),
      toolCallId: 'tc-move',
      destPath: abs('backup.md'),
      content: 'moved content',
      sha256: sha('moved content')
    })
    const toId = snap(store, { path: abs('backup.md'), toolCallId: 'tc-move', existed: false })
    const results = undoAllCheckpoints(store, fs, 's1')
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.ok)).toBe(true)
    // Group replays oldest-first: the source row renames the dest back, then
    // the dest row (created-by-agent, target now gone) succeeds idempotently.
    expect(ws.read('report.md')).toBe('moved content')
    expect(fs.existsSync(abs('backup.md'))).toBe(false)
    expect(store.getCheckpoint(fromId)?.revertedAt).not.toBeNull()
    expect(store.getCheckpoint(toId)?.revertedAt).not.toBeNull()
  })

  it('undo-all restores both sides of a move onto an existing dest', () => {
    ws.write('b.txt', 'moved over')
    // One tool call = one group: both rows share the AI SDK toolCallId the
    // wrapper threads through (the group replays oldest-first, so the source
    // row renames the moved bytes back BEFORE the dest row restores 'stale'
    // — newest-first would destroy the moved content).
    const fromId = snap(store, {
      path: abs('a.txt'),
      toolCallId: 'tc-move',
      destPath: abs('b.txt'),
      content: 'moved over',
      sha256: sha('moved over')
    })
    const toId = snap(store, {
      path: abs('b.txt'),
      toolCallId: 'tc-move',
      content: 'stale',
      sha256: sha('stale')
    })
    const results = undoAllCheckpoints(store, fs, 's1')
    expect(results.every((r) => r.ok)).toBe(true)
    expect(ws.read('a.txt')).toBe('moved over')
    expect(ws.read('b.txt')).toBe('stale')
    expect(store.getCheckpoint(fromId)?.revertedAt).not.toBeNull()
    expect(store.getCheckpoint(toId)?.revertedAt).not.toBeNull()
  })

  it('undoes a created folder and restores a deleted empty folder', () => {
    fs.mkdir(abs('made'))
    const madeId = snap(store, { path: abs('made'), existed: false, isDir: true })
    expect(undoCheckpoint(store, fs, madeId).ok).toBe(true)
    expect(fs.existsSync(abs('made'))).toBe(false)

    const goneId = snap(store, { path: abs('emptied'), existed: true, isDir: true })
    expect(undoCheckpoint(store, fs, goneId).ok).toBe(true)
    expect(fs.isDirectory(abs('emptied'))).toBe(true)
  })

  it('refuses a sha mismatch instead of writing untrusted bytes', () => {
    ws.write('report.md', 'changed')
    const id = snap(store, { path: abs('report.md'), content: 'original', sha256: 'deadbeef' })
    const result = undoCheckpoint(store, fs, id)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/integrity check/i)
    expect(ws.read('report.md')).toBe('changed')
    // refused rows stay active (retryable) and leave no stray undo row
    expect(store.getCheckpoint(id)?.revertedAt).toBeNull()
    expect(store.rows).toHaveLength(1)
  })

  it('refuses an evicted snapshot honestly, never fabricating', () => {
    const id = snap(store, { path: abs('big.bin'), content: null, sha256: null })
    const result = undoCheckpoint(store, fs, id)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/no longer kept/i)
    expect(fs.existsSync(abs('big.bin'))).toBe(false)
    expect(store.rows).toHaveLength(1)
  })

  it('undo-of-undo returns the file to its post-mutation state', () => {
    ws.write('report.md', 'changed')
    const id = snap(store, { path: abs('report.md'), content: 'original', sha256: sha('original') })
    const first = undoCheckpoint(store, fs, id)
    expect(first.ok).toBe(true)
    expect(ws.read('report.md')).toBe('original')
    if (!first.ok) throw new Error('expected success')
    const second = undoCheckpoint(store, fs, first.undoneId)
    expect(second.ok).toBe(true)
    expect(ws.read('report.md')).toBe('changed')
  })

  it('undo rows are solo groups: the undone item shows restored', () => {
    ws.write('report.md', 'changed')
    const id = snap(store, { path: abs('report.md'), content: 'original', sha256: sha('original') })
    const first = undoCheckpoint(store, fs, id)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected success')
    // The undone row is reverted while its undo row stays active in its OWN
    // group (null toolCallId) — so the panel can dim the item with
    // "restored" instead of showing it forever active (M2 gate finding).
    expect(store.getCheckpoint(id)?.revertedAt).not.toBeNull()
    const undone = store.getCheckpoint(first.undoneId)
    expect(undone?.revertedAt).toBeNull()
    expect(undone?.toolCallId).toBeNull()
  })

  it('refuses an already-reverted row', () => {
    ws.write('new.md', 'x')
    const id = snap(store, { path: abs('new.md'), existed: false })
    expect(undoCheckpoint(store, fs, id).ok).toBe(true)
    const again = undoCheckpoint(store, fs, id)
    expect(again.ok).toBe(false)
    if (again.ok) throw new Error('expected refusal')
    expect(again.error).toMatch(/already restored/i)
  })

  it('refuses an unknown checkpoint id', () => {
    const result = undoCheckpoint(store, fs, 'nope')
    expect(result.ok).toBe(false)
  })

  it('undo-all continues past a refusal and reports every outcome', () => {
    ws.write('good.md', 'changed')
    const goodId = snap(store, {
      path: abs('good.md'),
      content: 'good-orig',
      sha256: sha('good-orig')
    })
    // Newest row is evicted → refuses; the older good row must still restore.
    snap(store, { path: abs('big.bin'), content: null, sha256: null })
    const results = undoAllCheckpoints(store, fs, 's1')
    expect(results).toHaveLength(2)
    expect(results[0].ok).toBe(false)
    expect(results[1].ok).toBe(true)
    expect(ws.read('good.md')).toBe('good-orig')
    expect(store.getCheckpoint(goodId)?.revertedAt).not.toBeNull()
  })

  it('undo of a copy never touches the source — a later source edit survives', () => {
    // Copy snapshots only its DESTINATION (copy_path snapshotFields → ['to'],
    // M2.8 review fix). Before the fix the source row let undo rewrite the
    // source to its pre-copy state, destroying an unrelated later edit.
    ws.write('report.md', 'original')
    const destId = snap(store, { path: abs('backup.md'), existed: false })
    ws.write('report.md', 'original + user edit') // unrelated edit AFTER the copy
    const result = undoCheckpoint(store, fs, destId)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(fs.existsSync(abs('backup.md'))).toBe(false)
    expect(ws.read('report.md')).toBe('original + user edit')
  })

  it('undo of a copy onto an existing destination restores the old destination', () => {
    ws.write('report.md', 'new content')
    ws.write('backup.md', 'old dest content')
    const destId = snap(store, {
      path: abs('backup.md'),
      existed: true,
      content: 'old dest content',
      sha256: sha('old dest content')
    })
    const result = undoCheckpoint(store, fs, destId)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(ws.read('backup.md')).toBe('old dest content')
    expect(ws.read('report.md')).toBe('new content')
  })

  it('restores invalid-UTF-8 bytes exactly (binary-safe snapshots)', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs')
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x80, 0x81, 0x00])
    writeFileSync(abs('bin.dat'), raw)
    const { encodeSnapshotContent } = await import('./snapshots')
    const stored = encodeSnapshotContent(raw)
    const { createHash: createHash2 } = await import('node:crypto')
    const digest = createHash2('sha256').update(raw).digest('hex')
    const id = snap(store, { path: abs('bin.dat'), content: stored, sha256: digest })
    writeFileSync(abs('bin.dat'), Buffer.from('changed'))
    const result = undoCheckpoint(store, fs, id)
    expect(result.ok).toBe(true)
    expect(readFileSync(abs('bin.dat')).equals(raw)).toBe(true)
  })

  it('S5-002: undo-all after undo-redo-undo stays pristine (no re-apply)', () => {
    // s5d clean-room: ONE edit, then per-item undo → redo → undo (disk
    // verified pristine). Undo-all must NOT resurrect the edit.
    ws.write('todo.txt', 'pristine\n')
    const id = snap(store, {
      path: abs('todo.txt'),
      toolCallId: 'tc-edit',
      content: 'pristine\n',
      sha256: sha('pristine\n')
    })
    ws.write('todo.txt', 'call alice')
    const first = undoCheckpoint(store, fs, id)
    expect(first.ok).toBe(true)
    expect(ws.read('todo.txt')).toBe('pristine\n')
    if (!first.ok) throw new Error('expected success')
    const second = undoCheckpoint(store, fs, first.undoneId)
    expect(second.ok).toBe(true)
    expect(ws.read('todo.txt')).toBe('call alice')
    if (!second.ok) throw new Error('expected success')
    const third = undoCheckpoint(store, fs, second.undoneId)
    expect(third.ok).toBe(true)
    expect(ws.read('todo.txt')).toBe('pristine\n')
    const results = undoAllCheckpoints(store, fs, 's1')
    expect(results.every((r) => r.ok)).toBe(true)
    expect(ws.read('todo.txt')).toBe('pristine\n')
  })

  it('S5-002: undo-all after a redo restores pristine (no stuck edit)', () => {
    // Disk edited with only a redo row active (original + first undo
    // reverted): undo-all must rewind to the oldest snapshot, not no-op.
    ws.write('todo.txt', 'pristine\n')
    const id = snap(store, {
      path: abs('todo.txt'),
      toolCallId: 'tc-edit',
      content: 'pristine\n',
      sha256: sha('pristine\n')
    })
    ws.write('todo.txt', 'call alice')
    const first = undoCheckpoint(store, fs, id)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected success')
    const second = undoCheckpoint(store, fs, first.undoneId)
    expect(second.ok).toBe(true)
    expect(ws.read('todo.txt')).toBe('call alice')
    const results = undoAllCheckpoints(store, fs, 's1')
    expect(results.every((r) => r.ok)).toBe(true)
    expect(ws.read('todo.txt')).toBe('pristine\n')
  })

  it('S5-002: double undo-all never deletes (idempotent second pass)', async () => {
    // s5e escalation: a 2nd undo-all reverted the 1st's restore rows and
    // deleted both moved files. Second pass must be a no-op.
    const { renameSync } = await import('node:fs')
    fs.mkdir(abs('sub'))
    ws.write('a.txt', 'alpha')
    const fromId = snap(store, {
      path: abs('a.txt'),
      toolCallId: 'tc-move',
      destPath: abs('sub/a.txt'),
      content: 'alpha',
      sha256: sha('alpha')
    })
    snap(store, { path: abs('sub/a.txt'), toolCallId: 'tc-move', existed: false })
    // Simulate the completed move: source gone, dest holds the bytes.
    renameSync(abs('a.txt'), abs('sub/a.txt'))
    const first = undoAllCheckpoints(store, fs, 's1')
    expect(first.every((r) => r.ok)).toBe(true)
    expect(ws.read('a.txt')).toBe('alpha')
    expect(fs.existsSync(abs('sub/a.txt'))).toBe(false)
    expect(store.getCheckpoint(fromId)?.revertedAt).not.toBeNull()
    const second = undoAllCheckpoints(store, fs, 's1')
    expect(second.every((r) => r.ok)).toBe(true)
    expect(ws.read('a.txt')).toBe('alpha')
    expect(fs.existsSync(abs('sub/a.txt'))).toBe(false)
  })

  it('S5-002: undo-all with mixed edit+create restores both (no resurrection)', () => {
    // s5e v1/v4: after Ctrl+Z (edit) + /undo (create), undo-all re-applied
    // both. Oldest-per-path must delete the creation and rewind the edit.
    ws.write('note.txt', 'line one\nsecond line')
    const editId = snap(store, {
      path: abs('note.txt'),
      toolCallId: 'tc-edit',
      content: 'line one\n',
      sha256: sha('line one\n')
    })
    ws.write('c.txt', 'hello')
    const createId = snap(store, {
      path: abs('c.txt'),
      toolCallId: 'tc-create',
      existed: false
    })
    ws.write('note.txt', 'line one\n')
    expect(undoCheckpoint(store, fs, editId).ok).toBe(true)
    expect(undoCheckpoint(store, fs, createId).ok).toBe(true)
    expect(ws.read('note.txt')).toBe('line one\n')
    expect(fs.existsSync(abs('c.txt'))).toBe(false)
    const results = undoAllCheckpoints(store, fs, 's1')
    expect(results.every((r) => r.ok)).toBe(true)
    expect(ws.read('note.txt')).toBe('line one\n')
    expect(fs.existsSync(abs('c.txt'))).toBe(false)
  })
})
