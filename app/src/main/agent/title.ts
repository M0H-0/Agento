// Chat title generation (docs/03 §4): the first user message becomes a real
// topic title via one cheap LLM call, answered in the message's own language.
// Pure Node — the completion is injected (same ctx.llm-style shape the tools
// use), so this module stays Electron-free (AGENTS.md) and vitest can drive
// it with fakes.

/** Input budget for the title prompt — a title needs the topic, not the whole message. */
export const TITLE_MAX_INPUT_CHARS = 500

/** Same display cap the renderer's derived fallback title uses (transport.ts). */
export const TITLE_MAX_LENGTH = 60

export function buildTitlePrompt(firstMessage: string): string {
  const clipped = firstMessage.slice(0, TITLE_MAX_INPUT_CHARS)
  return [
    'Write a short title for a conversation that starts with the user message below.',
    'Capture what it is about in 2 to 6 words.',
    'Write the title in the SAME language as the user message.',
    'Reply with the title text only — no quotes, no labels like "Title:", no trailing punctuation, no emojis.',
    '',
    `User message: ${clipped}`
  ].join('\n')
}

// Models wrap titles in quotes or add a label; users type in any language.
// Clean to one plain line, then cap. Emoji codepoints are stripped here, not
// just banned in the prompt — the sidebar renders this text everywhere.
// Anything empty after cleaning falls back to the derived first-message
// title already on the session row.
export function sanitizeTitle(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(
      // Emoji ban: pictographs plus the pieces that compose them (skin-tone
      // and regional-indicator modifiers, ZWJ, variation selector) — leftover
      // fragments must not survive even when the model sends a bare modifier.
      // ZWJ/VS16 sit in an alternation, not the class: they only ever match
      // one code point, which no-misleading-character-class rightly calls out.
      /(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]|\u200D|\uFE0F)/gu,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^title\s*[:：]\s*/i, '')
    .replace(/^["'“”«»`]+|["'“”«»`]+$/g, '')
    .replace(/[.。!！?？]$/, '')
    .trim()
  if (!cleaned) return fallback
  return cleaned.length > TITLE_MAX_LENGTH ? `${cleaned.slice(0, TITLE_MAX_LENGTH)}…` : cleaned
}

export interface GenerateSessionTitleInput {
  complete: (prompt: string) => Promise<string>
  firstMessage: string
  fallback: string
}

// One shot: prompt → complete → sanitize. A completer failure propagates to
// the caller (chat.ts logs it and the session keeps its fallback title).
export async function generateSessionTitle(input: GenerateSessionTitleInput): Promise<string> {
  const raw = await input.complete(buildTitlePrompt(input.firstMessage))
  return sanitizeTitle(raw, input.fallback)
}
