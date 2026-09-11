import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { CustomProviderSnapshot, SettingsSnapshot } from '../../../preload/index'
import { useLocale } from './locale-context'

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

interface AnchorRect {
  top: number
  bottom: number
  left: number
  right: number
}

// Model chip (docs/04 §2 composer sketch): the active provider · model beside
// the Plan/Act tabs, with a compact popover to switch either without opening
// Settings — a live mid-demo model swap stays one click. Same invokes the
// Providers tab uses (settings:set-model / settings:set-provider); main owns
// validation and the model-resets-to-default rule on provider switches.
//
// The menu lists PROVIDERS only; clicking a row expands its models in a
// SEPARATE fixed panel aside — never providers and models stacked in one flat
// list, and never nested inside the menu's scroll box (overflow would clip
// it). Expansion is strictly click-driven: opening the menu shows no flyout
// and hovering over a row never opens one.
function ModelChip(): React.JSX.Element {
  const { t } = useLocale()
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [openProviderId, setOpenProviderId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const [submenuFlip, setSubmenuFlip] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const submenuRef = useRef<HTMLDivElement>(null)

  const load = useCallback((): void => {
    window.agento.settings
      .get()
      .then((next) => setSnapshot(next))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Position the flyout for an expanded row: anchor immediately (the row is
  // already mounted in every path that calls this), then pick the side that
  // fits once the panel's real width is known after paint. Plain function
  // (not memoized): the rAF + ref reads don't survive compiler memoization.
  function positionFlyout(id: string | null): void {
    setOpenProviderId(id)
    if (id === null) {
      setAnchor(null)
      return
    }
    const row = rowRefs.current.get(id)
    if (!row) {
      setAnchor(null)
      return
    }
    const rect = row.getBoundingClientRect()
    setAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right })
    requestAnimationFrame(() => {
      const panel = submenuRef.current
      const liveRow = rowRefs.current.get(id)
      if (!panel || !liveRow) return
      const box = liveRow.getBoundingClientRect()
      const width = panel.offsetWidth
      const rtl = document.documentElement.dir === 'rtl'
      if (!rtl) {
        const fitsRight = box.right + 6 + width <= window.innerWidth - 8
        const fitsLeft = box.left - 6 - width >= 8
        setSubmenuFlip(!fitsRight && fitsLeft)
      } else {
        const fitsLeft = box.left - 6 - width >= 8
        const fitsRight = box.right + 6 + width <= window.innerWidth - 8
        setSubmenuFlip(!fitsLeft && fitsRight)
      }
    })
  }

  // Close on any outside pointer press — the flyout is part of the popover,
  // so presses inside it must not close anything. The popover is a plain
  // card, not a dialog — no focus trap, Esc just closes via the same path.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      const inChip = containerRef.current?.contains(target) ?? false
      const inFlyout = submenuRef.current?.contains(target) ?? false
      if (!inChip && !inFlyout) {
        setOpen(false)
        setOpenProviderId(null)
        setAnchor(null)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  // Esc closes the flyout first, then the root menu.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (openProviderId !== null) positionFlyout(null)
        else setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // positionFlyout is a plain per-render function — intentionally not a
    // dep (it only touches refs + setState, never stale state).
  }, [open, openProviderId])

  // Keep the flyout glued to its row while the provider list scrolls under
  // it or the window resizes.
  useEffect(() => {
    if (!open || openProviderId === null) return
    const id = openProviderId
    const onReposition = (): void => positionFlyout(id)
    window.addEventListener('resize', onReposition)
    const list = listRef.current
    list?.addEventListener('scroll', onReposition, { passive: true })
    return () => {
      window.removeEventListener('resize', onReposition)
      list?.removeEventListener('scroll', onReposition)
    }
    // positionFlyout is a plain per-render function — intentionally not a
    // dep (it only touches refs + setState, never stale state).
  }, [open, openProviderId])

  const openRoot = (): void => {
    load()
    setError(null)
    setSubmenuFlip(false)
    setOpen(true)
    // No auto-expand: the menu opens with the provider list only — a row must
    // be clicked (or arrow-keyed) before its models panel appears.
  }

  const pickModel = async (providerId: string, model: string): Promise<void> => {
    if (snapshot === null) return
    setBusy(true)
    setError(null)
    try {
      const switched = providerId !== snapshot.provider
      if (switched) await window.agento.settings.setProvider({ provider: providerId })
      // setProvider already lands on the profile model for custom targets —
      // a second setModel would only churn updatedAt.
      const customTarget = snapshot.customProviders.find((p) => p.id === providerId)
      const alreadyCorrect = switched && customTarget?.model === model
      if (!alreadyCorrect && (switched || model !== snapshot.model)) {
        await window.agento.settings.setModel({ model })
      }
      setOpen(false)
      setOpenProviderId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('model.switchFailed'))
    } finally {
      setBusy(false)
      load()
    }
  }

  const label = snapshot
    ? `${providerLabel(snapshot.provider, snapshot.customProviders)} · ${snapshot.model}`
    : t('model.model')

  const providerIds = snapshot
    ? [...snapshot.providers, ...snapshot.customProviders.map((profile) => profile.id)]
    : []
  const modelsFor = (id: string): string[] => {
    if (!snapshot) return []
    const map = snapshot.providerModels ?? {}
    if (map[id]) return map[id]
    if (id === snapshot.provider) return snapshot.models
    const customModel = snapshot.customProviders.find((p) => p.id === id)?.model
    return customModel ? [customModel] : []
  }
  const isRtl = (): boolean =>
    typeof document !== 'undefined' && document.documentElement.dir === 'rtl'

  // Fixed-panel placement from the live anchor: bottom-aligned with the row
  // (the root menu opens upward, so top-alignment would push long lists
  // off-screen), height capped to the space above the viewport top.
  const rtl = isRtl()
  const placeAfter = rtl ? submenuFlip : !submenuFlip
  const flyoutStyle: CSSProperties =
    anchor === null
      ? { visibility: 'hidden' }
      : {
          ...(placeAfter
            ? { left: anchor.right + 6 }
            : { right: window.innerWidth - anchor.left + 6 }),
          bottom: window.innerHeight - anchor.bottom,
          maxHeight: Math.max(120, Math.min(224, anchor.bottom - 8))
        }

  const flyout =
    open && snapshot && openProviderId !== null && anchor !== null ? (
      <div
        ref={submenuRef}
        className="model-submenu"
        role="menu"
        aria-label={providerLabel(openProviderId, snapshot.customProviders)}
        style={flyoutStyle}
      >
        {modelsFor(openProviderId).map((model) => (
          <button
            key={model}
            type="button"
            role="menuitemradio"
            aria-checked={openProviderId === snapshot.provider && model === snapshot.model}
            disabled={busy}
            onClick={() => void pickModel(openProviderId, model)}
          >
            <span className="model-menu-check">
              {openProviderId === snapshot.provider && model === snapshot.model ? '✓' : ''}
            </span>
            {model}
          </button>
        ))}
      </div>
    ) : null

  return (
    <div className="model-chip-anchor" ref={containerRef}>
      <button
        type="button"
        className="model-chip"
        onClick={() => {
          if (open) {
            setOpen(false)
            setOpenProviderId(null)
          } else openRoot()
        }}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('model.switch')}
      >
        <span className="model-chip-label">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && snapshot ? (
        <div className="model-menu" role="menu" aria-label={t('model.menu')}>
          <p className="model-menu-section">{t('model.provider')}</p>
          <div className="model-menu-list" ref={listRef}>
            {providerIds.map((id) => {
              const expanded = openProviderId === id
              return (
                <button
                  key={id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(id, el)
                    else rowRefs.current.delete(id)
                  }}
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={expanded}
                  disabled={busy}
                  className="model-menu-item"
                  data-active={id === snapshot.provider ? 'true' : undefined}
                  onClick={() => positionFlyout(expanded ? null : id)}
                  onKeyDown={(event) => {
                    const rowRtl = isRtl()
                    const openKey = rowRtl ? 'ArrowLeft' : 'ArrowRight'
                    const closeKey = rowRtl ? 'ArrowRight' : 'ArrowLeft'
                    if (event.key === openKey) {
                      event.preventDefault()
                      positionFlyout(id)
                    } else if (event.key === closeKey && expanded) {
                      event.preventDefault()
                      positionFlyout(null)
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      positionFlyout(expanded ? null : id)
                    }
                  }}
                >
                  <span className="model-menu-check">{id === snapshot.provider ? '✓' : ''}</span>
                  <span className="model-menu-name">
                    {providerLabel(id, snapshot.customProviders)}
                  </span>
                  <span className="model-menu-chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              )
            })}
          </div>
          {error ? <p className="model-menu-error">{error}</p> : null}
        </div>
      ) : null}
      {flyout}
    </div>
  )
}

export default ModelChip
