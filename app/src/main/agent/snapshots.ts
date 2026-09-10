import type { SnapshotEntry, SnapshotStore } from './types'

// Per-file snapshot cap (docs/03 §7). Mirrors
// storage/checkpoints.ts MAX_SNAPSHOT_BYTES_PER_FILE — duplicated here so the
// Electron-free agent tree can enforce fail-closed caps without importing the
// better-sqlite3-backed repository (which cannot load under vitest).
export const MAX_SNAPSHOT_BYTES_PER_FILE = 10 * 1024 * 1024

/** Prefix marking base64-encoded raw bytes in a snapshot `content` string. */
export const BINARY_SNAPSHOT_PREFIX = 'b64:'

/**
 * Encode raw file bytes for the snapshot `content` string (TEXT-compatible,
 * no migration). Text files stay plain UTF-8; non-UTF-8 bytes become
 * `b64:<base64>` so undo restores exact bytes instead of corrupted text.
 */
export function encodeSnapshotContent(raw: Buffer): string {
  const text = raw.toString('utf8')
  if (Buffer.from(text, 'utf8').equals(raw)) return text
  return `${BINARY_SNAPSHOT_PREFIX}${raw.toString('base64')}`
}

/** Decode a snapshot `content` back to raw bytes (null = absent/evicted). */
export function decodeSnapshotContent(stored: string | null): Buffer | null {
  if (stored === null) return null
  if (stored.startsWith(BINARY_SNAPSHOT_PREFIX)) {
    return Buffer.from(stored.slice(BINARY_SNAPSHOT_PREFIX.length), 'base64')
  }
  return Buffer.from(stored, 'utf8')
}

export function isBinarySnapshotContent(stored: string | null): boolean {
  return stored !== null && stored.startsWith(BINARY_SNAPSHOT_PREFIX)
}

/** Safe excerpt head from raw bytes (replacement chars, never throws). */
export function excerptHeadFromBytes(raw: Buffer): string {
  const text = raw.toString('utf8')
  const lines = text.split(/\r?\n/).slice(0, 8)
  let out = lines.join('\n')
  if (out.length > 600) out = `${out.slice(0, 600)}…`
  if (lines.length === 8) out += '\n…'
  return out
}

// In-memory snapshot store for M2.1-M2.4 tests and the dev harness. The
// durable checkpoint store (SQLite checkpoints table + snapshots directory,
// docs/03 §7-8) lands with M2.5 — its checkbox explicitly requires the first
// mutating run to "prove snapshotting" at the persistence layer. The wrapper
// stage contract (snapshot BEFORE execute, no opt-out) is identical either way.
export function createInMemorySnapshotStore(): SnapshotStore & {
  entries: SnapshotEntry[]
  clear(): void
} {
  const entries: SnapshotEntry[] = []
  return {
    entries,
    remember(entry: SnapshotEntry): void {
      entries.push(entry)
    },
    clear() {
      entries.length = 0
    }
  }
}
