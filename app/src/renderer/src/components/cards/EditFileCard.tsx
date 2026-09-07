import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// edit_file card (M2.6): shows the changed region's before/after excerpts —
// no diff component, no code view (docs/03 §5, docs/04 §3.1). The excerpts
// are the ±context window from the tool result; full content lives in the
// checkpoints table.
export interface EditFileCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  beforeExcerpt: string
  afterExcerpt: string
}

export function EditFileCard({
  beforeExcerpt,
  afterExcerpt,
  ...rest
}: EditFileCardProps): React.JSX.Element {
  return (
    <BaseToolCard {...rest} defaultOpen>
      <div className="tool-card__excerpt">
        <span className="tool-card__excerpt-label">Before</span>
        <pre className="tool-card__pre">{beforeExcerpt}</pre>
      </div>
      <div className="tool-card__excerpt">
        <span className="tool-card__excerpt-label">After</span>
        <pre className="tool-card__pre">{afterExcerpt}</pre>
      </div>
    </BaseToolCard>
  )
}
