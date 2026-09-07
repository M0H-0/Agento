import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

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
  return (
    <BaseToolCard {...rest} defaultOpen>
      {errorText ? <div className="tool-card__error">{errorText}</div> : null}
      {args !== undefined ? (
        <details className="tool-card__details">
          <summary>Arguments</summary>
          <pre className="tool-card__pre">{JSON.stringify(args, null, 2)}</pre>
        </details>
      ) : null}
      {result !== undefined ? (
        <details className="tool-card__details" open>
          <summary>Result</summary>
          <pre className="tool-card__pre">{JSON.stringify(result, null, 2)}</pre>
        </details>
      ) : null}
    </BaseToolCard>
  )
}
