// Reasoning-tag strip (demo-breaker fix): thinking models on
// OpenAI-compatible providers (Ollama gpt-oss) emit raw `<think>…</think>`
// deliberation inside TEXT deltas instead of native `reasoning` parts. That
// raw text used to stream straight into the chat bubble — English
// deliberation naming internal tools (e.g. emit_plan) in the user's thread,
// against the product rule that replies never leak tool names or internal
// text. Strip it main-side at every stream handoff (plan attempts, discovery,
// live execution) so neither the thread nor persistence ever sees it.
//
// Pure, Electron-free (agent-tree rule): one instance per run, fed deltas in
// order. Tags split across deltas are handled — a trailing `<…` fragment is
// held until the next push resolves it; `flush()` releases a held fragment
// as normal text at stream end (a lone `<` is content, not a tag).

import type { UIMessageChunk } from 'ai'

const MAX_TAG_LEN = 24

function isOpenTag(tag: string): boolean {
  return /^<\s*think(?:ing)?(\s[^<>]*)?>$/i.test(tag)
}

/**
 * A `<…` fragment that could still grow into a think tag (split deltas).
 * Deliberately narrow — only `<` + optional `/` + whitespace + a prefix of
 * `think`/`thinking` (or a full `think…` word with attributes in flight).
 * Normal prose (`< b`, `<3`, `<div>`) fails immediately so it is never held
 * back waiting for the next delta.
 */
function isTagPrefix(fragment: string): boolean {
  if (fragment.length >= MAX_TAG_LEN || !fragment.startsWith('<')) return false
  const rest = fragment.slice(1).replace(/^\s+/, '')
  const word = rest.startsWith('/') ? rest.slice(1).replace(/^\s+/, '') : rest
  if (/^[a-z]*$/i.test(word)) {
    const lower = word.toLowerCase()
    return 'think'.startsWith(lower) || 'thinking'.startsWith(lower)
  }
  return /^think(?:ing)?[^<>]*$/i.test(word)
}

export interface ThinkStripper {
  /** Visible text from this delta (possibly empty — caller drops empties). */
  push(delta: string): string
  /** Release any held fragment at stream end. */
  flush(): string
}

export function createThinkStripper(): ThinkStripper {
  let inThink = false
  let pending = ''

  return {
    push(delta: string): string {
      let out = ''
      const text = pending + delta
      pending = ''
      let i = 0
      while (i < text.length) {
        if (!inThink) {
          if (text[i] !== '<') {
            out += text[i]
            i += 1
            continue
          }
          const rest = text.slice(i)
          const full = rest.match(/^<\/?\s*think(?:ing)?(\s[^<>]*)?>/i)?.[0]
          if (full !== undefined) {
            // Open tag enters thinking; a stray close is dropped too — tags
            // themselves must never render.
            if (isOpenTag(full)) inThink = true
            i += full.length
            continue
          }
          if (isTagPrefix(rest)) {
            pending = rest
            break
          }
          out += '<'
          i += 1
        } else {
          if (text[i] !== '<') {
            i += 1
            continue
          }
          const rest = text.slice(i)
          const close = rest.match(/^<\s*\/\s*think(?:ing)?\s*>/i)?.[0]
          if (close !== undefined) {
            inThink = false
            i += close.length
            continue
          }
          if (isTagPrefix(rest)) {
            pending = rest
            break
          }
          // A `<…>` inside thinking that is not the close tag is deliberation
          // content — discard it either way.
          i += 1
        }
      }
      return out
    },

    flush(): string {
      // Unclosed thinking is discarded; a held normal-text fragment is real
      // content (e.g. a trailing `<` the user typed about).
      if (inThink) {
        pending = ''
        return ''
      }
      const tail = pending
      pending = ''
      return tail
    }
  }
}

/** Complete-string path (tests, non-streamed synthesis). */
export function stripThinkTags(text: string): string {
  const stripper = createThinkStripper()
  return stripper.push(text) + stripper.flush()
}

/**
 * Stream-end remainder as a self-contained text sequence (start/delta/end),
 * or null when there is nothing to release. A response whose visible text
 * ends in a tag-looking fragment (e.g. a trailing `<`) holds that fragment
 * in the stripper — without this it would be silently dropped. The caller
 * supplies a unique id per flush and routes the triple through its normal
 * sink (live send or held buffer).
 */
export function thinkTailParts(id: string, tail: string): UIMessageChunk[] | null {
  if (tail.length === 0) return null
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: tail },
    { type: 'text-end', id }
  ]
}
