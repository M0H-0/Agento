import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { emitPlanTool, planStepsSchema } from './emit_plan'
import { createToolRegistry } from '../registry'
import { buildRunContext, newRunId } from '../context'

// The plan tool (docs/03 §2/§5, M3.1): schema validates the structured plan,
// describes plainly, and is a pure risk-0 read — through the registry wrapper
// it must exercise NO snapshot and NO approval (stage-order proof).

const GOOD_STEPS = {
  steps: [
    {
      id: 's1',
      description: 'Move the PDF invoices into a folder called Finance',
      tool: 'move_path',
      riskLevel: 2,
      requiresApproval: true
    }
  ]
}

describe('emit_plan — schema', () => {
  it('accepts a well-formed step list', () => {
    const parsed = planStepsSchema.parse(GOOD_STEPS)
    expect(parsed.steps).toHaveLength(1)
    expect(parsed.steps[0]).toMatchObject({
      id: 's1',
      tool: 'move_path',
      riskLevel: 2,
      requiresApproval: true
    })
  })

  it('rejects steps with an out-of-range riskLevel', () => {
    const bad = {
      steps: [
        { id: 's1', description: 'x', tool: 'move_path', riskLevel: 4, requiresApproval: true }
      ]
    }
    expect(planStepsSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an empty plan and blank descriptions', () => {
    expect(planStepsSchema.safeParse({ steps: [] }).success).toBe(false)
    expect(
      planStepsSchema.safeParse({
        steps: [
          { id: 's1', description: '', tool: 'write_file', riskLevel: 0, requiresApproval: false }
        ]
      }).success
    ).toBe(false)
  })

  it('is wired as a pure read: risk 0, no path fields, plain describe', () => {
    expect(emitPlanTool.access).toBe('read')
    expect(emitPlanTool.pathFields).toEqual([])
    const ctx = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-plan',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const risk = emitPlanTool.risk(GOOD_STEPS, ctx.ctx)
    expect(risk.level).toBe(0)
    expect(emitPlanTool.describe(GOOD_STEPS)).toEqual({ title: 'Prepared a plan', group: 'plan' })
  })
})

describe('emit_plan — through the registry wrapper', () => {
  it('executes cleanly with no snapshot and no approval (stage order)', async () => {
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-plan-2',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const outcome = await registry.run({
      tool: 'emit_plan',
      args: GOOD_STEPS,
      ctx: run.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    // No pathFields → nothing was snapshotted; risk 0 → the approval hook was
    // never consulted.
    expect(run.snapshotStore.entries).toHaveLength(0)
    expect(run.approvalDecisions).toHaveLength(0)
  })

  it('schema round-trips a slightly imperfect model payload (extra keys tolerated)', () => {
    // Zod v4 default: unknown keys are stripped, not rejected — a model that
    // adds a "rationale" field must not kill the plan phase.
    const sloppy = { steps: [...GOOD_STEPS.steps], rationale: 'because' }
    const parsed = planStepsSchema.parse(sloppy)
    expect(parsed.steps).toHaveLength(1)
  })

  it('exposes the schema as a Zod type (the single source of truth)', () => {
    expect(planStepsSchema).toBeInstanceOf(z.ZodObject)
  })
})
