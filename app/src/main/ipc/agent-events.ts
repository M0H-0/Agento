import { BrowserWindow } from 'electron'
import { z } from 'zod'

// Session-scoped agent events (docs/03-agent-core.md §4): main → renderer
// pushes on the 'agent:event' channel, payload discriminated on `type`. All
// members share the { sessionId, runId, ts, seq } envelope and are
// Zod-validated both sides — the schema here builds/validates what main sends,
// the renderer's mirror schema (src/renderer/src/chat/agent-events.ts)
// validates everything before it touches state. Plan/approval events (M3)
// join the union; they must not need another channel.

// M1.5 simplifications, recorded in docs/03 §4: `runId` is a per-send uuid
// generated in main (real run lifecycle arrives in M2) and `seq` is a
// per-session monotonic counter kept in main memory only — the persisted
// event log / replay semantics arrive with the session state machine (§3).

const usageEventSchema = z.object({
  type: z.literal('usage'),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.number(), // epoch milliseconds
  seq: z.number().int().min(0),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable()
})

// One plan step as the model proposed it (docs/03 §2/§4, M3.1). The wire key
// is the model's step id; storage maps plans to positions (plan-steps repo).
export const planStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  tool: z.string().min(1),
  riskLevel: z.number().int().min(0).max(3),
  requiresApproval: z.boolean()
})

export type PlanStep = z.infer<typeof planStepSchema>

const planCreatedEventSchema = z.object({
  type: z.literal('plan/created'),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.number(),
  seq: z.number().int().min(0),
  steps: z.array(planStepSchema).min(1)
})

// Step transitions (docs/03 §2 stepwise execution). M3.1 adds the event
// member to the union; the loop starts emitting transitions when per-step
// tracing lands (M3.5/M3.6). `verification` is the badge payload (score +
// earned flag — a badge is never faked, docs/04 §3.3).
const planStepUpdatedEventSchema = z.object({
  type: z.literal('plan/step_updated'),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.number(),
  seq: z.number().int().min(0),
  stepId: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done', 'failed', 'awaiting_approval', 'skipped']),
  verification: z.object({ score: z.number().nullable(), verified: z.boolean() }).optional(),
  error: z.string().optional()
})

const approvalRequestedEventSchema = z.object({
  type: z.literal('approval/requested'),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.number(),
  seq: z.number().int().min(0),
  approvalId: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  riskLevel: z.number().int().min(2).max(3),
  count: z.number().int().min(2).optional(),
  allowOptions: z.array(z.enum(['approve', 'skip', 'cancel'])).optional()
})

const approvalResolvedEventSchema = z.object({
  type: z.literal('approval/resolved'),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.number(),
  seq: z.number().int().min(0),
  approvalId: z.string().min(1),
  decision: z.enum(['approve', 'skip', 'cancel'])
})

const verificationFinishedEventSchema = z.object({
  type: z.literal('verification/finished'),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.number(),
  seq: z.number().int().min(0),
  stepId: z.string().min(1),
  isComplete: z.boolean(),
  score: z.number().nullable(),
  missedSegments: z.array(z.string()).optional()
})

// Auto-generated chat title landed (docs/03 §4): fired when background title
// generation after the first send succeeds. Idempotent by sessionId — the
// renderer patches the sidebar row and must apply it even for a session that
// is no longer active, so it is handled before the active-run/seq guards.
const sessionTitleUpdatedEventSchema = z.object({
  type: z.literal('session/title_updated'),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.number(),
  seq: z.number().int().min(0),
  title: z.string().min(1)
})

export const agentEventSchema = z.discriminatedUnion('type', [
  usageEventSchema,
  planCreatedEventSchema,
  planStepUpdatedEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  verificationFinishedEventSchema,
  sessionTitleUpdatedEventSchema
])

export type AgentEvent = z.infer<typeof agentEventSchema>
export type UsageEvent = z.infer<typeof usageEventSchema>
export type PlanCreatedEvent = z.infer<typeof planCreatedEventSchema>
export type PlanStepUpdatedEvent = z.infer<typeof planStepUpdatedEventSchema>
export type ApprovalRequestedEvent = z.infer<typeof approvalRequestedEventSchema>
export type ApprovalResolvedEvent = z.infer<typeof approvalResolvedEventSchema>
export type VerificationFinishedEvent = z.infer<typeof verificationFinishedEventSchema>
export type SessionTitleUpdatedEvent = z.infer<typeof sessionTitleUpdatedEventSchema>

// Per-session event counter, in memory (see the M1.5 note above): starts at 1
// per session, advances with every agent:event, resets on app restart.
const seqBySession = new Map<string, number>()

function nextEventSeq(sessionId: string): number {
  const next = (seqBySession.get(sessionId) ?? 0) + 1
  seqBySession.set(sessionId, next)
  return next
}

// Broadcast to every window (sidecar:status precedent — a window that is not
// focused would otherwise go stale); the renderer filters by sessionId.
function emitAgentEvent(event: AgentEvent): void {
  // Build-validate: a malformed envelope is a main-side bug — fail loud here,
  // never send unvalidated payload across the bridge.
  agentEventSchema.parse(event)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('agent:event', event)
  }
}

// Token usage for one settled run (docs/03 §2 token guard, §4 usage event):
// emitted at the chat settle point, right beside the persistence it mirrors.
export function emitUsageEvent(input: {
  sessionId: string
  runId: string
  inputTokens: number | null
  outputTokens: number | null
}): void {
  emitAgentEvent({
    type: 'usage',
    sessionId: input.sessionId,
    runId: input.runId,
    ts: Date.now(),
    seq: nextEventSeq(input.sessionId),
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens
  })
}

// A plan was emitted (M3.1): fired by the chat adapter's plan/created hook —
// once per plan, including a revised plan mid-execution (the panel shows the
// "updated" chip when the same run re-plans).
export function emitPlanCreated(input: {
  sessionId: string
  runId: string
  steps: PlanStep[]
}): void {
  emitAgentEvent({
    type: 'plan/created',
    sessionId: input.sessionId,
    runId: input.runId,
    ts: Date.now(),
    seq: nextEventSeq(input.sessionId),
    steps: input.steps
  })
}

// M3.2/M3.5 emitters: approval round-trip + verification badge events.
// Both build-validate before send (malformed = main-side bug, fail loud).
export function emitApprovalRequested(input: {
  sessionId: string
  runId: string
  approvalId: string
  title: string
  body: string
  riskLevel: 2 | 3
  count?: number
}): void {
  emitAgentEvent({
    type: 'approval/requested',
    sessionId: input.sessionId,
    runId: input.runId,
    ts: Date.now(),
    seq: nextEventSeq(input.sessionId),
    approvalId: input.approvalId,
    title: input.title,
    body: input.body,
    riskLevel: input.riskLevel,
    ...(input.count !== undefined ? { count: input.count } : {}),
    allowOptions: ['approve', 'skip', 'cancel']
  })
}

export function emitApprovalResolved(input: {
  sessionId: string
  runId: string
  approvalId: string
  decision: 'approve' | 'skip' | 'cancel'
}): void {
  emitAgentEvent({
    type: 'approval/resolved',
    sessionId: input.sessionId,
    runId: input.runId,
    ts: Date.now(),
    seq: nextEventSeq(input.sessionId),
    approvalId: input.approvalId,
    decision: input.decision
  })
}

export function emitVerificationFinished(input: {
  sessionId: string
  runId: string
  stepId: string
  isComplete: boolean
  score: number | null
  missedSegments?: string[]
}): void {
  emitAgentEvent({
    type: 'verification/finished',
    sessionId: input.sessionId,
    runId: input.runId,
    ts: Date.now(),
    seq: nextEventSeq(input.sessionId),
    stepId: input.stepId,
    isComplete: input.isComplete,
    score: input.score,
    ...(input.missedSegments !== undefined ? { missedSegments: input.missedSegments } : {})
  })
}

// A plan step changed state (docs/03 §4). No M3.1 emitter yet — the loop's
// per-step tracing lands with M3.5/M3.6; the union member exists now so the
// renderer mirror + preload type are the contract from day one.
export function emitPlanStepUpdated(input: {
  sessionId: string
  runId: string
  stepId: string
  status: PlanStepUpdatedEvent['status']
  verification?: { score: number | null; verified: boolean }
  error?: string
}): void {
  emitAgentEvent({
    type: 'plan/step_updated',
    sessionId: input.sessionId,
    runId: input.runId,
    ts: Date.now(),
    seq: nextEventSeq(input.sessionId),
    stepId: input.stepId,
    status: input.status,
    ...(input.verification !== undefined ? { verification: input.verification } : {}),
    ...(input.error !== undefined ? { error: input.error } : {})
  })
}

// A session's auto-generated title landed (docs/03 §4): fired from chat:send's
// background first-send rename. The sidebar patches the row by id — safe for
// active and background sessions alike (title setting is idempotent).
export function emitSessionTitleUpdated(input: {
  sessionId: string
  runId: string
  title: string
}): void {
  emitAgentEvent({
    type: 'session/title_updated',
    sessionId: input.sessionId,
    runId: input.runId,
    ts: Date.now(),
    seq: nextEventSeq(input.sessionId),
    title: input.title
  })
}
