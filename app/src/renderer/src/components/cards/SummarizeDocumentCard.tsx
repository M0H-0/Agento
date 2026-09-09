import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// summarize_document card: title is the registry's `Summarize <basename>`,
// body shows the plain-language summary.
export interface SummarizeDocumentCardProps extends Omit<
  BaseToolCardProps,
  'meta' | 'children' | 'title'
> {
  title: string
  summary: string
  truncated: boolean
}

export function SummarizeDocumentCard({
  summary,
  truncated,
  ...rest
}: SummarizeDocumentCardProps): React.JSX.Element {
  return (
    <BaseToolCard
      {...rest}
      meta={truncated ? 'from the beginning of a longer document' : undefined}
      defaultOpen
    >
      <pre className="tool-card__pre">{summary || '(no summary was produced)'}</pre>
    </BaseToolCard>
  )
}
