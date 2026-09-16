import { describe, expect, it, vi } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { APICallError, RetryError } from 'ai'
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { createToolRegistry, ToolFailureError } from './registry'
import { buildRunContext, newRunId } from './context'
import { friendlyProviderError, runPlanFirstTurn } from './plan-run'
import type { PlanRunDeps, PlanRunOutcome } from './plan-run'
import { emitPlanTool } from './tools/emit_plan'
import type { PlanStep } from './tools/emit_plan'
import type { ToolDefinition } from './types'

// The two-phase loop (docs/03 §2, M3.1) with NO network and NO real provider
// (MockLanguageModelV2, same recipe as the M3.0 spike). Proves the contract:
// a plan-first run emits the plan via onPlanCreated, BLOCKS on the plan-start
// gate (execution starts only after the promise resolves), executes with the
// full tool set after approval, and executes NOTHING on a decline.

// ── Scripted provider turns ────────────────────────────────────────────────
const PLAN_STEPS = {
  steps: [
    {
      id: 's1',
      description: 'Move the PDF invoices into a folder called Finance',
      tool: 'stub_action',
      riskLevel: 0,
      requiresApproval: false
    }
  ]
}

function twoMockTurns(): { plan: object; exec: object; execFollowup: object } {
  // Like the M3.0 spike: literal stream shapes inline (no `as const` — the
  // union must see them as widenable candidates). Explicitly annotated as
  // the provider-v2 stream parts so `simulateReadableStream` receives the
  // exact union member types (not widened strings — a contextual-typing
  // collapse that bites when chunks pass through a helper boundary).
  const planChunks: LanguageModelV2StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'plan-1', toolName: 'emit_plan' },
    { type: 'tool-input-delta', id: 'plan-1', delta: JSON.stringify(PLAN_STEPS) },
    { type: 'tool-input-end', id: 'plan-1' },
    {
      type: 'tool-call',
      toolCallId: 'plan-1',
      toolName: 'emit_plan',
      input: JSON.stringify(PLAN_STEPS)
    },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
    }
  ]
  const execChunks: LanguageModelV2StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'act-1', toolName: 'stub_action' },
    { type: 'tool-input-delta', id: 'act-1', delta: '{}' },
    { type: 'tool-input-end', id: 'act-1' },
    { type: 'tool-call', toolCallId: 'act-1', toolName: 'stub_action', input: '{}' },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
    }
  ]
  // After the tool result returns to the model, the mock must give the loop
  // one more scripted turn: post-tool text + natural finish (finish-reason
  // 'stop'). Without it the SDK retries the tool turn and the mock exhausts
  // its turns — mirroring what a real provider does after a tool call.
  const execFollowupChunks: LanguageModelV2StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'act-text-1' },
    { type: 'text-delta', id: 'act-text-1', delta: 'done' },
    { type: 'text-end', id: 'act-text-1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
    }
  ]
  return {
    plan: { stream: simulateReadableStream({ chunks: planChunks }) },
    exec: { stream: simulateReadableStream({ chunks: execChunks }) },
    execFollowup: { stream: simulateReadableStream({ chunks: execFollowupChunks }) }
  }
}

let executed = 0
const stubAction: ToolDefinition<{ confirm: boolean }, { done: boolean }> = {
  name: 'stub_action',
  description: 'A stub execution tool that records it ran',
  access: 'read',
  inputSchema: z
    .object({
      confirm: z
        .boolean()
        .nullish()
        .transform((v) => v ?? false)
    })
    .default({ confirm: false }),
  pathFields: [],
  risk: () => ({ level: 0, reason: 'stub' }),
  describe: () => ({ title: 'Stub action', group: 'test' }),
  execute: async () => {
    executed += 1
    return { ok: true, output: { done: true } }
  }
}

function twoTurnModel(): MockLanguageModelV2 {
  // Like the M3.0 spike: literal stream shapes inline at the doStream site
  // so they contextually match the LanguageModelV2 stream-part union.
  // Per-fixture factory so every test gets fresh turns.
  const turns = twoMockTurns()
  const streams = [turns.plan, turns.exec, turns.execFollowup]
  return new MockLanguageModelV2({
    provider: 'mock',
    modelId: 'plan-run-test',
    doStream: async () => {
      const next = streams.shift()
      if (!next) throw new Error('unexpected extra doStream call')
      return next as never
    }
  })
}

const USER_MESSAGES = [
  { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'organize my files' }] }
]

interface Fixture {
  run: ReturnType<typeof buildRunContext>
  sentParts: UIMessageChunk[]
  planEvents: PlanStep[][]
  model: MockLanguageModelV2
  start: (deps?: Partial<PlanRunDeps>) => Promise<PlanRunOutcome>
}

function fixture(): Fixture {
  const run = buildRunContext({
    sender: { emit: () => undefined },
    sessionId: 's-planrun',
    runId: newRunId(),
    workspaceRoot: 'C:/ws'
  })
  const registry = createToolRegistry()
  registry.define(emitPlanTool)
  registry.define(stubAction)
  const sentParts: UIMessageChunk[] = []
  const planEvents: PlanStep[][] = []
  const model = twoTurnModel()
  const start = (deps?: Partial<PlanRunDeps>): Promise<PlanRunOutcome> =>
    runPlanFirstTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      requestPlanStart: (ids) => run.requestPlanStart(ids),
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: (steps) => planEvents.push(steps),
      signal: new AbortController().signal,
      ...deps
    })
  return { run, sentParts, planEvents, model, start }
}

describe('runPlanFirstTurn — the plan-first loop', () => {
  it('emits the plan, blocks on the gate, and executes only after approval', async () => {
    executed = 0
    const f = fixture()
    const outcomePromise = f.start()

    // Phase 1 completes: the plan arrives BEFORE the gate resolves — and
    // NOTHING executes while it pends: no second model call, no stub run.
    await vi.waitFor(() => expect(f.planEvents).toHaveLength(1))
    expect(f.planEvents[0]?.[0]).toMatchObject({ id: 's1', tool: 'stub_action' })
    expect(f.model.doStreamCalls.length).toBe(1)
    expect(executed).toBe(0)

    // The user presses Start.
    expect(f.run.resolvePlanStart(true)).toBe(true)
    const outcome = await outcomePromise

    // Phase 2 ran: second model call, stub executed, gate recorded approved.
    expect(outcome.planEmitted).toBe(true)
    expect(outcome.planApproved).toBe(true)
    expect(outcome.aborted).toBe(false)
    expect(executed).toBe(1)
    expect(f.model.doStreamCalls.length).toBe(3)

    // The execution call kept the plan in context (plan response messages
    // appended after the original conversation).
    const execCall = f.model.doStreamCalls[1]
    expect(JSON.stringify(execCall?.prompt)).toContain('emit_plan')

    // emit_plan's raw JSON parts are suppressed from the thread (the
    // PlanPanel is the plan's surface); the stub's parts flow normally.
    const toolNames = f.sentParts
      .filter((p) => p.type === 'tool-input-available')
      .map((p) => (p as { toolName: string }).toolName)
    expect(toolNames).toContain('stub_action')
    expect(toolNames).not.toContain('emit_plan')

    // Terminal handling (single-terminal contract — chat.ts settle sends it):
    // both phases HOLD their finish (never on the wire mid-run); the outcome
    // carries the execution phase's finish and chat.ts sends exactly one.
    expect(f.sentParts.filter((p) => p.type === 'finish')).toHaveLength(0)
    expect(outcome.heldFinish).not.toBeNull()
    expect(outcome.heldFinish?.type).toBe('finish')
    // Usage is the SUM of the plan and execution phases.
    expect(outcome.usage).toEqual({ inputTokens: 115, outputTokens: 225 })
  })

  it('declined gate → no execution at all, run ends with the phase-1 finish', async () => {
    executed = 0
    const f = fixture()
    const outcomePromise = f.start()
    await vi.waitFor(() => expect(f.planEvents).toHaveLength(1))
    expect(f.run.resolvePlanStart(false)).toBe(true)
    const outcome = await outcomePromise

    expect(outcome.planEmitted).toBe(true)
    expect(outcome.planApproved).toBe(false)
    expect(executed).toBe(0)
    expect(f.model.doStreamCalls.length).toBe(1) // never a second call
    // The plan phase's own finish is the natural terminal (held for settle —
    // a decline is not an error — card 05 refines the deny copy).
    expect(outcome.heldFinish).not.toBeNull()
    expect(outcome.heldFinish?.type).toBe('finish')
    expect(f.sentParts.some((p) => p.type === 'error')).toBe(false)
  })

  it('stop while blocked → plan-start rejection unwinds the run honestly', async () => {
    executed = 0
    const f = fixture()
    const outcomePromise = f.start()
    await vi.waitFor(() => expect(f.planEvents).toHaveLength(1))
    // chat:stop path: rejectPlanStart (the abort lands here too in prod).
    expect(f.run.rejectPlanStart('Run stopped before the user replied.')).toBe(true)
    const outcome = await outcomePromise

    expect(outcome.planApproved).toBe(false)
    expect(outcome.terminalSent).toBe(true) // the loop sent the stop error part
    expect(executed).toBe(0)
    expect(f.sentParts.some((p) => p.type === 'error')).toBe(true)
  })

  it('forced-refusal fallback: first plan attempt throws → auto retry plans and gates', async () => {
    executed = 0
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-fallback',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(stubAction)
    const turns = twoMockTurns()
    let calls = 0
    const streams = [turns.plan, turns.exec, turns.execFollowup]
    // M3.7 gate finding: live Groq refuses forced tool choice. First doStream
    // throws (attempt 1), the retry (auto) consumes the scripted turns.
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'plan-run-test-fallback',
      doStream: async () => {
        calls += 1
        if (calls === 1) throw new Error('Tool choice is required, but model did not call a tool')
        const next = streams.shift()
        if (!next) throw new Error('unexpected extra doStream call')
        return next as never
      }
    })
    const sentParts: UIMessageChunk[] = []
    const planEvents: PlanStep[][] = []
    const outcomePromise = runPlanFirstTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      requestPlanStart: (ids) => run.requestPlanStart(ids),
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: (steps) => planEvents.push(steps),
      signal: new AbortController().signal
    })
    await vi.waitFor(() => expect(planEvents).toHaveLength(1))
    // The held first-attempt error must NOT pollute the thread on retry.
    expect(sentParts.some((p) => p.type === 'error')).toBe(false)
    expect(run.resolvePlanStart(true)).toBe(true)
    const outcome = await outcomePromise
    expect(outcome.planEmitted).toBe(true)
    expect(outcome.planApproved).toBe(true)
    expect(executed).toBe(1)
  })

  it('M3.8: forced refusal then a TEXT-ONLY retry → the reply is delivered as a normal reply', async () => {
    // The live "hey" failure (PROGRESS Devlog 2026-09-11): attempt 1 is
    // refused (forced tool choice), attempt 2 answers "hey" in text and never
    // calls emit_plan. That is a valid outcome — no provider error happened —
    // so the reply must reach the user and be persisted, NOT be replaced by
    // the held 400 copy, and NOTHING may execute without a plan.
    executed = 0
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-textreply',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(stubAction)
    const replyChunks: LanguageModelV2StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'hey-1' },
      { type: 'text-delta', id: 'hey-1', delta: 'Hi there!' },
      { type: 'text-end', id: 'hey-1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 6, totalTokens: 9 }
      }
    ]
    let calls = 0
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'plan-run-test-textreply',
      doStream: async () => {
        calls += 1
        if (calls === 1) throw new Error('Tool choice is required, but model did not call a tool')
        return { stream: simulateReadableStream({ chunks: replyChunks }) } as never
      }
    })
    const sentParts: UIMessageChunk[] = []
    const outcome = await runPlanFirstTurn({
      model,
      system: 'test system',
      messages: [
        { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hey' }] }
      ],
      registry,
      ctx: run.ctx,
      requestPlanStart: () => {
        throw new Error('the gate must never be reached without a plan')
      },
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: () => {
        throw new Error('no plan must be emitted')
      },
      signal: new AbortController().signal
    })
    expect(outcome.planEmitted).toBe(false)
    expect(outcome.planApproved).toBe(false)
    expect(executed).toBe(0)
    expect(model.doStreamCalls.length).toBe(2) // forced + one auto retry
    // No error copy, no silent run: the text is the reply, kept for the
    // settle point to persist + finish (chat.ts sends the held finish).
    expect(outcome.terminalSent).toBe(false)
    expect(sentParts.some((p) => p.type === 'error')).toBe(false)
    expect(outcome.assistantMessage?.parts).toEqual([{ type: 'text', text: 'Hi there!' }])
    expect(outcome.heldFinish?.type).toBe('finish')
  })

  it('M3.8: both attempts answer in text → only the RETRY is delivered, never doubled', async () => {
    // The doubled greeting: with a single shared accumulator the first
    // attempt's partial text leaked into the final message. The retry is the
    // only attempt that resolves this run, so its text is all we see.
    // Uses a greeting (non-mutating): text-only answers to file-changing
    // requests now fail loudly instead (isLikelyMutatingRequest).
    executed = 0
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-textretry',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(stubAction)
    const greeting = (id: string, word: string): LanguageModelV2StreamPart[] => [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: word },
      { type: 'text-end', id },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      }
    ]
    const streams = [
      { stream: simulateReadableStream({ chunks: greeting('g1', 'first attempt') }) },
      { stream: simulateReadableStream({ chunks: greeting('g2', 'second attempt') }) }
    ]
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'plan-run-test-textretry',
      doStream: async () => {
        const next = streams.shift()
        if (!next) throw new Error('unexpected extra doStream call')
        return next as never
      }
    })
    const sentParts: UIMessageChunk[] = []
    const outcome = await runPlanFirstTurn({
      model,
      system: 'test system',
      messages: [
        { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hey there' }] }
      ],
      registry,
      ctx: run.ctx,
      requestPlanStart: () => {
        throw new Error('the gate must never be reached without a plan')
      },
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: () => {
        throw new Error('no plan must be emitted')
      },
      signal: new AbortController().signal
    })
    expect(outcome.planEmitted).toBe(false)
    expect(executed).toBe(0)
    expect(model.doStreamCalls.length).toBe(2)
    // Exactly ONE reply — the retry's — never a concatenation of both.
    expect(outcome.assistantMessage?.parts).toEqual([{ type: 'text', text: 'second attempt' }])
    // And only that one text ever reached the wire.
    const wireText = sentParts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { delta: string }).delta)
      .join('')
    expect(wireText).toBe('second attempt')
    expect(outcome.terminalSent).toBe(false)
  })

  it('double refusal → honest error, NO execution without a plan', async () => {
    executed = 0
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-norefuse',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(stubAction)
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'plan-run-test-norefuse',
      doStream: async () => {
        throw new Error('Tool choice is required, but model did not call a tool')
      }
    })
    const sentParts: UIMessageChunk[] = []
    const outcome = await runPlanFirstTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      requestPlanStart: () => {
        throw new Error('the gate must never be reached without a plan')
      },
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: () => {
        throw new Error('no plan must be emitted')
      },
      signal: new AbortController().signal
    })
    expect(outcome.planEmitted).toBe(false)
    expect(outcome.planApproved).toBe(false)
    expect(executed).toBe(0)
    expect(model.doStreamCalls.length).toBe(2) // forced + one auto retry
    expect(sentParts.some((p) => p.type === 'error')).toBe(true)
    expect(outcome.terminalSent).toBe(true)
  })

  it('plan-less degradation: no emit_plan tool → straight execution, no gate', async () => {
    executed = 0
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-planrun-2',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(stubAction) // NO emit_plan defined
    const planEvents: PlanStep[][] = []
    const turns = twoMockTurns()
    let turnIndex = 0
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'plan-run-test-nodegate',
      doStream: async () => {
        turnIndex += 1
        const next = turnIndex === 1 ? turns.exec : turns.execFollowup
        return next as never
      }
    })
    const outcome = await runPlanFirstTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      requestPlanStart: () => {
        throw new Error('the gate must never be reached without a plan')
      },
      sendPart: () => undefined,
      onPlanCreated: (steps) => planEvents.push(steps),
      signal: new AbortController().signal
    })
    expect(planEvents).toHaveLength(0)
    expect(outcome.planEmitted).toBe(false)
    expect(executed).toBe(1)
    // No plan phase at all — exactly the two execution turns (tool turn +
    // post-tool followup), and the gate was never consulted.
    expect(model.doStreamCalls.length).toBe(2)
    // The execution text gives the persisted reply (S5-001: alongside the
    // executed tool's own persisted part).
    expect(outcome.assistantMessage?.parts).toContainEqual({ type: 'text', text: 'done' })
  })
})

describe('friendlyProviderError — copy classification + diagnosability (M3.8)', () => {
  const apiCall = (statusCode: number, responseBody?: string): APICallError =>
    new APICallError({
      message: `mock provider error ${statusCode}`,
      url: 'https://mock.invalid/v1/chat/completions',
      requestBodyValues: undefined,
      statusCode,
      responseBody
    })

  it('logs the raw status + response body to the console (never the request)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      friendlyProviderError(apiCall(400, 'tool_use_failed: Tool choice is required'), 'plan')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[0]).toContain('[provider] 400')
      expect(spy.mock.calls[0]?.[0]).toContain('tool_use_failed')
    } finally {
      spy.mockRestore()
    }
  })

  it('a non-key 400 in the plan phase is a refusal to plan, not a connection problem', () => {
    const copy = friendlyProviderError(apiCall(400, '{"error":{"code":"tool_use_failed"}}'), 'plan')
    expect(copy).toContain("couldn't create a plan")
    expect(copy).not.toContain('connection')
  })

  it('the same 400 outside the plan phase keeps the generic provider copy', () => {
    expect(friendlyProviderError(apiCall(400, 'tool_use_failed'))).toContain('connection')
  })

  it('key, rate-limit, and non-API errors still classify first', () => {
    expect(friendlyProviderError(apiCall(401), 'plan')).toContain('API key')
    expect(friendlyProviderError(apiCall(403, 'forbidden'), 'plan')).toContain('API key')
    expect(friendlyProviderError(apiCall(400, 'API key not valid'), 'plan')).toContain('API key')
    expect(friendlyProviderError(apiCall(429, 'rate limit'), 'plan')).toContain('rate-limiting')
    expect(friendlyProviderError(new Error('network down'), 'plan')).toContain('connection')
  })

  it('unwraps RetryError before classifying (a wrapped 429 stays a 429)', () => {
    const wrapped = new RetryError({
      message: 'retries exhausted',
      reason: 'maxRetriesExceeded',
      errors: [apiCall(429, 'rate limit')]
    })
    expect(friendlyProviderError(wrapped, 'plan')).toContain('rate-limiting')
  })

  it('a tool failure keeps its plain sentence — never provider copy (Phase-1 item 1)', () => {
    const failure = new ToolFailureError(
      'That page could not be fetched — getaddrinfo ENOTFOUND.',
      'web_fetch'
    )
    const copy = friendlyProviderError(failure)
    expect(copy).toContain('could not be fetched')
    expect(copy).not.toContain('model provider')
    expect(copy).not.toContain('connection')
  })
})
