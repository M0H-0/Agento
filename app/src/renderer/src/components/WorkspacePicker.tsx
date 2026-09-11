import { useCallback, useEffect, useState } from 'react'

// Workspace picker (M2.2, docs/03 §4 workspace/*): the native folder dialog
// lives in main — this component only shows the current workspace + recents
// and asks main to pick or re-apply. Recents persist across restarts
// (main-side workspaces.json); picking one attaches it to the NEXT new
// session (session:create stamps it main-side).

interface WorkspaceRecent {
  path: string
  lastOpenedAt: string
}

// Path formatting for the chip — never abbreviate on an ambiguous spot; show
// the tail (the part a user recognizes) with an ellipsis head when needed.
function formatPath(path: string | null): string {
  if (!path) return 'No workspace selected'
  if (path.length <= 46) return path
  // Keep the last two segments recognizable: `…\📁 Projects\agency`
  const segments = path.split(/[\\/]/).filter(Boolean)
  const tail = segments.slice(-2).join('\\')
  return `…\\${tail}`
}

function formatRecentTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function WorkspacePicker({
  onChanged
}: {
  onChanged?: (path: string | null) => void
}): React.JSX.Element {
  const [current, setCurrent] = useState<string | null>(null)
  const [recents, setRecents] = useState<WorkspaceRecent[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const snapshot = await window.agento.workspaces.get()
      setCurrent(snapshot.current)
      setRecents(snapshot.recents)
      // The sidebar's Folder mode pins this folder's section first — push
      // the fresh value up so its order follows a switch immediately.
      onChanged?.(snapshot.current)
    } catch {
      // Deviation: never crash the rail on a workspace read failure.
    }
  }, [onChanged])

  useEffect(() => {
    // StrictMode-safe: state lands in the promise callbacks, never
    // synchronously inside the effect (the M1.3 renderer rule). The parent
    // learns the initial value here too, so Folder mode pins correctly on
    // first paint without waiting for a pick.
    let cancelled = false
    window.agento.workspaces
      .get()
      .then((snapshot) => {
        if (cancelled) return
        setCurrent(snapshot.current)
        setRecents(snapshot.recents)
        onChanged?.(snapshot.current)
      })
      .catch(() => {
        // Deviation: never crash the rail on a workspace read failure.
      })
    return () => {
      cancelled = true
    }
  }, [onChanged])

  const choose = useCallback(async () => {
    setError(null)
    try {
      const picked = await window.agento.workspaces.pick()
      if (picked) await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open that folder.')
    }
  }, [refresh])

  const applyRecent = useCallback(
    async (path: string) => {
      setError(null)
      try {
        await window.agento.workspaces.set({ path })
        setOpen(false)
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not use that folder.')
      }
    },
    [refresh]
  )

  return (
    <div className="workspace-picker">
      <button
        type="button"
        className="workspace-chip"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          current
            ? `Folder new chats will use: ${current}\nEach chat keeps the folder it was created in.`
            : 'Pick a folder — new chats will work in it.'
        }
      >
        <span className="workspace-chip-label">Workspace</span>
        <span className="workspace-chip-path">{formatPath(current)}</span>
      </button>

      {open && (
        <ul className="workspace-menu" role="listbox" aria-label="Recent workspaces">
          {recents.length === 0 && !current && (
            <li className="workspace-menu-empty">Pick a folder for new chats to work in.</li>
          )}
          {recents.map((recent) => (
            <li key={recent.path}>
              <button
                type="button"
                className="workspace-menu-item"
                role="option"
                aria-selected={current === recent.path}
                onClick={() => void applyRecent(recent.path)}
                title={recent.path}
              >
                <span className="workspace-menu-path">{formatPath(recent.path)}</span>
                <span className="workspace-menu-time">{formatRecentTime(recent.lastOpenedAt)}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="workspace-menu-pick" onClick={() => void choose()}>
              Choose folder…
            </button>
          </li>
        </ul>
      )}

      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
