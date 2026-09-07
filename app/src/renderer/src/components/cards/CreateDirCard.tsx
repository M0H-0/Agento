import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// create_dir card (M2.5): plain-language title, created/existed meta line.
export interface CreateDirCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  existed: boolean
}

export function CreateDirCard({ existed, ...rest }: CreateDirCardProps): React.JSX.Element {
  const meta = existed ? 'Already existed' : 'Created'
  return (
    <BaseToolCard {...rest} meta={meta}>
      <div className="tool-card__empty">
        {existed ? 'That folder was already there — nothing was changed.' : 'Folder created.'}
      </div>
    </BaseToolCard>
  )
}
