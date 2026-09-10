import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { getDrizzle } from './db'
import { checkpoints, toolCalls } from './schema'

// Checkpoints + tool-calls repository (migration 0003, M2.5; docs/03 §7-8).
// The ONLY code that touches the checkpoints/tool_calls tables. Plain Node,
// no Electron imports — the run ctx's snapshot hook receives this module's
// writer through injection (the agent tree stays storage-free by contract).

// Content caps (docs/03 §7): 10 MB/file, 200 MB/session. A file over the
// per-file cap stores NO content (existed + excerpts still land — the card
// works; undo of that path will refuse with a plain-language explanation,
// never fake a restore). Over the session cap, evict-oldest non-reverted
// checkpoints with a warning list.
export const MAX_SNAPSHOT_BYTES_PER_FILE = 10 * 1024 * 1024
export const MAX_SNAPSHOT_BYTES_PER_SESSION = 200 * 1024 * 1024

export type CheckpointRow = typeof checkpoints.$inferSelect
export type ToolCallRow = typeof toolCalls.$inferSelect

function nowIso(): string {
  return new Date().toISOString()
}

export interface RecordToolCallInput {
  sessionId: string
  toolCallId: string | null
  tool: string
  input: unknown
  output: unknown
  ok: boolean
  error?: string
  riskLevel: number
  riskSource: 'rule_table' | 'llm_fallback' | 'ts_fallback'
  durationMs: number
}

export function recordToolCall(input: RecordToolCallInput): ToolCallRow {
  return getDrizzle()
    .insert(toolCalls)
    .values({
      id: randomUUID(),
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      tool: input.tool,
      inputJson: JSON.stringify(input.input),
      outputJson: input.output === undefined ? null : JSON.stringify(input.output),
      ok: input.ok ? 1 : 0,
      error: input.error ?? null,
      riskLevel: input.riskLevel,
      riskSource: input.riskSource,
      durationMs: input.durationMs,
      createdAt: nowIso()
    })
    .returning()
    .get()
}

export interface RecordCheckpointInput {
  sessionId: string
  toolCallId: string | null
  /** Absolute path (sandbox-resolved) the tool will touch. */
  path: string
  /** set by move_path (M2.7). */
  destPath?: string | null
  existed: boolean
  /** True when the snapshotted path was a directory (M2.8). */
  isDir?: boolean
  /** Full pre-mutation content; null when the file did not exist or exceeded the per-file cap. */
  content: string | null
  size: number | null
  beforeExcerpt?: string | null
  afterExcerpt?: string | null
}

const BINARY_PREFIX = 'b64:'

function rawBytesForStored(content: string): Buffer {
  if (content.startsWith(BINARY_PREFIX)) {
    return Buffer.from(content.slice(BINARY_PREFIX.length), 'base64')
  }
  return Buffer.from(content, 'utf8')
}

function sha256ForStored(content: string): string {
  return createHash('sha256').update(rawBytesForStored(content)).digest('hex')
}

// Evict-oldest to keep the session under the byte budget (docs/03 §7). Only
// non-reverted checkpoints count; eviction returns the ids removed so the
// caller can surface a warning (M3 wires the UI).
function evictToBudget(sessionId: string): string[] {
  const rows = getDrizzle()
    .select({ id: checkpoints.id, size: checkpoints.size, revertedAt: checkpoints.revertedAt })
    .from(checkpoints)
    .where(eq(checkpoints.sessionId, sessionId))
    .orderBy(desc(checkpoints.createdAt))
    .all()
  let total = 0
  const evict: string[] = []
  const live = rows.filter((r) => r.revertedAt === null)
  for (const row of live) {
    total += row.size ?? 0
  }
  // rows are newest-first; walk from the oldest live entry until under budget
  for (let i = live.length - 1; i >= 0 && total > MAX_SNAPSHOT_BYTES_PER_SESSION; i--) {
    const row = live[i]
    if (row.id) {
      evict.push(row.id)
      total -= row.size ?? 0
    }
  }
  for (const id of evict) {
    getDrizzle()
      .update(checkpoints)
      .set({ content: null, size: null, sha256: null })
      .where(eq(checkpoints.id, id))
      .run()
  }
  return evict
}

// The snapshot writer — called by the run ctx's snapshot hook BEFORE a
// risk >= 1 mutation executes (docs/03 §7: no opt-out, no way to skip).
// One row per (mutation, path). The `after*` fields are backfilled by the
// tool's own result (write through) — M2.5 tools pass them in directly.
export function recordCheckpoint(input: RecordCheckpointInput): CheckpointRow {
  // The agent layer already enforces the per-file cap fail-closed; this is
  // the durable backstop (never store an oversized snapshot, never execute
  // on the caller's behalf — the caller throws before execute).
  const rawSize =
    input.content !== null ? rawBytesForStored(input.content).length : (input.size ?? null)
  const oversized = rawSize !== null && rawSize > MAX_SNAPSHOT_BYTES_PER_FILE
  if (oversized) {
    throw new Error(
      'That file is too large to safely snapshot (over 10 MB), so I left it untouched. Nothing was changed.'
    )
  }
  const storedContent = input.existed && input.content !== null && !oversized ? input.content : null
  const row = getDrizzle()
    .insert(checkpoints)
    .values({
      id: randomUUID(),
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      path: input.path,
      destPath: input.destPath ?? null,
      existed: input.existed ? 1 : 0,
      isDir: input.isDir ? 1 : 0,
      content: storedContent,
      size: input.content !== null ? rawSize : (input.size ?? null),
      sha256: storedContent !== null ? sha256ForStored(storedContent) : null,
      beforeExcerpt: input.beforeExcerpt ?? null,
      afterExcerpt: input.afterExcerpt ?? null,
      createdAt: nowIso()
    })
    .returning()
    .get()
  if (input.content !== null) evictToBudget(input.sessionId)
  return row
}

// Backfill the after-excerpt once the mutation executed (the checkpoint is
// written pre-execution; the card needs both sides, docs/03 §5).
export function setCheckpointAfterExcerpts(
  id: string,
  after: { afterExcerpt: string | null }
): void {
  getDrizzle()
    .update(checkpoints)
    .set({ afterExcerpt: after.afterExcerpt })
    .where(eq(checkpoints.id, id))
    .run()
}

// The Changes view's feed (docs/04): a session's checkpoints, newest-first,
// non-reverted first. Excerpt fields power the card bodies. Ordered by the
// checkpoints rowid (strict insertion order, table-qualified — the tool_calls
// join makes a bare `rowid` ambiguous) — M2.8: a move lands two rows in the
// same millisecond, and undo-all must replay them newest-first
// deterministically, which created_at ties cannot guarantee.
export function listCheckpoints(sessionId: string): (CheckpointRow & { tool: string })[] {
  const rows = getDrizzle()
    .select({
      checkpoint: checkpoints,
      tool: toolCalls.tool
    })
    .from(checkpoints)
    .leftJoin(toolCalls, eq(checkpoints.toolCallId, toolCalls.toolCallId))
    .where(eq(checkpoints.sessionId, sessionId))
    .orderBy(sql`"checkpoints"."rowid" DESC`)
    .all()
  return rows.map((r) => ({ ...r.checkpoint, tool: r.tool ?? 'agent' }))
}

// Session totals for the Changes badge (M3 refines into a real panel).
export function countActiveCheckpoints(sessionId: string): number {
  const row = getDrizzle()
    .select({ n: sql<number>`count(*)` })
    .from(checkpoints)
    .where(and(eq(checkpoints.sessionId, sessionId), isNull(checkpoints.revertedAt)))
    .get()
  return Number(row?.n ?? 0)
}

// Undo support (M2.8; docs/03 §7-8). The restore engine itself
// (`src/main/agent/undo.ts`) is storage-free and unit-tested in vitest; these
// three functions are its durable adapter — the only code besides the
// snapshot writer that touches the checkpoints table.
export function getCheckpoint(id: string): CheckpointRow | undefined {
  return getDrizzle().select().from(checkpoints).where(eq(checkpoints.id, id)).get()
}

export function markCheckpointReverted(id: string, at: string): void {
  getDrizzle().update(checkpoints).set({ revertedAt: at }).where(eq(checkpoints.id, id)).run()
}

export interface AppendUndoRowInput {
  sessionId: string
  path: string
  existed: boolean
  isDir: boolean
  content: string | null
}

/** Capture the pre-undo state as a new row (undo is itself undoable). */
export function appendUndoRow(input: AppendUndoRowInput): CheckpointRow {
  const stored = input.existed && !input.isDir && input.content !== null ? input.content : null
  return getDrizzle()
    .insert(checkpoints)
    .values({
      id: randomUUID(),
      sessionId: input.sessionId,
      toolCallId: null,
      path: input.path,
      destPath: null,
      existed: input.existed ? 1 : 0,
      isDir: input.isDir ? 1 : 0,
      content: stored,
      size: input.content !== null ? rawBytesForStored(input.content).length : null,
      sha256: stored !== null ? sha256ForStored(stored) : null,
      beforeExcerpt: null,
      afterExcerpt: null,
      createdAt: nowIso()
    })
    .returning()
    .get()
}
