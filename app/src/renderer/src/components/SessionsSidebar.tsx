import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '../chat/transport'
import SidecarStatusDot from './SidecarStatusDot'
import WorkspacePicker from './WorkspacePicker'

interface SessionsSidebarProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onNewChat: () => void
  onOpenSession: (session: SessionSummary) => void
  onOpenSettings: () => void
  onRenameSession: (session: SessionSummary, title: string) => Promise<void>
  onDeleteSession: (session: SessionSummary) => Promise<void>
}

// Relative timestamps for the session list — small local helper, no
// date library (STACK.md is the law); ISO-8601 strings from main.
function formatRelativeTime(iso: string): string {
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

// The folder each chat is bound to (per-session workspace_path, docs/03 §8) —
// the path itself, not just the leaf name, so chats in sibling folders are
// tellable apart at a glance. Short paths render whole; longer ones keep the
// last two segments recognizable with an ellipsis head (same treatment as the
// workspace chip). '' placeholder rows (created before any pick) say so
// honestly instead of inventing a folder; the full path stays in the tooltip.
function formatWorkspacePath(path: string): string {
  if (!path) return 'No folder'
  if (path.length <= 46) return path
  const segments = path.split(/[\\/]/).filter(Boolean)
  return `…\\${segments.slice(-2).join('\\')}`
}

// One row's rename editor. Enter or blur commits, Escape cancels (docs/04 §2
// rename gesture). The trimmed-empty title is refused client-side — a chat
// always has a name.
function SessionRename({
  session,
  busy,
  onCommit,
  onCancel
}: {
  session: SessionSummary
  busy: boolean
  onCommit: (title: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(session.title)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.select()
  }, [])
  const commit = (): void => {
    const title = draft.trim()
    if (busy) return
    if (!title || title === session.title) {
      onCancel()
      return
    }
    onCommit(title)
  }
  return (
    <div className="session-rename">
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        onBlur={commit}
        disabled={busy}
        maxLength={120}
        aria-label="Chat name"
      />
      <span className="session-rename-hint">Enter to rename · Esc to cancel</span>
    </div>
  )
}

// Left rail (docs/04 §2/§4): new chat + chronological sessions, most recent
// first, each with a hover "…" menu (rename / delete — the delete confirm
// states that the chat's undo history goes too). The UI-polish shell pins
// Settings + the sidecar status dot to this rail's footer.
function SessionsSidebar({
  sessions,
  activeSessionId,
  onNewChat,
  onOpenSession,
  onOpenSettings,
  onRenameSession,
  onDeleteSession
}: SessionsSidebarProps): React.JSX.Element {
  // Per-row menu state. Only one row is ever in a special state; ids are the
  // session's, which also means closing on re-render is never required.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleteConfirmFor, setDeleteConfirmFor] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [menuError, setMenuError] = useState<string | null>(null)

  const closeMenus = (): void => {
    setMenuFor(null)
    setDeleteConfirmFor(null)
    setMenuError(null)
  }

  const handleRenameCommit = async (session: SessionSummary, title: string): Promise<void> => {
    setBusyId(session.id)
    setMenuError(null)
    try {
      await onRenameSession(session, title)
      setRenamingId(null)
    } catch (error) {
      console.error('session:rename failed:', error)
      setMenuError(error instanceof Error ? error.message : 'Could not rename the chat.')
    } finally {
      setBusyId(null)
    }
  }

  const handleDeleteConfirm = async (session: SessionSummary): Promise<void> => {
    setBusyId(session.id)
    setMenuError(null)
    try {
      await onDeleteSession(session)
      closeMenus()
    } catch (error) {
      console.error('session:delete failed:', error)
      setMenuError(error instanceof Error ? error.message : 'Could not delete the chat.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <nav className="sessions-sidebar" aria-label="Sessions">
      {/* M2.2: the workspace chip + recents live at the top of the rail — they
          are app-level state, not per-session. */}
      <WorkspacePicker />
      <button type="button" className="sessions-new-chat" onClick={onNewChat}>
        + New chat
      </button>
      <h2 className="sessions-section-label">Conversations</h2>
      <ul className="sessions-list">
        {sessions.map((session) => (
          <li key={session.id} className="session-row">
            {renamingId === session.id ? (
              <SessionRename
                session={session}
                busy={busyId === session.id}
                onCommit={(title) => void handleRenameCommit(session, title)}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <>
                <button
                  type="button"
                  className={
                    session.id === activeSessionId
                      ? 'session-item session-item--active'
                      : 'session-item'
                  }
                  onClick={() => onOpenSession(session)}
                  title={
                    session.workspacePath
                      ? `${session.title}\n${session.workspacePath}`
                      : session.title
                  }
                >
                  <span className="session-item-title">{session.title}</span>
                  <span className="session-item-workspace">
                    {formatWorkspacePath(session.workspacePath)}
                  </span>
                  <span className="session-item-time">{formatRelativeTime(session.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  className="session-menu-btn"
                  aria-label={`Chat options for ${session.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === session.id}
                  onClick={() => {
                    if (menuFor === session.id) closeMenus()
                    else {
                      setMenuFor(session.id)
                      setDeleteConfirmFor(null)
                      setMenuError(null)
                    }
                  }}
                >
                  …
                </button>
                {menuFor === session.id ? (
                  <div
                    className="session-menu"
                    role="menu"
                    aria-label={`Chat options for ${session.title}`}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) closeMenus()
                    }}
                  >
                    {deleteConfirmFor === session.id ? (
                      <>
                        <p className="session-menu-confirm">
                          Delete this chat? Its undo history goes too.
                        </p>
                        {menuError ? <p className="session-menu-error">{menuError}</p> : null}
                        <div className="session-menu-actions">
                          <button
                            type="button"
                            role="menuitem"
                            className="session-menu-danger"
                            onClick={() => void handleDeleteConfirm(session)}
                            disabled={busyId !== null}
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={closeMenus}
                            disabled={busyId !== null}
                          >
                            Keep
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        {menuError ? <p className="session-menu-error">{menuError}</p> : null}
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setRenamingId(session.id)
                            closeMenus()
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setDeleteConfirmFor(session.id)
                            setMenuError(null)
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      <footer className="sessions-footer">
        <SidecarStatusDot />
        <button
          type="button"
          className="sessions-footer-settings"
          onClick={onOpenSettings}
          aria-haspopup="dialog"
        >
          Settings
        </button>
      </footer>
    </nav>
  )
}

export default SessionsSidebar
