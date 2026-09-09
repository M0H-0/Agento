import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { semanticSearchTool } from './semantic_search'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

describe('semantic_search — read-only', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(semanticSearchTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('returns ranked results from the injected capability', async () => {
    const outcome = await harness.registry.run({
      tool: 'semantic_search',
      args: { query: 'where did I write about pricing?', top_k: 3 },
      ctx: {
        ...harness.ctx,
        semantic: {
          search: async (query: string, topK?: number) => {
            expect(query).toBe('where did I write about pricing?')
            expect(topK).toBe(3)
            return [{ path: 'docs/pricing.md', snippet: 'Pricing tiers and invoices', score: 0.91 }]
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      query: string
      results: { path: string; score: number }[]
    }
    expect(result.results[0].path).toBe('docs/pricing.md')
    expect(result.results[0].score).toBe(0.91)
  })

  it('answers honestly when no semantic capability is injected', async () => {
    const outcome = await harness.registry.run({
      tool: 'semantic_search',
      args: { query: 'pricing' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('not available')
  })

  it('passes capability failures through as plain-language errors', async () => {
    const outcome = await harness.registry.run({
      tool: 'semantic_search',
      args: { query: 'pricing' },
      ctx: {
        ...harness.ctx,
        semantic: {
          search: async () => {
            throw new Error('The embedding service is not running right now.')
          }
        }
      }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('embedding service')
  })

  it('schema-rejects an empty query', async () => {
    const outcome = await harness.registry.run({
      tool: 'semantic_search',
      args: { query: '' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
  })
})
