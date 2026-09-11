import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'
import { isAwaitingAskOutput } from '../../chat/ask'

// ask_user card: a display-only record of the question and its answer. While
// the payload carries __agentoAskUser the run is paused on this question and
// the main composer is the reply box (App.tsx reply mode) — the card only
// points there. Once the answer chunk lands, the part's `output` no longer
// has __agentoAskUser and we render the "Replied" state.

export interface AskUserCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  question: string
  /** The part's `output` object — if it carries `__agentoAskUser`, the
   *  question is still open; otherwise a string `answer` means replied. */
  output: unknown
  status: BaseToolCardProps['status']
}

interface AnsweredPayload {
  answer: string
  question?: string
}

function isAnswered(value: unknown): value is AnsweredPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { answer?: unknown }).answer === 'string' &&
    !(value as { __agentoAskUser?: unknown }).__agentoAskUser
  )
}

export function AskUserCard({
  question,
  output,
  status,
  ...rest
}: AskUserCardProps): React.JSX.Element {
  const awaiting = isAwaitingAskOutput(output)
  const answered = !awaiting && isAnswered(output)

  // If the run stops while the question is open, surface an honest
  // "stopped before reply" note. Deriving during render: no effect needed
  // (the AI SDK's onAbort signature feeds the part's `incomplete` status).
  const stopped = awaiting && status === 'incomplete'

  const meta = answered
    ? 'Replied'
    : stopped
      ? 'Stopped before reply'
      : awaiting
        ? 'Awaiting your reply'
        : ''

  return (
    <BaseToolCard {...rest} title={`Ask: ${question}`} status={status} meta={meta} defaultOpen>
      {awaiting ? (
        <div className="tool-card__empty">
          Waiting for your reply — type it in the message box below.
        </div>
      ) : answered ? (
        <div className="tool-card__answered">
          <span className="tool-card__answered-label">Your reply:</span>
          <span className="tool-card__answered-value">{(output as AnsweredPayload).answer}</span>
        </div>
      ) : stopped ? (
        <div className="tool-card__empty">The run was stopped before you could reply.</div>
      ) : (
        <div className="tool-card__empty">—</div>
      )}
    </BaseToolCard>
  )
}
