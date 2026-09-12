import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchHistoryTool } from './search_history'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'
import type { HistoryRecent, ToolExecutionContext } from '../types'

// Deterministic fake embedder: one dim per vocab word, 1 when the word
// appears — paraphrase ranking is assertable without a real model.
function makeFakeEmbedder(vocab: string[]): {
  embedTexts(texts: string[]): Promise<number[][]>
  embeddedTexts: string[]
} {
  const embeddedTexts: string[] = []
  const embedTexts = async (texts: string[]): Promise<number[][]> => {
    embeddedTexts.push(...texts)
    return texts.map((text) => {
      const lowered = text.toLowerCase()
      return vocab.map((word) => (lowered.includes(word) ? 1 : 0))
    })
  }
  return { embedTexts, embeddedTexts }
}

const RECENT: HistoryRecent[] = [
  { seq: 1, role: 'user', text: 'Please organize my downloads folder.' },
  { seq: 2, role: 'assistant', text: 'Done — moved 12 files into folders.' },
  { seq: 3, role: 'user', text: 'Where did I write about the cost breakdown for Q3?' },
  {
    seq: 4,
    role: 'assistant',
    text: 'The Q3 cost breakdown is in finance/report.md with rates per team.'
  }
]

function keywordHistory(): ToolExecutionContext['history'] {
  return {
    search: async (query: string, limit = 5) => {
      const lowered = query.toLowerCase()
      return RECENT.filter((entry) => entry.text.toLowerCase().includes(lowered))
        .reverse()
        .slice(0, limit)
        .map((entry) => ({ seq: entry.seq, role: entry.role, excerpt: entry.text }))
    },
    listRecent: async (limit: number) => RECENT.slice(-limit).reverse()
  }
}

describe('search_history — L1 session recall', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(searchHistoryTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('finds a paraphrase through the semantic engine (pricing → cost breakdown)', async () => {
    const fake = makeFakeEmbedder(['pricing', 'cost', 'breakdown', 'downloads'])
    const outcome = await harness.registry.run({
      tool: 'search_history',
      args: { query: 'pricing' },
      ctx: { ...harness.ctx, history: keywordHistory(), embed: { embedTexts: fake.embedTexts } }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      engine: string
      matches: { excerpt: string; score: number }[]
    }
    expect(result.engine).toBe('semantic')
    expect(result.matches.length).toBeGreaterThan(0)
    // The cost-breakdown answer outranks the downloads chatter.
    expect(result.matches[0].excerpt).toContain('cost breakdown')
    expect(typeof result.matches[0].score).toBe('number')
  })

  it('falls back to keyword honestly when the embedder throws', async () => {
    const outcome = await harness.registry.run({
      tool: 'search_history',
      args: { query: 'downloads' },
      ctx: {
        ...harness.ctx,
        history: keywordHistory(),
        embed: {
          embedTexts: async () => {
            throw new Error('The embedding model could not be loaded.')
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { engine: string; matches: { excerpt: string }[] }
    expect(result.engine).toBe('keyword')
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches[0].excerpt).toContain('downloads')
  })

  it('uses keyword directly when no embedder is injected', async () => {
    const outcome = await harness.registry.run({
      tool: 'search_history',
      args: { query: 'Q3' },
      ctx: { ...harness.ctx, history: keywordHistory() }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { engine: string; matches: unknown[] }
    expect(result.engine).toBe('keyword')
    expect(result.matches.length).toBe(2)
  })

  it('answers honestly when no history capability is injected', async () => {
    const outcome = await harness.registry.run({
      tool: 'search_history',
      args: { query: 'pricing' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('not available')
  })

  it('schema-rejects an empty query', async () => {
    const outcome = await harness.registry.run({
      tool: 'search_history',
      args: { query: '' },
      ctx: { ...harness.ctx, history: keywordHistory() }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
  })
})
