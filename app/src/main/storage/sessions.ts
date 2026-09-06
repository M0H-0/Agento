import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { getDrizzle } from './db'
import { messages, sessions } from './schema'

// Session repository — the only code that touches the sessions/messages tables
// (docs/02 §2.5, docs/03-agent-core.md §8). Plain Node, no Electron imports.

export interface SessionRow {
  id: string
  title: string
  workspacePath: string
  mode: string
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
}): SessionRow {
  const now = nowIso()
  return getDrizzle()
    .insert(sessions)
    .values({
      id: randomUUID(),
      title: input.title?.trim() ? input.title.trim() : DEFAULT_TITLE,
      workspacePath: input.workspacePath ?? WORKSPACE_PLACEHOLDER,
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
