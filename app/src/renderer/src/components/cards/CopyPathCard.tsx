import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

// copy_path card (M2.7): plain-language title, source → destination meta line.
// `from`/`to` arrive display-ready (relative paths, folder included) from
// ToolUIRegistry.displayPath — same rule as MovePathCard.
export interface CopyPathCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  from: string
  to: string
  overwritten: boolean
  size: number
}

export function CopyPathCard({
  from,
  to,
  overwritten,
  size,
  ...rest
}: CopyPathCardProps): React.JSX.Element {
  const { t } = useLocale()
  const meta = t(overwritten ? 'cards.copiedReplaced' : 'cards.copiedTo', { from, to })
  return (
    <BaseToolCard {...rest} meta={meta}>
      <div className="tool-card__empty">
        {size > 0 ? t('cards.copiedBytes', { n: size }) : t('cards.copyDone')}{' '}
        {overwritten ? t('cards.copyKeptNote') : ''}
      </div>
    </BaseToolCard>
  )
}
