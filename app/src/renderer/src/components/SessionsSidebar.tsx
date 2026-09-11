import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '../chat/transport'
import { relativeTime } from '../chat/locale'
import type { StringKey } from '../chat/locale'
import { useLocale } from './locale-context'
import SidecarStatusDot from './SidecarStatusDot'
import WorkspacePicker from './WorkspacePicker'

interface SessionsSidebarProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onNewChat: () => void
  onOpenSession: (session: SessionSummary) => void
  onOpenSettings: () => void
  onOpenOverview: () => void
  onRenameSession: (session: SessionSummary, title: string) => Promise<void>
  onDeleteSession: (session: SessionSummary) => Promise<void>
  /** Whether the Settings dialog is currently open — refreshes the badge. */
  settingsOpen: boolean
  /** Forwarded picker signal: fires on mount and every folder switch. */
  onWorkspaceChanged?: (path: string | null) => void
}

// Settings attention badge (gap 2): lit ONLY when the active provider is a
// built-in (key-mandatory) provider with no stored key — custom profiles may
// legally be keyless (main's providerRequiresKey rule, mirrored without new
// IPC: built-ins in snapshot.providers always need keys). Dismissed once the
// user visits Settings (per-provider localStorage flag); resolving the key
// clears the condition itself.
const SETTINGS_BADGE_DISMISS_PREFIX = 'agento.settings.badgeSeen:'

function readBadgeDismissed(provider: string): boolean {
  try {
    return window.localStorage.getItem(`${SETTINGS_BADGE_DISMISS_PREFIX}${provider}`) !== null
  } catch {
    return false
  }
}

function writeBadgeDismissed(provider: string): void {
  try {
    window.localStorage.setItem(`${SETTINGS_BADGE_DISMISS_PREFIX}${provider}`, '1')
  } catch {
    // Private-mode quota failures must never break the rail.
  }
}

// The folder tag for each chat (per-session workspace_path, docs/03 §8) —
// folder name only, so consecutive chats in the same workspace no longer
// repeat the full path down the rail. The full path stays in the row's
// tooltip. '' placeholder rows (created before any pick) say so honestly.
function workspaceFolderName(path: string, noFolder: string): string {
  if (!path) return noFolder
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : path
}

// Date groups for the session list (docs/04 §2) — local calendar days, no
// date library. Today / Yesterday / Earlier this week (Monday–Sunday) /
// Older. Invalid or future timestamps fall back to Today so a row never
// vanishes into the wrong bucket. Keys are locale-free; labels come from
// sidebar.today/yesterday/earlierWeek/older at render time.
type DateGroupKey = 'today' | 'yesterday' | 'earlierWeek' | 'older'

const DATE_GROUP_LABEL_KEYS: Record<DateGroupKey, StringKey> = {
  today: 'sidebar.today',
  yesterday: 'sidebar.yesterday',
  earlierWeek: 'sidebar.earlierWeek',
  older: 'sidebar.older'
}

function getDateGroup(iso: string): DateGroupKey {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'today'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate())
  const dayMs = 24 * 60 * 60 * 1000
  const diffDays = Math.round((startOfToday.getTime() - startOfThen.getTime()) / dayMs)
  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  // Monday-start week containing today; days since Monday (0 = Monday).
  const dayOfWeek = (startOfToday.getDay() + 6) % 7
  const startOfWeek = new Date(startOfToday.getTime() - dayOfWeek * dayMs)
  if (startOfThen.getTime() >= startOfWeek.getTime()) return 'earlierWeek'
  return 'older'
}

const DATE_GROUP_ORDER: DateGroupKey[] = ['today', 'yesterday', 'earlierWeek', 'older']

// Sort toggle state (view preference — lives in localStorage, never IPC or
// Settings). Default Recency; the last pick is remembered across reloads.
type SortMode = 'recency' | 'folder'

const SIDEBAR_SORT_KEY = 'agento.sidebar.sort'
const SIDEBAR_COLLAPSED_KEY = 'agento.sidebar.collapsed'

function readSortMode(): SortMode {
  try {
    return window.localStorage.getItem(SIDEBAR_SORT_KEY) === 'folder' ? 'folder' : 'recency'
  } catch {
    return 'recency'
  }
}

function readCollapsedKeys(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))
  } catch {
    return new Set()
  }
}

// Folder grouping key — case-insensitive so Windows case variants of the
// same folder land in one section. '' (pre-pick rows) is its own group.
function folderKey(path: string): string {
  return path.toLowerCase()
}

// Section header label — bare leaf name, except when two visible folders
// share a leaf (sibling checkouts both ending in `btw`): those get the last
// two segments so they stay tellable apart. Full path is always in the
// header tooltip regardless.
function folderDisplayName(path: string, colliding: boolean, noFolder: string): string {
  if (!path) return noFolder
  const segments = path.split(/[\\/]/).filter(Boolean)
  if (segments.length === 0) return path
  const leaf = segments[segments.length - 1]
  if (!colliding || segments.length < 2) return leaf
  return `${leaf} — ${segments.slice(-2).join('\\')}`
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
  const { t } = useLocale()
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
        aria-label={t('sidebar.chatName')}
      />
      <span className="session-rename-hint">{t('sidebar.renameHint')}</span>
    </div>
  )
}

// Left rail (docs/04 §2/§4): new chat + sessions under a Recency | Folder
// sort toggle. Recency groups under date headers (Today / Yesterday /
// Earlier this week / Older), most recent first, each row with a compact
// folder-name tag (full path in the tooltip). Folder groups each folder's
// chats together (current folder first, newest inside) with the path once in
// the section header. Both share the hover "…" menu (rename / delete — the
// delete confirm states that the chat's undo history goes too). The
// UI-polish shell pins Settings + the sidecar status dot to this rail's
// footer.
function SessionsSidebar({
  sessions,
  activeSessionId,
  onNewChat,
  onOpenSession,
  onOpenSettings,
  onOpenOverview,
  onRenameSession,
  onDeleteSession,
  settingsOpen,
  onWorkspaceChanged
}: SessionsSidebarProps): React.JSX.Element {
  const { locale, t } = useLocale()
  const noFolderLabel = t('sidebar.noFolder')
  // Per-row menu state. Only one row is ever in a special state; ids are the
  // session's, which also means closing on re-render is never required.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleteConfirmFor, setDeleteConfirmFor] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [menuError, setMenuError] = useState<string | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>(readSortMode)
  // The picker's current workspace, used ONLY to pin its section first in
  // Folder mode. Pushed up by <WorkspacePicker onChanged> on mount and every
  // pick/set — plus the lazy fetch below for first paint — so the order
  // follows a workspace switch immediately. A read failure degrades to
  // newest-first ordering, never a broken list.
  const [currentWorkspace, setCurrentWorkspace] = useState<string | null>(null)
  // Collapsed sections — folder keys (case-insensitive paths, '' for No
  // folder) plus 'date:<bucket>' keys for Recency mode. All expanded by
  // default; the set persists in localStorage across reloads. A Windows path
  // can never contain a colon, so the 'date:' prefix cannot collide with a
  // folder key.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(readCollapsedKeys)
  // Settings badge: the provider id needing a key, or null when nothing is
  // actionable. Refreshed on mount and whenever the dialog closes (a key may
  // have been saved). `dismissedTick` re-renders after a visit-dismiss.
  const [needsKeyProvider, setNeedsKeyProvider] = useState<string | null>(null)
  const [dismissedTick, setDismissedTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    window.agento.settings
      .get()
      .then((snapshot) => {
        if (cancelled) return
        const builtIn = snapshot.providers.includes(snapshot.provider)
        setNeedsKeyProvider(builtIn && !snapshot.hasKey ? snapshot.provider : null)
      })
      .catch(() => {
        // A settings read failure leaves the badge hidden, never stuck on.
      })
    return () => {
      cancelled = true
    }
  }, [settingsOpen])

  // `dismissedTick` has no value of its own — writing the dismiss flag to
  // localStorage doesn't re-render, so the tick forces one.
  void dismissedTick
  const showSettingsBadge = needsKeyProvider !== null && !readBadgeDismissed(needsKeyProvider)

  const handleOpenSettings = (): void => {
    if (needsKeyProvider) {
      writeBadgeDismissed(needsKeyProvider)
      setDismissedTick((tick) => tick + 1)
    }
    onOpenSettings()
  }

  // Stable: WorkspacePicker's refresh() identity (and its mount effect)
  // depends on this, so it must never change between renders — the parent
  // must pass a stable callback (App passes the raw useState setter).
  const handleWorkspaceChanged = useCallback(
    (path: string | null) => {
      setCurrentWorkspace(path)
      onWorkspaceChanged?.(path)
      // Auto-expand the folder you just moved to, so you see where you went.
      if (path) {
        const key = folderKey(path)
        setCollapsedKeys((prev) => {
          if (!prev.has(key)) return prev
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [onWorkspaceChanged]
  )

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_SORT_KEY, sortMode)
    } catch {
      // Private-mode style quota failures must never break the rail.
    }
  }, [sortMode])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify([...collapsedKeys]))
    } catch {
      // Private-mode style quota failures must never break the rail.
    }
  }, [collapsedKeys])

  useEffect(() => {
    if (sortMode !== 'folder') return
    let cancelled = false
    window.agento.workspaces
      .get()
      .then((snapshot) => {
        if (!cancelled) setCurrentWorkspace(snapshot.current)
      })
      .catch(() => {
        // Deviation: never crash the rail on a workspace read failure.
      })
    return () => {
      cancelled = true
    }
  }, [sortMode])

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
      setMenuError(error instanceof Error ? error.message : t('sidebar.renameFailed'))
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
      setMenuError(error instanceof Error ? error.message : t('sidebar.deleteFailed'))
    } finally {
      setBusyId(null)
    }
  }

  // Sessions arrive most-recent-first (main's updated_at DESC); grouping
  // preserves that order inside each date bucket.
  const groupedSessions: { key: DateGroupKey; items: SessionSummary[] }[] = DATE_GROUP_ORDER.map(
    (key) => ({
      key,
      items: sessions.filter((session) => getDateGroup(session.updatedAt) === key)
    })
  ).filter((group) => group.items.length > 0)

  // Folder mode: one section per workspace (first-seen order is already
  // newest-first), pinned with the picker's current folder on top and the
  // rest by their newest chat. Chats stay newest-first inside each folder.
  const folderGroups: { key: string; path: string; label: string; items: SessionSummary[] }[] =
    (() => {
      const seen = new Map<string, { path: string; items: SessionSummary[] }>()
      for (const session of sessions) {
        const key = folderKey(session.workspacePath)
        const group = seen.get(key)
        if (group) group.items.push(session)
        else seen.set(key, { path: session.workspacePath, items: [session] })
      }
      const leafCounts = new Map<string, number>()
      for (const group of seen.values()) {
        const leaf = workspaceFolderName(group.path, noFolderLabel).toLowerCase()
        leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1)
      }
      const groups = [...seen.entries()].map(([key, group]) => ({
        key,
        path: group.path,
        label: folderDisplayName(
          group.path,
          (leafCounts.get(workspaceFolderName(group.path, noFolderLabel).toLowerCase()) ?? 0) > 1,
          noFolderLabel
        ),
        items: group.items
      }))
      const currentKey = currentWorkspace ? folderKey(currentWorkspace) : null
      if (currentKey === null) return groups
      return groups.sort((a, b) => {
        if (a.key === currentKey && b.key !== currentKey) return -1
        if (b.key === currentKey && a.key !== currentKey) return 1
        return 0
      })
    })()

  const renderRow = (session: SessionSummary, showFolderTag: boolean): React.JSX.Element => (
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
              session.id === activeSessionId ? 'session-item session-item--active' : 'session-item'
            }
            onClick={() => onOpenSession(session)}
            title={
              session.workspacePath ? `${session.title}\n${session.workspacePath}` : session.title
            }
          >
            <span className="session-item-title">
              <bdi>{session.title}</bdi>
            </span>
            <span className="session-item-meta">
              {showFolderTag ? (
                <>
                  <span
                    className="session-item-folder"
                    title={session.workspacePath ? session.workspacePath : undefined}
                  >
                    {workspaceFolderName(session.workspacePath, noFolderLabel)}
                  </span>
                  <span className="session-item-dot" aria-hidden="true">
                    ·
                  </span>
                </>
              ) : null}
              <span className="session-item-time">{relativeTime(locale, session.updatedAt)}</span>
            </span>
          </button>
          <button
            type="button"
            className="session-menu-btn"
            aria-label={t('sidebar.chatOptions', { title: session.title })}
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
              aria-label={t('sidebar.chatOptions', { title: session.title })}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) closeMenus()
              }}
            >
              {deleteConfirmFor === session.id ? (
                <>
                  <p className="session-menu-confirm">{t('sidebar.deleteConfirm')}</p>
                  {menuError ? <p className="session-menu-error">{menuError}</p> : null}
                  <div className="session-menu-actions">
                    <button
                      type="button"
                      role="menuitem"
                      className="session-menu-danger"
                      onClick={() => void handleDeleteConfirm(session)}
                      disabled={busyId !== null}
                    >
                      {t('sidebar.delete')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={closeMenus}
                      disabled={busyId !== null}
                    >
                      {t('sidebar.keep')}
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
                    {t('sidebar.rename')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDeleteConfirmFor(session.id)
                      setMenuError(null)
                    }}
                  >
                    {t('sidebar.delete')}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </>
      )}
    </li>
  )

  const toggleSectionCollapsed = (key: string): void => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <nav className="sessions-sidebar" aria-label={t('sidebar.sessions')}>
      {/* M2.2: the workspace chip + recents live at the top of the rail — they
          are app-level state, not per-session. onChanged keeps Folder mode's
          first-section pin + auto-expand following a switch. */}
      <WorkspacePicker onChanged={handleWorkspaceChanged} />
      <button type="button" className="sessions-overview-btn" onClick={onOpenOverview}>
        {t('sidebar.workspaceOverview')}
      </button>
      <button type="button" className="sessions-new-chat" onClick={onNewChat}>
        {t('sidebar.newChat')}
      </button>
      <div className="sessions-header-row">
        <h2 className="sessions-section-label">{t('sidebar.conversations')}</h2>
        <div className="sort-toggle" role="group" aria-label={t('sidebar.sortBy')}>
          <button
            type="button"
            className={
              sortMode === 'recency' ? 'sort-toggle-btn sort-toggle-btn--active' : 'sort-toggle-btn'
            }
            aria-pressed={sortMode === 'recency'}
            onClick={() => setSortMode('recency')}
          >
            {t('sidebar.recency')}
          </button>
          <button
            type="button"
            className={
              sortMode === 'folder' ? 'sort-toggle-btn sort-toggle-btn--active' : 'sort-toggle-btn'
            }
            aria-pressed={sortMode === 'folder'}
            onClick={() => setSortMode('folder')}
          >
            {t('sidebar.folder')}
          </button>
        </div>
      </div>
      <div className="sessions-list">
        {sortMode === 'recency'
          ? groupedSessions.map((group) => {
              const key = `date:${group.key}`
              const collapsed = collapsedKeys.has(key)
              const label = t(DATE_GROUP_LABEL_KEYS[group.key])
              return (
                <section key={group.key} aria-label={label} className="sessions-group">
                  <h3 className="sessions-date-header sessions-folder-header">
                    <button
                      type="button"
                      className="sessions-section-toggle"
                      aria-expanded={!collapsed}
                      aria-label={t(collapsed ? 'sidebar.expandChats' : 'sidebar.collapseChats', {
                        name: label
                      })}
                      onClick={() => toggleSectionCollapsed(key)}
                    >
                      <span
                        className={
                          collapsed
                            ? 'sessions-section-chevron sessions-section-chevron--collapsed'
                            : 'sessions-section-chevron'
                        }
                        aria-hidden="true"
                      >
                        ▸
                      </span>
                      <span className="sessions-section-text">
                        {label} · {group.items.length}
                      </span>
                    </button>
                  </h3>
                  {collapsed ? null : (
                    <ul className="sessions-group-list">
                      {group.items.map((session) => renderRow(session, true))}
                    </ul>
                  )}
                </section>
              )
            })
          : folderGroups.map((group) => {
              const collapsed = collapsedKeys.has(group.key)
              return (
                <section key={group.key} aria-label={group.label} className="sessions-group">
                  <h3 className="sessions-date-header sessions-folder-header">
                    <button
                      type="button"
                      className="sessions-section-toggle"
                      aria-expanded={!collapsed}
                      aria-label={t(
                        collapsed ? 'sidebar.expandChatsIn' : 'sidebar.collapseChatsIn',
                        { name: group.label }
                      )}
                      title={group.path ? group.path : undefined}
                      onClick={() => toggleSectionCollapsed(group.key)}
                    >
                      <span
                        className={
                          collapsed
                            ? 'sessions-section-chevron sessions-section-chevron--collapsed'
                            : 'sessions-section-chevron'
                        }
                        aria-hidden="true"
                      >
                        ▸
                      </span>
                      <span className="sessions-section-text">
                        {group.label} · {group.items.length}
                      </span>
                    </button>
                  </h3>
                  {collapsed ? null : (
                    <ul className="sessions-group-list">
                      {group.items.map((session) => renderRow(session, false))}
                    </ul>
                  )}
                </section>
              )
            })}
      </div>
      <footer className="sessions-footer">
        <SidecarStatusDot />
        <span className="sessions-settings-wrap">
          <button
            type="button"
            className="sessions-footer-settings"
            onClick={handleOpenSettings}
            aria-haspopup="dialog"
            aria-label={showSettingsBadge ? t('sidebar.noKeyButton') : t('sidebar.settings')}
            title={showSettingsBadge ? t('sidebar.noKeyTooltip') : t('sidebar.settings')}
          >
            {t('sidebar.settings')}
          </button>
          {showSettingsBadge ? <span className="sessions-settings-dot" aria-hidden="true" /> : null}
        </span>
      </footer>
    </nav>
  )
}

export default SessionsSidebar
