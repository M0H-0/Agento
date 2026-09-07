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
})
