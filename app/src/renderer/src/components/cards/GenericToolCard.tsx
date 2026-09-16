import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

// Fallback for tools the renderer has no per-tool component for (e.g. M2.5's
// write_file before its card lands, or future MCP tools). The card shows the
// tool name and its raw result as a pre block — no diff, no editor.
export interface GenericToolCardProps extends BaseToolCardProps {
  result?: unknown
  args?: unknown
  errorText?: string
}

export function GenericToolCard({
  result,
  args,
  errorText,
  ...rest
}: GenericToolCardProps): React.JSX.Element {
  const { t } = useLocale()
  // An {"error": "…"} result reads as a plain sentence, not raw JSON.
  const plainError =
    result &&
    typeof result === 'object' &&
    typeof (result as { error?: unknown }).error === 'string' &&
    Object.keys(result as object).length === 1
      ? ((result as { error: string }).error as string)
      : undefined
  // Phase-1 item 1: the wrapper's oversized-result envelope ({ outputTruncated })
  // carries no ranked structure — render it as a plain-language notice, never
  // raw JSON. Ranked tools (web_search) self-cap below the wrapper budget so
  // this stays a backstop.
  const truncatedNotice =
    result &&
    typeof result === 'object' &&
    (result as { outputTruncated?: unknown }).outputTruncated === true
      ? t('cards.largeResult')
      : undefined
  const truncatedHint =
    truncatedNotice !== undefined &&
    result &&
    typeof result === 'object' &&
    typeof (result as { hint?: unknown }).hint === 'string'
      ? ((result as { hint: string }).hint as string)
      : undefined
  return (
    <BaseToolCard {...rest} defaultOpen>
      {/* The error line is the one surface for a failure sentence. When the
          result is the same single-key {"error": …} the tool returned, the
          Result block would print the sentence twice — it is suppressed below
          (plainError === errorText). */}
      {errorText ? <div className="tool-card__error">{errorText}</div> : null}
      {truncatedNotice !== undefined ? (
        <div className="tool-card__empty">
          {truncatedNotice} {truncatedHint ?? t('cards.largeResultHint')}
        </div>
      ) : null}
      {args !== undefined ? (
        <details className="tool-card__details">
          <summary>{t('cards.args')}</summary>
          <pre className="tool-card__pre">{JSON.stringify(args, null, 2)}</pre>
        </details>
      ) : null}
      {result !== undefined && truncatedNotice === undefined && plainError !== errorText ? (
        <details className="tool-card__details" open>
          <summary>{t('cards.result')}</summary>
          <pre className="tool-card__pre">{plainError ?? JSON.stringify(result, null, 2)}</pre>
        </details>
      ) : null}
    </BaseToolCard>
  )
}
