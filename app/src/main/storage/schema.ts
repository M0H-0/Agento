import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Storage schema of record (docs/03-agent-core.md §8). M1.3 created ONLY
// sessions + messages; M1.5 adds usage_events. tool_calls/plan_steps/
// checkpoints arrive with M2.x as further drizzle-kit migrations. Plain Node —
// no Electron imports (AGENTS.md rule 1); timestamps are ISO-8601 TEXT written
// by the repositories, not SQLite defaults.

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default('New task'),
  // 1 once the user renames the chat themselves (sidebar rename): the
  // background auto-title (docs/03 §4) checks this and never overwrites it.
  titleRenamed: integer('title_renamed').notNull().default(0),
  // NOT NULL per docs/03 §8 — the workspace picker lands in M2.2; repositories
  // store an empty-string placeholder until then.
  workspacePath: text('workspace_path').notNull(),
  mode: text('mode').notNull().default('act'),
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

// Token usage per run (migration 0002, M1.5; docs/03 §8): written at the chat
// settle point only when the run's usage resolved — input_tokens/output_tokens
// stay nullable per docs/03 §8 because a provider may omit a field.
export const usageEvents = sqliteTable('usage_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: text('created_at').notNull()
})

// Tool-call audit trail (migration 0003, M2.5; docs/03 §8): one row per tool
// execution through the wrapper. Append-only; output_json carries the
// (already-truncated) wrapper output.
export const toolCalls = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  // AI SDK v5 toolCallId when available (ask_user threading); null for
  // harness runs that pass none.
  toolCallId: text('tool_call_id'),
  tool: text('tool').notNull(),
  inputJson: text('input_json').notNull(),
  outputJson: text('output_json'),
  ok: integer('ok'),
  error: text('error'),
  riskLevel: integer('risk_level'),
  riskSource: text('risk_source'), // rule_table (M2.5) | llm_fallback | ts_fallback (M4)
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull()
})

// Plan steps (docs/03 §8, migration 0005 — M3.1): one row per step of every
// emitted plan version. Append-style per plan; a revised plan is a new
// plan_version. `status` mirrors the plan/step_updated event vocabulary.
export const planSteps = sqliteTable('plan_steps', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  planVersion: integer('plan_version').notNull().default(1),
  position: integer('position').notNull(),
  // The model-supplied wire step id (migration 0008): step-status tracing
  // (plan/step_updated) keys by it, so the Act go-ahead handoff must return
  // the SAME ids the plan/created event carried — synthesized per-position
  // ids broke the panel counter (live: "0 of 43 steps done" with 6 traced
  // outcomes). NULL for rows written before the migration (read falls back
  // to the positional synthesis).
  wireId: text('wire_id'),
  description: text('description').notNull(),
  tool: text('tool'),
  riskLevel: integer('risk_level').default(0),
  status: text('status').notNull().default('pending'), // pending|in_progress|done|failed|awaiting_approval|skipped
  verificationScore: real('verification_score'),
  verified: integer('verified'),
  missedSegmentsJson: text('missed_segments_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

// Append-only checkpoint log (migration 0003, M2.5; docs/03 §7-8): every
// risk >= 1 mutation lands a row BEFORE the tool executes — a mutation
// without a checkpoint is unrepresentable. Undo (M2.8) writes new rows;
// `revertedAt` marks undone entries. The full pre-mutation content lives in
// the `content` BLOB (capped by the repository per docs/03 §7 — 10 MB/file,
// 200 MB/session with evict-oldest).
export const checkpoints = sqliteTable('checkpoints', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  toolCallId: text('tool_call_id'),
  path: text('path').notNull(),
  // set by move_path (M2.7): undo restores the original name.
  destPath: text('dest_path'),
  // 0 = created by agent (undo deletes); 1 = existed (undo restores content).
  existed: integer('existed').notNull(),
  // 1 = the snapshotted path was a directory (M2.8): directory rows carry no
  // content (nothing to restore byte-wise — undo re-creates or removes the
  // dir), and this flag is what distinguishes them from evicted file rows
  // (undo of an evicted file refuses honestly instead of mkdir-ing a folder
  // where a file was). Survives eviction (evict-oldest never touches it).
  isDir: integer('is_dir').notNull().default(0),
  // Full pre-mutation content (SQLite TEXT; docs/03 §8 declares BLOB — the
  // column stores utf-8 text either way and drizzle's text mode round-trips
  // strings cleanly).
  content: text('content'),
  size: integer('size'),
  sha256: text('sha256'),
  beforeExcerpt: text('before_excerpt'),
  afterExcerpt: text('after_excerpt'),
  revertedAt: text('reverted_at'),
  createdAt: text('created_at').notNull()
})
