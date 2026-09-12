import { useState } from 'react'
import type { ChangeEntry } from '../../../preload/index'
import { buildStops, restorableNewer, restorePlan } from '../chat/history'
import { plural, relativeTime } from '../chat/locale'
import { useLocale } from './locale-context'

// History (docs/04 §3.4): step across the session's checkpoint stops and
// preview each moment. Read-only until the user confirms: stepping only swaps
// the preview (before-excerpt = how the file looked then); "Restore to here"
// fans out over the existing `changes:undo` channel, newest group first — the
// same order the engine's undo-all uses. Blocked mid-run main-side like every
// other restore (the honest refusal surfaces in the panel error), so this
// component takes no run-state prop.
export function HistorySection({
  entries,
  busy,
  onRestore
}: {
  entries: ChangeEntry[]
  busy: boolean
  onRestore: (checkpointIds: string[]) => void
}): React.JSX.Element | null {
  const { locale, t } = useLocale()
  const stops = buildStops(entries)
  // Stepper value: stop index, or stops.length = present (up to date).
  const [value, setValue] = useState(stops.length)
  const [confirming, setConfirming] = useState(false)
  // A reload (undo landed, new run settled) rebuilds the stops — park back at
  // the present so the stepper never points past the end of history. Render-
  // phase adjustment (previous-entries check), not an effect, so no
  // cascading render.
  const [trackedEntries, setTrackedEntries] = useState(entries)
  if (trackedEntries !== entries) {
    setTrackedEntries(entries)
    setValue(stops.length)
    setConfirming(false)
  }

  if (stops.length < 2) return null

  const atPresent = value >= stops.length
  const stop = atPresent ? null : (stops[value] as (typeof stops)[number])
  const plan = stop ? restorePlan(stops, value) : []
  const laterCount = stop ? restorableNewer(stops, value).length : 0

  return (
    <section className="history" aria-label={t('changes.history.title')}>
      <h3 className="history__title">{t('changes.history.title')}</h3>
      <p className="history__hint">{t('changes.history.hint')}</p>
      {/* Stepper (not a drag slider): arrow buttons move one stop at a time —
          clearer than dragging for a short checkpoint list, and natively
          keyboard-operable. ‹ steps back toward older changes, › forward
          toward the present; the glyphs mirror in RTL like the other
          chevrons (main.css). */}
      <div className="history__stepper">
        <button
          type="button"
          className="history__arrow"
          disabled={busy || value <= 0}
          onClick={() => {
            setValue(value - 1)
            setConfirming(false)
          }}
          aria-label={t('changes.history.prev')}
        >
          <span className="history__arrow-glyph" aria-hidden="true">
            ‹
          </span>
        </button>
        <span className="history__counter" aria-hidden="true">
          {atPresent ? stops.length : value + 1} / {stops.length}
        </span>
        <button
          type="button"
          className="history__arrow"
          disabled={busy || atPresent}
          onClick={() => {
            setValue(value + 1)
            setConfirming(false)
          }}
          aria-label={t('changes.history.next')}
        >
          <span className="history__arrow-glyph" aria-hidden="true">
            ›
          </span>
        </button>
      </div>
      {stop ? (
        <div className="history__preview">
          <span className="history__position">
            <bdi>
              {t('changes.history.position', {
                n: value + 1,
                total: stops.length,
                name: stop.fileName
              })}
            </bdi>{' '}
            · {relativeTime(locale, stop.createdAt)}
            {stop.reverted ? (
              <span className="changes-panel__restored"> {t('changes.restored')}</span>
            ) : null}
          </span>
          <span className="history__before-label">{t('changes.history.before')}</span>
          <span className="history__excerpt">
            {stop.beforeExcerpt ?? t('changes.history.noPreview')}
          </span>
          {laterCount > 0 ? (
            <span className="history__later">
              {plural(locale, laterCount, {
                one: t('changes.history.laterOne'),
                two: t('changes.history.laterTwo'),
                many: t('changes.history.laterMany')
              })}
            </span>
          ) : null}
          {plan.length > 0 ? (
            <span className="history__actions">
              {confirming ? (
                <span className="changes-panel__confirm">
                  {t('changes.history.confirm', { n: plan.length })}
                  <button type="button" onClick={() => onRestore(plan)} disabled={busy}>
                    {t('changes.history.yesRewind')}
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
                    {t('changes.keep')}
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => setConfirming(true)} disabled={busy}>
                  {t('changes.history.restoreHere')}
                </button>
              )}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="history__present">{t('changes.history.present', { n: stops.length })}</p>
      )}
    </section>
  )
}
