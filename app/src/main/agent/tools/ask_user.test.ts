import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askUserTool } from './ask_user'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

// ask_user (docs/03 §5): risk 0, blocks the loop on the user's reply. The
// harness `requestUserAnswer` is scriptable via `stages.setPendingAnswer(...)`.

describe('ask_user — blocks on the user reply', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(askUserTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('returns the user answer and records the question/options', async () => {
    harness.stages.setPendingAnswer('blue')
    const outcome = await harness.registry.run({
      tool: 'ask_user',
      args: { question: 'What color?', options: ['red', 'blue', 'green'] },
      ctx: { ...harness.ctx, activeToolCallId: 'call-1' }
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    expect(outcome.result).toEqual({ question: 'What color?', answer: 'blue' })
    expect(harness.stages.askUserRequests).toEqual([
      { toolCallId: 'call-1', question: 'What color?', options: ['red', 'blue', 'green'] }
    ])
  })

  it('refuses when the loop forgot to set an activeToolCallId', async () => {
    const outcome = await harness.registry.run({
      tool: 'ask_user',
      args: { question: 'What color?' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/toolCallId/i)
    // The tool itself returned { ok: false, error } rather than throwing — the
    // wrapper turns that into an executed-but-failed outcome, not a refused.
    expect(outcome.status).toBe('executed')
    // No ask_user request fired — the tool refused before asking the user.
    expect(harness.stages.askUserRequests).toEqual([])
  })

  it('accepts an explicit options: null (live-observed model shape)', async () => {
    // Groq's openai/gpt-oss-120b sent {"question":"...","options":null} for
    // an open-ended question; a strict .optional() rejected it provider-side
    // with a tool-validation 400. The schema must accept the nullish form
    // and treat it as "no options".
    harness.stages.setPendingAnswer('red')
    const outcome = await harness.registry.run({
      tool: 'ask_user',
      args: { question: 'What is your favorite color?', options: null },
      ctx: { ...harness.ctx, activeToolCallId: 'call-3' }
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('executed')
    expect(harness.stages.askUserRequests).toEqual([
      { toolCallId: 'call-3', question: 'What is your favorite color?', options: undefined }
    ])
  })

  it('schema-rejects an empty question', async () => {
    const outcome = await harness.registry.run({
      tool: 'ask_user',
      args: { question: '' },
      ctx: { ...harness.ctx, activeToolCallId: 'call-2' }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('schema validation')
  })

  it('describes with a one-line question preview (long questions truncated)', () => {
    const desc = askUserTool.describe({ question: 'A'.repeat(200), options: undefined })
    expect(desc.group).toBe('chat')
    expect(desc.title.startsWith('Ask: ')).toBe(true)
    // 80 char cap + ellipsis
    expect(desc.title.length).toBeLessThanOrEqual('Ask: '.length + 81)
  })
})
