import { useEffect, useState } from 'react'
import { useThreadRuntime } from '@assistant-ui/react'
import { genericPrompts, suggestPromptsFromScan } from '../chat/suggestions'

// Example prompts for the empty thread (docs/04 §3.5/§3.8, P1). Generated
// from a lightweight scan of the current workspace folder (one capped
// `workspace:list-files` + session titles for the pricing keyword) instead
// of hardcoded assumptions: PDF chips need PDFs, the organize chip needs a
// real mix, and the pricing chip needs filename or title evidence. Generic
// fallbacks cover empty folders and scan failures — and render immediately
// so the chips never flash a wrong guess while scanning.
function QuickActions(): React.JSX.Element | null {
  const runtime = useThreadRuntime({ optional: true })
  const [prompts, setPrompts] = useState<string[]>(() => genericPrompts())

  useEffect(() => {
    let cancelled = false
    Promise.all([window.agento.workspaces.listFiles({ limit: 500 }), window.agento.sessions.list()])
      .then(([listing, sessions]) => {
        if (cancelled) return
        setPrompts(
          suggestPromptsFromScan(
            listing.files,
            sessions.map((session) => session.title)
          )
        )
      })
      .catch(() => {
        if (!cancelled) setPrompts(genericPrompts())
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!runtime) return null
  const fillComposer = (prompt: string): void => {
    runtime.composer.setText(prompt)
    document.querySelector<HTMLInputElement>('.composer-input')?.focus()
  }
  return (
    <div className="quick-actions" role="list" aria-label="Example prompts">
      {prompts.map((prompt) => (
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
