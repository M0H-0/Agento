import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

// web_fetch card: title is the registry's `Open web page <url>`, meta shows
// the page's <title>, body shows the readable text preview.
export interface WebFetchCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  pageTitle?: string
  text: string
  truncated: boolean
}

export function WebFetchCard({
  pageTitle,
  text,
  truncated,
  ...rest
}: WebFetchCardProps): React.JSX.Element {
  const { t } = useLocale()
  const meta = truncated
    ? `${t('cards.truncatedPreview')}${pageTitle ? ` — ${pageTitle}` : ''}`
    : pageTitle
  return (
    <BaseToolCard {...rest} meta={meta || undefined} defaultOpen>
      <pre className="tool-card__pre">{text || t('cards.noPageText')}</pre>
    </BaseToolCard>
  )
}
