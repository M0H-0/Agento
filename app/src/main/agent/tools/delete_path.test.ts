import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deletePathTool } from './delete_path'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

// delete_path (M2.7): always risk 3 per the rule table (approval blocks),
// snapshot-before-execute holds the full content for undo. Non-empty
// folders are refused honestly.

describe('delete_path — deletion through the wrapper', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(deletePathTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('deletes the file (risk 3: approval, snapshot holds the content)', async () => {
    ws.write('draft.md', '# draft\nremove me\n')
    const outcome = await harness.registry.run({
      tool: 'delete_path',
      args: { path: 'draft.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    expect(harness.stages.order).toEqual(['approval', 'snapshot'])
    expect(harness.stages.approvals).toHaveLength(1)
    expect(harness.stages.snapshots).toHaveLength(1)
    expect(harness.stages.snapshots[0].existed).toBe(true)
    expect(harness.stages.snapshots[0].content).toBe('# draft\nremove me\n')
    expect(harness.ctx.fs.existsSync(harness.ctx.workspaceRoot + '\\draft.md')).toBe(false)
  })

  it('deletes an empty folder', async () => {
    harness.ctx.fs.mkdir(harness.ctx.workspaceRoot + '\\emptydir')
    const outcome = await harness.registry.run({
      tool: 'delete_path',
      args: { path: 'emptydir' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(harness.ctx.fs.existsSync(harness.ctx.workspaceRoot + '\\emptydir')).toBe(false)
  })

  it('refuses a non-empty folder with plain language', async () => {
    harness.ctx.fs.mkdir(harness.ctx.workspaceRoot + '\\fulldir')
    ws.write('fulldir\\inside.txt', 'kept')
    const outcome = await harness.registry.run({
      tool: 'delete_path',
      args: { path: 'fulldir' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/still has files/i)
    // nothing was changed
    expect(ws.read('fulldir\\inside.txt')).toBe('kept')
  })

  it('refuses a missing path with plain language', async () => {
    const outcome = await harness.registry.run({
      tool: 'delete_path',
      args: { path: 'gone.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/already be gone/i)
  })

  it('schema-rejects an empty path', async () => {
    const outcome = await harness.registry.run({
      tool: 'delete_path',
      args: { path: '' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
    expect(harness.stages.order).toEqual([])
  })

  it('describes with the deleted name', () => {
    const desc = deletePathTool.describe({ path: 'docs/draft.md' })
    expect(desc.group).toBe('files')
    expect(desc.title).toBe('Delete draft.md')
  })
})
