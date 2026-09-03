import type { UIMessage, UIMessageChunk } from 'ai'

export interface ChatSendPayload {
  messages: UIMessage[]
}

export interface ChatPartEvent {
  sessionId: string
  part: UIMessageChunk
}

export interface AgentoChat {
  /** Invoke 'chat:send' — main streams canned parts back via 'chat:part' (docs/02 §2.1). */
  send: (payload: ChatSendPayload) => Promise<void>
  /** Subscribe to 'chat:part' events; returns an unsubscribe function. */
  onPart: (listener: (event: ChatPartEvent) => void) => () => void
}

export type SidecarStatus = 'starting' | 'healthy' | 'unhealthy'

export interface SidecarStatusEvent {
  status: SidecarStatus
  detail?: string
}

export interface AgentoSidecar {
  /** Invoke 'sidecar:get-status' — current sidecar health (docs/03 §4). */
  getStatus: () => Promise<SidecarStatusEvent>
  /** Subscribe to 'sidecar:status' pushes; returns an unsubscribe function. */
  onStatus: (listener: (event: SidecarStatusEvent) => void) => () => void
}

export interface SettingsSnapshot {
  provider: string
  model: string
  /** True when a key is stored for the selected provider (docs/06 §7). */
  hasKey: boolean
  /** Last 4 chars of the stored key; '' when absent — never the key itself. */
  keyLast4: string
  /** False when OS-level encryption is unavailable: keys stay session-only. */
  storageAvailable: boolean
  /** Curated model ids for the provider; main is the source of truth. */
  models: string[]
}

export interface SetApiKeyPayload {
  provider: string
  key: string
}

export interface SetModelPayload {
  model: string
}

export interface ClearApiKeyPayload {
  provider: string
}

export interface AgentoSettings {
  /** Invoke 'settings:get' — snapshot for the selected provider (docs/03 §4). */
  get: () => Promise<SettingsSnapshot>
  /** Invoke 'settings:set-api-key' — main stores the key via safeStorage (docs/06 §7). */
  setApiKey: (payload: SetApiKeyPayload) => Promise<void>
  /** Invoke 'settings:set-model'. */
  setModel: (payload: SetModelPayload) => Promise<void>
  /** Invoke 'settings:clear-api-key'. */
  clearApiKey: (payload: ClearApiKeyPayload) => Promise<void>
}

export interface AgentoAPI {
  chat: AgentoChat
  sidecar: AgentoSidecar
  settings: AgentoSettings
}

declare global {
  interface Window {
    agento: AgentoAPI
  }
}
