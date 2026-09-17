import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

// move_path card (M2.7): plain-language title, source → destination meta line.
// `from`/`to` arrive display-ready (see displayPath in ToolUIRegistry): the
// model's own relative paths — folder included, so a move into a folder reads
// "Moved a.pdf to PDFs/a.pdf" instead of the old basename-only "Moved a.pdf to
// a.pdf" (live demo: an organize run looked like 30 no-ops). Anything absolute
// is reduced to its file name there — never a raw absolute path dump.
export interface MovePathCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  from: string
  to: string
  overwritten: boolean
}

export function MovePathCard({
  from,
  to,
  overwritten,
  ...rest
}: MovePathCardProps): React.JSX.Element {
  const { t } = useLocale()
  const meta = t(overwritten ? 'cards.movedReplaced' : 'cards.movedTo', { from, to })
  return (
    <BaseToolCard {...rest} meta={meta}>
      <div className="tool-card__empty">
        {t(overwritten ? 'cards.moveReplacedNote' : 'cards.moveGoneNote')}
      </div>
    </BaseToolCard>
  )
}
