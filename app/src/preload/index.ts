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

export interface SessionInfo {
  id: string
  title: string
  /** The workspace this session was created under ('' — empty placeholder — until M2.2 picks one; docs/03 §8). */
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

export type AgentEvent = AgentUsageEvent

// Sidecar status contract per docs/03 §4: app-level push + pull, deliberately
// not a session-scoped 'agent:event' (no sessionId/runId exists for it).
export interface SidecarStatusEvent {
  status: 'starting' | 'healthy' | 'unhealthy'
  detail?: string
}

// Settings contract per docs/03 §4 + docs/06 §7: plain invokes. Key material
// travels renderer → main only; the snapshot never contains the key — hasKey
// and keyLast4 at most.
export interface SettingsSnapshot {
  provider: string
  model: string
  hasKey: boolean
  keyLast4: string
  storageAvailable: boolean
  /** Provider ids enabled this phase — main is the source of truth. */
  providers: string[]
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
      ipcRenderer.invoke('session:messages', payload)
  },
  workspaces: {
    get: (): Promise<WorkspaceSnapshotPayload> => ipcRenderer.invoke('workspace:get'),
    list: (): Promise<WorkspaceRecent[]> => ipcRenderer.invoke('workspace:list'),
    /** Native folder dialog in main; resolves null when the user cancels. */
    pick: (): Promise<{ path: string } | null> => ipcRenderer.invoke('workspace:pick'),
    /** Re-apply a path from our own recents list. */
    set: (payload: WorkspaceSetPayload): Promise<{ path: string }> =>
      ipcRenderer.invoke('workspace:set', payload)
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
      ipcRenderer.invoke('settings:clear-api-key', payload)
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
