import type { UIMessage, UIMessageChunk } from 'ai'

export interface ChatSendPayload {
  sessionId: string
  messages: UIMessage[]
}

export interface ChatStopPayload {
  sessionId: string
}

export interface ToolAnswerPayload {
  toolCallId: string
  answer: string
}

export interface ChatPartEvent {
  sessionId: string
  part: UIMessageChunk
}

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
}

export type SessionMode = 'plan' | 'act'

export interface SessionInfo {
  id: string
  title: string
  /** Workspace the session was created under — '' placeholder until the picker (M2.2, docs/03 §8). */
  workspacePath: string
  /** Composer execution mode owned by this session (docs/03 §2): plan is read-only, act may mutate. */
  mode: SessionMode
  createdAt: string
  updatedAt: string
  /** Token totals from usage_events; null until the first settled run. */
  usage: SessionUsage | null
}

export interface CreateSessionPayload {
  title?: string
  mode?: SessionMode
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

// Auto-generated chat title landed (docs/03 §4) — structural mirror of the
// main-side sessionTitleUpdatedEventSchema.
export interface AgentSessionTitleUpdatedEvent {
  type: 'session/title_updated'
  sessionId: string
  runId: string
  ts: number
  seq: number
  title: string
}

export type AgentEvent =
  | AgentUsageEvent
  | AgentPlanCreatedEvent
  | AgentPlanStepUpdatedEvent
  | AgentApprovalRequestedEvent
  | AgentApprovalResolvedEvent
  | AgentVerificationFinishedEvent
  | AgentSessionTitleUpdatedEvent

export interface AgentApprovalRequestedEvent {
  type: 'approval/requested'
  sessionId: string
  runId: string
  ts: number
  seq: number
  approvalId: string
  title: string
  body: string
  riskLevel: number
  count?: number
}

export interface AgentApprovalResolvedEvent {
  type: 'approval/resolved'
  sessionId: string
  runId: string
  ts: number
  seq: number
  approvalId: string
  decision: 'approve' | 'skip' | 'cancel'
}

export interface AgentVerificationFinishedEvent {
  type: 'verification/finished'
  sessionId: string
  runId: string
  ts: number
  seq: number
  stepId: string
  isComplete: boolean
  score: number | null
  missedSegments?: string[]
}

// Plan events (docs/03 §4, M3.1): the plan's user surface is the PlanPanel
// (docs/04 §3.3). `plan/step_updated` has no M3.1 emitter yet (per-step
// tracing lands M3.5/M3.6) — the type is the contract from day one.
export interface AgentPlanStep {
  id: string
  description: string
  tool: string
  riskLevel: number
  requiresApproval: boolean
}

export interface AgentPlanCreatedEvent {
  type: 'plan/created'
  sessionId: string
  runId: string
  ts: number
  seq: number
  steps: AgentPlanStep[]
}

export type PlanStepStatus =
  'pending' | 'in_progress' | 'done' | 'failed' | 'awaiting_approval' | 'skipped'

export interface AgentPlanStepUpdatedEvent {
  type: 'plan/step_updated'
  sessionId: string
  runId: string
  ts: number
  seq: number
  stepId: string
  status: PlanStepStatus
  verification?: { score: number | null; verified: boolean }
  error?: string
}

// Plan-start gate (M3.1, docs/03 §2): resolves the run's pending plan-start
// promise — execution starts only after the user presses Start (or replies
// "go ahead"; both call this). `approved: false` is card 05's deny surface.
export interface PlanStartResult {
  ok: boolean
  reason?: string
}

export interface AgentoChat {
  /** Invoke 'chat:send' — main streams UIMessageChunks back via 'chat:part' (docs/02 §2.1). */
  send: (payload: ChatSendPayload) => Promise<void>
  /** Invoke 'chat:stop' — aborts the session's active run; a no-op when idle (docs/02 §2.1). */
  stop: (payload: ChatStopPayload) => Promise<void>
  /** Subscribe to 'chat:part' events; returns an unsubscribe function. */
  onPart: (listener: (event: ChatPartEvent) => void) => () => void
}

export interface AgentoTool {
  /** Invoke 'tool:answer' — settles a paused ask_user (docs/03 §5 / M2.4). */
  answer: (payload: ToolAnswerPayload) => Promise<{ ok: boolean; reason?: string }>
}

export interface AgentoPlan {
  /** Invoke 'plan:start' — resolves the matching session/run's pending plan-start gate (docs/03 §2, M3.1). */
  start: (payload?: {
    approved?: boolean
    sessionId?: string
    runId?: string
  }) => Promise<PlanStartResult>
}

export interface ApprovalRespondPayload {
  approvalId: string
  decision: 'approve' | 'skip' | 'cancel'
}

export interface AgentoApproval {
  /** Invoke 'approval:respond' — settles a pending risk ≥ 2 approval (docs/03 §4, M3.2). */
  respond: (payload: ApprovalRespondPayload) => Promise<{ ok: boolean; reason?: string }>
}

// Changes (M2.8 panel; docs/03 §4 + §7-8): a session's checkpoints
// newest-first with per-item undo and Undo all. The renderer shows relative
// paths only — the absolute workspace root never crosses the bridge.
export interface ChangeEntry {
  id: string
  tool: string
  /** Groups a multi-row mutation into one panel item (M2.7 move rows share it). */
  groupKey: string | null
  relativePath: string
  /** Move destination, relative for display. */
  relativeDestPath: string | null
  existed: boolean
  isDir: boolean
  size: number | null
  beforeExcerpt: string | null
  afterExcerpt: string | null
  revertedAt: string | null
  createdAt: string
}

export interface ChangesListResult {
  entries: ChangeEntry[]
  activeCount: number
}

export interface ChangesUndoItem {
  checkpointId: string
  ok: boolean
  action?: string
  error?: string
}

export interface ChangesUndoResult {
  results: ChangesUndoItem[]
}

export interface AgentoChanges {
  /** Invoke 'changes:list' — a session's checkpoints (M2.8 panel). */
  list: (payload: { sessionId: string }) => Promise<ChangesListResult>
  /** Invoke 'changes:undo' — restore one checkpoint (blocked mid-run). */
  undo: (payload: { checkpointId: string }) => Promise<ChangesUndoResult>
  /** Invoke 'changes:undo-all' — replay the session newest-first (blocked mid-run). */
  undoAll: (payload: { sessionId: string }) => Promise<ChangesUndoResult>
}

export interface AgentoSessions {
  /** Invoke 'session:create' — lazily creates the session row (docs/03 §8). */
  create: (payload: CreateSessionPayload) => Promise<SessionInfo>
  /** Invoke 'session:list' — sessions ordered updated_at DESC. */
  list: () => Promise<SessionInfo[]>
  /** Invoke 'session:messages' — the session's UIMessages in seq order. */
  messages: (payload: SessionMessagesPayload) => Promise<UIMessage[]>
  /** Invoke 'session:set-mode' — persists the composer's Plan/Act tab (docs/03 §2). */
  setMode: (payload: { sessionId: string; mode: SessionMode }) => Promise<SessionInfo>
  /** Invoke 'session:rename' — user rename; the auto-title never overwrites it. */
  rename: (payload: { sessionId: string; title: string }) => Promise<SessionInfo>
  /** Invoke 'session:delete' — removes the conversation, its undo history, and audit rows. */
  delete: (payload: SessionMessagesPayload) => Promise<{ deleted: boolean }>
  /** Invoke 'session:plan' — the session's latest saved plan (empty when none). */
  plan: (payload: SessionMessagesPayload) => Promise<AgentPlanStep[]>
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

export type Appearance = 'dark' | 'light' | 'system'

export interface CustomProviderSnapshot {
  id: string
  name: string
  baseUrl: string
  model: string
  /** True when a key is stored for this profile (docs/06 §7). */
  hasKey: boolean
  /** Last 4 chars of the stored key; '' when absent — never the key itself. */
  keyLast4: string
  createdAt: string
  updatedAt: string
}

export interface PermissionDefaults {
  risk1: 'auto' | 'ask'
  risk2: 'auto' | 'ask'
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
  /** Built-in provider ids ('google', 'groq') — main is the source of truth. */
  providers: string[]
  /** Model ids for the active provider (curated list, or [profile.model] for customs). */
  models: string[]
  appearance: Appearance
  permissionDefaults: PermissionDefaults
  customProviders: CustomProviderSnapshot[]
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

export interface SetAppearancePayload {
  appearance: string
}

export interface SetPermissionDefaultsPayload {
  risk1?: string
  risk2?: string
}

export interface CreateCustomProviderPayload {
  name: string
  baseUrl: string
  model: string
}

export interface UpdateCustomProviderPayload {
  id: string
  name?: string
  baseUrl?: string
  model?: string
}

export interface DeleteCustomProviderPayload {
  id: string
}

export interface TestProviderPayload {
  provider?: string
  baseUrl?: string
  model?: string
  key?: string
}

export interface TestProviderResult {
  ok: boolean
  reason?: string
}

export interface DataSummary {
  sessionCount: number
  messageCount: number
  checkpointCount: number
  activeCheckpointCount: number
}

export interface SystemOpenPathPayload {
  path: string
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
  /** Invoke 'settings:set-appearance' — dark | light | system. */
  setAppearance: (payload: SetAppearancePayload) => Promise<SettingsSnapshot>
  /** Invoke 'settings:set-permission-defaults' — risk 3 stays always-ask (docs/06 §2). */
  setPermissionDefaults: (payload: SetPermissionDefaultsPayload) => Promise<PermissionDefaults>
  /** Invoke 'settings:create-custom-provider'. */
  createCustomProvider: (payload: CreateCustomProviderPayload) => Promise<{ id: string }>
  /** Invoke 'settings:update-custom-provider'. */
  updateCustomProvider: (payload: UpdateCustomProviderPayload) => Promise<SettingsSnapshot>
  /** Invoke 'settings:delete-custom-provider' — also removes its stored key. */
  deleteCustomProvider: (payload: DeleteCustomProviderPayload) => Promise<SettingsSnapshot>
  /** Invoke 'settings:test-provider' — bounded non-mutating check in main; plain verdict only. */
  testProvider: (payload: TestProviderPayload) => Promise<TestProviderResult>
  /** Invoke 'settings:get-data-summary'. */
  getDataSummary: () => Promise<DataSummary>
  /** Invoke 'settings:open-data-folder'. */
  openDataFolder: () => Promise<{ ok: boolean }>
  /** Invoke 'settings:clear-sessions'. */
  clearSessions: () => Promise<{ sessions: number }>
  /** Invoke 'settings:purge-snapshots'. */
  purgeSnapshots: () => Promise<{ checkpoints: number }>
  /** Invoke 'settings:export-eval' — redacted eval export into the data dir. */
  exportEval: () => Promise<{ fileName: string; sessionCount: number }>
}

export interface AgentoSystem {
  /** Invoke 'system:open-path' — open a workspace file with the OS default
   * app (MVP semantic-search card). Main resolves against the current
   * workspace and sandbox-checks containment before shell.openPath. */
  openPath: (payload: SystemOpenPathPayload) => Promise<{ ok: boolean; reason?: string }>
}

export interface AgentoAPI {
  chat: AgentoChat
  tool: AgentoTool
  plan: AgentoPlan
  approval: AgentoApproval
  changes: AgentoChanges
  sessions: AgentoSessions
  workspaces: AgentoWorkspaces
  sidecar: AgentoSidecar
  agent: AgentoAgent
  settings: AgentoSettings
  system: AgentoSystem
}

declare global {
  interface Window {
    agento: AgentoAPI
  }
}
