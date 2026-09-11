import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive
} from '@assistant-ui/react'
import type { UIMessage } from 'ai'
import { createIpcChatTransport } from './chat/transport'
import type { SessionMode, SessionSummary } from './chat/transport'
import { findPendingAsk } from './chat/ask'
import type { PendingAsk } from './chat/ask'
import { parseAgentEvent } from './chat/agent-events'
import type { PlanStep } from './chat/agent-events'
import type { AgentApprovalRequestedEvent } from '../../preload/index'
import { ApprovalDialog } from './components/ApprovalDialog'
import MarkdownText from './components/MarkdownText'
import { PlanPanel } from './components/PlanPanel'
import ScrollToBottomButton from './components/ScrollToBottomButton'
import SettingsDialog from './components/SettingsDialog'
import SessionsSidebar from './components/SessionsSidebar'
import SidecarStatusDot from './components/SidecarStatusDot'
import ThinkingIndicator from './components/ThinkingIndicator'
import { ChangesPanel } from './components/ChangesPanel'
import { Onboarding } from './components/Onboarding'
import ModelChip from './components/ModelChip'
import QuickActions from './components/QuickActions'
import FileAttach from './components/FileAttach'
import { ToolUIRegistry } from './components/cards/ToolUIRegistry'

// Plan panel state (M3.1 + M3.6 live): fed by the agent:event subscription
// below. The runId disambiguates a fresh plan (new run) from a REVISED plan
// in the same run — only the latter shows the "updated" chip (docs/04 §3.3).
// `statuses`/`verification`/`errors` are fed by plan/step_updated +
// verification/finished (M3.6); absent entries render as pending.
interface PlanPanelState {
  runId: string
  steps: PlanStep[]
  updated: boolean
  statuses: Record<string, string>
  verification: Record<string, { score: number | null; verified: boolean }>
  errors: Record<string, string>
}

// User messages stay plain text (docs/04 §8.3 scopes markdown to model
// replies); assistant text renders as streaming markdown.
function MessageText({ text }: { text: string }): React.JSX.Element {
  return <div className="message-text">{text}</div>
}

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="message message--user">
      <MessagePrimitive.Parts components={{ Text: MessageText }} />
    </MessagePrimitive.Root>
  )
}

function AssistantMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="message message--assistant">
      <ThinkingIndicator />
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
    </MessagePrimitive.Root>
  )
}

// Tail of the workspace path for the welcome eyebrow — the same "keep the
// last two segments recognizable" treatment as the sidebar chip's formatPath.
function formatFolderTail(path: string): string {
  if (path.length <= 46) return path
  const segments = path.split(/[\\/]/).filter(Boolean)
  return `…\\${segments.slice(-2).join('\\')}`
}

// Empty-thread welcome (docs/04 §2). Deliberately two quiet elements — the
// folder chip and, below the composer, the QuickActions chips — matching the
// centered composer-first home layout. The eyebrow names the folder this new
// chat will actually work in (the picker's current pick — the same state
// session:create stamps). Plain useState fetch, state lands in the promise
// callback (StrictMode rule); a failed read degrades to the no-folder copy.
function ThreadWelcome(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.agento.workspaces
      .get()
      .then((snapshot) => {
        if (!cancelled) setWorkspace(snapshot.current)
      })
      .catch(() => {
        // Never crash the welcome on a workspace read failure.
      })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <div className="thread-welcome">
      <p className="thread-welcome-eyebrow">
        {/* Inline folder glyph (no icon dep — STACK.md): 16px grid, stroke
            follows the text color. */}
        <svg
          className="thread-welcome-foldericon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        {workspace ? formatFolderTail(workspace) : 'Pick a folder to work in'}
      </p>
    </div>
  )
}

// Reply-mode composer (docs/03 §7): while an ask_user holds the run, the
// main composer IS the reply box — no card-embedded form. Enter sends
// (Shift+Enter breaks the line, an in-progress IME composition never sends);
// option chips send directly. The reply rides the same tool:answer channel
// the old card form used; on a refusal (stale question) the draft survives
// so the user can Stop or retry. Stop itself stays rendered beside Send —
// it rejects the pending answer and aborts, exactly like chat:stop mid-ask.
function ReplyComposer({ ask }: { ask: PendingAsk }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  async function submit(answer: string): Promise<void> {
    const trimmed = answer.trim()
    if (!trimmed || sending) return
    setSending(true)
    setErrorText(null)
    try {
      const res = await window.agento.tool.answer({ toolCallId: ask.toolCallId, answer: trimmed })
      if (!res.ok) {
        setErrorText(res.reason ?? 'That question is no longer active.')
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {ask.options && ask.options.length > 0 ? (
        <div className="composer-replies" role="group" aria-label="Suggested replies">
          {ask.options.map((option) => (
            <button
              key={option}
              type="button"
              className="composer-chip"
              disabled={sending}
              onClick={() => void submit(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        className="composer-input"
        placeholder="Type your reply…"
        value={draft}
        rows={1}
        autoFocus
        disabled={sending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          void submit(draft)
        }}
      />
      <button
        type="button"
        className="composer-send"
        disabled={sending || draft.trim().length === 0}
        onClick={() => void submit(draft)}
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
      {errorText ? (
        <div className="composer-reply-error" role="alert">
          {errorText}
        </div>
      ) : null}
    </>
  )
}

function Thread({
  error,
  runStatus,
  mode,
  onModeChange,
  modeDisabled,
  pendingAsk,
  attachments,
  onAttachmentsChange,
  sessionId
}: {
  error?: Error
  runStatus?: string
  mode: SessionMode
  onModeChange: (mode: SessionMode) => void
  modeDisabled: boolean
  pendingAsk: PendingAsk | null
  attachments: string[]
  onAttachmentsChange: (next: string[]) => void
  sessionId: string | null
}): React.JSX.Element {
  // Hint preview: hovering or keyboard-focusing the unselected Plan/Act tab
  // shows THAT mode's description, so users can compare before switching.
  // Cleared on leave/blur back to the selected mode's copy. Text-only swap —
  // grayscale treatment untouched, reduced-motion safe.
  const [hintPreview, setHintPreview] = useState<SessionMode | null>(null)
  const hintMode = hintPreview ?? mode
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.If empty>
          <ThreadWelcome />
        </ThreadPrimitive.If>
        {runStatus ? (
          <div className="run-status" role="status" aria-live="polite">
            <span className="run-status__pulse" aria-hidden="true" />
            <span>{runStatus}</span>
          </div>
        ) : null}
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        {/* Conversation errors render as an honest sentence in the thread
            (docs/04 §6); useChat carries the friendly text from main's error
            part and clears it on the next send. assistant-ui 0.11.56 has no
            primitive for it (no Thread error condition; the AI SDK bridge
            keeps errors in message metadata, not status). */}
        {error && (
          <div className="thread-error" role="alert">
            {error.message}
          </div>
        )}
        {/* docs/04 §8.4: floats above the composer via absolute positioning
            (.thread is the containing block); visible only when scrolled up. */}
        <ScrollToBottomButton />
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ViewportFooter className="thread-footer">
        <ComposerPrimitive.Root className="composer">
          {/* Execution mode tabs (docs/04 §3.5): session-owned, persisted via
              session:set-mode. Plan is structurally read-only; Act may mutate
              through the normal approval/snapshot pipeline. */}
          <div className="mode-tabs" role="tablist" aria-label="Execution mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'plan'}
              aria-describedby="mode-hint"
              className={mode === 'plan' ? 'mode-tab mode-tab--active' : 'mode-tab'}
              disabled={modeDisabled}
              onClick={() => onModeChange('plan')}
              onMouseEnter={() => setHintPreview('plan')}
              onMouseLeave={() => setHintPreview(null)}
              onFocus={() => setHintPreview('plan')}
              onBlur={() => setHintPreview(null)}
              title="Read files and prepare a plan. Nothing will be changed."
            >
              Plan
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'act'}
              aria-describedby="mode-hint"
              className={mode === 'act' ? 'mode-tab mode-tab--active' : 'mode-tab'}
              disabled={modeDisabled}
              onClick={() => onModeChange('act')}
              onMouseEnter={() => setHintPreview('act')}
              onMouseLeave={() => setHintPreview(null)}
              onFocus={() => setHintPreview('act')}
              onBlur={() => setHintPreview(null)}
              title="Carry out work. Agento asks before risky changes."
            >
              Act
            </button>
            <span className="mode-hint" id="mode-hint">
              {hintMode === 'plan' ? 'Read-only — nothing will change.' : 'Carries out work.'}
            </span>
          </div>
          {/* Model chip (docs/04 §2): a sibling of the tablist (a non-tab
              control must not sit inside role="tablist"), absolutely
              positioned over the tabs row's right end. */}
          <ModelChip />
          {/* Reply mode: a pending ask_user replaces the composer input with
              the reply box (chips + textarea + Send, one unit keyed per
              question). The normal primitives return the moment the answer
              chunk overwrites the ask part's output. */}
          {pendingAsk ? (
            <ReplyComposer key={pendingAsk.toolCallId} ask={pendingAsk} />
          ) : (
            <>
              {/* File references (FileAttach): paperclip + @-mention share one
                  workspace-scoped picker; chips clear on send (transport). */}
              {/* Keyed by session so the picker's file cache resets with the
                  workspace it lists — no reset effect needed. */}
              <FileAttach
                key={sessionId ?? 'no-session'}
                attachments={attachments}
                onChange={onAttachmentsChange}
                disabled={modeDisabled}
                sessionId={sessionId}
              />
              <ComposerPrimitive.Input
                className="composer-input"
                placeholder={mode === 'plan' ? 'Ask for a read-only plan…' : 'Message Agento…'}
                rows={1}
                autoFocus
              />
            </>
          )}
          {/* docs/04 §3.5: stop replaces send mid-run. The Cancel primitive is
              gated by ThreadPrimitive.If because composer canCancel is a
              capability flag (onCancel is wired), not a running flag — without
              the gate the button would sit enabled while idle. isRunning covers
              the reasoning lead-in (status submitted|streaming), so Stop is
              visible before any text arrives. */}
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="composer-send">Send</ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="composer-cancel">Stop</ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
        {/* QuickActions chips (docs/04 §3.5) sit UNDER the composer on the
            empty thread — part of the centered home group, fill-only, never
            auto-send. */}
        <ThreadPrimitive.If empty>
          <QuickActions />
        </ThreadPrimitive.If>
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Root>
  )
}

interface ChatViewProps {
  getSessionId: () => string | null
  getMode: () => SessionMode
  mode: SessionMode
  onModeChange: (mode: SessionMode) => void
  modeDisabled?: boolean
  onSessionCreated: (session: SessionSummary) => void
  onSettled: () => void
  initialMessages: UIMessage[]
  registerDispose: (dispose: (() => void) | null) => void
  runStatus?: string
  sessionId: string | null
  attachments: string[]
  onAttachmentsChange: (next: string[]) => void
  getAttachments: () => string[]
  onAttachmentsConsumed: () => void
}

// One conversation view. Remounted (keyed by an epoch that advances only on
// explicit New chat / open-session actions) so each session's history lives in
// its own useChat instance — histories of different sessions can never mix.
// The key is NOT the session id on purpose: lazy session creation on first
// send flips the id from null to a real one, and remounting then would kill
// the in-flight stream. `messages` (ChatInit.messages) seeds the initial
// history; verified against @ai-sdk/react 2.0.253's UseChatOptions.
function ChatView({
  getSessionId,
  getMode,
  mode,
  onModeChange,
  modeDisabled,
  onSessionCreated,
  onSettled,
  initialMessages,
  registerDispose,
  runStatus,
  sessionId,
  attachments,
  onAttachmentsChange,
  getAttachments,
  onAttachmentsConsumed
}: ChatViewProps): React.JSX.Element {
  // Created once per mount: the transport carries this view's run state
  // (in-flight guard, active run's session id), so a per-render identity
  // would be a lie. getMode is App-stable (useCallback over a ref), so it can
  // be handed to the transport directly — a tab switch before the first send
  // still stamps the lazy-created session correctly.
  // The transport is created once per mount from App-owned prop callbacks
  // (never the view's own refs — react-hooks/refs forbids reading refs
  // during render, which a useState initializer would do).
  const [ipc] = useState(() =>
    createIpcChatTransport({
      getSessionId,
      getMode,
      onSessionCreated,
      onSettled,
      getAttachments,
      onAttachmentsConsumed
    })
  )
  const chat = useChat({ transport: ipc.transport, messages: initialMessages })
  const runtime = useAISDKRuntime(chat)
  // Reply mode (docs/03 §7): a pending ask_user pauses the run — the newest
  // tool part still carrying __agentoAskUser is the question to answer in
  // the composer. Gated on runActive so a dead ask (crashed stream, stale
  // history) can never trap the composer in reply mode.
  const pendingAsk = useMemo(() => findPendingAsk(chat.messages), [chat.messages])
  const runActive = chat.status === 'submitted' || chat.status === 'streaming'
  const activeAsk = runActive ? pendingAsk : null
  const liveStatus = activeAsk
    ? 'Waiting for your reply...'
    : (runStatus ??
      (chat.status === 'submitted'
        ? mode === 'plan'
          ? 'Reading and preparing your plan...'
          : 'Getting ready...'
        : chat.status === 'streaming'
          ? mode === 'plan'
            ? 'Reading and preparing your plan...'
            : 'Working...'
          : undefined))
  // The view is unmounted ONLY by an explicit session switch / New chat, and
  // App runs dispose there (before the remount) rather than in an effect
  // cleanup: StrictMode's simulated mount-unmount cycle would otherwise
  // permanently dispose the transport and reject every send.
  useEffect(() => {
    registerDispose(ipc.dispose)
    return () => registerDispose(null)
  }, [registerDispose, ipc])
  // Esc stops the run (docs/04 §7). Settings owns Esc while open — it closes
  // the dialog only. `stop` is an instance method of the stable Chat object
  // (bound in the constructor), so the listener registers once per run.
  const stop = chat.stop
  useEffect(() => {
    if (!runActive) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('.settings-overlay')) return
      // The approval dialog is blocking with no Escape dismiss — Esc must not
      // stop the run out from under the pending approval promise.
      if (document.querySelector('.approval-dialog-overlay')) return
      stop()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [runActive, stop])
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUIRegistry />
      <Thread
        error={chat.error}
        runStatus={liveStatus}
        mode={mode}
        onModeChange={onModeChange}
        modeDisabled={runActive || (modeDisabled ?? false)}
        pendingAsk={activeAsk}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        sessionId={sessionId}
      />
    </AssistantRuntimeProvider>
  )
}

function App(): React.JSX.Element {
  // Session state (M1.3): the ref is the transport's source of truth (a state
  // update alone would race the send that triggered lazy creation); the state
  // mirrors it for the sidebar highlight.
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const [threadEpoch, setThreadEpoch] = useState(0)
  const [pendingMessages, setPendingMessages] = useState<UIMessage[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The mounted ChatView's transport dispose. Session switches call it BEFORE
  // remounting so an in-flight run is aborted and its part subscription
  // dropped — no ghost listeners, and the run's partial reply is persisted
  // main-side (M1.4). StrictMode-safe: never tied to an effect cleanup.
  const chatDisposeRef = useRef<(() => void) | null>(null)
  const registerDispose = useCallback((dispose: (() => void) | null) => {
    chatDisposeRef.current = dispose
  }, [])
  // Event ordering: per-session monotonic seq + active run binding. Stale or
  // cross-run events are discarded so a delayed prior run cannot overwrite a
  // newer plan or reopen an obsolete approval.
  const lastSeqRef = useRef(0)
  const lastRunIdRef = useRef<string | null>(null)

  // MVP onboarding gate (MVP_PLAN.md; M6.1 cut): first launch walks one
  // static screen until a workspace AND an API key exist. null = still
  // checking (render nothing — a brief blank beats flashing the chat UI);
  // a failed check degrades to the main UI, which already handles both
  // missing states honestly.
  const [setupReady, setSetupReady] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.all([window.agento.settings.get(), window.agento.workspaces.get()])
      .then(([settings, workspaces]) => {
        if (!cancelled) setSetupReady(settings.hasKey && workspaces.current !== null)
      })
      .catch(() => {
        if (!cancelled) setSetupReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // M6.3 Appearance (docs/04 §3.7): the settings snapshot owns the theme;
  // the <html> .dark class is the token switch (main.css). Applied on launch
  // and whenever the OS scheme changes under 'system'.
  useEffect(() => {
    let cancelled = false
    const apply = (appearance: string): void => {
      const root = document.documentElement
      if (appearance === 'light') root.classList.remove('dark')
      else if (appearance === 'dark') root.classList.add('dark')
      else {
        const light = window.matchMedia('(prefers-color-scheme: light)').matches
        root.classList.toggle('dark', !light)
      }
    }
    window.agento.settings
      .get()
      .then((snapshot) => {
        if (!cancelled) apply(snapshot.appearance ?? 'dark')
      })
      .catch(() => {})
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => {
      window.agento.settings
        .get()
        .then((snapshot) => {
          if (!cancelled && (snapshot.appearance ?? 'dark') === 'system') apply('system')
        })
        .catch(() => {})
    }
    media.addEventListener?.('change', onChange)
    return () => {
      cancelled = true
      media.removeEventListener?.('change', onChange)
    }
  }, [setupReady])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.agento.sessions.list())
    } catch (error) {
      console.error('session:list failed:', error)
    }
  }, [])

  useEffect(() => {
    // Initial sidebar load. State lands in the promise callbacks, never
    // synchronously inside the effect.
    window.agento.sessions
      .list()
      .then(setSessions)
      .catch((error) => console.error('session:list failed:', error))
  }, [])

  // M1.5: the first session-scoped agent:event (docs/03 §4). This listener
  // validates every event BEFORE anything consumes it (the Zod-both-sides
  // rule) and holds the subscription lifecycle the M3 panels will build on.
  // It deliberately does NOT update the sidebar totals: push events and
  // invoke replies have no guaranteed ordering on the wire (the M1.3 note —
  // an invoke reply can overtake trailing pushes), so a provisional add
  // could stack on top of a session:list refresh that already read the new
  // usage row. Totals are owned by the settle-triggered session:list
  // refresh, which reads the authoritative usage_events sums — a valid
  // event can never double-count them. Passive-listener pattern
  // (SidecarStatusDot): unsubscribing in the effect cleanup is
  // StrictMode-safe because resubscription is complete and non-destructive
  // — the registerDispose ref pattern stays reserved for the transport's
  // destructive dispose (M1.4 rule).
  // ── Plan panel ─────────────────────────────────────────────────────────
  // Plan-mode runs are read-only: the panel is review-only, never a Start
  // gate. Act's "go ahead" executes the latest SAVED plan (session:plan),
  // which is also restored on session open so a reviewed plan survives a
  // restart.
  const [plan, setPlan] = useState<PlanPanelState | null>(null)

  // Composer file references (FileAttach chips): App-owned so ChatView can
  // hand stable prop callbacks to its transport initializer (a transport
  // created in useState must never close over the view's own refs). Cleared
  // on every session switch / new chat / successful send-consumption, so
  // chips never leak across conversations.
  const [attachments, setAttachments] = useState<string[]>([])
  const attachmentsRef = useRef<string[]>([])
  const handleAttachmentsChange = useCallback((next: string[]) => {
    attachmentsRef.current = next
    setAttachments(next)
  }, [])
  const getAttachments = useCallback(() => attachmentsRef.current, [])
  const clearAttachments = useCallback(() => {
    attachmentsRef.current = []
    setAttachments([])
  }, [])

  // ── Execution mode tabs (docs/03 §2, docs/04 §3.5) ─────────────────────────
  // Session-owned: new chats start in Act; opening a session restores its
  // persisted mode; switching with an active session persists immediately.
  const [mode, setMode] = useState<SessionMode>('act')
  const [modeSaving, setModeSaving] = useState(false)
  const modeRef = useRef<SessionMode>('act')
  const setModeBoth = useCallback((next: SessionMode) => {
    modeRef.current = next
    setMode(next)
  }, [])
  const getMode = useCallback(() => modeRef.current, [])

  const handleModeChange = useCallback(
    (next: SessionMode) => {
      if (next === modeRef.current || modeSaving) return
      const sessionId = activeSessionIdRef.current
      setModeBoth(next)
      // No session row yet (new chat before first send): the mode rides the
      // lazy session:create via the transport's getMode — nothing to persist.
      if (!sessionId) return
      setModeSaving(true)
      window.agento.sessions
        .setMode({ sessionId, mode: next })
        .then((updated) => {
          setModeBoth(updated.mode === 'plan' ? 'plan' : 'act')
          setSessions((prev) =>
            prev.map((s) => (s.id === updated.id ? { ...s, mode: updated.mode } : s))
          )
        })
        .catch((error) => {
          console.error('session:set-mode failed:', error)
          // Revert the optimistic switch so the tabs never lie about the
          // persisted mode that chat:send will route on.
          window.agento.sessions
            .list()
            .then((rows) => {
              const row = rows.find((s) => s.id === sessionId)
              if (row) setModeBoth(row.mode === 'plan' ? 'plan' : 'act')
            })
            .catch(() => undefined)
        })
        .finally(() => setModeSaving(false))
    },
    [modeSaving, setModeBoth]
  )

  // M3.2 approval dialog: one at a time, keyed by approvalId, closed on
  // approval/resolved (or after main confirms ok:true).
  const [approval, setApproval] = useState<AgentApprovalRequestedEvent | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [approvalPending, setApprovalPending] = useState(false)
  const [runStatus, setRunStatus] = useState<string | undefined>(undefined)

  function handleApprovalRespond(decision: 'approve' | 'skip' | 'cancel'): void {
    const current = approval
    if (!current || approvalPending) return
    setApprovalPending(true)
    setApprovalError(null)
    window.agento.approval
      .respond({ approvalId: current.approvalId, decision })
      .then((result) => {
        if (result.ok) {
          // Keep mounted until approval/resolved arrives; the event clears it.
          // Optimistically clear only on confirmed ok to avoid a stuck dialog
          // when the event is delayed — the resolved handler is idempotent.
          setApproval(null)
        } else {
          setApprovalError(result.reason ?? 'That decision was not accepted. Try again.')
        }
      })
      .catch((error) => {
        setApprovalError(
          error instanceof Error ? error.message : 'Could not send that decision. Try again.'
        )
      })
      .finally(() => setApprovalPending(false))
  }

  const resetPlan = useCallback(() => {
    setPlan(null)
    setApproval(null)
    setApprovalError(null)
    setApprovalPending(false)
    lastSeqRef.current = 0
    lastRunIdRef.current = null
  }, [])

  useEffect(() => {
    const unsubscribe = window.agento.agent.onEvent((raw) => {
      // Validate and drop: invalid events must never reach state. Consumers
      // route on type (M3): plan/created feeds the PlanPanel; step/verify/
      // approval events join with M3.5/M3.6. Enforce per-session monotonic
      // seq and active-run binding — stale/cross-run events are discarded.
      const event = parseAgentEvent(raw)
      if (!event) return
      // Auto-generated chat titles (docs/03 §4): patch the sidebar row by id.
      // Handled BEFORE the active-session/seq guards — a rename is idempotent,
      // can land for a session the user already switched away from, and must
      // never be dropped by the per-run monotonic-seq guard.
      if (event.type === 'session/title_updated') {
        setSessions((prev) =>
          prev.map((s) => (s.id === event.sessionId ? { ...s, title: event.title } : s))
        )
        return
      }
      if (event.sessionId !== activeSessionIdRef.current) return
      if (typeof event.seq === 'number') {
        if (event.seq <= lastSeqRef.current) return
        lastSeqRef.current = event.seq
      }
      if (event.type === 'plan/created') {
        lastRunIdRef.current = event.runId
        setRunStatus('Plan ready — nothing was changed.')
        setPlan((prev) =>
          prev !== null && prev.runId === event.runId
            ? {
                runId: event.runId,
                steps: event.steps,
                updated: true,
                statuses: {},
                verification: {},
                errors: {}
              }
            : {
                runId: event.runId,
                steps: event.steps,
                updated: false,
                statuses: {},
                verification: {},
                errors: {}
              }
        )
      } else if (event.type === 'plan/step_updated') {
        setRunStatus(
          event.status === 'done'
            ? 'Checking the result...'
            : event.status === 'failed'
              ? 'That step needs attention.'
              : event.status === 'skipped'
                ? 'Continuing with the remaining steps...'
                : 'Working through your plan...'
        )
        setPlan((prev) => {
          if (!prev || prev.runId !== event.runId) return prev
          return {
            ...prev,
            statuses: { ...prev.statuses, [event.stepId]: event.status },
            verification:
              event.verification !== undefined
                ? { ...prev.verification, [event.stepId]: event.verification }
                : prev.verification,
            errors:
              event.error !== undefined
                ? { ...prev.errors, [event.stepId]: event.error }
                : prev.errors
          }
        })
      } else if (event.type === 'verification/finished') {
        setRunStatus(
          event.isComplete
            ? 'Everything checks out — finishing up.'
            : 'Some results could not be confirmed — take a quick look when it finishes.'
        )
        setPlan((prev) => {
          if (!prev || prev.runId !== event.runId) return prev
          const key = event.stepId === 'run' ? (prev.steps[0]?.id ?? 'run') : event.stepId
          return {
            ...prev,
            verification: {
              ...prev.verification,
              [key]: { score: event.score, verified: event.isComplete }
            },
            errors:
              event.missedSegments !== undefined && event.missedSegments.length > 0
                ? { ...prev.errors, [key]: event.missedSegments.join('; ') }
                : prev.errors
          }
        })
      } else if (event.type === 'approval/requested') {
        if (lastRunIdRef.current && event.runId !== lastRunIdRef.current) return
        lastRunIdRef.current = event.runId
        setRunStatus('Waiting for your approval...')
        setApproval(event)
        setApprovalError(null)
        // No false owning-step glyph: the approval request carries no
        // authoritative stepId yet, so the panel must not mark step 0 as
        // awaiting. The dialog itself is the approval surface.
      } else if (event.type === 'approval/resolved') {
        if (lastRunIdRef.current && event.runId !== lastRunIdRef.current) return
        setRunStatus(
          event.decision === 'approve'
            ? 'Approved. Starting the next step...'
            : 'Continuing without that step...'
        )
        setApproval((current) =>
          current && current.approvalId === event.approvalId ? null : current
        )
      }
    })
    return unsubscribe
  }, [setPlan])

  const getSessionId = useCallback(() => activeSessionIdRef.current, [])

  const onSessionCreated = useCallback(
    (session: SessionSummary) => {
      activeSessionIdRef.current = session.id
      setActiveSessionId(session.id)
      setModeBoth(session.mode === 'plan' ? 'plan' : 'act')
      refreshSessions()
    },
    [refreshSessions, setModeBoth]
  )

  // M2.5: the Changes stub re-reads its checkpoint feed when a run settles
  // (same trigger as the sidebar refresh — durability rows land at settle).
  const [changesRefreshKey, setChangesRefreshKey] = useState(0)
  const onSettled = useCallback(() => {
    refreshSessions()
    setChangesRefreshKey((key) => key + 1)
    setRunStatus(undefined)
  }, [refreshSessions])

  // Ctrl+Z (docs/04 §7): undo the NEWEST change group — the same unit the
  // Changes panel's per-item undo restores (a move's two rows fan out
  // oldest-first, exactly like undoGroup there). Text-field undo is left
  // alone: keystrokes inside inputs/textareas/contenteditable fall through.
  const undoLastChange = useCallback(async (): Promise<void> => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    try {
      const { entries } = await window.agento.changes.list({ sessionId })
      const newest = entries.find((entry) => entry.revertedAt === null)
      if (!newest) return
      const newestKey = newest.groupKey ?? `solo:${newest.id}`
      const groupRows = entries.filter(
        (entry) => entry.revertedAt === null && (entry.groupKey ?? `solo:${entry.id}`) === newestKey
      )
      for (const row of [...groupRows].reverse()) {
        await window.agento.changes.undo({ checkpointId: row.id })
      }
      setChangesRefreshKey((key) => key + 1)
    } catch (error) {
      console.error('Ctrl+Z undo failed:', error)
    }
  }, [])

  const openSession = useCallback(
    async (session: SessionSummary) => {
      if (session.id === activeSessionIdRef.current) return
      chatDisposeRef.current?.()
      resetPlan()
      clearAttachments()
      try {
        const [messages, savedPlan] = await Promise.all([
          window.agento.sessions.messages({ sessionId: session.id }),
          window.agento.sessions.plan({ sessionId: session.id }).catch(() => [])
        ])
        activeSessionIdRef.current = session.id
        setActiveSessionId(session.id)
        setModeBoth(session.mode === 'plan' ? 'plan' : 'act')
        // Restore the reviewed plan so it survives restarts (docs/03 §2);
        // statuses stay pending until a new run traces them.
        if (savedPlan.length > 0) {
          setPlan({
            runId: `restored-${session.id}`,
            steps: savedPlan,
            updated: false,
            statuses: {},
            verification: {},
            errors: {}
          })
        }
        setPendingMessages(messages)
        setThreadEpoch((epoch) => epoch + 1)
      } catch (error) {
        console.error('session:messages failed:', error)
      }
    },
    [resetPlan, setModeBoth, clearAttachments]
  )

  const startNewChat = useCallback(() => {
    chatDisposeRef.current?.()
    resetPlan()
    clearAttachments()
    activeSessionIdRef.current = null
    setActiveSessionId(null)
    setModeBoth('act')
    setPendingMessages([])
    setThreadEpoch((epoch) => epoch + 1)
  }, [resetPlan, setModeBoth, clearAttachments])

  // Sidebar rename/delete (docs/04 §2). Rename patches the row in place; a
  // user rename also blocks the background auto-title main-side (title_renamed).
  // Delete of the ACTIVE chat first tears the view down (dispose → fresh chat)
  // so no subscribed transport or panel survives its session. Errors propagate
  // to the sidebar's inline menu message (e.g. the mid-run delete refusal).
  const handleRenameSession = useCallback(
    async (session: SessionSummary, title: string): Promise<void> => {
      const updated = await window.agento.sessions.rename({ sessionId: session.id, title })
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...s, title: updated.title } : s))
      )
    },
    []
  )

  const handleDeleteSession = useCallback(
    async (session: SessionSummary): Promise<void> => {
      await window.agento.sessions.delete({ sessionId: session.id })
      if (session.id === activeSessionIdRef.current) startNewChat()
      setSessions((prev) => prev.filter((s) => s.id !== session.id))
    },
    [startNewChat]
  )

  // ⌘/Ctrl+, opens Settings (docs/04 §7). Renderer-side keydown rather than an
  // Electron Menu accelerator: no Menu exists (autoHideMenuBar) and pure UI
  // state needs no extra push channel.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        setSettingsOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ⌘/Ctrl+Z (undo the newest change) and ⌘/Ctrl+N (new chat) — docs/04 §7.
  // Same renderer-side keydown pattern as ⌘/Ctrl+, above. When focus sits in
  // an editable control the event falls through untouched, so the composer's
  // and the rename field's native text undo keep working. Modal overlays own
  // the keyboard while up (same guard the Esc handler uses).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'n') return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (
        document.querySelector('.settings-overlay') ||
        document.querySelector('.approval-dialog-overlay')
      ) {
        return
      }
      event.preventDefault()
      if (key === 'z') void undoLastChange()
      else startNewChat()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undoLastChange, startNewChat])

  if (setupReady === false) {
    return <Onboarding onDone={() => setSetupReady(true)} />
  }
  if (setupReady === null) {
    return <SidecarStatusDot />
  }

  return (
    <>
      <SessionsSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onNewChat={startNewChat}
        onOpenSession={openSession}
        onOpenSettings={() => setSettingsOpen(true)}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        settingsOpen={settingsOpen}
      />
      {/* Real three-column shell (UI_POLISH_PLAN.md): the thread lives in its
          own flex column (.chat-main), so messages can never render under the
          panels; the right rail is in flow — Plan above Changes — so the two
          panels can never overlap either. */}
      <main className="chat-main">
        <ChatView
          key={threadEpoch}
          getSessionId={getSessionId}
          getMode={getMode}
          mode={mode}
          onModeChange={handleModeChange}
          modeDisabled={modeSaving}
          onSessionCreated={onSessionCreated}
          onSettled={onSettled}
          initialMessages={pendingMessages}
          registerDispose={registerDispose}
          runStatus={runStatus}
          sessionId={activeSessionId}
          attachments={attachments}
          onAttachmentsChange={handleAttachmentsChange}
          getAttachments={getAttachments}
          onAttachmentsConsumed={clearAttachments}
        />
      </main>
      {/* The rail collapses when there is no plan and no active session
          (docs/04 §2); ChangesPanel itself returns null without a session.
          Plain div wrapper — deliberately not a landmark: PlanPanel and
          ChangesPanel are the complementary regions (each has its own
          aria-label), avoiding three nested complementary landmarks. */}
      {plan !== null || activeSessionId !== null ? (
        <div className="right-rail">
          {plan !== null ? (
            <PlanPanel
              steps={plan.steps}
              updated={plan.updated}
              readOnly
              statuses={plan.statuses}
              verification={plan.verification}
              errors={plan.errors}
            />
          ) : null}
          <ChangesPanel sessionId={activeSessionId} refreshKey={changesRefreshKey} />
        </div>
      ) : null}
      {approval !== null ? (
        <ApprovalDialog
          request={approval}
          onRespond={handleApprovalRespond}
          pending={approvalPending}
          error={approvalError}
        />
      ) : null}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )
}

export default App
