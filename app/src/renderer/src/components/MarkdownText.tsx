import { useEffect, useRef, useState } from 'react'
import { useMessagePartText } from '@assistant-ui/react'
import type { CodeHeaderProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import remarkGfm from 'remark-gfm'
import { WORDS_PER_TICK, WORD_TICK_MS, nextDisplayed } from '../chat/word-pacing'
import { stripAskUserJsonEcho } from '../chat/ask'
import { codeHeaderText } from '../chat/code-label'
import { useLocale } from './locale-context'

// docs/04 §8.3: fenced code blocks get a plain-language header and a copy
// button. Clipboard only — navigator.clipboard, no new bridge surface.
function CodeBlockHeader({ language, code }: CodeHeaderProps): React.JSX.Element {
  const { t } = useLocale()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const copy = (): void => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true)
        window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => setCopied(false), 1500)
      },
      () => {
        // Copy refused (e.g. focus policy): keep the quiet affordance.
      }
    )
  }

  return (
    <div className="code-header">
      <span>{codeHeaderText(language, t('markdown.code'))}</span>
      <button type="button" className="code-copy" onClick={copy}>
        {t(copied ? 'markdown.copied' : 'markdown.copy')}
      </button>
    </div>
  )
}

// Module-scope identity on purpose: a fresh components object per render would
// remount every markdown block mid-stream (react-markdown remounts when the
// components prop changes identity).
const markdownComponents = { CodeHeader: CodeBlockHeader }

// Rendered as MessagePrimitive.Parts' Text component: the part's full text
// comes from useMessagePartText, and the word-by-word reveal rides the
// primitive's `preprocess` (smooth={false} kills the fast built-in animator —
// it catches up in ≤250ms, which still reads as chunk-at-once on large
// provider deltas). Prose reveals at WORDS_PER_TICK / WORD_TICK_MS via
// chat/word-pacing; fenced code blocks pop atomically; settled/history parts
// and prefers-reduced-motion render full text instantly. Persistence is
// untouched — main's accumulator stores the full reply either way.
function MarkdownText(): React.JSX.Element {
  const { text: rawText, status } = useMessagePartText()
  // Hide ask_user argument echoes some models emit as text (display only).
  const fullText = stripAskUserJsonEcho(rawText)
  const running = status.type === 'running'
  const [displayed, setDisplayed] = useState(fullText)
  // Settle, history, id-change, or reduced-motion: show the full text at once
  // (also flushes any lag when Stop ends the run mid-reveal). Derived, not
  // stored — so no synchronous setState inside the ticking effect below.
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const settled = !running || reduceMotion
  const visible = settled ? fullText : displayed

  useEffect(() => {
    if (settled || displayed === fullText) return
    const id = window.setTimeout(() => {
      setDisplayed((prev) => nextDisplayed(prev, fullText, WORDS_PER_TICK))
    }, WORD_TICK_MS)
    return () => window.clearTimeout(id)
  }, [displayed, fullText, settled])

  return (
    <MarkdownTextPrimitive
      className="message-markdown"
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}
      smooth={false}
      preprocess={() => visible}
    />
  )
}

export default MarkdownText
