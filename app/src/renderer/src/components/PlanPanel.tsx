import type { AgentPlanStep, PlanStepStatus } from '../../../preload/index'
import { useLocale } from './locale-context'

// Plan panel (M3.1 + M3.6 live; docs/04 §3.3): the plan's user surface.
// M3.6 feeds live statuses via plan/step_updated + verification/finished:
// step rows show glyphs, risk accents ≥ 2, `verified ✓` / `not verified`
// badges, failed-step missed requirements, and the N-of-M footer.
export interface PlanPanelProps {
  steps: AgentPlanStep[]
  /** True when this plan replaced an earlier one in the same run. */
  updated: boolean
  /** True when the plan came from a read-only Plan-mode run (no execution path). */
  readOnly?: boolean
  statuses?: Record<string, string>
  verification?: Record<string, { score: number | null; verified: boolean }>
  errors?: Record<string, string>
}

const STATUS_GLYPH: Record<PlanStepStatus, string> = {
  pending: '○',
  in_progress: '◐',
  done: '✓',
  failed: '✗',
  awaiting_approval: '⚠',
  skipped: '○'
}

function statusOf(statuses: Record<string, string> | undefined, id: string): PlanStepStatus {
  const raw = statuses?.[id]
  if (
    raw === 'pending' ||
    raw === 'in_progress' ||
    raw === 'done' ||
    raw === 'failed' ||
    raw === 'awaiting_approval' ||
    raw === 'skipped'
  ) {
    return raw
  }
  return 'pending'
}

export function PlanPanel({
  steps,
  updated,
  readOnly,
  statuses,
  verification,
  errors
}: PlanPanelProps): React.JSX.Element {
  const { t } = useLocale()
  const doneCount = steps.filter((s) => statusOf(statuses, s.id) === 'done').length
  return (
    <aside className="plan-panel" aria-label={t('plan.title')}>
      <h2 className="plan-panel__title">
        {t('plan.title')}
        {updated ? <span className="plan-panel__updated">{t('plan.updated')}</span> : null}
        {readOnly ? <span className="plan-panel__readonly">{t('plan.readOnly')}</span> : null}
      </h2>
      <ul className="plan-panel__list">
        {steps.map((step) => {
          const status = statusOf(statuses, step.id)
          const badge = verification?.[step.id]
          const error = errors?.[step.id]
          return (
            <li
              key={step.id}
              className={
                step.riskLevel >= 2 ? 'plan-panel__step plan-panel__step--risk' : 'plan-panel__step'
              }
            >
              <span className="plan-panel__step-glyph" aria-hidden="true">
                {STATUS_GLYPH[status]}
              </span>
              <span className="plan-panel__step-text">
                {step.description}
                {badge ? (
                  <span className="plan-panel__badge">
                    {t(badge.verified ? 'plan.verified' : 'plan.notVerified')}
                  </span>
                ) : null}
                {error ? <span className="plan-panel__error">{error}</span> : null}
              </span>
            </li>
          )
        })}
      </ul>
      <div className="plan-panel__footer">
        {readOnly
          ? t('plan.readOnlyFooter')
          : t('plan.progress', { done: doneCount, total: steps.length })}
      </div>
    </aside>
  )
}
