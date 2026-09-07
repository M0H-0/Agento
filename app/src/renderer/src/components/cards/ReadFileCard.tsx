import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// read_file card: title is the registry's `Read <basename>`, meta is the
// line range / truncation marker, body shows the content in a pre block.
export interface ReadFileCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  content: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
}

export function ReadFileCard({
  content,
  startLine,
  endLine,
  totalLines,
  truncated,
  ...rest
}: ReadFileCardProps): React.JSX.Element {
  const meta = truncated
    ? `lines ${startLine + 1}–${endLine} of ${totalLines} (truncated)`
    : `lines ${startLine + 1}–${endLine} of ${totalLines}`
  return (
    <BaseToolCard {...rest} meta={meta} defaultOpen>
      <pre className="tool-card__pre">{content || '(empty file)'}</pre>
    </BaseToolCard>
  )
}
