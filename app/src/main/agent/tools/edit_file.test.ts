import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editExcerpts, editFileTool } from './edit_file'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

// edit_file (M2.6): anchor-based edit — old_text must match exactly once —
// with before/after region excerpts in the result (docs/03 §5 — the card
// shows the changed region, no diff library).

describe('editExcerpts — changed region with context', () => {
  const content = ['line 1', 'line 2', 'line 3', 'TARGET', 'line 5', 'line 6', 'line 7'].join('\n')

  it('centers the region with ±3 context lines', () => {
    const { beforeExcerpt, afterExcerpt } = editExcerpts(content, 'TARGET', 'REPLACED')
    expect(beforeExcerpt).toBe(
      ['line 1', 'line 2', 'line 3', 'TARGET', 'line 5', 'line 6', 'line 7'].join('\n')
    )
    expect(afterExcerpt).toBe(
      ['line 1', 'line 2', 'line 3', 'REPLACED', 'line 5', 'line 6', 'line 7'].join('\n')
    )
  })

  it('clips context at the file edges', () => {
    const { beforeExcerpt } = editExcerpts('TARGET\nb\nc\nd', 'TARGET', 'REPLACED')
    expect(beforeExcerpt).toBe('TARGET\nb\nc\nd')
  })

  it('caps long regions at 600 chars', () => {
    const big = `START\n${'x'.repeat(700)}\nEND`
    const { beforeExcerpt } = editExcerpts(big, 'START', 'START')
    expect(beforeExcerpt.length).toBe(601)
    expect(beforeExcerpt.endsWith('…')).toBe(true)
  })
})

describe('edit_file — anchor must match exactly once', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(editFileTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('replaces the single match (risk 2: approval logged, snapshot first)', async () => {
    ws.write('note.md', 'hello\nold line\nbye')
    const outcome = await harness.registry.run({
      tool: 'edit_file',
      args: { path: 'note.md', old_text: 'old line', new_text: 'new line' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    // risk 2 blocks on the approval hook (auto-approved outside M3.2).
    // No 'risk' probe in the order log: edit_file classifies unconditionally
    // (always 2 — no disk probe), so the harness only logs approval+snapshot.
    expect(harness.stages.approvals).toHaveLength(1)
    expect(harness.stages.order).toEqual(['approval', 'snapshot'])
    // the snapshot stage captured the old content BEFORE the mutation
    expect(harness.stages.snapshots).toHaveLength(1)
    expect(harness.stages.snapshots[0].existed).toBe(true)
    expect(harness.stages.snapshots[0].content).toBe('hello\nold line\nbye')
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    expect(outcome.result).toMatchObject({
      beforeExcerpt: 'hello\nold line\nbye',
      afterExcerpt: 'hello\nnew line\nbye'
    })
    expect(ws.read('note.md')).toBe('hello\nnew line\nbye')
  })

  it('refuses when the anchor matches nothing', async () => {
    ws.write('note.md', 'hello world')
    const outcome = await harness.registry.run({
      tool: 'edit_file',
      args: { path: 'note.md', old_text: 'missing', new_text: 'x' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/does not match/i)
    expect(ws.read('note.md')).toBe('hello world')
  })

  it('refuses when the anchor matches more than once', async () => {
    ws.write('note.md', 'dup\nmiddle\ndup')
    const outcome = await harness.registry.run({
      tool: 'edit_file',
      args: { path: 'note.md', old_text: 'dup', new_text: 'x' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/more than one/i)
    expect(ws.read('note.md')).toBe('dup\nmiddle\ndup')
  })

  it('refuses honestly when the file does not exist', async () => {
    const outcome = await harness.registry.run({
      tool: 'edit_file',
      args: { path: 'gone.md', old_text: 'a', new_text: 'b' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/couldn't find/i)
  })

  it('schema-rejects an empty anchor', async () => {
    const outcome = await harness.registry.run({
      tool: 'edit_file',
      args: { path: 'note.md', old_text: '', new_text: 'x' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
    expect(harness.stages.order).toEqual([]) // refused before any stage
  })
})
