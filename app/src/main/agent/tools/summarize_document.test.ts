import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarizeDocumentTool } from './summarize_document'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

describe('summarize_document — read-only', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(summarizeDocumentTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('summarizes a text file through the injected llm capability', async () => {
    ws.write('report.md', 'Pricing changed in Q3. Revenue doubled.')
    let receivedPrompt = ''
    const outcome = await harness.registry.run({
      tool: 'summarize_document',
      args: { path: 'report.md', focus: 'pricing' },
      ctx: {
        ...harness.ctx,
        llm: {
          complete: async (prompt: string) => {
            receivedPrompt = prompt
            return 'Pricing changed in Q3 and revenue doubled.'
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { summary: string; truncated: boolean }
    expect(result.summary).toContain('Pricing changed in Q3')
    expect(result.truncated).toBe(false)
    expect(receivedPrompt).toContain('Focus especially on: pricing')
    expect(receivedPrompt).toContain('Pricing changed in Q3. Revenue doubled.')
  })

  it('notes truncation when the document exceeds the extract cap', async () => {
    ws.write('long.md', 'y'.repeat(13_000))
    const outcome = await harness.registry.run({
      tool: 'summarize_document',
      args: { path: 'long.md' },
      ctx: { ...harness.ctx, llm: { complete: async () => 'A summary.' } }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { summary: string; truncated: boolean }
    expect(result.truncated).toBe(true)
  })

  it('answers honestly when no llm capability is injected', async () => {
    ws.write('report.md', 'Some content.')
    const outcome = await harness.registry.run({
      tool: 'summarize_document',
      args: { path: 'report.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('not available')
  })

  it('extracts binary documents through the sidecar capability before summarizing', async () => {
    ws.write('report.pdf', '%PDF-not-really')
    const outcome = await harness.registry.run({
      tool: 'summarize_document',
      args: { path: 'report.pdf' },
      ctx: {
        ...harness.ctx,
        documents: {
          extract: async () => ({ text: 'PDF BODY TEXT', truncated: false })
        },
        llm: {
          complete: async (prompt: string) => (prompt.includes('PDF BODY TEXT') ? 'Done.' : '')
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { summary: string }
    expect(result.summary).toBe('Done.')
  })

  it('refuses a workspace escape', async () => {
    const outcome = await harness.registry.run({
      tool: 'summarize_document',
      args: { path: '../secret.txt' },
      ctx: { ...harness.ctx, llm: { complete: async () => 'never' } }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('sandbox')
  })
})
