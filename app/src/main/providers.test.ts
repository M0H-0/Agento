import { describe, expect, it } from 'vitest'
import { buildLanguageModel, friendlyTestError, providerRequiresKey } from './providers'

// M6.3 custom providers: factory routing + key requirements + test-error copy.
// No network — buildLanguageModel only constructs the AI SDK client; the
// connection test itself runs in main behind the settings:test-provider IPC.

describe('provider key requirements', () => {
  it('requires keys for built-ins, allows keyless custom endpoints', () => {
    expect(providerRequiresKey('google')).toBe(true)
    expect(providerRequiresKey('groq')).toBe(true)
    expect(providerRequiresKey('ollama')).toBe(true)
    expect(providerRequiresKey('custom:abc123')).toBe(false)
  })
})

describe('buildLanguageModel routing', () => {
  it('builds google, groq, and ollama clients without a base URL', () => {
    expect(() =>
      buildLanguageModel({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k' })
    ).not.toThrow()
    expect(() =>
      buildLanguageModel({ provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: 'k' })
    ).not.toThrow()
    expect(() =>
      buildLanguageModel({ provider: 'ollama', model: 'gpt-oss:20b', apiKey: 'k' })
    ).not.toThrow()
  })

  it('builds a custom client with and without a key', () => {
    expect(() =>
      buildLanguageModel({
        provider: 'custom:abc123',
        model: 'llama3.1:8b',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'k'
      })
    ).not.toThrow()
    expect(() =>
      buildLanguageModel({
        provider: 'custom:abc123',
        model: 'llama3.1:8b',
        baseUrl: 'http://127.0.0.1:11434/v1'
      })
    ).not.toThrow()
  })

  it('refuses missing keys for built-ins, missing endpoints for customs, and unknown providers', () => {
    expect(() => buildLanguageModel({ provider: 'google', model: 'm' })).toThrow(/key/i)
    expect(() => buildLanguageModel({ provider: 'groq', model: 'm' })).toThrow(/key/i)
    expect(() => buildLanguageModel({ provider: 'ollama', model: 'm' })).toThrow(/key/i)
    expect(() => buildLanguageModel({ provider: 'custom:x', model: 'm' })).toThrow(/endpoint/i)
    expect(() => buildLanguageModel({ provider: 'openai', model: 'm', apiKey: 'k' })).toThrow(
      /unsupported/i
    )
  })
})

describe('friendlyTestError', () => {
  it('maps auth/endpoint/rate-limit/network failures to plain language', () => {
    expect(friendlyTestError(new Error('401 Unauthorized'))).toMatch(/key was rejected/i)
    expect(friendlyTestError(new Error('404 Not Found'))).toMatch(/not found/i)
    expect(friendlyTestError(new Error('429 rate limit'))).toMatch(/rate-limiting/i)
    expect(friendlyTestError(new Error('fetch failed'))).toMatch(/could not be reached/i)
    expect(friendlyTestError(new Error('The operation was aborted due to timeout'))).toMatch(
      /timed out/i
    )
  })

  it('never echoes raw codes or bodies verbatim', () => {
    const copy = friendlyTestError(new Error('weird-provider-shape xyz-123'))
    expect(copy).toMatch(/check the endpoint/i)
    expect(copy).not.toContain('xyz-123')
  })
})
