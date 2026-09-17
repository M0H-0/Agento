import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { useLocale } from '../locale-context'

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
  const { t } = useLocale()
  const range = { a: startLine + 1, b: endLine, c: totalLines }
  const meta = t(truncated ? 'cards.linesOfTruncated' : 'cards.linesOf', range)
  return (
    <BaseToolCard {...rest} meta={meta}>
      <pre className="tool-card__pre">{content || t('cards.emptyFile')}</pre>
    </BaseToolCard>
  )
}
