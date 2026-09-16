import { randomUUID } from 'node:crypto'
import type { TextUIPart, UIMessage, UIMessageChunk } from 'ai'

// Builds the assistant UIMessage out of the very chunks the chat pipeline
// forwards (docs/02 §2.1), so what gets persisted is exactly what the renderer
// streamed.
//
// S5-001: text AND tool-call parts persist. The accumulator used to keep text
// only, so a reopened session rendered assistant prose with zero tool cards
// (the Changes panel was unaffected — reversibility never depended on this).
// Persisted tool parts use the AI SDK v5 `tool-${name}` message shape
// (input-available → output-available/output-error by toolCallId), exactly
// what the renderer's tool-UI adapter reads live — history renders the same
// cards as the live run. Reasoning parts still never persist (providers
// reject them on replay), and `emit_plan` parts still never persist (the
// PlanPanel owns the plan; plan_steps rows are restored separately).
//
// Structured for M1.4 (stop button): toUIMessage() is a cheap snapshot that
// is valid mid-stream, so an aborted run can persist the partial reply; the
// id is fixed at construction so a persisted partial can be recognized later.
//
// M3.1: moved from src/main/ipc/ into the agent tree — the extracted
// plan-run loop (plan-run.ts) owns the stream forwarding + accumulation now,
// and src/main/agent/ must not import from ipc/ (it stays plain Node,
// AGENTS.md rule 1); the accumulation logic is loop logic.

export interface AccumulatedToolPart {
  type: `tool-${string}`
  toolCallId: string
  state: 'input-available' | 'output-available' | 'output-error'
  input: unknown
  output?: unknown
  errorText?: string
}

export class AssistantMessageAccumulator {
  readonly id = randomUUID()

  private parts: (TextUIPart | AccumulatedToolPart)[] = []
  private readonly open = new Map<string, TextUIPart>()
  private readonly tools = new Map<string, AccumulatedToolPart>()
  private readonly suppressedToolCalls = new Set<string>()
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
      case 'tool-input-available': {
        // The plan is the PlanPanel's surface, never a thread card.
        if (part.toolName === 'emit_plan') {
          this.suppressedToolCalls.add(part.toolCallId)
          break
        }
        const toolPart: AccumulatedToolPart = {
          type: `tool-${part.toolName}`,
          toolCallId: part.toolCallId,
          state: 'input-available',
          input: part.input
        }
        this.parts.push(toolPart)
        this.tools.set(part.toolCallId, toolPart)
        break
      }
      case 'tool-input-error': {
        if (part.toolName === 'emit_plan') {
          this.suppressedToolCalls.add(part.toolCallId)
          break
        }
        const toolPart: AccumulatedToolPart = {
          type: `tool-${part.toolName}`,
          toolCallId: part.toolCallId,
          state: 'output-error',
          input: part.input,
          errorText: part.errorText
        }
        this.parts.push(toolPart)
        this.tools.set(part.toolCallId, toolPart)
        break
      }
      case 'tool-output-available': {
        if (part.preliminary === true) break
        if (this.suppressedToolCalls.has(part.toolCallId)) {
          this.suppressedToolCalls.delete(part.toolCallId)
          break
        }
        const toolPart = this.tools.get(part.toolCallId)
        if (toolPart) {
          toolPart.state = 'output-available'
          toolPart.output = part.output
        }
        break
      }
      case 'tool-output-error': {
        if (this.suppressedToolCalls.has(part.toolCallId)) {
          this.suppressedToolCalls.delete(part.toolCallId)
          break
        }
        const toolPart = this.tools.get(part.toolCallId)
        if (toolPart) {
          toolPart.state = 'output-error'
          toolPart.errorText = part.errorText
        }
        break
      }
      case 'error':
        // A failed stream persists nothing assistant-side (M1.3 Devlog):
        // accumulation stops, the error part still goes to the renderer.
        this.failed = true
        break
      default:
        // start / start-step / finish-step / finish / abort / reasoning /
        // deltas / sources / files carry no persisted message content.
        break
    }
  }

  isFailed(): boolean {
    return this.failed
  }

  /** True when at least one non-empty text part accumulated (Phase-1 item 1
   * Act fallback: tools ran but the model wrote no closing prose — tool
   * parts alone must NOT count as prose). */
  hasText(): boolean {
    return this.parts.some((part) => part.type === 'text' && part.text.length > 0)
  }

  // Non-null when the stream produced text or tool calls and did not end in
  // an error part. Empty (zero-length) text parts are dropped so a persisted
  // message never carries blank placeholders; input-only tool parts (run
  // stopped mid-call) persist as-is so history shows what started.
  toUIMessage(): UIMessage | null {
    if (this.failed) return null
    const parts = this.parts.filter(
      (part) => part.type !== 'text' || (part as TextUIPart).text.length > 0
    )
    if (parts.length === 0) return null
    return { id: this.id, role: 'assistant', parts: parts as UIMessage['parts'] }
  }
}
