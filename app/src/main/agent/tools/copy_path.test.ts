import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyPathTool } from './copy_path'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

// copy_path (M2.7): write_file's risk shape (1 new / 2 onto existing), one
// snapshot of the DESTINATION before execute (the source is only read — M2.8
// review fix, snapshotFields), byte-exact copy. Folders are refused.

describe('copy_path — file copy through the wrapper', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(copyPathTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('copies to a new path (risk 1: one probe, one snapshot, no approval)', async () => {
    ws.write('report.md', '# report\nbody\n')
    const outcome = await harness.registry.run({
      tool: 'copy_path',
      args: { from: 'report.md', to: 'backup.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    expect(harness.stages.order).toEqual(['risk', 'snapshot'])
    expect(harness.stages.approvals).toHaveLength(0)
    // Only the DESTINATION is snapshotted — copy never mutates its source, so
    // undo must never hold a row that could rewrite it (docs/03 §5 snapshotFields).
    expect(harness.stages.snapshots).toHaveLength(1)
    expect(harness.stages.snapshots[0]?.path).toBe(harness.ctx.workspaceRoot + '\\backup.md')
    expect(harness.stages.snapshots[0]?.existed).toBe(false)
    // source untouched, destination byte-identical
    expect(ws.read('report.md')).toBe('# report\nbody\n')
    expect(ws.read('backup.md')).toBe('# report\nbody\n')
    if (!outcome.result) throw new Error('expected result')
    expect(outcome.result).toMatchObject({ overwritten: false })
  })

  it('replaces an existing destination (risk 2: approval blocks)', async () => {
    ws.write('a.txt', 'fresh')
    ws.write('b.txt', 'stale')
    const outcome = await harness.registry.run({
      tool: 'copy_path',
      args: { from: 'a.txt', to: 'b.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(harness.stages.approvals).toHaveLength(1)
    expect(ws.read('b.txt')).toBe('fresh')
    const [toSnap] = harness.stages.snapshots
    expect(toSnap.existed).toBe(true)
    expect(toSnap.content).toBe('stale')
    expect(toSnap.path).toBe(harness.ctx.workspaceRoot + '\\b.txt')
    if (!outcome.result) throw new Error('expected result')
    expect(outcome.result).toMatchObject({ overwritten: true })
  })

  it('refuses a missing source with plain language', async () => {
    const outcome = await harness.registry.run({
      tool: 'copy_path',
      args: { from: 'gone.txt', to: 'backup.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/couldn't find/i)
  })

  it('names the current location when the source was already moved', async () => {
    harness.ctx.fs.mkdir(harness.ctx.workspaceRoot + '\\PDFs')
    ws.write('PDFs/gone.txt', 'already moved')
    const outcome = await harness.registry.run({
      tool: 'copy_path',
      args: { from: 'gone.txt', to: 'backup.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/couldn't find/i)
    expect(outcome.message).toContain('already at')
    expect(outcome.message).toContain('PDFs/gone.txt')
    expect(outcome.message).toContain('copy it from there')
  })

  it('refuses a folder source with plain language', async () => {
    harness.ctx.fs.mkdir(harness.ctx.workspaceRoot + '\\srcdir')
    const outcome = await harness.registry.run({
      tool: 'copy_path',
      args: { from: 'srcdir', to: 'dest.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/only copy files/i)
  })

  it('schema-rejects an empty source', async () => {
    const outcome = await harness.registry.run({
      tool: 'copy_path',
      args: { from: '', to: 'b.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
    expect(harness.stages.order).toEqual([])
  })

  it('describes with the copied name', () => {
    const desc = copyPathTool.describe({ from: 'docs/report.md', to: 'backup.md' })
    expect(desc.group).toBe('files')
    expect(desc.title).toBe('Copy report.md')
  })
})
