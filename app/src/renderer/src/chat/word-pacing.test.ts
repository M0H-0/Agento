import { describe, expect, it } from 'vitest'
import {
  WORDS_PER_TICK,
  WORD_TICK_MS,
  countFences,
  isInsideFence,
  nextDisplayed,
  tokenizeWords
} from './word-pacing'

describe('word-pacing', () => {
  it('keeps the medium-pace budget constants', () => {
    expect(WORDS_PER_TICK).toBe(2)
    expect(WORD_TICK_MS).toBe(40)
  })

  it('tokenizes words while preserving every character', () => {
    const tokens = tokenizeWords('hello  world\nnew')
    expect(tokens.join('')).toBe('hello  world\nnew')
    expect(tokens.filter((t) => /\S/.test(t))).toEqual(['hello  ', 'world\n', 'new'])
  })

  it('reveals prose word by word within budget', () => {
    expect(nextDisplayed('', 'one two three four', 2)).toBe('one two ')
    expect(nextDisplayed('one two ', 'one two three four', 2)).toBe('one two three four')
  })

  it('is a no-op when already caught up, and collapses empty targets', () => {
    expect(nextDisplayed('done', 'done')).toBe('done')
    expect(nextDisplayed('done', '')).toBe('')
  })

  it('jumps on non-prefix transitions (id change / edited history)', () => {
    expect(nextDisplayed('hello world', 'brand new text', 1)).toBe('brand new text')
  })

  it('counts fences and reports inside/outside', () => {
    expect(countFences('no code')).toBe(0)
    expect(countFences('a ```js\nx\n``` b')).toBe(2)
    expect(isInsideFence('a ```js\nx')).toBe(true)
    expect(isInsideFence('a ```js\nx\n``` done')).toBe(false)
  })

  it('extends a mid-fence slice to the closing fence (instant code)', () => {
    const target = 'intro line here\n```js\nconst a = 1\n```\ntrailing words here'
    const first = nextDisplayed('', target, 2)
    // "intro line " is 2 words; the slice must not stop mid-fence, but the
    // intro is outside the fence so it stays short.
    expect(first).toBe('intro line ')
    const intoFence = nextDisplayed(first, target, 2)
    // Advancing 2 more words ("here", "```js") would land inside the fence,
    // so the whole fenced block pops atomically.
    expect(intoFence).toBe('intro line here\n```js\nconst a = 1\n```')
  })

  it('flushes to full target while a fence is still unclosed', () => {
    const target = 'intro words here\n```js\nconst a = '
    const first = nextDisplayed('', target, 2)
    expect(first).toBe('intro words ')
    // Next word ("here") is still outside the fence, so it reveals normally…
    expect(nextDisplayed(first, target, 1)).toBe('intro words here\n')
    // …and stepping into the unclosed fence flushes the rest atomically.
    expect(nextDisplayed('intro words here\n', target, 1)).toBe(target)
  })

  it('zero budget holds the current frame', () => {
    expect(nextDisplayed('one ', 'one two three', 0)).toBe('one ')
  })
})
