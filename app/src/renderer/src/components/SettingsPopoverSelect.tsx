import { useEffect, useRef, useState } from 'react'

export interface PopoverSelectOption {
  value: string
  label: string
}

interface SettingsPopoverSelectProps {
  labelledBy: string
  describedBy?: string
  disabled?: boolean
  value: string
  options: PopoverSelectOption[]
  onChange: (value: string) => void
}

// Custom listbox replacing the native <select> in Settings: the dialog is a
// scroll container and native popups clip against it. The menu opens
// DOWNWARD in-flow and only flips upward when it would overflow the app
// window bottom — never just because dialog room runs out (the dialog
// scrolls to reveal it instead, so the tab bar stays uncovered). It follows
// the theme and aligns correctly in RTL (logical text-align in CSS).
export function SettingsPopoverSelect({
  labelledBy,
  describedBy,
  disabled = false,
  value,
  options,
  onChange
}: SettingsPopoverSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Flip direction, decided at open time: downward unless the menu would
  // overflow the app window bottom.
  const [above, setAbove] = useState(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLUListElement | null>(null)

  // Outside pointer press or Escape closes (and refocuses the button).
  // Capture + stopPropagation keeps the dialog's own document Esc→close
  // listener from firing while this menu owns the keypress.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      document.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [open])

  const current = options.find((option) => option.value === value)

  const toggle = (): void => {
    if (!open && anchorRef.current) {
      // Estimate the menu height (capped by its max-height + scroll) and
      // compare against the app window — not the dialog box. Dialog-internal
      // overflow is fine (the dialog scrolls to reveal the menu); only the
      // window edge is hard clipping worth flipping upward for.
      const anchorRect = anchorRef.current.getBoundingClientRect()
      const gap = 6
      const estimated = Math.min(options.length * 36 + 12, 204)
      const roomBelow = window.innerHeight - anchorRect.bottom - gap
      const roomAbove = anchorRect.top - gap
      setAbove(roomBelow < estimated && roomAbove > roomBelow)
    }
    setOpen((previous) => !previous)
  }

  // When opening downward, nudge the dialog scroll just enough to reveal the
  // menu instead of covering the rows above it.
  useEffect(() => {
    if (open && !above) menuRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, above])

  return (
    <div className="settings-pop-anchor" ref={anchorRef}>
      <button
        ref={btnRef}
        type="button"
        className="settings-select settings-pop-btn"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        <bdi>{current?.label ?? value}</bdi>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul
          ref={menuRef}
          className={above ? 'settings-pop-menu settings-pop-menu--above' : 'settings-pop-menu'}
          role="listbox"
          aria-labelledby={labelledBy}
        >
          {options.map((option) => {
            const selected = option.value === value
            return (
              <li key={option.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  onClick={() => {
                    setOpen(false)
                    if (!selected) onChange(option.value)
                  }}
                >
                  <bdi>{option.label}</bdi>
                  {selected ? <span aria-hidden="true">✓</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
