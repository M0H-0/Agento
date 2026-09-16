import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useThreadRuntime
} from '@assistant-ui/react'
import type { UIMessage } from 'ai'
import { createIpcChatTransport } from './chat/transport'
import type { SessionMode, SessionSummary } from './chat/transport'
import { canStartChat } from './chat/provider-gate'
import { findPendingAsk } from './chat/ask'
import type { PendingAsk } from './chat/ask'
import { localizeThreadError, translate } from './chat/locale'
import type { Locale, StringKey } from './chat/locale'
import { LocaleProvider } from './components/LocaleContext'
import { useLocale } from './components/locale-context'
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
import SlashMenu from './components/SlashMenu'
import WorkspaceOverview from './components/WorkspaceOverview'
import { ToolUIRegistry } from './components/cards/ToolUIRegistry'

// Composer prefill (Workspace Overview task starters): fills the composer
// once per provided prompt, never auto-sends. Lives inside the thread
// runtime so it can call composer.setText; the parent clears the prompt on
// first consumption so re-renders never re-fill over user typing.
function ComposerPrefill({
  text,
  onConsumed
}: {
  text: string | null
  onConsumed: () => void
}): null {
  const runtime = useThreadRuntime({ optional: true })
  useEffect(() => {
    if (!text || !runtime) return
    runtime.composer.setText(text)
    document.querySelector<HTMLInputElement>('.composer-input')?.focus()
    onConsumed()
  }, [text, runtime, onConsumed])
  return null
}

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

// Home greeting pool — one line shown at a time, picked at random once per
// app lifetime (App owns the pick so session switches, which remount ChatView
// per threadEpoch, neither re-roll the line nor replay the entrance).
const HOME_GREETING_KEYS: StringKey[] = ['app.greeting.a', 'app.greeting.b']

function pickHomeGreeting(): StringKey {
  const pick = HOME_GREETING_KEYS[Math.floor(Math.random() * HOME_GREETING_KEYS.length)]
  return pick ?? 'app.greeting.a'
}

// Empty-thread welcome (docs/04 §2). A short greeting line plus, below it as
// secondary context, the folder chip naming the folder this new chat will
// actually work in (the picker's current pick — the same state session:create
// stamps). Plain useState fetch, state lands in the promise callback
// (StrictMode rule); a failed read degrades to the no-folder copy.
// playEntrance is latched at mount: App flips it to false (same-instance
// re-render) once the first empty paint marks itself spent — without the
// latch the re-render would strip .home-enter mid-animation.
function ThreadWelcome({
  greetingKey,
  playEntrance,
  onPlayed
}: {
  greetingKey: StringKey
  playEntrance: boolean
  onPlayed: () => void
}): React.JSX.Element {
  const { t } = useLocale()
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [animate] = useState(playEntrance)
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
  useEffect(() => {
    if (animate) onPlayed()
  }, [animate, onPlayed])
  return (
    <div className={animate ? 'thread-welcome home-enter' : 'thread-welcome'}>
      <h1 className="thread-welcome-greeting">{t(greetingKey)}</h1>
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
        {workspace ? <bdi>{formatFolderTail(workspace)}</bdi> : t('app.noFolder')}
      </p>
    </div>
  )
}

// Reply-mode composer (docs/03 §7): while an ask_user holds the run, the
// main composer IS the reply box — no card-embedded form. Enter sends
// (Shift+Enter breaks the line, an in-progress IME composition never sends);
// option chips fill the draft instead of sending — a reply must always pass
// through the composer visibly before Enter/Send, so no stray click or
// focused-chip Enter can ever send a reply the user didn't type (bug: a
// model-authored chip once fired on a stray Enter and the thread recorded a
// reply the user never wrote). The reply rides the same tool:answer channel
// the old card form used; on a refusal (stale question) the draft survives
// so the user can Stop or retry. Stop itself stays rendered beside Send —
// it rejects the pending answer and aborts, exactly like chat:stop mid-ask.
function ReplyComposer({ ask }: { ask: PendingAsk }): React.JSX.Element {
  const { t } = useLocale()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  async function submit(answer: string): Promise<void> {
    const trimmed = answer.trim()
    if (!trimmed || sending) return
    setSending(true)
    setErrorText(null)
    try {
      const res = await window.agento.tool.answer({ toolCallId: ask.toolCallId, answer: trimmed })
      if (!res.ok) {
        setErrorText(res.reason ?? t('app.questionGone'))
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
        <div className="composer-replies" role="group" aria-label={t('app.suggestedReplies')}>
          {ask.options.map((option) => (
            <button
              key={option}
              type="button"
              className="composer-chip"
              disabled={sending}
              onClick={() => {
                setDraft(option)
                inputRef.current?.focus()
              }}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        className="composer-input"
        placeholder={t('app.typeReply')}
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
        {sending ? t('app.sending') : t('app.send')}
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
  sessionId,
  onSlashMutated,
  greetingKey,
  playHomeEntrance,
  onHomeEntrancePlayed,
  prefillPrompt,
  onPrefillConsumed
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
  onSlashMutated: () => void
  greetingKey: StringKey
  playHomeEntrance: boolean
  onHomeEntrancePlayed: () => void
  prefillPrompt: string | null
  onPrefillConsumed: () => void
}): React.JSX.Element {
  // Hint preview: hovering or keyboard-focusing the unselected Plan/Act tab
  // shows THAT mode's description, so users can compare before switching.
  // Cleared on leave/blur back to the selected mode's copy. Text-only swap —
  // grayscale treatment untouched, reduced-motion safe.
  const [hintPreview, setHintPreview] = useState<SessionMode | null>(null)
  const hintMode = hintPreview ?? mode
  const { locale, t } = useLocale()
  // Latched at mount (see ThreadWelcome): App marks the entrance spent right
  // after the first empty paint, which re-renders this same instance with
  // playHomeEntrance=false — the latch keeps .home-enter for the full 250ms.
  const [playEntrance] = useState(playHomeEntrance)
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.If empty>
          <ThreadWelcome
            greetingKey={greetingKey}
            playEntrance={playEntrance}
            onPlayed={onHomeEntrancePlayed}
          />
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
            {localizeThreadError(locale, error.message)}
          </div>
        )}
        {/* docs/04 §8.4: floats above the composer via absolute positioning
            (.thread is the containing block); visible only when scrolled up. */}
        <ScrollToBottomButton />
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ViewportFooter className="thread-footer">
        {/* The composer's entrance only plays on the empty home (CSS gates
            .composer.home-enter behind .thread:has(.thread-welcome)) — opening
            an existing session never animates the docked composer. */}
        <ComposerPrimitive.Root className={playEntrance ? 'composer home-enter' : 'composer'}>
          {/* Execution mode tabs (docs/04 §3.5): session-owned, persisted via
              session:set-mode. Plan is structurally read-only; Act may mutate
              through the normal approval/snapshot pipeline. */}
          <div className="mode-tabs" role="tablist" aria-label={t('app.modeLabel')}>
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
              title={t('app.planTitle')}
            >
              {t('app.planTab')}
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
              title={t('app.actTitle')}
            >
              {t('app.actTab')}
            </button>
            <span className="mode-hint" id="mode-hint">
              {hintMode === 'plan' ? t('app.planHint') : t('app.actHint')}
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
              {/* Slash commands (docs/04 §3.5): `/` menu for undo + search
                  shortcuts; template commands send through the normal
                  transport, local ones run against the changes IPC. */}
              <SlashMenu disabled={modeDisabled} sessionId={sessionId} onMutated={onSlashMutated} />
              <ComposerPrimitive.Input
                className="composer-input"
                placeholder={t(mode === 'plan' ? 'app.planPlaceholder' : 'app.actPlaceholder')}
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
            <ComposerPrimitive.Send className="composer-send">
              {t('app.send')}
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="composer-cancel">
              {t('app.stop')}
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
        {/* QuickActions chips (docs/04 §3.5) sit UNDER the composer on the
            empty thread — part of the centered home group, fill-only, never
            auto-send. */}
        <ThreadPrimitive.If empty>
          <QuickActions playEntrance={playEntrance} />
        </ThreadPrimitive.If>
        <ComposerPrefill text={prefillPrompt} onConsumed={onPrefillConsumed} />
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
  onSlashMutated: () => void
  greetingKey: StringKey
  playHomeEntrance: boolean
  onHomeEntrancePlayed: () => void
  prefillPrompt: string | null
  onPrefillConsumed: () => void
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
  onAttachmentsConsumed,
  onSlashMutated,
  greetingKey,
  playHomeEntrance,
  onHomeEntrancePlayed,
  prefillPrompt,
  onPrefillConsumed
}: ChatViewProps): React.JSX.Element {
  const { t } = useLocale()
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
    ? t('app.waitingReply')
    : (runStatus ??
      (chat.status === 'submitted'
        ? t(mode === 'plan' ? 'app.preparingPlan' : 'app.gettingReady')
        : chat.status === 'streaming'
          ? t(mode === 'plan' ? 'app.preparingPlan' : 'app.working')
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
        onSlashMutated={onSlashMutated}
        greetingKey={greetingKey}
        playHomeEntrance={playHomeEntrance}
        onHomeEntrancePlayed={onHomeEntrancePlayed}
        prefillPrompt={prefillPrompt}
        onPrefillConsumed={onPrefillConsumed}
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
  // Home/empty-state identity (warmth pass): the greeting is picked once per
  // app lifetime — App never remounts, so session switches (ChatView remounts
  // per threadEpoch) keep the same line. Spent flips after the first empty
  // paint; later ChatViews receive playHomeEntrance=false, so the entrance
  // never replays on new chats and window focus (no remount) replays nothing.
  const [greetingKey] = useState(() => pickHomeGreeting())
  // Locale (Arabic option): owned here, pushed down via LocaleProvider.
  // localeRef mirrors it for the agent:event handler (registered once).
  const [locale, setLocaleState] = useState<Locale>('en')
  const localeRef = useRef<Locale>('en')
  const applyLocale = useCallback((next: Locale) => {
    localeRef.current = next
    setLocaleState(next)
    const root = document.documentElement
    root.lang = next
    root.dir = next === 'ar' ? 'rtl' : 'ltr'
  }, [])
  const [homeEntranceSpent, setHomeEntranceSpent] = useState(false)
  const markHomeEntranceSpent = useCallback(() => setHomeEntranceSpent(true), [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The mounted ChatView's transport dispose. Session switches call it BEFORE
  // remounting so an in-flight run is aborted and its part subscription
  // dropped — no ghost listeners, and the run's partial reply is persisted
  // main-side (M1.4). StrictMode-safe: never tied to an effect cleanup.
  const chatDisposeRef = useRef<(() => void) | null>(null)
  const registerDispose = useCallback((dispose: (() => void) | null) => {
    chatDisposeRef.current = dispose
  }, [])
  // Event ordering: per-session monotonic seq. Stale events are discarded so
  // a delayed prior run cannot overwrite a newer plan. There is deliberately
  // no runId gate: chat:send mints a new runId per turn (docs/03 §4, M1.5),
  // so a legitimate new run — the plan → "go ahead" handoff included —
  // always carries an id the renderer has not seen yet, and gating on the
  // previous run's id dropped its approval dialog and parked the whole chain
  // (Phase-1 item 3 live repro: approval/requested arrived, no dialog ever
  // rendered). Approvals key by approvalId instead (M3.2), and a decision
  // for a no-longer-pending approval answers with an explicit error, never
  // a silent hang.
  const lastSeqRef = useRef(0)

  // MVP onboarding gate (MVP_PLAN.md; M6.1 cut): first launch walks one
  // static screen until a workspace AND an API key exist. null = still
  // checking (render nothing — a brief blank beats flashing the chat UI);
  // a failed check degrades to the main UI, which already handles both
  // missing states honestly.
  const [setupReady, setSetupReady] = useState<boolean | null>(null)
  // Locale loads with the first settings read so the onboarding screen (which
  // renders before the appearance effect's setupReady gate) already speaks
  // the saved language; the appearance effect re-applies it for later changes.
  useEffect(() => {
    let cancelled = false
    Promise.all([window.agento.settings.get(), window.agento.workspaces.get()])
      .then(([settings, workspaces]) => {
        if (cancelled) return
        const saved = settings.locale
        if (saved === 'en' || saved === 'ar') applyLocale(saved)
        // Keyless custom profiles (local servers) are startable without a key
        // (docs/03 §10) — the launch gate must match Onboarding's readiness.
        setSetupReady(
          canStartChat(settings.provider, settings.hasKey) && workspaces.current !== null
        )
      })
      .catch(() => {
        if (!cancelled) setSetupReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [applyLocale])

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
        if (cancelled) return
        apply(snapshot.appearance ?? 'dark')
        const saved = snapshot.locale
        if (saved === 'en' || saved === 'ar') applyLocale(saved)
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
  }, [setupReady, applyLocale])

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
          setApprovalError(result.reason ?? translate(locale, 'app.decisionRejected'))
        }
      })
      .catch((error) => {
        setApprovalError(
          error instanceof Error ? error.message : translate(locale, 'app.sendFailed')
        )
      })
      .finally(() => setApprovalPending(false))
  }

  const resetPlan = useCallback(() => {
    setPlan(null)
    setApproval(null)
    setApprovalError(null)
    setApprovalPending(false)
    // 2026-09-16: the run-status line belongs to the run, not the view — a
    // stale "Plan ready — nothing was changed." used to survive session
    // switches and new chats, announcing a plan the current view never got.
    setRunStatus(undefined)
    lastSeqRef.current = 0
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
        setRunStatus(translate(localeRef.current, 'app.planReady'))
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
        const L = localeRef.current
        setRunStatus(
          event.status === 'done'
            ? translate(L, 'app.checkingResult')
            : event.status === 'failed'
              ? translate(L, 'app.stepAttention')
              : event.status === 'skipped'
                ? translate(L, 'app.continuingSteps')
                : translate(L, 'app.workingPlan')
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
        const L = localeRef.current
        // Incomplete verification stays silent at thread level (user request):
        // '' passes through the liveStatus ?? fallback and is falsy at the
        // .run-status gate, so no line renders until settle clears. The
        // per-step `not verified` badge in PlanPanel is untouched.
        setRunStatus(event.isComplete ? translate(L, 'app.verifiedDone') : '')
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
        setRunStatus(translate(localeRef.current, 'app.waitingApproval'))
        setApproval(event)
        setApprovalError(null)
        // No false owning-step glyph: the approval request carries no
        // authoritative stepId yet, so the panel must not mark step 0 as
        // awaiting. The dialog itself is the approval surface.
      } else if (event.type === 'approval/resolved') {
        const L = localeRef.current
        setRunStatus(
          event.decision === 'approve'
            ? translate(L, 'app.approvedNext')
            : translate(L, 'app.continuingWithout')
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

  // Slash-command undos land outside a run settle, so they bump the same
  // Changes feed key directly (docs/04 §3.5).
  const onSlashMutated = useCallback(() => {
    setChangesRefreshKey((key) => key + 1)
  }, [])

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

  // Workspace Overview (demo destination): idle navigation only — the center
  // column swaps between the chat thread and the folder overview. Opening a
  // session or starting a task always returns to the chat view; the trust
  // loop (plan/approval/changes) is untouched.
  const [mainView, setMainView] = useState<'chat' | 'overview'>('chat')
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
  // Current folder for the Workspace Overview, pushed up from the sidebar's
  // picker (mount + every switch) — the overview follows it even while
  // mounted. Passing the raw setter keeps the picker's callback identity
  // stable (its mount effect depends on it).
  const [overviewWorkspace, setOverviewWorkspace] = useState<string | null>(null)
  const onPrefillConsumed = useCallback(() => setComposerPrefill(null), [])

  const openOverviewSession = useCallback(
    (session: SessionSummary) => {
      setMainView('chat')
      void openSession(session)
    },
    [openSession]
  )

  const startTaskFromOverview = useCallback(
    (prompt: string) => {
      setComposerPrefill(prompt)
      startNewChat()
      setMainView('chat')
    },
    [startNewChat]
  )

  const newChatFromOverview = useCallback(() => {
    setComposerPrefill(null)
    startNewChat()
    setMainView('chat')
  }, [startNewChat])

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
      else {
        startNewChat()
        setMainView('chat')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undoLastChange, startNewChat])

  if (setupReady === false) {
    return (
      <LocaleProvider locale={locale}>
        <Onboarding onDone={() => setSetupReady(true)} />
      </LocaleProvider>
    )
  }
  if (setupReady === null) {
    return <SidecarStatusDot />
  }

  return (
    <LocaleProvider locale={locale}>
      <SessionsSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onNewChat={() => {
          startNewChat()
          setMainView('chat')
        }}
        onOpenSession={(session) => {
          setMainView('chat')
          void openSession(session)
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenOverview={() => setMainView('overview')}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        settingsOpen={settingsOpen}
        onWorkspaceChanged={setOverviewWorkspace}
      />
      {/* Real three-column shell (UI_POLISH_PLAN.md): the thread lives in its
          own flex column (.chat-main), so messages can never render under the
          panels; the right rail is in flow — Plan above Changes — so the two
          panels can never overlap either. The Workspace Overview swaps the
          center column only; the rail hides while it is up. */}
      <main className="chat-main">
        {mainView === 'overview' ? (
          // Keyed by folder: a switch while mounted remounts fresh (loading
          // shimmer, no stale listing flashing through).
          <WorkspaceOverview
            key={overviewWorkspace}
            sessions={sessions}
            workspacePath={overviewWorkspace}
            onOpenSession={openOverviewSession}
            onNewChat={newChatFromOverview}
            onStartTask={startTaskFromOverview}
            onBack={() => setMainView('chat')}
          />
        ) : (
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
            onSlashMutated={onSlashMutated}
            greetingKey={greetingKey}
            playHomeEntrance={!homeEntranceSpent}
            onHomeEntrancePlayed={markHomeEntranceSpent}
            prefillPrompt={composerPrefill}
            onPrefillConsumed={onPrefillConsumed}
          />
        )}
      </main>
      {/* The rail collapses when there is no plan and no active session
          (docs/04 §2), and hides entirely under the Workspace Overview;
          ChangesPanel itself returns null without a session.
          Plain div wrapper — deliberately not a landmark: PlanPanel and
          ChangesPanel are the complementary regions (each has its own
          aria-label), avoiding three nested complementary landmarks. */}
      {mainView === 'chat' && (plan !== null || activeSessionId !== null) ? (
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
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLocaleChange={applyLocale}
      />
    </LocaleProvider>
  )
}

export default App
