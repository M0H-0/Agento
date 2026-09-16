import type { z } from 'zod'

// Tool registry contracts (docs/03-agent-core.md §5, docs/06-security-and-permissions.md).
// THIS FILE IS PLAIN NODE — no Electron imports (AGENTS.md rule 1): the agent
// tree receives an injected context per run and stays unit-testable.

// Access mode drives the sandbox policy (docs/06 §4.3): reads may follow an
// outside-pointing symlink/junction; writes/moves/deletes never may.
export type ToolAccess = 'read' | 'write'

export interface RiskClassification {
  // Rule-table levels (docs/06 §2): 0 safe · 1 reversible · 2 overwriting ·
  // 3 destructive. The wrapper blocks on the approval hook for level ≥ 2.
  level: 0 | 1 | 2 | 3
  reason: string
}

export interface ToolDescriptor {
  /** Plain-language card title (docs/04 §3.1) — never a tool name or JSON. */
  title: string
  group: string
}

export type ApprovalDecision = 'approve' | 'skip' | 'cancel'

export interface ApprovalRequest {
  tool: string
  title: string
  /** Coalescing to a batch count arrives with the loop/plan steps (M3). */
  riskLevel: 2 | 3
  reason: string
  paths: string[]
  /** Authoritative plan-step id when the caller knows it (step binding). */
  stepId?: string
}

// MVP read-only capability injections (MVP_PLAN.md). All optional — absent in
// tests and degraded mode; tools then fall back to direct text reads and
// answer honestly when a capability is missing (docs/05 §6 degraded doctrine).
export interface DocumentCapabilities {
  /** Extract plain text from a document (absolute, sandbox-resolved path).
   * Throws a plain-language Error on failure — tool bodies catch and answer
   * with ok:false (the wrapper never catches execute exceptions). */
  extract(path: string): Promise<{ text: string; truncated: boolean }>
  /** Anchor-text edit of a `.docx`/`.pptx`/`.xlsx` file (absolute,
   * sandbox-resolved path). Returns before/after excerpts for the card.
   * Throws plain-language. Optional like every other capability — absent
   * in tests/degraded mode. */
  edit?: (
    path: string,
    edits: { anchor: string; replacement: string }[]
  ) => Promise<{ beforeExcerpt: string; afterExcerpt: string; editsApplied: number }>
  /** Build a `.docx`/`.pptx`/`.xlsx` file from a title plus plain-text items
   * (absolute, sandbox-resolved path). Returns the card excerpt + byte size.
   * Throws plain-language. Optional — absent in tests/degraded mode. */
  create?: (
    path: string,
    title: string,
    items: string[]
  ) => Promise<{ afterExcerpt: string; sizeBytes: number }>
}

/** PDF export capability (docs/02 §2.6): render HTML to an absolute,
 * sandbox-resolved path via hidden-window printToPDF. Injected by the IPC
 * layer; absent in tests/degraded mode — the tool then answers honestly. */
export interface PdfCapabilities {
  exportHtml(outPath: string, html: string): Promise<{ sizeBytes: number }>
}

export interface LlmCapabilities {
  /** One-shot completion over the run's configured provider/model (MVP:
   * summarize_document). Throws a plain-language Error on failure. */
  complete(prompt: string): Promise<string>
}

export interface VisionCapabilities {
  /** Describe an image with the run's configured vision model (MVP: images in
   * read_document). Runs in main only — keys never cross to the sidecar.
   * Throws a plain-language Error on failure (e.g. a text-only model). */
  describeImage(image: { data: Buffer; mimeType: string }): Promise<string>
}

export interface TavilySearchHit {
  title: string
  url: string
  snippet: string
}

export interface WebCapabilities {
  /** HTTP GET returning the raw body (capped) — MVP: web_fetch. Throws a
   * plain-language Error on network failure. */
  fetch(url: string): Promise<{ status: number; body: string; contentType: string }>
  /** Keyed Tavily search (injected by the IPC layer only when a Tavily key
   * is stored in Settings — chat.ts resolves it per run via
   * resolveProviderKey('tavily')). Throws on any failure (bad key, no
   * credits, rate limit, network) so the web_search tool falls back to the
   * keyless path. Absent when no key is stored. */
  tavily?: {
    search(query: string, maxResults: number): Promise<TavilySearchHit[]>
  }
}

export interface SemanticCapabilities {
  /** On-device semantic search over the workspace (MVP standout feature):
   * indexes readable files into cached embeddings and ranks a query. Throws
   * a plain-language Error on failure. */
  search(query: string, topK?: number): Promise<{ path: string; snippet: string; score: number }[]>
}

export interface HistoryMatch {
  seq: number
  role: string
  excerpt: string
}

export interface HistoryRecent {
  seq: number
  role: string
  text: string
}

// L1 session recall (same-session only): keyword search + recent listing over
// the session's persisted transcript. Implemented in the IPC layer over the
// storage repos (the agent tree stays storage-free); absent in tests unless
// the harness injects a fake.
export interface HistoryCapabilities {
  /** Case-insensitive substring search over user+assistant text parts. */
  search(query: string, limit?: number): Promise<HistoryMatch[]>
  /** Newest N messages' text (newest-first), for semantic ranking + summary. */
  listRecent(limit: number): Promise<HistoryRecent[]>
}

export interface EmbedCapabilities {
  /** On-device sentence embeddings (fastembed via the sidecar). Throws a
   * plain-language Error when the model is unavailable — callers fall back. */
  embedTexts(texts: string[]): Promise<number[][]>
}

// The ONLY way a tool reaches the disk. Tools never import node:fs — the
// registry wraps every mutation behind this facade, which itself refuses any
// path outside the workspace root (defense in depth on top of the sandbox's
// pre-resolved paths). All writes are temp-file + atomic rename on the same
// volume (docs/06 §4.5).
export interface WorkspaceFs {
  existsSync(path: string): boolean
  /** Throws if path escapes the workspace (refusal is the wrapper's job upstream, this is the backstop). */
  readFileSync(path: string): string
  /** Raw bytes (binary-safe); same containment + revalidation as readFileSync. */
  readFileBytes(path: string): Buffer
  /** Atomic temp+rename; returns the byte size written. */
  writeFileAtomic(path: string, content: string): number
  /** Binary-safe atomic write; returns the byte size written. */
  writeFileBytes(path: string, data: Buffer): number
  /** True when the path is a directory (and inside the workspace). */
  isDirectory(path: string): boolean
  /** Create a directory (recursive), inside the workspace only. */
  mkdir(path: string): void
  /** Move/rename a file or folder inside the workspace (overwrites an
   * existing destination — the wrapper snapshots both sides first).
   * Refuses with plain language when the source is missing. */
  movePath(from: string, to: string): void
  /** Byte-exact copy of a single file inside the workspace (overwrites an
   * existing destination). Refuses directories with plain language. */
  copyPath(from: string, to: string): number
  /** Delete a file or an empty folder inside the workspace. Refuses a
   * non-empty folder with plain language (recursive delete is out of scope). */
  deletePath(path: string): void
  /** Directory entries (top-level only) with a small type tag. Refuses outside the workspace. */
  readdir(path: string): { name: string; type: 'file' | 'directory' }[]
  /** Recursively list file paths under a directory, capped at `limit`. Excludes directories themselves. */
  walkFiles(root: string, limit: number): string[]
}

// Permission policy (M6.3 Settings → Permissions, docs/04 §3.7): optional so
// existing harness/test contexts keep today's behavior. risk1 'ask' routes
// reversible creates through the approval dialog; risk2 'auto' runs overwrites
// silently. Risk 3 always blocks — no such setting exists (docs/06 §2).
export interface ApprovalPolicy {
  askRisk1: boolean
  autoRisk2: boolean
}

// Injected per run (docs/03 §5 "ctx"): workspace root, existence probe for the
// risk stage, the mandatory snapshot hook, the approval hook, the guarded
// fs facade, and the ask_user pause. Storage repos / intelligence client /
// event sender connect here in M2.5/M3.
export interface ToolExecutionContext {
  workspaceRoot: string
  approvalPolicy?: ApprovalPolicy
  /** AI SDK v5's toolCallId for the current call (used by ask_user; the registry thread sets it). */
  activeToolCallId?: string
  /** Disk probe for risk classification (rule-table floor; docs/06 §2). */
  exists(path: string): boolean
  /** Mandatory snapshot before a risk ≥ 1 mutation (docs/03 §7). The meta
   * carries the wrapper's per-call context (tool name + AI SDK toolCallId)
   * so the durable write-through (M2.5) can key the checkpoints row.
   * `destPath` carries a move's destination (M2.7): the wrapper sets it from
   * the tool's `checkpointDestPath`, and the durable row stores it in
   * `checkpoints.dest_path` so undo restores the original name. */
  snapshot(path: string, meta?: { tool?: string; toolCallId?: string; destPath?: string }): void
  /** Blocks on the user's decision for risk ≥ 2 (docs/06 §3); the caller wires the dialog. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
  /**
   * One-shot ask_user grant (S3-005 — one confirmation per action): when the
   * model routes via ask_user ("May I edit todo.txt?") and the user answers
   * affirmatively, ask_user sets `granted = true`. The registry's approval
   * stage consumes it (reset to false) and runs the next gated call WITHOUT
   * a second dialog. Negative/ambiguous answers grant nothing (fail-closed —
   * the dialog still appears if the model proceeds). Shared by reference
   * across the run's ctx spreads; absent in contexts that never ask.
   */
  askApprovalGrant?: { granted: boolean }
  /**
   * M3.3 coalescing projection (docs/03 §5): read-only tools report the size
   * of the enumeration they just produced (list_dir = file entries,
   * search_files = matches) plus the enumerated directory (absolute,
   * sandbox-resolved). The approval hook projects the scoped count when the
   * gated paths fall under that directory — S3-001: an Act-mode
   * list-then-move batch shows its size on the FIRST dialog instead of a
   * singular headline. The scope also kills phantoms: an unrelated earlier
   * listing never inflates a later approval outside its directory.
   * Optional so test/harness contexts need not provide it.
   */
  noteEnumeration?: (fileCount: number, scopePath?: string) => void
  /**
   * Blocks until the user replies to an ask_user question. The bridge is the
   * synthetic `tool-output-available` chunk over `chat:part` carrying
   * `{ __askUserAwait: true, toolCallId, question, options? }` (M2.4 design);
   * the renderer calls `window.agento.toolAnswer({ toolCallId, answer })` and
   * main resolves this promise with the answer. ask_user never gates on
   * approval — it's risk 0 by docs/03 §5.
   */
  requestUserAnswer(input: {
    toolCallId: string
    question: string
    options?: string[]
  }): Promise<string>
  fs: WorkspaceFs
  /** MVP: sidecar-backed extraction for .pdf/.docx/.pptx/.xlsx (injected by the IPC layer). */
  documents?: DocumentCapabilities
  /** PDF export via hidden-window printToPDF (IPC-injected; absent in tests). */
  pdf?: PdfCapabilities
  /** MVP: one-shot LLM completion over the run's provider/model (IPC-injected). */
  llm?: LlmCapabilities
  /** MVP: vision-model description of image files for read_document (IPC-injected). */
  vision?: VisionCapabilities
  /** MVP: plain HTTP GET for web_fetch (IPC-injected, Node global fetch). */
  web?: WebCapabilities
  /** MVP: on-device semantic search (IPC-injected, fastembed via sidecar). */
  semantic?: SemanticCapabilities
  /** L1 session recall: keyword search + recent listing over this session's
   * transcript (IPC-injected from the storage repos; absent in tests). */
  history?: HistoryCapabilities
  /** L1 semantic recall: raw embedder for ranking history candidates
   * (IPC-injected; absent when the sidecar/model is down — tools fall back). */
  embed?: EmbedCapabilities
}

export interface ToolResult<TOutput = unknown> {
  ok: boolean
  output: TOutput
  error?: string
  /** True when the returned output was truncated (docs/03 §5 — large outputs never reach the model). */
  truncated?: boolean
}

// Wrapper outcome — the value the tool loop (M2.4 slot) consumes, plus the
// approval decision so a skip/cancel propagates as a normal, honest non-execution.
export type ToolCallStatus = 'executed' | 'skipped' | 'cancelled' | 'refused'

export interface ToolCallOutcome {
  ok: boolean
  status: ToolCallStatus
  tool: string
  /** Plain-language message for the card / loop. */
  message: string
  result?: unknown
  error?: string
}

// One definition drives the LLM schema, the UI card, the risk gate, and the
// logger (docs/03 §5). `pathFields` is the sandbox's contract: the wrapper
// pre-resolves these input keys against the workspace and the tool body only
// ever sees resolved paths — model paths are relative intent, never taken
// literally (docs/06 §4 floor).
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string
  /** LLM-facing description. */
  description: string
  access: ToolAccess
  /** Single source of truth for the LLM-facing JSON schema (docs/03 §5). */
  inputSchema: z.ZodType<TInput>
  pathFields: (keyof TInput)[]
  /** Optional snapshot-subset override (M2.8 review fix): by default the
   *  wrapper snapshots every pathField before execute. A tool whose pathField
   *  is NOT actually mutated (copy_path's `from` — the source is only read)
   *  declares ONLY the fields it does mutate, so undo of its checkpoint can
   *  never rewrite a path the mutation never touched. Returned fields are
   *  snapshotted in the returned order (the first lands any checkpointDestPath). */
  snapshotFields?(input: TInput): (keyof TInput)[]
  /** Rule-table classification; may be sync per the docs/03 §5 sketch. */
  risk(input: TInput, ctx: ToolExecutionContext): RiskClassification
  describe(input: TInput): ToolDescriptor
  execute(input: TInput, ctx: ToolExecutionContext): Promise<ToolResult<TOutput>>
  /** Optional move destination (M2.7): when defined, the wrapper stores the
   * returned (already sandbox-resolved) path as `dest_path` on the FIRST
   * path field's checkpoint row, so undo restores the original name
   * (docs/03 §8). Only move_path defines this. */
  checkpointDestPath?(input: TInput): string | null
}

// Snapshot store — the checkpoint durability question (SQLite checkpoints
// table, docs/03 §8) is an M2.5 concern; M2.1 proves the wrapper stage with an
// in-memory store.
export interface SnapshotEntry {
  path: string
  content: string | null
  existed: boolean
  tool: string
  ts: number
  /** Move destination (M2.7) — mirrors `checkpoints.dest_path`. */
  destPath?: string | null
  /** True when the snapshotted path was a directory (M2.8). */
  isDir?: boolean
}

export interface SnapshotStore {
  remember(entry: SnapshotEntry): void
}
