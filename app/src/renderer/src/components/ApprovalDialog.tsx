import type { AgentApprovalRequestedEvent } from '../../../preload/index'
import { useLocale } from './locale-context'

// ApprovalDialog (M3.2; docs/04 §3.2): blocking modal for risk ≥ 2.
// No overlay-click or Escape dismiss — the run stays blocked until one of
// the three decisions resolves the pending promise main-side.
export interface ApprovalDialogProps {
  request: AgentApprovalRequestedEvent
  onRespond: (decision: 'approve' | 'skip' | 'cancel') => void
  pending?: boolean
  error?: string | null
}

export function ApprovalDialog({
  request,
  onRespond,
  pending,
  error
}: ApprovalDialogProps): React.JSX.Element {
  const { t } = useLocale()
  const destructive = request.riskLevel >= 3
  const countLine =
    request.count !== undefined && request.count > 1
      ? t('approval.batchLine', { n: request.count })
      : null
  return (
    <div className="approval-dialog-overlay">
      <div
        className="approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('approval.needed')}
      >
        {/* request.title/body come from main (describe()) — English until the
            main-side Arabic pass lands (deferred in the trimmed plan). */}
        <h2 className="approval-dialog__title">{request.title}</h2>
        <p className="approval-dialog__body">{request.body}</p>
        {countLine ? <p className="approval-dialog__count">{countLine}</p> : null}
        <p className="approval-dialog__assurance">{t('approval.assurance')}</p>
        {error ? (
          <p className="approval-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="approval-dialog__actions">
          <button
            type="button"
            className="approval-dialog__approve"
            onClick={() => onRespond('approve')}
            disabled={pending}
            autoFocus
          >
            {t(destructive ? 'approval.delete' : 'approval.approve')}
          </button>
          <button
            type="button"
            className="approval-dialog__skip"
            onClick={() => onRespond('skip')}
            disabled={pending}
          >
            {t('approval.skip')}
          </button>
          <button
            type="button"
            className="approval-dialog__cancel"
            onClick={() => onRespond('cancel')}
            disabled={pending}
          >
            {t('approval.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
