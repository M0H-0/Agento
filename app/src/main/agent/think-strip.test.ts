import { describe, expect, it } from 'vitest'
import { createThinkStripper, stripThinkTags, thinkTailParts } from './think-strip'

// The demo-breaker: thinking models on OpenAI-compatible providers emit raw
// `<think>…</think>` deliberation inside text deltas. None of it may reach
// the thread — English deliberation naming internal tools (emit_plan) in the
// user's bubble violates the product's no-leak rule.
describe('stripThinkTags — complete strings', () => {
  it('strips one block and keeps surrounding text', () => {
    expect(stripThinkTags('Hello <think>secret plan</think>world')).toBe('Hello world')
  })

  it('strips case-insensitively, the thinking variant, and attributes', () => {
    expect(stripThinkTags('a<THINK>x</THINK>b')).toBe('ab')
    expect(stripThinkTags('a<thinking>x</thinking>b')).toBe('ab')
    expect(stripThinkTags('a<think >x</think >b')).toBe('ab')
  })

  it('strips an unclosed leading block but keeps trailing visible text', () => {
    expect(stripThinkTags('<think>deliberation about emit_plan here</think>Done.')).toBe('Done.')
    expect(stripThinkTags('<think>never closed, then visible')).toBe('')
  })

  it('drops a stray close tag instead of rendering it', () => {
    expect(stripThinkTags('Done.</think>')).toBe('Done.')
  })

  it('preserves normal angle-bracket text', () => {
    expect(stripThinkTags('a < b')).toBe('a < b')
    expect(stripThinkTags('I <3 this')).toBe('I <3 this')
    expect(stripThinkTags('use <b>bold</b>')).toBe('use <b>bold</b>')
  })

  it('treats an unterminated tag-like tail as content, not a tag', () => {
    expect(stripThinkTags('x <think')).toBe('x <think')
  })

  it('strips several blocks in one string', () => {
    expect(stripThinkTags('<think>a</think>one<think>b</think>two')).toBe('onetwo')
  })

  it('returns empty for think-only input', () => {
    expect(stripThinkTags('<think>hmm</think>')).toBe('')
  })
})

describe('createThinkStripper — split deltas', () => {
  it('handles tags split across deltas', () => {
    const s = createThinkStripper()
    expect(s.push('Hello <th')).toBe('Hello ')
    expect(s.push('ink>secret</')).toBe('')
    expect(s.push('think>world')).toBe('world')
    expect(s.flush()).toBe('')
  })

  it('handles a close tag split across deltas', () => {
    const s = createThinkStripper()
    expect(s.push('<think>secret</thi')).toBe('')
    expect(s.push('nk>visible')).toBe('visible')
  })

  it('holds a bare trailing angle bracket until resolved', () => {
    const s = createThinkStripper()
    expect(s.push('a <')).toBe('a ')
    // '<' alone could still open a tag, so it stays held…
    expect(s.push('th')).toBe('')
    // …until text proves it normal — normal prose is never held back.
    expect(s.push('en ')).toBe('<then ')
    expect(s.flush()).toBe('')
  })

  it('never holds normal angle-bracket prose across deltas', () => {
    const s = createThinkStripper()
    expect(s.push('a <')).toBe('a ')
    expect(s.push(' b and c')).toBe('< b and c')
    expect(s.flush()).toBe('')
  })

  it('flush releases a stream-end fragment as normal text', () => {
    const s = createThinkStripper()
    expect(s.push('ends with <')).toBe('ends with ')
    expect(s.flush()).toBe('<')
  })

  it('flush discards unclosed thinking', () => {
    const s = createThinkStripper()
    expect(s.push('<think>forever')).toBe('')
    expect(s.flush()).toBe('')
  })

  it('keeps instances independent', () => {
    const a = createThinkStripper()
    const b = createThinkStripper()
    expect(a.push('<think>x')).toBe('')
    expect(b.push('plain')).toBe('plain')
  })
})

describe('thinkTailParts', () => {
  it('returns null for an empty tail', () => {
    expect(thinkTailParts('t1', '')).toBeNull()
  })

  it('returns a start/delta/end triple otherwise', () => {
    expect(thinkTailParts('t1', '<')).toEqual([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '<' },
      { type: 'text-end', id: 't1' }
    ])
  })
})
