import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileTool } from './tools/write_file'
import { askUserTool } from './tools/ask_user'
import { createHandlerHarness, createTempWorkspace } from './testing/harness'
import type { TempWorkspace } from './testing/harness'

// Wrapper stage tests (docs/07 §2 Registry wrapper row): prove every stage
// fires in the mandated order — schema validation → sandbox → risk →
// approval-hook → snapshot → execute — with the refusal paths short-circuiting
// exactly where they must. The harness stage-order log is the evidence.

function setup(decision: 'approve' | 'skip' | 'cancel' = 'approve'): {
  ws: TempWorkspace
  harness: ReturnType<typeof createHandlerHarness>
} {
  const ws = createTempWorkspace()
  const harness = createHandlerHarness(ws.root, decision)
  harness.registry.define(writeFileTool)
  return { ws, harness }
}

describe('registry wrapper — mandatory stage order', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ;({ ws, harness } = setup())
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('validates schema first and short-circuits before any other stage', async () => {
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'x.txt' }, // missing content
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('refused')
    expect(outcome.message).toContain('not right')
    expect(harness.stages.order).toEqual([])
    expect(existsSync(join(ws.root, 'x.txt'))).toBe(false)
  })

  it('sandbox refusal aborts before risk, approval, snapshot and execute', async () => {
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: '../../escape.txt', content: 'hi' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('refused')
    expect(outcome.error).toBe('sandbox')
    expect(harness.stages.order).toEqual([])
    expect(existsSync(join(ws.root, 'escape.txt'))).toBe(false)
  })

  it('risk-1 run on a new file executes with snapshot-before-execute and NO approval', async () => {
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'new.txt', content: 'hello' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    // snapshot logged, then the change hits disk
    expect(harness.stages.order).toEqual(['risk', 'snapshot'])
    // snapshot recorded full content BEFORE the mutation (absent → existed:false)
    expect(harness.stages.snapshots).toHaveLength(1)
    expect(harness.stages.snapshots[0].existed).toBe(false)
    expect(harness.stages.snapshots[0].content).toBeNull()
    expect(harness.stages.approvals).toHaveLength(0)
    expect(ws.read('new.txt')).toBe('hello')
  })

  it('risk-2 run on an existing file blocks on the approval hook; approve → snapshot then execute', async () => {
    ws.write('existing.txt', 'old content')
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'existing.txt', content: 'new content' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    expect(harness.stages.order).toEqual(['risk', 'approval', 'snapshot'])
    expect(harness.stages.approvals).toHaveLength(1)
    expect(harness.stages.approvals[0].decision).toBe('approve')
    // snapshot captured the OLD content (before execute)
    expect(harness.stages.snapshots).toHaveLength(1)
    expect(harness.stages.snapshots[0].existed).toBe(true)
    expect(harness.stages.snapshots[0].content).toBe('old content')
    expect(ws.read('existing.txt')).toBe('new content')
  })
  it('risk-2 skip → no snapshot, no mutation; cancel → same with cancel status', async () => {
    ws.write('existing.txt', 'pre-existing')

    const skipHarness = createHandlerHarness(ws.root, 'skip')
    skipHarness.registry.define(writeFileTool)
    const skipped = await skipHarness.registry.run({
      tool: 'write_file',
      args: { path: 'existing.txt', content: 'nope' },
      ctx: skipHarness.ctx
    })
    expect(skipped.ok).toBe(true)
    expect(skipped.status).toBe('skipped')
    expect(skipHarness.stages.snapshots).toHaveLength(0)
    expect(ws.read('existing.txt')).toBe('pre-existing')

    const cancelHarness = createHandlerHarness(ws.root, 'cancel')
    cancelHarness.registry.define(writeFileTool)
    const cancelled = await cancelHarness.registry.run({
      tool: 'write_file',
      args: { path: 'existing.txt', content: 'nope' },
      ctx: cancelHarness.ctx
    })
    expect(cancelled.ok).toBe(true)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelHarness.stages.snapshots).toHaveLength(0)
    expect(ws.read('existing.txt')).toBe('pre-existing')
  })

  it('unknown tool is refused loudly', async () => {
    const outcome = await harness.registry.run({ tool: 'nope', args: {}, ctx: harness.ctx })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('refused')
    expect(outcome.message).toContain('nope')
    expect(() => harness.registry.define(writeFileTool)).toThrowError(/Duplicate tool definition/)
  })

  it('snapshot failure refuses the mutation fail-closed (no execute)', async () => {
    const failingCtx = {
      ...harness.ctx,
      snapshot: (): void => {
        throw new Error('durable snapshot failed')
      }
    }
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'new.txt', content: 'hello' },
      ctx: failingCtx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('refused')
    expect(existsSync(join(ws.root, 'new.txt'))).toBe(false)
  })

  it('publishes sandbox-resolved absolute inputs for verification (not raw model paths)', async () => {
    const seen: { tool: string; input: unknown }[] = []
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'new.txt', content: 'hello' },
      ctx: harness.ctx,
      onOutcome: (entry) => void seen.push({ tool: entry.tool, input: entry.input })
    })
    expect(outcome.ok).toBe(true)
    expect(seen).toHaveLength(1)
    const published = (seen[0] as { input: { path: string } }).input
    expect(published.path).toBe(join(ws.root, 'new.txt'))
  })
})

describe('S3-005 — one confirmation per action (ask Yes skips the second dialog)', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(writeFileTool)
    harness.registry.define(askUserTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  async function ask(answer: string): Promise<void> {
    harness.stages.setPendingAnswer(answer)
    const outcome = await harness.registry.run({
      tool: 'ask_user',
      args: { question: 'May I edit todo.txt?' },
      ctx: { ...harness.ctx, activeToolCallId: `ask-${answer}-${Date.now()}` }
    })
    expect(outcome.ok).toBe(true)
  }

  it('ask Yes → risk-2 overwrite runs with NO approval dialog', async () => {
    ws.write('todo.txt', 'old')
    await ask('Yes')
    expect(harness.ctx.askApprovalGrant?.granted).toBe(true)
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'todo.txt', content: 'new' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    expect(harness.stages.approvals).toHaveLength(0)
    expect(harness.stages.order).toEqual(['risk', 'snapshot'])
    expect(ws.read('todo.txt')).toBe('new')
  })

  it('ask No → the gated call still raises its approval dialog (fail-closed)', async () => {
    ws.write('todo.txt', 'old')
    await ask('No')
    expect(harness.ctx.askApprovalGrant?.granted).toBe(false)
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'todo.txt', content: 'new' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(harness.stages.approvals).toHaveLength(1)
    expect(ws.read('todo.txt')).toBe('new')
  })

  it('the grant is one-shot: a second gated call asks again', async () => {
    ws.write('todo.txt', 'old')
    await ask('Yes')
    const first = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'todo.txt', content: 'first' },
      ctx: harness.ctx
    })
    expect(first.ok).toBe(true)
    expect(harness.stages.approvals).toHaveLength(0)
    const second = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'todo.txt', content: 'second' },
      ctx: harness.ctx
    })
    expect(second.ok).toBe(true)
    expect(harness.stages.approvals).toHaveLength(1)
    expect(ws.read('todo.txt')).toBe('second')
  })
})

describe('wrapper — atomic write + no temp leftovers', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ;({ ws, harness } = setup())
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('writes land through the injected facade atomically, with no temp-file leftovers', async () => {
    await harness.registry.run({
      tool: 'write_file',
      args: { path: 'folder/notes.md', content: '# hello\n\nworld' },
      ctx: harness.ctx
    })
    expect(ws.read('folder/notes.md')).toBe('# hello\n\nworld')
    // Atomic temp files always clean up on success.
    const leftovers = readdirSync(join(ws.root, 'folder')).filter((name) =>
      name.includes('.agento-tmp')
    )
    expect(leftovers).toEqual([])
  })
})
