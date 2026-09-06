import { ThreadPrimitive } from '@assistant-ui/react'

// docs/04 §8.4 / PROGRESS M1.7: appears only when scrolled up; clicking jumps
// to the bottom, and the viewport keeps following the stream while at bottom
// (Viewport auto-sticks). Composed on ThreadPrimitive.ScrollToBottom —
// assistant-ui covered this one, so no registry adoption was needed. The
// 0.11.56 primitive renders the button disabled while isAtBottom and exposes
// no data-state attributes, so visibility is styled off :disabled in main.css.
function ScrollToBottomButton(): React.JSX.Element {
  return (
    <ThreadPrimitive.ScrollToBottom className="scroll-to-bottom" aria-label="Scroll to bottom">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="m6 9 6 6 6-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </ThreadPrimitive.ScrollToBottom>
  )
}

export default ScrollToBottomButton
