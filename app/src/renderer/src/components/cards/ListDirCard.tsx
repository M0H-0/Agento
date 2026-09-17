import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { plural } from '../../chat/locale'
import { useLocale } from '../locale-context'

// list_dir card: plain-language title from the registry's describe(), one-line
// entry count, body lists each entry with its type tag. Body opens on click.
export interface ListDirCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  entries: { name: string; type: 'file' | 'directory' }[]
}

export function ListDirCard({ entries, ...rest }: ListDirCardProps): React.JSX.Element {
  const { locale, t } = useLocale()
  const meta = plural(locale, entries.length, {
    one: t('cards.entriesOne'),
    two: t('cards.entriesTwo'),
    many: t('cards.entriesMany')
  })
  return (
    <BaseToolCard {...rest} meta={meta}>
      {entries.length === 0 ? (
        <div className="tool-card__empty">{t('cards.folderEmpty')}</div>
      ) : (
        <ul className="tool-card__list">
          {entries.map((entry) => (
            <li key={entry.name} className="tool-card__list-item">
              <span className="tool-card__list-type" aria-hidden>
                {entry.type === 'directory' ? '📁' : '📄'}
              </span>
              <span className="tool-card__list-name">
                <bdi>{entry.name}</bdi>
              </span>
            </li>
          ))}
        </ul>
      )}
    </BaseToolCard>
  )
}
