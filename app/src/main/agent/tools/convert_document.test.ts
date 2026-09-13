import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { convertDocumentTool, destForConvert } from './convert_document'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

describe('convert_document — format conversion without online services', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(convertDocumentTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('destForConvert swaps the extension in place', () => {
    expect(destForConvert('/w/story.txt', 'docx')).toBe('/w/story.docx')
    expect(destForConvert('/w/story.md', 'pdf')).toBe('/w/story.pdf')
  })

  it('converts txt to docx through the sidecar create capability', async () => {
    ws.write('story.txt', 'The Midnight Adventure\n\nWhiskers loved midnight.')
    let seen: { path: string; title: string; items: string[] } | null = null
    const outcome = await harness.registry.run({
      tool: 'convert_document',
      args: { path: 'story.txt', target: 'docx' },
      ctx: {
        ...harness.ctx,
        documents: {
          extract: async () => ({ text: '', truncated: false }),
          create: async (path, title, items) => {
            seen = { path, title, items }
            return { afterExcerpt: `${title}\n${items.join('\n')}`, sizeBytes: 4096 }
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { path: string; size: number }
    expect(result.path).toContain('story.docx')
    expect(result.size).toBe(4096)
    expect(seen).not.toBeNull()
    expect((seen as unknown as { title: string }).title).toBe('The Midnight Adventure')
    // the title line is not duplicated into the body items
    expect((seen as unknown as { items: string[] }).items.join('\n')).not.toContain(
      'The Midnight Adventure'
    )
    // the dest was snapshotted (fresh path), the read-only source was not
    expect(harness.stages.snapshots.map((s) => s.path)).toEqual([result.path])
  })

  it('converts md to pdf through the injected pdf capability with wrapped html', async () => {
    ws.write('notes.md', '# Q2 report\n\nRevenue grew 12%.')
    let seen: { outPath: string; html: string } | null = null
    const outcome = await harness.registry.run({
      tool: 'convert_document',
      args: { path: 'notes.md', target: 'pdf' },
      ctx: {
        ...harness.ctx,
        pdf: {
          exportHtml: async (outPath, html) => {
            seen = { outPath, html }
            return { sizeBytes: 8192 }
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { path: string; size: number }
    expect(result.path).toContain('notes.pdf')
    expect(result.size).toBe(8192)
    expect(seen).not.toBeNull()
    const html = (seen as unknown as { html: string }).html
    expect(html).toContain('white-space:pre-wrap')
    expect(html).toContain('Revenue grew 12%.')
  })

  it('converts docx to md through the sidecar extract capability', async () => {
    ws.write('report.docx', 'fake-bytes-never-read-directly')
    const outcome = await harness.registry.run({
      tool: 'convert_document',
      args: { path: 'report.docx', target: 'md' },
      ctx: {
        ...harness.ctx,
        documents: {
          extract: async (path) => {
            expect(path).toContain('report.docx')
            return { text: '# Report\n\nBody text.', truncated: false }
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    expect(ws.read('report.md')).toBe('# Report\n\nBody text.')
  })

  it('is risk 1 for a fresh dest and risk 2 when overwriting', async () => {
    ws.write('story.txt', 'hello')
    const fresh = convertDocumentTool.risk(
      { path: join(ws.root, 'story.txt'), target: 'docx' },
      harness.ctx
    )
    expect(fresh).toEqual({ level: 1, reason: 'Creates a new converted file' })
    ws.write('story.docx', 'old-bytes')
    const overwrite = convertDocumentTool.risk(
      { path: join(ws.root, 'story.txt'), target: 'docx' },
      harness.ctx
    )
    expect(overwrite).toEqual({ level: 2, reason: 'Overwrites an existing converted file' })
  })

  it('refuses same-format, missing source, and down capabilities honestly', async () => {
    const same = await harness.registry.run({
      tool: 'convert_document',
      args: { path: 'story.txt', target: 'txt' },
      ctx: harness.ctx
    })
    expect(same.ok).toBe(false)

    ws.write('story.txt', 'hello')
    const downDocx = await harness.registry.run({
      tool: 'convert_document',
      args: { path: 'story.txt', target: 'docx' },
      ctx: harness.ctx
    })
    expect(downDocx.ok).toBe(false)
    if (!downDocx.ok) expect(downDocx.message).toContain('intelligence service')

    const downPdf = await harness.registry.run({
      tool: 'convert_document',
      args: { path: 'story.txt', target: 'pdf' },
      ctx: harness.ctx
    })
    expect(downPdf.ok).toBe(false)

    const missing = await harness.registry.run({
      tool: 'convert_document',
      args: { path: 'gone.txt', target: 'pdf' },
      ctx: { ...harness.ctx, pdf: { exportHtml: async () => ({ sizeBytes: 1 }) } }
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.message).toContain("couldn't find")
  })
})
