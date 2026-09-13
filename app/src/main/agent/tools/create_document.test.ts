import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDocumentTool } from './create_document'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

describe('create_document — write access, write_file card shape', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(createDocumentTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('creates a .pptx through the injected sidecar capability with a null beforeExcerpt', async () => {
    const outcome = await harness.registry.run({
      tool: 'create_document',
      args: { path: 'deck.pptx', title: 'Roadmap', items: ['Q1\nShip it'] },
      ctx: {
        ...harness.ctx,
        documents: {
          extract: async () => ({ text: '', truncated: false }),
          create: async (path, title) => {
            expect(path).toContain('deck.pptx')
            expect(title).toBe('Roadmap')
            return { afterExcerpt: 'Roadmap\nQ1', sizeBytes: 1234 }
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      path: string
      size: number
      beforeExcerpt: null
      afterExcerpt: string
    }
    expect(result.size).toBe(1234)
    expect(result.beforeExcerpt).toBeNull()
    expect(result.afterExcerpt).toContain('Roadmap')
  })

  it('creates a .docx through the injected sidecar capability', async () => {
    const outcome = await harness.registry.run({
      tool: 'create_document',
      args: {
        path: 'story.docx',
        title: 'The Midnight Adventure',
        items: ['Whiskers loved midnight.']
      },
      ctx: {
        ...harness.ctx,
        documents: {
          extract: async () => ({ text: '', truncated: false }),
          create: async (path, title) => {
            expect(path).toContain('story.docx')
            expect(title).toBe('The Midnight Adventure')
            return {
              afterExcerpt: 'The Midnight Adventure\nWhiskers loved midnight.',
              sizeBytes: 4096
            }
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    expect(outcome.result).toMatchObject({ size: 4096, beforeExcerpt: null })
  })

  it('is risk 1 for a fresh path and risk 2 when overwriting (write_file mirror)', async () => {
    // risk() runs on sandbox-resolved paths (registry stage 2), so the
    // probe paths below are absolute — relative ones trip the fs guard.
    const { join } = await import('node:path')
    const freshPath = join(ws.root, 'fresh.xlsx')
    const fresh = createDocumentTool.risk(
      { path: freshPath, title: 'T', items: ['a'] },
      harness.ctx
    )
    expect(fresh).toEqual({ level: 1, reason: 'Creates a new file' })
    ws.write('deck.pptx', 'existing-bytes')
    const existingPath = join(ws.root, 'deck.pptx')
    const overwrite = createDocumentTool.risk(
      { path: existingPath, title: 'T', items: ['a'] },
      harness.ctx
    )
    expect(overwrite).toEqual({ level: 2, reason: 'Overwrites an existing file' })
  })

  it('answers honestly when the sidecar is down or the suffix is not creatable', async () => {
    const down = await harness.registry.run({
      tool: 'create_document',
      args: { path: 'deck.pptx', title: 'T', items: ['a'] },
      ctx: harness.ctx
    })
    expect(down.ok).toBe(false)
    expect(down.message).toContain('intelligence service')

    const pdf = await harness.registry.run({
      tool: 'create_document',
      args: { path: 'notes.pdf', title: 'T', items: ['a'] },
      ctx: harness.ctx
    })
    expect(pdf.ok).toBe(false)
    expect(pdf.message).toContain('.pptx')
  })

  it('rejects empty item lists before any stage runs', async () => {
    const outcome = await harness.registry.run({
      tool: 'create_document',
      args: { path: 'deck.pptx', title: 'T', items: [] },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(harness.stages.order).toEqual([])
  })
})
