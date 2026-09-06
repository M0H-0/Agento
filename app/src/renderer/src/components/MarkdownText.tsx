import { useEffect, useRef, useState } from 'react'
import type { CodeHeaderProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import remarkGfm from 'remark-gfm'

// Plain-language names for fenced code blocks (docs/04 §8.3: "code — JavaScript
// · copy"). Unlisted languages fall back to a capitalized form of the tag.
const LANGUAGE_LABELS: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  typescript: 'TypeScript',
  py: 'Python',
  python: 'Python',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  shell: 'Shell',
  powershell: 'PowerShell',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  md: 'Markdown',
  markdown: 'Markdown',
  diff: 'Diff'
}

function languageLabel(language: string): string {
  return (
    LANGUAGE_LABELS[language.toLowerCase()] ?? language.charAt(0).toUpperCase() + language.slice(1)
  )
}

// docs/04 §8.3: fenced code blocks get a plain-language header and a copy
// button. Clipboard only — navigator.clipboard, no new bridge surface.
function CodeBlockHeader({ language, code }: CodeHeaderProps): React.JSX.Element {
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
      <span>{language ? `code — ${languageLabel(language)}` : 'code'}</span>
      <button type="button" className="code-copy" onClick={copy}>
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  )
}

// Module-scope identity on purpose: a fresh components object per render would
// remount every markdown block mid-stream (react-markdown remounts when the
// components prop changes identity).
const markdownComponents = { CodeHeader: CodeBlockHeader }

// Rendered as MessagePrimitive.Parts' Text component: the primitive pulls the
// message part's text itself, so no props are needed here.
function MarkdownText(): React.JSX.Element {
  return (
    <MarkdownTextPrimitive
      className="message-markdown"
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}
    />
  )
}

export default MarkdownText
