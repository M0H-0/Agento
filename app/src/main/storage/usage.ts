import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDrizzle } from './db'
import { usageEvents } from './schema'

// Usage repository — the only code that touches the usage_events table
// (docs/03-agent-core.md §8). Plain Node, no Electron imports.

export type UsageEventRow = typeof usageEvents.$inferSelect

// Timestamps are ISO-8601 TEXT written here, never SQLite defaults (same rule
// as the sessions/messages repositories).
function nowIso(): string {
  return new Date().toISOString()
}

// One row per chat run whose usage resolved (M1.5). A stopped run resolves no
// usage with the pinned ai@5.0.250 (verified against the installed dist:
// streamText's onFinish never fires and result.totalUsage rejects on a
// mid-first-step abort), so it records nothing rather than a fabricated zero.
// A missing field stays null per docs/03 §8's nullable columns.
export function insertUsage(input: {
  sessionId: string
  inputTokens: number | null
  outputTokens: number | null
}): UsageEventRow {
  return getDrizzle()
    .insert(usageEvents)
    .values({
      id: randomUUID(),
      sessionId: input.sessionId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      createdAt: nowIso()
    })
    .returning()
    .get()
}

// Per-session totals for the session list (docs/03 §4) — ONE grouped query,
// never a per-session round trip. Sessions with no usage rows are absent from
// the map.
export function getUsageTotalsBySession(): Map<
  string,
  { inputTokens: number; outputTokens: number }
> {
  const rows = getDrizzle()
    .select({
      sessionId: usageEvents.sessionId,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`
    })
    .from(usageEvents)
    .groupBy(usageEvents.sessionId)
    .all()
  const totals = new Map<string, { inputTokens: number; outputTokens: number }>()
  for (const row of rows) {
    totals.set(row.sessionId, {
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens)
    })
  }
  return totals
}
