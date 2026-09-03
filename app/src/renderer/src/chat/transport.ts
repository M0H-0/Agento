import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

// Must match the placeholder in src/main/ipc/chat.ts until M1.3 introduces
// real sessions.
const SESSION_ID = 'session-placeholder'

// Custom IPC ChatTransport (docs/02 §2.1): every UIMessageChunk main emits is
// enqueued exactly as received over the preload bridge — the only
// transformation between main and useChat is Electron's structured clone, so
// the Thread renders exactly what main emitted.
// Abort plumbing is deferred to M1.4; sendMessages resolves once main has
// finished forwarding the whole stream.
export const ipcChatTransport: ChatTransport<UIMessage> = {
  sendMessages: ({ messages }) =>
    Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        async start(controller) {
          let closed = false
          const unsubscribe = window.agento.chat.onPart((event) => {
            if (event.sessionId !== SESSION_ID || closed) return
            controller.enqueue(event.part)
          })
          try {
            await window.agento.chat.send({ messages })
            closed = true
            controller.close()
          } catch (error) {
            closed = true
            controller.error(error)
          } finally {
            unsubscribe()
          }
        }
      })
    ),
  // Nothing to reconnect to locally; persisted sessions arrive in M1.3.
  reconnectToStream: async () => null
}
