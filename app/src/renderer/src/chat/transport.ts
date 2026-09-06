import type { ChatTransport, TextUIPart, UIMessage, UIMessageChunk } from 'ai'

// Structural mirror of SessionInfo in src/preload/index.d.ts — the renderer
// consumes window.agento typed globally and doesn't import preload.
export interface SessionSummary {
  id: string
  title: string
  /** Workspace the session was created under — '' placeholder until M2.2's picker stamps it. */
  workspacePath: string
  createdAt: string
  updatedAt: string
  /** Token totals from usage_events; null until the first settled run. */
  usage: { inputTokens: number; outputTokens: number } | null
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
// into a different session's view.
//
// Stop (M1.4): an AbortSignal cannot cross IPC, so the abort listener on the
// send's own signal turns into a 'chat:stop' invoke for THIS session; main
// aborts its streamText, persists the partial reply, and ends the stream with
// the native v5 { type: 'abort' } chunk — one of the three terminals
// (finish | error | abort) this transport closes on. A second send while a
// run is active is rejected here rather than interleaved into the stream
// (useChat's sendMessage has no running guard of its own), and a lazy
// session:create is shared between racing sends so a fast double-send on a
// new chat makes exactly one row.
export interface IpcChatTransportHooks {
  getSessionId: () => string | null
  onSessionCreated?: (session: SessionSummary) => void
  onSettled?: () => void
}

export interface IpcChatTransport {
  transport: ChatTransport<UIMessage>
  dispose: () => void
}

// Honest second-send copy (docs/04 §6): a conversation error card, not a
// console error, and never a second interleaved stream.
const SECOND_SEND_COPY =
  'A reply is already streaming in this conversation. Stop it first or wait for it to finish.'

export function createIpcChatTransport(hooks: IpcChatTransportHooks): IpcChatTransport {
  // Per-view run state — one transport instance per ChatView mount (App.tsx
  // keys remounts by thread epoch). runActive is the in-flight guard; the
  // composer's send-disabled state mirrors it through the library's thread
  // isRunning (both track the same stream lifecycle).
  let runActive = false
  let activeRunSessionId: string | null = null
  let createPromise: Promise<SessionSummary> | null = null
  let unsubscribeRun: (() => void) | null = null
  let disposed = false

  const stopActiveRun = (): void => {
    if (activeRunSessionId) {
      window.agento.chat.stop({ sessionId: activeRunSessionId }).catch(() => {})
    }
  }

  return {
    transport: {
      sendMessages: ({ messages, abortSignal }) => {
        if (disposed || runActive) {
          return Promise.reject(new Error(SECOND_SEND_COPY))
        }
        runActive = true
        let closed = false
        let activeSessionId: string | null = null
        let receivedAny = false
        let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null
        const onAbort = (): void => {
          // Stop control / Esc: abort THIS session's run main-side. The
          // native { type: 'abort' } part main sends back is this stream's
          // terminal — do not close or unsubscribe here.
          stopActiveRun()
        }
        const cleanup = (): void => {
          closed = true
          if (unsubscribeRun) {
            unsubscribeRun()
            unsubscribeRun = null
          }
          abortSignal?.removeEventListener('abort', onAbort)
          if (activeRunSessionId !== null && activeRunSessionId === activeSessionId) {
            activeRunSessionId = null
          }
          activeSessionId = null
          runActive = false
        }
        const closeStream = (): void => {
          if (closed) return
          cleanup()
          // The consumer may have cancelled the stream already (useChat's own
          // abort path) — closing then throws, which is fine.
          try {
            controller?.close()
          } catch {
            // already closed by the consumer
          }
        }

        return Promise.resolve(
          new ReadableStream<UIMessageChunk>({
            async start(streamController) {
              controller = streamController
              try {
                let sessionId = hooks.getSessionId()
                if (!sessionId) {
                  // Lazy session creation: a "New chat" only becomes a row once
                  // the first message is actually sent, so empty sessions never
                  // reach the sidebar. The in-flight create is shared, so two
                  // racing sends cannot make two rows.
                  createPromise ??= window.agento.sessions.create({ title: deriveTitle(messages) })
                  const session = await createPromise
                  if (closed || disposed) return // abandoned mid-create; keep the promise for reuse
                  createPromise = null
                  sessionId = session.id
                  hooks.onSessionCreated?.(session)
                }
                if (closed || disposed) return
                activeSessionId = sessionId
                activeRunSessionId = sessionId
                abortSignal?.addEventListener('abort', onAbort, { once: true })
                unsubscribeRun = window.agento.chat.onPart((event) => {
                  if (closed || event.sessionId !== activeSessionId) return
                  receivedAny = true
                  try {
                    controller?.enqueue(event.part)
                  } catch {
                    // Consumer cancelled the stream — cancel() already cleaned
                    // up; late parts are dropped.
                    return
                  }
                  // The wire itself decides when the run is over. The invoke's
                  // resolution is only an acceptance ack: its reply can overtake
                  // the trailing 'chat:part' events on the IPC channel (observed
                  // in M1.3), so the invoke must never close the controller.
                  // Main ends every run with exactly one terminal part —
                  // 'finish' (natural), 'error' (provider or persistence
                  // failure), or 'abort' (user stop) — and these are the
                  // complete set of end-of-stream signals.
                  if (
                    event.part.type === 'finish' ||
                    event.part.type === 'error' ||
                    event.part.type === 'abort'
                  ) {
                    closeStream()
                  }
                })
                await window.agento.chat.send({ sessionId: activeSessionId, messages })
                // send() resolved. If the stream already saw its end part the
                // controller is closed; the only remaining case is main
                // returning without forwarding anything (no known path, closed
                // defensively so useChat can never hang on an empty stream).
                if (!receivedAny && !closed) closeStream()
              } catch (error) {
                if (closed || disposed) return // already settled — the error is moot
                createPromise = null // a failed create must be retryable
                cleanup()
                try {
                  controller?.error(error)
                } catch {
                  // controller already closed by an end part
                }
              } finally {
                hooks.onSettled?.()
              }
            },
            // useChat can cancel the stream itself when a run is stopped —
            // free the per-view run state either way.
            cancel(): void {
              cleanup()
            }
          })
        )
      },
      // Nothing to reconnect to locally; resume arrives with M2.x if ever.
      reconnectToStream: async () => null
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      // Session switch / unmount mid-stream: abort the run this view owns
      // (main persists its partial reply) and drop the part subscription —
      // no orphan listeners buffering into an abandoned stream.
      if (runActive) stopActiveRun()
      if (unsubscribeRun) {
        unsubscribeRun()
        unsubscribeRun = null
      }
    }
  }
}
