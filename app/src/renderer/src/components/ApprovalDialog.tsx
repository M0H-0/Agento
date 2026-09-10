import type { AgentApprovalRequestedEvent } from '../../../preload/index'

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
  const destructive = request.riskLevel >= 3
  const countLine =
    request.count !== undefined && request.count > 1
      ? `I'm about to touch ${request.count} items in one batch.`
      : null
  return (
    <div className="approval-dialog-overlay">
      <div className="approval-dialog" role="dialog" aria-modal="true" aria-label="Approval needed">
        <h2 className="approval-dialog__title">{request.title}</h2>
        <p className="approval-dialog__body">{request.body}</p>
        {countLine ? <p className="approval-dialog__count">{countLine}</p> : null}
        <p className="approval-dialog__assurance">You can undo this afterwards from Changes.</p>
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
            {destructive ? 'Delete permanently' : 'Approve'}
          </button>
          <button
            type="button"
            className="approval-dialog__skip"
            onClick={() => onRespond('skip')}
            disabled={pending}
          >
            Skip this step
          </button>
          <button
            type="button"
            className="approval-dialog__cancel"
            onClick={() => onRespond('cancel')}
            disabled={pending}
          >
            Cancel the rest
          </button>
        </div>
      </div>
    </div>
  )
}
