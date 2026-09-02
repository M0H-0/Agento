import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime
} from '@assistant-ui/react'
import type { ChatModelAdapter, ThreadMessage } from '@assistant-ui/react'

// Hello-world ChatModelAdapter: streams a fixed echo/greeting word by word.
// No IPC, no model provider, no network — everything runs in the renderer.
// Each yield is a cumulative snapshot of the assistant message content;
// assistant-ui renders the most recent yielded result as the stream grows.
// Replaced by the real IPC transport in M0.3 (docs/02 §2.1).
const helloWorldAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const said = extractText(messages[messages.length - 1])
    const reply =
      said.length > 0
        ? `Hello from Agento! You said: “${said}”. This hello-world exchange runs entirely in the renderer.`
        : 'Hello from Agento! This hello-world exchange runs entirely in the renderer.'

    let streamed = ''
    for (const word of reply.split(' ')) {
      if (abortSignal.aborted) return
      streamed = streamed ? `${streamed} ${word}` : word
      await new Promise((resolve) => setTimeout(resolve, 40))
      yield { content: [{ type: 'text' as const, text: streamed }] }
    }
  }
}

function extractText(message: ThreadMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join(' ')
    .trim()
}

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

function Thread(): React.JSX.Element {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.If empty>
          <div className="thread-welcome">
            <h1>Agento</h1>
            <p>Say something to try the hello-world runtime.</p>
          </div>
        </ThreadPrimitive.If>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
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

function App(): React.JSX.Element {
  const runtime = useLocalRuntime(helloWorldAdapter)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

export default App
