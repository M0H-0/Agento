import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// list_dir card: plain-language title from the registry's describe(), one-line
// entry count, body lists each entry with its type tag. Body opens on click.
export interface ListDirCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  entries: { name: string; type: 'file' | 'directory' }[]
}

export function ListDirCard({ entries, ...rest }: ListDirCardProps): React.JSX.Element {
  const meta = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
  return (
    <BaseToolCard {...rest} meta={meta} defaultOpen={entries.length <= 12}>
      {entries.length === 0 ? (
        <div className="tool-card__empty">This folder is empty.</div>
      ) : (
        <ul className="tool-card__list">
          {entries.map((entry) => (
            <li key={entry.name} className="tool-card__list-item">
              <span className="tool-card__list-type" aria-hidden>
                {entry.type === 'directory' ? '📁' : '📄'}
              </span>
              <span className="tool-card__list-name">{entry.name}</span>
            </li>
          ))}
        </ul>
      )}
    </BaseToolCard>
  )
}
