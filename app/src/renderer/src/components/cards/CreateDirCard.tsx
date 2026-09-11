import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

// create_dir card (M2.5): plain-language title, created/existed meta line.
export interface CreateDirCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  existed: boolean
}

export function CreateDirCard({ existed, ...rest }: CreateDirCardProps): React.JSX.Element {
  const { t } = useLocale()
  const meta = t(existed ? 'cards.alreadyExisted' : 'cards.created')
  return (
    <BaseToolCard {...rest} meta={meta}>
      <div className="tool-card__empty">
        {t(existed ? 'cards.dirExistedNote' : 'cards.dirCreatedNote')}
      </div>
    </BaseToolCard>
  )
}
