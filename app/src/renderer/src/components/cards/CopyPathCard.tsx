import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

// copy_path card (M2.7): plain-language title, source → destination meta line.
// Absolute result paths are reduced to file names (MovePathCard doctrine).
function fileName(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path
}

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
  const names = { from: fileName(from), to: fileName(to) }
  const meta = t(overwritten ? 'cards.copiedReplaced' : 'cards.copiedTo', names)
  return (
    <BaseToolCard {...rest} meta={meta}>
      <div className="tool-card__empty">
        {size > 0 ? t('cards.copiedBytes', { n: size }) : t('cards.copyDone')}{' '}
        {overwritten ? t('cards.copyKeptNote') : ''}
      </div>
    </BaseToolCard>
  )
}
