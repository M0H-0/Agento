import type { ChatTransport, TextUIPart, UIMessage, UIMessageChunk } from 'ai'

// Structural mirror of SessionInfo in src/preload/index.d.ts — the renderer
// consumes window.agento typed globally and doesn't import preload.
export interface SessionSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

// Sidebar titles come from the first user message, truncated to one line.
const TITLE_MAX_LENGTH = 60

function deriveTitle(messages: UIMessage[]): string | undefined {
  const firstUser = messages.find((message) => message.role === 'user')
  if (!firstUser) return undefined
  const text = firstUser.parts
    .filter((part): part is TextUIPart => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH)}…` : text
}

// Per-view transport (docs/02 §2.1): every UIMessageChunk main emits is
// enqueued exactly as received over the preload bridge — the only
// transformation between main and useChat is Electron's structured clone, so
// the Thread renders exactly what main emitted.
//
// Session identity (M1.3): each send reads the active session id from the
// hook; a fresh "New chat" has none, so the first send creates the session
// (session:create) and reports it back via onSessionCreated. Parts are
// filtered against the id captured for THIS send, so a stream can never leak
// into a different session's view. Abort plumbing is deferred to M1.4;
// sendMessages resolves once main has finished forwarding the whole stream.
export interface IpcChatTransportHooks {
  getSessionId: () => string | null
  onSessionCreated?: (session: SessionSummary) => void
  onSettled?: () => void
}

export function createIpcChatTransport(hooks: IpcChatTransportHooks): ChatTransport<UIMessage> {
  return {
    sendMessages: ({ messages }) =>
      Promise.resolve(
        new ReadableStream<UIMessageChunk>({
          async start(controller) {
            let sessionId: string | null = null
            let closed = false
            let receivedAny = false
            let unsubscribe: (() => void) | null = null
            try {
              sessionId = hooks.getSessionId()
              if (!sessionId) {
                // Lazy session creation: a "New chat" only becomes a row once
                // the first message is actually sent, so empty sessions never
                // reach the sidebar.
                const session = await window.agento.sessions.create({
                  title: deriveTitle(messages)
                })
                sessionId = session.id
                hooks.onSessionCreated?.(session)
              }
              const activeSessionId = sessionId
              const finish = (): void => {
                if (closed) return
                closed = true
                unsubscribe?.()
                controller.close()
              }
              unsubscribe = window.agento.chat.onPart((event) => {
                if (closed || event.sessionId !== activeSessionId) return
                receivedAny = true
                controller.enqueue(event.part)
                // The wire itself decides when the run is over. The invoke's
                // resolution is only an acceptance ack: its reply can overtake
                // the trailing 'chat:part' events on the IPC channel (observed
                // in M1.3 — the ack raced ahead of the last text-delta and
                // close() dropped it), so the invoke must never close the
                // controller. Main always ends a stream with 'finish' (normal
                // loop) or an 'error' part (short-circuits and catch-all), so
                // these two parts are the complete set of end-of-stream
                // signals; anything after the first one (e.g. a persistence
                // failure surfacing after 'finish') is dropped here.
                if (event.part.type === 'finish' || event.part.type === 'error') {
                  finish()
                }
              })
              await window.agento.chat.send({ sessionId: activeSessionId, messages })
              // send() resolved. If the stream already saw its end part the
              // controller is closed; the only remaining case is main
              // returning without forwarding anything (no known path, closed
              // defensively so useChat can never hang on an empty stream).
              if (!receivedAny) {
                finish()
              }
            } catch (error) {
              try {
                if (!closed) {
                  closed = true
                  unsubscribe?.()
                  controller.error(error)
                }
              } catch {
                // controller already closed by the end part — the error is
                // moot; the renderer already rendered the full stream.
              }
            } finally {
              hooks.onSettled?.()
            }
          }
        })
      ),
    // Nothing to reconnect to locally; resume arrives with M1.4/M2.x if ever.
    reconnectToStream: async () => null
  }
}
