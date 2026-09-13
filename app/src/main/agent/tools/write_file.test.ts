import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { excerptOf, writeFileTool } from './write_file'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

// write_file (M2.5): whole-file replacement with before/after excerpts in
// the result (docs/03 §5 — the card shows the changed region, no diff
// library). The M2.1 wrapper-stage behavior (risk = exists ? 2 : 1,
// snapshot-before-execute) is covered by registry.test.ts; this suite pins
// the M2.5 excerpt contract.

describe('excerptOf — head-capped preview', () => {
  it('returns short content unchanged', () => {
    expect(excerptOf('one\ntwo')).toBe('one\ntwo')
  })

  it('caps at 8 lines with an ellipsis line', () => {
    const content = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    const out = excerptOf(content)
    expect(out).toContain('line 8')
    expect(out).not.toContain('line 9')
    expect(out.endsWith('\n…')).toBe(true)
  })

  it('caps at 600 chars with an ellipsis char', () => {
    const content = 'x'.repeat(700)
    const out = excerptOf(content)
    expect(out.length).toBe(601)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('write_file — before/after excerpts in the result', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(writeFileTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('new file: beforeExcerpt null, afterExcerpt is the content head', async () => {
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'new.md', content: '# Hello\n\nworld' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    expect(outcome.result).toMatchObject({
      beforeExcerpt: null,
      afterExcerpt: '# Hello\n\nworld'
    })
    expect(ws.read('new.md')).toBe('# Hello\n\nworld')
  })

  it('overwrite: beforeExcerpt captures the OLD content', async () => {
    ws.write('existing.md', 'old line 1\nold line 2')
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'existing.md', content: 'new content' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    expect(outcome.result).toMatchObject({
      beforeExcerpt: 'old line 1\nold line 2',
      afterExcerpt: 'new content'
    })
    // the snapshot stage captured the old content BEFORE the mutation
    expect(harness.stages.snapshots).toHaveLength(1)
    expect(harness.stages.snapshots[0].existed).toBe(true)
    expect(harness.stages.snapshots[0].content).toBe('old line 1\nold line 2')
    expect(ws.read('existing.md')).toBe('new content')
  })

  it('refuses binary document formats instead of writing corrupt bytes', async () => {
    for (const name of ['story.docx', 'deck.pptx', 'prices.xlsx', 'out.pdf']) {
      const outcome = await harness.registry.run({
        tool: 'write_file',
        args: { path: name, content: 'plain text is not a document' },
        ctx: harness.ctx
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error(`expected refusal for ${name}`)
      expect(outcome.message).toMatch(/create_document|convert_document/)
    }
  })
})
