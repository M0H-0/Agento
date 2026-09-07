import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { searchFilesTool } from './search_files'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

describe('search_files — read-only', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(searchFilesTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('finds case-insensitive matches across nested files', async () => {
    mkdirSync(join(ws.root, 'docs'))
    ws.write('top.md', 'Invoice 1\nnotes here')
    ws.write('docs/inner.md', 'INVOICE 2\nmore')
    ws.write('docs/skip.txt', 'invoice 3 — different ext')
    const outcome = await harness.registry.run({
      tool: 'search_files',
      args: { path: '.', query: 'invoice' },
      ctx: harness.ctx
    })
    if (!outcome.ok) {
      throw new Error(`expected ok=true, got ${JSON.stringify(outcome)}`)
    }
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      query: string
      matches: { path: string; line: number; preview: string }[]
      truncated: boolean
    }
    expect(result.query).toBe('invoice')
    // 2 matches: one in top.md, one in docs/inner.md. docs/skip.txt is included
    // because the test asks for every file (no glob).
    expect(result.matches.length).toBeGreaterThanOrEqual(2)
    const paths = result.matches.map((match) => match.path.replace(/\\/g, '/'))
    expect(paths).toContain('top.md')
    expect(paths.some((path) => path.endsWith('inner.md'))).toBe(true)
    expect(result.matches[0].line).toBe(1)
  })

  it('respects a glob filter', async () => {
    ws.write('a.md', 'banana')
    ws.write('a.txt', 'banana')
    const outcome = await harness.registry.run({
      tool: 'search_files',
      args: { path: '.', query: 'banana', glob: '*.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { matches: { path: string }[] }
    expect(result.matches.length).toBe(1)
    expect(result.matches[0].path.replace(/\\/g, '/')).toBe('a.md')
  })

  it('returns an empty match list when nothing matches', async () => {
    ws.write('a.md', 'unrelated')
    const outcome = await harness.registry.run({
      tool: 'search_files',
      args: { path: '.', query: 'banana' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { matches: unknown[]; truncated: boolean }
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('schema-rejects an empty query', async () => {
    const outcome = await harness.registry.run({
      tool: 'search_files',
      args: { query: '' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
  })
})
