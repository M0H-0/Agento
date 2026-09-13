import { describe, expect, it, vi } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { createToolRegistry } from './registry'
import { buildRunContext, newRunId } from './context'
import { isGoAheadMessage, runActTurn, runPlanModeTurn } from './plan-run'
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
    { type: 'tool-call', toolCallId: 'act-1', toolName, input: '{}' },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
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
})

describe('runPlanModeTurn — structurally read-only', () => {
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
