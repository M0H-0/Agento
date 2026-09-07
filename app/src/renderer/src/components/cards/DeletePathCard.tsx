import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// delete_path card (M2.7): plain-language title, deleted-name meta line.
// The snapshot holds the full content, so the body says the delete is
// undoable (docs/04 §3.1 footer actions).
function fileName(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path
}

export interface DeletePathCardProps extends Omit<
  BaseToolCardProps,
  'meta' | 'children' | 'title'
> {
  title: string
  path: string
}

export function DeletePathCard({ path, ...rest }: DeletePathCardProps): React.JSX.Element {
  return (
    <BaseToolCard {...rest} meta={`Deleted ${fileName(path)}`}>
      <div className="tool-card__empty">
        Its content is kept in the checkpoint — undo restores it.
      </div>
    </BaseToolCard>
  )
}
