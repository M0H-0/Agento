import type { UIMessage } from 'ai'

// ask_user's two wire shapes (docs/03 §7): the synthetic pause chunk's output
// carries __agentoAskUser and means the run is paused on this question; the
// answer chunk's output is { question, answer } and means it resolved. The
// AskUserCard pattern-matches the same field for its display state.

export interface AskAwaitingOutput {
  __agentoAskUser: true
  toolCallId: string
  question: string
  options?: string[]
}

// The live question the composer's reply mode answers.
export interface PendingAsk {
  toolCallId: string
  question: string
  options?: string[]
}

export function isAwaitingAskOutput(value: unknown): value is AskAwaitingOutput {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as {
    __agentoAskUser?: unknown
    toolCallId?: unknown
    question?: unknown
  }
  return (
    candidate.__agentoAskUser === true &&
    typeof candidate.toolCallId === 'string' &&
    typeof candidate.question === 'string'
  )
}

// The newest tool part still carrying the awaiting marker. The answer chunk
// overwrites the same part's output, so a resolved ask drops out on its own —
// no extra bookkeeping for reply mode to end.
export function findPendingAsk(messages: UIMessage[]): PendingAsk | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m].parts
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p]
      if (!part.type.startsWith('tool-')) continue
      if ((part as { state?: unknown }).state !== 'output-available') continue
      const output = (part as { output?: unknown }).output
      if (!isAwaitingAskOutput(output)) continue
      const options = Array.isArray(output.options)
        ? output.options.filter((option): option is string => typeof option === 'string')
        : undefined
      return options && options.length > 0
        ? { toolCallId: output.toolCallId, question: output.question, options }
        : { toolCallId: output.toolCallId, question: output.question }
    }
  }
  return null
}

// Some models echo ask_user's tool-call arguments as visible text before (or
// alongside) the real tool call — e.g. `{ "question": "…", "options": null }`.
// The thread never shows raw tool JSON (docs/04 plain-language rule), so a
// leading JSON object shaped like ask_user's arguments is stripped for
// display only; persistence is untouched.
export function stripAskUserJsonEcho(text: string): string {
  const start = text.indexOf('{')
  if (start === -1) return text
  // Find the matching close brace, skipping string literals and escapes.
  let inString = false
  let escaped = false
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        let parsed: unknown
        try {
          parsed = JSON.parse(text.slice(start, i + 1))
        } catch {
          return text
        }
        if (typeof parsed !== 'object' || parsed === null) return text
        const obj = parsed as Record<string, unknown>
        const keys = Object.keys(obj)
        if (typeof obj.question !== 'string') return text
        if (!keys.every((k) => k === 'question' || k === 'options')) return text
        return (text.slice(0, start) + text.slice(i + 1)).replace(/^\s+/, '')
      }
    }
  }
  return text
}
