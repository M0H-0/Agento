import { describe, expect, it, vi } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { createToolRegistry } from './registry'
import { buildRunContext, newRunId } from './context'
import {
  buildFallbackOrganizePlan,
  isGoAheadMessage,
  runActTurn,
  runPlanModeTurn
} from './plan-run'
import { emitPlanTool } from './tools/emit_plan'
import type { PlanStep } from './tools/emit_plan'
import type { ToolDefinition } from './types'

// Explicit Plan/Act composer modes (docs/03 §2): Plan runs are structurally
// read-only (discovery sees read-access tools only, then a forced emit_plan;
// no execution path exists), Act runs execute with the full registry MINUS
// emit_plan, and an Act "go ahead" carries out the session's saved plan.
// No network, no real provider (MockLanguageModelV2, same recipe as
// plan-run.test.ts). Storage/IPC routing (sessions.mode, session:plan) cannot
// load under vitest — better-sqlite3 is Electron-ABI (AGENTS.md) — so these
// tests pin the mode-turn wiring both sides of that boundary must honor.

const PLAN_STEPS = {
  steps: [
    {
      id: 's1',
      description: 'Move the PDF invoices into a folder called Finance',
      tool: 'stub_read',
      riskLevel: 0,
      requiresApproval: false
    }
  ]
}

const USER_MESSAGES = [
  { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'organize my files' }] }
]

function textTurn(delta: string): { stream: unknown } {
  const chunks: LanguageModelV2StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'txt-1' },
    { type: 'text-delta', id: 'txt-1', delta },
    { type: 'text-end', id: 'txt-1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
    }
  ]
  return { stream: simulateReadableStream({ chunks }) }
}

function planTurn(): { stream: unknown } {
  const chunks: LanguageModelV2StreamPart[] = [
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
  return { stream: simulateReadableStream({ chunks }) }
}

function stubTurn(toolName: string): { stream: unknown } {
  const chunks: LanguageModelV2StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'act-1', toolName },
    { type: 'tool-input-delta', id: 'act-1', delta: '{}' },
    { type: 'tool-input-end', id: 'act-1' },
    {
      type: 'tool-call',
      toolCallId: 'act-1',
      toolName,
      input: '{}'
    },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
    }
  ]
  return { stream: simulateReadableStream({ chunks }) }
}

// A turn that produces no text at all — just finishes. Models that answer a
// failed tool call with silence (live: failed web_fetch, gpt-oss) end this way;
// the Act fallback must still close the thread with a persisted sentence.
function emptyTurn(): { stream: unknown } {
  const chunks: LanguageModelV2StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 }
    }
  ]
  return { stream: simulateReadableStream({ chunks }) }
}

function scriptedModel(turns: { stream: unknown }[]): MockLanguageModelV2 {
  const streams = [...turns]
  return new MockLanguageModelV2({
    provider: 'mock',
    modelId: 'plan-act-modes-test',
    doStream: async () => {
      const next = streams.shift()
      if (!next) throw new Error('unexpected extra doStream call')
      return next as never
    }
  })
}

function stubTool(
  name: string,
  access: 'read' | 'write',
  onExecute: () => void
): ToolDefinition<{ confirm: boolean }, { done: boolean }> {
  return {
    name,
    description: `Stub ${name}`,
    access,
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
    describe: () => ({ title: `Stub ${name}`, group: 'test' }),
    execute: async () => {
      onExecute()
      return { ok: true, output: { done: true } }
    }
  }
}

describe('isGoAheadMessage — the Act saved-plan trigger', () => {
  it.each([
    'go ahead',
    'Go ahead.',
    'go-ahead',
    'yes, go ahead',
    'execute the plan',
    'carry out the plan',
    'do the plan',
    'start'
  ])('accepts %j', (text) => {
    expect(isGoAheadMessage(text)).toBe(true)
  })

  it.each([
    '',
    'hello',
    'what is the plan?',
    'go ahead and also rewrite everything',
    'starting over',
    'yes'
  ])('rejects %j', (text) => {
    expect(isGoAheadMessage(text)).toBe(false)
  })

  // 2026-09-17: the Arabic read-only footer says «تابع» — the trigger must
  // accept it (live: "انطلق، نفّذ الخطة" parked the run in Plan).
  it.each([
    'تابع',
    'انطلق',
    'نفذ',
    'ابدأ',
    'انطلق، نفّذ الخطة',
    'نفذ الخطة',
    'تابع تنفيذ الخطة',
    'نعم، نفذ',
    'موافق، تابع',
    'توكل على الله'
  ])('accepts Arabic %j', (text) => {
    expect(isGoAheadMessage(text)).toBe(true)
  })

  it.each(['', 'ما هي الخطة؟', 'نعم', 'موافق', 'احذف كل شيء', 'تابع واحذف التقارير'])(
    'rejects Arabic %j',
    (text) => {
      expect(isGoAheadMessage(text)).toBe(false)
    }
  )
})

describe('registry include/exclude filter — the mode boundary primitive', () => {
  it('include keeps only the named tools; exclude drops only the named tools', () => {
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-filter',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(stubTool('a_read', 'read', () => undefined))
    registry.define(stubTool('b_write', 'write', () => undefined))
    registry.define(stubTool('c_read', 'read', () => undefined))

    expect(Object.keys(registry.toAiSdkTools(run.ctx, undefined, { include: ['a_read'] }))).toEqual(
      ['a_read']
    )
    expect(
      Object.keys(registry.toAiSdkTools(run.ctx, undefined, { exclude: ['b_write'] })).sort()
    ).toEqual(['a_read', 'c_read'])
    // No filter still exposes everything (legacy path contract).
    expect(Object.keys(registry.toAiSdkTools(run.ctx)).sort()).toEqual([
      'a_read',
      'b_write',
      'c_read'
    ])
  })
})

describe('runActTurn — execution without a planning phase', () => {
  it('saved Arabic organize plan blocks its three moves on one counted approval', async () => {
    const plans = buildFallbackOrganizePlan('رتّب الملفات حسب النوع', [
      {
        entries: ['a.pdf', 'b.pdf', 'c.pdf'].map((name) => ({ name, type: 'file' as const }))
      }
    ])!
    const approvals: { approvalId: string; count?: number }[] = []
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-saved-arabic',
      runId: newRunId(),
      workspaceRoot: 'C:/ws',
      onApprovalRequested: (event) => approvals.push(event)
    })
    run.setPlanSteps(plans)
    const registry = createToolRegistry()
    const execute = vi.fn()
    registry.define({
      ...stubTool('move_path', 'write', execute),
      risk: () => ({ level: 2, reason: 'move' })
    })
    const model = scriptedModel([
      stubTurn('move_path'),
      stubTurn('move_path'),
      stubTurn('move_path'),
      textTurn('تم نقل الملفات الثلاثة.')
    ])
    const pending = runActTurn({
      model,
      system: 'test system',
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'انطلق، نفّذ الخطة' }] }],
      planHandoff: plans,
      registry,
      ctx: run.ctx,
      sendPart: () => undefined,
      signal: new AbortController().signal
    })
    await vi.waitFor(() => expect(approvals).toHaveLength(1))
    expect(approvals[0].count).toBe(3)
    expect(execute).not.toHaveBeenCalled()
    expect(run.resolveApproval(approvals[0].approvalId, 'approve')).toBe(true)
    const outcome = await pending
    expect(approvals).toHaveLength(1)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(outcome.terminalSent).toBe(false)
  })

  it('never offers emit_plan and executes the stub through the wrapper', async () => {
    let executed = 0
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-act',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(
      stubTool('stub_action', 'write', () => {
        executed += 1
      })
    )
    const toAiSdkToolsSpy = vi.spyOn(registry, 'toAiSdkTools')
    // Tool turn + the post-tool text followup (same recipe as plan-run.test.ts).
    const model = scriptedModel([stubTurn('stub_action'), textTurn('done')])
    const sentParts: UIMessageChunk[] = []

    const outcome = await runActTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      signal: new AbortController().signal
    })

    // The ONLY tools handed to the model exclude emit_plan — the model could
    // not have planned even if prompted.
    expect(toAiSdkToolsSpy).toHaveBeenCalledOnce()
    expect(toAiSdkToolsSpy.mock.calls[0]?.[2]).toEqual({ exclude: ['emit_plan'] })
    expect(executed).toBe(1)
    const toolNames = sentParts
      .filter((p) => p.type === 'tool-input-available')
      .map((p) => (p as { toolName: string }).toolName)
    expect(toolNames).toContain('stub_action')
    expect(toolNames).not.toContain('emit_plan')
    expect(outcome.planEmitted).toBe(false)
    expect(outcome.aborted).toBe(false)
  })

  it('a mutating request answered in prose with zero tool calls retries once, then fails loudly', async () => {
    // The reported "says I'm doing it and does nothing": the model narrates
    // the claim and never calls anything. stepsTaken counts round-trips, so
    // the guard keys on real wrapper outcomes (callsMade) instead.
    let executed = 0
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-act-prose',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(
      stubTool('stub_action', 'write', () => {
        executed += 1
      })
    )
    const toAiSdkToolsSpy = vi.spyOn(registry, 'toAiSdkTools')
    // First auto attempt: prose. Required retry: prose again (mock providers
    // don't enforce tool choice — a real one either calls or refuses, and the
    // refusal path maps to the same honest copy).
    const model = scriptedModel([
      textTurn("I'll organize those files right now."),
      textTurn('Still working on it, almost done.')
    ])
    const sentParts: UIMessageChunk[] = []

    const outcome = await runActTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      signal: new AbortController().signal
    })

    expect(executed).toBe(0)
    // One auto attempt + one required retry.
    expect(toAiSdkToolsSpy).toHaveBeenCalledTimes(2)
    const terminalError = sentParts
      .filter((p) => p.type === 'error')
      .map((p) => (p as { errorText: string }).errorText)
      .at(-1)
    expect(terminalError).toContain("didn't take any actions")
    expect(outcome.aborted).toBe(false)
  })

  it('does not resume old mutations when the latest Arabic turn only asks for observations', async () => {
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-observation',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    const execute = vi.fn()
    registry.define(stubTool('stub_action', 'write', execute))
    const model = scriptedModel([
      textTurn('لم ألاحظ شيئًا آخر.'),
      stubTurn('stub_action'),
      textTurn('Resumed organizing.')
    ])
    const sentParts: UIMessageChunk[] = []
    const outcome = await runActTurn({
      model,
      system: 'test system',
      messages: [
        ...USER_MESSAGES,
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'create a report.txt file' }] },
        { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'delete report.txt' }] },
        {
          id: 'u4',
          role: 'user',
          parts: [{ type: 'text', text: 'هل لاحظت أي شيء آخر في ملفاتي؟' }]
        }
      ],
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      signal: new AbortController().signal
    })
    expect(execute).not.toHaveBeenCalled()
    expect(model.doStreamCalls).toHaveLength(1)
    expect(outcome.terminalSent).toBe(false)
    expect(sentParts.some((part) => part.type === 'error')).toBe(false)
  })

  it.each([0, 3])('stops on a terminal stream error after %i actions', async (actions) => {
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-terminal',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    const execute = vi.fn()
    const verify = vi.fn(async () => ({ verdict: 'skipped' as const }))
    registry.define(stubTool('stub_action', 'write', execute))
    const model = scriptedModel([
      ...Array.from({ length: actions }, () => stubTurn('stub_action')),
      {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: new Error('stream interrupted') }
          ] as LanguageModelV2StreamPart[]
        })
      },
      stubTurn('stub_action'),
      textTurn('Resumed after error.')
    ])
    const sentParts: UIMessageChunk[] = []
    const outcome = await runActTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      signal: new AbortController().signal,
      verify
    })
    expect(execute).toHaveBeenCalledTimes(actions)
    expect(model.doStreamCalls).toHaveLength(actions + 1)
    expect(verify).not.toHaveBeenCalled()
    expect(outcome.terminalSent).toBe(true)
    expect(sentParts.filter((part) => part.type === 'error')).toHaveLength(1)
    expect(sentParts.filter((part) => part.type === 'tool-input-available')).toHaveLength(actions)
    expect(sentParts.at(-1)?.type).toBe('error')
  })

  it('a Q&A reply with zero tool calls stays a normal reply, not an error', async () => {
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-act-qa',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const model = scriptedModel([textTurn('Hello! How can I help?')])
    const sentParts: UIMessageChunk[] = []

    const outcome = await runActTurn({
      model,
      system: 'test system',
      messages: [
        { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hello' }] }
      ],
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      signal: new AbortController().signal
    })

    expect(outcome.aborted).toBe(false)
    expect(sentParts.some((p) => p.type === 'error')).toBe(false)
    expect(outcome.assistantMessage).not.toBeNull()
  })

  it('a failed tool with no closing prose still persists one honest sentence (Phase-1 item 1)', async () => {
    // Live: a failed web_fetch where the model went silent ended as a bare user
    // bubble — nothing persisted. The Act fallback must synthesize one text
    // sentence (persisted) from the tool's plain-language failure.
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-act-fail-silent',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    const failingTool: ToolDefinition = {
      name: 'stub_fetch',
      description: 'Stub failing fetch',
      access: 'read',
      inputSchema: z.object({}),
      pathFields: [],
      risk: () => ({ level: 0, reason: 'stub' }),
      describe: () => ({ title: 'Stub fetch', group: 'test' }),
      execute: async () => ({
        ok: false,
        output: { url: 'https://example.com/' },
        error: 'That page could not be fetched — getaddrinfo ENOTFOUND.'
      })
    }
    registry.define(failingTool)
    // Tool turn (fails) + an empty followup (model says nothing).
    const model = scriptedModel([stubTurn('stub_fetch'), emptyTurn()])
    const sentParts: UIMessageChunk[] = []

    const outcome = await runActTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      signal: new AbortController().signal
    })

    expect(outcome.aborted).toBe(false)
    // One persisted assistant sentence carrying the plain-language failure.
    expect(outcome.assistantMessage).not.toBeNull()
    const text = (outcome.assistantMessage?.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('')
    expect(text).toContain('could not be fetched')
    // The fallback travels as text chunks (persisted), not an error part.
    expect(sentParts.some((p) => p.type === 'text-delta')).toBe(true)
    // The tool card's error line keeps the tool's own sentence — the stream's
    // onError classifier must not relabel a tool failure as a provider failure
    // (Phase-1 item 1: live DNS-failed web_fetch wore provider copy).
    const toolErrorPart = sentParts.find((p) => p.type === 'tool-output-error') as
      { errorText: string } | undefined
    expect(toolErrorPart?.errorText).toContain('could not be fetched')
    expect(toolErrorPart?.errorText).not.toContain('model provider')
  })
})

describe('runPlanModeTurn — structurally read-only', () => {
  it('discovery read-tool cards stream live while prose stays held (2026-09-16)', async () => {
    // The "taking too long" fix: discovery is a full model pass before
    // planning — its tool activity must be visible immediately (progress),
    // while its prose summary still commits only with the plan outcome.
    let reads = 0
    let writes = 0
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-planmode-live',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(
      stubTool('stub_read', 'read', () => {
        reads += 1
      })
    )
    registry.define(
      stubTool('stub_write', 'write', () => {
        writes += 1
      })
    )
    // Discovery tool turn + its text followup, then the forced emit_plan turn.
    const model = scriptedModel([
      stubTurn('stub_read'),
      textTurn('I found some files to organize.'),
      planTurn()
    ])
    const sentParts: UIMessageChunk[] = []
    const plans: PlanStep[][] = []

    const outcome = await runPlanModeTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: (steps) => plans.push(steps),
      signal: new AbortController().signal
    })

    expect(reads).toBe(1)
    expect(writes).toBe(0)
    expect(plans).toHaveLength(1)
    expect(outcome.planEmitted).toBe(true)
    // The read-tool card streamed (exactly once per direction)...
    const toolInputs = sentParts.filter((p) => p.type === 'tool-input-available') as {
      toolName: string
    }[]
    expect(toolInputs.map((p) => p.toolName)).toEqual(['stub_read'])
    expect(sentParts.filter((p) => p.type === 'tool-output-available')).toHaveLength(1)
    // ...and the held narration is dropped in favor of the one summary
    // (2026-09-16: no essay above the plan — the panel carries it).
    const flushedText = sentParts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { delta?: string }).delta ?? '')
      .join('')
    expect(flushedText).not.toContain('I found some files')
    expect(flushedText).toContain("Here's my plan")
  })

  it('a plan with no prose anywhere still lands a visible summary in the thread (2026-09-16)', async () => {
    // The live organize run: discovery spent every step on tools and the
    // plan call had no preamble — the thread ended as bare cards with no
    // indicator and no next action. The run now synthesizes the summary.
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-planmode-summary',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(stubTool('stub_read', 'read', () => undefined))
    registry.define(stubTool('stub_write', 'write', () => undefined))
    // Discovery tool turn + a textless followup, then the forced emit_plan.
    const model = scriptedModel([stubTurn('stub_read'), emptyTurn(), planTurn()])
    const sentParts: UIMessageChunk[] = []
    const plans: PlanStep[][] = []

    const outcome = await runPlanModeTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: (steps) => plans.push(steps),
      signal: new AbortController().signal
    })

    expect(outcome.planEmitted).toBe(true)
    expect(plans).toHaveLength(1)
    const flushedText = sentParts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { delta?: string }).delta ?? '')
      .join('')
    expect(flushedText).toContain("Here's my plan")
    expect(flushedText).toContain('Move the PDF invoices into a folder called Finance')
    expect(flushedText).toContain('go ahead')
    // Persisted, so a reopened session keeps the indicator.
    const persistedText = (outcome.assistantMessage?.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('')
    expect(persistedText).toContain("Here's my plan")
  })

  it('a narrated plan drops the model words; the thread gets one summary', async () => {
    // 2026-09-16: discovery prose + plan preamble used to land in the
    // thread above the plan. Now narration is always dropped on success —
    // the panel carries the plan, the thread gets exactly one summary.
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-planmode-narrated',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(stubTool('stub_read', 'read', () => undefined))
    registry.define(stubTool('stub_write', 'write', () => undefined))
    const model = scriptedModel([textTurn('I will plan this.'), planTurn()])
    const sentParts: UIMessageChunk[] = []
    const plans: PlanStep[][] = []

    const outcome = await runPlanModeTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: (steps) => plans.push(steps),
      signal: new AbortController().signal
    })

    expect(outcome.planEmitted).toBe(true)
    const flushedText = sentParts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { delta?: string }).delta ?? '')
      .join('')
    expect(flushedText).not.toContain('I will plan this.')
    expect(flushedText).toContain("Here's my plan")
  })

  it('discovery sees read tools only; the write stub never runs; the plan is emitted', async () => {
    let reads = 0
    let writes = 0
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-planmode',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(
      stubTool('stub_read', 'read', () => {
        reads += 1
      })
    )
    registry.define(
      stubTool('stub_write', 'write', () => {
        writes += 1
      })
    )
    const toAiSdkToolsSpy = vi.spyOn(registry, 'toAiSdkTools')
    // Discovery text turn (no tool calls) + the forced emit_plan turn.
    const model = scriptedModel([textTurn('I will plan this.'), planTurn()])
    const sentParts: UIMessageChunk[] = []
    const plans: PlanStep[][] = []

    const outcome = await runPlanModeTurn({
      model,
      system: 'test system',
      messages: USER_MESSAGES,
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: (steps) => plans.push(steps),
      signal: new AbortController().signal
    })

    // Discovery's include set is read-access only: no write stub, no emit_plan.
    // (reads stays 0 here because the scripted discovery turn calls no tools —
    // the guarantee is structural: the write tool was never even offered.)
    expect(toAiSdkToolsSpy).toHaveBeenCalledOnce()
    expect(toAiSdkToolsSpy.mock.calls[0]?.[2]).toEqual({ include: ['stub_read'] })
    expect(writes).toBe(0)
    expect(reads).toBe(0)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.[0]).toMatchObject({ id: 's1', tool: 'stub_read' })
    expect(outcome.planEmitted).toBe(true)
    expect(outcome.planApproved).toBe(false)
    expect(outcome.stepsTaken).toBe(0)
    // emit_plan's raw JSON never reaches the thread (PlanPanel is its surface).
    const toolNames = sentParts
      .filter((p) => p.type === 'tool-input-available')
      .map((p) => (p as { toolName: string }).toolName)
    expect(toolNames).not.toContain('emit_plan')
  })
})
