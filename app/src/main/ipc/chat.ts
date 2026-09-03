import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { UIMessage, UIMessageChunk } from 'ai'

// Hardcoded placeholder until M1.3 introduces real sessions; carried in the
// 'chat:part' envelope so the renderer can filter by session from day one.
const SESSION_ID = 'session-placeholder'
// Pacing between forwarded parts so the stream paints progressively.
const PART_INTERVAL_MS = 50
const TEXT_PART_ID = 'canned-text'

interface ChatSendPayload {
  messages: UIMessage[]
}

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    return message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join(' ')
      .trim()
  }
  return ''
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Canned echo: main emits a faithful ai-v5 UI message stream (no model call,
// no network) and forwards every part verbatim over IPC (docs/02 §2.1).
// Replaced by streamText + toUIMessageStream() in M1.2.
export function registerChatIpc(): void {
  ipcMain.handle('chat:send', async (event: IpcMainInvokeEvent, payload: ChatSendPayload) => {
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const said = lastUserText(messages)
    const reply = said
      ? `You said: “${said}” — echoed by the main process over the real IPC transport as a canned UI message stream. No model involved yet.`
      : 'I did not catch any text in that message, but this reply was emitted by the main process over the real IPC transport. No model involved yet.'

    const words = reply.split(' ')
    const parts: UIMessageChunk[] = [
      { type: 'start', messageId: `assistant-${crypto.randomUUID()}` },
      { type: 'start-step' },
      { type: 'text-start', id: TEXT_PART_ID },
      ...words.map((word, index) => ({
        type: 'text-delta' as const,
        id: TEXT_PART_ID,
        delta: index === 0 ? word : ` ${word}`
      })),
      { type: 'text-end', id: TEXT_PART_ID },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' }
    ]

    for (const part of parts) {
      await delay(PART_INTERVAL_MS)
      event.sender.send('chat:part', { sessionId: SESSION_ID, part })
    }
  })
}
