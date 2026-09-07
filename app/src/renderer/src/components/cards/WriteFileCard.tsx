import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// write_file card (M2.5): shows the before/after excerpts in the card body —
// no diff component, no code view (docs/03 §5, docs/04 §3.1). The excerpts
// are head-capped previews from the tool result; full content lives in the
// checkpoints table.
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
  const meta = size >= 1024 ? `${Math.round(size / 102.4) / 10} KB` : `${size} B`
  return (
    <BaseToolCard {...rest} meta={meta} defaultOpen>
      <div className="tool-card__excerpt">
        <span className="tool-card__excerpt-label">
          {beforeExcerpt === null ? 'New file' : 'Before'}
        </span>
        {beforeExcerpt === null ? (
          <div className="tool-card__empty">This file did not exist before.</div>
        ) : (
          <pre className="tool-card__pre">{beforeExcerpt}</pre>
        )}
      </div>
      <div className="tool-card__excerpt">
        <span className="tool-card__excerpt-label">After</span>
        <pre className="tool-card__pre">{afterExcerpt}</pre>
      </div>
    </BaseToolCard>
  )
}
