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
import type { SessionSummary } from './chat/transport'
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

function Thread({ error }: { error?: Error }): React.JSX.Element {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.If empty>
          <div className="thread-welcome">
            <h1>Agento</h1>
            <p>Say something — the main process echoes it back over IPC.</p>
          </div>
        </ThreadPrimitive.If>
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
          <ComposerPrimitive.Input
            className="composer-input"
            placeholder="Message Agento…"
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
  onSessionCreated: (session: SessionSummary) => void
  onSettled: () => void
  initialMessages: UIMessage[]
  registerDispose: (dispose: (() => void) | null) => void
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
  onSessionCreated,
  onSettled,
  initialMessages,
  registerDispose
}: ChatViewProps): React.JSX.Element {
  // Created once per mount: the transport carries this view's run state
  // (in-flight guard, active run's session id), so a per-render identity
  // would be a lie.
  const [ipc] = useState(() =>
    createIpcChatTransport({ getSessionId, onSessionCreated, onSettled })
  )
  const chat = useChat({ transport: ipc.transport, messages: initialMessages })
  const runtime = useAISDKRuntime(chat)
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
      stop()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [runActive, stop])
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUIRegistry />
      <Thread error={chat.error} />
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
  // ── Plan panel (M3.1) ────────────────────────────────────────────────────
  const [plan, setPlan] = useState<PlanPanelState | null>(null)
  const [planStartRequested, setPlanStartRequested] = useState(false)

  const handlePlanStart = useCallback(() => {
    // Optimistic: the run is blocked on the gate; main resolves it. The
    // button hides either way — a declined/duplicate start is ok:false and
    // the panel just stays on its honest pre-execution footer.
    setPlanStartRequested(true)
    window.agento.plan.start().catch((error) => console.error('plan:start failed:', error))
  }, [setPlanStartRequested])

  // M3.2 approval dialog: one at a time, keyed by approvalId, closed on
  // approval/resolved (or after responding).
  const [approval, setApproval] = useState<AgentApprovalRequestedEvent | null>(null)

  function handleApprovalRespond(decision: 'approve' | 'skip' | 'cancel'): void {
    setApproval((current) => {
      if (current) {
        window.agento.approval
          .respond({ approvalId: current.approvalId, decision })
          .catch((error) => console.error('approval:respond failed:', error))
      }
      return null
    })
  }

  const resetPlan = useCallback(() => {
    setPlan(null)
    setPlanStartRequested(false)
    setApproval(null)
  }, [])

  useEffect(() => {
    const unsubscribe = window.agento.agent.onEvent((raw) => {
      // Validate and drop: invalid events must never reach state. Consumers
      // route on type (M3): plan/created feeds the PlanPanel; step/verify/
      // approval events join with M3.5/M3.6.
      const event = parseAgentEvent(raw)
      if (!event) return
      if (event.sessionId !== activeSessionIdRef.current) return
      if (event.type === 'plan/created') {
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
        setApproval(event)
        // The owning step (first match) shows the awaiting glyph.
        setPlan((prev) => {
          if (!prev || prev.runId !== event.runId || prev.steps.length === 0) return prev
          const firstId = prev.steps[0]?.id
          if (!firstId) return prev
          return { ...prev, statuses: { ...prev.statuses, [firstId]: 'awaiting_approval' } }
        })
      } else if (event.type === 'approval/resolved') {
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
      refreshSessions()
    },
    [refreshSessions]
  )

  // M2.5: the Changes stub re-reads its checkpoint feed when a run settles
  // (same trigger as the sidebar refresh — durability rows land at settle).
  const [changesRefreshKey, setChangesRefreshKey] = useState(0)
  const onSettled = useCallback(() => {
    refreshSessions()
    setChangesRefreshKey((key) => key + 1)
  }, [refreshSessions])

  const openSession = useCallback(
    async (session: SessionSummary) => {
      if (session.id === activeSessionIdRef.current) return
      chatDisposeRef.current?.()
      resetPlan()
      try {
        const messages = await window.agento.sessions.messages({ sessionId: session.id })
        activeSessionIdRef.current = session.id
        setActiveSessionId(session.id)
        setPendingMessages(messages)
        setThreadEpoch((epoch) => epoch + 1)
      } catch (error) {
        console.error('session:messages failed:', error)
      }
    },
    [resetPlan]
  )

  const startNewChat = useCallback(() => {
    chatDisposeRef.current?.()
    resetPlan()
    activeSessionIdRef.current = null
    setActiveSessionId(null)
    setPendingMessages([])
    setThreadEpoch((epoch) => epoch + 1)
  }, [resetPlan])

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

  return (
    <>
      <SidecarStatusDot />
      <SessionsSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onNewChat={startNewChat}
        onOpenSession={openSession}
      />
      <button
        type="button"
        className="settings-button"
        onClick={() => setSettingsOpen(true)}
        aria-haspopup="dialog"
      >
        Settings
      </button>
      {/* M3.1: while a plan is visible in the right rail, the changes panel
          shifts below it — both are fixed-position and would otherwise
          overlap (`.changes-panel--plan-open` in main.css). */}
      <ChangesPanel
        sessionId={activeSessionId}
        refreshKey={changesRefreshKey}
        shifted={plan !== null}
      />
      {approval !== null ? (
        <ApprovalDialog request={approval} onRespond={handleApprovalRespond} />
      ) : null}
      {plan !== null ? (
        <PlanPanel
          steps={plan.steps}
          updated={plan.updated}
          awaitingStart={!planStartRequested}
          onStart={handlePlanStart}
          statuses={plan.statuses}
          verification={plan.verification}
          errors={plan.errors}
        />
      ) : null}
      <ChatView
        key={threadEpoch}
        getSessionId={getSessionId}
        onSessionCreated={onSessionCreated}
        onSettled={onSettled}
        initialMessages={pendingMessages}
        registerDispose={registerDispose}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )
}

export default App
