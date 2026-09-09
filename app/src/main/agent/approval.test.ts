import { describe, expect, it } from 'vitest'
import { buildRunContext, newRunId } from './context'

// M3.2 approval promise: a risk ≥ 2 call blocks until resolveApproval.
describe('approval promise (M3.2)', () => {
  function bundle(): ReturnType<typeof buildRunContext> {
    return buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-appr',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
  }

  const req = {
    tool: 'delete_path',
    title: 'Delete file',
    riskLevel: 3 as const,
    reason: 'permanent',
    paths: ['C:/ws/a.txt']
  }

  it('blocks on the promise and executes after approve', async () => {
    const b = bundle()
    const pending = b.ctx.requestApproval(req)
    expect(b._pendingApprovalIds()).toHaveLength(1)
    const id = b._pendingApprovalIds()[0] as string
    expect(b.resolveApproval(id, 'approve')).toBe(true)
    expect(await pending).toBe('approve')
    expect(b.approvalDecisions).toHaveLength(1)
  })

  it('skip and cancel propagate to the caller', async () => {
    const b1 = bundle()
    const p1 = b1.ctx.requestApproval(req)
    expect(b1.resolveApproval(b1._pendingApprovalIds()[0] as string, 'skip')).toBe(true)
    expect(await p1).toBe('skip')

    const b2 = bundle()
    const p2 = b2.ctx.requestApproval(req)
    expect(b2.resolveApproval(b2._pendingApprovalIds()[0] as string, 'cancel')).toBe(true)
    expect(await p2).toBe('cancel')
  })

  it('projects the batch count from the plan step description', async () => {
    const emitted: { channel: string; payload: unknown }[] = []
    const b = buildRunContext({
      sender: { emit: (channel, payload) => emitted.push({ channel, payload }) },
      sessionId: 's-proj',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    b.setPlanSteps([
      { id: 's1', description: 'List the workspace', tool: 'list_dir' },
      { id: 's2', description: 'Delete all six temp files', tool: 'delete_path' }
    ])
    const pending = b.ctx.requestApproval(req)
    const event = emitted.find(
      (e) => (e.payload as { type?: string }).type === 'approval/requested'
    )
    expect(event).toBeDefined()
    expect((event?.payload as { count?: number }).count).toBe(6)
    expect(b.resolveApproval(b._pendingApprovalIds()[0] as string, 'approve')).toBe(true)
    expect(await pending).toBe('approve')
  })

  it('falls back to the step enumeration when the plan states no number', async () => {
    const emitted: { channel: string; payload: unknown }[] = []
    const run = buildRunContext({
      sender: { emit: (channel, payload) => emitted.push({ channel, payload }) },
      sessionId: 's-enum',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    run.setPlanSteps([{ id: 's1', description: 'Move every .txt file', tool: 'move' }])
    run.ctx.noteEnumeration?.(6)
    const pending = run.ctx.requestApproval(req)
    const event = emitted.find(
      (e) => (e.payload as { type?: string }).type === 'approval/requested'
    )
    expect((event?.payload as { count?: number }).count).toBe(6)
    expect(run.resolveApproval(run._pendingApprovalIds()[0] as string, 'approve')).toBe(true)
    expect(await pending).toBe('approve')
  })

  it('unknown id resolves false; stop rejects pendings', async () => {
    const b = bundle()
    expect(b.resolveApproval('nope', 'approve')).toBe(false)
    const pending = b.ctx.requestApproval(req)
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected'
    )
    expect(b.rejectApprovals('Stopped before you decided.')).toBe(1)
    expect(await settled).toBe('rejected')
    expect(b._pendingApprovalIds()).toHaveLength(0)
  })
})
