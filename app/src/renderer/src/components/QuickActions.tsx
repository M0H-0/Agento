import { useThreadRuntime } from '@assistant-ui/react'

// Example prompts for the empty thread (docs/04 §3.5/§3.8, P1). The copy
// mirrors the scripted demo scenario (docs/07 §4) — one chip per headline
// capability (batch file work, document summarization, semantic search) —
// so the cold-open screen doubles as a one-click demo cue.
const QUICK_ACTIONS = [
  'Organize this folder by file type',
  'Make a one-page summary of every PDF in this folder',
  'Where did I write about pricing?'
]

// QuickActions chips fill the composer and focus it — they NEVER auto-send
// (docs/04 §3.5). They render inside the empty-thread welcome, i.e. within
// ThreadPrimitive.Root, so the thread runtime (and its composer) exists;
// the optional hook just degrades to nothing outside that scope.
function QuickActions(): React.JSX.Element | null {
  const runtime = useThreadRuntime({ optional: true })
  if (!runtime) return null
  const fillComposer = (prompt: string): void => {
    runtime.composer.setText(prompt)
    document.querySelector<HTMLInputElement>('.composer-input')?.focus()
  }
  return (
    <div className="quick-actions" role="list" aria-label="Example prompts">
      {QUICK_ACTIONS.map((prompt) => (
        <button
          key={prompt}
          type="button"
          role="listitem"
          className="quick-action-chip"
          onClick={() => fillComposer(prompt)}
        >
          {prompt}
        </button>
      ))}
    </div>
  )
}

export default QuickActions
