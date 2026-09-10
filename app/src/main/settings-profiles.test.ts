import { describe, expect, it } from 'vitest'
import {
  isCustomProviderId,
  migratePrefs,
  normalizeAppearance,
  normalizeBaseUrl,
  normalizePermissionDefaults,
  validateCustomModel,
  validateProviderName
} from './settings-profiles'

// M6.3 settings completion: pure validation/migration for custom providers,
// appearance, and permission defaults. Electron-free by contract — settings.ts
// (safeStorage) stays out of vitest.

function resolveModel(provider: string, model: unknown): string {
  if (provider === 'google')
    return typeof model === 'string' && model.startsWith('gemini-') ? model : 'gemini-2.5-flash'
  if (provider === 'groq') return 'llama-3.3-70b-versatile'
  if (provider.startsWith('custom:'))
    return typeof model === 'string' && model.trim() !== '' ? model : 'model'
  return 'gemini-2.5-flash'
}

describe('custom provider ids', () => {
  it('accepts opaque custom ids, rejects display names and URLs', () => {
    expect(isCustomProviderId('custom:abc123')).toBe(true)
    expect(isCustomProviderId('custom:550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isCustomProviderId('google')).toBe(false)
    expect(isCustomProviderId('Work gateway')).toBe(false)
    expect(isCustomProviderId('https://example.com')).toBe(false)
    expect(isCustomProviderId('custom:')).toBe(false)
  })
})

describe('base URL normalization', () => {
  it('accepts https endpoints and strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('  https://api.example.com/v1  ')).toBe('https://api.example.com/v1')
  })

  it('allows http only for loopback (Ollama/LM Studio)', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
    expect(normalizeBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1')
    expect(normalizeBaseUrl('http://[::1]:11434/v1')).toBe('http://[::1]:11434/v1')
  })

  it('rejects non-loopback http with plain language', () => {
    expect(() => normalizeBaseUrl('http://api.example.com/v1')).toThrow(/local servers/)
  })

  it('rejects credentials, query, fragment, and non-http schemes', () => {
    expect(() => normalizeBaseUrl('https://user:pass@example.com/v1')).toThrow(/credentials/i)
    expect(() => normalizeBaseUrl('https://example.com/v1?key=x')).toThrow(/query/i)
    expect(() => normalizeBaseUrl('https://example.com/v1#frag')).toThrow(/fragment/i)
    expect(() => normalizeBaseUrl('ftp://example.com/v1')).toThrow(/https/)
    expect(() => normalizeBaseUrl('not a url')).toThrow(/not valid/)
  })

  it('never appends /v1 — the documented endpoint is used verbatim', () => {
    expect(normalizeBaseUrl('https://example.com/custom-path')).toBe(
      'https://example.com/custom-path'
    )
  })
})

describe('name and model validation', () => {
  it('requires a short non-empty display name', () => {
    expect(validateProviderName('  Work gateway  ')).toBe('Work gateway')
    expect(() => validateProviderName('   ')).toThrow(/name/i)
    expect(() => validateProviderName('x'.repeat(81))).toThrow(/80/)
  })

  it('requires a free-form model id under the length cap', () => {
    expect(validateCustomModel('llama3.1:8b')).toBe('llama3.1:8b')
    expect(() => validateCustomModel('  ')).toThrow(/model name/i)
    expect(() => validateCustomModel('x'.repeat(201))).toThrow(/200/)
  })
})

describe('appearance and permission defaults', () => {
  it('accepts dark/light/system, falls back to dark', () => {
    expect(normalizeAppearance('light')).toBe('light')
    expect(normalizeAppearance('system')).toBe('system')
    expect(normalizeAppearance('neon')).toBe('dark')
    expect(normalizeAppearance(undefined)).toBe('dark')
  })

  it('defaults to risk1 auto + risk2 ask and never stores risk 3', () => {
    expect(normalizePermissionDefaults(undefined)).toEqual({ risk1: 'auto', risk2: 'ask' })
    expect(normalizePermissionDefaults({ risk1: 'ask', risk2: 'auto' })).toEqual({
      risk1: 'ask',
      risk2: 'auto'
    })
    expect(normalizePermissionDefaults({ risk1: 'always', risk2: 'never' })).toEqual({
      risk1: 'auto',
      risk2: 'ask'
    })
    const normalized = normalizePermissionDefaults({ risk1: 'ask', risk2: 'ask' })
    expect('risk3' in (normalized as unknown as Record<string, unknown>)).toBe(false)
  })
})

describe('v1 → v2 migration', () => {
  it('migrates a v1 file losslessly with safe defaults for the new fields', () => {
    const migrated = migratePrefs(
      { version: 1, provider: 'groq', model: 'llama-3.3-70b-versatile' },
      resolveModel
    )
    expect(migrated.version).toBe(2)
    expect(migrated.provider).toBe('groq')
    expect(migrated.model).toBe('llama-3.3-70b-versatile')
    expect(migrated.appearance).toBe('dark')
    expect(migrated.permissionDefaults).toEqual({ risk1: 'auto', risk2: 'ask' })
    expect(migrated.customProviders).toEqual([])
  })

  it('falls back to safe defaults on absent/corrupt/foreign files', () => {
    for (const bad of [null, undefined, 42, 'x', {}, { version: 99 }]) {
      const migrated = migratePrefs(bad, resolveModel)
      expect(migrated.provider).toBe('google')
      expect(migrated.model).toBe('gemini-2.5-flash')
      expect(migrated.customProviders).toEqual([])
    }
  })

  it('resets unknown providers but keeps valid custom profiles', () => {
    const migrated = migratePrefs(
      {
        version: 2,
        provider: 'custom:abc123',
        model: 'llama3.1:8b',
        appearance: 'system',
        permissionDefaults: { risk1: 'ask', risk2: 'ask' },
        customProviders: [
          {
            id: 'custom:abc123',
            name: 'Local',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'llama3.1:8b',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          },
          // Invalid rows are skipped, never fatal.
          { id: 'bogus', name: '', baseUrl: 'nope', model: '' }
        ]
      },
      resolveModel
    )
    expect(migrated.provider).toBe('custom:abc123')
    expect(migrated.appearance).toBe('system')
    expect(migrated.customProviders).toHaveLength(1)
    expect(migrated.customProviders[0].baseUrl).toBe('http://127.0.0.1:11434/v1')
  })

  it('drops the active provider to google when its custom profile is gone', () => {
    const migrated = migratePrefs(
      { version: 2, provider: 'custom:missing', model: 'x', customProviders: [] },
      resolveModel
    )
    expect(migrated.provider).toBe('google')
  })
})
