import { describe, expect, it } from 'vitest'
import { buildRunContext, newRunId } from './context'

// Per-run ToolExecutionContext builder (docs/03 §5): wires the ask_user
// pause protocol, the (M2.4 no-op) approval hook, and the in-memory
// snapshot store. The IPC handler is the only caller; this test exists to
// pin the contract the bridge depends on (and to make the ask_user
// request/response cycle testable without spinning up Electron).

describe('buildRunContext — per-run ctx', () => {
  it('produces a ctx with all five required fields', () => {
    const { ctx } = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-1',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    expect(ctx.workspaceRoot).toBe('C:/ws')
    expect(typeof ctx.exists).toBe('function')
    expect(typeof ctx.snapshot).toBe('function')
    expect(typeof ctx.requestApproval).toBe('function')
    expect(typeof ctx.requestUserAnswer).toBe('function')
    expect(ctx.fs.existsSync('C:/ws/x.txt')).toBe(false) // nothing there
  })

  it('forwards an ask_user request through the sender and resolves on answer', async () => {
    const emitted: { channel: string; payload: unknown }[] = []
    const { ctx, resolveAskUserAnswer } = buildRunContext({
      sender: { emit: (channel, payload) => emitted.push({ channel, payload }) },
      sessionId: 's-2',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const pending = ctx.requestUserAnswer({ toolCallId: 'tc-1', question: 'Pick one' })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].channel).toBe('chat:part')
    const part = (
      emitted[0].payload as { part: { output: { __agentoAskUser: boolean; toolCallId: string } } }
    ).part
    expect(part.output.__agentoAskUser).toBe(true)
    expect(part.output.toolCallId).toBe('tc-1')
    expect(resolveAskUserAnswer('tc-1', 'yes')).toBe(true)
    expect(await pending).toBe('yes')
  })

  it('returns false from resolveAskUserAnswer when no pending answer matches', () => {
    const { resolveAskUserAnswer } = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-3',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    expect(resolveAskUserAnswer('nope', 'x')).toBe(false)
  })

  it('rejects pending answers (used by the chat:stop path)', async () => {
    const { ctx, rejectAskUserAnswer } = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-4',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const pending = ctx.requestUserAnswer({ toolCallId: 'tc-2', question: 'Pick' })
    expect(rejectAskUserAnswer('tc-2', 'Run stopped before the user replied.')).toBe(true)
    await expect(pending).rejects.toThrow(/Run stopped/)
  })

  it('records the in-memory snapshot when ctx.snapshot is called', () => {
    const { ctx, snapshotStore } = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-5',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    ctx.snapshot('C:/ws/file.md')
    expect(snapshotStore.entries).toHaveLength(1)
    expect(snapshotStore.entries[0].path).toBe('C:/ws/file.md')
    expect(snapshotStore.entries[0].existed).toBe(false) // nothing there
  })

  it('approves automatically because M2.4 has no risk ≥ 2 tools', async () => {
    const { ctx } = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-6',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const decision = await ctx.requestApproval({
      tool: 'write_file',
      title: 'Write',
      riskLevel: 2,
      reason: 'overwrite',
      paths: ['C:/ws/x']
    })
    expect(decision).toBe('approve')
  })
})
