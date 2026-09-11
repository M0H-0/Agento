import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

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
  const { t } = useLocale()
  return (
    <BaseToolCard {...rest} meta={truncated ? t('cards.docBeginning') : undefined} defaultOpen>
      <pre className="tool-card__pre">{summary || t('cards.noSummary')}</pre>
    </BaseToolCard>
  )
}
