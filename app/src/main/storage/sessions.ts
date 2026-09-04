import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { getDrizzle } from './db'
import { messages, sessions } from './schema'

// Session repository — the only code that touches the sessions/messages tables
// (docs/02 §2.5, docs/03-agent-core.md §8). Plain Node, no Electron imports.

export type SessionRow = typeof sessions.$inferSelect

const DEFAULT_TITLE = 'New task' // schema default, docs/03 §8

// workspace_path is NOT NULL per docs/03 §8; until the workspace picker lands
// (M2.2) every session stores the empty-string placeholder (M1.3 Devlog).
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
}): SessionRow {
  const now = nowIso()
  return getDrizzle()
    .insert(sessions)
    .values({
      id: randomUUID(),
      title: input.title?.trim() ? input.title.trim() : DEFAULT_TITLE,
      workspacePath: WORKSPACE_PLACEHOLDER,
      provider: input.provider ?? null,
      model: input.model ?? null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .get()
}

export function listSessions(): SessionRow[] {
  return getDrizzle().select().from(sessions).orderBy(desc(sessions.updatedAt)).all()
}

export function getSession(id: string): SessionRow | undefined {
  return getDrizzle().select().from(sessions).where(eq(sessions.id, id)).get()
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

// Idempotent by message id (ON CONFLICT DO NOTHING): a regenerate or a resend
// of history after a restart must not duplicate rows. The session's
// updated_at only moves when a row was actually inserted, which is what keeps
// the sidebar's updated_at DESC ordering honest.
export function appendMessage(sessionId: string, message: UIMessage): { seq: number } | undefined {
  const now = nowIso()
  return getDrizzle().transaction((tx) => {
    const next = tx
      .select({ value: sql<number>`coalesce(max(${messages.seq}), 0) + 1` })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .get()
    const seq = next?.value ?? 1
    const result = tx
      .insert(messages)
      .values({
        id: message.id,
        sessionId,
        seq,
        role: message.role,
        content: JSON.stringify(message),
        createdAt: now
      })
      .onConflictDoNothing()
      .run()
    if (result.changes === 0) return undefined
    tx.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run()
    return { seq }
  })
}
