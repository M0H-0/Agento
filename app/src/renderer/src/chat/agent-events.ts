import { z } from 'zod'

// Renderer-side schema for session-scoped agent events (docs/03 §4): every
// event received over window.agento.agent.onEvent is validated here BEFORE it
// touches any state — the Zod-both-sides rule. Mirror of the main-side schema
// in src/main/ipc/agent-events.ts; the preload's AgentEvent type is the
// structural contract between them, and drift fails loudly here.

const usageEventSchema = z.object({
  type: z.literal('usage'),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.number(),
  seq: z.number().int().min(0),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable()
})

// One plan step (docs/03 §4, M3.1) — mirrors the main-side planStepSchema.
const planStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  tool: z.string().min(1),
  riskLevel: z.number().int().min(0).max(3),
  requiresApproval: z.boolean()
})

const planCreatedEventSchema = z.object({
  type: z.literal('plan/created'),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.number(),
  seq: z.number().int().min(0),
  steps: z.array(planStepSchema).min(1)
})

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

export const agentEventSchema = z.discriminatedUnion('type', [
  usageEventSchema,
  planCreatedEventSchema,
  planStepUpdatedEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  verificationFinishedEventSchema
])

export type AgentEvent = z.infer<typeof agentEventSchema>
export type UsageEvent = z.infer<typeof usageEventSchema>
export type PlanCreatedEvent = z.infer<typeof planCreatedEventSchema>
export type PlanStepUpdatedEvent = z.infer<typeof planStepUpdatedEventSchema>
export type ApprovalRequestedEvent = z.infer<typeof approvalRequestedEventSchema>
export type ApprovalResolvedEvent = z.infer<typeof approvalResolvedEventSchema>
export type VerificationFinishedEvent = z.infer<typeof verificationFinishedEventSchema>
export type PlanStep = z.infer<typeof planStepSchema>

// Returns the parsed event, or null when validation failed (logged by the
// caller) — an invalid event must never reach session state.
export function parseAgentEvent(raw: unknown): AgentEvent | null {
  const result = agentEventSchema.safeParse(raw)
  if (!result.success) {
    console.error('agent:event failed validation:', result.error.message)
    return null
  }
  return result.data
}
