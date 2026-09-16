import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { createToolRegistry } from './registry'
import { buildRunContext, newRunId } from './context'
import { isLikelyMutatingRequest, runPlanFirstTurn } from './plan-run'
import { emitPlanTool } from './tools/emit_plan'
import type { PlanStep } from './tools/emit_plan'
import { writeFileTool } from './tools/write_file'
import { createTempWorkspace } from './testing/harness'

// Regression for the "make a txt file and it just stopped" report:
// plan → gate approve → write_file executes → real file lands on disk.
describe('plan-run + write_file — txt creation end to end', () => {
  it('creates notes.txt through the full loop', async () => {
    const ws = createTempWorkspace()
    try {
      const run = buildRunContext({
        sender: { emit: () => undefined },
        sessionId: 's-txt',
        runId: newRunId(),
        workspaceRoot: ws.root
      })
      const registry = createToolRegistry()
      registry.define(emitPlanTool)
      registry.define(writeFileTool)

      const planInput = JSON.stringify({
        steps: [
          {
            id: 's1',
            description: 'Create notes.txt with the requested text',
            tool: 'write_file',
            riskLevel: 1,
            requiresApproval: false
          }
        ]
      })
      const planChunks: LanguageModelV2StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: 'plan-1', toolName: 'emit_plan' },
        { type: 'tool-input-delta', id: 'plan-1', delta: planInput },
        { type: 'tool-input-end', id: 'plan-1' },
        {
          type: 'tool-call',
          toolCallId: 'plan-1',
          toolName: 'emit_plan',
          input: planInput
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
        }
      ]
      const writeInput = JSON.stringify({ path: 'notes.txt', content: 'hello from agento' })
      const execChunks: LanguageModelV2StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: 'act-1', toolName: 'write_file' },
        { type: 'tool-input-delta', id: 'act-1', delta: writeInput },
        { type: 'tool-input-end', id: 'act-1' },
        { type: 'tool-call', toolCallId: 'act-1', toolName: 'write_file', input: writeInput },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
        }
      ]
      const followupChunks: LanguageModelV2StreamPart[] = [
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
        { stream: simulateReadableStream({ chunks: followupChunks }) }
      ]
      const model = new MockLanguageModelV2({
        provider: 'mock',
        modelId: 'plan-run-write-file',
        doStream: async () => {
          const next = streams.shift()
          if (!next) throw new Error('unexpected extra doStream call')
          return next as never
        }
      })

      const sentParts: UIMessageChunk[] = []
      const plans: PlanStep[][] = []
      const outcome = await runPlanFirstTurn({
        model,
        system: 'test system',
        messages: [
          {
            id: 'u1',
            role: 'user' as const,
            parts: [{ type: 'text' as const, text: 'make a txt file called notes.txt' }]
          }
        ],
        registry,
        ctx: run.ctx,
        requestPlanStart: () => Promise.resolve({ approved: true }),
        sendPart: (part) => sentParts.push(part),
        onPlanCreated: (steps) => plans.push(steps),
        signal: new AbortController().signal
      })

      expect(outcome.planEmitted).toBe(true)
      expect(outcome.planApproved).toBe(true)
      expect(plans).toHaveLength(1)
      expect(readFileSync(join(ws.root, 'notes.txt'), 'utf8')).toBe('hello from agento')
      // The write_file tool parts reach the thread (only emit_plan is suppressed).
      expect(
        sentParts
          .filter((p) => p.type === 'tool-input-available')
          .map((p) => (p as { toolName: string }).toolName)
      ).toContain('write_file')
      // S5-001: tool parts persist alongside text so reopened history
      // renders the same cards as the live run (emit_plan stays suppressed).
      const persisted = outcome.assistantMessage?.parts ?? []
      expect(persisted).toContainEqual({ type: 'text', text: 'done' })
      const writePart = persisted.find(
        (p) => (p as { type?: string }).type === 'tool-write_file'
      ) as { state?: string; output?: unknown } | undefined
      expect(writePart?.state).toBe('output-available')
    } finally {
      ws.cleanup()
    }
  })

  it('text-only answer to a file request fails loudly instead of looking stopped', async () => {
    const run = buildRunContext({
      sender: { emit: () => undefined },
      sessionId: 's-txt-fail',
      runId: newRunId(),
      workspaceRoot: 'C:/ws'
    })
    const registry = createToolRegistry()
    registry.define(emitPlanTool)
    registry.define(writeFileTool)
    const greeting = (id: string): LanguageModelV2StreamPart[] => [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: 'Sure!' },
      { type: 'text-end', id },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      }
    ]
    const streams = [
      { stream: simulateReadableStream({ chunks: greeting('g1') }) },
      { stream: simulateReadableStream({ chunks: greeting('g2') }) }
    ]
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'plan-run-write-file-textonly',
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
        {
          id: 'u1',
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: 'make a txt file called notes.txt' }]
        }
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
    expect(outcome.terminalSent).toBe(true)
    expect(sentParts.some((p) => p.type === 'error')).toBe(true)
  })

  it('isLikelyMutatingRequest separates greetings from file work', () => {
    expect(isLikelyMutatingRequest('hey')).toBe(false)
    expect(isLikelyMutatingRequest('make a txt file called notes.txt')).toBe(true)
    expect(isLikelyMutatingRequest('create a new text file with my meeting notes')).toBe(true)
  })
})
