import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// move_path card (M2.7): plain-language title, source → destination meta line.
// Paths in the result are absolute (sandbox-resolved main-side); the card
// shows file names only — never a raw path dump.
function fileName(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path
}

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
  const meta = overwritten
    ? `Moved ${fileName(from)} to ${fileName(to)} · replaced existing`
    : `Moved ${fileName(from)} to ${fileName(to)}`
  return (
    <BaseToolCard {...rest} meta={meta}>
      <div className="tool-card__empty">
        {overwritten
          ? 'The destination already existed — its old content is kept in the checkpoint, so this is undoable.'
          : 'The original is gone from its old place — undo restores it.'}
      </div>
    </BaseToolCard>
  )
}
