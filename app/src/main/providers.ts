import type { LanguageModel } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

// Provider client factory — plain Node, no Electron (AGENTS.md rule 1).
// Built-ins keep their exact M1.2 behavior; custom profiles ride the
// already-installed @ai-sdk/openai-compatible Chat Completions adapter
// (OpenAI-compatible endpoints only — no vendor forks, docs/03 §10).

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

// First-class Ollama Cloud (M6.5): hosted OpenAI-compatible endpoint.
// Keyed like Google/Groq — local servers stay on custom profiles.
export const OLLAMA_BASE_URL = 'https://ollama.com/v1'

export interface CustomProviderDescriptor {
  id: string
  baseUrl: string
  model: string
}

/** Built-ins always need a key; custom endpoints may be keyless (local servers). */
export function providerRequiresKey(providerId: string): boolean {
  return providerId === 'google' || providerId === 'groq' || providerId === 'ollama'
}

export function buildLanguageModel(input: {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
}): LanguageModel {
  const { provider, model } = input
  if (provider === 'google') {
    if (!input.apiKey) throw new Error('Missing API key.')
    return createGoogleGenerativeAI({ apiKey: input.apiKey })(model)
  }
  if (provider === 'groq') {
    if (!input.apiKey) throw new Error('Missing API key.')
    const groq = createOpenAICompatible({
      name: 'groq',
      baseURL: GROQ_BASE_URL,
      apiKey: input.apiKey
    })
    return groq(model)
  }
  if (provider === 'ollama') {
    if (!input.apiKey) throw new Error('Missing API key.')
    const ollama = createOpenAICompatible({
      name: 'ollama',
      baseURL: input.baseUrl ?? OLLAMA_BASE_URL,
      apiKey: input.apiKey
    })
    return ollama(model)
  }
  if (provider.startsWith('custom:')) {
    if (!input.baseUrl) throw new Error('This custom provider has no endpoint URL.')
    const factory =
      input.apiKey !== undefined && input.apiKey !== ''
        ? createOpenAICompatible({ name: 'custom', baseURL: input.baseUrl, apiKey: input.apiKey })
        : createOpenAICompatible({ name: 'custom', baseURL: input.baseUrl })
    return factory(model)
  }
  throw new Error(`Unsupported provider: ${provider}`)
}

/** Plain-language mapping for the Test-connection action (docs/04 §5 — never raw codes). */
export function friendlyTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key')
  ) {
    return 'The API key was rejected. Check the key and try again.'
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return 'The endpoint refused the request. Check the key and model access.'
  }
  if (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('no such model') ||
    lower.includes('model_not_found')
  ) {
    return 'The endpoint or model was not found. Check the endpoint URL and model name.'
  }
  if (lower.includes('429') || lower.includes('rate')) {
    return 'The endpoint is rate-limiting. Wait a moment and try again.'
  }
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('fetch failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('network')
  ) {
    return 'The endpoint could not be reached. Check the URL and your connection.'
  }
  if (lower.includes('timeout') || lower.includes('aborted') || lower.includes('abort')) {
    return 'The endpoint timed out. Check the URL and try again.'
  }
  return 'The test request failed. Check the endpoint URL, model name, and key.'
}
