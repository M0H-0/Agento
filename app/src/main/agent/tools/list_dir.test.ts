import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { listDirTool } from './list_dir'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

// M2.4 — read-only `list_dir` runs through the wrapper, never the disk
// directly. The wrapper stage log proves it.

describe('list_dir — read-only', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(listDirTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('returns file and directory entries with a type tag', async () => {
    ws.write('a.md', 'a')
    ws.write('b.txt', 'b')
    mkdirSync(join(ws.root, 'docs'))
    const outcome = await harness.registry.run({
      tool: 'list_dir',
      args: { path: '.' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { path: string; entries: { name: string; type: string }[] }
    expect(result.path.replace(/\\/g, '/')).toContain(ws.root.replace(/\\/g, '/'))
    const sorted = [...result.entries].sort((a, b) => a.name.localeCompare(b.name))
    expect(sorted.map((entry) => entry.name)).toEqual(['a.md', 'b.txt', 'docs'])
    expect(sorted.find((entry) => entry.name === 'docs')?.type).toBe('directory')
    expect(sorted.find((entry) => entry.name === 'a.md')?.type).toBe('file')
  })

  it('refuses paths that escape the workspace', async () => {
    const outcome = await harness.registry.run({
      tool: 'list_dir',
      args: { path: '../escape' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('refused')
    expect(outcome.error).toBe('sandbox')
  })

  it('schema rejection short-circuits before any disk access', async () => {
    const outcome = await harness.registry.run({
      tool: 'list_dir',
      args: { path: '' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('refused')
    expect(harness.stages.order).toEqual([])
  })

  it('describes with the folder name only, never the absolute path', () => {
    // The wrapper hands describe the PRE-RESOLVED (absolute) path — the card
    // title must reduce it to the folder name (docs/04 §3.1; M2.8 review fix).
    expect(listDirTool.describe({ path: 'D:\\workspace\\docs' }).title).toBe('List docs')
    expect(listDirTool.describe({ path: '/workspace' }).title).toBe('List workspace')
  })

  it('a missing folder fails honestly — never an empty listing (Phase-1 item 2)', async () => {
    // Live: T2 probed archive/ before it existed and the card claimed
    // "0 entries / This folder is empty." The failure must ride the error
    // shape with a complete sentence, and the sentence must not carry the
    // absolute workspace path (AGENTS rule 6).
    const outcome = await harness.registry.run({
      tool: 'list_dir',
      args: { path: 'archive' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('executed')
    expect(outcome.message).toContain("couldn't find")
    expect(outcome.message).toContain('archive')
    expect(outcome.message.toLowerCase()).not.toContain('empty')
    expect(outcome.message).not.toContain(ws.root)
  })

  it('a file path fails as not-a-folder instead of listing nothing', async () => {
    ws.write('notes.txt', 'hello')
    const outcome = await harness.registry.run({
      tool: 'list_dir',
      args: { path: 'notes.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('not a folder')
    expect(outcome.message).not.toContain(ws.root)
  })
})
