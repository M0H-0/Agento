import { useEffect, useState } from 'react'
import type { ChangeEntry } from '../../../preload/index'
import { relativeTime } from '../chat/locale'
import type { StringKey } from '../chat/locale'
import { useLocale } from './locale-context'
import { HistorySection } from './HistorySection'

// Changes panel (M2.8; docs/04 §3.4): session checkpoints with per-item undo
// and Undo all. Rows sharing a groupKey are one mutation (M2.7: a move lands
// a source row + a dest row) and render as a single item whose undo fans out
// over the group's rows oldest-first — the same order the engine's undo-all
// uses (snapshot order restores both sides of a move correctly). Since the
// UI-polish shell, the panel is an in-flow child of the right rail (nothing
// fixed, nothing overlaps) and fills whatever the Plan panel leaves.
export interface ChangesPanelProps {
  sessionId: string | null
  refreshKey: number
}

interface ChangeGroup {
  key: string
  /** Newest-first, as the feed returns. */
  rows: ChangeEntry[]
}

function groupEntries(entries: ChangeEntry[]): ChangeGroup[] {
  const groups = new Map<string, ChangeEntry[]>()
  const order: string[] = []
  for (const entry of entries) {
    const key = entry.groupKey ?? `solo:${entry.id}`
    const group = groups.get(key)
    if (group) group.push(entry)
    else {
      groups.set(key, [entry])
      order.push(key)
    }
  }
  return order.map((key) => ({ key, rows: groups.get(key) as ChangeEntry[] }))
}

function fileName(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path
}

type T = (key: StringKey, params?: Record<string, string | number>) => string

function titleForGroup(t: T, group: ChangeGroup): string {
  // The oldest row (snapshot order) describes the mutation best: for a move
  // it is the source row carrying the destination.
  const first = group.rows[group.rows.length - 1] as ChangeEntry
  switch (first.tool) {
    case 'write_file':
      return t(first.existed ? 'changes.overwrote' : 'changes.wrote')
    case 'edit_file':
      return t('changes.edited')
    case 'create_dir':
      return t('changes.createdFolder')
    case 'move_path': {
      const dest = group.rows.find((row) => row.relativeDestPath)?.relativeDestPath
      return dest
        ? t('changes.movedTo', { from: fileName(first.relativePath), to: fileName(dest) })
        : t('changes.movedFile')
    }
    case 'copy_path': {
      const dest = group.rows.find((row) => row.relativeDestPath)?.relativeDestPath
      return dest
        ? t('changes.copiedTo', { from: fileName(first.relativePath), to: fileName(dest) })
        : t('changes.copiedFile')
    }
    case 'create_document':
      return t(first.existed ? 'changes.overwrote' : 'changes.wrote')
    case 'edit_document':
      return t('changes.edited')
    case 'convert_document':
      return t(first.existed ? 'changes.overwrote' : 'changes.wrote')
    case 'delete_path':
      return t('changes.deleted')
    case 'agent':
      // Undo rows carry no toolCallId (their own solo group): the captured
      // pre-undo state, which undoing reverts the undo (docs/04 §3.4).
      return t('changes.restorePoint')
    default:
      return t('changes.changed')
  }
}

function pathForGroup(group: ChangeGroup): string {
  const first = group.rows[group.rows.length - 1] as ChangeEntry
  return first.relativePath
}

export function ChangesPanel({
  sessionId,
  refreshKey
}: ChangesPanelProps): React.JSX.Element | null {
  const { locale, t } = useLocale()
  const [entries, setEntries] = useState<ChangeEntry[]>([])
  const [activeCount, setActiveCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  useEffect(() => {
    // Passive-listener pattern (SidecarStatusDot): state lands in the promise
    // callbacks, never synchronously in the effect body (M1.3 rule). The
    // null-session reset also happens in a microtask callback.
    let cancelled = false
    const reset = (): void => {
      if (cancelled) return
      setEntries([])
      setActiveCount(0)
      setError(null)
      setConfirmKey(null)
      setConfirmAll(false)
    }
    if (!sessionId) {
      Promise.resolve().then(reset)
      return () => {
        cancelled = true
      }
    }
    window.agento.changes
      .list({ sessionId })
      .then((result) => {
        if (cancelled) return
        setEntries(result.entries)
        setActiveCount(result.activeCount)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshKey])

  if (!sessionId) return null

  const reload = (): void => {
    window.agento.changes
      .list({ sessionId })
      .then((result) => {
        setEntries(result.entries)
        setActiveCount(result.activeCount)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  const failMessages = (results: { ok: boolean; error?: string }[]): string | null => {
    const failures = results.filter((result) => !result.ok)
    if (failures.length === 0) return null
    if (failures.length === 1)
      return (failures[0] as { error?: string }).error ?? t('changes.undoFailed')
    return t('changes.restoreFailed', {
      n: failures.length,
      reason: (failures[0] as { error?: string }).error ?? t('changes.seeEachItem')
    })
  }

  const undoGroup = (group: ChangeGroup): void => {
    // Oldest-first within the group (engine doctrine): the source row of a
    // move renames the dest back before the dest row restores anything.
    const pending = [...group.rows].reverse().filter((row) => row.revertedAt === null)
    if (pending.length === 0) return
    setBusyKey(group.key)
    setError(null)
    const run = async (): Promise<void> => {
      const outcomes: { ok: boolean; error?: string }[] = []
      for (const row of pending) {
        try {
          const result = await window.agento.changes.undo({ checkpointId: row.id })
          for (const item of result.results) outcomes.push(item)
        } catch (err: unknown) {
          outcomes.push({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      }
      const message = failMessages(outcomes)
      setError(message)
      setBusyKey(null)
      setConfirmKey(null)
      reload()
    }
    void run()
  }

  const undoAll = (): void => {
    setBusyKey('__all')
    setError(null)
    window.agento.changes
      .undoAll({ sessionId })
      .then((result) => {
        setError(failMessages(result.results))
        setBusyKey(null)
        setConfirmAll(false)
        reload()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusyKey(null)
        setConfirmAll(false)
      })
  }

  const groups = groupEntries(entries)

  // Time travel ("restore to here"): rewind an ordered list of checkpoint ids
  // through the same per-row `changes:undo` channel the per-item undo uses —
  // no new IPC. The order comes from the caller (newest group first); a
  // mid-run refusal surfaces as the panel error, exactly like undo-all.
  const restoreIds = (ids: string[]): void => {
    if (ids.length === 0) return
    setBusyKey('__history')
    setError(null)
    const run = async (): Promise<void> => {
      const outcomes: { ok: boolean; error?: string }[] = []
      for (const id of ids) {
        try {
          const result = await window.agento.changes.undo({ checkpointId: id })
          for (const item of result.results) outcomes.push(item)
        } catch (err: unknown) {
          outcomes.push({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      }
      setError(failMessages(outcomes))
      setBusyKey(null)
      reload()
    }
    void run()
  }

  return (
    <aside className="changes-panel" aria-label={t('changes.title')}>
      <h2 className="changes-panel__title">
        {t('changes.title')}{' '}
        {activeCount > 0 ? <span className="changes-panel__count">{activeCount}</span> : null}
      </h2>
      {activeCount > 0 ? (
        <div className="changes-panel__actions">
          {confirmAll ? (
            <span className="changes-panel__confirm">
              {t('changes.confirmAll')}
              <button type="button" onClick={undoAll} disabled={busyKey !== null}>
                {t('changes.yesUndoAll')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmAll(false)}
                disabled={busyKey !== null}
              >
                {t('changes.keep')}
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmAll(true)} disabled={busyKey !== null}>
              {t('changes.undoAll')}
            </button>
          )}
        </div>
      ) : null}
      {error ? <div className="changes-panel__error">{error}</div> : null}
      <HistorySection entries={entries} busy={busyKey !== null} onRestore={restoreIds} />
      {groups.length === 0 && !error ? (
        <div className="changes-panel__empty">{t('changes.empty')}</div>
      ) : (
        <ul className="changes-panel__list">
          {groups.map((group) => {
            const reverted = group.rows.every((row) => row.revertedAt !== null)
            // Any undo in flight (this group's or another's) disables EVERY
            // row's buttons — a concurrent restore must not interleave its
            // pre-undo state captures with this one (M2.8 review fix; the
            // main side serializes too, but the UI should say so).
            const busy = busyKey !== null
            const title = titleForGroup(t, group)
            return (
              <li
                key={group.key}
                className={
                  reverted
                    ? 'changes-panel__item changes-panel__item--reverted'
                    : 'changes-panel__item'
                }
              >
                <span className="changes-panel__item-title">
                  {title}{' '}
                  {reverted ? (
                    <span className="changes-panel__restored">{t('changes.restored')}</span>
                  ) : null}
                </span>
                <span className="changes-panel__item-path">
                  <bdi>{pathForGroup(group)}</bdi>
                </span>
                <span className="changes-panel__item-meta">
                  {relativeTime(locale, (group.rows[0] as ChangeEntry).createdAt)}
                </span>
                {!reverted ? (
                  <span className="changes-panel__item-actions">
                    {confirmKey === group.key ? (
                      <span className="changes-panel__confirm">
                        {t('changes.confirmItem', { name: fileName(pathForGroup(group)) })}
                        <button type="button" onClick={() => undoGroup(group)} disabled={busy}>
                          {t('changes.yesRestore')}
                        </button>
                        <button type="button" onClick={() => setConfirmKey(null)} disabled={busy}>
                          {t('changes.keep')}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmKey(group.key)}
                        disabled={busy}
                        aria-label={t('changes.undoItem', { title })}
                      >
                        {t('changes.undo')}
                      </button>
                    )}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
