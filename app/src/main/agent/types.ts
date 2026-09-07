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
   * so the durable write-through (M2.5) can key the checkpoints row. */
  snapshot(path: string, meta?: { tool?: string; toolCallId?: string }): void
  /** Blocks on the user's decision for risk ≥ 2 (docs/06 §3); the caller wires the dialog. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
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
  /** Rule-table classification; may be sync per the docs/03 §5 sketch. */
  risk(input: TInput, ctx: ToolExecutionContext): RiskClassification
  describe(input: TInput): ToolDescriptor
  execute(input: TInput, ctx: ToolExecutionContext): Promise<ToolResult<TOutput>>
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
}

export interface SnapshotStore {
  remember(entry: SnapshotEntry): void
}
