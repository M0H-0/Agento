import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

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
  const meta =
    results.length === 0
      ? 'no matching files'
      : `${results.length} matching file${results.length === 1 ? '' : 's'}`
  return (
    <BaseToolCard {...rest} meta={meta} defaultOpen>
      <div className="semantic-card">
        <div className="semantic-card__query">“{query}”</div>
        {results.length === 0 ? (
          <div className="semantic-card__empty">
            Nothing in the workspace reads as close to that yet — try search_files for exact text.
          </div>
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
                  <span className="semantic-card__path">{result.path}</span>
                  <span className="semantic-card__score">{Math.round(result.score * 100)}%</span>
                  <span className="semantic-card__snippet">{result.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BaseToolCard>
  )
}
