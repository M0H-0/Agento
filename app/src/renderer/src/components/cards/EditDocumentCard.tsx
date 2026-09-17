import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

// edit_document card: the changed region's before/after excerpts —
// no diff component, no code view (docs/03 §5, docs/04 §3.1). Same shape
// as EditFileCard; the meta line states how many anchor edits applied.
export interface EditDocumentCardProps extends Omit<
  BaseToolCardProps,
  'meta' | 'children' | 'title'
> {
  title: string
  beforeExcerpt: string
  afterExcerpt: string
  editsApplied: number
}

export function EditDocumentCard({
  beforeExcerpt,
  afterExcerpt,
  editsApplied,
  ...rest
}: EditDocumentCardProps): React.JSX.Element {
  const { t } = useLocale()
  const meta = `${editsApplied} ${t('cards.editsApplied')}`
  return (
    <BaseToolCard {...rest} meta={meta}>
      <div className="tool-card__excerpt">
        <span className="tool-card__excerpt-label">{t('cards.before')}</span>
        <pre className="tool-card__pre">{beforeExcerpt}</pre>
      </div>
      <div className="tool-card__excerpt">
        <span className="tool-card__excerpt-label">{t('cards.after')}</span>
        <pre className="tool-card__pre">{afterExcerpt}</pre>
      </div>
    </BaseToolCard>
  )
}
