import { randomUUID } from 'node:crypto'
import { createWorkspaceFs } from './workspace-fs'
import { createInMemorySnapshotStore } from './snapshots'
import type {
  ApprovalRequest,
  ApprovalDecision,
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
   *  the user has not picked one — tools then refuse with a plain-language
   *  "pick a workspace first" message via the sandbox resolver. */
  workspaceRoot: string
}

export interface RunContextBundle {
  ctx: ToolExecutionContext
  snapshotStore: SnapshotStore & {
    entries: { path: string; content: string | null; existed: boolean; tool: string; ts: number }[]
    clear(): void
  }
  resolveAskUserAnswer: (toolCallId: string, answer: string) => boolean
  rejectAskUserAnswer: (toolCallId: string, reason: string) => boolean
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

  // M2.4 has no risk ≥ 2 tools (everything is read-only or ask_user), so the
  // approval hook is a recorded no-op. M3.2 replaces this with the real
  // ApprovalDialog promise.
  const requestApproval = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    const decision: ApprovalDecision = 'approve'
    approvalDecisions.push({ request, decision })
    return decision
  }

  const ctx: ToolExecutionContext = {
    workspaceRoot,
    // The current settings is read once on run start; tool execution never
    // re-reads it. (Settings that affect risk classification, e.g. a future
    // "trust this tool for the session" toggle, are wired in M3.2.)
    exists: (path) => fs.existsSync(path),
    snapshot: (path) => {
      const entry = {
        path,
        content: fs.existsSync(path) ? fs.readFileSync(path) : null,
        existed: fs.existsSync(path),
        tool: 'agent',
        ts: Date.now()
      }
      snapshotStore.remember(entry)
    },
    requestApproval,
    requestUserAnswer,
    fs
  }

  return {
    ctx,
    snapshotStore,
    resolveAskUserAnswer,
    rejectAskUserAnswer,
    approvalDecisions,
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
