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

export const agentEventSchema = z.discriminatedUnion('type', [usageEventSchema])

export type AgentEvent = z.infer<typeof agentEventSchema>
export type UsageEvent = z.infer<typeof usageEventSchema>

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
