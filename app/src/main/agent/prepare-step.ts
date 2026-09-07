import type { ModelMessage } from 'ai'

// Intra-turn reasoning strip (M2.4 live-gate finding): replayable() in the
// IPC layer only cleans the INITIAL history, but every step after the first
// resends the previous step's assistant message — reasoning parts included —
// and the OpenAI-compatible provider maps those to `reasoning_content`,
// which Groq rejects with a 400. So any multi-step tool turn whose first
// step contains reasoning dies on step 2. The loop's prepareStep runs this
// before EVERY step with the about-to-send ModelMessages; dropping assistant
// `reasoning` parts keeps every provider request Groq-clean. Uniform across
// providers (Google would accept thinking, but one code path beats a
// per-vendor fork — docs/03 §10 provider-neutrality).
//
// Plain Node, no Electron imports (AGENTS.md rule 1) — unit-tested here,
// consumed by src/main/ipc/chat.ts.
export function stripStepReasoning(messages: Array<ModelMessage>): Array<ModelMessage> {
  return messages.map((message) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return message
    return {
      ...message,
      content: message.content.filter((part) => part.type !== 'reasoning')
    }
  })
}
