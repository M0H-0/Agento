import { useCallback, useEffect, useRef, useState } from 'react'
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

function Thread({
  error,
  runStatus,
  mode,
  onModeChange,
  modeDisabled
}: {
  error?: Error
  runStatus?: string
  mode: SessionMode
  onModeChange: (mode: SessionMode) => void
  modeDisabled: boolean
}): React.JSX.Element {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.If empty>
          <div className="thread-welcome">
            <h1>Agento</h1>
            <p>Say something — the main process echoes it back over IPC.</p>
          </div>
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
              className={mode === 'plan' ? 'mode-tab mode-tab--active' : 'mode-tab'}
              disabled={modeDisabled}
              onClick={() => onModeChange('plan')}
              title="Read files and prepare a plan. Nothing will be changed."
            >
              Plan
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'act'}
              className={mode === 'act' ? 'mode-tab mode-tab--active' : 'mode-tab'}
              disabled={modeDisabled}
              onClick={() => onModeChange('act')}
              title="Carry out work. Agento asks before risky changes."
            >
              Act
            </button>
            <span className="mode-hint">
              {mode === 'plan' ? 'Read-only — nothing will change.' : 'Carries out work.'}
            </span>
          </div>
          <ComposerPrimitive.Input
            className="composer-input"
            placeholder={mode === 'plan' ? 'Ask for a read-only plan…' : 'Message Agento…'}
            rows={1}
            autoFocus
          />
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
  runStatus
}: ChatViewProps): React.JSX.Element {
  // Created once per mount: the transport carries this view's run state
  // (in-flight guard, active run's session id), so a per-render identity
  // would be a lie. getMode is App-stable (useCallback over a ref), so it can
  // be handed to the transport directly — a tab switch before the first send
  // still stamps the lazy-created session correctly.
  const [ipc] = useState(() =>
    createIpcChatTransport({ getSessionId, getMode, onSessionCreated, onSettled })
  )
  const chat = useChat({ transport: ipc.transport, messages: initialMessages })
  const runtime = useAISDKRuntime(chat)
  const liveStatus =
    runStatus ??
    (chat.status === 'submitted'
      ? mode === 'plan'
        ? 'Reading and preparing your plan...'
        : 'Getting ready...'
      : chat.status === 'streaming'
        ? mode === 'plan'
          ? 'Reading and preparing your plan...'
          : 'Working...'
        : undefined)
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
  const runActive = chat.status === 'submitted' || chat.status === 'streaming'
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
          event.isComplete ? 'Verified. Finishing up...' : 'The result could not be fully verified.'
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

  const openSession = useCallback(
    async (session: SessionSummary) => {
      if (session.id === activeSessionIdRef.current) return
      chatDisposeRef.current?.()
      resetPlan()
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
    [resetPlan, setModeBoth]
  )

  const startNewChat = useCallback(() => {
    chatDisposeRef.current?.()
    resetPlan()
    activeSessionIdRef.current = null
    setActiveSessionId(null)
    setModeBoth('act')
    setPendingMessages([])
    setThreadEpoch((epoch) => epoch + 1)
  }, [resetPlan, setModeBoth])

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
