import type { SnapshotEntry, SnapshotStore } from './types'

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
