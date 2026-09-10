import { ipcMain } from 'electron'
import { app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { LanguageModel, UIMessage, UIMessageChunk } from 'ai'
import { generateText } from 'ai'
import { assertPublicHttpUrl } from '../agent/web-fetch-guard'
import { generateSessionTitle } from '../agent/title'
import { buildLanguageModel, providerRequiresKey } from '../providers'
import {
  getPermissionDefaults,
  getSettings,
  resolveActiveBaseUrl,
  resolveProviderKey
} from '../settings'
import {
  appendMessage,
  getSession,
  normalizeSessionMode,
  setSessionTitle
} from '../storage/sessions'
import { insertUsage } from '../storage/usage'
import { getLatestPlan, nextPlanVersion, recordPlanSteps } from '../storage/plan-steps'
import {
  recordCheckpoint,
  recordToolCall,
  setCheckpointAfterExcerpts
} from '../storage/checkpoints'
import { getCurrentWorkspace } from '../workspaces'
import { getSidecarStatus, sidecarFetch } from '../sidecar'
import {
  askUserTool,
  buildRunContext,
  cachePathForWorkspace,
  copyPathTool,
  createDirTool,
  createToolRegistry,
  createWorkspaceFs,
  deletePathTool,
  editExcerpts,
  editFileTool,
  emitPlanTool,
  excerptOf,
  hasMutatingActions,
  listDirTool,
  movePathTool,
  newRunId,
  readFileTool,
  readDocumentTool,
  isGoAheadMessage,
  runActTurn,
  runPlanModeTurn,
  searchFilesTool,
  semanticSearch,
  semanticSearchTool,
  summarizeDocumentTool,
  verifyStep,
  webFetchTool,
  writeFileTool
} from '../agent'
import type { PlanStep, RunContextBundle, ToolRegistry } from '../agent'
import {
  emitApprovalRequested,
  emitApprovalResolved,
  emitPlanCreated,
  emitPlanStepUpdated,
  emitSessionTitleUpdated,
  emitUsageEvent,
  emitVerificationFinished
} from './agent-events'
import { buildSystemPrompt } from './system-prompt'
import { classifyIntent, classifySafety, embedTexts, extractDocument } from './sidecar-calls'

// The run loop itself (streamText calls, stream forwarding, provider error
// classification, step guard) lives in src/main/agent/plan-run.ts — this
// module is the thin IPC adapter: it builds the deps (Electron sender,
// storage sinks), routes on the session's persisted Plan/Act mode, calls the
// loop, and owns the settle point (persistence + terminal parts + usage).

type ToolOutcomeEntry = Parameters<ToolRegistry['run']>[0]['onOutcome']

interface ChatSendPayload {
  sessionId: string
  messages: UIMessage[]
}

interface ChatStopPayload {
  sessionId: string
}

interface ToolAnswerPayload {
  toolCallId: string
  answer: string
}

interface PlanStartPayload {
  /** Omitted/true = approve (the Start button / "go ahead"); card 05 adds the deny surface. */
  approved?: boolean
  sessionId?: string
  runId?: string
}

interface ApprovalRespondPayload {
  approvalId: string
  decision: 'approve' | 'skip' | 'cancel'
}

// M1.4: persistence failures are always loud (docs/02 §2.1 wire contract) —
// the terminal part that would have closed the run is replaced by this error.
const PERSIST_FAILED_COPY = 'The reply could not be saved to this conversation.'
// M1.4: one stream per session, enforced main-side where the streams live.
// The renderer has its own in-flight guard, but a send that slips past it
// (useChat has no running guard of its own) must still never start a second
// concurrent stream — main rejects the invoke instead.
const SECOND_RUN_COPY =
  'A reply is already streaming in this conversation. Stop it first or wait for it to finish.'
// MVP step 7: /completion/verify budget — verifyStep has its own race with
// this timeout; a slow or absent sidecar degrades to an honest skip.
const VERIFY_TIMEOUT_MS = 8_000
// docs/03 §2 step guard: the default is 25, surfaced as a friendly note when
// the loop runs out of steps (the SDK emits a finish part with reason
// 'tool-calls' or 'length'; we don't inspect the reason — the step guard is
// the single source of truth).
const STEP_LIMIT_COPY =
  'I stopped after taking 25 actions in a row. Say "continue" if you want me to keep going.'

// M2.5 audit sink, built per run: every registry tool wrapper outcome lands a
// tool_calls row; mutating tools get their checkpoint after-excerpt backfilled
// (write_file's whole-file excerpt / edit_file's region recomputation).
// Executed outcomes also feed the run's verification action list (MVP step 7).
// Bookkeeping failures are logged and never break the run.
function createToolCallAuditSink(
  sessionId: string,
  checkpointIdsByToolCall: Map<string, string>,
  checkpointContentByToolCall: Map<string, string>,
  verifyActions: { tool: string; input: unknown; result: unknown }[],
  onStepUpdate?: (input: {
    tool: string
    toolCallId: string | null
    status: 'in_progress' | 'done' | 'failed' | 'skipped'
    message?: string
  }) => void
): ToolOutcomeEntry {
  return (entry) => {
    onStepUpdate?.({
      tool: entry.tool,
      toolCallId: entry.toolCallId,
      status:
        entry.status === 'executed' && entry.ok
          ? 'done'
          : entry.status === 'skipped' || entry.status === 'cancelled'
            ? 'skipped'
            : 'failed',
      message: entry.ok ? undefined : entry.message
    })
    try {
      recordToolCall({
        sessionId,
        toolCallId: entry.toolCallId,
        tool: entry.tool,
        input: entry.input,
        output: entry.status === 'executed' && entry.ok ? { message: entry.message } : undefined,
        ok: entry.ok,
        error: entry.ok ? undefined : entry.status === 'refused' ? entry.message : entry.message,
        riskLevel: entry.riskLevel,
        riskSource: 'rule_table',
        durationMs: entry.durationMs
      })
    } catch (error) {
      console.error('[tool_calls] audit write failed:', error)
    }
    // MVP audit-only safety cross-check (MVP_PLAN.md step 6): the sidecar's
    // independent heuristic view is logged when it disagrees with the rule
    // table — it never gates anything. Any failure is silent (sidecar-down
    // degraded doctrine, docs/05 §6).
    void classifySafety(entry.tool, entry.input).then(
      (result) => {
        if (result.risk !== entry.riskLevel) {
          console.log(
            `[safety] ${entry.tool}: rule table ${entry.riskLevel} vs sidecar heuristic ${result.risk} — ${result.reason}`
          )
        }
      },
      () => {}
    )
    // MVP step 7: executed outcomes feed the run's verification action list
    // (the sidecar's postcondition heuristic re-reads those targets). The
    // message stands in for the raw result — the sidecar checks paths, not
    // payloads.
    if (entry.status === 'executed' && entry.ok) {
      verifyActions.push({ tool: entry.tool, input: entry.input, result: entry.message })
    }
    // M2.5: backfill the after-excerpt onto the checkpoint row written at
    // snapshot time (the snapshot fires pre-execution; write_file computes
    // the excerpt caps itself — reuse its own excerptOf so the durable copy
    // matches the card). M2.6: edit_file's region excerpts come from its
    // own editExcerpts over the input anchors (the checkpoint's
    // before-excerpt is the whole-file head; the card reads the tool
    // result — both flow from the same caps). Bookkeeping failures are
    // logged and never break the run.
    if (
      entry.status === 'executed' &&
      entry.ok &&
      entry.tool === 'write_file' &&
      entry.toolCallId
    ) {
      const cpId = checkpointIdsByToolCall.get(entry.toolCallId)
      const content = (entry.input as { content?: unknown } | null)?.content
      if (cpId && typeof content === 'string') {
        try {
          setCheckpointAfterExcerpts(cpId, { afterExcerpt: excerptOf(content) })
        } catch (error) {
          console.error('[checkpoints] after-excerpt backfill failed:', error)
        }
      }
    }
    if (entry.status === 'executed' && entry.ok && entry.tool === 'edit_file' && entry.toolCallId) {
      const cpId = checkpointIdsByToolCall.get(entry.toolCallId)
      const input = (entry.input as { old_text?: unknown; new_text?: unknown } | null) ?? {}
      if (cpId && typeof input.old_text === 'string' && typeof input.new_text === 'string') {
        try {
          // The pre-mutation content rode the snapshot sink (stashed by
          // toolCallId above); the region window recomputes from the
          // anchors. Anchors that no longer locate degrade to the
          // new-text head rather than breaking the run.
          const before = checkpointContentByToolCall.get(entry.toolCallId) ?? ''
          const { afterExcerpt } = before.includes(input.old_text)
            ? editExcerpts(before, input.old_text, input.new_text)
            : { afterExcerpt: excerptOf(input.new_text) }
          setCheckpointAfterExcerpts(cpId, { afterExcerpt })
        } catch (error) {
          console.error('[checkpoints] after-excerpt backfill failed:', error)
        }
      }
    }
  }
}

// Provider clients (STACK.md's provider table + M6.3 custom OpenAI-compatible
// profiles, docs/03 §10). Built-ins keep their exact behavior; custom profiles
// ride the already-installed @ai-sdk/openai-compatible adapter. The key comes
// from settings' safeStorage store; custom endpoints may be keyless (local
// servers). Unknown providers keep the honest error part in the handler.
// Keys never cross to the sidecar (AGENTS.md).
function resolveLanguageModel(
  provider: string,
  model: string,
  apiKey: string | undefined,
  baseUrl: string | undefined
): LanguageModel {
  return buildLanguageModel({ provider, model, apiKey, baseUrl })
}

// MVP (MVP_PLAN.md step 3): the one-shot LLM capability backing ctx.llm —
// the run's configured provider/model, called from the Electron main process
// only (keys never cross to the sidecar). Failures become plain-language
// errors the tool answers honestly.
function llmCompleter(model: LanguageModel): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    try {
      const { text } = await generateText({ model, prompt })
      return text
    } catch {
      throw new Error(
        'The model call for this step failed. Check your connection and provider settings.'
      )
    }
  }
}

// MVP (MVP_PLAN.md step 4): SSRF-guarded HTTP GET for web_fetch — 10 s
// timeout, 2 MB streaming cap, decoded as UTF-8. Loopback / private /
// link-local / multicast destinations and redirects to them are refused;
// bodies stream with an enforced byte budget (no unbounded arrayBuffer).
// Network failures throw; the tool catches and answers honestly.
const WEB_FETCH_TIMEOUT_MS = 10_000
const WEB_FETCH_MAX_BYTES = 2_000_000
const WEB_FETCH_MAX_REDIRECTS = 5

async function webFetch(
  url: string
): Promise<{ status: number; body: string; contentType: string }> {
  let current = url
  for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop += 1) {
    const parsed = await assertPublicHttpUrl(current)
    const response = await fetch(parsed.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
    })
    const location = response.headers.get('location')
    if (
      response.status >= 300 &&
      response.status < 400 &&
      location &&
      hop < WEB_FETCH_MAX_REDIRECTS
    ) {
      current = new URL(location, parsed.toString()).toString()
      await response.body?.cancel().catch(() => undefined)
      continue
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.body) {
      const buffer = await response.arrayBuffer()
      const capped =
        buffer.byteLength > WEB_FETCH_MAX_BYTES ? buffer.slice(0, WEB_FETCH_MAX_BYTES) : buffer
      return {
        status: response.status,
        body: new TextDecoder('utf-8').decode(capped),
        contentType
      }
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > WEB_FETCH_MAX_BYTES) {
            const allowed = value.byteLength - (total - WEB_FETCH_MAX_BYTES)
            if (allowed > 0) chunks.push(value.slice(0, allowed))
            break
          }
          chunks.push(value)
        }
      }
    } finally {
      reader.releaseLock()
      await response.body.cancel().catch(() => undefined)
    }
    const combined = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    return {
      status: response.status,
      body: new TextDecoder('utf-8').decode(combined),
      contentType
    }
  }
  throw new Error('That page redirected too many times.')
}

// Per-run active context. The run ctx exposes the ask_user answer resolver
// (so the `tool:answer` IPC can settle the pending promise) and the abort
// callback (so the renderer-initiated `chat:stop` aborts the AI SDK stream
// without leaving ask_user pending forever).
interface ActiveRun {
  controller: AbortController
  run: RunContextBundle
  runId: string
}

// One stream per session, enforced main-side (M1.4). A second send while a
// session is running is rejected before anything is persisted. The map entry
// is deleted in a `finally` so a stop landing during the persist window
// (or when nothing is running) is a no-op.
const activeRuns = new Map<string, ActiveRun>()

// Build the registry exactly once — tool definitions are immutable for the
// app's lifetime, so re-defining per send would only allocate. The active
// tools are the M2.4 set (read-only + ask_user + write_file from M2.1);
// M2.5/M2.6/M2.7 add their tools here.
function buildGlobalRegistry(): ReturnType<typeof createToolRegistry> {
  const registry = createToolRegistry()
  registry.define(listDirTool)
  registry.define(readFileTool)
  registry.define(readDocumentTool)
  registry.define(summarizeDocumentTool)
  registry.define(webFetchTool)
  registry.define(semanticSearchTool)
  registry.define(searchFilesTool)
  registry.define(askUserTool)
  registry.define(writeFileTool)
  registry.define(createDirTool)
  registry.define(editFileTool)
  registry.define(movePathTool)
  registry.define(copyPathTool)
  registry.define(deletePathTool)
  // M3.1: the plan tool. The plan phase wraps ONLY this tool (forced
  // toolChoice); it stays in the registry so a revised plan mid-execution
  // goes through the same wrapper (docs/03 §2 "plans are advisory").
  registry.define(emitPlanTool)
  return registry
}

const globalRegistry = buildGlobalRegistry()

/** Undo is blocked mid-run (docs/03 §8) — the Changes IPC asks, chat owns the map. */
export function isSessionRunActive(sessionId: string): boolean {
  return activeRuns.has(sessionId)
}

export function registerChatIpc(): void {
  ipcMain.handle('chat:stop', (_event: IpcMainInvokeEvent, payload: ChatStopPayload) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (!sessionId) return
    const active = activeRuns.get(sessionId)
    if (active) {
      // Reject any pending plan-start promise (M3.1) so the loop does not sit
      // on the gate forever — same doctrine as the ask_user rejection below.
      active.run.rejectPlanStart('Run stopped before the user replied.')
      // Reject pending approvals (M3.2) + ask_user so a stop unwinds both.
      active.run.rejectApprovals('Stopped before you decided.')
      // Reject any pending ask_user promise so the AI SDK sees an error and
      // unwinds the in-flight step (otherwise a stop on a paused ask_user
      // would hang on an unobserved promise until the next send).
      for (const pending of collectPendingAnswerIds(active.run)) {
        active.run.rejectAskUserAnswer(pending, 'Run stopped before the user replied.')
      }
      active.controller.abort()
    }
  })

  ipcMain.handle('tool:answer', (_event: IpcMainInvokeEvent, payload: ToolAnswerPayload) => {
    const toolCallId = typeof payload?.toolCallId === 'string' ? payload.toolCallId : ''
    const answer = typeof payload?.answer === 'string' ? payload.answer : ''
    if (!toolCallId) return { ok: false, reason: 'toolCallId is required' }
    // Walk every active run; in practice only one run is ever asking the
    // user at a time, but the loop tolerates a stale answer arriving for a
    // run that already settled (returns false so the renderer can show
    // "this question is no longer active").
    for (const active of activeRuns.values()) {
      if (active.run.resolveAskUserAnswer(toolCallId, answer)) {
        return { ok: true }
      }
    }
    return { ok: false, reason: 'No active ask_user matches that toolCallId.' }
  })

  // Legacy plan-start gate (docs/03 §2): Plan mode is now read-only with no
  // gate and Act mode executes directly, so no run ever pends here in
  // production. Kept resolving any legacy pending promise; otherwise an
  // honest no-op so stale callers never hang.
  ipcMain.handle('plan:start', (_event: IpcMainInvokeEvent, payload: PlanStartPayload) => {
    const approved = payload?.approved !== false
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
    const runId = typeof payload?.runId === 'string' ? payload.runId : undefined
    if (sessionId !== undefined) {
      const active = activeRuns.get(sessionId)
      if (active && (runId === undefined || active.runId === runId)) {
        if (active.run.resolvePlanStart(approved)) return { ok: true }
      }
      return { ok: false, reason: 'No plan is waiting to start.' }
    }
    for (const active of activeRuns.values()) {
      if (runId !== undefined && active.runId !== runId) continue
      if (active.run.resolvePlanStart(approved)) {
        return { ok: true }
      }
    }
    return { ok: false, reason: 'No plan is waiting to start.' }
  })

  // M3.2 approval response (docs/03 §4): resolves the pending approval
  // promise — the registry wrapper is blocked on it for risk ≥ 2. The
  // approval/resolved event is emitted once by the run's onApprovalResolved
  // callback (central sequenced emitter) — never here, to avoid duplicates.
  ipcMain.handle(
    'approval:respond',
    (_event: IpcMainInvokeEvent, payload: ApprovalRespondPayload) => {
      const approvalId = typeof payload?.approvalId === 'string' ? payload.approvalId : ''
      const decision = payload?.decision
      if (!approvalId) return { ok: false, reason: 'approvalId is required' }
      if (decision !== 'approve' && decision !== 'skip' && decision !== 'cancel') {
        return { ok: false, reason: 'decision must be approve, skip, or cancel' }
      }
      for (const entry of activeRuns.values()) {
        if (entry.run.resolveApproval(approvalId, decision)) {
          return { ok: true }
        }
      }
      return { ok: false, reason: 'No pending approval matches that id.' }
    }
  )

  ipcMain.handle('chat:send', async (event: IpcMainInvokeEvent, payload: ChatSendPayload) => {
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''

    if (!sessionId) throw new Error('chat:send requires a sessionId.')
    const session = getSession(sessionId)
    if (!session) throw new Error('The session for this conversation no longer exists.')

    if (activeRuns.has(sessionId)) {
      throw new Error(SECOND_RUN_COPY)
    }

    // Persist the user's message before anything else — even a failed or
    // rejected stream keeps what the user said. Upserted by message id, so
    // history resends after a restart cannot duplicate rows.
    const last = messages[messages.length - 1]
    if (last && last.role === 'user') {
      appendMessage(sessionId, last)
    }

    const { provider, model } = getSettings()
    let apiKey: string | undefined
    try {
      apiKey = resolveProviderKey(provider)
    } catch {
      sendPart(event.sender, sessionId, {
        type: 'error',
        // docs/04 §5 copy rules: provider failures never surface as raw codes
        // or stack traces. (The key-missing copy below is the same doctrine.)
        errorText: "The API key for this provider isn't working. Check it in Settings → Providers."
      })
      return
    }
    if (apiKey === undefined && providerRequiresKey(provider)) {
      sendPart(event.sender, sessionId, {
        type: 'error',
        errorText: 'There is no API key for this provider yet. Add one in Settings → Providers.'
      })
      return
    }
    let languageModel: LanguageModel
    try {
      languageModel = resolveLanguageModel(provider, model, apiKey, resolveActiveBaseUrl())
    } catch {
      sendPart(event.sender, sessionId, {
        type: 'error',
        errorText: 'This provider is not set up. Check the provider in Settings → Providers.'
      })
      return
    }

    // MVP audit-only intent classification (MVP_PLAN.md step 6): one
    // heuristic sidecar call per instruction, logged and never consumed by
    // the loop — any failure is silent (degraded doctrine, docs/05 §6).
    const lastUserText =
      last && last.role === 'user'
        ? last.parts
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join(' ')
            .trim()
        : ''
    if (lastUserText) {
      void classifyIntent(lastUserText).then(
        (result) => console.log(`[intent] ${result.intent} (${result.confidence})`),
        () => {}
      )
    }

    // Build the per-run ctx now. Workspace is session-bound (not global):
    // a resumed session runs in the workspace it was created in. Fall back
    // to the current pick only for legacy rows with the '' placeholder.
    // The Sender wraps webContents.send — `src/main/agent/` is Electron-free
    // by contract (AGENTS.md rule 1), so the wrapping happens here in the
    // main side. The durable sinks (M2.5) write the checkpoints + tool_calls
    // rows through the storage repos; bookkeeping failures are logged and
    // never break the run (same doctrine as usage recording).
    const runId = newRunId()
    const sessionWorkspace = session.workspacePath?.trim() ? session.workspacePath : null
    const workspaceRoot = sessionWorkspace ?? getCurrentWorkspace() ?? ''

    // Auto title (docs/03 §4): on the FIRST send only — messages holds the
    // full history, so length 1 means exactly the opening user message — ask
    // the model for a real topic title in the user's language. Fire-and-forget
    // alongside the run: the derived first-message title stays until (and
    // unless) the rename lands. A failure (e.g. the provider refusing a
    // concurrent request) is logged, never touches the run, and retries once
    // at the settle point, when the run no longer competes for the provider.
    // An unchanged answer (some reasoning models return empty text for a side
    // call) is logged and skipped — no pointless rename event.
    const runTitleGeneration = (onFailure?: () => void): void => {
      void generateSessionTitle({
        complete: llmCompleter(languageModel),
        firstMessage: lastUserText,
        fallback: session.title
      })
        .then((title) => {
          if (title === session.title) {
            console.info(`[title] model returned nothing usable for session ${sessionId}`)
            return
          }
          const row = setSessionTitle(sessionId, title)
          if (row) {
            console.info(`[title] "${session.title}" -> "${title}"`)
            emitSessionTitleUpdated({ sessionId, runId, title })
          }
        })
        .catch((error: unknown) => {
          console.error('[title] generation failed:', error)
          onFailure?.()
        })
    }
    const isFirstSend = messages.length === 1 && lastUserText !== ''
    let retryTitleAtSettle = false
    if (isFirstSend) {
      runTitleGeneration(() => {
        retryTitleAtSettle = true
      })
    }
    // MVP (MVP_PLAN.md step 5): the semantic index cache lives in the app's
    // own userData — never inside the user's workspace (a risk-0 tool must
    // not write there; it would bypass the snapshot pipeline). Undefined
    // without a workspace: the tool answers honestly.
    const semantic = workspaceRoot
      ? {
          search: (query: string, topK?: number) =>
            semanticSearch(
              {
                fs: createWorkspaceFs(workspaceRoot),
                embedTexts,
                extractDocument,
                cachePath: cachePathForWorkspace(app.getPath('userData'), workspaceRoot)
              },
              workspaceRoot,
              query,
              topK
            )
        }
      : undefined
    const run = buildRunContext({
      sender: {
        emit: (channel, value) => {
          event.sender.send(channel, value)
        }
      },
      sessionId,
      runId,
      workspaceRoot,
      // M6.3 permission defaults (Settings → Permissions): read once per run.
      permissionDefaults: getPermissionDefaults(),
      onApprovalRequested: ({ approvalId, request, count }) => {
        try {
          emitApprovalRequested({
            sessionId,
            runId,
            approvalId,
            title: request.title,
            body:
              count !== undefined && count > 1
                ? `${request.reason} (batch of ${count})`
                : request.reason,
            riskLevel: request.riskLevel,
            ...(count !== undefined && count > 1 ? { count } : {})
          })
        } catch (error) {
          console.error('[approval] emitting request failed:', error)
        }
      },
      onApprovalResolved: ({ approvalId, decision }) => {
        // Single sequenced emission (the handler no longer emits).
        try {
          emitApprovalResolved({ sessionId, runId, approvalId, decision })
        } catch (error) {
          console.error('[approval] emitting resolution failed:', error)
        }
      },
      // MVP (MVP_PLAN.md step 2): .pdf/.docx extraction rides the sidecar.
      // Failures throw plain-language errors the tool answers honestly.
      documents: { extract: extractDocument },
      // MVP (MVP_PLAN.md step 3): summarize_document's one-shot completion.
      llm: { complete: llmCompleter(languageModel) },
      // MVP (MVP_PLAN.md step 4): web_fetch's plain HTTP GET.
      web: { fetch: webFetch },
      // MVP (MVP_PLAN.md step 5): on-device semantic search (undefined
      // without a workspace pick).
      semantic,
      onSnapshot: (entry) => {
        // Fail-closed: recordCheckpoint throws on oversize/storage failure —
        // let it bubble so the registry refuses the mutation (docs/03 §7).
        // Size is recomputed from raw bytes in the repository (b64-aware).
        const row = recordCheckpoint({
          sessionId,
          toolCallId: entry.toolCallId,
          path: entry.path,
          destPath: entry.destPath ?? null,
          existed: entry.existed,
          isDir: entry.isDir,
          content: entry.content,
          size: null,
          beforeExcerpt: entry.beforeExcerpt ?? null
        })
        // The snapshot fires BEFORE execution, so the after-excerpt backfill
        // rides the outcome notification (below); keep the row id by the AI SDK
        // toolCallId so the tool's own result can reach it. The pre-mutation
        // content is stashed alongside for the edit_file region backfill.
        if (entry.toolCallId) checkpointIdsByToolCall.set(entry.toolCallId, row.id)
        if (entry.toolCallId && entry.content !== null) {
          checkpointContentByToolCall.set(entry.toolCallId, entry.content)
        }
      }
    })

    const controller = new AbortController()
    // M2.5 checkpoint-after backfill index: the snapshot hook (pre-execution)
    // creates the checkpoint row; a mutating tool's own result carries the
    // after excerpt, so the outcome notification looks the row up by the AI
    // SDK toolCallId and backfills it (docs/03 §5 — the durable row is the
    // source the card/Bridge read from).
    const checkpointIdsByToolCall = new Map<string, string>()
    const checkpointContentByToolCall = new Map<string, string>()
    // MVP step 7: the run's executed actions, fed by the audit sink and
    // consumed by the verify dep below (verify.ts is the contract client).
    const verifyActions: { tool: string; input: unknown; result: unknown }[] = []
    let currentPlanSteps: PlanStep[] = []
    const toolCallToStepId = new Map<string, string>()
    const doneStepIds = new Set<string>()
    activeRuns.set(sessionId, { controller, run, runId })

    // M3.1 plan persistence + event: the loop calls this exactly once per
    // plan (the initial one, or a revised one mid-execution). Rows land in
    // plan_steps (docs/03 §8) and the `plan/created` agent event goes out on
    // the standard envelope (Zod-validated in agent-events.ts). Bookkeeping
    // failures are logged and never break the run.
    const onPlanCreated = (steps: PlanStep[]): void => {
      currentPlanSteps = steps
      // M3.3: the run's coalescer projects batch counts from these steps —
      // set even if persistence/emission below throws (projection must not
      // depend on bookkeeping).
      try {
        run.setPlanSteps(steps)
      } catch (error) {
        console.error('[plan] run plan-steps handoff failed:', error)
      }
      try {
        const planVersion = nextPlanVersion(sessionId)
        recordPlanSteps({ sessionId, planVersion, steps })
        emitPlanCreated({ sessionId, runId, steps })
      } catch (error) {
        console.error('[plan] recording plan failed:', error)
      }
    }

    // Explicit Plan/Act routing (docs/03 §2): the session's persisted mode
    // owns execution — never a renderer-supplied flag. Plan runs read-only
    // with no gate; Act runs execute directly. An Act "go ahead" carries the
    // session's latest saved plan as advisory context (still fully guarded).
    // Unexpected throws must never lock the session: activeRuns cleanup lives
    // in the finally below.
    const sessionMode = normalizeSessionMode(session.mode)
    let savedPlan: PlanStep[] = []
    if (sessionMode === 'act' && isGoAheadMessage(lastUserText)) {
      try {
        const latest = getLatestPlan(sessionId)
        if (latest.length > 0) {
          savedPlan = latest
          currentPlanSteps = latest
          try {
            run.setPlanSteps(latest)
          } catch (error) {
            console.error('[plan] run plan-steps handoff failed:', error)
          }
        }
      } catch (error) {
        console.error('[plan] loading saved plan failed:', error)
      }
    }
    const onOutcome = createToolCallAuditSink(
      sessionId,
      checkpointIdsByToolCall,
      checkpointContentByToolCall,
      verifyActions,
      ({ tool, toolCallId, status, message }) => {
        // Step binding: prefer an explicit toolCallId mapping, else the
        // first *pending* fuzzy match. Never fall back to step 0 for an
        // unmatched tool — a false badge is worse than no badge.
        const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z]/g, '')
        const matches = (candidateTool: string): boolean => {
          const a = normalize(candidateTool)
          const b = normalize(tool)
          return a === b || a.startsWith(b) || b.startsWith(a)
        }
        let step: PlanStep | undefined
        if (toolCallId) {
          const mappedId = toolCallToStepId.get(toolCallId)
          if (mappedId) step = currentPlanSteps.find((s) => s.id === mappedId)
        }
        if (!step) {
          const pending = currentPlanSteps.filter((s) => !doneStepIds.has(s.id) && matches(s.tool))
          step = pending[0] ?? currentPlanSteps.find((s) => matches(s.tool))
        }
        if (!step) return
        if (toolCallId && !toolCallToStepId.has(toolCallId)) {
          toolCallToStepId.set(toolCallId, step.id)
        }
        if (status === 'done' || status === 'failed' || status === 'skipped') {
          doneStepIds.add(step.id)
        }
        try {
          emitPlanStepUpdated({
            sessionId,
            runId,
            stepId: step.id,
            status,
            ...(message !== undefined ? { error: message } : {})
          })
        } catch (error) {
          console.error('[plan] step status event failed:', error)
        }
      }
    )
    let outcome: Awaited<ReturnType<typeof runActTurn>>
    try {
      const system = buildSystemPrompt(workspaceRoot || null)
      const send = (part: Parameters<typeof sendPart>[2]): void =>
        sendPart(event.sender, sessionId, part)
      // MVP step 7: the real sidecar verifier replaces M3.5's degraded stub.
      // The audit sink accumulates every executed action; verification
      // re-checks the FULL set on both the first call and the one retry (no
      // drain — the retry must see the same targets). Read-only-only runs
      // skip honestly (badges are never faked in either direction), and any
      // sidecar failure degrades to skipped inside verifyStep.
      const verify = (input: {
        instructionSegment: string
        stepDescription: string
      }): Promise<
        | { verdict: 'skipped' }
        | { verdict: 'complete'; score: number }
        | { verdict: 'incomplete'; score: number; missedSegments: string[] }
      > => {
        if (!hasMutatingActions(verifyActions)) {
          return Promise.resolve({ verdict: 'skipped' } as const)
        }
        return verifyStep(
          {
            sidecarHealth: () => getSidecarStatus().status,
            fetchVerify: (body: unknown) =>
              sidecarFetch('/completion/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
              })
          },
          {
            instructionSegment: input.instructionSegment,
            stepDescription: input.stepDescription,
            actions: verifyActions,
            beforeAfter: { before: null, after: null }
          }
        )
      }
      const onVerification = (result: {
        stepId: string
        isComplete: boolean
        score: number | null
        missedSegments?: string[]
      }): void => {
        try {
          emitVerificationFinished({
            sessionId,
            runId,
            stepId: result.stepId,
            isComplete: result.isComplete,
            score: result.score,
            ...(result.missedSegments !== undefined
              ? { missedSegments: result.missedSegments }
              : {})
          })
        } catch (error) {
          console.error('[verify] emitting verification failed:', error)
        }
      }
      if (sessionMode === 'plan') {
        outcome = await runPlanModeTurn({
          model: languageModel,
          system,
          messages,
          registry: globalRegistry,
          ctx: run.ctx,
          sendPart: send,
          onOutcome,
          onPlanCreated,
          signal: controller.signal,
          verify,
          onVerification
        })
      } else {
        outcome = await runActTurn({
          model: languageModel,
          system,
          messages,
          registry: globalRegistry,
          ctx: run.ctx,
          sendPart: send,
          onOutcome,
          signal: controller.signal,
          ...(savedPlan.length > 0 ? { planHandoff: savedPlan } : {}),
          verify,
          onVerification
        })
      }
    } catch (error) {
      // Unexpected loop throw (malformed history, sender failure): the
      // session stays usable — surface an honest error part, never a hang.
      console.error('[chat] run failed:', error)
      try {
        sendPart(event.sender, sessionId, {
          type: 'error',
          errorText: 'Something went wrong running that request. Try again.'
        })
      } catch {
        // noop — sender gone
      }
      return
    } finally {
      activeRuns.delete(sessionId)
      // An unexpected throw above must not leave plan/approval/ask_user
      // promises hanging — settle them so a retry can start cleanly.
      try {
        run.rejectPlanStart('Run stopped before the user replied.')
      } catch {
        // noop — no pending gate is the common case
      }
      try {
        run.rejectApprovals('Run ended before you decided.')
      } catch {
        // noop
      }
      for (const pending of collectPendingAnswerIds(run)) {
        try {
          run.rejectAskUserAnswer(pending, 'Run stopped before the user replied.')
        } catch {
          // noop
        }
      }
    }

    // The title's one retry lives here rather than mid-run: with the stream
    // finished, the side call no longer competes with the run for the
    // provider.
    if (retryTitleAtSettle) runTitleGeneration()

    // Token usage rides the settle point (docs/03 §2 token guard, §8
    // usage_events): recorded only when the run's usage actually resolved
    // (plan + execution phases summed by the loop). A stopped run resolves
    // no usage with the pinned ai@5.0.250 (onFinish never fires on a
    // mid-first-step abort; result.totalUsage rejects), so it records
    // nothing — no row, no event — rather than a fabricated zero. The SDK
    // also reports reasoningTokens/cachedInputTokens/totalTokens; the
    // documented schema holds input/output only, so those are dropped. A
    // bookkeeping failure must never break the run or replace the terminal
    // (only reply-persistence failures are loud, docs/02 §2.1), so it is
    // logged main-side and the run continues.
    if (outcome.usage) {
      if (outcome.usage.inputTokens !== null || outcome.usage.outputTokens !== null) {
        try {
          insertUsage({
            sessionId,
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens
          })
          emitUsageEvent({
            sessionId,
            runId,
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens
          })
        } catch (error) {
          console.error('[usage] recording token usage failed:', error)
        }
      }
    }

    // Exactly one terminal part per run, sent only after persistence:
    //  - stopped run → native v5 { type: 'abort' } after the partial reply is
    //    saved (assistantMessage is null when nothing textual arrived — e.g.
    //    a stop during the reasoning lead-in — and then nothing is persisted);
    //  - natural run → the held 'finish' after the full reply is saved;
    //  - either save failing swaps that terminal for an 'error' part, so a
    //    persistence failure is visible in the thread, never swallowed.
    //  A stream that already ended in an 'error' part sent its terminal then.
    if (!outcome.terminalSent && !outcome.accumulatorFailed) {
      if (outcome.aborted && outcome.heldFinish === null) {
        try {
          if (outcome.assistantMessage) appendMessage(sessionId, outcome.assistantMessage)
          sendPart(event.sender, sessionId, { type: 'abort' })
        } catch {
          sendPart(event.sender, sessionId, { type: 'error', errorText: PERSIST_FAILED_COPY })
        }
      } else {
        try {
          if (outcome.assistantMessage) appendMessage(sessionId, outcome.assistantMessage)
          sendPart(event.sender, sessionId, outcome.heldFinish ?? { type: 'finish' })
        } catch {
          sendPart(event.sender, sessionId, { type: 'error', errorText: PERSIST_FAILED_COPY })
        }
      }
    }

    // The step-limit note is sent as an additional error part AFTER the
    // terminal so the user can read it without the natural finish claiming
    // success. We treat it as informational — not a terminal — so the loop
    // status is consistent with a normal reply.
    if (outcome.stepLimitReached) {
      sendPart(event.sender, sessionId, { type: 'error', errorText: STEP_LIMIT_COPY })
    }
  })
}

function sendPart(sender: Electron.WebContents, sessionId: string, part: UIMessageChunk): void {
  sender.send('chat:part', { sessionId, part })
}

// Reach into the run ctx to find pending ask_user ids. The agent's `context`
// module owns the map, but the IPC handler must be able to settle them on
// stop. The cleanest way without a public iterator is to keep an internal
// id-set on the bundle — the run ctx returns one from buildRunContext. The
// shape is small; we expose it via a per-run symbol on the bundle so the
// IPC handler doesn't reach into agent internals.
function collectPendingAnswerIds(run: RunContextBundle): string[] {
  // The bundle's pending answers map is intentionally internal (tests use
  // the resolve/reject API). For the IPC's stop path we expose a small
  // helper on the run — see `context.ts`.
  return (run as RunContextBundle & { _pendingAnswerIds(): string[] })._pendingAnswerIds?.() ?? []
}
