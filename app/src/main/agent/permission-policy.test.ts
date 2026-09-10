import { afterEach, describe, expect, it } from 'vitest'
import { writeFileTool } from './tools/write_file'
import { createHandlerHarness, createTempWorkspace } from './testing/harness'
import type { TempWorkspace } from './testing/harness'

// M6.3 permission defaults (Settings → Permissions): risk1 ask routes
// reversible creates through the dialog; risk2 auto runs overwrites silently.
// Risk 3 always blocks — no setting exists. The harness ctx carries the
// policy; absent policy keeps today's behavior (covered by registry.test.ts).

describe('permission policy', () => {
  const workspaces: TempWorkspace[] = []
  afterEach(() => {
    for (const w of workspaces.splice(0)) w.cleanup()
  })

  function setup(): {
    workspace: TempWorkspace
    harness: ReturnType<typeof createHandlerHarness>
  } {
    const workspace = createTempWorkspace()
    workspaces.push(workspace)
    const harness = createHandlerHarness(workspace.root, 'approve')
    harness.registry.define(writeFileTool)
    return { workspace, harness }
  }

  it('risk 1 runs silently by default, asks when risk1 is ask', async () => {
    const { harness } = setup()
    // Default (no policy): no approval for a new file.
    const silent = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'a.txt', content: 'hello' },
      ctx: harness.ctx
    })
    expect(silent.ok).toBe(true)
    expect(harness.stages.approvals).toHaveLength(0)

    // Ask-first: the same shape blocks on the approval hook (amber dialog).
    harness.ctx.approvalPolicy = { askRisk1: true, autoRisk2: false }
    const asked = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'b.txt', content: 'hello' },
      ctx: harness.ctx
    })
    expect(asked.ok).toBe(true)
    expect(harness.stages.approvals).toHaveLength(1)
  })

  it('risk 2 blocks by default, runs silently when risk2 is auto', async () => {
    const { workspace, harness } = setup()
    workspace.write('exists.txt', 'old')
    // Default: overwrite blocks on the approval hook.
    const blocked = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'exists.txt', content: 'new' },
      ctx: harness.ctx
    })
    expect(blocked.ok).toBe(true)
    expect(harness.stages.approvals).toHaveLength(1)

    // Auto: the overwrite runs without asking (audit still records risk 2).
    harness.ctx.approvalPolicy = { askRisk1: false, autoRisk2: true }
    workspace.write('exists2.txt', 'old')
    const auto = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'exists2.txt', content: 'new' },
      ctx: harness.ctx
    })
    expect(auto.ok).toBe(true)
    expect(harness.stages.approvals).toHaveLength(1)
    expect(workspace.read('exists2.txt')).toBe('new')
  })
})
