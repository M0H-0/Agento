import { describe, expect, it } from 'vitest'
import { codeHeaderText } from './code-label'

describe('codeHeaderText', () => {
  it('names known languages in plain words', () => {
    expect(codeHeaderText('js', 'code')).toBe('code — JavaScript')
    expect(codeHeaderText('python', 'code')).toBe('code — Python')
  })

  it('capitalizes unlisted language tags', () => {
    expect(codeHeaderText('foobar', 'code')).toBe('code — Foobar')
  })

  it('falls back to a bare "code" for languageless tags', () => {
    // Live repro: the model wrote ```Unknown and the header parroted
    // "code — Unknown".
    for (const tag of ['Unknown', 'UNKNOWN', 'text', 'txt', 'plain', 'plaintext']) {
      expect(codeHeaderText(tag, 'code')).toBe('code')
    }
    expect(codeHeaderText(undefined, 'code')).toBe('code')
    expect(codeHeaderText('', 'code')).toBe('code')
  })
})
