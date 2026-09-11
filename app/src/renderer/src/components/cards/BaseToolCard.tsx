import { useState } from 'react'
import { Loader } from '@/components/ui/loader'
import { cn } from '@/lib/utils'
import { useLocale } from '../locale-context'
import type { StringKey } from '../../chat/locale'

// Shared chrome for tool cards (docs/04 §3.1): chevron + plain-language title
// from the registry's describe() + status glyph (spinner / check / cross) +
// one-line meta. No diff component anywhere (docs/04 §5). M2.4 keeps the body
// simple — every card just shows its title + meta + (when running) a Loader;
// ask_user adds the awaiting-reply composer.

export type ToolCardStatus = 'running' | 'complete' | 'incomplete' | 'disabled'

export interface BaseToolCardProps {
  title: string
  status: ToolCardStatus
  meta?: string
  /** Optional body — exposed for cards that need to render excerpts (M2.5/M2.6). */
  children?: React.ReactNode
  /** Optional default-open state; M2.4 cards stay collapsed by default. */
  defaultOpen?: boolean
  /** Tool-call id (used by ask_user to route the answer back). */
  toolCallId?: string
}

function statusGlyph(status: ToolCardStatus): React.JSX.Element {
  if (status === 'running') return <Loader size="sm" className="text-muted-foreground" />
  if (status === 'complete') {
    return (
      <span
        aria-hidden
        className="inline-flex h-4 w-4 items-center justify-center text-emerald-500"
      >
        {/* check glyph (no lucide dependency) */}
        <svg
          viewBox="0 0 16 16"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  if (status === 'incomplete') {
    return (
      <span aria-hidden className="inline-flex h-4 w-4 items-center justify-center text-amber-500">
        <svg
          viewBox="0 0 16 16"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M8 3v6M8 12.5v.5" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground"
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
        <circle cx="8" cy="8" r="3" />
      </svg>
    </span>
  )
}

const STATUS_KEYS: Record<ToolCardStatus, StringKey> = {
  running: 'cards.running',
  complete: 'cards.done',
  incomplete: 'cards.failed',
  disabled: 'cards.disabled'
}

export function BaseToolCard({
  title,
  status,
  meta,
  children,
  defaultOpen = false,
  toolCallId
}: BaseToolCardProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const { t } = useLocale()
  const ariaLabel = t('cards.titleStatus', { title, status: t(STATUS_KEYS[status]) })
  return (
    <div className="tool-card" data-tool-call-id={toolCallId} aria-label={ariaLabel}>
      <button
        type="button"
        className={cn('tool-card__header', status === 'incomplete' && 'tool-card__header--warn')}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="tool-card__chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="tool-card__title">{title}</span>
        <span className="tool-card__status">{statusGlyph(status)}</span>
      </button>
      {meta && <div className="tool-card__meta">{meta}</div>}
      {open && children ? <div className="tool-card__body">{children}</div> : null}
    </div>
  )
}
