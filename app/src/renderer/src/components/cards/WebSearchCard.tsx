import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { plural } from '../../chat/locale'
import { useLocale } from '../locale-context'

// web_search card: ranked results with title + address + snippet.
// Display-only — the model opens a result with web_fetch for the full page.
// `provider` names the engine that answered (Tavily primary, keyless
// fallback) so the card stays honest about where results came from.
export interface WebSearchCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  query: string
  results: { title: string; url: string; snippet: string }[]
  provider?: 'tavily' | 'duckduckgo'
}

export function WebSearchCard({
  query,
  results,
  provider,
  ...rest
}: WebSearchCardProps): React.JSX.Element {
  const { locale, t } = useLocale()
  const count =
    results.length === 0
      ? t('cards.noWebResults')
      : plural(locale, results.length, {
          one: t('cards.webResultsOne'),
          two: t('cards.webResultsTwo'),
          many: t('cards.webResultsMany')
        })
  const meta =
    provider === undefined
      ? count
      : `${count} · ${t(provider === 'tavily' ? 'cards.webViaTavily' : 'cards.webViaKeyless')}`
  return (
    <BaseToolCard {...rest} meta={meta} defaultOpen>
      <div className="semantic-card">
        <div className="semantic-card__query">“{query}”</div>
        {results.length === 0 ? (
          <div className="semantic-card__empty">{t('cards.noWebResultsHint')}</div>
        ) : (
          <ul className="semantic-card__list">
            {results.map((result) => (
              <li key={result.url} className="semantic-card__item">
                <span className="semantic-card__path">
                  <bdi>{result.title}</bdi>
                </span>
                <span className="semantic-card__snippet">
                  <bdi>{result.url}</bdi>
                </span>
                {result.snippet ? (
                  <span className="semantic-card__snippet">
                    <bdi>{result.snippet}</bdi>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </BaseToolCard>
  )
}
