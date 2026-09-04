import { randomUUID } from 'node:crypto'
import type { TextUIPart, UIMessage, UIMessageChunk } from 'ai'

// Builds the assistant UIMessage out of the very chunks the chat pipeline
// forwards (docs/02 §2.1), so what gets persisted is exactly what the renderer
// streamed. M1.3 accumulates text parts only; reasoning/tool parts arrive
// with M2.x and are ignored here until then.
//
// Structured for M1.4 (stop button): toUIMessage() is a cheap snapshot that
// is valid mid-stream, so an aborted run can persist the partial reply; the
// id is fixed at construction so a persisted partial can be recognized later.
export class AssistantMessageAccumulator {
  readonly id = randomUUID()

  private parts: TextUIPart[] = []
  private readonly open = new Map<string, TextUIPart>()
  private failed = false

  addChunk(part: UIMessageChunk): void {
    if (this.failed) return
    switch (part.type) {
      case 'text-start': {
        const textPart: TextUIPart = { type: 'text', text: '' }
        this.parts.push(textPart)
        this.open.set(part.id, textPart)
        break
      }
      case 'text-delta': {
        const textPart = this.open.get(part.id)
        if (textPart) textPart.text += part.delta
        break
      }
      case 'text-end':
        this.open.delete(part.id)
        break
      case 'error':
        // A failed stream persists nothing assistant-side (M1.3 Devlog):
        // accumulation stops, the error part still goes to the renderer.
        this.failed = true
        break
      default:
        // start / start-step / finish-step / finish / abort / … carry no
        // message content.
        break
    }
  }

  isFailed(): boolean {
    return this.failed
  }

  // Non-null only when the stream produced text and did not end in an error
  // part. Empty (zero-length) text parts are dropped so a persisted message
  // never carries blank placeholders.
  toUIMessage(): UIMessage | null {
    if (this.failed) return null
    const parts = this.parts.filter((part) => part.text.length > 0)
    if (parts.length === 0) return null
    return { id: this.id, role: 'assistant', parts }
  }
}
