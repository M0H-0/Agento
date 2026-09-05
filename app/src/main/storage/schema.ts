import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Storage schema of record (docs/03-agent-core.md §8). M1.3 creates ONLY
// sessions + messages; tool_calls/plan_steps/checkpoints/usage_events arrive
// with M1.5/M2.x as further drizzle-kit migrations. Plain Node — no Electron
// imports (AGENTS.md rule 1); timestamps are ISO-8601 TEXT written by the
// repositories, not SQLite defaults.

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default('New task'),
  // NOT NULL per docs/03 §8 — the workspace picker lands in M2.2; repositories
  // store an empty-string placeholder until then.
  workspacePath: text('workspace_path').notNull(),
  mode: text('mode').notNull().default('auto'),
  status: text('status').notNull().default('idle'), // idle|running|error
  provider: text('provider'),
  model: text('model'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    seq: integer('seq').notNull(),
    role: text('role').notNull(), // user|assistant|system_notice
    // The full serialized UIMessage JSON (role/seq/order are the indexed
    // columns; part fidelity lives here) — see the M1.3 Devlog note.
    content: text('content').notNull(),
    intent: text('intent'),
    confidence: real('confidence'),
    createdAt: text('created_at').notNull()
  },
  // UNIQUE(session_id, seq) (migration 0001, M1.4): seq is the per-session
  // playback order, so the pair must be unique — it also makes the id upsert
  // in appendMessage unambiguous when a stopped run re-persists a partial.
  (table) => [uniqueIndex('messages_session_seq_unique').on(table.sessionId, table.seq)]
)
