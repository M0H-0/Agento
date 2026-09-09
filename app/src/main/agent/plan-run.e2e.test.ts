import { describe, expect, it, vi } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { createToolRegistry } from './registry'
import { buildRunContext, newRunId } from './context'
import { runPlanFirstTurn } from './plan-run'
import { emitPlanTool } from './tools/emit_plan'
import type { ToolDefinition } from './types'

// M3.7 smoke (1-hour slice): plan → gate approve → execute → verify-skipped.
// Deterministic MockLanguageModelV2 script, no provider, no Electron, no key.
const PLAN_STEPS = {
  steps: [
    {
      id: 's1',
      description: 'Move the report into Archive',
      tool: 'stub_e2e',
      riskLevel: 0,
      requiresApproval: false
    }
  ]
}

function scriptedModel(): MockLanguageModelV2 {
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
    { type: 'tool-input-start', id: 'act-1', toolName: 'stub_e2e' },
    { type: 'tool-input-delta', id: 'act-1', delta: '{}' },
    { type: 'tool-input-end', id: 'act-1' },
    { type: 'tool-call', toolCallId: 'act-1', toolName: 'stub_e2e', input: '{}' },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
    }
  ]
  const followup: LanguageModelV2StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't-1' },
    { type: 'text-delta', id: 't-1', delta: 'done' },
    { type: 'text-end', id: 't-1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
    }
  ]
  const streams = [
    { stream: simulateReadableStream({ chunks: planChunks }) },
    { stream: simulateReadableStream({ chunks: execChunks }) },
    { stream: simulateReadableStream({ chunks: followup }) }
  ]
  return new MockLanguageModelV2({
    provider: 'mock',
    modelId: 'm3-7-smoke',
    doStream: async () => {
      const next = streams.shift()
      if (!next) throw new Error('unexpected extra doStream call')
      return next as never
    }
  })
}

describe('M3.7 smoke: plan → approve → execute → verify-skipped', () => {
  it('happy path with degraded verify', async () => {
    let executed = 0
    const stub: ToolDefinition<{ confirm: boolean }, { done: boolean }> = {
      name: 'stub_e2e',
      description: 'smoke stub',
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
      describe: () => ({ title: 'Stub', group: 'test' }),
      execute: async () => {
        executed += 1
        return { ok: true, output: { done: true } }
      }
    }
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-e2e',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(stub)
    const sentParts: UIMessageChunk[] = []
    const plans: unknown[] = []
    const verifications: unknown[] = []
    const model = scriptedModel()
    const outcomePromise = runPlanFirstTurn({
      model,
      system: 'test',
      messages: [
        { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'tidy up' }] }
      ],
      registry,
      ctx: run.ctx,
      requestPlanStart: (ids) => run.requestPlanStart(ids),
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: (steps) => plans.push(steps),
      signal: new AbortController().signal,
      verify: async () => ({ verdict: 'skipped' }) as const,
      onVerification: (result) => verifications.push(result)
    })
    await vi.waitFor(() => expect(plans).toHaveLength(1))
    expect(run.resolvePlanStart(true)).toBe(true)
    const outcome = await outcomePromise
    expect(outcome.planEmitted).toBe(true)
    expect(outcome.planApproved).toBe(true)
    expect(executed).toBe(1)
    expect(model.doStreamCalls.length).toBe(3)
    // Degraded verify: honest "not verified" badge payload, never a fake ✓.
    expect(verifications).toHaveLength(1)
    expect(verifications[0]).toMatchObject({ isComplete: false, score: null })
    expect(outcome.heldFinish?.type).toBe('finish')
    void sentParts
  })
})
