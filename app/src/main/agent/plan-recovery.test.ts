import { describe, expect, it } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { createToolRegistry } from './registry'
import { buildRunContext, newRunId } from './context'
import {
  buildFallbackDocumentPlan,
  isLikelyMutatingRequest,
  normalizePlanSteps,
  parsePlanJson,
  runPlanModeTurn
} from './plan-run'
import { emitPlanTool } from './tools/emit_plan'
import type { PlanStep } from './tools/emit_plan'
import type { ToolDefinition } from './types'

// Plan-JSON recovery (2026-09-13): providers that ignore a forced toolChoice
// (Ollama gpt-oss:120b live) return the plan attempts as plain text — no
// emit_plan call, no error — and Plan mode used to end silently with no plan.
// Recovery re-reads the structured contract from the model's text (echo) or
// one no-tools completion (extraction); a mutating request that still has no
// plan gets honest failure copy instead of a silent text-only reply.

const PLAN_STEPS = {
  steps: [
    {
      id: 's1',
      description: 'Move the PDF invoices into a folder called Finance',
      tool: 'stub_write',
      riskLevel: 1,
      requiresApproval: true
    }
  ]
}

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

function scriptedModel(turns: { stream: unknown }[]): MockLanguageModelV2 {
  const streams = [...turns]
  return new MockLanguageModelV2({
    provider: 'mock',
    modelId: 'plan-recovery-test',
    doStream: async () => {
      const next = streams.shift()
      if (!next) throw new Error('unexpected extra doStream call')
      return next as never
    }
  })
}

function writeOnlyRegistry(): ReturnType<typeof createToolRegistry> {
  // No read-access tools: discovery is skipped, so the scripted turns map
  // 1:1 onto the forced plan attempt → auto attempt → extraction pass.
  const registry = createToolRegistry()
  registry.define(emitPlanTool)
  const writeStub: ToolDefinition<{ confirm: boolean }, { done: boolean }> = {
    name: 'stub_write',
    description: 'Stub write',
    access: 'write',
    inputSchema: z.object({ confirm: z.boolean() }),
    pathFields: [],
    risk: () => ({ level: 1, reason: 'stub' }),
    describe: () => ({ title: 'Stub write', group: 'test' }),
    execute: async () => ({ ok: true, output: { done: true } })
  }
  registry.define(writeStub)
  return registry
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

function readRegistry(): ReturnType<typeof createToolRegistry> {
  // Read-access tool present: discovery runs first, so scripted turns map to
  // discovery → forced plan → auto plan → extraction.
  const registry = createToolRegistry()
  registry.define(emitPlanTool)
  const readStub: ToolDefinition<{ confirm: boolean }, { done: boolean }> = {
    name: 'stub_read',
    description: 'Stub read',
    access: 'read',
    inputSchema: z.object({ confirm: z.boolean() }),
    pathFields: [],
    risk: () => ({ level: 0, reason: 'stub' }),
    describe: () => ({ title: 'Stub read', group: 'test' }),
    execute: async () => ({ ok: true, output: { done: true } })
  }
  registry.define(readStub)
  const writeStub: ToolDefinition<{ confirm: boolean }, { done: boolean }> = {
    name: 'stub_write',
    description: 'Stub write',
    access: 'write',
    inputSchema: z.object({ confirm: z.boolean() }),
    pathFields: [],
    risk: () => ({ level: 1, reason: 'stub' }),
    describe: () => ({ title: 'Stub write', group: 'test' }),
    execute: async () => ({ ok: true, output: { done: true } })
  }
  registry.define(writeStub)
  return registry
}

async function runTurnWithRegistry(
  model: MockLanguageModelV2,
  userText: string,
  registry: ReturnType<typeof createToolRegistry>
): Promise<{
  sentParts: UIMessageChunk[]
  plans: PlanStep[][]
  terminalError: string | null
  planEmitted: boolean
  flushedText: string
}> {
  const run = buildRunContext({
    sender: { emit: () => undefined },
    sessionId: 's-recovery-held',
    runId: newRunId(),
    workspaceRoot: 'C:/ws'
  })
  const sentParts: UIMessageChunk[] = []
  const plans: PlanStep[][] = []
  const outcome = await runPlanModeTurn({
    model,
    system: 'test system',
    messages: [
      { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: userText }] }
    ],
    registry,
    ctx: run.ctx,
    sendPart: (part) => sentParts.push(part),
    onPlanCreated: (steps) => plans.push(steps),
    signal: new AbortController().signal
  })
  const terminalError =
    sentParts
      .filter((p) => p.type === 'error')
      .map((p) => (p as { errorText: string }).errorText)
      .at(-1) ?? null
  const flushedText = sentParts
    .filter((p) => p.type === 'text-delta')
    .map((p) => (p as { delta?: string }).delta ?? '')
    .join('')
  return { sentParts, plans, terminalError, planEmitted: outcome.planEmitted, flushedText }
}

async function runTurn(
  model: MockLanguageModelV2,
  userText: string
): Promise<{
  sentParts: UIMessageChunk[]
  plans: PlanStep[][]
  terminalError: string | null
  planEmitted: boolean
}> {
  const run = buildRunContext({
    sender: { emit: () => undefined },
    sessionId: 's-recovery',
    runId: newRunId(),
    workspaceRoot: 'C:/ws'
  })
  const sentParts: UIMessageChunk[] = []
  const plans: PlanStep[][] = []
  const outcome = await runPlanModeTurn({
    model,
    system: 'test system',
    messages: [
      { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: userText }] }
    ],
    registry: writeOnlyRegistry(),
    ctx: run.ctx,
    sendPart: (part) => sentParts.push(part),
    onPlanCreated: (steps) => plans.push(steps),
    signal: new AbortController().signal
  })
  const terminalError =
    sentParts
      .filter((p) => p.type === 'error')
      .map((p) => (p as { errorText: string }).errorText)
      .at(-1) ?? null
  return { sentParts, plans, terminalError, planEmitted: outcome.planEmitted }
}

describe('isLikelyMutatingRequest — copy choice only, never a safety gate', () => {
  it.each(['Sort the files', 'arrange my pdfs', 'convert the csv reports'])(
    'accepts %j (2026-09-13 gap: "sort the files" used to fall through)',
    (text) => {
      expect(isLikelyMutatingRequest(text)).toBe(true)
    }
  )

  it.each(['what files do I have?', 'hello', 'summarize this report for me'])(
    'rejects %j',
    (text) => {
      expect(isLikelyMutatingRequest(text)).toBe(false)
    }
  )
})

describe('parsePlanJson — balanced-object scan validated by planStepsSchema', () => {
  it('recovers a plan from prose-wrapped JSON', () => {
    const steps = parsePlanJson(
      `Here is what I propose.\n\n${JSON.stringify(PLAN_STEPS)}\n\nShall I?`
    )
    expect(steps).toEqual(PLAN_STEPS.steps)
  })

  it('recovers a plan from a fenced code block', () => {
    const steps = parsePlanJson('```json\n' + JSON.stringify(PLAN_STEPS) + '\n```')
    expect(steps).toEqual(PLAN_STEPS.steps)
  })

  it('rejects schema-invalid JSON and keeps scanning', () => {
    const text = `{"unrelated": true} ${JSON.stringify(PLAN_STEPS)}`
    expect(parsePlanJson(text)).toEqual(PLAN_STEPS.steps)
  })

  it('returns null for prose without a valid plan object', () => {
    expect(parsePlanJson('no json here')).toBeNull()
    expect(parsePlanJson('{"steps": []}')).toBeNull()
  })
})

describe('runPlanModeTurn — text-only plan attempts are recovered, not dropped', () => {
  it('recovers the plan when the model echoes it as text (no extra provider call)', async () => {
    // Exactly two turns: the forced attempt and the auto attempt both come
    // back as text carrying the plan JSON — recovery must not need a third.
    const echo = `Sure — here is the plan.\n${JSON.stringify(PLAN_STEPS)}`
    const model = scriptedModel([textTurn(echo), textTurn(echo)])
    const { sentParts, plans, planEmitted, terminalError } = await runTurn(model, 'sort the files')

    expect(plans).toHaveLength(1)
    expect(planEmitted).toBe(true)
    expect(terminalError).toBeNull()
    // The raw JSON echo never reaches the thread (plain-language, docs/04 §3.1).
    const flushedText = sentParts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { delta?: string }).delta ?? '')
      .join('')
    expect(flushedText).not.toContain('"steps"')
  })

  it('falls back to one no-tools extraction completion when the text is prose-only', async () => {
    const model = scriptedModel([
      textTurn('I would move the invoices into a Finance folder.'),
      textTurn('I would move the invoices into a Finance folder.'),
      textTurn(JSON.stringify(PLAN_STEPS))
    ])
    const { plans, planEmitted, terminalError } = await runTurn(model, 'sort the files')

    expect(plans).toHaveLength(1)
    expect(planEmitted).toBe(true)
    expect(terminalError).toBeNull()
  })

  it('sends honest failure copy when a mutating request recovers no plan', async () => {
    const model = scriptedModel([
      textTurn('I cannot do that.'),
      textTurn('I cannot do that.'),
      textTurn('Still nothing usable.')
    ])
    const { plans, planEmitted, terminalError } = await runTurn(model, 'sort the files')

    expect(plans).toHaveLength(0)
    expect(planEmitted).toBe(false)
    expect(terminalError).toContain("couldn't make a plan")
  })
})

describe('runPlanModeTurn — held discovery (2026-09-13 story-then-error fix)', () => {
  it('drops the held cat story on mutating failure: single error, no orphan prose', async () => {
    // Reported case: "make a txt file that have a story about cats" streamed
    // the story in discovery, then PLAN_FAILED_COPY landed under it. Held
    // discovery must drop the story so the thread sees the error alone.
    // (2026-09-13 fallback: obvious txt/docx/pdf requests now get a
    // deterministic plan instead of failing — the story must STILL be
    // dropped, so the panel gets a plan with no orphan prose.)
    const story = 'Midnight Library cats Luna and Jasper gathered at midnight for a moon tale.'
    const model = scriptedModel([
      textTurn(story),
      textTurn('I cannot do that.'),
      textTurn('I cannot do that.'),
      textTurn('Still nothing usable.')
    ])
    const { plans, planEmitted, terminalError, flushedText } = await runTurnWithRegistry(
      model,
      'make a txt file that have a story about cats',
      readRegistry()
    )

    expect(plans).toHaveLength(1)
    expect(planEmitted).toBe(true)
    expect(terminalError).toBeNull()
    expect(flushedText).not.toContain('Midnight Library')
    expect(flushedText).not.toContain('Luna')
    // The thread must visibly answer (never just the user bubble).
    expect(flushedText).toContain("Here's my plan")
  })

  it('commits held discovery summary when the plan lands', async () => {
    const model = scriptedModel([textTurn('I will plan the txt file.'), planTurn()])
    const { plans, planEmitted, terminalError, flushedText } = await runTurnWithRegistry(
      model,
      'make a txt file that have a story about cats',
      readRegistry()
    )

    expect(plans).toHaveLength(1)
    expect(planEmitted).toBe(true)
    expect(terminalError).toBeNull()
    expect(flushedText).toContain('I will plan the txt file.')
  })

  it('delivers the held discovery answer for Q&A with no error', async () => {
    const model = scriptedModel([
      textTurn('Hi there!'),
      textTurn('hello again'),
      textTurn('hello again'),
      textTurn('still just prose')
    ])
    const { plans, planEmitted, terminalError, flushedText } = await runTurnWithRegistry(
      model,
      'hello',
      readRegistry()
    )

    expect(plans).toHaveLength(0)
    expect(planEmitted).toBe(false)
    expect(terminalError).toBeNull()
    expect(flushedText).toContain('Hi there!')
  })
})

describe('normalizePlanSteps — provider arg-variant repair (live gpt-oss shape)', () => {
  it('normalizes snake_case args and a missing id onto the frozen contract', () => {
    const wire = {
      steps: [
        {
          description: 'Create live-probe-plan.txt in the workspace root',
          tool: 'write_file',
          risk: 1,
          requires_approval: true
        }
      ]
    }
    expect(parsePlanJson(JSON.stringify(wire))).toEqual([
      {
        id: '1',
        description: 'Create live-probe-plan.txt in the workspace root',
        tool: 'write_file',
        riskLevel: 1,
        requiresApproval: true
      }
    ])
  })

  it('keeps camelCase plans untouched', () => {
    expect(parsePlanJson(JSON.stringify(PLAN_STEPS))).toEqual(PLAN_STEPS.steps)
  })

  it('still rejects plans with no steps or no text', () => {
    expect(parsePlanJson(JSON.stringify({ steps: [] }))).toBeNull()
    expect(parsePlanJson(JSON.stringify({ steps: [{ tool: 'write_file' }] }))).toBeNull()
    expect(parsePlanJson('just some prose, no json at all')).toBeNull()
  })

  it('never flattens an explicit approval ask to false (needs_approval:true)', () => {
    const wire = {
      steps: [{ description: 'Delete everything', tool: 'delete_path', needs_approval: true }]
    }
    expect(parsePlanJson(JSON.stringify(wire))).toEqual([
      {
        id: '1',
        description: 'Delete everything',
        tool: 'delete_path',
        riskLevel: 0,
        requiresApproval: true
      }
    ])
  })

  it('normalizes a bare array of steps', () => {
    const normalized = normalizePlanSteps([
      { description: 'Do it', tool: 'write_file', risk: 0, requires_approval: false }
    ])
    expect(normalized).toEqual({
      steps: [
        { id: '1', description: 'Do it', tool: 'write_file', riskLevel: 0, requiresApproval: false }
      ]
    })
  })
})

describe('runPlanModeTurn — discovery failure is best-effort, never the verdict', () => {
  function errorTurn(message: string): { stream: unknown } {
    const chunks: LanguageModelV2StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: new Error(message) }
    ]
    return { stream: simulateReadableStream({ chunks }) }
  }

  it('a failed discovery still plans: single plan, no error', async () => {
    // Live shape: the provider flakes during read-only discovery. The run
    // must fall through to the forced plan instead of ending there.
    const model = scriptedModel([errorTurn('provider blew up'), planTurn()])
    const { plans, planEmitted, terminalError, flushedText } = await runTurnWithRegistry(
      model,
      'make a txt file with the quarterly numbers',
      readRegistry()
    )

    expect(plans).toHaveLength(1)
    expect(planEmitted).toBe(true)
    expect(terminalError).toBeNull()
    expect(flushedText).not.toContain('provider blew up')
  })
})

describe('buildFallbackDocumentPlan — obvious doc requests always plan', () => {
  it('builds write + convert steps for a txt+docx+pdf fish story', () => {
    const steps = buildFallbackDocumentPlan(
      'make a plan to make a txt and docx and pdf file of a fish story'
    )
    expect(steps).not.toBeNull()
    expect(steps!.map((s) => s.tool)).toEqual([
      'write_file',
      'convert_document',
      'convert_document'
    ])
    expect(steps![1].description).toContain('.docx')
    expect(steps![2].description).toContain('.pdf')
  })

  it('returns null for non-document requests', () => {
    expect(buildFallbackDocumentPlan('hello')).toBeNull()
    expect(buildFallbackDocumentPlan('organize my downloads')).toBeNull()
  })
})
