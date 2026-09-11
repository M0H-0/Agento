import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { plural } from '../../chat/locale'
import { useLocale } from '../locale-context'

// search_files card: title is the registry's `Search for "..."`, meta is the
// match count + truncation marker, body lists each match with file:line:preview.
export interface SearchFilesCardProps extends Omit<
  BaseToolCardProps,
  'meta' | 'children' | 'title'
> {
  title: string
  query: string
  matches: { path: string; line: number; preview: string }[]
  truncated: boolean
}

export function SearchFilesCard({
  query,
  matches,
  truncated,
  ...rest
}: SearchFilesCardProps): React.JSX.Element {
  const { locale, t } = useLocale()
  const count = plural(locale, matches.length, {
    one: t('cards.matchesOne'),
    two: t('cards.matchesTwo'),
    many: t('cards.matchesMany')
  })
  const meta = `${count}${truncated ? ` ${t('cards.truncated')}` : ''}`
  return (
    <BaseToolCard {...rest} meta={meta} defaultOpen>
      {matches.length === 0 ? (
        <div className="tool-card__empty">{t('cards.noFilesContain', { q: query })}</div>
      ) : (
        <ul className="tool-card__list">
          {matches.map((match, index) => (
            <li
              key={`${match.path}:${match.line}:${index}`}
              className="tool-card__list-item tool-card__list-item--search"
            >
              <span className="tool-card__list-name">
                <bdi>
                  {match.path}:{match.line}
                </bdi>
              </span>
              <span className="tool-card__list-preview">
                <bdi>{match.preview}</bdi>
              </span>
            </li>
          ))}
        </ul>
      )}
    </BaseToolCard>
  )
}
