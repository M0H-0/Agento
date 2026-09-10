import { sql } from 'drizzle-orm'
import { getDrizzle } from './db'
import {
  checkpoints,
  messages,
  planSteps as planStepsTable,
  sessions,
  toolCalls,
  usageEvents
} from './schema'
import { getUsageTotalsBySession } from './usage'

// Data-section maintenance (docs/04 §3.7) — the ONLY code besides the repos
// that deletes sessions/checkpoints in bulk. Plain Node, no Electron imports;
// the settings IPC layer calls these. All deletes are whole-table clears
// scoped to Agento's own data dir DB — never the user's workspace.

export interface DataSummary {
  sessionCount: number
  messageCount: number
  checkpointCount: number
  activeCheckpointCount: number
}

export function getDataSummary(): DataSummary {
  const db = getDrizzle()
  const sessionCount = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(sessions)
      .get()?.n ?? 0
  )
  const messageCount = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .get()?.n ?? 0
  )
  const checkpointCount = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(checkpoints)
      .get()?.n ?? 0
  )
  const activeCheckpointCount = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(checkpoints)
      .where(sql`${checkpoints.revertedAt} IS NULL`)
      .get()?.n ?? 0
  )
  return { sessionCount, messageCount, checkpointCount, activeCheckpointCount }
}

/** Delete every conversation and its messages/usage/tool-calls/plans/checkpoints. */
export function clearAllSessions(): { sessions: number } {
  const db = getDrizzle()
  const before = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(sessions)
      .get()?.n ?? 0
  )
  db.transaction((tx) => {
    tx.delete(checkpoints).run()
    tx.delete(toolCalls).run()
    tx.delete(planStepsTable).run()
    tx.delete(usageEvents).run()
    tx.delete(messages).run()
    tx.delete(sessions).run()
  })
  return { sessions: before }
}

/** Delete undo snapshots (checkpoints) but keep conversations and tool history. */
export function purgeSnapshots(): { checkpoints: number } {
  const db = getDrizzle()
  const before = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(checkpoints)
      .get()?.n ?? 0
  )
  db.delete(checkpoints).run()
  return { checkpoints: before }
}

export interface EvalExport {
  exportedAt: string
  sessionCount: number
  sessions: {
    id: string
    title: string
    provider: string | null
    model: string | null
    mode: string
    messageCount: number
    inputTokens: number | null
    outputTokens: number | null
    createdAt: string
    updatedAt: string
  }[]
  toolCalls: { tool: string; riskLevel: number | null; ok: number; count: number }[]
}

// Redacted eval/audit export (docs/05 §5 feed): counts and metadata only —
// no message content, no checkpoint content, no keys, no file paths.
export function buildEvalExport(): EvalExport {
  const db = getDrizzle()
  const rows = db.select().from(sessions).all()
  const totals = getUsageTotalsBySession()
  const messageCounts = new Map<string, number>()
  for (const row of db
    .select({ sessionId: messages.sessionId, n: sql<number>`count(*)` })
    .from(messages)
    .groupBy(messages.sessionId)
    .all()) {
    messageCounts.set(row.sessionId, Number(row.n ?? 0))
  }
  const toolRows = db
    .select({
      tool: toolCalls.tool,
      riskLevel: toolCalls.riskLevel,
      ok: toolCalls.ok,
      n: sql<number>`count(*)`
    })
    .from(toolCalls)
    .groupBy(toolCalls.tool, toolCalls.riskLevel, toolCalls.ok)
    .all()
  return {
    exportedAt: new Date().toISOString(),
    sessionCount: rows.length,
    sessions: rows.map((row) => {
      const usage = totals.get(row.id)
      return {
        id: row.id,
        title: row.title,
        provider: row.provider,
        model: row.model,
        mode: row.mode,
        messageCount: messageCounts.get(row.id) ?? 0,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }
    }),
    toolCalls: toolRows.map((row) => ({
      tool: row.tool,
      riskLevel: row.riskLevel,
      ok: row.ok ?? 0,
      count: Number(row.n ?? 0)
    }))
  }
}
