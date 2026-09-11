import { useCallback, useEffect, useRef, useState } from 'react'
import { useThreadRuntime } from '@assistant-ui/react'
import { useLocale } from './locale-context'

// Composer file references (gap 1): a paperclip button opens a searchable
// workspace-scoped picker, and typing `@name` in the composer opens the same
// list filtered. Picks become removable chips; the transport appends them as
// `Context files: @relpath` reference text (chat/attachments.ts) — the model
// reads content via read_file, so no binary upload and no IPC contract
// change. Relative paths only; the absolute root never crosses the bridge.

interface FileAttachProps {
  attachments: string[]
  onChange: (next: string[]) => void
  disabled: boolean
  sessionId: string | null
}

interface FileEntry {
  relativePath: string
  isDir: boolean
}

const MAX_SHOWN = 50

function PaperclipIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function FileAttach({
  attachments,
  onChange,
  disabled,
  sessionId
}: FileAttachProps): React.JSX.Element {
  const { t } = useLocale()
  const runtime = useThreadRuntime({ optional: true })
  const [open, setOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const loadAttempted = useRef(false)

  // The parent keys this component by session, so the cache below is
  // already session-scoped — no reset effect needed.
  const load = useCallback((): void => {
    if (loadAttempted.current) return
    loadAttempted.current = true
    setLoading(true)
    setError(null)
    window.agento.workspaces
      .listFiles({ sessionId: sessionId ?? undefined, limit: 500 })
      .then((result) => {
        setFiles(result.files)
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : t('attach.listFailed'))
        loadAttempted.current = false
      })
      .finally(() => setLoading(false))
  }, [sessionId, t])

  // `@` mention detection on the assistant-ui composer input. The composer
  // itself is runtime-owned — we only listen for the trigger and strip the
  // query text on pick; all other keystrokes pass through untouched.
  // `mentionOpenRef` tracks whether THIS popover instance was mention-opened,
  // so typing past the trigger closes only our own popover.
  const mentionOpenRef = useRef(false)
  useEffect(() => {
    if (disabled || !runtime) return
    const input = document.querySelector<HTMLTextAreaElement>('.composer .composer-input')
    if (!input) return
    const onInput = (): void => {
      const caret = input.selectionStart ?? input.value.length
      const before = input.value.slice(0, caret)
      const match = /@([\w\-.\\/]*)$/.exec(before)
      if (match) {
        mentionOpenRef.current = true
        load()
        setMentionQuery(match[1])
        setQuery(match[1])
        setActiveIndex(0)
        setOpen(true)
      } else if (mentionOpenRef.current) {
        mentionOpenRef.current = false
        setMentionQuery(null)
        setOpen(false)
      }
    }
    input.addEventListener('input', onInput)
    return () => input.removeEventListener('input', onInput)
  }, [disabled, runtime, load])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        mentionOpenRef.current = false
        setOpen(false)
        setMentionQuery(null)
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        mentionOpenRef.current = false
        setOpen(false)
        setMentionQuery(null)
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open && mentionQuery === null) searchRef.current?.focus()
  }, [open, mentionQuery])

  const add = (path: string): void => {
    if (!attachments.includes(path)) onChange([...attachments, path])
    if (mentionQuery !== null && runtime) {
      // Strip the typed `@query` so the chip is the single source of truth.
      const current = runtime.composer.getState().text
      const at = `@${mentionQuery}`
      const idx = current.lastIndexOf(at)
      if (idx >= 0) {
        runtime.composer.setText(`${current.slice(0, idx)}${current.slice(idx + at.length)}`)
      }
      document.querySelector<HTMLTextAreaElement>('.composer .composer-input')?.focus()
      mentionOpenRef.current = false
      setOpen(false)
      setMentionQuery(null)
    }
  }

  const remove = (path: string): void => {
    onChange(attachments.filter((p) => p !== path))
  }

  const needle = (mentionQuery ?? query).trim().toLowerCase()
  const matches = (files ?? [])
    .filter((f) => (needle === '' ? true : f.relativePath.toLowerCase().includes(needle)))
    .slice(0, MAX_SHOWN)

  return (
    <>
      {attachments.length > 0 ? (
        <div className="composer-attachments" aria-label={t('attach.attached')}>
          {attachments.map((path) => (
            <span key={path} className="attach-chip" title={path}>
              <span className="attach-chip-path">
                @<bdi>{path}</bdi>
              </span>
              <button
                type="button"
                className="attach-remove"
                aria-label={t('attach.remove', { name: path })}
                disabled={disabled}
                onClick={() => remove(path)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {/* Anchor sits inline in the composer's input row (paperclip · input ·
          Send) so the button never takes its own line; only the chips above
          span the full width. */}
      <div className="attach-anchor" ref={rootRef}>
        <button
          type="button"
          className="attach-btn"
          aria-label={t('attach.label')}
          aria-haspopup="listbox"
          aria-expanded={open && mentionQuery === null}
          title={t('attach.title')}
          disabled={disabled}
          onClick={() => {
            if (open && mentionQuery === null) {
              setOpen(false)
            } else {
              load()
              setMentionQuery(null)
              setQuery('')
              setActiveIndex(0)
              setOpen(true)
            }
          }}
        >
          <PaperclipIcon />
        </button>
        {open ? (
          <div className="attach-popover" role="listbox" aria-label={t('attach.files')}>
            {mentionQuery === null ? (
              <input
                ref={searchRef}
                className="attach-search"
                placeholder={t('attach.search')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setActiveIndex((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)))
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setActiveIndex((i) => Math.max(i - 1, 0))
                  } else if (event.key === 'Enter') {
                    event.preventDefault()
                    const pick = matches[activeIndex]
                    if (pick) add(pick.relativePath)
                  }
                }}
                aria-label={t('attach.searchLabel')}
              />
            ) : null}
            <div className="attach-list">
              {loading ? <p className="attach-empty">{t('attach.loading')}</p> : null}
              {error ? <p className="attach-error">{error}</p> : null}
              {!loading && !error && matches.length === 0 ? (
                <p className="attach-empty">
                  {files !== null && files.length === 0 ? t('attach.empty') : t('attach.noMatch')}
                </p>
              ) : null}
              {matches.map((file, index) => (
                <button
                  key={file.relativePath}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={
                    index === activeIndex ? 'attach-item attach-item--active' : 'attach-item'
                  }
                  title={file.relativePath}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => add(file.relativePath)}
                >
                  <bdi>{file.relativePath}</bdi>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}

export default FileAttach
