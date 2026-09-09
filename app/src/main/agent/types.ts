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
  /** Atomic temp+rename; returns the byte size written. */
  writeFileAtomic(path: string, content: string): number
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

// Injected per run (docs/03 §5 "ctx"): workspace root, existence probe for the
// risk stage, the mandatory snapshot hook, the approval hook, the guarded
// fs facade, and the ask_user pause. Storage repos / intelligence client /
// event sender connect here in M2.5/M3.
export interface ToolExecutionContext {
  workspaceRoot: string
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
   * M3.3 coalescing projection (docs/03 §5): read-only tools report the size
   * of the enumeration they just produced (list_dir = file entries,
   * search_files = matches). The approval hook uses the most recent value as
   * the batch-count projection when the plan step's description states none.
   * Optional so test/harness contexts need not provide it.
   */
  noteEnumeration?: (fileCount: number) => void
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
