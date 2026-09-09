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
const GENERIC_PROVIDER_COPY =
  'Something went wrong talking to the model provider. Check your connection and try again.'

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

export interface PlanRunDeps {
  model: LanguageModel
  system: string
  messages: UIMessage[]
  registry: ToolRegistry
  ctx: ToolExecutionContext
  /** The run's plan-start gate (context.ts). Resolves { approved } on decision. */
  requestPlanStart: (stepIds: string[]) => Promise<{ approved: boolean }>
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

  // A mutating request with no usable plan is an honest refusal, never a
  // silent unplanned mutation (docs/04 §5 copy rules — plain language).
  const PLAN_FAILED_COPY =
    "I couldn't make a plan for that request, so I didn't change anything. Try rephrasing it."

  try {
    // ── Phase 1: the plan call ─────────────────────────────────────────────
    // Attempt 1 is the forced call (plan-first is structural, not prompted).
    // Attempt 2 is the M3.7 gate-driven fallback: some providers (Groq
    // gpt-oss-120b live) refuse forced tool choice with `tool_use_failed`,
    // so we retry once with `toolChoice: 'auto'` over the SAME single-tool
    // set — the model can only plan or answer in text. Both attempts hold
    // error parts (the first attempt's failure must not pollute the thread
    // when the retry succeeds); only the final failure forwards one.
    const emitPlanWrapped = deps.registry.toAiSdkTool('emit_plan', deps.ctx, {
      onOutcome: deps.onOutcome
    })
    let planErrorText: string | null = null
    const attemptPlanCall = async (opts: {
      toolChoice: { type: 'tool'; toolName: 'emit_plan' } | 'auto'
      system: string
      tool: NonNullable<typeof emitPlanWrapped>
    }): Promise<{ steps: PlanStep[]; messages: ModelMessage[] } | null> => {
      const holdErrors: UIMessageChunk[] = []
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
        // Same forwarding as the shared stream path, but error parts are
        // HELD (not sent): a first-attempt provider refusal must not land in
        // the thread when the retry succeeds.
        for await (const part of planResult.toUIMessageStream({
          onError: friendlyProviderError
        })) {
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
            holdErrors.push(part)
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
          return { steps: found, messages }
        }
      } catch {
        // Provider refusal (e.g. forced-toolChoice 400) or unsettled steps:
        // hold the error for a possible retry; the caller decides.
        const first = holdErrors[0]
        if (first && first.type === 'error' && planErrorText === null) {
          planErrorText = first.errorText
        }
        return null
      }
      if (holdErrors.length > 0 && planErrorText === null) {
        const first = holdErrors[0]
        if (first && first.type === 'error') planErrorText = first.errorText
      }
      return null
    }
    let planResult2: { steps: PlanStep[]; messages: ModelMessage[] } | null = null
    if (emitPlanWrapped) {
      const forced = await attemptPlanCall({
        toolChoice: { type: 'tool', toolName: 'emit_plan' },
        system: deps.system,
        tool: emitPlanWrapped
      })
      planResult2 = forced
      if (!planResult2 && !deps.signal.aborted) {
        planResult2 = await attemptPlanCall({
          toolChoice: 'auto',
          system: `${deps.system}\nFirst, respond ONLY by calling the emit_plan tool with the step-by-step plan.`,
          tool: emitPlanWrapped
        })
      }
      if (planResult2) {
        planResponseMessages = planResult2.messages
      }
      if (!planResult2 && !deps.signal.aborted) {
        // The tool exists but the model produced no plan twice: refuse
        // honestly instead of mutating without a plan. (Plan-less execution
        // below stays reserved for the no-emit_plan-tool case — tests/dev.)
        // Gate is `!terminalSent` ONLY (not `!accumulator.isFailed()`): plan
        // attempts HOLD error parts, so a failed accumulator here means the
        // terminal never went out — without this the run ends silent.
        if (!terminalSent) {
          deps.sendPart({ type: 'error', errorText: planErrorText ?? PLAN_FAILED_COPY })
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

    const planSteps: PlanStep[] | null = planResult2 ? planResult2.steps : null
    if (planSteps) {
      planEmitted = true
      deps.onPlanCreated(planSteps)
      // THE GATE: nothing below runs until the user presses Start (or a stop
      // rejects this promise — chat:stop unwinds it like a paused ask_user).
      const decision = await deps.requestPlanStart(planSteps.map((s) => s.id))
      planApproved = decision.approved
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
      const executionResult = streamText({
        model: deps.model,
        system: deps.system,
        messages: planResponseMessages
          ? [...baseModelMessages, ...planResponseMessages, ...approvalHandoff]
          : baseModelMessages,
        tools: deps.registry.toAiSdkTools(ctxWithCancel, { onOutcome: deps.onOutcome }),
        toolChoice: 'auto',
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
          capturedUsage = event.totalUsage
        }
      })
      await forwardStream(executionResult)
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
          const firstText = deps.messages.find((m) => m.role === 'user')
          const instructionSegment =
            firstText && firstText.parts[0] && firstText.parts[0].type === 'text'
              ? (firstText.parts[0] as { text: string }).text.slice(0, 500)
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
