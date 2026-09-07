import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

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
  const meta = `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}${truncated ? ' (truncated)' : ''}`
  return (
    <BaseToolCard {...rest} meta={meta} defaultOpen>
      {matches.length === 0 ? (
        <div className="tool-card__empty">No files contain “{query}”.</div>
      ) : (
        <ul className="tool-card__list">
          {matches.map((match, index) => (
            <li
              key={`${match.path}:${match.line}:${index}`}
              className="tool-card__list-item tool-card__list-item--search"
            >
              <span className="tool-card__list-name">
                {match.path}:{match.line}
              </span>
              <span className="tool-card__list-preview">{match.preview}</span>
            </li>
          ))}
        </ul>
      )}
    </BaseToolCard>
  )
}
