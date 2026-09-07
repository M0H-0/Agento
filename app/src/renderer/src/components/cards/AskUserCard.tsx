import { useState } from 'react'
import { BaseToolCard, type BaseToolCardProps } from './BaseToolCard'

// ask_user card: shows the question, lets the user type a reply, and on
// Send calls window.agento.toolAnswer({ toolCallId, answer }) to resume the
// paused loop. The tool part's `output` carries { __agentoAskUser, toolCallId,
// question, options? }; once the AI SDK emits the follow-up tool-output-
// available with the real answer, the part's `output` no longer has
// __agentoAskUser and we render the "Replied" state.

export interface AskUserCardProps extends Omit<BaseToolCardProps, 'meta' | 'children' | 'title'> {
  title: string
  question: string
  options?: string[]
  toolCallId: string
  /** The part's `output` object — if it carries `__agentoAskUser`, we render the
   *  awaiting-reply composer; otherwise the question is answered and we show
   *  the final answer. */
  output: unknown
  status: BaseToolCardProps['status']
}

interface AwaitingPayload {
  __agentoAskUser: true
  toolCallId: string
  question: string
  options?: string[]
}

interface AnsweredPayload {
  answer: string
  question?: string
}

function isAwaiting(value: unknown): value is AwaitingPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __agentoAskUser?: unknown }).__agentoAskUser === true
  )
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
  options,
  toolCallId,
  output,
  status,
  ...rest
}: AskUserCardProps): React.JSX.Element {
  const awaiting = isAwaiting(output)
  const answered = !awaiting && isAnswered(output)
  const [draft, setDraft] = useState<string>('')
  const [sending, setSending] = useState<boolean>(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  // If the run stops while we're showing the composer, surface an honest
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

  async function send(answer: string): Promise<void> {
    if (!toolCallId) return
    setSending(true)
    setErrorText(null)
    try {
      const res = await window.agento.tool.answer({ toolCallId, answer })
      if (!res.ok) {
        setErrorText(res.reason ?? 'That question is no longer active.')
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <BaseToolCard {...rest} title={`Ask: ${question}`} status={status} meta={meta} defaultOpen>
      {awaiting ? (
        <form
          className="tool-card__form"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = draft.trim()
            if (!trimmed || sending) return
            void send(trimmed)
          }}
        >
          {options && options.length > 0 ? (
            <div className="tool-card__options">
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="tool-card__chip"
                  disabled={sending}
                  onClick={() => {
                    setDraft(option)
                    void send(option)
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            className="tool-card__textarea"
            placeholder="Type your reply…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            disabled={sending}
            autoFocus
          />
          <div className="tool-card__form-row">
            <button
              type="submit"
              className="tool-card__send"
              disabled={sending || draft.trim().length === 0}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
            {errorText ? <span className="tool-card__error">{errorText}</span> : null}
          </div>
        </form>
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
