import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDocumentTool } from './read_document'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

describe('read_document — read-only', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(readDocumentTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('reads a text file directly through the workspace facade (no sidecar needed)', async () => {
    ws.write('notes.md', '# Notes\n\nBody text.')
    const outcome = await harness.registry.run({
      tool: 'read_document',
      args: { path: 'notes.md' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { text: string; truncated: boolean }
    expect(result.text).toContain('BEGIN UNTRUSTED CONTENT')
    expect(result.text).toContain('# Notes\n\nBody text.')
    expect(result.truncated).toBe(false)
  })

  it('caps very long text with an honest truncated marker (below the wrapper 8 KB cap)', async () => {
    ws.write('big.txt', 'x'.repeat(9_000))
    const outcome = await harness.registry.run({
      tool: 'read_document',
      args: { path: 'big.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { text: string; truncated: boolean }
    expect(result.text).toContain('BEGIN UNTRUSTED CONTENT')
    expect(result.text.length).toBeGreaterThan(6_000)
    expect(result.truncated).toBe(true)
  })

  it('extracts a binary document through the injected sidecar capability', async () => {
    ws.write('report.pdf', '%PDF-not-really')
    const outcome = await harness.registry.run({
      tool: 'read_document',
      args: { path: 'report.pdf' },
      ctx: {
        ...harness.ctx,
        documents: {
          extract: async () => ({ text: 'PDF BODY TEXT', truncated: false })
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { text: string; truncated: boolean }
    expect(result.text).toContain('PDF BODY TEXT')
  })

  it('answers honestly for binary documents when no sidecar capability is injected', async () => {
    ws.write('report.pdf', '%PDF-not-really')
    const outcome = await harness.registry.run({
      tool: 'read_document',
      args: { path: 'report.pdf' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('intelligence service')
  })

  it('passes the sidecar error detail through as a plain-language refusal', async () => {
    ws.write('broken.docx', 'not a real docx')
    const outcome = await harness.registry.run({
      tool: 'read_document',
      args: { path: 'broken.docx' },
      ctx: {
        ...harness.ctx,
        documents: {
          extract: async () => {
            throw new Error('"broken.docx" could not be read as a Word document.')
          }
        }
      }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('could not be read')
  })

  it('refuses a workspace escape', async () => {
    const outcome = await harness.registry.run({
      tool: 'read_document',
      args: { path: '../secret.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('sandbox')
  })

  it('surfaces a missing text file with a plain-language error', async () => {
    const outcome = await harness.registry.run({
      tool: 'read_document',
      args: { path: 'gone.txt' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('gone.txt')
  })
})
