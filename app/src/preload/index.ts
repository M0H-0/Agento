import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { UIMessage, UIMessageChunk } from 'ai'

// Typed API exposed to the renderer — the ONLY bridge surface. The renderer
// never touches ipcRenderer directly. Chat transport contract per docs/02 §2.1:
// 'chat:send' + 'chat:stop' invokes + 'chat:part' stream-part events, parts
// forwarded verbatim.
export interface ChatSendPayload {
  sessionId: string
  messages: UIMessage[]
}

export interface ChatStopPayload {
  sessionId: string
}

// ask_user (docs/03 §5): the loop pauses on the user's reply in the thread.
// The bridge is a synthetic `tool-output-available` chunk with an
// `__agentoAskUser` payload; the renderer's card reads the question/options
// and calls `tool:answer` to resume the loop. No new IPC channel — the
// existing `chat:part` envelope is the only wire for tool activity.
export interface ToolAnswerPayload {
  toolCallId: string
  answer: string
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

export interface ChatPartEvent {
  sessionId: string
  part: UIMessageChunk
}

// Sessions contract per docs/03 §4 + §8: plain invokes; the renderer holds the
// active session id and passes it on every chat:send.
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
}

export type SessionMode = 'plan' | 'act'

export interface SessionInfo {
  id: string
  title: string
  /** The workspace this session was created under ('' — empty placeholder — until M2.2 picks one; docs/03 §8). */
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

// Workspace contract per docs/03 §4 (workspace/*): the native folder dialog
// lives in main; the renderer only gets the resulting path back and may
// re-apply paths this module produced (recents).
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

// Session-scoped agent events per docs/03 §4: main → renderer push on
// 'agent:event', payload discriminated on `type`, Zod-validated both sides
// (main builds/validates in src/main/ipc/agent-events.ts; the renderer
// validates in src/renderer/src/chat/agent-events.ts). First member is
// 'usage' (M1.5); plan/approval events (M3) join this union — one channel.
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

export interface ApprovalRespondPayload {
  approvalId: string
  decision: 'approve' | 'skip' | 'cancel'
}

// Plan events (docs/03 §4, M3.1): the plan's user surface is the PlanPanel
// (docs/04 §3.3); the wire step id is the model's own id. `plan/step_updated`
// has no M3.1 emitter yet (per-step tracing lands M3.5/M3.6) — the type is
// the contract from day one (Zod-both-sides rule: main schema + renderer
// mirror + this preload type must stay in sync).
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

// Sidecar status contract per docs/03 §4: app-level push + pull, deliberately
// not a session-scoped 'agent:event' (no sessionId/runId exists for it).
export interface SidecarStatusEvent {
  status: 'starting' | 'healthy' | 'unhealthy'
  detail?: string
}

// Settings contract per docs/03 §4 + docs/06 §7: plain invokes. Key material
// travels renderer → main ONLY; the snapshot never contains the key — hasKey
// and keyLast4 at most. M6.3: appearance + permission defaults + custom
// OpenAI-compatible provider profiles join the snapshot.
export type Appearance = 'dark' | 'light' | 'system'

export type Locale = 'en' | 'ar'

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

export interface PermissionDefaults {
  risk1: 'auto' | 'ask'
  risk2: 'auto' | 'ask'
}

export interface SettingsSnapshot {
  provider: string
  model: string
  hasKey: boolean
  keyLast4: string
  storageAvailable: boolean
  /** Built-in provider ids ('google', 'groq') — main is the source of truth. */
  providers: string[]
  /** Model ids for the active provider (curated list, or [profile.model] for customs). */
  models: string[]
  /** Every provider id → its model ids (built-in curated lists; one entry per custom profile). */
  providerModels: Record<string, string[]>
  /** Masked key state for every provider (built-ins + customs); keyLast4 only, never the key itself. */
  providerKeys: Record<string, { hasKey: boolean; keyLast4: string }>
  appearance: Appearance
  locale: Locale
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

export interface SetLocalePayload {
  locale: string
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

export interface WorkspaceListFilesPayload {
  sessionId?: string
  prefix?: string
  limit?: number
}

export interface WorkspaceFileEntry {
  relativePath: string
  isDir: boolean
}

export interface WorkspaceListFilesResult {
  files: WorkspaceFileEntry[]
  truncated: boolean
}

const agento = {
  chat: {
    send: (payload: ChatSendPayload): Promise<void> => ipcRenderer.invoke('chat:send', payload),
    stop: (payload: ChatStopPayload): Promise<void> => ipcRenderer.invoke('chat:stop', payload),
    onPart: (listener: (event: ChatPartEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, partEvent: ChatPartEvent): void =>
        listener(partEvent)
      ipcRenderer.on('chat:part', handler)
      return () => {
        ipcRenderer.removeListener('chat:part', handler)
      }
    }
  },
  tool: {
    answer: (payload: ToolAnswerPayload): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('tool:answer', payload)
  },
  plan: {
    start: (payload?: {
      approved?: boolean
      sessionId?: string
      runId?: string
    }): Promise<PlanStartResult> => ipcRenderer.invoke('plan:start', payload ?? {})
  },
  approval: {
    respond: (payload: ApprovalRespondPayload): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('approval:respond', payload)
  },
  changes: {
    list: (payload: { sessionId: string }): Promise<ChangesListResult> =>
      ipcRenderer.invoke('changes:list', payload),
    undo: (payload: { checkpointId: string }): Promise<ChangesUndoResult> =>
      ipcRenderer.invoke('changes:undo', payload),
    undoAll: (payload: { sessionId: string }): Promise<ChangesUndoResult> =>
      ipcRenderer.invoke('changes:undo-all', payload)
  },
  sidecar: {
    getStatus: (): Promise<SidecarStatusEvent> => ipcRenderer.invoke('sidecar:get-status'),
    onStatus: (listener: (event: SidecarStatusEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, statusEvent: SidecarStatusEvent): void =>
        listener(statusEvent)
      ipcRenderer.on('sidecar:status', handler)
      return () => {
        ipcRenderer.removeListener('sidecar:status', handler)
      }
    }
  },
  agent: {
    onEvent: (listener: (event: AgentEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, agentEvent: AgentEvent): void =>
        listener(agentEvent)
      ipcRenderer.on('agent:event', handler)
      return () => {
        ipcRenderer.removeListener('agent:event', handler)
      }
    }
  },
  sessions: {
    create: (payload: CreateSessionPayload): Promise<SessionInfo> =>
      ipcRenderer.invoke('session:create', payload),
    list: (): Promise<SessionInfo[]> => ipcRenderer.invoke('session:list'),
    messages: (payload: SessionMessagesPayload): Promise<UIMessage[]> =>
      ipcRenderer.invoke('session:messages', payload),
    setMode: (payload: { sessionId: string; mode: SessionMode }): Promise<SessionInfo> =>
      ipcRenderer.invoke('session:set-mode', payload),
    rename: (payload: { sessionId: string; title: string }): Promise<SessionInfo> =>
      ipcRenderer.invoke('session:rename', payload),
    delete: (payload: SessionMessagesPayload): Promise<{ deleted: boolean }> =>
      ipcRenderer.invoke('session:delete', payload),
    plan: (payload: SessionMessagesPayload): Promise<AgentPlanStep[]> =>
      ipcRenderer.invoke('session:plan', payload)
  },
  workspaces: {
    get: (): Promise<WorkspaceSnapshotPayload> => ipcRenderer.invoke('workspace:get'),
    list: (): Promise<WorkspaceRecent[]> => ipcRenderer.invoke('workspace:list'),
    /** Native folder dialog in main; resolves null when the user cancels. */
    pick: (): Promise<{ path: string } | null> => ipcRenderer.invoke('workspace:pick'),
    /** Re-apply a path from our own recents list. */
    set: (payload: WorkspaceSetPayload): Promise<{ path: string }> =>
      ipcRenderer.invoke('workspace:set', payload),
    /** Sandboxed workspace-relative file enumeration for the composer picker. */
    listFiles: (payload?: WorkspaceListFilesPayload): Promise<WorkspaceListFilesResult> =>
      ipcRenderer.invoke('workspace:list-files', payload ?? {})
  },
  settings: {
    get: (): Promise<SettingsSnapshot> => ipcRenderer.invoke('settings:get'),
    setApiKey: (payload: SetApiKeyPayload): Promise<void> =>
      ipcRenderer.invoke('settings:set-api-key', payload),
    setModel: (payload: SetModelPayload): Promise<void> =>
      ipcRenderer.invoke('settings:set-model', payload),
    setProvider: (payload: SetProviderPayload): Promise<void> =>
      ipcRenderer.invoke('settings:set-provider', payload),
    clearApiKey: (payload: ClearApiKeyPayload): Promise<void> =>
      ipcRenderer.invoke('settings:clear-api-key', payload),
    setAppearance: (payload: SetAppearancePayload): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke('settings:set-appearance', payload),
    setLocale: (payload: SetLocalePayload): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke('settings:set-locale', payload),
    setPermissionDefaults: (payload: SetPermissionDefaultsPayload): Promise<PermissionDefaults> =>
      ipcRenderer.invoke('settings:set-permission-defaults', payload),
    createCustomProvider: (payload: CreateCustomProviderPayload): Promise<{ id: string }> =>
      ipcRenderer.invoke('settings:create-custom-provider', payload),
    updateCustomProvider: (payload: UpdateCustomProviderPayload): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke('settings:update-custom-provider', payload),
    deleteCustomProvider: (payload: DeleteCustomProviderPayload): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke('settings:delete-custom-provider', payload),
    testProvider: (payload: TestProviderPayload): Promise<TestProviderResult> =>
      ipcRenderer.invoke('settings:test-provider', payload),
    getDataSummary: (): Promise<DataSummary> => ipcRenderer.invoke('settings:get-data-summary'),
    openDataFolder: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('settings:open-data-folder'),
    clearSessions: (): Promise<{ sessions: number }> =>
      ipcRenderer.invoke('settings:clear-sessions'),
    purgeSnapshots: (): Promise<{ checkpoints: number }> =>
      ipcRenderer.invoke('settings:purge-snapshots'),
    exportEval: (): Promise<{ fileName: string; sessionCount: number }> =>
      ipcRenderer.invoke('settings:export-eval')
  },
  system: {
    /** Open a workspace file with the OS default app (MVP semantic-search
     * card) — main resolves the path against the current workspace and runs
     * the sandbox containment check; nothing outside the workspace opens. */
    openPath: (payload: SystemOpenPathPayload): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('system:open-path', payload)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('agento', agento)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.agento = agento
}
