// Settings profiles — PURE Node, no Electron imports (AGENTS.md rule 1).
// Validation, canonicalization, and v1→v2 migration for the M6.3 settings
// completion + custom OpenAI-compatible providers. settings.ts (Electron
// safeStorage) imports these helpers; vitest covers this module directly.

export type Appearance = 'dark' | 'light' | 'system'

export type Locale = 'en' | 'ar'

export interface CustomProviderProfile {
  /** Opaque stable id (`custom:<uuid>`) — never the editable name/URL, so a rename never orphans the key. */
  id: string
  name: string
  /** Canonical OpenAI-compatible endpoint URL (no credentials/query/fragment). */
  baseUrl: string
  /** Free-form model id for the custom endpoint. */
  model: string
  createdAt: string
  updatedAt: string
}

export interface PermissionDefaults {
  /** Risk 1 (reversible creates): run silently or ask first. Default 'auto'. */
  risk1: 'auto' | 'ask'
  /** Risk 2 (overwrites): ask by default; 'auto' is allowed but weakens the trust loop. Default 'ask'. */
  risk2: 'auto' | 'ask'
  // Risk 3 is hard-locked to always-ask (docs/06 §2) — never stored.
}

export interface PrefsV2 {
  version: 2
  provider: string
  model: string
  appearance: Appearance
  locale: Locale
  permissionDefaults: PermissionDefaults
  customProviders: CustomProviderProfile[]
}

export const SETTINGS_VERSION = 2

export const DEFAULT_APPEARANCE: Appearance = 'dark'
export const DEFAULT_LOCALE: Locale = 'en'
export const DEFAULT_PERMISSIONS: PermissionDefaults = { risk1: 'auto', risk2: 'ask' }

export const BUILT_IN_PROVIDERS = ['google', 'groq', 'ollama'] as const
export type BuiltInProvider = (typeof BUILT_IN_PROVIDERS)[number]

export function isBuiltInProvider(id: string): boolean {
  return (BUILT_IN_PROVIDERS as readonly string[]).includes(id)
}

export function isCustomProviderId(id: string): boolean {
  return /^custom:[A-Za-z0-9-]{4,64}$/.test(id)
}

export function isKnownProviderId(id: string, customIds: string[]): boolean {
  if (isBuiltInProvider(id)) return true
  if (isCustomProviderId(id)) return customIds.includes(id)
  return false
}

export function normalizeAppearance(value: unknown): Appearance {
  return value === 'light' || value === 'dark' || value === 'system' ? value : DEFAULT_APPEARANCE
}

export function normalizeLocale(value: unknown): Locale {
  return value === 'ar' ? 'ar' : DEFAULT_LOCALE
}

export function normalizePermissionDefaults(value: unknown): PermissionDefaults {
  const raw = (value ?? {}) as Partial<PermissionDefaults>
  return {
    risk1: raw.risk1 === 'ask' ? 'ask' : 'auto',
    risk2: raw.risk2 === 'auto' ? 'auto' : 'ask'
  }
}

export function validateProviderName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ')
  if (clean === '') throw new Error('Give this provider a name.')
  if (clean.length > 80) throw new Error('Keep the provider name under 80 characters.')
  return clean
}

export function validateCustomModel(model: string): string {
  const clean = model.trim()
  if (clean === '') throw new Error('Enter the model name for this endpoint.')
  if (clean.length > 200) throw new Error('Keep the model name under 200 characters.')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new Error('The model name has invalid characters.')
  return clean
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

// Canonicalize a user-entered OpenAI-compatible endpoint. Never guesses `/v1`:
// the user enters exactly what the provider documents (e.g. Ollama/LM Studio
// `http://127.0.0.1:11434/v1`). Plain-language errors — no URLs echoed back
// beyond the host.
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('Enter the API endpoint URL.')
  if (trimmed.length > 500) throw new Error('That endpoint URL is too long.')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(
      'That endpoint URL is not valid. It should start with https:// (or http:// for a local server).'
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The endpoint must be an https:// URL (http:// is only for local servers).')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Do not put credentials in the endpoint URL — use the API key field.')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      'The endpoint URL should have no query or fragment — just scheme, host, port, and path.'
    )
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'Plain http:// is only allowed for local servers (localhost / 127.0.0.1). Use https:// otherwise.'
    )
  }
  // Canonical form: href minus trailing slash(es).
  const canonical = parsed.toString().replace(/\/+$/, '')
  return canonical
}

export function nowIso(): string {
  return new Date().toISOString()
}

// Model ids per provider for the composer flyout (ModelChip): built-in curated
// lists verbatim (copied, never shared by reference) plus one single-model
// entry per custom profile. Pure so vitest can cover it — settings.ts
// (Electron safeStorage) cannot load under vitest.
export function buildProviderModels(
  builtInModels: Record<string, string[]>,
  customs: CustomProviderProfile[]
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [id, models] of Object.entries(builtInModels)) out[id] = [...models]
  for (const profile of customs) out[profile.id] = [profile.model]
  return out
}

export function newCustomProviderId(): string {
  // randomUUID is imported by the caller (settings.ts) to keep this module
  // dependency-light; this helper only formats. Kept here for one obvious place.
  return `custom:${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

// Tolerant v1→v2 migration: absent/corrupt/foreign → safe defaults. v1 shape
// was { version: 1, provider, model }; v2 adds appearance, permissionDefaults,
// customProviders. Unknown providers fall back to google; unknown models fall
// back to the provider default (resolved by the caller via curated lists, or
// kept when the provider is a known custom id).
export function migratePrefs(
  raw: unknown,
  resolveModel: (provider: string, model: unknown) => string,
  defaultProvider = 'google'
): PrefsV2 {
  const fallback: PrefsV2 = {
    version: SETTINGS_VERSION,
    provider: defaultProvider,
    model: resolveModel(defaultProvider, undefined),
    appearance: DEFAULT_APPEARANCE,
    locale: DEFAULT_LOCALE,
    permissionDefaults: { ...DEFAULT_PERMISSIONS },
    customProviders: []
  }
  if (raw === null || typeof raw !== 'object') return fallback
  const obj = raw as Record<string, unknown>

  // Custom profiles first (needed to judge provider validity).
  const customProviders: CustomProviderProfile[] = []
  if (Array.isArray(obj.customProviders)) {
    const seen = new Set<string>()
    for (const entry of obj.customProviders) {
      if (entry === null || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      try {
        if (typeof e.id !== 'string' || !isCustomProviderId(e.id)) continue
        if (seen.has(e.id)) continue
        const name = validateProviderName(String(e.name ?? ''))
        const baseUrl = normalizeBaseUrl(String(e.baseUrl ?? ''))
        const model = validateCustomModel(String(e.model ?? ''))
        seen.add(e.id)
        customProviders.push({
          id: e.id,
          name,
          baseUrl,
          model,
          createdAt: typeof e.createdAt === 'string' ? e.createdAt : nowIso(),
          updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : nowIso()
        })
      } catch {
        // Skip invalid custom rows — one bad profile never breaks settings.
      }
    }
  }

  const customIds = customProviders.map((p) => p.id)
  const rawProvider = typeof obj.provider === 'string' ? obj.provider : ''
  const provider =
    isBuiltInProvider(rawProvider) || customIds.includes(rawProvider)
      ? rawProvider
      : defaultProvider

  return {
    version: SETTINGS_VERSION,
    provider,
    model: resolveModel(provider, obj.model),
    appearance: normalizeAppearance(obj.appearance),
    locale: normalizeLocale(obj.locale),
    permissionDefaults: normalizePermissionDefaults(obj.permissionDefaults),
    customProviders
  }
}
