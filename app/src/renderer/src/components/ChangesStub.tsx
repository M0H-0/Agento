import { useEffect, useState } from 'react'
import type { ChangeEntry } from '../../../preload/index'

// Changes stub (M2.5; full panel is M3): lists a session's checkpoints so a
// create/write run's durability is visible in the UI ("Done when: a
// create/write run lands a checkpoint that the Changes view can see").
// Refreshes when the refreshKey advances (the App bumps it on run settle).
// The full M3 panel adds undo actions, grouping, and the eviction warnings.
export interface ChangesStubProps {
  sessionId: string | null
  refreshKey: number
}

function titleForEntry(entry: ChangeEntry): string {
  switch (entry.tool) {
    case 'write_file':
      return entry.existed ? 'Overwrote file' : 'Wrote file'
    case 'edit_file':
      return 'Edited file'
    case 'create_dir':
      return 'Created folder'
    case 'move_path':
      return 'Moved file'
    case 'copy_path':
      return 'Copied file'
    case 'delete_path':
      return 'Deleted file'
    default:
      return entry.tool
  }
}

export function ChangesStub({ sessionId, refreshKey }: ChangesStubProps): React.JSX.Element | null {
  const [entries, setEntries] = useState<ChangeEntry[]>([])
  const [activeCount, setActiveCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Passive-listener pattern (SidecarStatusDot): state lands in the promise
    // callbacks, never synchronously in the effect body (M1.3 rule). The
    // null-session reset also happens in a microtask callback.
    let cancelled = false
    const reset = (): void => {
      if (cancelled) return
      setEntries([])
      setActiveCount(0)
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

  return (
    <aside className="changes-stub" aria-label="Changes">
      <h2 className="changes-stub__title">
        Changes{' '}
        {activeCount > 0 ? <span className="changes-stub__count">{activeCount}</span> : null}
      </h2>
      {error ? <div className="changes-stub__error">{error}</div> : null}
      {entries.length === 0 && !error ? (
        <div className="changes-stub__empty">No file changes yet in this conversation.</div>
      ) : (
        <ul className="changes-stub__list">
          {entries.map((entry) => (
            <li key={entry.id} className="changes-stub__item">
              <span className="changes-stub__item-title">{titleForEntry(entry)}</span>
              <span className="changes-stub__item-path">{entry.relativePath}</span>
              <span className="changes-stub__item-meta">
                {entry.existed ? 'replaced existing' : 'new'}
                {entry.size !== null ? ` · ${entry.size} B snapshot` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
