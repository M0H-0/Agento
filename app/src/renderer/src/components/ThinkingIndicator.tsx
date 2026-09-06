import { AssistantIf } from '@assistant-ui/react'
import { Loader } from './ui/loader'

// docs/04 §8.4: the thinking affordance covers the reasoning lead-in — shown
// while this assistant message's run is active but no text has arrived yet
// (gpt-oss streams ~57 reasoning deltas before any text, M1.3). The condition
// is composed from assistant-ui's AssistantIf; the visual is the prompt-kit
// Loader (docs/04 §4 log), animated by CSS keyframes in main.css.
function ThinkingIndicator(): React.JSX.Element {
  return (
    <AssistantIf
      condition={({ message }) =>
        message.status?.type === 'running' &&
        !message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
      }
    >
      <div className="thinking-indicator" role="status">
        <Loader size="sm" />
      </div>
    </AssistantIf>
  )
}

export default ThinkingIndicator
