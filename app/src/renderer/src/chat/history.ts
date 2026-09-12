// History (docs/04 §3.4): scrub across a session's checkpoint groups and
// preview each moment. Pure module (no DOM, no Electron, no node:path) so the
// slider component stays thin and the ordering contract is unit-testable.
//
// The feed arrives newest-first (`changes:list`); stops are oldest-first so a
// left-to-right slider reads as time passing. "Restore to here" is exclusive:
// it reverts the stops NEWER than the selected position, newest group first
// with oldest-first row order inside each group — the same order the engine's
// undo-all uses (snapshot order restores both sides of a move correctly).
// Already-reverted stops and undo-point rows (tool 'agent') are history
// markers: shown on the slider, never part of a restore plan.

import type { ChangeEntry } from '../../../preload/index'

export interface TimeStop {
  /** Group key (toolCallId) or `solo:<id>` — same rule as the panel. */
  key: string
  tool: string
  relativePath: string
  relativeDestPath: string | null
  fileName: string
  /** Oldest row's before-excerpt: how the file looked before this change. */
  beforeExcerpt: string | null
  /** Newest row's after-excerpt: how it looked right after. */
  afterExcerpt: string | null
  createdAt: string
  reverted: boolean
  /** Undo rows (tool 'agent') are their own markers, never restored over. */
  isUndoPoint: boolean
  /** Checkpoint ids, oldest-first (restore order inside the group). */
  rowIdsOldestFirst: string[]
}

export function fileNameOf(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path
}

/**
 * Group feed entries into oldest-first stops. Mirrors the panel's grouping
 * (shared toolCallId = one mutation; a move's two rows stay one stop).
 */
export function buildStops(entries: ChangeEntry[]): TimeStop[] {
  const groups = new Map<string, ChangeEntry[]>()
  const order: string[] = []
  for (const entry of entries) {
    const key = entry.groupKey ?? `solo:${entry.id}`
    const group = groups.get(key)
    if (group) group.push(entry)
    else {
      groups.set(key, [entry])
      order.push(key)
    }
  }
  // Feed is newest-first: reverse so index 0 is the oldest change.
  return order
    .map((key) => groups.get(key) as ChangeEntry[])
    .reverse()
    .map((rows) => {
      const oldest = rows[rows.length - 1] as ChangeEntry
      const newest = rows[0] as ChangeEntry
      return {
        key: oldest.groupKey ?? `solo:${oldest.id}`,
        tool: oldest.tool,
        relativePath: oldest.relativePath,
        relativeDestPath: oldest.relativeDestPath,
        fileName: fileNameOf(oldest.relativePath),
        beforeExcerpt: oldest.beforeExcerpt,
        afterExcerpt: newest.afterExcerpt,
        createdAt: oldest.createdAt,
        reverted: rows.every((row) => row.revertedAt !== null),
        isUndoPoint: oldest.tool === 'agent',
        rowIdsOldestFirst: [...rows].reverse().map((row) => row.id)
      }
    })
}

/** Stops newer than `index` (exclusive) that a rewind would actually restore. */
export function restorableNewer(stops: TimeStop[], index: number): TimeStop[] {
  return stops.slice(index + 1).filter((stop) => !stop.reverted && !stop.isUndoPoint)
}

/**
 * Ordered checkpoint ids for "restore to here" at `index`: newer restorable
 * stops first (newest group first), oldest row first inside each stop.
 */
export function restorePlan(stops: TimeStop[], index: number): string[] {
  return [...restorableNewer(stops, index)].reverse().flatMap((stop) => stop.rowIdsOldestFirst)
}
