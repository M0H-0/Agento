import { describe, expect, it } from 'vitest'
import { AssistantMessageAccumulator } from './assistant-accumulator'

// S5-001: reopened sessions rendered zero tool cards because the accumulator
// kept text only. Tool-call parts must persist in the AI SDK v5 message
// shape the renderer's tool-UI adapter reads live.
describe('AssistantMessageAccumulator — tool persistence (S5-001)', () => {
  it('persists input-available → output-available tool parts around text', () => {
    const acc = new AssistantMessageAccumulator()
    acc.addChunk({ type: 'text-start', id: 't1' })
    acc.addChunk({ type: 'text-delta', id: 't1', delta: 'working' })
    acc.addChunk({ type: 'text-end', id: 't1' })
    acc.addChunk({
      type: 'tool-input-available',
      toolCallId: 'c1',
      toolName: 'read_file',
      input: { path: 'a.txt' }
    })
    acc.addChunk({ type: 'tool-output-available', toolCallId: 'c1', output: { text: 'hi' } })
    const message = acc.toUIMessage()
    expect(message).not.toBeNull()
    expect(message?.parts).toEqual([
      { type: 'text', text: 'working' },
      {
        type: 'tool-read_file',
        toolCallId: 'c1',
        state: 'output-available',
        input: { path: 'a.txt' },
        output: { text: 'hi' }
      }
    ])
  })

  it('persists a tool-only run (no text) instead of null', () => {
    const acc = new AssistantMessageAccumulator()
    acc.addChunk({
      type: 'tool-input-available',
      toolCallId: 'c2',
      toolName: 'move_path',
      input: { from: 'a', to: 'b' }
    })
    acc.addChunk({ type: 'tool-output-available', toolCallId: 'c2', output: { message: 'Done.' } })
    const message = acc.toUIMessage()
    expect(message).not.toBeNull()
    expect(message?.parts).toHaveLength(1)
  })

  it('records output-error parts for failed tools', () => {
    const acc = new AssistantMessageAccumulator()
    acc.addChunk({
      type: 'tool-input-available',
      toolCallId: 'c3',
      toolName: 'move_path',
      input: { from: 'missing', to: 'b' }
    })
    acc.addChunk({ type: 'tool-output-error', toolCallId: 'c3', errorText: 'not found' })
    const message = acc.toUIMessage()
    const part = message?.parts[0] as { state?: string; errorText?: string } | undefined
    expect(part?.state).toBe('output-error')
    expect(part?.errorText).toBe('not found')
  })

  it('never persists emit_plan parts (the PlanPanel owns the plan)', () => {
    const acc = new AssistantMessageAccumulator()
    acc.addChunk({ type: 'text-start', id: 't1' })
    acc.addChunk({ type: 'text-delta', id: 't1', delta: 'plan ready' })
    acc.addChunk({ type: 'text-end', id: 't1' })
    acc.addChunk({
      type: 'tool-input-available',
      toolCallId: 'plan-1',
      toolName: 'emit_plan',
      input: { steps: [] }
    })
    acc.addChunk({ type: 'tool-output-available', toolCallId: 'plan-1', output: { ok: true } })
    expect(acc.toUIMessage()?.parts).toEqual([{ type: 'text', text: 'plan ready' }])
  })

  it('drops empty text parts but keeps input-only tools (stopped mid-call)', () => {
    const acc = new AssistantMessageAccumulator()
    acc.addChunk({ type: 'text-start', id: 't1' })
    acc.addChunk({ type: 'text-end', id: 't1' })
    acc.addChunk({
      type: 'tool-input-available',
      toolCallId: 'c4',
      toolName: 'write_file',
      input: { path: 'x.txt' }
    })
    const message = acc.toUIMessage()
    expect(message?.parts).toEqual([
      {
        type: 'tool-write_file',
        toolCallId: 'c4',
        state: 'input-available',
        input: { path: 'x.txt' }
      }
    ])
  })

  it('still persists nothing on stream error', () => {
    const acc = new AssistantMessageAccumulator()
    acc.addChunk({ type: 'text-start', id: 't1' })
    acc.addChunk({ type: 'text-delta', id: 't1', delta: 'partial' })
    acc.addChunk({ type: 'error', errorText: 'boom' })
    expect(acc.toUIMessage()).toBeNull()
    expect(acc.isFailed()).toBe(true)
  })
})
