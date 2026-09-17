import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { plural } from '../../chat/locale'
import { useLocale } from '../locale-context'

// semantic_search card (MVP standout): ranked results with score + snippet;
// clicking a result asks main to open that file with the OS default app
// (sandbox-contained 'system:open-path'). Read-only tool → risk 0 → no
// approval surface here, matching every other read card.
export interface SemanticSearchCardProps extends Omit<
  BaseToolCardProps,
  'meta' | 'children' | 'title'
> {
  title: string
  query: string
  results: { path: string; snippet: string; score: number }[]
}

export function SemanticSearchCard({
  query,
  results,
  ...rest
}: SemanticSearchCardProps): React.JSX.Element {
  const { locale, t } = useLocale()
  const meta =
    results.length === 0
      ? t('cards.noMatchingFiles')
      : plural(locale, results.length, {
          one: t('cards.matchingOne'),
          two: t('cards.matchingTwo'),
          many: t('cards.matchingMany')
        })
  return (
    <BaseToolCard {...rest} meta={meta}>
      <div className="semantic-card">
        <div className="semantic-card__query">“{query}”</div>
        {results.length === 0 ? (
          <div className="semantic-card__empty">{t('cards.semanticEmpty')}</div>
        ) : (
          <ul className="semantic-card__list">
            {results.map((result) => (
              <li
                key={`${result.path}:${result.snippet.slice(0, 24)}`}
                className="semantic-card__item"
              >
                <button
                  type="button"
                  className="semantic-card__result"
                  onClick={() => {
                    void window.agento.system.openPath({ path: result.path })
                  }}
                >
                  <span className="semantic-card__path">
                    <bdi>{result.path}</bdi>
                  </span>
                  <span className="semantic-card__score">{Math.round(result.score * 100)}%</span>
                  <span className="semantic-card__snippet">
                    <bdi>{result.snippet}</bdi>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BaseToolCard>
  )
}
