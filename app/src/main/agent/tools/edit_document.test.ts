import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editDocumentTool } from './edit_document'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

describe('edit_document', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(editDocumentTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('edits a markdown file with exactly-once anchors and excerpts', async () => {
    ws.write('notes.md', '# Plan\n\nShip the demo on Friday.\n\nKeep it simple.\n')
    const outcome = await harness.registry.run({
      tool: 'edit_document',
      args: { path: 'notes.md', edits: [{ anchor: 'on Friday', replacement: 'on Monday' }] },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      beforeExcerpt: string
      afterExcerpt: string
      editsApplied: number
    }
    expect(ws.read('notes.md')).toContain('on Monday')
    expect(result.beforeExcerpt).toContain('on Friday')
    expect(result.afterExcerpt).toContain('on Monday')
    expect(result.editsApplied).toBe(1)
    expect(harness.stages.order).toEqual(['approval', 'snapshot'])
  })

  it('applies sequential text edits and refuses zero/multi matches honestly', async () => {
    ws.write('a.txt', 'one two three')
    const multi = await harness.registry.run({
      tool: 'edit_document',
      args: {
        path: 'a.txt',
        edits: [
          { anchor: 'one', replacement: '1' },
          { anchor: 'two', replacement: '2' }
        ]
      },
      ctx: harness.ctx
    })
    expect(multi.ok).toBe(true)
    expect(ws.read('a.txt')).toBe('1 2 three')

    const zero = await harness.registry.run({
      tool: 'edit_document',
      args: { path: 'a.txt', edits: [{ anchor: 'missing words', replacement: 'x' }] },
      ctx: harness.ctx
    })
    expect(zero.ok).toBe(false)
    expect(zero.message).toContain('does not match')

    ws.write('dup.txt', 'again and again')
    const dupes = await harness.registry.run({
      tool: 'edit_document',
      args: { path: 'dup.txt', edits: [{ anchor: 'again', replacement: 'once' }] },
      ctx: harness.ctx
    })
    expect(dupes.ok).toBe(false)
    expect(dupes.message).toContain('more than one place')
  })

  it('routes .docx through the sidecar capability', async () => {
    const outcome = await harness.registry.run({
      tool: 'edit_document',
      args: { path: 'report.docx', edits: [{ anchor: 'brown fox', replacement: 'red fox' }] },
      ctx: {
        ...harness.ctx,
        documents: {
          extract: async () => ({ text: '', truncated: false }),
          edit: async (path, edits) => {
            expect(path.endsWith('report.docx')).toBe(true)
            expect(edits).toEqual([{ anchor: 'brown fox', replacement: 'red fox' }])
            return { beforeExcerpt: 'brown fox', afterExcerpt: 'red fox', editsApplied: 1 }
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { beforeExcerpt: string; editsApplied: number }
    expect(result.beforeExcerpt).toBe('brown fox')
    expect(result.editsApplied).toBe(1)
  })

  it('answers honestly when the sidecar is down or the format is unsupported', async () => {
    const down = await harness.registry.run({
      tool: 'edit_document',
      args: { path: 'report.docx', edits: [{ anchor: 'a', replacement: 'b' }] },
      ctx: harness.ctx
    })
    expect(down.ok).toBe(false)
    expect(down.message).toContain('intelligence service')

    ws.write('deck.pdf', '%PDF fake')
    const pdf = await harness.registry.run({
      tool: 'edit_document',
      args: { path: 'deck.pdf', edits: [{ anchor: 'a', replacement: 'b' }] },
      ctx: harness.ctx
    })
    expect(pdf.ok).toBe(false)
    expect(pdf.message).toContain('.pptx')
  })

  it('routes .pptx and .xlsx through the injected sidecar edit capability', async () => {
    for (const name of ['deck.pptx', 'prices.xlsx']) {
      ws.write(name, 'fake-bytes')
      const outcome = await harness.registry.run({
        tool: 'edit_document',
        args: { path: name, edits: [{ anchor: 'a', replacement: 'b' }] },
        ctx: {
          ...harness.ctx,
          documents: {
            extract: async () => ({ text: '', truncated: false }),
            edit: async () => ({
              beforeExcerpt: 'before-a',
              afterExcerpt: 'after-b',
              editsApplied: 1
            })
          }
        }
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok || !outcome.result) throw new Error('expected result')
      expect((outcome.result as { editsApplied: number }).editsApplied).toBe(1)
    }
  })

  it('rejects empty edit lists before any stage runs', async () => {
    const outcome = await harness.registry.run({
      tool: 'edit_document',
      args: { path: 'notes.md', edits: [] },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(harness.stages.order).toEqual([])
  })
})
