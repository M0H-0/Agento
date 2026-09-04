import { useEffect, useRef, useState } from 'react'

// Settings modal (docs/04 §3.7): the Providers section — provider dropdown
// (Google AI Studio + Groq enabled this phase; the rest are honest "later"
// stubs), API-key entry stored via safeStorage (docs/06 §7), and the model
// pick for the active provider. Keys are never rendered back: after a save
// the dialog shows "•••• <last4>", which is all main ever sends. Permissions
// / Appearance / Data sections arrive with M6.3.

// Structural mirror of SettingsSnapshot in src/preload/index.d.ts — the
// renderer consumes window.agento typed globally and doesn't import preload.
interface SettingsSnapshot {
  provider: string
  model: string
  hasKey: boolean
  keyLast4: string
  storageAvailable: boolean
  providers: string[]
  models: string[]
}

// Enabled-provider labels; anything in the dropdown beyond snapshot.providers
// stays a disabled stub (main decides what's enabled, docs/04 §3.7).
const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google AI Studio',
  groq: 'Groq'
}

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

function SettingsDialog({ open, onClose }: SettingsDialogProps): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    // Fresh pull on every open so a reopened dialog reflects current state.
    // setState only in the async continuations (react-hooks/set-state-in-effect).
    let cancelled = false
    window.agento.settings
      .get()
      .then((next) => {
        if (cancelled) return
        setSnapshot(next)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setError('Could not load settings.')
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (open) dialogRef.current?.focus()
  }, [open])

  const saveKey = (): void => {
    if (snapshot === null || keyDraft.trim() === '') return
    setBusy(true)
    window.agento.settings
      .setApiKey({ provider: snapshot.provider, key: keyDraft })
      .then(() => {
        // Drop the plaintext from renderer state the moment main has it.
        setKeyDraft('')
        return window.agento.settings.get()
      })
      .then((next) => {
        setSnapshot(next)
        setError(null)
      })
      .catch(() => setError('Saving the key failed.'))
      .finally(() => setBusy(false))
  }

  const removeKey = (): void => {
    if (snapshot === null) return
    setBusy(true)
    window.agento.settings
      .clearApiKey({ provider: snapshot.provider })
      .then(() => window.agento.settings.get())
      .then((next) => {
        setSnapshot(next)
        setError(null)
      })
      .catch(() => setError('Removing the key failed.'))
      .finally(() => setBusy(false))
  }

  const changeModel = (model: string): void => {
    if (snapshot === null) return
    setBusy(true)
    window.agento.settings
      .setModel({ model })
      .then(() => window.agento.settings.get())
      .then((next) => {
        setSnapshot(next)
        setError(null)
      })
      .catch(() => setError('Changing the model failed.'))
      .finally(() => setBusy(false))
  }

  const changeProvider = (provider: string): void => {
    if (snapshot === null || provider === snapshot.provider) return
    setBusy(true)
    // Clear any in-progress key draft: it belonged to the previous provider.
    setKeyDraft('')
    window.agento.settings
      .setProvider({ provider })
      .then(() => window.agento.settings.get())
      .then((next) => {
        setSnapshot(next)
        setError(null)
      })
      .catch(() => setError('Changing the provider failed.'))
      .finally(() => setBusy(false))
  }

  if (!open) return null

  const maskedKey = snapshot?.keyLast4 === '' ? '••••' : `•••• ${snapshot?.keyLast4 ?? ''}`

  return (
    <div
      className="settings-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <h2 id="settings-title" className="settings-title">
          Settings
        </h2>

        {snapshot === null ? (
          <p className="settings-note">Loading settings…</p>
        ) : (
          <section className="settings-section" aria-label="Providers">
            <h3 className="settings-heading">Providers</h3>

            <div className="settings-field">
              <span className="settings-label" id="settings-provider-label">
                Provider
              </span>
              {/* Enabled providers come from main (snapshot.providers); the
                  disabled entries are honest stubs until their phases land. */}
              <select
                className="settings-select"
                value={snapshot.provider}
                aria-labelledby="settings-provider-label"
                disabled={busy}
                onChange={(event) => changeProvider(event.target.value)}
              >
                {snapshot.providers.map((provider) => (
                  <option key={provider} value={provider}>
                    {PROVIDER_LABELS[provider] ?? provider}
                  </option>
                ))}
                <option value="anthropic" disabled>
                  Anthropic (later)
                </option>
                <option value="openai" disabled>
                  OpenAI (later)
                </option>
              </select>
            </div>

            <div className="settings-field">
              <span className="settings-label" id="settings-key-label">
                API key
              </span>
              {snapshot.hasKey ? (
                <div className="settings-key-row">
                  <span className="settings-key-display" aria-label="Stored API key (masked)">
                    {maskedKey}
                  </span>
                  <button
                    type="button"
                    className="settings-remove"
                    onClick={removeKey}
                    disabled={busy}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="settings-key-row">
                  <input
                    type="password"
                    className="settings-input"
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    placeholder="Paste your API key"
                    autoComplete="off"
                    spellCheck={false}
                    aria-labelledby="settings-key-label"
                  />
                  <button
                    type="button"
                    className="settings-save"
                    onClick={saveKey}
                    disabled={busy || keyDraft.trim() === ''}
                  >
                    Save
                  </button>
                </div>
              )}
              {!snapshot.storageAvailable && (
                <p className="settings-warning">
                  OS encryption unavailable — the key is kept for this session only.
                </p>
              )}
            </div>

            <div className="settings-field">
              <span className="settings-label" id="settings-model-label">
                Model
              </span>
              <select
                className="settings-select"
                value={snapshot.model}
                aria-labelledby="settings-model-label"
                onChange={(event) => changeModel(event.target.value)}
              >
                {snapshot.models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </div>

            {error !== null && <p className="settings-error">{error}</p>}
          </section>
        )}
      </div>
    </div>
  )
}

export default SettingsDialog
