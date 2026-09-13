import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

// write_file card: shows only the written content — no diff component, no code
// view (docs/03 §5, docs/04 §3.1). A whole-file write's "before" blob is noise
// (the old content is kept in the checkpoint for undo, not displayed); the
// label says whether the file is new or replaced. Targeted edits keep their
// before/after regions in EditFileCard/EditDocumentCard.
export interface WriteFileCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  size: number
  beforeExcerpt: string | null
  afterExcerpt: string
}

export function WriteFileCard({
  size,
  beforeExcerpt,
  afterExcerpt,
  ...rest
}: WriteFileCardProps): React.JSX.Element {
  const { t } = useLocale()
  const meta = size >= 1024 ? `${Math.round(size / 102.4) / 10} KB` : `${size} B`
  return (
    <BaseToolCard {...rest} meta={meta} defaultOpen>
      <div className="tool-card__excerpt">
        <span className="tool-card__excerpt-label">
          {beforeExcerpt === null ? t('cards.newFile') : t('cards.replacedContent')}
        </span>
        <pre className="tool-card__pre">{afterExcerpt}</pre>
      </div>
    </BaseToolCard>
  )
}
