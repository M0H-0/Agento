import type { UIMessage, UIMessageChunk } from 'ai'

export interface ChatSendPayload {
  sessionId: string
  messages: UIMessage[]
}

export interface ChatStopPayload {
  sessionId: string
}

export interface ChatPartEvent {
  sessionId: string
  part: UIMessageChunk
}

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
}

export interface SessionInfo {
  id: string
  title: string
  /** Workspace the session was created under — '' placeholder until the picker (M2.2, docs/03 §8). */
  workspacePath: string
  createdAt: string
  updatedAt: string
  /** Token totals from usage_events; null until the first settled run. */
  usage: SessionUsage | null
}

export interface CreateSessionPayload {
  title?: string
}

export interface SessionMessagesPayload {
  sessionId: string
}

// Workspace contract per docs/03 §4 (workspace/*): main owns the native
// folder dialog; the renderer gets the picked path and may re-apply recents
// this module produced.
export interface WorkspaceRecent {
  path: string
  lastOpenedAt: string
}

export interface WorkspaceSnapshotPayload {
  current: string | null
  recents: WorkspaceRecent[]
}

export interface WorkspaceSetPayload {
  path: string
}

// Session-scoped agent events per docs/03 §4 (M1.5: 'usage' is the first
// member; plan/approval events join this union in M3 — one channel).
export interface AgentUsageEvent {
  type: 'usage'
  sessionId: string
  runId: string
  ts: number
  seq: number
  inputTokens: number | null
  outputTokens: number | null
}

export type AgentEvent = AgentUsageEvent

export interface AgentoChat {
  /** Invoke 'chat:send' — main streams UIMessageChunks back via 'chat:part' (docs/02 §2.1). */
  send: (payload: ChatSendPayload) => Promise<void>
  /** Invoke 'chat:stop' — aborts the session's active run; a no-op when idle (docs/02 §2.1). */
  stop: (payload: ChatStopPayload) => Promise<void>
  /** Subscribe to 'chat:part' events; returns an unsubscribe function. */
  onPart: (listener: (event: ChatPartEvent) => void) => () => void
}

export interface AgentoSessions {
  /** Invoke 'session:create' — lazily creates the session row (docs/03 §8). */
  create: (payload: CreateSessionPayload) => Promise<SessionInfo>
  /** Invoke 'session:list' — sessions ordered updated_at DESC. */
  list: () => Promise<SessionInfo[]>
  /** Invoke 'session:messages' — the session's UIMessages in seq order. */
  messages: (payload: SessionMessagesPayload) => Promise<UIMessage[]>
}

export interface AgentoWorkspaces {
  /** Invoke 'workspace:get' — current workspace + recents (docs/03 §4). */
  get: () => Promise<WorkspaceSnapshotPayload>
  /** Invoke 'workspace:list' — recents only. */
  list: () => Promise<WorkspaceRecent[]>
  /** Invoke 'workspace:pick' — the native folder dialog in main; resolves null when the user cancels. */
  pick: () => Promise<{ path: string } | null>
  /** Invoke 'workspace:set' — applies a path from our own recents. */
  set: (payload: WorkspaceSetPayload) => Promise<{ path: string }>
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

export interface AgentoAgent {
  /** Subscribe to session-scoped 'agent:event' pushes (docs/03 §4); returns an unsubscribe function. */
  onEvent: (listener: (event: AgentEvent) => void) => () => void
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
  /** Provider ids enabled this phase ('google', 'groq') — main is the source of truth. */
  providers: string[]
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

export interface SetProviderPayload {
  provider: string
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
  /** Invoke 'settings:set-provider' — switches the active provider (model resets to that provider's default when needed). */
  setProvider: (payload: SetProviderPayload) => Promise<void>
  /** Invoke 'settings:clear-api-key'. */
  clearApiKey: (payload: ClearApiKeyPayload) => Promise<void>
}

export interface AgentoAPI {
  chat: AgentoChat
  sessions: AgentoSessions
  workspaces: AgentoWorkspaces
  sidecar: AgentoSidecar
  agent: AgentoAgent
  settings: AgentoSettings
}

declare global {
  interface Window {
    agento: AgentoAPI
  }
}
