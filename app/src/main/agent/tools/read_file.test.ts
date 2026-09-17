import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileTool } from './read_file'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

describe('read_file — read-only', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(readFileTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('returns the file content with total lines and a non-truncated marker', async () => {
    ws.write('hello.md', 'line one\nline two\nline three\n')
    const outcome = await harness.registry.run({
      tool: 'read_file',
      args: { path: 'hello.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      content: string
      startLine: number
      endLine: number
      totalLines: number
      truncated: boolean
    }
    expect(result.content).toContain('BEGIN UNTRUSTED CONTENT')
    expect(result.content).toContain('line one\nline two\nline three')
    expect(result.content).toContain('END UNTRUSTED CONTENT')
    expect(result.startLine).toBe(0)
    expect(result.endLine).toBe(3)
    expect(result.totalLines).toBe(3)
    expect(result.truncated).toBe(false)
  })

  it('honors startLine + maxLines for a targeted read', async () => {
    ws.write('big.md', Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'))
    const outcome = await harness.registry.run({
      tool: 'read_file',
      args: { path: 'big.md', startLine: 10, maxLines: 3 },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      content: string
      startLine: number
      endLine: number
      truncated: boolean
    }
    expect(result.startLine).toBe(10)
    expect(result.endLine).toBe(13)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain('line 11\nline 12\nline 13')
  })

  it('refuses a workspace escape', async () => {
    const outcome = await harness.registry.run({
      tool: 'read_file',
      args: { path: '../secret.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('sandbox')
  })

  it('schema-rejects a negative maxLines', async () => {
    const outcome = await harness.registry.run({
      tool: 'read_file',
      args: { path: 'x.md', maxLines: -1 },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
  })

  it('returns a plain-language refusal for a missing file', async () => {
    const outcome = await harness.registry.run({
      tool: 'read_file',
      args: { path: 'nonexistent.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain(
      "I couldn't find that file — it may have been moved or renamed."
    )
  })
})
