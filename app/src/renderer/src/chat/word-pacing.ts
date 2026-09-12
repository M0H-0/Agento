// Word-by-word streaming pace (docs/04 §8.4): pure module (no DOM, no
// Electron, no node:path) so the reveal budget is unit-testable and the
// MarkdownText component stays thin.
//
// Contract: the renderer reveals assistant prose a few words per tick while
// fenced code blocks pop atomically — code is never half-typed. Fences are
// counted by ``` occurrences; an odd count means "inside a fence". When a
// word-budget slice would land inside a fence, the slice extends to the
// fence end (or the full target when the fence is still unclosed).

/** Medium pace: ~2 words per 40ms tick (~50 words/sec). */
export const WORDS_PER_TICK = 2
export const WORD_TICK_MS = 40

const FENCE = '```'

function isWordToken(token: string): boolean {
  return /\S/.test(token)
}

/** Split into word/whitespace tokens, preserving every character. */
export function tokenizeWords(text: string): string[] {
  if (text.length === 0) return []
  return text.match(/(\S+\s*|\s+)/g) ?? []
}

/** Number of ``` markers in text (odd = inside a fence). */
export function countFences(text: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(FENCE, from)
    if (at < 0) return count
    count += 1
    from = at + FENCE.length
  }
}

export function isInsideFence(text: string): boolean {
  return countFences(text) % 2 === 1
}

/**
 * Advance `current` toward `target` by up to `wordBudget` words. Returns the
 * new displayed string (always a prefix of `target`). Non-prefix transitions
 * (message id change, history edit) jump straight to `target`.
 */
export function nextDisplayed(
  current: string,
  target: string,
  wordBudget: number = WORDS_PER_TICK
): string {
  if (current === target) return target
  if (target.length === 0) return target
  if (current.length === 0) {
    // Fresh part: fall through to budgeted reveal (keeps first paint small).
  } else if (!target.startsWith(current)) {
    return target
  }
  if (wordBudget <= 0) return current

  const rest = target.slice(current.length)
  const tokens = tokenizeWords(rest)
  let words = 0
  let end = current.length
  for (const token of tokens) {
    end += token.length
    if (isWordToken(token)) {
      words += 1
      if (words >= wordBudget) break
    }
  }
  let sliced = target.slice(0, end)
  // Instant code blocks: never stop mid-fence. Extend to the closing fence
  // (or the full target while the fence is still streaming open).
  if (isInsideFence(sliced)) {
    const closeAt = target.indexOf(FENCE, sliced.length)
    sliced = closeAt < 0 ? target : target.slice(0, closeAt + FENCE.length)
  }
  return sliced
}
