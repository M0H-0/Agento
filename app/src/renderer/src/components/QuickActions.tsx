import { useEffect, useState } from 'react'
import { useThreadRuntime } from '@assistant-ui/react'
import { genericPrompts, suggestPromptsFromScan } from '../chat/suggestions'

// Line icons for the chips (no icon dep — STACK.md): 24-grid, stroke follows
// the chip text color, same 2px round treatment as the composer's paperclip.
function ChipIcon({ d, circle }: { d?: string; circle?: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {circle ? <circle cx="11" cy="11" r="7" /> : null}
      {d ? <path d={d} /> : null}
    </svg>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <ChipIcon d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  )
}

function DocumentIcon(): React.JSX.Element {
  return (
    <ChipIcon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6" />
  )
}

function SearchIcon(): React.JSX.Element {
  return <ChipIcon circle d="m21 21-4.3-4.3" />
}

function ListIcon(): React.JSX.Element {
  return <ChipIcon d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
}

function SparkIcon(): React.JSX.Element {
  return (
    <ChipIcon d="M12 3c.6 4.5 2.5 6.4 7 7-4.5.6-6.4 2.5-7 7-.6-4.5-2.5-6.4-7-7 4.5-.6 6.4-2.5 7-7Z" />
  )
}

// Icon by prompt content — the suggestion pool in chat/suggestions.ts is a
// closed set, so substring matching stays stable without touching that
// contract (mirrored main-side in workspace-listing.ts).
function iconForPrompt(prompt: string): React.JSX.Element {
  const text = prompt.toLowerCase()
  if (text.includes('organiz')) return <FolderIcon />
  if (text.includes('summary') || text.includes('pdf')) return <DocumentIcon />
  if (text.includes('pric') || text.startsWith('where did')) return <SearchIcon />
  if (text.includes('list the files')) return <ListIcon />
  return <SparkIcon />
}

// Example prompts for the empty thread (docs/04 §3.5/§3.8, P1). Generated
// from a lightweight scan of the current workspace folder (one capped
// `workspace:list-files` + session titles for the pricing keyword) instead
// of hardcoded assumptions: PDF chips need PDFs, the organize chip needs a
// real mix, and the pricing chip needs filename or title evidence. Generic
// fallbacks cover empty folders and scan failures — and render immediately
// so the chips never flash a wrong guess while scanning.
function QuickActions({
  playEntrance = false
}: {
  playEntrance?: boolean
}): React.JSX.Element | null {
  const runtime = useThreadRuntime({ optional: true })
  const [prompts, setPrompts] = useState<string[]>(() => genericPrompts())
  // Latched at mount like the welcome (see App.tsx): the async scan
  // re-render must not restart the entrance, and later new chats mount fresh
  // with playEntrance already false from App.
  const [animate] = useState(playEntrance)

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
    <div
      className={animate ? 'quick-actions home-enter' : 'quick-actions'}
      role="list"
      aria-label="Example prompts"
    >
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          role="listitem"
          className="quick-action-chip"
          onClick={() => fillComposer(prompt)}
        >
          <span className="quick-action-icon" aria-hidden="true">
            {iconForPrompt(prompt)}
          </span>
          <span>{prompt}</span>
        </button>
      ))}
    </div>
  )
}

export default QuickActions
