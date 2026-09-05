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

export const agentEventSchema = z.discriminatedUnion('type', [usageEventSchema])

export type AgentEvent = z.infer<typeof agentEventSchema>
export type UsageEvent = z.infer<typeof usageEventSchema>

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
