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
import SettingsDialog from './components/SettingsDialog'
import SessionsSidebar from './components/SessionsSidebar'
import SidecarStatusDot from './components/SidecarStatusDot'

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
      <MessagePrimitive.Parts components={{ Text: MessageText }} />
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
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ViewportFooter className="thread-footer">
        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input
            className="composer-input"
            placeholder="Message Agento…"
            rows={1}
            autoFocus
          />
          <ComposerPrimitive.Send className="composer-send">Send</ComposerPrimitive.Send>
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
  initialMessages
}: ChatViewProps): React.JSX.Element {
  // Created once per mount: the transport is stateless, but useChat captured
  // it at Chat construction, so a per-render identity would be a lie.
  const [transport] = useState(() =>
    createIpcChatTransport({ getSessionId, onSessionCreated, onSettled })
  )
  const chat = useChat({ transport, messages: initialMessages })
  const runtime = useAISDKRuntime(chat)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
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

  const getSessionId = useCallback(() => activeSessionIdRef.current, [])

  const onSessionCreated = useCallback(
    (session: SessionSummary) => {
      activeSessionIdRef.current = session.id
      setActiveSessionId(session.id)
      refreshSessions()
    },
    [refreshSessions]
  )

  const onSettled = useCallback(() => refreshSessions(), [refreshSessions])

  const openSession = useCallback(async (session: SessionSummary) => {
    if (session.id === activeSessionIdRef.current) return
    try {
      const messages = await window.agento.sessions.messages({ sessionId: session.id })
      activeSessionIdRef.current = session.id
      setActiveSessionId(session.id)
      setPendingMessages(messages)
      setThreadEpoch((epoch) => epoch + 1)
    } catch (error) {
      console.error('session:messages failed:', error)
    }
  }, [])

  const startNewChat = useCallback(() => {
    activeSessionIdRef.current = null
    setActiveSessionId(null)
    setPendingMessages([])
    setThreadEpoch((epoch) => epoch + 1)
  }, [])

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
      <ChatView
        key={threadEpoch}
        getSessionId={getSessionId}
        onSessionCreated={onSessionCreated}
        onSettled={onSettled}
        initialMessages={pendingMessages}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )
}

export default App
