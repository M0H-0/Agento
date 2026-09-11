import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILT_IN_PROVIDERS,
  DEFAULT_PERMISSIONS,
  SETTINGS_VERSION,
  buildProviderModels,
  isCustomProviderId,
  migratePrefs,
  normalizeAppearance,
  normalizeBaseUrl,
  normalizeLocale,
  normalizePermissionDefaults,
  nowIso,
  validateCustomModel,
  validateProviderName
} from './settings-profiles'
import type {
  Appearance,
  CustomProviderProfile,
  Locale,
  PermissionDefaults,
  PrefsV2
} from './settings-profiles'

// Settings + secrets storage (docs/06 §7 split): plain preferences live in
// settings.json; model-provider API keys live ONLY in secrets.bin, wrapped
// with Electron safeStorage (DPAPI on Windows). Unlike db.ts/sidecar.ts this
// module deliberately imports Electron — safeStorage exists only in the main
// process (AGENTS.md rule 1 exception, M1.1) — but stays otherwise pure Node
// and receives userDataDir as an argument; src/main/index.ts passes
// app.getPath('userData') during whenReady, before its IPC registers.
//
// Scrub discipline (docs/06 §7): key material is never logged, never returned
// over IPC, and never written outside secrets.bin. If OS-level encryption is
// unavailable, keys are kept in memory for the session only and secrets.bin
// is never written — the UI says so honestly via storageAvailable.

export interface CustomProviderSnapshot {
  id: string
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  keyLast4: string
  createdAt: string
  updatedAt: string
}

export interface SettingsSnapshot {
  provider: string
  model: string
  hasKey: boolean
  keyLast4: string
  storageAvailable: boolean
  /** Built-in provider ids ('google', 'groq') — main is the source of truth. */
  providers: string[]
  /** Model ids for the active provider: curated list for built-ins, [profile.model] for customs. */
  models: string[]
  /** Every provider id → its model ids (built-in curated lists; one entry per custom profile). */
  providerModels: Record<string, string[]>
  /** Masked key state for EVERY provider (built-ins + customs) — keyLast4 only, never the key itself. */
  providerKeys: Record<string, { hasKey: boolean; keyLast4: string }>
  appearance: Appearance
  locale: Locale
  permissionDefaults: PermissionDefaults
  customProviders: CustomProviderSnapshot[]
}

// secrets.bin envelope: provider id → base64 safeStorage ciphertext.
// Custom profiles use their opaque `custom:<uuid>` id as the key, so a rename
// never orphans the stored secret.
interface SecretsEnvelope {
  version: number
  keys: Record<string, string>
}

const SECRETS_VERSION = 1
const DEFAULT_PROVIDER = 'google'

// Curated Google AI Studio (Gemini API) model ids for a chat agent — text
// generation only (no image/TTS/live/embedding variants), re-verified
// 2026-09-12 against ai.google.dev/gemini-api/docs/models (page last updated
// 2026-09-04): the current stable lineup is 2.5 → 3.1 Flash-Lite → 3.5 →
// 3.5-Lite → 3.6 → 3.7 → 3.8 Flash. gemini-3.1-pro-preview is dropped (no
// 3.1-series Pro exists in the catalog; stored prefs naming it self-heal to
// the default via resolveModelForPrefs on load). The default stays
// gemini-2.5-flash — still Google's price-performance workhorse.
const GOOGLE_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash'
]

// Curated Groq model ids — chat-capable, tool-calling models only (no
// whisper/orpheus audio, no prompt-guard classifiers, no groq/compound
// agentic systems whose tool semantics differ), re-verified 2026-09-11:
// Groq shut down llama-3.3-70b-versatile + llama-3.1-8b-instant on
// 2026-08-16 (console.groq.com/docs/models now lists only the gpt-oss
// pair among chat models), so both Llama ids are dropped and the default
// moves to Groq's recommended flagship replacement. Stored prefs naming a
// retired id self-heal to the default via resolveModelForPrefs on load.
// Served through the OpenAI-compatible endpoint (STACK.md's Groq row:
// @ai-sdk/openai-compatible).
const GROQ_MODEL_IDS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.6-27b',
  'qwen/qwen3.8-27b'
]

// Providers enabled this phase + their curated model lists. Main is the
// source of truth for both the provider list and the model list (docs/04
// §3.7); the renderer renders what this says, nothing more.
const PROVIDERS: Record<string, { models: string[]; defaultModel: string }> = {
  google: { models: GOOGLE_MODEL_IDS, defaultModel: 'gemini-2.5-flash' },
  groq: { models: GROQ_MODEL_IDS, defaultModel: 'openai/gpt-oss-120b' }
}
const ENABLED_PROVIDERS: string[] = [...BUILT_IN_PROVIDERS]

let initialized = false
let dataDir: string | undefined
let storageAvailable = false
let prefs: PrefsV2 = {
  version: SETTINGS_VERSION,
  provider: DEFAULT_PROVIDER,
  model: PROVIDERS[DEFAULT_PROVIDER].defaultModel,
  appearance: 'dark',
  locale: 'en',
  permissionDefaults: { ...DEFAULT_PERMISSIONS },
  customProviders: []
}
// Encrypted key map as loaded from / destined for secrets.bin (empty when
// encryption is unavailable).
let encryptedKeys: Record<string, string> = {}
// Plaintext keys for the CURRENT session only — memory, never disk. Feeds
// keyLast4 today and the provider client in M1.2.
const sessionKeys = new Map<string, string>()

function settingsFilePath(): string {
  return join(requireDataDir(), 'settings.json')
}

function secretsFilePath(): string {
  return join(requireDataDir(), 'secrets.bin')
}

export function requireDataDir(): string {
  if (dataDir === undefined) throw new Error('Settings are not initialized.')
  return dataDir
}

function resolveModelForPrefs(provider: string, model: unknown): string {
  if (provider === 'google' || provider === 'groq') {
    const list = PROVIDERS[provider]
    return typeof model === 'string' && list.models.includes(model) ? model : list.defaultModel
  }
  if (isCustomProviderId(provider)) {
    // Custom model validity needs the profile list, which migratePrefs is
    // still building — accept any non-empty string here; migratePrefs keeps
    // only rows whose own model validates.
    return typeof model === 'string' && model.trim() !== '' ? model.trim() : 'model'
  }
  return PROVIDERS[DEFAULT_PROVIDER].defaultModel
}

function loadPrefs(): PrefsV2 {
  // Tolerant by contract (task M1.1): absent/corrupt/foreign file → defaults.
  try {
    const raw = JSON.parse(readFileSync(settingsFilePath(), 'utf-8')) as unknown
    return migratePrefs(raw, resolveModelForPrefs, DEFAULT_PROVIDER)
  } catch {
    // Absent or unreadable — fall through to the defaults.
  }
  return {
    version: SETTINGS_VERSION,
    provider: DEFAULT_PROVIDER,
    model: PROVIDERS[DEFAULT_PROVIDER].defaultModel,
    appearance: 'dark',
    locale: 'en',
    permissionDefaults: { ...DEFAULT_PERMISSIONS },
    customProviders: []
  }
}

function loadSecrets(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(secretsFilePath(), 'utf-8')) as unknown
    if (
      raw !== null &&
      typeof raw === 'object' &&
      (raw as SecretsEnvelope).version === SECRETS_VERSION &&
      typeof (raw as SecretsEnvelope).keys === 'object' &&
      (raw as SecretsEnvelope).keys !== null
    ) {
      const clean: Record<string, string> = {}
      for (const [provider, value] of Object.entries((raw as SecretsEnvelope).keys)) {
        if (typeof value === 'string' && value !== '') clean[provider] = value
      }
      return clean
    }
  } catch {
    // Absent or unreadable — start with no persisted keys.
  }
  return {}
}

// Idempotent singleton (db.ts style). Runs inside whenReady, so safeStorage
// can answer honestly about OS-level encryption (docs/06 §7).
export function initSettings(userDataDir: string): void {
  if (initialized) return
  mkdirSync(userDataDir, { recursive: true })
  dataDir = userDataDir
  storageAvailable = safeStorage.isEncryptionAvailable()
  prefs = loadPrefs()
  // Repair pass: prefs.model for a custom provider mirrors its profile; a
  // profile edit outside the setters (or a v1 file) could leave them apart.
  const activeCustom = prefs.customProviders.find((p) => p.id === prefs.provider)
  if (activeCustom && prefs.model !== activeCustom.model) {
    prefs = { ...prefs, model: activeCustom.model }
    try {
      writePrefs()
    } catch {
      // Best-effort repair — the in-memory value is already correct.
    }
  }
  // secrets.bin is only ever read when we can also decrypt it, and only ever
  // written when encryption is available — never plaintext (docs/06 §7).
  encryptedKeys = storageAvailable ? loadSecrets() : {}
  console.log(
    `[settings] ready — storageAvailable=${storageAvailable}, provider=${prefs.provider}, model=${prefs.model}, persistedKeys=${Object.keys(encryptedKeys).length}, customProviders=${prefs.customProviders.length}`
  )
  initialized = true
}

// Decrypt on demand, only here. Session keys (this launch's setApiKey calls)
// short-circuit the decrypt; restarts decrypt from secrets.bin when possible.
// Exported for the chat pipeline (M1.2): the provider client in
// src/main/ipc/chat.ts asks for the key here instead of re-reading files —
// so a key saved mid-session applies to the very next message.
export function resolveProviderKey(provider: string): string | undefined {
  const sessionKey = sessionKeys.get(provider)
  if (sessionKey !== undefined) return sessionKey
  const encrypted = encryptedKeys[provider]
  if (encrypted === undefined || !storageAvailable) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    // Undecryptable (e.g. ciphertext from another OS user) — treat as absent.
    return undefined
  }
}

function maskKey(key: string | undefined): string {
  return key !== undefined && key.length >= 8 ? key.slice(-4) : ''
}

function toCustomSnapshot(profile: CustomProviderProfile): CustomProviderSnapshot {
  const key = resolveProviderKey(profile.id)
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasKey: key !== undefined,
    keyLast4: maskKey(key),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  }
}

export function getSettings(): SettingsSnapshot {
  const key = resolveProviderKey(prefs.provider)
  // Only mask keys long enough that 4 chars reveal nothing meaningful.
  const keyLast4 = maskKey(key)
  const activeCustom = prefs.customProviders.find((p) => p.id === prefs.provider)
  const models =
    activeCustom !== undefined
      ? [activeCustom.model]
      : [...(PROVIDERS[prefs.provider]?.models ?? [])]
  const builtInModels: Record<string, string[]> = {}
  for (const [id, entry] of Object.entries(PROVIDERS)) builtInModels[id] = entry.models
  // Key state for every provider — feeds the unified "Your providers" list in
  // Settings (docs/04 §3.7) so built-ins appear alongside custom profiles with
  // their own masked status. Same masking discipline as `keyLast4` above.
  const providerKeys: Record<string, { hasKey: boolean; keyLast4: string }> = {}
  for (const id of ENABLED_PROVIDERS) {
    const providerKey = resolveProviderKey(id)
    providerKeys[id] = { hasKey: providerKey !== undefined, keyLast4: maskKey(providerKey) }
  }
  for (const profile of prefs.customProviders) {
    const profileKey = resolveProviderKey(profile.id)
    providerKeys[profile.id] = { hasKey: profileKey !== undefined, keyLast4: maskKey(profileKey) }
  }
  return {
    provider: prefs.provider,
    model: prefs.model,
    hasKey: key !== undefined,
    keyLast4,
    storageAvailable,
    providers: [...ENABLED_PROVIDERS],
    models,
    providerModels: buildProviderModels(builtInModels, prefs.customProviders),
    providerKeys,
    appearance: prefs.appearance,
    locale: prefs.locale,
    permissionDefaults: { ...prefs.permissionDefaults },
    customProviders: prefs.customProviders.map(toCustomSnapshot)
  }
}

/** Active provider's endpoint URL for custom profiles; undefined for built-ins. */
export function resolveActiveBaseUrl(): string | undefined {
  const active = prefs.customProviders.find((p) => p.id === prefs.provider)
  return active?.baseUrl
}

export function getAppearance(): Appearance {
  return prefs.appearance
}

export function getLocale(): Locale {
  return prefs.locale
}

export function getPermissionDefaults(): PermissionDefaults {
  return { ...prefs.permissionDefaults }
}

export function getCustomProviders(): CustomProviderProfile[] {
  return prefs.customProviders.map((p) => ({ ...p }))
}

function writePrefs(): void {
  // Atomic temp-file + rename (workspaces.json precedent): a crash mid-write
  // never leaves a half-written settings.json.
  const target = settingsFilePath()
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, 'utf-8')
  renameSync(tmp, target)
}

function writeSecrets(keys: Record<string, string>): void {
  const envelope: SecretsEnvelope = { version: SECRETS_VERSION, keys }
  // mode 0o600 is the POSIX intent; on Windows the real protection is the
  // DPAPI ciphertext plus the user-profile ACL (mode bits don't map cleanly).
  writeFileSync(secretsFilePath(), `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
}

export function setApiKey(provider: string, key: string): void {
  const cleanProvider = provider.trim()
  const cleanKey = key.trim()
  if (cleanProvider === '') throw new Error('Provider is required.')
  if (cleanKey === '') throw new Error('API key is required.')

  if (storageAvailable) {
    // Persist-then-commit: write the next map first, then adopt it, so a
    // failed write never leaves memory and disk describing different keys.
    const next = {
      ...encryptedKeys,
      [cleanProvider]: safeStorage.encryptString(cleanKey).toString('base64')
    }
    writeSecrets(next)
    encryptedKeys = next
  }
  sessionKeys.set(cleanProvider, cleanKey)
  // First save creates settings.json (prefs only — no key ever lands here).
  writePrefs()
}

export function setProvider(provider: string): void {
  const cleanProvider = provider.trim()
  const customIds = prefs.customProviders.map((p) => p.id)
  const known = ENABLED_PROVIDERS.includes(cleanProvider) || customIds.includes(cleanProvider)
  if (!known) {
    throw new Error(`Unknown provider: ${cleanProvider === '' ? '(empty)' : cleanProvider}`)
  }
  if (cleanProvider === prefs.provider) return
  let model = prefs.model
  if (ENABLED_PROVIDERS.includes(cleanProvider)) {
    const next = PROVIDERS[cleanProvider as 'google' | 'groq']
    model = next.models.includes(prefs.model) ? prefs.model : next.defaultModel
  } else {
    const profile = prefs.customProviders.find((p) => p.id === cleanProvider)
    if (profile) model = profile.model
  }
  prefs = { ...prefs, provider: cleanProvider, model }
  writePrefs()
}

export function setModel(model: string): void {
  const cleanModel = model.trim()
  if (prefs.provider === 'google' || prefs.provider === 'groq') {
    const valid = PROVIDERS[prefs.provider as 'google' | 'groq'].models.includes(cleanModel)
    if (!valid) {
      throw new Error(`Unknown model: ${cleanModel === '' ? '(empty)' : cleanModel}`)
    }
    prefs = { ...prefs, model: cleanModel }
    writePrefs()
    return
  }
  // Custom active provider: free-form model id, kept in sync with the profile.
  const valid = validateCustomModel(cleanModel)
  prefs = {
    ...prefs,
    model: valid,
    customProviders: prefs.customProviders.map((p) =>
      p.id === prefs.provider ? { ...p, model: valid, updatedAt: nowIso() } : p
    )
  }
  writePrefs()
}

export function clearApiKey(provider: string): void {
  const cleanProvider = provider.trim()
  if (cleanProvider === '') throw new Error('Provider is required.')

  if (storageAvailable && encryptedKeys[cleanProvider] !== undefined) {
    const next = { ...encryptedKeys }
    delete next[cleanProvider]
    writeSecrets(next)
    encryptedKeys = next
  }
  sessionKeys.delete(cleanProvider)
}

export function setAppearance(appearance: string): void {
  prefs = { ...prefs, appearance: normalizeAppearance(appearance) }
  writePrefs()
}

export function setLocale(locale: string): void {
  prefs = { ...prefs, locale: normalizeLocale(locale) }
  writePrefs()
}

export function setPermissionDefaults(input: unknown): PermissionDefaults {
  const next = normalizePermissionDefaults(input)
  prefs = { ...prefs, permissionDefaults: next }
  writePrefs()
  return { ...next }
}

export function createCustomProvider(input: {
  name: string
  baseUrl: string
  model: string
}): CustomProviderProfile {
  const name = validateProviderName(input.name)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const model = validateCustomModel(input.model)
  const now = nowIso()
  const profile: CustomProviderProfile = {
    id: `custom:${randomUUID()}`,
    name,
    baseUrl,
    model,
    createdAt: now,
    updatedAt: now
  }
  prefs = { ...prefs, customProviders: [...prefs.customProviders, profile] }
  writePrefs()
  return { ...profile }
}

export function updateCustomProvider(
  id: string,
  input: { name?: string; baseUrl?: string; model?: string }
): CustomProviderProfile {
  const cleanId = id.trim()
  const index = prefs.customProviders.findIndex((p) => p.id === cleanId)
  if (index === -1) throw new Error('That custom provider no longer exists.')
  const current = prefs.customProviders[index]
  const next: CustomProviderProfile = {
    ...current,
    name: input.name !== undefined ? validateProviderName(input.name) : current.name,
    baseUrl: input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : current.baseUrl,
    model: input.model !== undefined ? validateCustomModel(input.model) : current.model,
    updatedAt: nowIso()
  }
  const customProviders = prefs.customProviders.map((p, i) => (i === index ? next : p))
  prefs = {
    ...prefs,
    customProviders,
    // Keep the active model mirror in sync when editing the active profile.
    model: prefs.provider === next.id ? next.model : prefs.model
  }
  writePrefs()
  return { ...next }
}

export function deleteCustomProvider(id: string): void {
  const cleanId = id.trim()
  if (cleanId === '') throw new Error('Provider is required.')
  if (prefs.provider === cleanId) {
    throw new Error(
      'This provider is currently selected. Pick another provider before removing it.'
    )
  }
  const exists = prefs.customProviders.some((p) => p.id === cleanId)
  if (!exists) throw new Error('That custom provider no longer exists.')
  prefs = { ...prefs, customProviders: prefs.customProviders.filter((p) => p.id !== cleanId) }
  writePrefs()
  // Removing a profile removes its key too — no orphan secrets. Persisted and
  // session-only copies both go; a failure writing secrets.bin must not
  // resurrect the profile, so the profile write above commits first.
  if (storageAvailable && encryptedKeys[cleanId] !== undefined) {
    const next = { ...encryptedKeys }
    delete next[cleanId]
    writeSecrets(next)
    encryptedKeys = next
  }
  sessionKeys.delete(cleanId)
}
