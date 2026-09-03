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

export interface AgentoAPI {
  chat: AgentoChat
}

declare global {
  interface Window {
    agento: AgentoAPI
  }
}
