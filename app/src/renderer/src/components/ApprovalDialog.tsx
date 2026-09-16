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
  // DEMO-001: the verb names the damage, not the risk tier. Risk 3 arrives
  // two ways — delete_path (always 3) and bulk move/copy escalations (> 25
  // paths, docs/06 §2) — but only a delete deletes. The tool rides the
  // approval/requested event so a 35-file move reads "Approve & move…" while
  // any delete keeps the red "Delete permanently" verb.
  const batchCount = request.count !== undefined && request.count > 1 ? request.count : null
  const tool = 'tool' in request && typeof request.tool === 'string' ? request.tool : ''
  // Damage-accurate verb (never the risk tier alone): only a delete deletes.
  // Any other risk-3 batch (bulk move/copy/edit escalation, docs/06 §2) keeps
  // the Approve verb — the risk-3 accent styling below is untouched.
  const verbKey =
    tool === 'delete_path'
      ? 'approval.delete'
      : tool === 'move_path' && batchCount !== null
        ? 'approval.approveMove'
        : tool === 'copy_path' && batchCount !== null
          ? 'approval.approveCopy'
          : tool !== ''
            ? 'approval.approve'
            : // Legacy payload without `tool`: sniff the English describe()
              // title ("Delete …") so a stale event still reads correctly.
              request.riskLevel >= 3 && /^delete\b/i.test(request.title)
              ? 'approval.delete'
              : 'approval.approve'
  const approveLabel =
    verbKey === 'approval.approveMove' || verbKey === 'approval.approveCopy'
      ? t(verbKey, { n: batchCount as number })
      : t(verbKey)
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
            {approveLabel}
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
