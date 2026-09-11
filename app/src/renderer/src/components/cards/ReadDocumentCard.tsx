import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

// read_document card: title is the registry's `Read document <basename>`,
// meta notes truncation, body shows the extracted plain text.
export interface ReadDocumentCardProps extends Omit<
  BaseToolCardProps,
  'meta' | 'children' | 'title'
> {
  title: string
  text: string
  truncated: boolean
}

export function ReadDocumentCard({
  text,
  truncated,
  ...rest
}: ReadDocumentCardProps): React.JSX.Element {
  const { t } = useLocale()
  return (
    <BaseToolCard {...rest} meta={truncated ? t('cards.truncatedPreview') : undefined} defaultOpen>
      <pre className="tool-card__pre">{text || t('cards.noDocText')}</pre>
    </BaseToolCard>
  )
}
