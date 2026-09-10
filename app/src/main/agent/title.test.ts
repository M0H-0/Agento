import { describe, expect, it, vi } from 'vitest'
import {
  TITLE_MAX_INPUT_CHARS,
  TITLE_MAX_LENGTH,
  buildTitlePrompt,
  generateSessionTitle,
  sanitizeTitle
} from './title'

describe('buildTitlePrompt', () => {
  it('includes the message and the same-language instruction', () => {
    const prompt = buildTitlePrompt('please fix the login bug in auth.ts')
    expect(prompt).toContain('please fix the login bug in auth.ts')
    expect(prompt).toContain('SAME language')
    expect(prompt).toContain('2 to 6 words')
  })

  it('clips very long messages to the input budget', () => {
    const long = 'a'.repeat(TITLE_MAX_INPUT_CHARS + 500)
    const prompt = buildTitlePrompt(long)
    expect(prompt).toContain('a'.repeat(TITLE_MAX_INPUT_CHARS))
    expect(prompt).not.toContain('a'.repeat(TITLE_MAX_INPUT_CHARS + 1))
  })
})

describe('sanitizeTitle', () => {
  it('strips wrapping quotes and whitespace noise', () => {
    expect(sanitizeTitle('  "Login bug fix"  ', 'fallback')).toBe('Login bug fix')
    expect(sanitizeTitle('«تحية ترحيب»', 'fallback')).toBe('تحية ترحيب')
  })

  it('strips a "Title:" label and a single trailing punctuation mark', () => {
    expect(sanitizeTitle('Title: Greeting', 'fallback')).toBe('Greeting')
    expect(sanitizeTitle('Greeting.', 'fallback')).toBe('Greeting')
    expect(sanitizeTitle('你好！', 'fallback')).toBe('你好')
  })

  it('collapses newlines into one line', () => {
    expect(sanitizeTitle('File\nedit\nrequest', 'fallback')).toBe('File edit request')
  })

  it('caps the length with an ellipsis', () => {
    const long = 'x'.repeat(TITLE_MAX_LENGTH + 10)
    const result = sanitizeTitle(long, 'fallback')
    expect(result).toHaveLength(TITLE_MAX_LENGTH + 1) // cap + ellipsis
    expect(result.endsWith('…')).toBe(true)
  })

  it('falls back when the model answers nothing usable', () => {
    expect(sanitizeTitle('', 'fallback')).toBe('fallback')
    expect(sanitizeTitle('   ', 'fallback')).toBe('fallback')
    expect(sanitizeTitle('""', 'fallback')).toBe('fallback')
    expect(sanitizeTitle('Title:', 'fallback')).toBe('fallback')
  })

  it('keeps titles that merely contain punctuation inside', () => {
    expect(sanitizeTitle('report.docx edit', 'fallback')).toBe('report.docx edit')
  })
})

describe('generateSessionTitle', () => {
  it('prompts the completer and returns the sanitized title', async () => {
    const complete = vi.fn().mockResolvedValue('"Login bug in auth"')
    const title = await generateSessionTitle({
      complete,
      firstMessage: 'fix the login bug',
      fallback: 'fix the login bug'
    })
    expect(complete).toHaveBeenCalledWith(buildTitlePrompt('fix the login bug'))
    expect(title).toBe('Login bug in auth')
  })

  it('propagates completer failures to the caller', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('model call failed'))
    await expect(
      generateSessionTitle({ complete, firstMessage: 'hi', fallback: 'hi' })
    ).rejects.toThrow('model call failed')
  })

  it('returns the fallback when the completion is empty', async () => {
    const complete = vi.fn().mockResolvedValue('  ')
    const title = await generateSessionTitle({
      complete,
      firstMessage: 'مرحبا',
      fallback: 'مرحبا'
    })
    expect(title).toBe('مرحبا')
  })
})
