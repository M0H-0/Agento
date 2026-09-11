import { useEffect, useState } from 'react'
import type { SessionSummary } from '../chat/transport'
import { genericPrompts, suggestPromptsFromScan } from '../chat/suggestions'
import { formatTokenCount, lastActiveAt, summarizeFolderSessions } from '../chat/folder-activity'
import {
  summarizeWorkspaceFiles,
  workspaceTail,
  type SnapshotFile
} from '../chat/workspace-summary'

// Workspace Overview (demo destination, renderer-only): a calm non-chat home
// for the current folder — what is here, folder-scoped activity the sidebar
// never aggregates (chat/draft/token counts), one resume card instead of a
// second recency list, and contextual task starters. Read-only composition
// over existing IPC (`workspaces.get`, `workspace:list-files`, the sessions
// prop); chips fill the composer only, never auto-send. No file tree, no
// previews, no actions.

export interface WorkspaceOverviewProps {
  sessions: SessionSummary[]
  onOpenSession: (session: SessionSummary) => void
  onNewChat: () => void
  onStartTask: (prompt: string) => void
  onBack: () => void
}

function folderLeaf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

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

export function WorkspaceOverview({
  sessions,
  onOpenSession,
  onNewChat,
  onStartTask,
  onBack
}: WorkspaceOverviewProps): React.JSX.Element {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [files, setFiles] = useState<SnapshotFile[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [prompts, setPrompts] = useState<string[]>(() => genericPrompts())

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.agento.workspaces.get(),
      window.agento.workspaces.listFiles({ limit: 500 })
    ])
      .then(([snapshot, listing]) => {
        if (cancelled) return
        setWorkspacePath(snapshot.current)
        setFiles(listing.files)
        setPrompts(
          suggestPromptsFromScan(
            listing.files,
            sessions.map((session) => session.title)
          )
        )
        setLoadError(null)
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('Could not read this folder right now.')
          setPrompts(genericPrompts())
        }
      })
    return () => {
      cancelled = true
    }
    // sessions titles feed the pricing-chip evidence; re-scan when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.length])

  const snapshot = files ? summarizeWorkspaceFiles(files) : null
  const isEmptyFolder = files !== null && files.length === 0
  const folderSessions = (() => {
    if (!workspacePath) return []
    const current = workspacePath.toLowerCase()
    return sessions.filter((s) => s.workspacePath.toLowerCase() === current)
  })()
  // One resume card, not a second recency list: the newest session bound to
  // this folder. A settled run makes it "pick up where you left off"; a
  // null-usage session is a draft that never sent anything.
  const resume = folderSessions.reduce<SessionSummary | null>((latest, s) => {
    if (!latest) return s
    const a = new Date(latest.updatedAt).getTime()
    const b = new Date(s.updatedAt).getTime()
    if (Number.isNaN(b)) return latest
    if (Number.isNaN(a)) return s
    return b > a ? s : latest
  }, null)
  const activityLine =
    workspacePath && folderSessions.length > 0
      ? summarizeFolderSessions(sessions, workspacePath)
      : null
  const lastActive = workspacePath ? lastActiveAt(sessions, workspacePath) : null

  return (
    <div className="workspace-overview">
      <button type="button" className="workspace-overview__back" onClick={onBack}>
        ← Back to chat
      </button>

      <h1 className="workspace-overview__title">
        {workspacePath ? folderLeaf(workspacePath) : 'Your workspace'}
      </h1>
      <p className="workspace-overview__path" title={workspacePath ?? undefined}>
        {workspacePath ? workspaceTail(workspacePath) : 'Pick a folder in the sidebar to begin.'}
      </p>

      {loadError ? (
        <p className="workspace-overview__error" role="alert">
          {loadError}
        </p>
      ) : null}

      <section aria-label="What's here">
        <h2 className="workspace-overview__heading">What&apos;s here</h2>
        {snapshot === null ? (
          <p className="workspace-overview__note">Reading the folder…</p>
        ) : snapshot.fileCount === 0 && snapshot.folderCount === 0 ? (
          <p className="workspace-overview__note">
            This folder is empty — add files with Windows Explorer, then ask Agento to organize or
            summarize them.
          </p>
        ) : (
          <p className="workspace-overview__note">
            {snapshot.fileCount} file{snapshot.fileCount === 1 ? '' : 's'} · {snapshot.folderCount}{' '}
            folder{snapshot.folderCount === 1 ? '' : 's'} · {snapshot.documents} document
            {snapshot.documents === 1 ? '' : 's'}
          </p>
        )}
        {snapshot !== null && (snapshot.fileCount > 0 || snapshot.folderCount > 0) ? (
          <ul className="workspace-overview__stats">
            <li>
              <span className="workspace-overview__stat-num">{snapshot.documents}</span>
              <span className="workspace-overview__stat-label">Documents</span>
            </li>
            <li>
              <span className="workspace-overview__stat-num">{snapshot.images}</span>
              <span className="workspace-overview__stat-label">Images</span>
            </li>
            <li>
              <span className="workspace-overview__stat-num">{snapshot.spreadsheets}</span>
              <span className="workspace-overview__stat-label">Spreadsheets</span>
            </li>
            <li>
              <span className="workspace-overview__stat-num">{snapshot.others}</span>
              <span className="workspace-overview__stat-label">Other</span>
            </li>
          </ul>
        ) : null}
      </section>

      {activityLine ? (
        <section aria-label="Activity in this folder">
          <h2 className="workspace-overview__heading">Activity in this folder</h2>
          <ul className="workspace-overview__stats">
            <li>
              <span className="workspace-overview__stat-num">{activityLine.chatCount}</span>
              <span className="workspace-overview__stat-label">
                Chat{activityLine.chatCount === 1 ? '' : 's'}
              </span>
            </li>
            {lastActive ? (
              <li>
                <span className="workspace-overview__stat-num">
                  {formatRelativeTime(lastActive)}
                </span>
                <span className="workspace-overview__stat-label">Last active</span>
              </li>
            ) : null}
            {activityLine.totalTokens > 0 ? (
              <li>
                <span className="workspace-overview__stat-num">
                  {formatTokenCount(activityLine.totalTokens)}
                </span>
                <span className="workspace-overview__stat-label">Tokens used</span>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {resume ? (
        <section aria-label={resume.usage ? 'Pick up where you left off' : 'Unfinished draft'}>
          <h2 className="workspace-overview__heading">
            {resume.usage ? 'Pick up where you left off' : 'Unfinished draft'}
          </h2>
          <ul className="workspace-overview__recent">
            <li>
              <button
                type="button"
                className="workspace-overview__recent-item"
                onClick={() => onOpenSession(resume)}
                title={resume.title}
              >
                <span className="workspace-overview__recent-title">{resume.title}</span>
                <span className="workspace-overview__recent-time">
                  {resume.mode === 'plan' ? 'Plan' : 'Act'} ·{' '}
                  {resume.usage
                    ? `${formatTokenCount(resume.usage.inputTokens + resume.usage.outputTokens)} tokens`
                    : 'no messages yet'}{' '}
                  · {formatRelativeTime(resume.updatedAt)}
                </span>
                <span className="workspace-overview__open" aria-hidden="true">
                  →
                </span>
              </button>
            </li>
          </ul>
        </section>
      ) : null}

      {files === null ? null : (
        <section aria-label={isEmptyFolder ? 'Things to try' : 'Common tasks'}>
          <h2 className="workspace-overview__heading">
            {isEmptyFolder ? 'Things to try' : 'Common tasks'}
          </h2>
          <div
            className="quick-actions workspace-overview__chips"
            role="list"
            aria-label="Task starters"
          >
            {prompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                role="listitem"
                className="quick-action-chip"
                onClick={() => onStartTask(prompt)}
              >
                <span>{prompt}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="workspace-overview__actions">
        <button type="button" className="sessions-new-chat" onClick={onNewChat}>
          Start a task
        </button>
      </div>
    </div>
  )
}

export default WorkspaceOverview
