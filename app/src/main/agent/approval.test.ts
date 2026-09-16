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

  it('falls back to the scoped step enumeration when the plan states no number', async () => {
    const emitted: { channel: string; payload: unknown }[] = []
    const run = buildRunContext({
      sender: { emit: (channel, payload) => emitted.push({ channel, payload }) },
      sessionId: 's-enum',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    run.setPlanSteps([{ id: 's1', description: 'Move every .txt file', tool: 'move' }])
    run.ctx.noteEnumeration?.(6, 'C:/ws')
    const pending = run.ctx.requestApproval({
      tool: 'move_path',
      title: 'Move a.txt',
      riskLevel: 2,
      reason: 'move',
      paths: ['C:/ws/a.txt', 'C:/ws/dest/a.txt']
    })
    const event = emitted.find(
      (e) => (e.payload as { type?: string }).type === 'approval/requested'
    )
    expect((event?.payload as { count?: number }).count).toBe(6)
    expect(run.resolveApproval(run._pendingApprovalIds()[0] as string, 'approve')).toBe(true)
    expect(await pending).toBe('approve')
  })

  it('never escalates a risk-2 batch from an out-of-scope enumeration (Delete-verb bug)', async () => {
    // Live repro: a batch-move dialog showed "Delete permanently" — a
    // leftover enumeration (> 25) leaked through the unscoped fallback and
    // escalated the move group to risk 3. The dialog must stay risk 2 with
    // no phantom count.
    const emitted: { channel: string; payload: unknown }[] = []
    const run = buildRunContext({
      sender: { emit: (channel, payload) => emitted.push({ channel, payload }) },
      sessionId: 's-no-phantom-escalation',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    run.setPlanSteps([{ id: 's1', description: 'Move every .txt file', tool: 'move' }])
    run.ctx.noteEnumeration?.(30, 'C:/ws/invoices')
    const pending = run.ctx.requestApproval({
      tool: 'move_path',
      title: 'Move todo.txt',
      riskLevel: 2,
      reason: 'move',
      paths: ['C:/ws/todo.txt', 'C:/ws/done/todo.txt']
    })
    const event = emitted.find(
      (e) => (e.payload as { type?: string }).type === 'approval/requested'
    )
    expect(event).toBeDefined()
    expect((event?.payload as { riskLevel?: number }).riskLevel).toBe(2)
    expect((event?.payload as { count?: number }).count).toBeUndefined()
    expect((event?.payload as { body?: string }).body).not.toContain('batch of')
    expect(run.resolveApproval(run._pendingApprovalIds()[0] as string, 'approve')).toBe(true)
    expect(await pending).toBe('approve')
  })

  it('ignores an unscoped enumeration even when plan steps exist', async () => {
    const emitted: { channel: string; payload: unknown }[] = []
    const run = buildRunContext({
      sender: { emit: (channel, payload) => emitted.push({ channel, payload }) },
      sessionId: 's-unscoped-with-plan',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    run.setPlanSteps([{ id: 's1', description: 'Move every .txt file', tool: 'move' }])
    run.ctx.noteEnumeration?.(30)
    const pending = run.ctx.requestApproval({
      tool: 'move_path',
      title: 'Move todo.txt',
      riskLevel: 2,
      reason: 'move',
      paths: ['C:/ws/todo.txt', 'C:/ws/done/todo.txt']
    })
    const event = emitted.find(
      (e) => (e.payload as { type?: string }).type === 'approval/requested'
    )
    expect(event).toBeDefined()
    expect((event?.payload as { riskLevel?: number }).riskLevel).toBe(2)
    expect((event?.payload as { count?: number }).count).toBeUndefined()
    expect(run.resolveApproval(run._pendingApprovalIds()[0] as string, 'approve')).toBe(true)
    expect(await pending).toBe('approve')
  })

  it('ignores a leftover enumeration when the run has no plan steps', async () => {
    // Live repro: in plain Act mode an earlier list_dir (4 files) leaked its
    // enumeration into a later single-file edit approval ("batch of 4").
    const emitted: { channel: string; payload: unknown }[] = []
    const run = buildRunContext({
      sender: { emit: (channel, payload) => emitted.push({ channel, payload }) },
      sessionId: 's-noplan',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    run.ctx.noteEnumeration?.(4)
    const pending = run.ctx.requestApproval(req)
    const event = emitted.find(
      (e) => (e.payload as { type?: string }).type === 'approval/requested'
    )
    expect(event).toBeDefined()
    expect((event?.payload as { count?: number }).count).toBeUndefined()
    expect((event?.payload as { body?: string }).body).not.toContain('batch of')
    expect(run.resolveApproval(run._pendingApprovalIds()[0] as string, 'approve')).toBe(true)
    expect(await pending).toBe('approve')
  })

  it('S3-001: scoped enumeration projects an Act-mode batch with no plan steps', async () => {
    // Live repro: Act-mode list of invoices/ then "move every PDF invoice
    // into Finance" opened a singular dialog (displayCount null) that
    // authorized the whole batch. The listed directory scopes the count.
    const emitted: { channel: string; payload: unknown }[] = []
    const run = buildRunContext({
      sender: { emit: (channel, payload) => emitted.push({ channel, payload }) },
      sessionId: 's-scoped',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    run.ctx.noteEnumeration?.(12, 'C:/ws/invoices')
    const pending = run.ctx.requestApproval({
      tool: 'move_path',
      title: 'Move invoice_2026-01_northwind.pdf',
      riskLevel: 2,
      reason: 'move',
      paths: [
        'C:/ws/invoices/invoice_2026-01_northwind.pdf',
        'C:/ws/Finance/invoice_2026-01_northwind.pdf'
      ]
    })
    const event = emitted.find(
      (e) => (e.payload as { type?: string }).type === 'approval/requested'
    )
    expect(event).toBeDefined()
    expect((event?.payload as { count?: number }).count).toBe(12)
    expect(run.resolveApproval(run._pendingApprovalIds()[0] as string, 'approve')).toBe(true)
    expect(await pending).toBe('approve')
  })

  it('S3-001: scoped enumeration never leaks into approvals outside its directory', async () => {
    const emitted: { channel: string; payload: unknown }[] = []
    const run = buildRunContext({
      sender: { emit: (channel, payload) => emitted.push({ channel, payload }) },
      sessionId: 's-scope-phantom',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    run.ctx.noteEnumeration?.(12, 'C:/ws/invoices')
    const pending = run.ctx.requestApproval({
      tool: 'edit_file',
      title: 'Edit todo.txt',
      riskLevel: 2,
      reason: 'overwrite',
      paths: ['C:/ws/todo.txt']
    })
    const event = emitted.find(
      (e) => (e.payload as { type?: string }).type === 'approval/requested'
    )
    expect(event).toBeDefined()
    expect((event?.payload as { count?: number }).count).toBeUndefined()
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
