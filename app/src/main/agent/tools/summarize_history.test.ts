import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarizeHistoryTool } from './summarize_history'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'
import type { ToolExecutionContext } from '../types'

const RECENT = [
  { seq: 1, role: 'user', text: 'Organize my downloads by file type.' },
  { seq: 2, role: 'assistant', text: 'Moved 12 PDFs into Reports/.' },
  { seq: 3, role: 'user', text: 'Now summarize the Q3 report.' }
]

function historyWith(entries: typeof RECENT): ToolExecutionContext['history'] {
  return {
    search: async () => [],
    listRecent: async (limit: number) => entries.slice(-limit).reverse()
  }
}

describe('summarize_history — on-demand conversation summary', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(summarizeHistoryTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('summarizes recent messages through the injected llm capability', async () => {
    let receivedPrompt = ''
    const outcome = await harness.registry.run({
      tool: 'summarize_history',
      args: { focus: 'decisions' },
      ctx: {
        ...harness.ctx,
        history: historyWith(RECENT),
        llm: {
          complete: async (prompt: string) => {
            receivedPrompt = prompt
            return 'You decided to organize downloads; 12 PDFs moved; Q3 summary requested.'
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      summary: string
      messagesCovered: number
      truncated: boolean
    }
    expect(result.summary).toContain('12 PDFs moved')
    expect(result.messagesCovered).toBe(3)
    expect(result.truncated).toBe(false)
    expect(receivedPrompt).toContain('Focus especially on: decisions')
    expect(receivedPrompt).toContain('Organize my downloads')
  })

  it('reports oldest-first order and caps long histories', async () => {
    const long = Array.from({ length: 60 }, (_, i) => ({
      seq: i + 1,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `message number ${i + 1} with enough words to matter`
    }))
    let receivedPrompt = ''
    const outcome = await harness.registry.run({
      tool: 'summarize_history',
      args: {},
      ctx: {
        ...harness.ctx,
        history: historyWith(long),
        llm: {
          complete: async (prompt: string) => {
            receivedPrompt = prompt
            return 'Summary.'
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { messagesCovered: number }
    // Default 30 messages; oldest-first means message 31 leads, message 60 closes.
    expect(result.messagesCovered).toBe(30)
    expect(receivedPrompt).toContain('[31 user]')
    expect(receivedPrompt).toContain('[60 assistant]')
    expect(receivedPrompt).not.toContain('[1 user]')
  })

  it('says so when the conversation is empty', async () => {
    const outcome = await harness.registry.run({
      tool: 'summarize_history',
      args: {},
      ctx: {
        ...harness.ctx,
        history: historyWith([]),
        llm: { complete: async () => 'never' }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { summary: string; messagesCovered: number }
    expect(result.messagesCovered).toBe(0)
    expect(result.summary).toContain('Nothing')
  })

  it('answers honestly when history or llm is missing', async () => {
    const noLlm = await harness.registry.run({
      tool: 'summarize_history',
      args: {},
      ctx: { ...harness.ctx, history: historyWith(RECENT) }
    })
    expect(noLlm.ok).toBe(false)
    expect(noLlm.message).toContain('not available')

    const noHistory = await harness.registry.run({
      tool: 'summarize_history',
      args: {},
      ctx: { ...harness.ctx, llm: { complete: async () => 'never' } }
    })
    expect(noHistory.ok).toBe(false)
    expect(noHistory.message).toContain('not available')
  })
})
