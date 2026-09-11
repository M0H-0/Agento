import { useEffect, useState } from 'react'
import type { SessionSummary } from '../chat/transport'
import { genericPrompts, suggestPromptsFromScan } from '../chat/suggestions'
import { formatTokenCount, lastActiveAt, summarizeFolderSessions } from '../chat/folder-activity'
import { plural, relativeTime } from '../chat/locale'
import { useLocale } from './locale-context'
import {
  summarizeWorkspaceFiles,
  workspaceTail,
  type SnapshotFile
} from '../chat/workspace-summary'

// Workspace Overview (demo destination, renderer-only): a calm non-chat home
// for the current folder — what is here, folder-scoped activity the sidebar
// never aggregates (chat/draft/token counts), one resume card instead of a
// second recency list, and contextual task starters. Read-only composition
// over existing IPC (`workspace:list-files`, the sessions prop; the current
// folder arrives as a prop pushed up from the sidebar picker); chips fill
// the composer only, never auto-send. No file tree, no previews, no actions.

export interface WorkspaceOverviewProps {
  sessions: SessionSummary[]
  /** Current folder, pushed up from the sidebar picker through App — the
      overview never reads it itself, so a switch while mounted follows. */
  workspacePath: string | null
  onOpenSession: (session: SessionSummary) => void
  onNewChat: () => void
  onStartTask: (prompt: string) => void
  onBack: () => void
}

function folderLeaf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function WorkspaceOverview({
  sessions,
  workspacePath,
  onOpenSession,
  onNewChat,
  onStartTask,
  onBack
}: WorkspaceOverviewProps): React.JSX.Element {
  const { locale, t } = useLocale()
  const [files, setFiles] = useState<SnapshotFile[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [prompts, setPrompts] = useState<string[]>(() => genericPrompts())

  useEffect(() => {
    let cancelled = false
    // No folder yet (picker hasn't reported) — the title falls back to the
    // pick-a-folder note until the prop lands and this re-runs.
    if (!workspacePath) return
    window.agento.workspaces
      .listFiles({ limit: 500 })
      .then((listing) => {
        if (cancelled) return
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
          setLoadError(t('overview.readFailed'))
          setPrompts(genericPrompts())
        }
      })
    return () => {
      cancelled = true
    }
    // sessions titles feed the pricing-chip evidence; re-scan when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.length, workspacePath])

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
        {t('overview.back')}
      </button>

      <h1 className="workspace-overview__title">
        {workspacePath ? folderLeaf(workspacePath) : t('overview.yourWorkspace')}
      </h1>
      <p className="workspace-overview__path" title={workspacePath ?? undefined}>
        {workspacePath ? workspaceTail(workspacePath) : t('overview.pickFolder')}
      </p>

      {loadError ? (
        <p className="workspace-overview__error" role="alert">
          {loadError}
        </p>
      ) : null}

      <section aria-label={t('overview.whatsHere')}>
        <h2 className="workspace-overview__heading">{t('overview.whatsHere')}</h2>
        {snapshot === null ? (
          <p className="workspace-overview__note">{t('overview.reading')}</p>
        ) : snapshot.fileCount === 0 && snapshot.folderCount === 0 ? (
          <p className="workspace-overview__note">{t('overview.emptyFolderNote')}</p>
        ) : (
          <p className="workspace-overview__note">
            {t('overview.counts', {
              files: snapshot.fileCount,
              folders: snapshot.folderCount,
              documents: snapshot.documents
            })}
          </p>
        )}
        {snapshot !== null && (snapshot.fileCount > 0 || snapshot.folderCount > 0) ? (
          <ul className="workspace-overview__stats">
            <li>
              <span className="workspace-overview__stat-num">{snapshot.documents}</span>
              <span className="workspace-overview__stat-label">{t('overview.documents')}</span>
            </li>
            <li>
              <span className="workspace-overview__stat-num">{snapshot.images}</span>
              <span className="workspace-overview__stat-label">{t('overview.images')}</span>
            </li>
            <li>
              <span className="workspace-overview__stat-num">{snapshot.spreadsheets}</span>
              <span className="workspace-overview__stat-label">{t('overview.spreadsheets')}</span>
            </li>
            <li>
              <span className="workspace-overview__stat-num">{snapshot.others}</span>
              <span className="workspace-overview__stat-label">{t('overview.other')}</span>
            </li>
          </ul>
        ) : null}
      </section>

      {activityLine ? (
        <section aria-label={t('overview.activity')}>
          <h2 className="workspace-overview__heading">{t('overview.activity')}</h2>
          <ul className="workspace-overview__stats">
            <li>
              <span className="workspace-overview__stat-num">{activityLine.chatCount}</span>
              <span className="workspace-overview__stat-label">
                {plural(locale, activityLine.chatCount, {
                  one: t('overview.chatsOne'),
                  two: t('overview.chatsTwo'),
                  many: t('overview.chatsMany')
                })}
              </span>
            </li>
            {lastActive ? (
              <li>
                <span className="workspace-overview__stat-num">
                  {relativeTime(locale, lastActive)}
                </span>
                <span className="workspace-overview__stat-label">{t('overview.lastActive')}</span>
              </li>
            ) : null}
            {activityLine.totalTokens > 0 ? (
              <li>
                <span className="workspace-overview__stat-num">
                  {formatTokenCount(activityLine.totalTokens)}
                </span>
                <span className="workspace-overview__stat-label">{t('overview.tokensUsed')}</span>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {resume ? (
        <section aria-label={t(resume.usage ? 'overview.resume' : 'overview.draft')}>
          <h2 className="workspace-overview__heading">
            {t(resume.usage ? 'overview.resume' : 'overview.draft')}
          </h2>
          <ul className="workspace-overview__recent">
            <li>
              <button
                type="button"
                className="workspace-overview__recent-item"
                onClick={() => onOpenSession(resume)}
                title={resume.title}
              >
                <span className="workspace-overview__recent-title">
                  <bdi>{resume.title}</bdi>
                </span>
                <span className="workspace-overview__recent-time">
                  {t(resume.mode === 'plan' ? 'app.planTab' : 'app.actTab')} ·{' '}
                  {resume.usage
                    ? t('overview.tokens', {
                        n: formatTokenCount(resume.usage.inputTokens + resume.usage.outputTokens)
                      })
                    : t('overview.noMessages')}{' '}
                  · {relativeTime(locale, resume.updatedAt)}
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
        <section aria-label={t(isEmptyFolder ? 'overview.thingsToTry' : 'overview.commonTasks')}>
          <h2 className="workspace-overview__heading">
            {t(isEmptyFolder ? 'overview.thingsToTry' : 'overview.commonTasks')}
          </h2>
          <div
            className="quick-actions workspace-overview__chips"
            role="list"
            aria-label={t('overview.taskStarters')}
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
          {t('overview.startTask')}
        </button>
      </div>
    </div>
  )
}

export default WorkspaceOverview
