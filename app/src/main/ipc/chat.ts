import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { APICallError, RetryError, stepCountIs, streamText } from 'ai'
import type { LanguageModel, LanguageModelUsage, UIMessage, UIMessageChunk } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { getSettings, resolveProviderKey } from '../settings'
import { appendMessage, getSession } from '../storage/sessions'
import { insertUsage } from '../storage/usage'
import {
  recordCheckpoint,
  recordToolCall,
  setCheckpointAfterExcerpts
} from '../storage/checkpoints'
import { getCurrentWorkspace } from '../workspaces'
import {
  askUserTool,
  buildRunContext,
  createDirTool,
  createToolRegistry,
  excerptOf,
  listDirTool,
  newRunId,
  readFileTool,
  searchFilesTool,
  stripStepReasoning,
  writeFileTool
} from '../agent'
import type { RunContextBundle } from '../agent'
import { emitUsageEvent } from './agent-events'
import { AssistantMessageAccumulator } from './assistant-accumulator'
import { FULL_SYSTEM_PROMPT } from './system-prompt'

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

// docs/04 §5 copy rules: provider failures never surface as raw codes or
// stack traces. Google signals a rejected key as 400 INVALID_ARGUMENT
// ("API key not valid"), so 401-class detection also matches that shape.
const KEY_REJECTED_COPY =
  "The API key for this provider isn't working. Check it in Settings → Providers."
const RATE_LIMITED_COPY = "The model is rate-limiting us. I'll wait a moment and retry."
const GENERIC_PROVIDER_COPY =
  'Something went wrong talking to the model provider. Check your connection and try again.'
// M1.4: persistence failures are always loud (docs/02 §2.1 wire contract) —
// the terminal part that would have closed the run is replaced by this error.
const PERSIST_FAILED_COPY = 'The reply could not be saved to this conversation.'
// M1.4: one stream per session, enforced main-side where the streams live.
// The renderer has its own in-flight guard, but a send that slips past it
// (useChat has no running guard of its own) must still never start a second
// concurrent stream — main rejects the invoke instead.
const SECOND_RUN_COPY =
  'A reply is already streaming in this conversation. Stop it first or wait for it to finish.'
// docs/03 §2 step guard: the default is 25, surfaced as a friendly note when
// the loop runs out of steps (the SDK emits a finish part with reason
// 'tool-calls' or 'length'; we don't inspect the reason — the step guard is
// the single source of truth).
const STEP_LIMIT_COPY =
  'I stopped after taking 25 actions in a row. Say "continue" if you want me to keep going.'

function friendlyProviderError(error: unknown): string {
  // streamText retries transient failures and surfaces them as a RetryError
  // wrapping the provider's own APICallError — unwrap before classifying, or
  // a rate limit (429) falls through to the generic copy (docs/04 §5).
  const cause = RetryError.isInstance(error) ? error.lastError : error
  if (APICallError.isInstance(cause)) {
    const body = `${cause.message} ${cause.responseBody ?? ''}`
    if (cause.statusCode === 401 || cause.statusCode === 403) return KEY_REJECTED_COPY
    if (cause.statusCode === 400 && /api key/i.test(body)) return KEY_REJECTED_COPY
    if (cause.statusCode === 429) return RATE_LIMITED_COPY
  }
  return GENERIC_PROVIDER_COPY
}

// Reasoning parts are model-internal scratch (thinking models like
// openai/gpt-oss-* emit them). The renderer replays the full UIMessage history
// on every send, and OpenAI-compatible providers reject reasoning content on
// input (Groq: "property 'reasoning_content' is unsupported") — reasoning
// never persists either (the accumulator keeps text only). Strip it from
// assistant messages before building model messages.
function replayable(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) =>
    message.role === 'assistant'
      ? { ...message, parts: message.parts.filter((part) => part.type !== 'reasoning') }
      : message
  )
}

// Provider clients enabled this phase (STACK.md's provider table): Google AI
// Studio and Groq (via its OpenAI-compatible endpoint). The key comes from
// settings' safeStorage store; an unknown provider keeps the honest "not set
// up in this version" error part in the handler.
function resolveLanguageModel(provider: string, model: string, apiKey: string): LanguageModel {
  if (provider === 'google') {
    return createGoogleGenerativeAI({ apiKey })(model)
  }
  if (provider === 'groq') {
    const groq = createOpenAICompatible({
      name: 'groq',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey
    })
    return groq(model)
  }
  throw new Error(`Unsupported provider: ${provider}`)
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
// M2.5/M2.6 add their tools here.
function buildGlobalRegistry(): ReturnType<typeof createToolRegistry> {
  const registry = createToolRegistry()
  registry.define(listDirTool)
  registry.define(readFileTool)
  registry.define(searchFilesTool)
  registry.define(askUserTool)
  registry.define(writeFileTool)
  registry.define(createDirTool)
  return registry
}

const globalRegistry = buildGlobalRegistry()

export function registerChatIpc(): void {
  ipcMain.handle('chat:stop', (_event: IpcMainInvokeEvent, payload: ChatStopPayload) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (!sessionId) return
    const active = activeRuns.get(sessionId)
    if (active) {
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
      sendPart(event.sender, sessionId, { type: 'error', errorText: GENERIC_PROVIDER_COPY })
      return
    }
    if (apiKey === undefined) {
      sendPart(event.sender, sessionId, {
        type: 'error',
        errorText: 'There is no API key for this provider yet. Add one in Settings → Providers.'
      })
      return
    }
    let languageModel: LanguageModel
    try {
      languageModel = resolveLanguageModel(provider, model, apiKey)
    } catch {
      sendPart(event.sender, sessionId, {
        type: 'error',
        errorText:
          'Only Google and Groq are set up in this version of Agento. Check the provider in Settings → Providers.'
      })
      return
    }

    // Build the per-run ctx now (so the workspaceRoot reflects the current
    // pick). The Sender wraps webContents.send — `src/main/agent/` is
    // Electron-free by contract (AGENTS.md rule 1), so the wrapping happens
    // here in the main side. The durable sinks (M2.5) write the checkpoints
    // + tool_calls rows through the storage repos; bookkeeping failures are
    // logged and never break the run (same doctrine as usage recording).
    const runId = newRunId()
    const run = buildRunContext({
      sender: {
        emit: (channel, value) => {
          event.sender.send(channel, value)
        }
      },
      sessionId,
      runId,
      workspaceRoot: getCurrentWorkspace() ?? '',
      onSnapshot: (entry) => {
        const row = recordCheckpoint({
          sessionId,
          toolCallId: entry.toolCallId,
          path: entry.path,
          existed: entry.existed,
          content: entry.content,
          size: entry.content !== null ? Buffer.byteLength(entry.content, 'utf8') : null,
          beforeExcerpt: entry.beforeExcerpt ?? null
        })
        // The snapshot fires BEFORE execution, so the after-excerpt backfill
        // rides the outcome notification (below); keep the row id by the AI SDK
        // toolCallId so the tool's own result can reach it.
        if (entry.toolCallId) checkpointIdsByToolCall.set(entry.toolCallId, row.id)
      }
    })

    const controller = new AbortController()
    // M2.5 checkpoint-after backfill index: the snapshot hook (pre-execution)
    // creates the checkpoint row; a mutating tool's own result carries the
    // after excerpt, so the outcome notification looks the row up by the AI
    // SDK toolCallId and backfills it (docs/03 §5 — the durable row is the
    // source the card/Bridge read from).
    const checkpointIdsByToolCall = new Map<string, string>()
    activeRuns.set(sessionId, { controller, run, runId })

    // The provider's own 'finish' part is HELD: it is forwarded only after
    // persistence completes, so the wire never claims a complete run whose
    // reply did not reach storage.
    let heldFinish: UIMessageChunk | null = null
    let aborted = false
    let terminalSent = false
    const accumulator = new AssistantMessageAccumulator()
    // Token usage for this run (M1.5), captured from the SDK's onFinish.
    // Verified against the installed ai@5.0.250 dist: onFinish fires only
    // when at least one step completed, and it always runs inside the
    // stream's flush — before the forwarding loop below exits, so the value
    // is settled by the time the settle point records it. On a mid-stream
    // abort (the only abort shape without tools) onFinish never fires and
    // result.totalUsage REJECTS with NoOutputGeneratedError — which is why
    // usage is captured via the callback, never awaited.
    let capturedUsage: LanguageModelUsage | undefined
    let stepsTaken = 0
    let stepLimitReached = false
    try {
      const result = streamText({
        model: languageModel,
        system: FULL_SYSTEM_PROMPT,
        messages: convertToModelMessagesSafe(replayable(messages)),
        tools: globalRegistry.toAiSdkTools(run.ctx, {
          onOutcome: (entry) => {
            try {
              recordToolCall({
                sessionId,
                toolCallId: entry.toolCallId,
                tool: entry.tool,
                input: entry.input,
                output:
                  entry.status === 'executed' && entry.ok ? { message: entry.message } : undefined,
                ok: entry.ok,
                error: entry.ok
                  ? undefined
                  : entry.status === 'refused'
                    ? entry.message
                    : entry.message,
                riskLevel: entry.riskLevel,
                riskSource: 'rule_table',
                durationMs: entry.durationMs
              })
            } catch (error) {
              console.error('[tool_calls] audit write failed:', error)
            }
            // M2.5: backfill the after-excerpt onto the checkpoint row written at
            // snapshot time (the snapshot fires pre-execution; write_file computes
            // the excerpt caps itself — reuse its own excerptOf so the durable copy
            // matches the card). Bookkeeping failures are logged and never break
            // the run.
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
          }
        }),
        abortSignal: controller.signal,
        stopWhen: stepCountIs(25),
        // Every step's provider request is scrubbed of reasoning parts (see
        // stripStepReasoning): without this, step 2+ of any tool turn whose
        // first step reasoned dies on Groq's reasoning_content rejection.
        prepareStep: ({ messages: stepMessages }) => ({
          messages: stripStepReasoning(stepMessages)
        }),
        onAbort: () => {
          aborted = true
        },
        onStepFinish: () => {
          stepsTaken += 1
        },
        onFinish: (event) => {
          capturedUsage = event.totalUsage
        }
      })
      for await (const part of result.toUIMessageStream({ onError: friendlyProviderError })) {
        accumulator.addChunk(part)
        if (part.type === 'finish') {
          heldFinish = part
          continue
        }
        if (part.type === 'abort') {
          aborted = true
          continue
        }
        if (part.type === 'error' && controller.signal.aborted) {
          // An error chunk arriving on an aborted signal is the abort
          // signature (the onError transform has no context that we stopped
          // this run) — never surface the generic provider copy for it.
          aborted = true
          continue
        }
        // M2.5 hard-won carve-out (gate finding): Groq streams tool-input
        // deltas in one JSON key order and then sends the final arguments with a
        // different key order. @assistant-ui/react's useToolInvocations enforces
        // an append-only argsText invariant across renders, and the reorder throws
        // "Tool call argsText can only be appended, not updated" — a React
        // render error that unmounts the entire ChatView (blank tree — the gate
        // driver found "composer input not found" right after turn 2). Our
        // cards render only from the tool RESULT (never the streaming args), so
        // the tool-input-* deltas are dropped; the final 'tool-input-available'
        // then creates the part fresh and the append guard is never engaged.

        if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
        sendPart(event.sender, sessionId, part)
      }
      // The step guard's effect: the SDK stops calling tools after the cap,
      // emits a finish part with reason 'tool-calls' or 'length', and never
      // throws. We surface a one-line friendly note so the user can ask
      // "continue" without a separate UI affordance.
      if (!aborted && stepsTaken >= 25) {
        stepLimitReached = true
      }
    } catch (error) {
      // ask_user rejections (the run was stopped) and other unhandled errors
      // come through here. The provider-error transform handles
      // RetryError/APICallError specifically; anything else gets the generic
      // copy unless we know the run was stopped.
      if (controller.signal.aborted) {
        aborted = true
      } else if (!accumulator.isFailed() && !terminalSent) {
        const message = isAskUserRejection(error)
          ? 'Stopped before the reply was sent.'
          : friendlyProviderError(error)
        sendPart(event.sender, sessionId, { type: 'error', errorText: message })
        terminalSent = true
      }
    } finally {
      activeRuns.delete(sessionId)
    }

    // Token usage rides the settle point (docs/03 §2 token guard, §8
    // usage_events): recorded only when the run's usage actually resolved.
    // A stopped run resolves no usage with the pinned ai@5.0.250 (onFinish
    // never fires on a mid-first-step abort; result.totalUsage rejects), so
    // it records nothing — no row, no event — rather than a fabricated zero.
    // The SDK also reports reasoningTokens/cachedInputTokens/totalTokens;
    // the documented schema holds input/output only, so those are dropped.
    // A bookkeeping failure must never break the run or replace the terminal
    // (only reply-persistence failures are loud, docs/02 §2.1), so it is
    // logged main-side and the run continues.
    if (capturedUsage !== undefined) {
      const inputTokens =
        typeof capturedUsage.inputTokens === 'number' ? capturedUsage.inputTokens : null
      const outputTokens =
        typeof capturedUsage.outputTokens === 'number' ? capturedUsage.outputTokens : null
      if (inputTokens !== null || outputTokens !== null) {
        try {
          insertUsage({ sessionId, inputTokens, outputTokens })
          emitUsageEvent({ sessionId, runId, inputTokens, outputTokens })
        } catch (error) {
          console.error('[usage] recording token usage failed:', error)
        }
      }
    }

    // Exactly one terminal part per run, sent only after persistence:
    //  - stopped run → native v5 { type: 'abort' } after the partial reply is
    //    saved (toUIMessage() is null when nothing textual arrived — e.g. a
    //    stop during the reasoning lead-in — and then nothing is persisted);
    //  - natural run → the held 'finish' after the full reply is saved;
    //  - either save failing swaps that terminal for an 'error' part, so a
    //    persistence failure is visible in the thread, never swallowed.
    //  A stream that already ended in an 'error' part sent its terminal then.
    if (!terminalSent && !accumulator.isFailed()) {
      if (aborted && heldFinish === null) {
        try {
          const partial = accumulator.toUIMessage()
          if (partial) appendMessage(sessionId, partial)
          sendPart(event.sender, sessionId, { type: 'abort' })
        } catch {
          sendPart(event.sender, sessionId, { type: 'error', errorText: PERSIST_FAILED_COPY })
        }
      } else {
        try {
          const assistantMessage = accumulator.toUIMessage()
          if (assistantMessage) appendMessage(sessionId, assistantMessage)
          sendPart(event.sender, sessionId, heldFinish ?? { type: 'finish' })
        } catch {
          sendPart(event.sender, sessionId, { type: 'error', errorText: PERSIST_FAILED_COPY })
        }
      }
    }

    // The step-limit note is sent as an additional error part AFTER the
    // terminal so the user can read it without the natural finish claiming
    // success. We treat it as informational — not a terminal — so the loop
    // status is consistent with a normal reply.
    if (stepLimitReached) {
      sendPart(event.sender, sessionId, { type: 'error', errorText: STEP_LIMIT_COPY })
    }
  })
}

function sendPart(sender: Electron.WebContents, sessionId: string, part: UIMessageChunk): void {
  sender.send('chat:part', { sessionId, part })
}

// convertToModelMessages is exported by `ai` and takes UIMessage[]. We import
// it lazily inside the function to keep module-load cost off the test path;
// also keeps the agent-loop module's import surface narrow.
import { convertToModelMessages } from 'ai'
function convertToModelMessagesSafe(
  messages: UIMessage[]
): ReturnType<typeof convertToModelMessages> {
  return convertToModelMessages(messages)
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

function isAskUserRejection(error: unknown): boolean {
  return error instanceof Error && /Run stopped before the user replied\./.test(error.message)
}
