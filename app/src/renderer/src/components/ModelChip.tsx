import { useCallback, useEffect, useRef, useState } from 'react'
import type { CustomProviderSnapshot, SettingsSnapshot } from '../../../preload/index'

// Provider display labels (mirror of SettingsDialog's PROVIDER_LABELS —
// built-in ids only; custom profiles carry their own name).
const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google AI Studio',
  groq: 'Groq'
}

function providerLabel(id: string, customs: CustomProviderSnapshot[]): string {
  if (PROVIDER_LABELS[id]) return PROVIDER_LABELS[id]
  return customs.find((profile) => profile.id === id)?.name ?? id
}

// Model chip (docs/04 §2 composer sketch): the active provider · model beside
// the Plan/Act tabs, with a compact popover to switch either without opening
// Settings — a live mid-demo model swap stays one click. Same invokes the
// Providers tab uses (settings:set-model / settings:set-provider); main owns
// validation and the model-resets-to-default rule on provider switches.
function ModelChip(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const load = useCallback((): void => {
    window.agento.settings
      .get()
      .then((next) => setSnapshot(next))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Close on any outside pointer press; the popover is a plain card, not a
  // dialog — no focus trap, Esc just closes via the same path.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const pick = async (action: 'model' | 'provider', value: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (action === 'model') await window.agento.settings.setModel({ model: value })
      else await window.agento.settings.setProvider({ provider: value })
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch.')
    } finally {
      setBusy(false)
      load()
    }
  }

  const label = snapshot
    ? `${providerLabel(snapshot.provider, snapshot.customProviders)} · ${snapshot.model}`
    : 'Model'

  return (
    <div className="model-chip-anchor" ref={containerRef}>
      <button
        type="button"
        className="model-chip"
        onClick={() => {
          if (open) setOpen(false)
          else {
            load()
            setOpen(true)
            setError(null)
          }
        }}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch model or provider"
      >
        <span className="model-chip-label">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && snapshot ? (
        <div className="model-menu" role="menu" aria-label="Model and provider">
          <p className="model-menu-section">Model</p>
          {snapshot.models.map((model) => (
            <button
              key={model}
              type="button"
              role="menuitemradio"
              aria-checked={model === snapshot.model}
              disabled={busy}
              onClick={() => void pick('model', model)}
            >
              <span className="model-menu-check">{model === snapshot.model ? '✓' : ''}</span>
              {model}
            </button>
          ))}
          <p className="model-menu-section">Provider</p>
          {[...snapshot.providers, ...snapshot.customProviders.map((profile) => profile.id)].map(
            (id) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={id === snapshot.provider}
                disabled={busy}
                onClick={() => void pick('provider', id)}
              >
                <span className="model-menu-check">{id === snapshot.provider ? '✓' : ''}</span>
                {providerLabel(id, snapshot.customProviders)}
              </button>
            )
          )}
          {error ? <p className="model-menu-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

export default ModelChip
