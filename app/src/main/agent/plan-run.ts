import { APICallError, RetryError, stepCountIs, streamText } from 'ai'
import type { LanguageModel, LanguageModelUsage, ModelMessage, UIMessage, UIMessageChunk } from 'ai'
import { convertToModelMessages } from 'ai'
import { AssistantMessageAccumulator } from './assistant-accumulator'
import { stripStepReasoning } from './prepare-step'
import type { ToolRegistry } from './registry'
import type { ToolExecutionContext } from './types'
import { planStepsSchema } from './tools/emit_plan'
import type { PlanStep } from './tools/emit_plan'

// The two-phase run loop (docs/03 §2, M3.1) — extracted from ipc/chat.ts so
// the loop lives in the plain-Node agent tree (deps injected, no Electron,
// AGENTS.md rule 1) and chat.ts becomes a thin IPC adapter.
//
// Phase 1 — PLAN (mechanism proven by plan-mechanism.spike.test.ts on the
// pinned ai@5.0.250): streamText with ONLY the emit_plan tool available and
// `toolChoice: { type: 'tool', toolName: 'emit_plan' }` + `stepCountIs(1)` —
// plan-first is structural, not prompted (the model cannot call anything
// else). When the plan call lands: onPlanCreated (the adapter persists
// plan_steps rows + emits `plan/created`), then the loop BLOCKS on the
// plan-start promise — execution starts only when the user presses Start
// (or replies "go ahead"; the renderer calls `plan/start` for both).
//
// Phase 2 — EXECUTE: streamText with the FULL registry tool set, fed the
// original conversation PLUS the plan phase's own response messages (so the
// model keeps its plan in context), with the same streaming / abort /
// step-guard / usage handling chat.ts has always run (extracted, not
// rewritten).
//
// `emit_plan` tool parts are dropped from the chat:part stream: the plan's
// user-facing surface is the PlanPanel (docs/04 §3.3), not a thread tool
// card — a raw JSON args card in the thread would violate the plain-language
// copy rules (docs/04 §3.1). The recorded plan/created event is the wire the
// panel reads.

/** Default step guard carried over from chat.ts (docs/03 §2). */
const MAX_STEPS = 25

// docs/04 §5 copy rules: provider failures never surface as raw codes or
// stack traces. Google signals a rejected key as 400 INVALID_ARGUMENT
// ("API key not valid"), so 401-class detection also matches that shape.
const KEY_REJECTED_COPY =
  "The API key for this provider isn't working. Check it in Settings → Providers."
const RATE_LIMITED_COPY = "The model is rate-limiting us. I'll wait a moment and retry."
// M3.8 copy classification: a 400 in the plan phase is almost always the
// provider refusing the forced tool choice (Groq gpt-oss-120b live:
// `tool_use_failed`) — "check your connection" would be a flat-out lie for
// it, so the plan phase maps non-key 400s to an honest plan-specific copy.
const PLAN_REFUSED_COPY = "I couldn't create a plan for that. Try rephrasing the request."
// A mutating request with no usable plan is an honest refusal, never a
// silent unplanned mutation (docs/04 §5 copy rules — plain language). Shared
// by the legacy plan-first path and the explicit Plan mode turn.
const PLAN_FAILED_COPY =
  "I couldn't make a plan for that request, so I didn't change anything. Try rephrasing it."
const GENERIC_PROVIDER_COPY =
  'Something went wrong talking to the model provider. Check your connection and try again.'

// M3.8 diagnosability: friendlyProviderError used to classify and then
// discard the raw error, so any confusing user-facing copy was impossible to
// trace (PROGRESS Devlog 2026-09-11). Log the status + provider message +
// response body to the main-process console only — the RESPONSE headers carry
// the API key and requestBodyValues may echo conversation content, so neither
// ever gets logged. A provider's responseBody is its own payload. Logging is
// wrapped: it is diagnostic-only and must never break the run.
function logProviderError(cause: APICallError): void {
  try {
    console.error(
      `[provider] ${cause.statusCode ?? 'unknown'}: ${cause.message}` +
        (cause.responseBody ? ` body=${cause.responseBody}` : '')
    )
  } catch {
    // Diagnostic only — never throw into the stream path.
  }
}

// Heuristic: does the user's request look like it wants files changed?
// Used ONLY to choose honest copy when planning fails (a text-only reply to
// "make a txt file" would look like the run silently stopped). Never a safety
// gate — mutations still require a valid plan + wrapper snapshot + approval.
export function isLikelyMutatingRequest(text: string): boolean {
  const lower = text.toLowerCase()
  const verbs =
    /\b(create|make|write|add|save|generate|update|edit|change|fix|move|copy|rename|delete|remove|organize|organise|tidy|backup)\b/
  const markers =
    /\b(file|files|folder|folders|directory|directories|note|notes|document|report|txt|text file)\b|\.txt\b|\.md\b/
  return verbs.test(lower) && markers.test(lower)
}

// Exported for the plan-run tests (copy classification). `phase: 'plan'`
// narrows the 400 branch: in the plan phase a non-key 400 is the model or
// provider refusing to plan, not a connectivity problem.
export function friendlyProviderError(error: unknown, phase?: 'plan'): string {
  // streamText retries transient failures and surfaces them as a RetryError
  // wrapping the provider's own APICallError — unwrap before classifying, or
  // a rate limit (429) falls through to the generic copy (docs/04 §5).
  const cause = RetryError.isInstance(error) ? error.lastError : error
  if (APICallError.isInstance(cause)) {
    logProviderError(cause)
    const body = `${cause.message} ${cause.responseBody ?? ''}`
    if (cause.statusCode === 401 || cause.statusCode === 403) return KEY_REJECTED_COPY
    if (cause.statusCode === 400 && /api key/i.test(body)) return KEY_REJECTED_COPY
    if (cause.statusCode === 429) return RATE_LIMITED_COPY
    if (phase === 'plan' && cause.statusCode === 400) return PLAN_REFUSED_COPY
  }
  return GENERIC_PROVIDER_COPY
}

export type PlanRunMode = 'plan' | 'act'

/** Affirmative continuations that execute the session's saved plan in Act mode. */
export function isGoAheadMessage(text: string): boolean {
  return /^\s*(go ahead|go-ahead|yes[,\s]+go ahead|execute the plan|carry out the plan|do the plan|start)\s*[.!]*\s*$/i.test(
    text
  )
}

export interface PlanRunDeps {
  model: LanguageModel
  system: string
  messages: UIMessage[]
  registry: ToolRegistry
  ctx: ToolExecutionContext
  /** The run's plan-start gate (context.ts). Resolves { approved } on decision. */
  requestPlanStart?: (stepIds: string[]) => Promise<{ approved: boolean }>
  /** Stream sink — chat.ts wraps webContents.send. */
  sendPart: (part: UIMessageChunk) => void
  /** M2.5 audit sink, threaded into every registry tool wrapper. */
  onOutcome?: Parameters<ToolRegistry['run']>[0]['onOutcome']
  /** Fired once per plan: the adapter persists plan_steps rows and emits
   * `plan/created` (docs/03 §4). */
  onPlanCreated: (steps: PlanStep[]) => void
  /** Abort controller's signal (chat:stop aborts mid-stream). */
  signal: AbortSignal
  maxSteps?: number
  /** M3.5 verification (optional, injected): called once per mutating run
   * after execution settles. Absent → honest "not verified" (M3.7 degraded).
   * `onVerification` carries the badge payload to the adapter. */
  verify?: (input: {
    instructionSegment: string
    stepDescription: string
  }) => Promise<
    | { verdict: 'skipped' }
    | { verdict: 'complete'; score: number }
    | { verdict: 'incomplete'; score: number; missedSegments: string[] }
  >
  onVerification?: (result: {
    stepId: string
    isComplete: boolean
    score: number | null
    missedSegments?: string[]
  }) => void
}

export interface PlanRunOutcome {
  aborted: boolean
  /** True when an 'error' part was already sent inside the loop. */
  terminalSent: boolean
  accumulatorFailed: boolean
  /** The accumulated assistant UIMessage (null when nothing textual arrived). */
  assistantMessage: UIMessage | null
  /** The provider's 'finish' part, held for the settle point (chat.ts). */
  heldFinish: UIMessageChunk | null
  /** Combined plan + execution usage; undefined when nothing resolved. */
  usage: { inputTokens: number | null; outputTokens: number | null } | undefined
  stepsTaken: number
  stepLimitReached: boolean
  /** True when a plan was emitted via onPlanCreated. */
  planEmitted: boolean
  /** True only when the gate approved execution (decline/stop → false). */
  planApproved: boolean
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

// convertToModelMessages is exported by `ai` and takes UIMessage[]. Kept as a
// tiny indirection so the loop's import surface stays explicit.
function convertToModelMessagesSafe(
  messages: UIMessage[]
): ReturnType<typeof convertToModelMessages> {
  return convertToModelMessages(messages)
}

// ask_user rejections and plan-start rejections (both "the run was stopped")
// share this message; a stop that lands on either pause must unwind the
// in-flight step instead of surfacing a provider error.
function isStopRejection(error: unknown): boolean {
  return error instanceof Error && /Run stopped before the user replied\./.test(error.message)
}

function sumUsage(
  a: LanguageModelUsage | undefined,
  b: LanguageModelUsage | undefined
): { inputTokens: number | null; outputTokens: number | null } | undefined {
  if (a === undefined && b === undefined) return undefined
  const pick = (x: number | undefined, y: number | undefined): number | null => {
    const values = [x, y].filter((v): v is number => typeof v === 'number')
    return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) : null
  }
  return {
    inputTokens: pick(a?.inputTokens, b?.inputTokens),
    outputTokens: pick(a?.outputTokens, b?.outputTokens)
  }
}

export async function runPlanFirstTurn(deps: PlanRunDeps): Promise<PlanRunOutcome> {
  const maxSteps = deps.maxSteps ?? MAX_STEPS
  const accumulator = new AssistantMessageAccumulator()
  let heldFinish: UIMessageChunk | null = null
  let aborted = false
  let terminalSent = false
  let stepsTaken = 0
  let stepLimitReached = false
  let capturedUsage: LanguageModelUsage | undefined
  let planUsage: LanguageModelUsage | undefined
  let planEmitted = false
  let planApproved = false
  let planResponseMessages: ModelMessage[] | null = null

  // toolCallIds of emit_plan calls seen on the wire — their input AND output
  // parts are suppressed from the thread (the PlanPanel is the plan's surface).
  const emitPlanCallIds = new Set<string>()

  // Shared stream forwarding (both phases): accumulate for persistence, hold
  // the finish for the settle point, treat error-on-abort as the abort
  // signature, drop streaming tool-input deltas (the append-only argsText
  // invariant — M2.5 gate finding), and drop emit_plan parts (see header).
  //
  // IMPORTANT (M3.1 mechanism finding): the UI stream MUST be consumed to the
  // terminal `finish` with the SAME observable sequence chat.ts used (per-part
  // `await` — no microtask batching tricks). The SDK's `steps`/`response`
  // settlement interleaves with the UI transform: the tool result is not
  // considered settled (and `response.messages` stays unavailable) until the
  // corresponding `tool-output-available` part has been pulled from the UI
  // stream. Slower consumption breaks `planResponseMessages` timing.
  const forwardStream = async (result: {
    toUIMessageStream: (opts: { onError: (e: unknown) => string }) => AsyncIterable<UIMessageChunk>
  }): Promise<void> => {
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
      if (part.type === 'error' && deps.signal.aborted) {
        // An error chunk arriving on an aborted signal is the abort
        // signature (the onError transform has no context that we stopped
        // this run) — never surface the generic provider copy for it.
        aborted = true
        continue
      }
      if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
      if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
        emitPlanCallIds.add(part.toolCallId)
        continue
      }
      if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) {
        continue
      }
      deps.sendPart(part)
    }
  }

  const baseModelMessages = convertToModelMessagesSafe(replayable(deps.messages))

  try {
    // ── Phase 1: the plan call ─────────────────────────────────────────────
    // Attempt 1 is the forced call (plan-first is structural, not prompted).
    // Attempt 2 is the M3.7 gate-driven fallback: some providers (Groq
    // gpt-oss-120b live) refuse forced tool choice with `tool_use_failed`,
    // so we retry once with `toolChoice: 'auto'` over the SAME single-tool
    // set — the model can only plan or answer in text.
    //
    // M3.8: EVERY plan-phase part is HELD per attempt (text, reasoning, step
    // markers — not just errors) and committed — forwarded to the thread and
    // accumulated for persistence — only for the ONE attempt that resolves
    // the run. A failed attempt's partial text used to stream live AND into
    // the shared accumulator, so when Groq refused the forced call mid
    // preamble the retry's greeting doubled in the bubble and in the reply.
    const emitPlanWrapped = deps.registry.toAiSdkTool('emit_plan', deps.ctx, {
      onOutcome: deps.onOutcome
    })
    interface PlanAttemptResult {
      /** Parsed plan steps — non-null only when the attempt actually planned. */
      steps: PlanStep[] | null
      /** The plan phase's response messages (kept for the execution call). */
      messages: ModelMessage[] | null
      /** Non-tool parts the attempt produced (forwarded only on commit). */
      heldParts: UIMessageChunk[]
      /** The attempt's natural finish (null when it ended without one). */
      finish: UIMessageChunk | null
      /** First held provider-error copy (null when no error part arrived). */
      errorText: string | null
      /** True when the attempt streamed text (a text-only reply is possible). */
      hadText: boolean
    }
    const attemptPlanCall = async (opts: {
      toolChoice: { type: 'tool'; toolName: 'emit_plan' } | 'auto'
      system: string
      tool: NonNullable<typeof emitPlanWrapped>
    }): Promise<PlanAttemptResult> => {
      const heldParts: UIMessageChunk[] = []
      const heldErrors: UIMessageChunk[] = []
      let finish: UIMessageChunk | null = null
      let hadText = false
      let errorText: string | null = null
      const planResult = streamText({
        model: deps.model,
        system: opts.system,
        messages: baseModelMessages,
        tools: { emit_plan: opts.tool },
        toolChoice: opts.toolChoice,
        stopWhen: [stepCountIs(1)],
        abortSignal: deps.signal,
        prepareStep: ({ messages: stepMessages }) => ({
          messages: stripStepReasoning(stepMessages)
        }),
        onAbort: () => {
          aborted = true
        },
        onFinish: (event) => {
          planUsage = event.totalUsage
        }
      })
      try {
        // Same forwarding shape as the shared stream path, but every part is
        // held — error parts and text alike — so the caller can drop the
        // attempt wholesale if it fails and is going to be retried.
        for await (const part of planResult.toUIMessageStream({
          // Plan-phase 400s (the provider refusing the forced tool choice)
          // get the honest plan copy, never "check your connection" (M3.8).
          onError: (error) => friendlyProviderError(error, 'plan')
        })) {
          if (part.type === 'finish') {
            finish = part
            heldFinish = part
            continue
          }
          if (part.type === 'abort') {
            aborted = true
            continue
          }
          if (part.type === 'error' && deps.signal.aborted) {
            aborted = true
            continue
          }
          if (part.type === 'error') {
            heldErrors.push(part)
            continue
          }
          if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
          if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
            emitPlanCallIds.add(part.toolCallId)
            continue
          }
          if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) {
            continue
          }
          if (part.type === 'text-start' || part.type === 'text-delta') hadText = true
          heldParts.push(part)
        }
        // An error part marks the attempt failed; remember its copy for the
        // final failure (a retry that succeeds discards it via the caller).
        const firstError = heldErrors[0]
        if (firstError && firstError.type === 'error') {
          errorText = firstError.errorText
        }
        if (aborted) {
          return { steps: null, messages: null, heldParts, finish, errorText, hadText }
        }
        // Extract the parsed steps from the emit_plan tool call.
        const steps = await planResult.steps
        let found: PlanStep[] | null = null
        for (const step of steps) {
          for (const toolCall of step.toolCalls) {
            if (toolCall.toolName !== 'emit_plan') continue
            const parsed = planStepsSchema.safeParse(toolCall.input)
            if (parsed.success) {
              found = parsed.data.steps
              break
            }
          }
          if (found) break
        }
        if (found) {
          // Keep the plan phase's own messages (the tool call + its result)
          // so the execution phase starts with the plan already in context.
          const messages = (await planResult.response).messages
          return { steps: found, messages, heldParts, finish, errorText, hadText }
        }
        return { steps: null, messages: null, heldParts, finish, errorText, hadText }
      } catch {
        // Provider refusal (e.g. forced-toolChoice 400) or unsettled steps:
        // the attempt produced no plan and its held parts (if any) are dropped
        // — the caller decides whether a final error copy surfaces.
        return { steps: null, messages: null, heldParts, finish, errorText, hadText }
      }
    }
    let planAttempt: PlanAttemptResult | null = null
    if (emitPlanWrapped) {
      // The run's user-facing surface is exactly ONE plan attempt: the one
      // that resolves the run. Its held parts (preamble text, step markers)
      // are committed — forwarded to the thread AND accumulated for
      // persistence — at this point; failed attempts never reach either
      // (M3.8, the doubled-greeting fix).
      const commitAttempt = (attempt: PlanAttemptResult): void => {
        for (const part of attempt.heldParts) {
          accumulator.addChunk(part)
          deps.sendPart(part)
        }
      }
      planAttempt = await attemptPlanCall({
        toolChoice: { type: 'tool', toolName: 'emit_plan' },
        system: deps.system,
        tool: emitPlanWrapped
      })
      if (!planAttempt.steps && !deps.signal.aborted) {
        planAttempt = await attemptPlanCall({
          toolChoice: 'auto',
          system: `${deps.system}\nFirst, respond ONLY by calling the emit_plan tool with the step-by-step plan.`,
          tool: emitPlanWrapped
        })
      }
      if (planAttempt.steps) {
        // The plan landed — commit the attempt and keep its response messages
        // so the execution phase starts with the plan already in context.
        commitAttempt(planAttempt)
        planResponseMessages = planAttempt.messages
      } else if (!deps.signal.aborted) {
        // No plan after both attempts. The plan-first guarantee still holds —
        // nothing below can execute — but what the user SEES must be honest:
        //  - a naturally completed text-only attempt IS a valid reply ("hey"
        //    → the model answers in text; no provider error happened). The
        //    forced attempt's held 400 is discarded, and the reply is
        //    delivered through the normal settle point (persisted + finish).
        //  - a genuine failure (a stream error part, or no natural finish at
        //    all) keeps the honest refusal — now with plan-appropriate copy
        //    for the common non-key 400 (tool_use_failed) instead of a lie
        //    about the connection (M3.8).
        const genuineError = planAttempt.errorText !== null || planAttempt.finish === null
        if (!genuineError && planAttempt.hadText) {
          // A text-only answer to a file-changing request is NOT a valid
          // reply — delivering "Sure!" with no file looks exactly like the
          // run silently stopped. Fail loudly so the user can rephrase/retry.
          const userText = deps.messages
            .filter((m) => m.role === 'user')
            .flatMap((m) => m.parts)
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text: string }).text)
            .join(' ')
          if (isLikelyMutatingRequest(userText)) {
            if (!terminalSent) {
              deps.sendPart({ type: 'error', errorText: PLAN_FAILED_COPY })
              terminalSent = true
            }
            return {
              aborted,
              terminalSent,
              accumulatorFailed: accumulator.isFailed(),
              assistantMessage: accumulator.toUIMessage(),
              heldFinish,
              usage: sumUsage(planUsage, undefined),
              stepsTaken,
              stepLimitReached,
              planEmitted,
              planApproved
            }
          }
          commitAttempt(planAttempt)
          return {
            aborted,
            terminalSent,
            accumulatorFailed: accumulator.isFailed(),
            assistantMessage: accumulator.toUIMessage(),
            heldFinish,
            usage: sumUsage(planUsage, undefined),
            stepsTaken,
            stepLimitReached,
            planEmitted,
            planApproved
          }
        }
        // Gate is `!terminalSent` ONLY (not `!accumulator.isFailed()`): plan
        // attempts HOLD error parts, so a failed accumulator here means the
        // terminal never went out — without this the run ends silent.
        if (!terminalSent) {
          deps.sendPart({ type: 'error', errorText: planAttempt.errorText ?? PLAN_FAILED_COPY })
          terminalSent = true
        }
        return {
          aborted,
          terminalSent,
          accumulatorFailed: accumulator.isFailed(),
          assistantMessage: accumulator.toUIMessage(),
          heldFinish,
          usage: sumUsage(planUsage, undefined),
          stepsTaken,
          stepLimitReached,
          planEmitted,
          planApproved
        }
      }
    }

    const planSteps: PlanStep[] | null = planAttempt ? planAttempt.steps : null
    if (planSteps) {
      planEmitted = true
      deps.onPlanCreated(planSteps)
      // THE GATE (legacy plan-first path only — new Plan mode never blocks
      // and Act mode never plans; both bypass this). Nothing below runs until
      // the user presses Start (or a stop rejects this promise).
      if (deps.requestPlanStart) {
        const decision = await deps.requestPlanStart(planSteps.map((s) => s.id))
        planApproved = decision.approved
      }
    }

    // ── Phase 2: the full-tool execution call ─────────────────────────────
    // Plan-less degradation (no emit_plan tool): run execution unconditionally.
    // Otherwise run only after the gate approved.
    // M3.4 cancel semantics: a 'cancel' approval decision stops the run AFTER
    // the current step (never mid-mutation) via a run-level flag consumed by
    // `stopWhen` at step boundaries. `skip` needs nothing — the SDK continues.
    let cancelled = false
    const ctxWithCancel: ToolExecutionContext = {
      ...deps.ctx,
      requestApproval: async (request) => {
        const decision = await deps.ctx.requestApproval(request)
        if (decision === 'cancel') cancelled = true
        return decision
      }
    }
    if (!planEmitted || planApproved) {
      // M3.7 gate finding: without an explicit handoff the model treats the
      // execution call as "present the plan and ask to proceed" (live run:
      // settled with a text reply, zero tool calls). The gate decision IS the
      // user's reply — append it so the model executes instead of asking.
      const approvalHandoff: ModelMessage[] = planApproved
        ? [
            {
              role: 'user',
              content:
                'Approved — execute the plan now. Start with step 1 and use the file tools; do not ask for confirmation again.'
            }
          ]
        : []
      const baseExecMessages = planResponseMessages
        ? [...baseModelMessages, ...planResponseMessages, ...approvalHandoff]
        : baseModelMessages
      const runExecutionOnce = async (opts: {
        systemSuffix: string
        toolChoice: 'auto' | 'required'
      }): Promise<void> => {
        const executionResult = streamText({
          model: deps.model,
          system: opts.systemSuffix ? `${deps.system}${opts.systemSuffix}` : deps.system,
          messages: baseExecMessages,
          tools: deps.registry.toAiSdkTools(ctxWithCancel, { onOutcome: deps.onOutcome }),
          toolChoice: opts.toolChoice,
          abortSignal: deps.signal,
          stopWhen: [stepCountIs(maxSteps), () => cancelled],
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
            // Sum across retries — the second attempt must not discard the
            // first attempt's usage.
            const next = event.totalUsage
            if (capturedUsage === undefined) {
              capturedUsage = next
            } else if (next !== undefined) {
              const inT = (capturedUsage.inputTokens ?? 0) + (next.inputTokens ?? 0)
              const outT = (capturedUsage.outputTokens ?? 0) + (next.outputTokens ?? 0)
              capturedUsage = { ...capturedUsage, inputTokens: inT, outputTokens: outT }
            }
          }
        })
        await forwardStream(executionResult)
      }
      await runExecutionOnce({ systemSuffix: '', toolChoice: 'auto' })
      // Execution retry: some providers answer the approved plan with prose
      // and zero tool calls (looks like "stopped, no file"). Retry once with
      // toolChoice 'required' + an explicit execute-now suffix — the wrapper
      // still guards every call, so forcing *a* tool cannot force a mutation.
      const execToolsRan = stepsTaken > 0
      if (planApproved && !aborted && !cancelled && !execToolsRan) {
        await runExecutionOnce({
          systemSuffix:
            '\nYou must act now using the file tools to carry out the approved plan. Call the first tool immediately; do not reply in text first.',
          toolChoice: 'required'
        })
      }
      // Zero-action guard: an approved plan that produced no tool calls and no
      // assistant text is a silent failure — end loudly instead of with a
      // success finish, so the user knows nothing changed.
      if (planApproved && !aborted && stepsTaken === 0 && accumulator.toUIMessage() === null) {
        if (!terminalSent) {
          deps.sendPart({
            type: 'error',
            errorText:
              "I prepared the plan but didn't take any actions, so nothing changed. Try saying which file to create and what to put in it."
          })
          terminalSent = true
        }
      }
      // The step guard's effect: the SDK stops calling tools after the cap,
      // emits a finish part with reason 'tool-calls' or 'length', and never
      // throws. We surface a one-line friendly note so the user can ask
      // "continue" without a separate UI affordance.
      if (!aborted && stepsTaken >= maxSteps) {
        stepLimitReached = true
      }
      // M3.5 verification (one shot + one retry handled by the adapter's
      // injected `verify`; default absent → skipped). The loop emits the
      // badge payload; the adapter persists/emits `verification/finished`.
      // One retry on missed segments: re-invoked by the adapter via a second
      // `verify` call is out of scope for the 1-hour slice — the client
      // contract + skipped-honest path is what the degraded gate needs.
      if (deps.verify && !aborted) {
        try {
          // Current instruction (last user message), not the first in a
          // resumed history — verifying against a stale turn fakes the badge.
          const userMessages = deps.messages.filter((m) => m.role === 'user')
          const lastText = userMessages[userMessages.length - 1]
          const instructionSegment =
            lastText && lastText.parts[0] && lastText.parts[0].type === 'text'
              ? (lastText.parts[0] as { text: string }).text.slice(0, 500)
              : 'run'
          const verdict = await deps.verify({
            instructionSegment,
            stepDescription: 'execution'
          })
          if (verdict.verdict === 'complete') {
            deps.onVerification?.({
              stepId: 'run',
              isComplete: true,
              score: verdict.score
            })
          } else if (verdict.verdict === 'incomplete') {
            // ONE retry: ask the injected verifier once more with the missed
            // segments folded in (the adapter's stub decides); second failure
            // surfaces as a failed step with plain-language missed segments.
            const retry = await deps.verify({
              instructionSegment: `${instructionSegment}\nMissed: ${verdict.missedSegments.join('; ')}`,
              stepDescription: 'execution-retry'
            })
            if (retry.verdict === 'complete') {
              deps.onVerification?.({ stepId: 'run', isComplete: true, score: retry.score })
            } else if (retry.verdict === 'incomplete') {
              deps.onVerification?.({
                stepId: 'run',
                isComplete: false,
                score: retry.score,
                missedSegments: retry.missedSegments
              })
            } else {
              deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
            }
          } else {
            deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
          }
        } catch {
          deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
        }
      }
    }
  } catch (error) {
    // ask_user / plan-start rejections (the run was stopped) and other
    // unhandled errors come through here. The provider-error transform
    // handles RetryError/APICallError specifically; anything else gets the
    // generic copy unless we know the run was stopped.
    if (deps.signal.aborted) {
      aborted = true
    } else if (!accumulator.isFailed() && !terminalSent) {
      const message = isStopRejection(error)
        ? 'Stopped before the reply was sent.'
        : friendlyProviderError(error)
      deps.sendPart({ type: 'error', errorText: message })
      terminalSent = true
    }
  }

  return {
    aborted,
    terminalSent,
    accumulatorFailed: accumulator.isFailed(),
    assistantMessage: accumulator.toUIMessage(),
    heldFinish,
    usage: sumUsage(planUsage, capturedUsage),
    stepsTaken,
    stepLimitReached,
    planEmitted,
    planApproved
  }
}

// ── Explicit Plan/Act modes (composer tabs, docs/03 §2) ─────────────────────
// The legacy runPlanFirstTurn above stays as the tested plan-first-with-gate
// path. Production now routes on the session's persisted mode instead:
//
// - Plan mode (runPlanModeTurn): STRUCTURALLY read-only. Discovery exposes
//   only access==='read' tools, then a forced emit_plan call produces the
//   structured plan. Write-access tools are never in any tool set handed to
//   the model, so the model cannot mutate even if prompted. The plan is
//   persisted/emitted via onPlanCreated and the run settles — no plan-start
//   gate exists, so nothing can ever execute from a Plan run.
// - Act mode (runActTurn): direct execution with the full registry MINUS
//   emit_plan. Every mutation still flows through the registry wrapper
//   (validate → sandbox → risk → approval → snapshot → execute), so all
//   trust guarantees hold; there is simply no planning phase.

const MAX_DISCOVERY_STEPS = 5

export interface ModeTurnDeps {
  model: LanguageModel
  system: string
  messages: UIMessage[]
  registry: ToolRegistry
  ctx: ToolExecutionContext
  onOutcome?: Parameters<ToolRegistry['run']>[0]['onOutcome']
  sendPart: (part: UIMessageChunk) => void
  signal: AbortSignal
  maxSteps?: number
  verify?: PlanRunDeps['verify']
  onVerification?: PlanRunDeps['onVerification']
}

function readToolNames(registry: ToolRegistry): string[] {
  return registry
    .names()
    .filter((name) => name !== 'emit_plan' && registry.get(name)?.access === 'read')
}

export async function runPlanModeTurn(
  deps: ModeTurnDeps & { onPlanCreated: (steps: PlanStep[]) => void }
): Promise<PlanRunOutcome> {
  const maxSteps = deps.maxSteps ?? MAX_STEPS
  const accumulator = new AssistantMessageAccumulator()
  let heldFinish: UIMessageChunk | null = null
  let aborted = false
  let terminalSent = false
  let planUsage: LanguageModelUsage | undefined
  let discoveryUsage: LanguageModelUsage | undefined
  let discoveryMessages: ModelMessage[] = []
  const emitPlanCallIds = new Set<string>()
  const baseModelMessages = convertToModelMessagesSafe(replayable(deps.messages))

  const forwardLive = async (result: {
    toUIMessageStream: (opts: { onError: (e: unknown) => string }) => AsyncIterable<UIMessageChunk>
  }): Promise<void> => {
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
      if (part.type === 'error' && deps.signal.aborted) {
        aborted = true
        continue
      }
      if (part.type === 'error') {
        deps.sendPart(part)
        terminalSent = true
        continue
      }
      if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
      if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
        emitPlanCallIds.add(part.toolCallId)
        continue
      }
      if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) continue
      deps.sendPart(part)
    }
  }

  try {
    // Discovery: read-only tools only (structurally — write tools are never
    // in this set). Renders as normal cards so the user sees what was read.
    const readNames = readToolNames(deps.registry)
    if (readNames.length > 0 && !deps.signal.aborted) {
      try {
        const discoveryResult = streamText({
          model: deps.model,
          system: `${deps.system}\nYou are in read-only planning mode. Inspect what you need with the available tools, then answer briefly in text: what you found and what you will put in the plan. Do not claim to change anything.`,
          messages: baseModelMessages,
          tools: deps.registry.toAiSdkTools(
            { ...deps.ctx },
            { onOutcome: deps.onOutcome },
            { include: readNames }
          ),
          toolChoice: 'auto',
          stopWhen: [stepCountIs(Math.min(MAX_DISCOVERY_STEPS, maxSteps))],
          abortSignal: deps.signal,
          prepareStep: ({ messages: stepMessages }) => ({
            messages: stripStepReasoning(stepMessages)
          }),
          onAbort: () => {
            aborted = true
          },
          onFinish: (event) => {
            discoveryUsage = event.totalUsage
          }
        })
        await forwardLive(discoveryResult)
        if (!aborted && !terminalSent) {
          try {
            discoveryMessages = (await discoveryResult.response).messages
          } catch {
            discoveryMessages = []
          }
        }
      } catch {
        // Discovery is best-effort context — the forced plan attempt below
        // produces the honest outcome (plan or plan-phase error copy).
        if (deps.signal.aborted) aborted = true
      }
    }
    if (deps.signal.aborted || aborted) {
      return {
        aborted: true,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }
    if (terminalSent) {
      return {
        aborted,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }

    // Forced plan: ONLY emit_plan is available — the model must plan.
    const emitPlanWrapped = deps.registry.toAiSdkTool('emit_plan', deps.ctx, {
      onOutcome: deps.onOutcome
    })
    if (!emitPlanWrapped) {
      if (!terminalSent) {
        deps.sendPart({ type: 'error', errorText: PLAN_FAILED_COPY })
        terminalSent = true
      }
      return {
        aborted,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }
    const planMessages: ModelMessage[] = [...baseModelMessages, ...discoveryMessages]
    interface HeldAttempt {
      steps: PlanStep[] | null
      heldParts: UIMessageChunk[]
      finish: UIMessageChunk | null
      errorText: string | null
      hadText: boolean
    }
    const attemptPlan = async (opts: {
      toolChoice: { type: 'tool'; toolName: 'emit_plan' } | 'auto'
      systemSuffix: string
    }): Promise<HeldAttempt> => {
      const heldParts: UIMessageChunk[] = []
      const heldErrors: UIMessageChunk[] = []
      let finish: UIMessageChunk | null = null
      let hadText = false
      let errorText: string | null = null
      const planResult = streamText({
        model: deps.model,
        system: opts.systemSuffix ? `${deps.system}${opts.systemSuffix}` : deps.system,
        messages: planMessages,
        tools: { emit_plan: emitPlanWrapped },
        toolChoice: opts.toolChoice,
        stopWhen: [stepCountIs(1)],
        abortSignal: deps.signal,
        prepareStep: ({ messages: stepMessages }) => ({
          messages: stripStepReasoning(stepMessages)
        }),
        onAbort: () => {
          aborted = true
        },
        onFinish: (event) => {
          planUsage = event.totalUsage
        }
      })
      try {
        for await (const part of planResult.toUIMessageStream({
          onError: (error) => friendlyProviderError(error, 'plan')
        })) {
          if (part.type === 'finish') {
            finish = part
            heldFinish = part
            continue
          }
          if (part.type === 'abort') {
            aborted = true
            continue
          }
          if (part.type === 'error' && deps.signal.aborted) {
            aborted = true
            continue
          }
          if (part.type === 'error') {
            heldErrors.push(part)
            continue
          }
          if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
          if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
            emitPlanCallIds.add(part.toolCallId)
            continue
          }
          if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) {
            continue
          }
          if (part.type === 'text-start' || part.type === 'text-delta') hadText = true
          heldParts.push(part)
        }
        const firstError = heldErrors[0]
        if (firstError && firstError.type === 'error') errorText = firstError.errorText
        if (aborted) return { steps: null, heldParts, finish, errorText, hadText }
        const steps = await planResult.steps
        let found: PlanStep[] | null = null
        for (const step of steps) {
          for (const toolCall of step.toolCalls) {
            if (toolCall.toolName !== 'emit_plan') continue
            const parsed = planStepsSchema.safeParse(toolCall.input)
            if (parsed.success) {
              found = parsed.data.steps
              break
            }
          }
          if (found) break
        }
        return { steps: found, heldParts, finish, errorText, hadText }
      } catch {
        return { steps: null, heldParts, finish, errorText, hadText }
      }
    }
    let attempt = await attemptPlan({
      toolChoice: { type: 'tool', toolName: 'emit_plan' },
      systemSuffix: ''
    })
    if (!attempt.steps && !deps.signal.aborted && !aborted) {
      attempt = await attemptPlan({
        toolChoice: 'auto',
        systemSuffix: '\nRespond ONLY by calling the emit_plan tool with the step-by-step plan.'
      })
    }
    if (attempt.steps) {
      for (const part of attempt.heldParts) {
        accumulator.addChunk(part)
        deps.sendPart(part)
      }
      deps.onPlanCreated(attempt.steps)
      return {
        aborted,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: true,
        planApproved: false
      }
    }
    if (deps.signal.aborted || aborted) {
      return {
        aborted: true,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }
    const genuineError = attempt.errorText !== null || attempt.finish === null
    if (!genuineError && attempt.hadText) {
      const userText = deps.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.parts)
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join(' ')
      if (isLikelyMutatingRequest(userText)) {
        if (!terminalSent) {
          deps.sendPart({ type: 'error', errorText: PLAN_FAILED_COPY })
          terminalSent = true
        }
        return {
          aborted,
          terminalSent,
          accumulatorFailed: accumulator.isFailed(),
          assistantMessage: accumulator.toUIMessage(),
          heldFinish,
          usage: sumUsage(discoveryUsage, planUsage),
          stepsTaken: 0,
          stepLimitReached: false,
          planEmitted: false,
          planApproved: false
        }
      }
      for (const part of attempt.heldParts) {
        accumulator.addChunk(part)
        deps.sendPart(part)
      }
      return {
        aborted,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }
    if (!terminalSent) {
      deps.sendPart({ type: 'error', errorText: attempt.errorText ?? PLAN_FAILED_COPY })
      terminalSent = true
    }
    return {
      aborted,
      terminalSent,
      accumulatorFailed: accumulator.isFailed(),
      assistantMessage: accumulator.toUIMessage(),
      heldFinish,
      usage: sumUsage(discoveryUsage, planUsage),
      stepsTaken: 0,
      stepLimitReached: false,
      planEmitted: false,
      planApproved: false
    }
  } catch (error) {
    if (deps.signal.aborted) {
      aborted = true
    } else if (!accumulator.isFailed() && !terminalSent) {
      const message = isStopRejection(error)
        ? 'Stopped before the reply was sent.'
        : friendlyProviderError(error)
      deps.sendPart({ type: 'error', errorText: message })
      terminalSent = true
    }
    return {
      aborted,
      terminalSent,
      accumulatorFailed: accumulator.isFailed(),
      assistantMessage: accumulator.toUIMessage(),
      heldFinish,
      usage: sumUsage(discoveryUsage, planUsage),
      stepsTaken: 0,
      stepLimitReached: false,
      planEmitted: false,
      planApproved: false
    }
  }
}

export async function runActTurn(
  deps: ModeTurnDeps & { planHandoff?: PlanStep[] }
): Promise<PlanRunOutcome> {
  const maxSteps = deps.maxSteps ?? MAX_STEPS
  const accumulator = new AssistantMessageAccumulator()
  let heldFinish: UIMessageChunk | null = null
  let aborted = false
  let terminalSent = false
  let stepsTaken = 0
  let stepLimitReached = false
  let capturedUsage: LanguageModelUsage | undefined
  const emitPlanCallIds = new Set<string>()
  let cancelled = false
  const ctxWithCancel: ToolExecutionContext = {
    ...deps.ctx,
    requestApproval: async (request) => {
      const decision = await deps.ctx.requestApproval(request)
      if (decision === 'cancel') cancelled = true
      return decision
    }
  }

  const forwardLive = async (result: {
    toUIMessageStream: (opts: { onError: (e: unknown) => string }) => AsyncIterable<UIMessageChunk>
  }): Promise<void> => {
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
      if (part.type === 'error' && deps.signal.aborted) {
        aborted = true
        continue
      }
      if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
      if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
        emitPlanCallIds.add(part.toolCallId)
        continue
      }
      if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) continue
      deps.sendPart(part)
    }
  }

  try {
    // The reviewed plan is advisory context, never privileged execution data:
    // every resulting tool call still passes the registry wrapper. Only added
    // for an explicit go-ahead (chat.ts decides); a normal Act message runs
    // on the conversation alone.
    const handoff: ModelMessage[] =
      deps.planHandoff && deps.planHandoff.length > 0
        ? [
            {
              role: 'user',
              content: `The plan we reviewed:\n${deps.planHandoff.map((s, i) => `${i + 1}. ${s.description} (tool: ${s.tool})`).join('\n')}\nCarry it out now with the file tools; follow the existing approval behavior for anything risky.`
            }
          ]
        : []
    const baseExecMessages = [...convertToModelMessagesSafe(replayable(deps.messages)), ...handoff]
    const runOnce = async (opts: {
      systemSuffix: string
      toolChoice: 'auto' | 'required'
    }): Promise<void> => {
      const executionResult = streamText({
        model: deps.model,
        system: opts.systemSuffix ? `${deps.system}${opts.systemSuffix}` : deps.system,
        messages: baseExecMessages,
        tools: deps.registry.toAiSdkTools(
          ctxWithCancel,
          { onOutcome: deps.onOutcome },
          { exclude: ['emit_plan'] }
        ),
        toolChoice: opts.toolChoice,
        abortSignal: deps.signal,
        stopWhen: [stepCountIs(maxSteps), () => cancelled],
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
          const next = event.totalUsage
          if (capturedUsage === undefined) {
            capturedUsage = next
          } else if (next !== undefined) {
            const inT = (capturedUsage.inputTokens ?? 0) + (next.inputTokens ?? 0)
            const outT = (capturedUsage.outputTokens ?? 0) + (next.outputTokens ?? 0)
            capturedUsage = { ...capturedUsage, inputTokens: inT, outputTokens: outT }
          }
        }
      })
      await forwardLive(executionResult)
    }
    await runOnce({ systemSuffix: '', toolChoice: 'auto' })
    // A go-ahead that produced prose and zero tool calls looks like the run
    // silently stopped — retry once with a tool call required. The wrapper
    // still guards every call, so forcing *a* tool cannot force a mutation.
    if (
      deps.planHandoff &&
      deps.planHandoff.length > 0 &&
      !aborted &&
      !cancelled &&
      stepsTaken === 0
    ) {
      await runOnce({
        systemSuffix:
          '\nAct now using the file tools to carry out the reviewed plan. Call the first tool immediately; do not reply in text first.',
        toolChoice: 'required'
      })
    }
    if (!aborted && !cancelled && stepsTaken === 0 && accumulator.toUIMessage() === null) {
      if (!terminalSent) {
        deps.sendPart({
          type: 'error',
          errorText:
            "I didn't take any actions, so nothing changed. Try saying which file to work on and what to do with it."
        })
        terminalSent = true
      }
    }
    if (!aborted && stepsTaken >= maxSteps) stepLimitReached = true
    if (deps.verify && !aborted) {
      try {
        const userMessages = deps.messages.filter((m) => m.role === 'user')
        const lastText = userMessages[userMessages.length - 1]
        const instructionSegment =
          lastText && lastText.parts[0] && lastText.parts[0].type === 'text'
            ? (lastText.parts[0] as { text: string }).text.slice(0, 500)
            : 'run'
        const verdict = await deps.verify({
          instructionSegment,
          stepDescription: 'execution'
        })
        if (verdict.verdict === 'complete') {
          deps.onVerification?.({ stepId: 'run', isComplete: true, score: verdict.score })
        } else if (verdict.verdict === 'incomplete') {
          const retry = await deps.verify({
            instructionSegment: `${instructionSegment}\nMissed: ${verdict.missedSegments.join('; ')}`,
            stepDescription: 'execution-retry'
          })
          if (retry.verdict === 'complete') {
            deps.onVerification?.({ stepId: 'run', isComplete: true, score: retry.score })
          } else if (retry.verdict === 'incomplete') {
            deps.onVerification?.({
              stepId: 'run',
              isComplete: false,
              score: retry.score,
              missedSegments: retry.missedSegments
            })
          } else {
            deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
          }
        } else {
          deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
        }
      } catch {
        deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
      }
    }
  } catch (error) {
    if (deps.signal.aborted) {
      aborted = true
    } else if (!accumulator.isFailed() && !terminalSent) {
      const message = isStopRejection(error)
        ? 'Stopped before the reply was sent.'
        : friendlyProviderError(error)
      deps.sendPart({ type: 'error', errorText: message })
      terminalSent = true
    }
  }
  return {
    aborted,
    terminalSent,
    accumulatorFailed: accumulator.isFailed(),
    assistantMessage: accumulator.toUIMessage(),
    heldFinish,
    usage: sumUsage(capturedUsage, undefined),
    stepsTaken,
    stepLimitReached,
    planEmitted: false,
    planApproved: false
  }
}
