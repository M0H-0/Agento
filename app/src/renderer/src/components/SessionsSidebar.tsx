import type { SessionSummary } from '../chat/transport'
import SidecarStatusDot from './SidecarStatusDot'
import WorkspacePicker from './WorkspacePicker'

interface SessionsSidebarProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onNewChat: () => void
  onOpenSession: (session: SessionSummary) => void
  onOpenSettings: () => void
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

// Per-session token totals (M1.5, docs/03 §4) — plain number formatting, no
// library; only rendered once the session has recorded usage.
function formatUsage(usage: { inputTokens: number; outputTokens: number }): string {
  return `${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out`
}

// Left rail (docs/04 §2/§4): new chat + chronological sessions, most recent
// first. The UI-polish shell pins Settings + the sidecar status dot to this
// rail's footer (was floating top-right chrome over the panels).
function SessionsSidebar({
  sessions,
  activeSessionId,
  onNewChat,
  onOpenSession,
  onOpenSettings
}: SessionsSidebarProps): React.JSX.Element {
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
          <li key={session.id}>
            <button
              type="button"
              className={
                session.id === activeSessionId
                  ? 'session-item session-item--active'
                  : 'session-item'
              }
              onClick={() => onOpenSession(session)}
              title={session.title}
            >
              <span className="session-item-title">{session.title}</span>
              {session.usage && (
                <span className="session-item-usage">{formatUsage(session.usage)}</span>
              )}
              <span className="session-item-time">{formatRelativeTime(session.updatedAt)}</span>
            </button>
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
