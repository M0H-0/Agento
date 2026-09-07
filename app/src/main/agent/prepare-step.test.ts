import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { stripStepReasoning } from './prepare-step'

// M2.4 live-gate regression test: Groq rejects `reasoning_content` on ANY
// provider request, and intra-turn steps resend the previous step's assistant
// message verbatim — so a tool turn whose first step reasoned dies on step 2
// with a 400 unless prepareStep strips reasoning parts first.

function assistantWithReasoning(): ModelMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'hello' }
    ]
  } as ModelMessage
}

describe('stripStepReasoning — intra-turn Groq guard', () => {
  it('drops reasoning parts from assistant messages, keeps text', () => {
    const out = stripStepReasoning([{ role: 'user', content: 'hi' }, assistantWithReasoning()])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ role: 'user', content: 'hi' })
    const assistant = out[1]
    expect(assistant.role).toBe('assistant')
    if (assistant.role !== 'assistant' || typeof assistant.content === 'string') {
      throw new Error('expected assistant content array')
    }
    expect(assistant.content.map((part) => part.type)).toEqual(['text'])
  })

  it('leaves tool-call parts untouched', () => {
    const withTool = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'hmm' },
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'list_dir',
          input: { path: '.' }
        }
      ]
    } as unknown as ModelMessage
    const out = stripStepReasoning([withTool])
    const assistant = out[0]
    if (assistant.role !== 'assistant' || typeof assistant.content === 'string') {
      throw new Error('expected assistant content array')
    }
    expect(assistant.content.map((part) => part.type)).toEqual(['tool-call'])
  })

  it('passes through string-content and non-assistant messages unchanged', () => {
    const stringAssistant = { role: 'assistant', content: 'plain' } as ModelMessage
    const tool = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 't1',
          toolName: 'x',
          output: { type: 'json', value: {} }
        }
      ]
    } as unknown as ModelMessage
    const out = stripStepReasoning([stringAssistant, tool])
    expect(out[0]).toBe(stringAssistant)
    expect(out[1]).toBe(tool)
  })

  it('handles an empty message list', () => {
    expect(stripStepReasoning([])).toEqual([])
  })
})
