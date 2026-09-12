import { describe, expect, it } from 'vitest'
import type { ChangeEntry } from '../../../preload/index'
import { buildStops, fileNameOf, restorableNewer, restorePlan } from './history'

// History contract (docs/04 §3.4): grouping mirrors the panel, stops run
// oldest-first, "restore to here" is exclusive and follows the engine's
// undo-all order (newest group first, oldest row first inside a group).
// Node env — no DOM needed.

function entry(overrides: Partial<ChangeEntry> & { id: string }): ChangeEntry {
  return {
    tool: 'edit_file',
    groupKey: null,
    relativePath: 'notes.txt',
    relativeDestPath: null,
    existed: true,
    isDir: false,
    size: 10,
    beforeExcerpt: 'before',
    afterExcerpt: 'after',
    revertedAt: null,
    createdAt: '2026-09-12T10:00:00.000Z',
    ...overrides
  }
}

describe('fileNameOf', () => {
  it('takes the last segment, tolerates odd input', () => {
    expect(fileNameOf('a/b/report.md')).toBe('report.md')
    expect(fileNameOf('report.md')).toBe('report.md')
    expect(fileNameOf('')).toBe('')
  })
})

describe('buildStops', () => {
  it('returns oldest-first stops from a newest-first feed', () => {
    const entries = [entry({ id: 'c2', relativePath: 'b.txt' }), entry({ id: 'c1' })]
    const stops = buildStops(entries)
    expect(stops.map((stop) => stop.rowIdsOldestFirst)).toEqual([['c1'], ['c2']])
    expect(stops[0]?.relativePath).toBe('notes.txt')
    expect(stops[1]?.relativePath).toBe('b.txt')
  })

  it('keeps a move pair (shared toolCallId) as one stop, oldest row first', () => {
    const entries = [
      entry({ id: 'dest', tool: 'move_path', groupKey: 'tc1', relativePath: 'new.txt' }),
      entry({ id: 'src', tool: 'move_path', groupKey: 'tc1', relativePath: 'old.txt' })
    ]
    const stops = buildStops(entries)
    expect(stops).toHaveLength(1)
    expect(stops[0]?.rowIdsOldestFirst).toEqual(['src', 'dest'])
    expect(stops[0]?.relativePath).toBe('old.txt')
  })

  it('marks fully-reverted stops and undo-point rows', () => {
    const entries = [
      entry({ id: 'u1', tool: 'agent' }),
      entry({ id: 'r1', revertedAt: '2026-09-12T11:00:00.000Z' })
    ]
    const stops = buildStops(entries)
    expect(stops[0]?.reverted).toBe(true)
    expect(stops[1]?.isUndoPoint).toBe(true)
    expect(stops[1]?.reverted).toBe(false)
  })

  it('carries the oldest before-excerpt and newest after-excerpt', () => {
    const entries = [
      entry({ id: 'n', groupKey: 'tc', afterExcerpt: 'after-new' }),
      entry({ id: 'o', groupKey: 'tc', beforeExcerpt: 'before-old' })
    ]
    const stops = buildStops(entries)
    expect(stops[0]?.beforeExcerpt).toBe('before-old')
    expect(stops[0]?.afterExcerpt).toBe('after-new')
  })

  it('returns no stops for an empty feed', () => {
    expect(buildStops([])).toEqual([])
  })
})

describe('restorableNewer + restorePlan', () => {
  // Oldest-first: copy backup.md, then edit it with today's date.
  const entries = [
    entry({
      id: 'edit1',
      relativePath: 'backup.md',
      beforeExcerpt: 'no date',
      afterExcerpt: 'dated'
    }),
    entry({ id: 'copy1', tool: 'copy_path', relativePath: 'backup.md' })
  ]
  const stops = buildStops(entries)

  it('restore to the first stop rewinds only the newer edit (exclusive)', () => {
    expect(restorableNewer(stops, 0).map((stop) => stop.rowIdsOldestFirst)).toEqual([['edit1']])
    expect(restorePlan(stops, 0)).toEqual(['edit1'])
  })

  it('restore at the newest stop plans nothing', () => {
    expect(restorePlan(stops, 1)).toEqual([])
    expect(restorableNewer(stops, 1)).toEqual([])
  })

  it('skips reverted stops and undo points in the plan', () => {
    const withHistory = [
      entry({ id: 'e2', relativePath: 'b.txt' }),
      entry({ id: 'u1', tool: 'agent', relativePath: 'notes.txt' }),
      entry({ id: 'e1', relativePath: 'a.txt', revertedAt: '2026-09-12T11:00:00.000Z' })
    ]
    const history = buildStops(withHistory)
    // Newest (e2) is restorable; the undo point and the reverted row are not.
    expect(restorePlan(history, 0)).toEqual(['e2'])
    expect(restorableNewer(history, 0)).toHaveLength(1)
  })

  it('orders multi-row groups newest-first with oldest rows first inside', () => {
    const multi = [
      entry({ id: 'm2d', tool: 'move_path', groupKey: 't2', relativePath: 'y.txt' }),
      entry({ id: 'm2s', tool: 'move_path', groupKey: 't2', relativePath: 'x.txt' }),
      entry({ id: 'm1d', tool: 'move_path', groupKey: 't1', relativePath: 'b.txt' }),
      entry({ id: 'm1s', tool: 'move_path', groupKey: 't1', relativePath: 'a.txt' })
    ]
    const groups = buildStops(multi)
    expect(restorePlan(groups, -1)).toEqual(['m2s', 'm2d', 'm1s', 'm1d'])
  })
})
