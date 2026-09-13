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
  return (
    <BaseToolCard {...rest} defaultOpen>
      {errorText ? <div className="tool-card__error">{errorText}</div> : null}
      {args !== undefined ? (
        <details className="tool-card__details">
          <summary>{t('cards.args')}</summary>
          <pre className="tool-card__pre">{JSON.stringify(args, null, 2)}</pre>
        </details>
      ) : null}
      {result !== undefined ? (
        <details className="tool-card__details" open>
          <summary>{t('cards.result')}</summary>
          <pre className="tool-card__pre">{plainError ?? JSON.stringify(result, null, 2)}</pre>
        </details>
      ) : null}
    </BaseToolCard>
  )
}
