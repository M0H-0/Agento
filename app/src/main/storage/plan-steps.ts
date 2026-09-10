import { randomUUID } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import { getDrizzle } from './db'
import { planSteps } from './schema'

// Plan-steps repository (migration 0005, M3.1; docs/03 §8 plan_steps).
// The ONLY code that touches the plan_steps table. Plain Node, no Electron
// imports — the IPC chat adapter calls it from the run's plan/created hook
// (the agent tree stays storage-free by contract).

export type PlanStepRow = typeof planSteps.$inferSelect

/** One step as it arrives on the `plan/created` event payload. */
export interface PlanStepInput {
  id: string
  description: string
  tool: string
  riskLevel: number
  requiresApproval: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

// Highest plan_version already recorded for the session (0 = no plan yet).
export function nextPlanVersion(sessionId: string): number {
  const row = getDrizzle()
    .select({ max: sql<number | null>`max(${planSteps.planVersion})` })
    .from(planSteps)
    .where(eq(planSteps.sessionId, sessionId))
    .get()
  return (row?.max ?? 0) + 1
}

// Persist one plan version's steps, all starting 'pending' (docs/03 §8).
// requiresApproval rides the event payload / LLM schema but has no
// plan_steps column in the documented DDL — the risk_level column carries
// the classification the UI needs; approval comes from the wrapper at
// execution time, not from the plan row. NOTE: the model-supplied wire step
// id has no column either — step-status tracing (plan/step_updated, M3.5/
// M3.6) will need its own storage decision (position-based or a migration);
// this card only records plans.
export function recordPlanSteps(input: {
  sessionId: string
  planVersion: number
  steps: PlanStepInput[]
}): PlanStepRow[] {
  const ts = nowIso()
  const rows = input.steps.map((step, index) => ({
    id: randomUUID(),
    sessionId: input.sessionId,
    planVersion: input.planVersion,
    position: index + 1,
    description: step.description,
    tool: step.tool,
    riskLevel: step.riskLevel,
    status: 'pending',
    verificationScore: null,
    verified: null,
    missedSegmentsJson: null,
    createdAt: ts,
    updatedAt: ts
  }))
  if (rows.length === 0) return []
  return getDrizzle().insert(planSteps).values(rows).returning().all()
}

// Latest emitted plan version for a session, oldest-position first. Used by
// Act mode's "go ahead" handoff and by session reopen (the PlanPanel restores
// what was reviewed even after a restart). Empty when no plan was ever saved.
export function getLatestPlan(sessionId: string): PlanStepInput[] {
  const versionRow = getDrizzle()
    .select({ max: sql<number | null>`max(${planSteps.planVersion})` })
    .from(planSteps)
    .where(eq(planSteps.sessionId, sessionId))
    .get()
  const version = versionRow?.max ?? null
  if (version === null) return []
  // The model-supplied wire step id has no column (docs/03 §8) — synthesize a
  // stable per-position id so Act's step binding and the panel keep working.
  return getDrizzle()
    .select({
      description: planSteps.description,
      tool: planSteps.tool,
      riskLevel: planSteps.riskLevel
    })
    .from(planSteps)
    .where(and(eq(planSteps.sessionId, sessionId), eq(planSteps.planVersion, version)))
    .orderBy(asc(planSteps.position))
    .all()
    .map((row, index) => ({
      id: `plan-v${version}-s${index + 1}`,
      description: row.description,
      tool: row.tool ?? 'unknown',
      riskLevel: typeof row.riskLevel === 'number' ? row.riskLevel : 0,
      requiresApproval: (row.riskLevel ?? 0) >= 2
    }))
}
