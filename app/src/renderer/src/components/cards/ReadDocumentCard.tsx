import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// read_document card: title is the registry's `Read document <basename>`,
// meta notes truncation, body shows the extracted plain text.
export interface ReadDocumentCardProps extends Omit<
  BaseToolCardProps,
  'meta' | 'children' | 'title'
> {
  title: string
  text: string
  truncated: boolean
}

export function ReadDocumentCard({
  text,
  truncated,
  ...rest
}: ReadDocumentCardProps): React.JSX.Element {
  return (
    <BaseToolCard {...rest} meta={truncated ? 'truncated preview' : undefined} defaultOpen>
      <pre className="tool-card__pre">{text || '(no text found in this document)'}</pre>
    </BaseToolCard>
  )
}
