import { randomUUID } from 'node:crypto'
import { createApprovalCoalescer, parseCountFromText } from './coalesce'
import { createWorkspaceFs } from './workspace-fs'
import { createInMemorySnapshotStore } from './snapshots'
import type {
  ApprovalRequest,
  ApprovalDecision,
  DocumentCapabilities,
  SnapshotStore,
  ToolExecutionContext
} from './types'

// Per-run ToolExecutionContext builder (docs/03 §5 "ctx"). The factory takes
// a `Sender` interface (the only outbound surface main exposes to the agent
// tree) and a pre-resolved workspace root. This keeps `src/main/agent/`
// zero-Electron by contract (AGENTS.md rule 1): main reads the current
// workspace from its own state and passes it in. Storage repos (M2.5's
// checkpoints), the intelligence client (M4), and the approval dialog
// wiring (M3.2) connect here in their respective phases. M2.4 wires only
// what read-only tools + ask_user need.

export interface Sender {
  emit(channel: string, payload: unknown): void
}

export interface RunContextDeps {
  sender: Sender
  /** Session id this run belongs to — echoed on agent events + the answer wait registry. */
  sessionId: string
  /** Per-send run id (docs/03 §4 envelope). */
  runId: string
  /** Pre-resolved workspace root from main's workspace store. May be '' when
   * the user has not picked one — tools then refuse with a plain-language
   * "pick a workspace first" message via the sandbox resolver. */
  workspaceRoot: string
  /** M2.5 durable sinks, injected by the IPC layer (the agent tree stays
   * storage-free by contract). When absent, the snapshot store stays the
   * in-memory one (tests/harness). */
  onSnapshot?: (entry: {
    toolCallId: string | null
    path: string
    /** Move destination (M2.7) — lands in `checkpoints.dest_path`. */
    destPath?: string | null
    existed: boolean
    /** True when the snapshotted path was a directory (M2.8). */
    isDir: boolean
    content: string | null
    beforeExcerpt?: string | null
  }) => void
  onToolCall?: (entry: {
    toolCallId: string | null
    tool: string
    input: unknown
    output: unknown
    ok: boolean
    error?: string
    riskLevel: number
    riskSource: 'rule_table' | 'llm_fallback' | 'ts_fallback'
    durationMs: number
  }) => void
  /** MVP (MVP_PLAN.md step 2): sidecar-backed document extraction for
   * .pdf/.docx. Injected by the IPC layer; absent in tests/degraded mode —
   * tools then answer honestly for binary formats (docs/05 §6). */
  documents?: DocumentCapabilities
}

export interface PlanStepRef {
  id: string
  description: string
  tool: string
}

export interface RunContextBundle {
  ctx: ToolExecutionContext
  snapshotStore: SnapshotStore & {
    entries: { path: string; content: string | null; existed: boolean; tool: string; ts: number }[]
    clear(): void
  }
  resolveAskUserAnswer: (toolCallId: string, answer: string) => boolean
  rejectAskUserAnswer: (toolCallId: string, reason: string) => boolean
  /** M3.2 approval promise: resolve a pending approval (IPC `approval:respond`). */
  resolveApproval: (approvalId: string, decision: ApprovalDecision) => boolean
  /** Reject all pending approvals (IPC `chat:stop`). Returns count rejected. */
  rejectApprovals: (reason: string) => number
  /** M3.3: the run's plan steps (set by the adapter's plan/created hook) —
   * the coalescer projects batch counts from their descriptions. */
  setPlanSteps: (steps: PlanStepRef[]) => void
  /** Internal: currently-pending approval ids (stop path). */
  _pendingApprovalIds(): string[]
  /** M3.1 plan-start gate: registers the run's pending promise (one per run). */
  requestPlanStart: (stepIds: string[]) => Promise<{ approved: boolean }>
  /** Resolves this run's pending plan-start (IPC `plan:start`). False when none pending. */
  resolvePlanStart: (approved: boolean) => boolean
  /** Rejects this run's pending plan-start (IPC `chat:stop`). False when none pending. */
  rejectPlanStart: (reason: string) => boolean
  /** For tests/inspection: a list of every tool call's awaited approval (M2.4 has none). */
  approvalDecisions: { request: ApprovalRequest; decision: ApprovalDecision }[]
  /** Internal: list of currently-pending ask_user toolCallIds. Used by the
   *  IPC `chat:stop` handler to settle paused ask_user promises on stop. */
  _pendingAnswerIds(): string[]
}

// ask_user is a request/response protocol: main forwards the synthetic
// `tool-output-available` chunk carrying `{ __askUserAwait, toolCallId,
// question, options? }`, the renderer calls `tool:answer`, and main resolves
// the registered promise. The protocol is symmetric: the synthetic output
// chunk is the "request", the bridge is keyed by the AI SDK's toolCallId
// (stable across the pause).
type PendingAnswer = {
  resolve: (answer: string) => void
  reject: (reason: string) => void
}

// Plan-start gate (M3.1, docs/03 §2): the plan-run layer blocks on this
// promise after `plan/created` — execution starts ONLY when the user presses
// Start (or replies "go ahead"; the renderer calls `plan/start` for both).
// Same pending-promise pattern as ask_user above, but ONE per run (a run has
// a single initial plan; revised plans during execution do not re-block),
// keyed by runId in a module map so the IPC `plan:start` handler can settle
// it through the run bundle without reaching into agent internals.
type PendingPlanStart = {
  resolve: (result: { approved: boolean }) => void
  reject: (reason: string) => void
}

const pendingPlanStarts = new Map<string, PendingPlanStart>()

// Small head excerpt for the checkpoints table's before_excerpt column —
// the card preview of the pre-mutation content (full content lives in the
// row's content BLOB; docs/03 §5 excerpt caps).
function excerptHead(content: string): string {
  const lines = content.split(/\r?\n/).slice(0, 8)
  let out = lines.join('\n')
  if (out.length > 600) out = `${out.slice(0, 600)}…`
  if (lines.length === 8) out += '\n…'
  return out
}

export function buildRunContext(deps: RunContextDeps): RunContextBundle {
  // The current workspace may be absent (deps.workspaceRoot === ''). Tools
  // that need a workspace to read from simply refuse with a plain-language
  // error — the sandbox resolver throws with a helpful message and the
  // wrapper returns a refused outcome.
  const workspaceRoot = deps.workspaceRoot
  const fs = createWorkspaceFs(workspaceRoot)
  const snapshotStore = createInMemorySnapshotStore()
  const approvalDecisions: RunContextBundle['approvalDecisions'] = []
  const pendingAnswers = new Map<string, PendingAnswer>()

  // ask_user: write the synthetic pause chunk to the chat:part stream so the
  // renderer's `AskUserCard` can render the question and call back. The chunk
  // is a plain `tool-output-available` (the AI SDK's native shape) with an
  // extra `__agentoAskUser` field; the renderer's chunk validator recognises
  // the field and switches the part into the awaiting-reply UI. The AI SDK
  // is unaware of the extra field — the assistant-ui card maps to
  // `tool-output-available` and reads our payload.
  const requestUserAnswer = (input: {
    toolCallId: string
    question: string
    options?: string[]
  }): Promise<string> => {
    deps.sender.emit('chat:part', {
      sessionId: deps.sessionId,
      part: {
        type: 'tool-output-available',
        toolCallId: input.toolCallId,
        // The output field is what the AI SDK will eventually ship back to
        // the model; for the awaiting-reply state we mark it specially and
        // let the renderer pattern-match the field.
        output: {
          __agentoAskUser: true,
          toolCallId: input.toolCallId,
          question: input.question,
          options: input.options
        }
      }
    })
    return new Promise<string>((resolve, reject) => {
      pendingAnswers.set(input.toolCallId, { resolve, reject })
    })
  }

  const resolveAskUserAnswer = (toolCallId: string, answer: string): boolean => {
    const pending = pendingAnswers.get(toolCallId)
    if (!pending) return false
    pendingAnswers.delete(toolCallId)
    pending.resolve(answer)
    return true
  }

  const rejectAskUserAnswer = (toolCallId: string, reason: string): boolean => {
    const pending = pendingAnswers.get(toolCallId)
    if (!pending) return false
    pendingAnswers.delete(toolCallId)
    pending.reject(reason)
    return true
  }

  // Plan-start gate (M3.1): registered under this run's runId; the IPC layer
  // settles it via resolvePlanStart/rejectPlanStart below. The step ids ride
  // the API for symmetry with the plan/created event (M3.3 coalescing reads
  // them); the gate itself needs only the approve/decline bit today.
  const requestPlanStart = (stepIds: string[]): Promise<{ approved: boolean }> => {
    void stepIds
    return new Promise((resolve, reject) => {
      pendingPlanStarts.set(deps.runId, { resolve, reject })
    })
  }

  const resolvePlanStart = (approved: boolean): boolean => {
    const pending = pendingPlanStarts.get(deps.runId)
    if (!pending) return false
    pendingPlanStarts.delete(deps.runId)
    pending.resolve({ approved })
    return true
  }

  const rejectPlanStart = (reason: string): boolean => {
    const pending = pendingPlanStarts.get(deps.runId)
    if (!pending) return false
    pendingPlanStarts.delete(deps.runId)
    pending.reject(reason)
    return true
  }

  // M3.2 real ApprovalDialog promise (mirrors the ask_user pending map):
  // register under an approvalId, emit `approval/requested` on the sender,
  // and await the IPC `approval:respond` resolution. M3.3 coalescing wraps
  // this hook: the registry keeps calling per tool call, same-tool calls
  // share one group/decision, and every buffered call re-emits the SAME
  // approvalId with the running count — the one dialog shows the batch size
  // live ("I'm about to touch N items", docs/04 §3.2).
  type PendingApproval = {
    resolve: (decision: ApprovalDecision) => void
    reject: (reason: unknown) => void
    request: ApprovalRequest
  }
  const pendingApprovals = new Map<string, PendingApproval>()

  function emitApprovalRequested(
    approvalId: string,
    request: ApprovalRequest,
    count: number | undefined
  ): void {
    // Best-effort event for the dialog; the promise is the contract and
    // works even when no window listens (tests).
    try {
      deps.sender.emit('agent:event', {
        type: 'approval/requested',
        sessionId: deps.sessionId,
        runId: deps.runId,
        ts: Date.now(),
        seq: 0,
        approvalId,
        title: request.title,
        body:
          count !== undefined && count > 1
            ? `${request.reason} (batch of ${count})`
            : request.reason,
        riskLevel: request.riskLevel,
        ...(count !== undefined && count > 1 ? { count } : {}),
        allowOptions: ['approve', 'skip', 'cancel'] as const
      })
    } catch {
      // emit failures never break the gate — the dialog may simply be absent
    }
  }

  const requestOneApproval = async (
    request: ApprovalRequest,
    approvalId: string
  ): Promise<ApprovalDecision> => {
    const decision = await new Promise<ApprovalDecision>((resolve, reject) => {
      pendingApprovals.set(approvalId, { resolve, reject, request })
    })
    approvalDecisions.push({ request, decision })
    openApprovalIdByTool.delete(request.tool)
    try {
      deps.sender.emit('agent:event', {
        type: 'approval/resolved',
        sessionId: deps.sessionId,
        runId: deps.runId,
        ts: Date.now(),
        seq: 0,
        approvalId,
        decision
      })
    } catch {
      // same doctrine — resolution is recorded above regardless
    }
    return decision
  }

  // M3.3 projection sources (docs/03 §5): the run's plan steps (count parsed
  // from the matching step's description, e.g. "move 42 files") and the most
  // recent read enumeration (list_dir file count / search match count).
  let planSteps: PlanStepRef[] = []
  let lastEnumeration: number | null = null

  const setPlanSteps = (steps: PlanStepRef[]): void => {
    planSteps = steps
  }

  // Normalized tool-name match (the model writes "move", "move_path",
  // "make_dir" interchangeably): equal after stripping non-letters, or one
  // side a prefix of the other.
  function stepMatchesTool(stepTool: string, tool: string): boolean {
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '')
    const a = norm(stepTool)
    const b = norm(tool)
    return a.length > 0 && b.length > 0 && (a === b || a.startsWith(b) || b.startsWith(a))
  }

  function projectBatchCount(request: ApprovalRequest): number | null {
    for (const step of planSteps) {
      if (!stepMatchesTool(step.tool, request.tool)) continue
      const n = parseCountFromText(step.description)
      if (n !== null) return n
    }
    return lastEnumeration
  }

  // Open generations (approvalId per tool + generation): buffered calls and
  // the 25% re-ask re-emit the SAME approvalId with the display count — the
  // renderer replaces by approvalId so one dialog shows the batch live. A
  // re-ask generation gets a FRESH approvalId (fresh dialog, real count).
  const openApprovalIdByTool = new Map<string, { approvalId: string; generation: number }>()

  const coalescer = createApprovalCoalescer(
    (request: ApprovalRequest, displayCount: number | null) => {
      const approvalId = randomUUID()
      openApprovalIdByTool.set(request.tool, {
        approvalId,
        generation: coalescer.generation(request.tool)
      })
      emitApprovalRequested(approvalId, request, displayCount ?? undefined)
      return requestOneApproval(request, approvalId)
    },
    {
      onBuffered: (tool: string, displayCount: number | null, generation: number) => {
        // Same dialog, live count: the renderer replaces by approvalId. A
        // re-ask generation is emitted by requestOne above (fresh id), so
        // only re-emit when the generation still matches the open one.
        const open = openApprovalIdByTool.get(tool)
        if (!open || open.generation !== generation) return
        const pending = pendingApprovals.get(open.approvalId)
        if (!pending) return
        emitApprovalRequested(open.approvalId, pending.request, displayCount ?? undefined)
      }
    }
  )

  const requestApproval = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    const decision = await coalescer.request(request, projectBatchCount(request))
    // Buffered/post-decision calls share the group promise without touching
    // the pending map — record each caller's own audit row (M2.5 sink reads
    // this log per tool call).
    if (!approvalDecisions.some((d) => d.request === request)) {
      approvalDecisions.push({ request, decision })
    }
    return decision
  }

  const resolveApproval = (approvalId: string, decision: ApprovalDecision): boolean => {
    const pending = pendingApprovals.get(approvalId)
    if (!pending) return false
    pendingApprovals.delete(approvalId)
    pending.resolve(decision)
    return true
  }

  const rejectApprovals = (reason: string): number => {
    const ids = Array.from(pendingApprovals.keys())
    for (const id of ids) {
      const pending = pendingApprovals.get(id)
      if (pending) {
        pendingApprovals.delete(id)
        pending.reject(new Error(reason))
      }
    }
    return ids.length
  }

  const ctx: ToolExecutionContext = {
    workspaceRoot,
    // M3.3 projection feed: read tools report their enumeration size here;
    // the next approval group projects from it when the plan states none.
    noteEnumeration: (fileCount: number) => {
      if (Number.isSafeInteger(fileCount) && fileCount >= 0) lastEnumeration = fileCount
    },
    // The current settings is read once on run start; tool execution never
    // re-reads it. (Settings that affect risk classification, e.g. a future
    // "trust this tool for the session" toggle, are wired in M3.2.)
    exists: (path) => fs.existsSync(path),
    snapshot: (path, meta) => {
      // A directory target has no file content to restore — the checkpoint
      // records existed + path only (undo deletes the created dir).
      const isDir = fs.isDirectory(path)
      const entry = {
        path,
        content: !isDir && fs.existsSync(path) ? fs.readFileSync(path) : null,
        existed: fs.existsSync(path),
        isDir,
        tool: meta?.tool ?? 'agent',
        destPath: meta?.destPath ?? null,
        ts: Date.now()
      }
      snapshotStore.remember(entry)
      // Durable write-through (M2.5): the IPC layer's sink lands the
      // checkpoints table row. Bookkeeping must never break a run — a
      // storage failure is logged main-side and the mutation proceeds
      // (the in-memory entry above still holds the snapshot for this run).
      if (deps.onSnapshot) {
        try {
          deps.onSnapshot({
            toolCallId: meta?.toolCallId ?? null,
            path,
            destPath: entry.destPath,
            existed: entry.existed,
            isDir: entry.isDir,
            content: entry.content,
            beforeExcerpt:
              entry.existed && entry.content !== null ? excerptHead(entry.content) : null
          })
        } catch (error) {
          console.error('[checkpoints] durable snapshot failed:', error)
        }
      }
    },
    requestApproval,
    requestUserAnswer,
    fs,
    documents: deps.documents
  }

  return {
    ctx,
    snapshotStore,
    resolveAskUserAnswer,
    rejectAskUserAnswer,
    resolveApproval,
    rejectApprovals,
    setPlanSteps,
    requestPlanStart,
    resolvePlanStart,
    rejectPlanStart,
    approvalDecisions,
    _pendingApprovalIds: () => Array.from(pendingApprovals.keys()),
    // Internal: lets the IPC `chat:stop` handler reject any pending ask_user
    // promises so a stop on a paused ask_user run actually unwinds the AI
    // SDK step (otherwise the awaiting promise would leak forever).
    _pendingAnswerIds: () => Array.from(pendingAnswers.keys())
  }
}

// Re-exported for any future consumer that needs a fresh runId (e.g. tests).
export function newRunId(): string {
  return randomUUID()
}
