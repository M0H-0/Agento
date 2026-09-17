import { describe, expect, it } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { createToolRegistry } from './registry'
import { buildRunContext, newRunId } from './context'
import {
  buildFallbackDocumentPlan,
  buildFallbackOrganizePlan,
  canonicalPlanToolName,
  canonicalizePlanTools,
  historyListings,
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

  // 2026-09-16: bare "organize my downloads" names no marker word the old
  // list knew — it fell through to Q&A passthrough and answered in prose
  // with zero action. Downloads is a file-work marker.
  it.each(['organize my downloads', 'sort my downloads folder'])('accepts %j', (text) => {
    expect(isLikelyMutatingRequest(text)).toBe(true)
  })

  // 2026-09-16: the live Arabic organize request ("رتّب الملفات...") fell
  // through to the Q&A path because the heuristic was English-only.
  it.each([
    'مجلد التنزيلات عندي فوضوي. رتّب الملفات إلى مجلدات حسب النوع، وأعطني ملخصًا قصيرًا لمستندات التسعير.',
    'نظم المجلد حسب نوع الملفات',
    'انقل ملفات pdf إلى مجلد التقارير'
  ])('accepts Arabic mutating %j', (text) => {
    expect(isLikelyMutatingRequest(text)).toBe(true)
  })

  it.each(['ما هي الملفات الموجودة في المجلد؟', 'مرحبا', 'أخبرني عن مستندات التسعير'])(
    'rejects Arabic Q&A %j',
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

  it('drops discovery narration when the plan lands; the thread gets one summary', async () => {
    // 2026-09-16 (user report): the model narrated a full essay before
    // emitting, so the plan arrived under a wall of prose. On plan success
    // narration is dropped — the panel carries the plan, the thread gets
    // tool cards + exactly one synthesized summary.
    const model = scriptedModel([textTurn('I will plan the txt file.'), planTurn()])
    const { plans, planEmitted, terminalError, flushedText } = await runTurnWithRegistry(
      model,
      'make a txt file that have a story about cats',
      readRegistry()
    )

    expect(plans).toHaveLength(1)
    expect(planEmitted).toBe(true)
    expect(terminalError).toBeNull()
    expect(flushedText).not.toContain('I will plan the txt file.')
    expect(flushedText).toContain("Here's my plan")
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

describe('canonicalPlanToolName — hallucinated plan tools map onto the registry', () => {
  // 2026-09-16 live: an organize plan named make_dir / move_file /
  // final_message — none executable, none traceable to a step.
  it.each([
    ['make_dir', 'create_dir'],
    ['move_file', 'move_path'],
    ['copy_file', 'copy_path'],
    ['delete_file', 'delete_path'],
    ['create_file', 'write_file'],
    ['list_files', 'list_dir'],
    ['Move File', 'move_path']
  ])('aliases %j to %j', (input, expected) => {
    expect(canonicalPlanToolName(input)).toBe(expected)
  })

  it.each(['move_path', 'write_file', 'final_message', 'ask_user', 'emit_plan'])(
    'leaves %j untouched',
    (tool) => {
      expect(canonicalPlanToolName(tool)).toBe(tool)
    }
  )

  it('canonicalizePlanTools rewrites only the aliased steps', () => {
    const steps = canonicalizePlanTools([
      {
        id: '1',
        description: 'Make folders',
        tool: 'make_dir',
        riskLevel: 1,
        requiresApproval: false
      },
      {
        id: '2',
        description: 'Move files',
        tool: 'move_path',
        riskLevel: 2,
        requiresApproval: true
      }
    ])
    expect(steps.map((s) => s.tool)).toEqual(['create_dir', 'move_path'])
    expect(steps[0].description).toBe('Make folders')
  })

  it('a forced plan naming move_file reaches the panel as move_path', async () => {
    const aliased = {
      steps: [
        {
          id: 's1',
          description: 'Move the PDFs into Finance',
          tool: 'move_file',
          riskLevel: 2,
          requiresApproval: true
        }
      ]
    }
    const model = scriptedModel([
      {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-input-start', id: 'plan-1', toolName: 'emit_plan' },
            { type: 'tool-input-delta', id: 'plan-1', delta: JSON.stringify(aliased) },
            { type: 'tool-input-end', id: 'plan-1' },
            {
              type: 'tool-call',
              toolCallId: 'plan-1',
              toolName: 'emit_plan',
              input: JSON.stringify(aliased)
            },
            {
              type: 'finish',
              finishReason: 'tool-calls',
              usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
            }
          ] as LanguageModelV2StreamPart[]
        })
      }
    ])
    const { plans, planEmitted, terminalError } = await runTurn(model, 'sort the files')
    expect(planEmitted).toBe(true)
    expect(terminalError).toBeNull()
    expect(plans).toHaveLength(1)
    expect(plans[0]?.[0]?.tool).toBe('move_path')
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

  it('returns null for organize/move prompts that merely mention PDFs', () => {
    expect(
      buildFallbackDocumentPlan(
        'move every PDF invoice into a folder called Finance, every image into Pictures, and every presentation into Presentations. Keep the plan to 5 small steps.'
      )
    ).toBeNull()
    expect(buildFallbackDocumentPlan('organize PDFs/images/presentations into folders')).toBeNull()
    expect(
      buildFallbackDocumentPlan('create a folder called Finance and move the PDFs there')
    ).toBeNull()
  })

  // 2026-09-16: Arabic gates mirror the English creation-only rule.
  it('returns null for an Arabic organize request mentioning PDFs', () => {
    expect(buildFallbackDocumentPlan('رتّب ملفات pdf في مجلدات حسب النوع')).toBeNull()
  })

  it('builds a write step for an Arabic txt creation request', () => {
    const steps = buildFallbackDocumentPlan('أنشئ ملف txt فيه قصة قصيرة')
    expect(steps).not.toBeNull()
    expect(steps![0].tool).toBe('write_file')
  })
})

describe('buildFallbackOrganizePlan — grounded organize plans when the model only talks', () => {
  // 2026-09-16 live: the Arabic organize request returned prose-without-a-
  // plan on every attempt (forced, auto, extraction). The deterministic
  // fallback grounds buckets + counts in the discovery listing instead.
  const LISTING = [
    {
      entries: [
        { name: 'report.pdf', type: 'file' as const },
        { name: 'invoice.pdf', type: 'file' as const },
        { name: 'notes.txt', type: 'file' as const },
        { name: 'photo.jpg', type: 'file' as const },
        { name: 'pricing.docx', type: 'file' as const },
        { name: 'data.csv', type: 'file' as const },
        { name: 'mystery.xyz', type: 'file' as const },
        { name: 'subfolder', type: 'directory' as const }
      ]
    }
  ]

  it('builds create + per-bucket moves with counts for the live Arabic request', () => {
    const steps = buildFallbackOrganizePlan(
      'مجلد التنزيلات عندي فوضوي. رتّب الملفات إلى مجلدات حسب النوع، وأعطني ملخصًا قصيرًا لمستندات التسعير.',
      LISTING
    )
    expect(steps).not.toBeNull()
    const tools = steps!.map((s) => s.tool)
    // create_dir, one move_path per populated bucket, then the summary tail.
    expect(tools[0]).toBe('create_dir')
    expect(tools).toContain('move_path')
    expect(tools.slice(-2)).toEqual(['read_file', 'write_file'])
    expect(steps![0].description).toContain('PDFs')
    const pdfMove = steps!.find((s) => s.description.includes('PDFs') && s.tool === 'move_path')
    expect(pdfMove?.description).toContain('2')
    expect(pdfMove?.requiresApproval).toBe(true)
    // Unknown extensions land in Others; directories are never moved.
    expect(steps!.some((s) => s.description.includes('Others'))).toBe(true)
    expect(steps!.some((s) => s.description.includes('subfolder'))).toBe(false)
  })

  it('skips the summary tail when none is asked', () => {
    const steps = buildFallbackOrganizePlan('organize my files by type', LISTING)
    expect(steps).not.toBeNull()
    expect(steps!.map((s) => s.tool)).not.toContain('read_file')
    expect(steps!.map((s) => s.tool)).not.toContain('write_file')
  })

  it('writes Arabic step descriptions for an Arabic request (folder names stay literal)', () => {
    const steps = buildFallbackOrganizePlan(
      'مجلد التنزيلات عندي فوضوي. رتّب الملفات إلى مجلدات حسب النوع، وأعطني ملخصًا قصيرًا لمستندات التسعير.',
      LISTING
    )
    expect(steps).not.toBeNull()
    expect(steps![0].description).toMatch(/أنشئ مجلد/)
    expect(steps![0].description).toContain('PDFs')
    const pdfMove = steps!.find((s) => s.tool === 'move_path' && s.description.includes('PDFs'))
    expect(pdfMove?.description).toMatch(/انقل.*\(2\).*PDFs/)
    expect(steps!.slice(-2)[0].description).toMatch(/التسعير/)
    expect(steps!.slice(-1)[0].description).toContain('pricing_summary.txt')
  })

  it('keeps English step descriptions for an English request', () => {
    const steps = buildFallbackOrganizePlan('organize my files by type', LISTING)
    expect(steps).not.toBeNull()
    expect(steps![0].description).toMatch(/Create a folder/)
    const pdfMove = steps!.find((s) => s.tool === 'move_path' && s.description.includes('PDFs'))
    expect(pdfMove?.description).toMatch(/Move the 2 PDF files into PDFs/)
  })

  it('writes Arabic descriptions for an Arabic document fallback', () => {
    const steps = buildFallbackDocumentPlan('أنشئ ملف txt فيه قصة قصيرة')
    expect(steps).not.toBeNull()
    expect(steps![0].description).toMatch(/اكتب/)
  })

  it.each(['hello', 'make a txt file with a story', 'summarize this report for me'])(
    'returns null for non-organize %j',
    (text) => {
      expect(buildFallbackOrganizePlan(text, LISTING)).toBeNull()
    }
  )

  it('returns null without a usable listing', () => {
    expect(buildFallbackOrganizePlan('organize my files by type', [])).toBeNull()
    expect(
      buildFallbackOrganizePlan('organize my files by type', [
        { entries: [{ name: 'empty-dir', type: 'directory' as const }] }
      ])
    ).toBeNull()
  })

  it('an organize run that never plans still emits the grounded fallback', async () => {
    // Discovery lists (canned list_dir stub) but every plan path comes back
    // as prose: forced + auto attempts text-only, extraction text without
    // JSON. The run must end with a plan, not PLAN_FAILED_COPY.
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-organize-fallback',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    const listStub: ToolDefinition<{ path?: string }, unknown> = {
      name: 'list_dir',
      description: 'Stub listing',
      access: 'read',
      inputSchema: z.object({ path: z.string().optional() }),
      pathFields: [],
      risk: () => ({ level: 0, reason: 'stub' }),
      describe: () => ({ title: 'Stub listing', group: 'test' }),
      execute: async () => ({
        ok: true,
        output: {
          path: '.',
          entries: [
            { name: 'a.pdf', type: 'file' },
            { name: 'b.pdf', type: 'file' },
            { name: 'c.txt', type: 'file' }
          ],
          truncated: false,
          total: 3
        }
      })
    }
    registry.define(listStub)
    const listTurnChunks: LanguageModelV2StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'list-1', toolName: 'list_dir' },
      { type: 'tool-input-delta', id: 'list-1', delta: '{}' },
      { type: 'tool-input-end', id: 'list-1' },
      { type: 'tool-call', toolCallId: 'list-1', toolName: 'list_dir', input: '{}' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }
      }
    ]
    const emptyTurnChunks: LanguageModelV2StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 }
      }
    ]
    const model = scriptedModel([
      { stream: simulateReadableStream({ chunks: listTurnChunks }) },
      { stream: simulateReadableStream({ chunks: emptyTurnChunks }) },
      textTurn('I will organize everything by type.'),
      textTurn('Organizing now, one moment.'),
      textTurn('Almost done planning.')
    ])
    const sentParts: UIMessageChunk[] = []
    const plans: PlanStep[][] = []
    const outcome = await runPlanModeTurn({
      model,
      system: 'test system',
      messages: [
        {
          id: 'u1',
          role: 'user' as const,
          parts: [
            {
              type: 'text' as const,
              text: 'organize my files by type and summarize the pricing docs'
            }
          ]
        }
      ],
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: (steps) => plans.push(steps),
      signal: new AbortController().signal
    })

    expect(outcome.planEmitted).toBe(true)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.[0]).toMatchObject({ tool: 'create_dir' })
    expect(plans[0]?.map((s) => s.tool)).toContain('move_path')
    const terminalError =
      sentParts
        .filter((p) => p.type === 'error')
        .map((p) => (p as { errorText: string }).errorText)
        .at(-1) ?? null
    expect(terminalError).toBeNull()
    const flushedText = sentParts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { delta?: string }).delta ?? '')
      .join('')
    expect(flushedText).toContain("Here's my plan")
  })

  it('historyListings harvests the freshest folder listing, ignoring decoys', () => {
    const listing = (
      names: string[]
    ): {
      type: 'tool-list_dir'
      toolCallId: string
      state: 'output-available'
      input: { path: string }
      output: { entries: { name: string; type: 'file' }[] }
    } => ({
      type: 'tool-list_dir' as const,
      toolCallId: `call-${names.length}`,
      state: 'output-available' as const,
      input: { path: '.' },
      output: { entries: names.map((name) => ({ name, type: 'file' as const })) }
    })
    const messages = [
      { id: 'u0', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] },
      {
        id: 'a-old',
        role: 'assistant' as const,
        parts: [listing(['old.pdf']), { type: 'text' as const, text: 'old answer' }]
      },
      {
        id: 'a-err',
        role: 'assistant' as const,
        parts: [
          {
            type: 'tool-list_dir' as const,
            toolCallId: 'call-err',
            state: 'output-error' as const,
            input: { path: '.' },
            errorText: 'denied'
          }
        ]
      },
      {
        id: 'a-other',
        role: 'assistant' as const,
        parts: [
          {
            type: 'tool-search_files' as const,
            toolCallId: 'call-s',
            state: 'output-available' as const,
            input: {},
            output: { entries: [{ name: 'nope.pdf', type: 'file' }] }
          }
        ]
      },
      { id: 'a-new', role: 'assistant' as const, parts: [listing(['a.pdf', 'b.txt'])] }
    ]
    const found = historyListings(messages)
    expect(found).toHaveLength(2)
    // Freshest first: the newest listing grounds the fallback.
    expect(found[0]?.entries.map((e) => e.name)).toEqual(['a.pdf', 'b.txt'])
    expect(found[1]?.entries.map((e) => e.name)).toEqual(['old.pdf'])
  })

  it('an organize run with no listing of its own falls back on the conversation history', async () => {
    // Live shape (2026-09-16): the previous turn already listed the folder,
    // so this run's discovery and every plan attempt come back as prose
    // with zero tool calls — the fallback must ground in the persisted
    // `tool-list_dir` part instead of ending in PLAN_FAILED_COPY.
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-organize-history',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = readRegistry()
    const model = scriptedModel([
      textTurn('I can see the files from before.'),
      textTurn('I will organize everything by type.'),
      textTurn('Organizing now, one moment.'),
      textTurn('Almost done planning.')
    ])
    const historyPart = {
      type: 'tool-list_dir' as const,
      toolCallId: 'call_hist',
      state: 'output-available' as const,
      input: { path: '.' },
      output: {
        entries: [
          { name: 'فاتورة.pdf', type: 'file' as const },
          { name: 'notes.txt', type: 'file' as const }
        ]
      }
    }
    const sentParts: UIMessageChunk[] = []
    const plans: PlanStep[][] = []
    const outcome = await runPlanModeTurn({
      model,
      system: 'test system',
      messages: [
        {
          id: 'u0',
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: 'what files are in this folder?' }]
        },
        { id: 'a0', role: 'assistant' as const, parts: [historyPart] },
        {
          id: 'u1',
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: 'organize my files by type' }]
        }
      ],
      registry,
      ctx: run.ctx,
      sendPart: (part) => sentParts.push(part),
      onPlanCreated: (steps) => plans.push(steps),
      signal: new AbortController().signal
    })

    expect(outcome.planEmitted).toBe(true)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.[0]).toMatchObject({ tool: 'create_dir' })
    expect(plans[0]?.map((s) => s.tool)).toContain('move_path')
    // Grounded in the history listing: one PDF bucket move, one Text move.
    const descriptions = (plans[0] ?? []).map((s) => s.description).join('\n')
    expect(descriptions).toContain('PDFs')
    expect(descriptions).toContain('Text')
    const terminalError =
      sentParts
        .filter((p) => p.type === 'error')
        .map((p) => (p as { errorText: string }).errorText)
        .at(-1) ?? null
    expect(terminalError).toBeNull()
    const flushedText = sentParts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { delta?: string }).delta ?? '')
      .join('')
    expect(flushedText).toContain("Here's my plan")
  })
})
