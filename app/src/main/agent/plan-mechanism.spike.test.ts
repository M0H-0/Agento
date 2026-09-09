import { describe, expect, it } from 'vitest'
import { stepCountIs, streamText, tool, zodSchema } from 'ai'
import type { UIMessageChunk } from 'ai'
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'

// M3.0 SPIKE (docs/03 §2: "Verify the exact tool-choice forcing API against `ai`
// v5 during M2/M3 and Devlog any difference"). Proves the plan mechanism on the
// pinned ai@5.0.250 with NO network and NO real provider, via `streamText` —
// the loop chat.ts actually runs:
//
//   1. `toolChoice: { type: 'tool', toolName: 'emit_plan' }` reaches the model
//      call verbatim — a real provider must honor it (structural plan-first,
//      not merely prompted — docs/03 §2, docs/06 §2).
//   2. `stopWhen: [stepCountIs(1)]` ends the loop after the single plan step —
//      the mock records exactly one doStream call (a second call would exhaust
//      the single scripted turn and fail).
//   3. The emit_plan tool call flows through `toUIMessageStream()` as a
//      `tool-input-available` part (the shape chat.ts forwards and cards
//      render), with a terminal `finish`.
//
// generateText is NOT exercised: MockLanguageModelV2 implements doStream only
// (its doGenerate throws "Not implemented"), and the production loop is
// streamText — generateText would prove nothing extra.
//
// Kept as a regression for the M3.1 mechanism decision; delete only with a
// Devlog note.

const planSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      tool: z.string(),
      riskLevel: z.number().int().min(0).max(3),
      requiresApproval: z.boolean()
    })
  )
})

const PLAN_STEPS = {
  steps: [
    {
      id: 's1',
      description: 'Move the PDF invoices into a folder called Finance',
      tool: 'move_path',
      riskLevel: 2,
      requiresApproval: true
    }
  ]
}

// One scripted model turn: stream-start → tool-input parts → tool-call → finish.
// The provider-v2 tool-call part carries `input` as the raw JSON STRING
// (@ai-sdk/provider LanguageModelV2ToolCall) — the SDK parses it against the
// tool's schema.
const PLAN_CHUNKS: LanguageModelV2StreamPart[] = [
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

let executed = 0
const emitPlanTool = tool({
  description: 'Emit the structured plan for user approval',
  inputSchema: zodSchema(planSchema),
  execute: async (input) => {
    executed += 1
    return { ok: true, output: input }
  }
})

function spikeModel(): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    provider: 'mock',
    modelId: 'spike',
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: PLAN_CHUNKS })
    })
  })
}

describe('M3.0 spike — plan mechanism (toolChoice + stepCountIs)', () => {
  it('streamText: forced toolChoice reaches the model; stepCountIs(1) stops after one step', async () => {
    executed = 0
    const model = spikeModel()
    const result = streamText({
      model,
      tools: { emit_plan: emitPlanTool },
      toolChoice: { type: 'tool', toolName: 'emit_plan' },
      stopWhen: [stepCountIs(1)],
      prompt: 'move the files'
    })
    const steps = await result.steps

    // Exactly one model request: stepCountIs(1) ended the loop before a second
    // doStream call (the mock has one scripted turn — a second call would throw).
    expect(model.doStreamCalls.length).toBe(1)
    expect(steps.length).toBe(1)

    // The forced choice was passed down verbatim (what a real provider must honor).
    const call = model.doStreamCalls[0]
    expect(call?.toolChoice).toEqual({ type: 'tool', toolName: 'emit_plan' })

    // The plan tool ran with the scripted steps.
    const toolCall = steps[0]?.toolCalls.find((tc) => tc.toolName === 'emit_plan')
    expect(toolCall).toBeDefined()
    expect(executed).toBe(1)
  })

  it('streamText: the plan call flows through toUIMessageStream() and terminates cleanly', async () => {
    executed = 0
    const model = spikeModel()
    const result = streamText({
      model,
      tools: { emit_plan: emitPlanTool },
      toolChoice: { type: 'tool', toolName: 'emit_plan' },
      stopWhen: [stepCountIs(1)],
      prompt: 'move the files'
    })

    const parts: UIMessageChunk[] = []
    for await (const part of result.toUIMessageStream()) {
      parts.push(part)
    }

    expect(model.doStreamCalls.length).toBe(1)
    const toolPart = parts.find((part) => part.type === 'tool-input-available')
    expect(toolPart).toBeDefined()
    expect(toolPart?.type === 'tool-input-available' && toolPart.toolName === 'emit_plan').toBe(
      true
    )
    expect(parts.some((part) => part.type === 'finish')).toBe(true)
    expect(executed).toBe(1)
  })
})
