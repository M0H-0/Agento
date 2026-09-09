import { useEffect, useState } from 'react'
import type { ChangeEntry } from '../../../preload/index'

// Changes panel (M2.8; docs/04 §3.4): session checkpoints with per-item undo
// and Undo all. Rows sharing a groupKey are one mutation (M2.7: a move lands
// a source row + a dest row) and render as a single item whose undo fans out
// over the group's rows oldest-first — the same order the engine's undo-all
// uses (snapshot order restores both sides of a move correctly).
export interface ChangesPanelProps {
  sessionId: string | null
  refreshKey: number
  /** M3.1: shift below the PlanPanel when one is visible (both fixed right-rail). */
  shifted?: boolean
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

function titleForGroup(group: ChangeGroup): string {
  // The oldest row (snapshot order) describes the mutation best: for a move
  // it is the source row carrying the destination.
  const first = group.rows[group.rows.length - 1] as ChangeEntry
  switch (first.tool) {
    case 'write_file':
      return first.existed ? 'Overwrote file' : 'Wrote file'
    case 'edit_file':
      return 'Edited file'
    case 'create_dir':
      return 'Created folder'
    case 'move_path': {
      const dest = group.rows.find((row) => row.relativeDestPath)?.relativeDestPath
      return dest ? `Moved ${fileName(first.relativePath)} to ${fileName(dest)}` : 'Moved file'
    }
    case 'copy_path': {
      const dest = group.rows.find((row) => row.relativeDestPath)?.relativeDestPath
      return dest ? `Copied ${fileName(first.relativePath)} to ${fileName(dest)}` : 'Copied file'
    }
    case 'delete_path':
      return 'Deleted file'
    case 'agent':
      // Undo rows carry no toolCallId (their own solo group): the captured
      // pre-undo state, which undoing reverts the undo (docs/04 §3.4).
      return 'Restore point'
    default:
      return 'Changed file'
  }
}

function pathForGroup(group: ChangeGroup): string {
  const first = group.rows[group.rows.length - 1] as ChangeEntry
  return first.relativePath
}

function relativeTime(createdAt: string): string {
  const then = Date.parse(createdAt)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(then).toLocaleDateString()
}

export function ChangesPanel({
  sessionId,
  refreshKey,
  shifted
}: ChangesPanelProps): React.JSX.Element | null {
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
    if (failures.length === 1) return (failures[0] as { error?: string }).error ?? 'Undo failed.'
    return `${failures.length} items could not be restored — ${(failures[0] as { error?: string }).error ?? 'see each item'}`
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

  return (
    <aside
      className={shifted ? 'changes-panel changes-panel--plan-open' : 'changes-panel'}
      aria-label="Changes"
    >
      <h2 className="changes-panel__title">
        Changes{' '}
        {activeCount > 0 ? <span className="changes-panel__count">{activeCount}</span> : null}
      </h2>
      {activeCount > 0 ? (
        <div className="changes-panel__actions">
          {confirmAll ? (
            <span className="changes-panel__confirm">
              Restore everything to how it was before this conversation?
              <button type="button" onClick={undoAll} disabled={busyKey !== null}>
                Yes, undo all
              </button>
              <button
                type="button"
                onClick={() => setConfirmAll(false)}
                disabled={busyKey !== null}
              >
                Keep
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmAll(true)} disabled={busyKey !== null}>
              Undo all
            </button>
          )}
        </div>
      ) : null}
      {error ? <div className="changes-panel__error">{error}</div> : null}
      {groups.length === 0 && !error ? (
        <div className="changes-panel__empty">No file changes yet in this conversation.</div>
      ) : (
        <ul className="changes-panel__list">
          {groups.map((group) => {
            const reverted = group.rows.every((row) => row.revertedAt !== null)
            // Any undo in flight (this group's or another's) disables EVERY
            // row's buttons — a concurrent restore must not interleave its
            // pre-undo state captures with this one (M2.8 review fix; the
            // main side serializes too, but the UI should say so).
            const busy = busyKey !== null
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
                  {titleForGroup(group)}{' '}
                  {reverted ? <span className="changes-panel__restored">restored ✓</span> : null}
                </span>
                <span className="changes-panel__item-path">{pathForGroup(group)}</span>
                <span className="changes-panel__item-meta">
                  {relativeTime((group.rows[0] as ChangeEntry).createdAt)}
                </span>
                {!reverted ? (
                  <span className="changes-panel__item-actions">
                    {confirmKey === group.key ? (
                      <span className="changes-panel__confirm">
                        Restore {fileName(pathForGroup(group))} to how it was before?
                        <button type="button" onClick={() => undoGroup(group)} disabled={busy}>
                          Yes, restore
                        </button>
                        <button type="button" onClick={() => setConfirmKey(null)} disabled={busy}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmKey(group.key)}
                        disabled={busy}
                        aria-label={`Undo ${titleForGroup(group)}`}
                      >
                        undo ↩
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
