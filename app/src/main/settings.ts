import { safeStorage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

export interface SettingsSnapshot {
  provider: string
  model: string
  hasKey: boolean
  keyLast4: string
  storageAvailable: boolean
  /** Provider ids enabled this phase ('google', 'groq') — renderer renders stubs for the rest. */
  providers: string[]
  models: string[]
}

interface Prefs {
  version: number
  provider: string
  model: string
}

// secrets.bin envelope: provider id → base64 safeStorage ciphertext.
interface SecretsEnvelope {
  version: number
  keys: Record<string, string>
}

const SETTINGS_VERSION = 1
const SECRETS_VERSION = 1
const DEFAULT_PROVIDER = 'google'

// Curated Google AI Studio (Gemini API) model ids for a chat agent — text
// generation only (no image/TTS/live/embedding variants), verified 2026-09-03
// against ai.google.dev/gemini-api/docs/models; deprecated gemini-2.0-* ids
// excluded. M1.2 revalidates this list against the provider package.
const GOOGLE_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview'
]

// Curated Groq model ids — chat-capable, tool-calling models only (no
// whisper/orpheus audio, no prompt-guard classifiers, no groq/compound
// agentic systems whose tool semantics differ), verified 2026-09-05 against
// console.groq.com/docs/models via the models.dev catalog. Served through the
// OpenAI-compatible endpoint (STACK.md's Groq row: @ai-sdk/openai-compatible).
const GROQ_MODEL_IDS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
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
  groq: { models: GROQ_MODEL_IDS, defaultModel: 'llama-3.3-70b-versatile' }
}
const ENABLED_PROVIDERS = Object.keys(PROVIDERS)

let initialized = false
let dataDir: string | undefined
let storageAvailable = false
let prefs: Prefs = {
  version: SETTINGS_VERSION,
  provider: DEFAULT_PROVIDER,
  model: PROVIDERS[DEFAULT_PROVIDER].defaultModel
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

function requireDataDir(): string {
  if (dataDir === undefined) throw new Error('Settings are not initialized.')
  return dataDir
}

function loadPrefs(): Prefs {
  // Tolerant by contract (task M1.1): absent/corrupt/foreign file → defaults.
  try {
    const raw = JSON.parse(readFileSync(settingsFilePath(), 'utf-8')) as unknown
    if (
      raw !== null &&
      typeof raw === 'object' &&
      (raw as Prefs).version === SETTINGS_VERSION &&
      typeof (raw as Prefs).provider === 'string' &&
      (raw as Prefs).provider !== '' &&
      typeof (raw as Prefs).model === 'string'
    ) {
      const parsed = raw as Prefs
      const provider = ENABLED_PROVIDERS.includes(parsed.provider)
        ? parsed.provider
        : DEFAULT_PROVIDER
      const models = PROVIDERS[provider].models
      return {
        version: SETTINGS_VERSION,
        provider,
        model: models.includes(parsed.model) ? parsed.model : PROVIDERS[provider].defaultModel
      }
    }
  } catch {
    // Absent or unreadable — fall through to the defaults.
  }
  return {
    version: SETTINGS_VERSION,
    provider: DEFAULT_PROVIDER,
    model: PROVIDERS[DEFAULT_PROVIDER].defaultModel
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
  // secrets.bin is only ever read when we can also decrypt it, and only ever
  // written when encryption is available — never plaintext (docs/06 §7).
  encryptedKeys = storageAvailable ? loadSecrets() : {}
  console.log(
    `[settings] ready — storageAvailable=${storageAvailable}, provider=${prefs.provider}, model=${prefs.model}, persistedKeys=${Object.keys(encryptedKeys).length}`
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

export function getSettings(): SettingsSnapshot {
  const key = resolveProviderKey(prefs.provider)
  // Only mask keys long enough that 4 chars reveal nothing meaningful.
  const keyLast4 = key !== undefined && key.length >= 8 ? key.slice(-4) : ''
  return {
    provider: prefs.provider,
    model: prefs.model,
    hasKey: key !== undefined,
    keyLast4,
    storageAvailable,
    providers: [...ENABLED_PROVIDERS],
    models: [...PROVIDERS[prefs.provider].models]
  }
}

function writePrefs(): void {
  writeFileSync(settingsFilePath(), `${JSON.stringify(prefs, null, 2)}\n`, 'utf-8')
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
  if (!ENABLED_PROVIDERS.includes(cleanProvider)) {
    throw new Error(`Unknown provider: ${cleanProvider === '' ? '(empty)' : cleanProvider}`)
  }
  if (cleanProvider === prefs.provider) return
  // Keep the model only when it exists on the new provider; otherwise fall
  // back to that provider's curated default.
  const next = PROVIDERS[cleanProvider]
  const model = next.models.includes(prefs.model) ? prefs.model : next.defaultModel
  prefs = { ...prefs, provider: cleanProvider, model }
  writePrefs()
}

export function setModel(model: string): void {
  const cleanModel = model.trim()
  const valid = PROVIDERS[prefs.provider].models.includes(cleanModel)
  if (!valid) {
    throw new Error(`Unknown model: ${cleanModel === '' ? '(empty)' : cleanModel}`)
  }
  prefs = { ...prefs, model: cleanModel }
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
