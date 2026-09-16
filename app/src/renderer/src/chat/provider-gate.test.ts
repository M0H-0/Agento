import { describe, expect, it } from 'vitest'
import { canStartChat } from './provider-gate'

describe('canStartChat', () => {
  it('requires a key for built-in providers', () => {
    expect(canStartChat('ollama', false)).toBe(false)
    expect(canStartChat('groq', false)).toBe(false)
    expect(canStartChat('ollama', true)).toBe(true)
  })

  it('lets a keyless custom (local-server) profile through', () => {
    // Live repro: a keyless custom profile passed validation yet onboarding
    // never finished because readiness demanded hasKey.
    expect(canStartChat('custom:9f2c1a44-0b1e-4d2a-9c3e-1a2b3c4d5e6f', false)).toBe(true)
    expect(canStartChat('custom:9f2c1a44-0b1e-4d2a-9c3e-1a2b3c4d5e6f', true)).toBe(true)
  })
})
