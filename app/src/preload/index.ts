import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { UIMessage, UIMessageChunk } from 'ai'

// Typed API exposed to the renderer — the ONLY bridge surface. The renderer
// never touches ipcRenderer directly. Chat transport contract per docs/02 §2.1:
// 'chat:send' invoke + 'chat:part' stream-part events, parts forwarded verbatim.
export interface ChatSendPayload {
  messages: UIMessage[]
}

export interface ChatPartEvent {
  sessionId: string
  part: UIMessageChunk
}

const agento = {
  chat: {
    send: (payload: ChatSendPayload): Promise<void> => ipcRenderer.invoke('chat:send', payload),
    onPart: (listener: (event: ChatPartEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, partEvent: ChatPartEvent): void =>
        listener(partEvent)
      ipcRenderer.on('chat:part', handler)
      return () => {
        ipcRenderer.removeListener('chat:part', handler)
      }
    }
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
