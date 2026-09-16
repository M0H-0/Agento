import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { movePathTool } from './move_path'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

// move_path (M2.7): always risk 2 (the source disappears — approval blocks),
// both sides snapshotted before execute, and the source row carries dest_path
// so undo restores the original name (docs/03 §8).

describe('move_path — rename through the wrapper', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(movePathTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('moves the file (risk 2: approval, two snapshots, dest_path on the source row)', async () => {
    ws.write('report.md', '# report\nbody\n')
    const outcome = await harness.registry.run({
      tool: 'move_path',
      args: { from: 'report.md', to: 'backup.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    // no risk-stage probe (always 2) — approval first, then one snapshot per side
    expect(harness.stages.order).toEqual(['approval', 'snapshot', 'snapshot'])
    expect(harness.stages.approvals).toHaveLength(1)
    expect(harness.stages.snapshots).toHaveLength(2)
    const [fromSnap, toSnap] = harness.stages.snapshots
    expect(fromSnap.existed).toBe(true)
    expect(fromSnap.content).toBe('# report\nbody\n')
    expect(fromSnap.destPath).toBe(harness.ctx.workspaceRoot + '\\backup.md')
    expect(toSnap.existed).toBe(false)
    expect(toSnap.destPath ?? null).toBeNull()
    // disk: source gone, destination holds the content
    expect(harness.ctx.fs.existsSync(harness.ctx.workspaceRoot + '\\report.md')).toBe(false)
    expect(ws.read('backup.md')).toBe('# report\nbody\n')
    if (!outcome.result) throw new Error('expected result')
    expect(outcome.result).toMatchObject({ overwritten: false })
  })

  it('replaces an existing destination (its snapshot holds the old content)', async () => {
    ws.write('a.txt', 'new content')
    ws.write('b.txt', 'old dest content')
    const outcome = await harness.registry.run({
      tool: 'move_path',
      args: { from: 'a.txt', to: 'b.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(ws.read('b.txt')).toBe('new content')
    const [, toSnap] = harness.stages.snapshots
    expect(toSnap.existed).toBe(true)
    expect(toSnap.content).toBe('old dest content')
    if (!outcome.result) throw new Error('expected result')
    expect(outcome.result).toMatchObject({ overwritten: true })
  })

  it('no-ops honestly when from and to are the same path', async () => {
    ws.write('same.txt', 'kept')
    const outcome = await harness.registry.run({
      tool: 'move_path',
      args: { from: 'same.txt', to: 'same.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(ws.read('same.txt')).toBe('kept')
  })

  it('refuses a missing source with plain language', async () => {
    const outcome = await harness.registry.run({
      tool: 'move_path',
      args: { from: 'gone.txt', to: 'elsewhere.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/couldn't find/i)
  })

  it('names the current location when the source was already moved', async () => {
    // Stale plan state: the file now lives under PDFs/ — the refusal must say
    // so (lookup only; nothing is auto-moved).
    harness.ctx.fs.mkdir(harness.ctx.workspaceRoot + '\\PDFs')
    ws.write('PDFs/gone.txt', 'already moved')
    const outcome = await harness.registry.run({
      tool: 'move_path',
      args: { from: 'gone.txt', to: 'elsewhere.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/couldn't find/i)
    expect(outcome.message).toContain('already at')
    expect(outcome.message).toContain('PDFs/gone.txt')
    // Still a refusal: the file stays where it is.
    expect(ws.read('PDFs/gone.txt')).toBe('already moved')
  })

  it('moves a folder (rename works for directories)', async () => {
    harness.ctx.fs.mkdir(harness.ctx.workspaceRoot + '\\srcdir')
    const outcome = await harness.registry.run({
      tool: 'move_path',
      args: { from: 'srcdir', to: 'destdir' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(harness.ctx.fs.isDirectory(harness.ctx.workspaceRoot + '\\destdir')).toBe(true)
    expect(harness.ctx.fs.existsSync(harness.ctx.workspaceRoot + '\\srcdir')).toBe(false)
  })

  it('schema-rejects an empty destination', async () => {
    const outcome = await harness.registry.run({
      tool: 'move_path',
      args: { from: 'a.txt', to: '' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
    expect(harness.stages.order).toEqual([])
  })

  it('describes with the moved name', () => {
    const desc = movePathTool.describe({ from: 'docs/report.md', to: 'backup.md' })
    expect(desc.group).toBe('files')
    expect(desc.title).toBe('Move report.md')
  })
})
