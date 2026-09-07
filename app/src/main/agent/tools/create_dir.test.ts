import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDirTool } from './create_dir'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

// create_dir (M2.5): first mutating tool through the wrapper. Risk 1 on a
// new path (snapshot-before-execute, no approval); risk 2 when the path
// already exists. The snapshot records existed:0 for the undo path.

describe('create_dir — first mutation through the wrapper', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(createDirTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('creates the folder (risk 1: snapshot logged, no approval)', async () => {
    const outcome = await harness.registry.run({
      tool: 'create_dir',
      args: { path: 'docs' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    // risk stage probed once (isDirectory on a missing path), snapshot logged
    expect(harness.stages.order).toEqual(['risk', 'snapshot'])
    // no approval for risk 1
    expect(harness.stages.approvals).toHaveLength(0)
    // snapshot recorded the absent target (undo deletes)
    expect(harness.stages.snapshots).toHaveLength(1)
    expect(harness.stages.snapshots[0].existed).toBe(false)
    // the folder exists on disk now
    expect(harness.ctx.fs.isDirectory(harness.ctx.workspaceRoot + '\\docs')).toBe(true)
  })

  it('no-ops honestly when the folder already exists (risk 2)', async () => {
    const existing = ws.root + '\\already'
    harness.ctx.fs.mkdir(existing)
    const outcome = await harness.registry.run({
      tool: 'create_dir',
      args: { path: 'already' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    expect(harness.stages.approvals).toHaveLength(1) // risk 2 blocks
    if (!outcome.result) throw new Error('expected result')
    expect(outcome.result).toMatchObject({ existed: true })
  })

  it('refuses when a FILE exists at the path', async () => {
    ws.write('afile.txt', 'content')
    const outcome = await harness.registry.run({
      tool: 'create_dir',
      args: { path: 'afile.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('executed')
    expect(outcome.message).toMatch(/file, not a folder/i)
  })

  it('schema-rejects an empty path', async () => {
    const outcome = await harness.registry.run({
      tool: 'create_dir',
      args: { path: '' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
    expect(harness.stages.order).toEqual([]) // refused before any stage
  })

  it('describes with the folder name', () => {
    const desc = createDirTool.describe({ path: 'some/deep/folder' })
    expect(desc.group).toBe('files')
    expect(desc.title).toBe('Create folder folder')
  })
})
