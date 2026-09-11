import { useEffect, useRef, useState } from 'react'
import { useThreadRuntime } from '@assistant-ui/react'
import type { SlashCommandDef } from '../chat/slash-commands'
import {
  expandSlashTemplate,
  filterSlashCommands,
  parseSlashCommand,
  SLASH_COMMANDS,
  slashMenuQuery
} from '../chat/slash-commands'
import { plural } from '../chat/locale'
import type { StringKey } from '../chat/locale'
import { useLocale } from './locale-context'

// Slash command menu (docs/04 §3.5): typing `/` at the start of the composer
// opens the same upward popover treatment as the file picker — no new deps,
// no assistant-ui primitive for this (its composer has no slash notion, the
// same reason FileAttach is custom). Local commands (`/undo`, `/undo-all`,
// `/help`) run in the renderer; template commands (`/search`, `/semantic`)
// expand to prose and send through the normal transport, so the registry
// wrapper, approvals, snapshots, and verification all hold.

interface SlashMenuProps {
  disabled: boolean
  sessionId: string | null
  /** Bump the Changes feed after a slash undo lands. */
  onMutated: () => void
}

type SlashView =
  | { kind: 'closed' }
  | { kind: 'menu'; query: string; active: number }
  | {
      kind: 'confirm'
      target: 'undo' | 'undo-all'
      detail: string
      busy: boolean
      error: string | null
    }
  | { kind: 'help' }
  | { kind: 'hint'; message: string }

const LEADING_TOKEN_RE = /^(\s*)\/[A-Za-z-]*/

// Menu descriptions live in the locale dictionary (slash.desc.*) — the defs
// in chat/slash-commands.ts stay a locale-free catalog (unit-tested as-is);
// unknown names fall back to the catalog description.
const DESC_KEYS: Record<string, StringKey> = {
  search: 'slash.desc.search',
  semantic: 'slash.desc.semantic',
  undo: 'slash.desc.undo',
  'undo-all': 'slash.desc.undoAll',
  help: 'slash.desc.help'
}

function stripLeadingToken(text: string): string {
  return text.replace(LEADING_TOKEN_RE, '')
}

function completeCommand(text: string, name: string): string {
  if (LEADING_TOKEN_RE.test(text)) return text.replace(LEADING_TOKEN_RE, `$1/${name} `)
  return `/${name} `
}

function SlashMenu({ disabled, sessionId, onMutated }: SlashMenuProps): React.JSX.Element | null {
  const { locale, t } = useLocale()
  const runtime = useThreadRuntime({ optional: true })
  const [view, setView] = useState<SlashView>({ kind: 'closed' })
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef(view)
  const disabledRef = useRef(disabled)
  const sessionRef = useRef(sessionId)
  // Ref sync lives in an effect (render-time writes trip react-hooks/refs;
  // the listeners below read through these so stale closures never act).
  useEffect(() => {
    viewRef.current = view
    disabledRef.current = disabled
    sessionRef.current = sessionId
  })

  const close = (): void => {
    if (viewRef.current.kind === 'confirm' && viewRef.current.busy) return
    setView({ kind: 'closed' })
  }

  // Open the undo confirm: fetch the newest change group so the question can
  // name what it will restore (both undo flavors ask first — user decision).
  const describe = (def: SlashCommandDef): string => {
    const key = DESC_KEYS[def.name]
    return key ? t(key) : def.description
  }

  const openConfirm = (target: 'undo' | 'undo-all'): void => {
    const id = sessionRef.current
    if (!id) {
      setView({ kind: 'hint', message: t('slash.noConversation') })
      return
    }
    setView({ kind: 'confirm', target, detail: '', busy: true, error: null })
    window.agento.changes
      .list({ sessionId: id })
      .then((result) => {
        if (target === 'undo-all') {
          if (result.activeCount === 0) {
            setView({ kind: 'hint', message: t('slash.noChanges') })
            return
          }
          setView({
            kind: 'confirm',
            target,
            detail: plural(locale, result.activeCount, {
              one: t('slash.changesDetailOne'),
              two: t('slash.changesDetailTwo'),
              many: t('slash.changesDetailMany')
            }),
            busy: false,
            error: null
          })
          return
        }
        const newest = result.entries.find((entry) => entry.revertedAt === null)
        if (!newest) {
          setView({ kind: 'hint', message: t('slash.noChanges') })
          return
        }
        const key = newest.groupKey ?? `solo:${newest.id}`
        const paths = result.entries
          .filter(
            (entry) => entry.revertedAt === null && (entry.groupKey ?? `solo:${entry.id}`) === key
          )
          .map((entry) => entry.relativePath)
          .filter((path, index, all) => all.indexOf(path) === index)
        const shown = paths.slice(0, 3).join(', ')
        const extra = paths.length > 3 ? t('slash.andMore', { n: paths.length - 3 }) : ''
        setView({ kind: 'confirm', target, detail: shown + extra, busy: false, error: null })
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : t('slash.readFailed')
        setView({ kind: 'confirm', target, detail: '', busy: false, error: message })
      })
  }

  // Run the confirmed undo — the same oldest-first fan-out as the Changes
  // panel's per-item undo and App's Ctrl+Z (a move's rows restore correctly).
  const runConfirm = (): void => {
    const started = viewRef.current
    if (started.kind !== 'confirm' || started.busy) return
    const id = sessionRef.current
    if (!id) {
      setView({ kind: 'hint', message: t('slash.noConversation') })
      return
    }
    const target = started.target
    const detail = started.detail
    const fail = (message: string): void =>
      setView({ kind: 'confirm', target, detail, busy: false, error: message })
    setView({ kind: 'confirm', target, detail, busy: true, error: null })
    if (target === 'undo-all') {
      window.agento.changes
        .undoAll({ sessionId: id })
        .then((result) => {
          const failures = result.results.filter((item) => !item.ok)
          if (failures.length > 0) {
            fail(failures[0]?.error ?? t('slash.someNotRestored'))
            return
          }
          onMutated()
          setView({ kind: 'closed' })
        })
        .catch((cause: unknown) => {
          fail(cause instanceof Error ? cause.message : t('slash.undoFailed'))
        })
      return
    }
    window.agento.changes
      .list({ sessionId: id })
      .then(async (result) => {
        const newest = result.entries.find((entry) => entry.revertedAt === null)
        if (!newest) {
          setView({ kind: 'hint', message: t('slash.noChanges') })
          return
        }
        const key = newest.groupKey ?? `solo:${newest.id}`
        const rows = result.entries.filter(
          (entry) => entry.revertedAt === null && (entry.groupKey ?? `solo:${entry.id}`) === key
        )
        const outcomes: { ok: boolean; error?: string }[] = []
        for (const row of [...rows].reverse()) {
          try {
            const undoResult = await window.agento.changes.undo({ checkpointId: row.id })
            for (const item of undoResult.results) outcomes.push(item)
          } catch (cause: unknown) {
            outcomes.push({
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause)
            })
          }
        }
        const failures = outcomes.filter((outcome) => !outcome.ok)
        if (failures.length > 0) {
          fail(failures[0]?.error ?? t('slash.changeNotRestored'))
          return
        }
        onMutated()
        setView({ kind: 'closed' })
      })
      .catch((cause: unknown) => {
        fail(cause instanceof Error ? cause.message : t('slash.undoFailed'))
      })
  }

  const openHelp = (): void => {
    if (!runtime) return
    runtime.composer.setText(stripLeadingToken(runtime.composer.getState().text))
    setView({ kind: 'help' })
    document.querySelector<HTMLTextAreaElement>('.composer .composer-input')?.focus()
  }

  const runTemplate = (def: SlashCommandDef, args: string): void => {
    if (!runtime) return
    if (args.trim() === '') {
      const example = def.name === 'search' ? '/search invoice' : '/semantic pricing'
      setView({
        kind: 'hint',
        message: t('slash.typeAfterName', { name: def.name, example })
      })
      return
    }
    runtime.composer.setText(expandSlashTemplate(def, args))
    setView({ kind: 'closed' })
    runtime.composer.send()
  }

  // Pick a row from the menu/help (Enter or click). Template rows without
  // args yet just complete the `/name ` prefix so the user keeps typing; the
  // send interception below expands them.
  const pick = (def: SlashCommandDef): void => {
    if (!runtime || disabledRef.current) return
    if (def.kind === 'local') {
      if (def.name === 'help') {
        openHelp()
        return
      }
      if (def.name === 'undo' || def.name === 'undo-all') {
        runtime.composer.setText(stripLeadingToken(runtime.composer.getState().text))
        openConfirm(def.name === 'undo' ? 'undo' : 'undo-all')
        return
      }
      return
    }
    const text = runtime.composer.getState().text
    runtime.composer.setText(completeCommand(text, def.name))
    setView({ kind: 'closed' })
    document.querySelector<HTMLTextAreaElement>('.composer .composer-input')?.focus()
  }

  // Handle one full composer text as a slash invocation. Returns true when
  // the text was consumed (the caller must prevent the normal send).
  const handleSlashSend = (text: string): boolean => {
    const parsed = parseSlashCommand(text)
    if (!parsed) return false
    if (!parsed.def) {
      setView({
        kind: 'hint',
        message: t('slash.noMatchQuery', { q: parsed.name })
      })
      return true
    }
    if (parsed.def.kind === 'local') {
      if (parsed.def.name === 'help') {
        openHelp()
        return true
      }
      if (parsed.def.name === 'undo' || parsed.def.name === 'undo-all') {
        runtime?.composer.setText(stripLeadingToken(text))
        openConfirm(parsed.def.name === 'undo' ? 'undo' : 'undo-all')
        return true
      }
      return false
    }
    runTemplate(parsed.def, parsed.args)
    return true
  }

  // `@`-style trigger tracking on the runtime-owned input (FileAttach
  // precedent): the menu lives while the caret sits in a leading `/token`.
  useEffect(() => {
    // No listeners while disabled or runtime-less — and no synchronous
    // setState either (react-hooks/set-state-in-effect): the render guard
    // below already hides the popover while disabled, so there is nothing
    // stale to clean up here.
    if (disabled || !runtime) return
    const input = document.querySelector<HTMLTextAreaElement>('.composer .composer-input')
    if (!input) return
    const sync = (): void => {
      const current = viewRef.current
      if (current.kind === 'confirm' && current.busy) return
      if (current.kind !== 'closed' && current.kind !== 'menu') {
        setView({ kind: 'closed' })
        return
      }
      const query = slashMenuQuery(input.value, input.selectionStart ?? input.value.length)
      if (query === null) {
        if (viewRef.current.kind !== 'closed') setView({ kind: 'closed' })
        return
      }
      setView({ kind: 'menu', query, active: 0 })
    }
    // Preserve the highlighted row across keystrokes that keep the same
    // query — resync only resets the highlight when the query itself changes.
    const onInput = (): void => {
      const current = viewRef.current
      const query = slashMenuQuery(input.value, input.selectionStart ?? input.value.length)
      if (current.kind === 'confirm' && current.busy) return
      if (current.kind !== 'closed' && current.kind !== 'menu') {
        setView({ kind: 'closed' })
        return
      }
      if (query === null) {
        if (viewRef.current.kind !== 'closed') setView({ kind: 'closed' })
        return
      }
      if (current.kind === 'menu' && current.query === query) return
      setView({ kind: 'menu', query, active: 0 })
    }
    const onClick = (): void => {
      sync()
    }
    input.addEventListener('input', onInput)
    input.addEventListener('click', onClick)
    return () => {
      input.removeEventListener('input', onInput)
      input.removeEventListener('click', onClick)
    }
  }, [disabled, runtime])

  // Enter-to-pick/send interception (capture, before assistant-ui's own
  // handlers — the runtime-owned input is not ours to fork).
  useEffect(() => {
    if (disabled || !runtime) return
    const input = document.querySelector<HTMLTextAreaElement>('.composer .composer-input')
    if (!input) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const current = viewRef.current
      if (event.key === 'Escape') {
        if (current.kind !== 'closed') {
          event.preventDefault()
          close()
        }
        return
      }
      const matches = current.kind === 'menu' ? filterSlashCommands(current.query) : []
      if (event.key === 'ArrowDown' && current.kind === 'menu') {
        event.preventDefault()
        setView({
          ...current,
          active: Math.min(current.active + 1, Math.max(matches.length - 1, 0))
        })
        return
      }
      if (event.key === 'ArrowUp' && current.kind === 'menu') {
        event.preventDefault()
        setView({ ...current, active: Math.max(current.active - 1, 0) })
        return
      }
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (current.kind === 'menu') {
        const choice = matches[current.active]
        event.preventDefault()
        event.stopPropagation()
        if (choice) pick(choice)
        else setView({ kind: 'hint', message: t('slash.noMatch') })
        return
      }
      if (current.kind !== 'closed') {
        // Confirm/help/hint own the keyboard while open — never let a raw
        // `/undo` slip into the thread behind them.
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const text = runtime.composer.getState().text
      if (parseSlashCommand(text) !== null) {
        event.preventDefault()
        event.stopPropagation()
        handleSlashSend(text)
      }
    }
    input.addEventListener('keydown', onKeyDown, { capture: true })
    return () => input.removeEventListener('keydown', onKeyDown, { capture: true })
    // `locale` re-registers the listeners so the t() closures follow a
    // language switch (same reason `view` is a dep).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, runtime, sessionId, view, locale])

  // Send-button interception (the keyboard path above covers Enter; the
  // pointer path needs the same treatment).
  useEffect(() => {
    if (disabled || !runtime) return
    const onClick = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (!target || typeof target.closest !== 'function') return
      if (!target.closest('.composer-send')) return
      const text = runtime.composer.getState().text
      if (parseSlashCommand(text) !== null) {
        event.preventDefault()
        event.stopPropagation()
        handleSlashSend(text)
      }
    }
    document.addEventListener('click', onClick, { capture: true })
    return () => document.removeEventListener('click', onClick, { capture: true })
    // `locale` re-registers the listener so the t() closures follow a
    // language switch (same reason `view` is a dep).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, runtime, sessionId, view, locale])

  // Outside-click / Escape dismissal (FileAttach precedent). Textarea clicks
  // are owned by the trigger sync above, never by this closer.
  useEffect(() => {
    if (view.kind === 'closed') return
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (rootRef.current?.contains(target as Node)) return
      if (target && typeof target.closest === 'function' && target.closest('.composer-input'))
        return
      close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.kind === 'closed'])

  // Hidden while disabled (mid-run / reply mode own the composer then) —
  // except a busy confirm, which must stay visible until its restore lands.
  if (!runtime || view.kind === 'closed' || (disabled && view.kind !== 'confirm')) return null

  if (view.kind === 'menu') {
    const matches = filterSlashCommands(view.query)
    return (
      <div className="slash-popover" role="listbox" aria-label={t('slash.commands')} ref={rootRef}>
        <div className="slash-list">
          {matches.length === 0 ? <p className="slash-empty">{t('slash.noMatch')}</p> : null}
          {matches.map((def, index) => (
            <button
              key={def.name}
              type="button"
              role="option"
              aria-selected={index === view.active}
              className={index === view.active ? 'slash-item slash-item--active' : 'slash-item'}
              title={describe(def)}
              onMouseEnter={() => setView({ ...view, active: index })}
              onClick={() => pick(def)}
            >
              <span className="slash-item-name">
                /{def.name}
                {def.argHint ? ` ${def.argHint}` : ''}
              </span>
              <span className="slash-item-desc">{describe(def)}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (view.kind === 'help') {
    return (
      <div className="slash-popover" aria-label={t('slash.helpLabel')} ref={rootRef}>
        <p className="slash-title">{t('slash.commands')}</p>
        <div className="slash-list">
          {SLASH_COMMANDS.map((def) => (
            <button
              key={def.name}
              type="button"
              className="slash-item"
              title={describe(def)}
              onClick={() => pick(def)}
            >
              <span className="slash-item-name">
                /{def.name}
                {def.argHint ? ` ${def.argHint}` : ''}
              </span>
              <span className="slash-item-desc">{describe(def)}</span>
            </button>
          ))}
        </div>
        <div className="slash-confirm-actions">
          <button type="button" onClick={close}>
            {t('slash.close')}
          </button>
        </div>
      </div>
    )
  }

  if (view.kind === 'hint') {
    return (
      <div className="slash-popover" aria-label={t('slash.hintLabel')} ref={rootRef}>
        <p className="slash-hint">{view.message}</p>
        <div className="slash-confirm-actions">
          <button type="button" onClick={close}>
            {t('slash.dismiss')}
          </button>
        </div>
      </div>
    )
  }

  // Confirm (both undo flavors ask first — user decision).
  return (
    <div className="slash-popover" aria-label={t('slash.confirmUndo')} ref={rootRef}>
      <p className="slash-title">
        {view.target === 'undo' ? t('slash.undoConfirm') : t('slash.undoAllConfirm')}
      </p>
      {view.busy && view.detail === '' ? <p className="slash-hint">{t('slash.checking')}</p> : null}
      {view.detail !== '' ? <p className="slash-hint">{view.detail}</p> : null}
      {view.error ? (
        <p className="slash-error" role="alert">
          {view.error}
        </p>
      ) : null}
      <div className="slash-confirm-actions">
        <button type="button" onClick={runConfirm} disabled={view.busy}>
          {view.busy
            ? t('slash.restoring')
            : view.target === 'undo'
              ? t('slash.yesRestore')
              : t('slash.yesUndoAll')}
        </button>
        <button type="button" onClick={close} disabled={view.busy}>
          {t('slash.keep')}
        </button>
      </div>
    </div>
  )
}

export default SlashMenu
