import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { getDrizzle } from './db'
import { checkpoints, messages, planSteps, sessions, toolCalls, usageEvents } from './schema'

// Session repository — the only code that touches the sessions/messages tables
// (docs/02 §2.5, docs/03-agent-core.md §8). Plain Node, no Electron imports.

export type SessionMode = 'plan' | 'act'

export function normalizeSessionMode(value: unknown): SessionMode {
  return value === 'plan' ? 'plan' : 'act'
}

export interface SessionRow {
  id: string
  title: string
  /** 1 once the user renamed the chat — auto-titles must never overwrite it. */
  titleRenamed: number
  workspacePath: string
  mode: SessionMode
  status: string
  provider: string | null
  model: string | null
  createdAt: string
  updatedAt: string
}

const DEFAULT_TITLE = 'New task' // schema default, docs/03 §8

// workspace_path is NOT NULL per docs/03 §8; until the workspace picker lands
// (M2.2) every session stores the empty-string placeholder (M1.3 Devlog). M2.2
// stamps the picker's current workspace (or keeps the placeholder when the user
// never picked one) on every new session.
const WORKSPACE_PLACEHOLDER = ''

// Timestamps are ISO-8601 TEXT written here, never SQLite defaults — they must
// survive round-trips through JSON tooling and sort lexicographically.
function nowIso(): string {
  return new Date().toISOString()
}

export function createSession(input: {
  title?: string
  provider?: string
  model?: string
  workspacePath?: string
  mode?: unknown
}): SessionRow {
  const now = nowIso()
  // The drizzle row types `mode` as string — normalize on the way out so the
  // repository's SessionRow contract (SessionMode) always holds.
  return withNormalizedMode(
    getDrizzle()
      .insert(sessions)
      .values({
        id: randomUUID(),
        title: input.title?.trim() ? input.title.trim() : DEFAULT_TITLE,
        workspacePath: input.workspacePath ?? WORKSPACE_PLACEHOLDER,
        mode: normalizeSessionMode(input.mode),
        provider: input.provider ?? null,
        model: input.model ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .get()
  )
}

export function setSessionMode(sessionId: string, mode: unknown): SessionRow | undefined {
  const next = normalizeSessionMode(mode)
  const now = nowIso()
  const row = getDrizzle()
    .update(sessions)
    .set({ mode: next, updatedAt: now })
    .where(eq(sessions.id, sessionId))
    .returning()
    .get()
  return row === undefined ? undefined : withNormalizedMode(row)
}

// Title-only update for auto-generated chat titles (docs/03 §4): the rename
// lands in the background after the first send. updatedAt is deliberately NOT
// bumped — sidebar ordering stays message-driven, and a background rename
// must not shuffle the list.
export function setSessionTitle(sessionId: string, title: string): SessionRow | undefined {
  const row = getDrizzle()
    .update(sessions)
    .set({ title })
    .where(eq(sessions.id, sessionId))
    .returning()
    .get()
  return row === undefined ? undefined : withNormalizedMode(row)
}

// User rename (sidebar, docs/04 §2): stores the new title AND marks the row so
// the background auto-title skips this session from now on. updatedAt stays
// put, like setSessionTitle — a rename must not reorder the sidebar.
export function renameSession(sessionId: string, title: string): SessionRow | undefined {
  const row = getDrizzle()
    .update(sessions)
    .set({ title, titleRenamed: 1 })
    .where(eq(sessions.id, sessionId))
    .returning()
    .get()
  return row === undefined ? undefined : withNormalizedMode(row)
}

// One conversation and its children — messages, usage, tool-call audit,
// plan steps, and checkpoints (no FK cascades in the schema, so every child
// goes explicitly, inside one transaction). Returns whether the row existed.
export function deleteSession(sessionId: string): { deleted: boolean } {
  const db = getDrizzle()
  const result = db.transaction((tx) => {
    tx.delete(messages).where(eq(messages.sessionId, sessionId)).run()
    tx.delete(usageEvents).where(eq(usageEvents.sessionId, sessionId)).run()
    tx.delete(toolCalls).where(eq(toolCalls.sessionId, sessionId)).run()
    tx.delete(planSteps).where(eq(planSteps.sessionId, sessionId)).run()
    tx.delete(checkpoints).where(eq(checkpoints.sessionId, sessionId)).run()
    return tx.delete(sessions).where(eq(sessions.id, sessionId)).run()
  })
  return { deleted: result.changes > 0 }
}

function withNormalizedMode<T extends { mode: string }>(row: T): T & { mode: SessionMode } {
  return { ...row, mode: normalizeSessionMode(row.mode) }
}

export function listSessions(): SessionRow[] {
  return getDrizzle()
    .select()
    .from(sessions)
    .orderBy(desc(sessions.updatedAt))
    .all()
    .map((row) => withNormalizedMode(row))
}

export function getSession(id: string): SessionRow | undefined {
  const row = getDrizzle().select().from(sessions).where(eq(sessions.id, id)).get()
  return row ? withNormalizedMode(row) : undefined
}

// content stores the full serialized UIMessage JSON (M1.3 Devlog): parse back
// exactly what was streamed. A corrupt row is skipped with a warning rather
// than failing the whole history load.
export function getSessionMessages(sessionId: string): UIMessage[] {
  const rows = getDrizzle()
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.seq))
    .all()
  const parsed: UIMessage[] = []
  for (const row of rows) {
    try {
      parsed.push(JSON.parse(row.content) as UIMessage)
    } catch (error) {
      console.warn(`[storage] skipping unparseable message row in session ${sessionId}:`, error)
    }
  }
  return parsed
}

// L1 session recall: text extraction + keyword search over one session's
// persisted transcript. Searches user + assistant text parts only (tool
// outputs and system notices are not conversation memory). Corrupt rows are
// skipped like getSessionMessages above — recall is never fatal.

const HISTORY_EXCERPT_CHARS = 300

function historyTextOf(message: UIMessage): string {
  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return ''
  const texts: string[] = []
  for (const part of parts) {
    if (
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      texts.push((part as { text: string }).text)
    }
  }
  return texts.join('\n')
}

function excerptOfHistory(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= HISTORY_EXCERPT_CHARS
    ? oneLine
    : `${oneLine.slice(0, HISTORY_EXCERPT_CHARS)}…`
}

export interface HistorySearchHit {
  seq: number
  role: string
  excerpt: string
}

export interface HistoryRecentEntry {
  seq: number
  role: string
  text: string
}

function readSessionTranscript(sessionId: string): { seq: number; role: string; text: string }[] {
  const rows = getDrizzle()
    .select({ seq: messages.seq, role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.seq))
    .all()
  const out: { seq: number; role: string; text: string }[] = []
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue
    try {
      const text = historyTextOf(JSON.parse(row.content) as UIMessage).trim()
      if (text) out.push({ seq: row.seq, role: row.role, text })
    } catch (error) {
      console.warn(`[storage] skipping unparseable message row in session ${sessionId}:`, error)
    }
  }
  return out
}

/** Keyword recall: case-insensitive substring over user+assistant text, newest-first. */
export function searchSessionMessages(
  sessionId: string,
  query: string,
  limit = 5
): HistorySearchHit[] {
  const capped = Math.min(Math.max(limit, 1), 10)
  const lowered = query.toLowerCase()
  const transcript = readSessionTranscript(sessionId)
  const hits: HistorySearchHit[] = []
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const entry = transcript[i] as { seq: number; role: string; text: string }
    const idx = entry.text.toLowerCase().indexOf(lowered)
    if (idx === -1) continue
    // Excerpt centers on the match so long messages show the relevant span.
    const start = Math.max(0, idx - 120)
    hits.push({
      seq: entry.seq,
      role: entry.role,
      excerpt: excerptOfHistory(entry.text.slice(start))
    })
    if (hits.length >= capped) break
  }
  return hits
}

/** Newest N message texts (newest-first), for semantic ranking + summarization. */
export function listRecentSessionTexts(sessionId: string, limit: number): HistoryRecentEntry[] {
  const capped = Math.min(Math.max(limit, 1), 200)
  const transcript = readSessionTranscript(sessionId)
  return transcript.slice(-capped).reverse()
}

// Upsert by message id (ON CONFLICT DO UPDATE, M1.4): a stopped run persists
// the PARTIAL assistant reply from the accumulator snapshot, so a re-persist
// of the same message id must REPLACE its earlier row (content/role/seq/
// created_at), not be dropped by DO NOTHING. UNIQUE(session_id, seq) makes
// the upsert unambiguous; the seq computed here is max+1 inside this
// transaction, so a replace can only ever collide with the row it targets.
// The session's updated_at moves on every write, which keeps the sidebar's
// updated_at DESC ordering honest.
export function appendMessage(sessionId: string, message: UIMessage): { seq: number } | undefined {
  const now = nowIso()
  return getDrizzle().transaction((tx) => {
    const next = tx
      .select({ value: sql<number>`coalesce(max(${messages.seq}), 0) + 1` })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .get()
    const seq = next?.value ?? 1
    tx.insert(messages)
      .values({
        id: message.id,
        sessionId,
        seq,
        role: message.role,
        content: JSON.stringify(message),
        createdAt: now
      })
      .onConflictDoUpdate({
        target: messages.id,
        set: {
          sessionId: sql`excluded.session_id`,
          seq: sql`excluded.seq`,
          role: sql`excluded.role`,
          content: sql`excluded.content`,
          createdAt: sql`excluded.created_at`
        }
      })
      .run()
    tx.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run()
    return { seq }
  })
}
