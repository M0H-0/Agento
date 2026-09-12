import { useEffect, useRef, useState } from 'react'
import type { Locale, StringKey } from '../chat/locale'
import { useLocale } from './locale-context'
import { SettingsPopoverSelect } from './SettingsPopoverSelect'

// Settings modal (docs/04 §3.7): tabbed by category — Providers (built-ins +
// custom OpenAI-compatible profiles), Appearance, Permissions, Data. Only the
// active tab's panel is shown (others stay mounted but hidden, so form drafts
// survive tab switches). Keys are never rendered back: the dialog shows
// "•••• <last4>", which is all main ever sends (docs/06 §7). Custom profiles
// hold an opaque `custom:<uuid>` id — renames never orphan the stored secret.

// Structural mirror of SettingsSnapshot in src/preload/index.d.ts — the
// renderer consumes window.agento typed globally and doesn't import preload.
type Appearance = 'dark' | 'light' | 'system'
interface CustomProviderSnapshot {
  id: string
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  keyLast4: string
  createdAt: string
  updatedAt: string
}

interface SettingsSnapshot {
  provider: string
  model: string
  hasKey: boolean
  keyLast4: string
  storageAvailable: boolean
  providers: string[]
  models: string[]
  providerModels?: Record<string, string[]>
  providerKeys: Record<string, { hasKey: boolean; keyLast4: string }>
  searchKeys?: Record<string, { hasKey: boolean; keyLast4: string }>
  appearance: Appearance
  locale: Locale
  permissionDefaults: { risk1: 'auto' | 'ask'; risk2: 'auto' | 'ask' }
  customProviders: CustomProviderSnapshot[]
}

interface DataSummary {
  sessionCount: number
  messageCount: number
  checkpointCount: number
  activeCheckpointCount: number
}

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google AI Studio',
  groq: 'Groq',
  ollama: 'Ollama Cloud'
}

function providerLabel(id: string, customs: CustomProviderSnapshot[]): string {
  if (PROVIDER_LABELS[id]) return PROVIDER_LABELS[id]
  return customs.find((p) => p.id === id)?.name ?? id
}

type SettingsTab = 'providers' | 'appearance' | 'permissions' | 'data'

const SETTINGS_TABS: { id: SettingsTab; labelKey: StringKey }[] = [
  { id: 'providers', labelKey: 'settings.tab.providers' },
  { id: 'appearance', labelKey: 'settings.tab.appearance' },
  { id: 'permissions', labelKey: 'settings.tab.permissions' },
  { id: 'data', labelKey: 'settings.tab.data' }
]

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  onLocaleChange: (locale: Locale) => void
}

function SettingsDialog({
  open,
  onClose,
  onLocaleChange
}: SettingsDialogProps): React.JSX.Element | null {
  const { t } = useLocale()
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [tavilyKeyDraft, setTavilyKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dataSummary, setDataSummary] = useState<DataSummary | null>(null)
  const [confirmAction, setConfirmAction] = useState<'clear-sessions' | 'purge-snapshots' | null>(
    null
  )
  // Custom-provider form state: null = no form; { id: null } = adding;
  // { id } = editing that profile.
  const [editingId, setEditingId] = useState<string | null | undefined>(undefined)
  const [formName, setFormName] = useState('')
  const [formBaseUrl, setFormBaseUrl] = useState('')
  const [formModel, setFormModel] = useState('')
  const [formKey, setFormKey] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('providers')
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const refresh = (): Promise<void> =>
    window.agento.settings
      .get()
      .then((next) => {
        setSnapshot(next)
        setError(null)
      })
      .catch(() => {
        setError(t('settings.loadFailed'))
      })

  const refreshDataSummary = (): void => {
    window.agento.settings
      .getDataSummary()
      .then(setDataSummary)
      .catch(() => setDataSummary(null))
  }

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
        setNotice(null)
        setTestResult(null)
        setTavilyKeyDraft('')
        setEditingId(undefined)
        setActiveTab('providers')
      })
      .catch(() => {
        if (cancelled) return
        setError(t('settings.loadFailed'))
      })
    window.agento.settings
      .getDataSummary()
      .then((summary) => {
        if (!cancelled) setDataSummary(summary)
      })
      .catch(() => {
        if (!cancelled) setDataSummary(null)
      })
    return () => {
      cancelled = true
    }
    // `t` intentionally omitted: this effect opens the dialog (fresh pull +
    // tab reset) and must not re-run on a language switch mid-open — error
    // text resolves in the locale active at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const runGuarded = (work: () => Promise<void>, failure: string): void => {
    setBusy(true)
    work()
      .catch(() => setError(failure))
      .finally(() => setBusy(false))
  }

  const saveKey = (): void => {
    if (snapshot === null || keyDraft.trim() === '') return
    const provider = snapshot.provider
    runGuarded(
      () =>
        window.agento.settings
          .setApiKey({ provider, key: keyDraft })
          .then(() => {
            // Drop the plaintext from renderer state the moment main has it.
            setKeyDraft('')
            return refresh()
          })
          .then(() => setNotice(null)),
      t('settings.saveKeyFailed')
    )
  }

  const removeKey = (): void => {
    if (snapshot === null) return
    removeKeyFor(snapshot.provider)
  }

  const removeKeyFor = (provider: string): void => {
    runGuarded(
      () => window.agento.settings.clearApiKey({ provider }).then(refresh),
      t('settings.removeKeyFailed')
    )
  }

  // Web-search key (docs/06 §7): stored under the plain 'tavily' id through
  // the same key surface — no new IPC. Plaintext leaves renderer state the
  // moment main has it, like the provider key above.
  const saveTavilyKey = (): void => {
    if (snapshot === null || tavilyKeyDraft.trim() === '') return
    runGuarded(
      () =>
        window.agento.settings
          .setApiKey({ provider: 'tavily', key: tavilyKeyDraft })
          .then(() => {
            setTavilyKeyDraft('')
            return refresh()
          })
          .then(() => setNotice(null)),
      t('settings.saveKeyFailed')
    )
  }

  const removeTavilyKey = (): void => {
    runGuarded(
      () => window.agento.settings.clearApiKey({ provider: 'tavily' }).then(refresh),
      t('settings.removeKeyFailed')
    )
  }

  const changeModel = (model: string): void => {
    if (snapshot === null) return
    runGuarded(
      () => window.agento.settings.setModel({ model }).then(refresh),
      t('settings.changeModelFailed')
    )
  }

  const changeProvider = (provider: string): void => {
    if (snapshot === null || provider === snapshot.provider) return
    // Clear any in-progress key draft: it belonged to the previous provider.
    setKeyDraft('')
    setTestResult(null)
    runGuarded(
      () => window.agento.settings.setProvider({ provider }).then(refresh),
      t('settings.changeProviderFailed')
    )
  }

  const applyAppearance = (appearance: Appearance): void => {
    const root = document.documentElement
    if (appearance === 'light') root.classList.remove('dark')
    else if (appearance === 'dark') root.classList.add('dark')
    else {
      const light = window.matchMedia('(prefers-color-scheme: light)').matches
      root.classList.toggle('dark', !light)
    }
  }

  const changeAppearance = (appearance: Appearance): void => {
    if (snapshot === null || appearance === snapshot.appearance) return
    runGuarded(
      () =>
        window.agento.settings.setAppearance({ appearance }).then((next) => {
          setSnapshot(next)
          applyAppearance(next.appearance)
        }),
      t('settings.changeAppearanceFailed')
    )
  }

  // Language (Arabic option): persists via settings:set-locale, then tells
  // App to flip <html> lang/dir + the LocaleProvider — the whole dialog
  // re-renders in the new language instantly, no restart.
  const changeLocale = (locale: Locale): void => {
    if (snapshot === null || locale === snapshot.locale) return
    setBusy(true)
    window.agento.settings
      .setLocale({ locale })
      .then((next) => {
        setSnapshot(next)
        onLocaleChange(next.locale)
      })
      .catch(() => setError(t('settings.changeLanguageFailed')))
      .finally(() => setBusy(false))
  }

  const changePermissions = (risk1: 'auto' | 'ask', risk2: 'auto' | 'ask'): void => {
    runGuarded(
      () =>
        window.agento.settings
          .setPermissionDefaults({ risk1, risk2 })
          .then((next) =>
            setSnapshot((prev) => (prev === null ? prev : { ...prev, permissionDefaults: next }))
          ),
      t('settings.changePermissionsFailed')
    )
  }

  const startAddCustom = (): void => {
    setEditingId(null)
    setFormName('')
    setFormBaseUrl('')
    setFormModel('')
    setFormKey('')
    setTestResult(null)
    setError(null)
  }

  const startEditCustom = (profile: CustomProviderSnapshot): void => {
    setEditingId(profile.id)
    setFormName(profile.name)
    setFormBaseUrl(profile.baseUrl)
    setFormModel(profile.model)
    setFormKey('')
    setTestResult(null)
    setError(null)
  }

  const saveCustomForm = (): void => {
    if (formName.trim() === '' || formBaseUrl.trim() === '' || formModel.trim() === '') {
      setError(t('settings.fillCustomForm'))
      return
    }
    setBusy(true)
    const finish = refresh().then(() => {
      setEditingId(undefined)
      setFormKey('')
    })
    if (editingId === null) {
      // Adding: create the profile, optionally store its key, select it.
      window.agento.settings
        .createCustomProvider({ name: formName, baseUrl: formBaseUrl, model: formModel })
        .then(({ id }) => {
          const key = formKey.trim()
          const storeKey =
            key !== '' ? window.agento.settings.setApiKey({ provider: id, key }) : Promise.resolve()
          return storeKey.then(() => window.agento.settings.setProvider({ provider: id }))
        })
        .then(() => finish)
        .then(() => {
          setError(null)
          setNotice(t('settings.customAdded'))
        })
        .catch((saveError: unknown) =>
          setError(saveError instanceof Error ? saveError.message : t('settings.addProviderFailed'))
        )
        .finally(() => setBusy(false))
    } else if (editingId !== undefined) {
      const id = editingId
      window.agento.settings
        .updateCustomProvider({ id, name: formName, baseUrl: formBaseUrl, model: formModel })
        .then((next) => {
          setSnapshot(next)
          const key = formKey.trim()
          return key !== ''
            ? window.agento.settings.setApiKey({ provider: id, key }).then(refresh)
            : undefined
        })
        .then(() => {
          setEditingId(undefined)
          setFormKey('')
          setError(null)
          setNotice(t('settings.customUpdated'))
        })
        .catch((saveError: unknown) =>
          setError(
            saveError instanceof Error ? saveError.message : t('settings.updateProviderFailed')
          )
        )
        .finally(() => setBusy(false))
    }
  }

  const removeCustom = (id: string): void => {
    runGuarded(
      () =>
        window.agento.settings.deleteCustomProvider({ id }).then((next) => {
          setSnapshot(next)
          setNotice(t('settings.customRemoved'))
        }),
      t('settings.removeProviderFailed')
    )
  }

  const testSaved = (providerId: string): void => {
    setTesting(true)
    setTestResult(null)
    window.agento.settings
      .testProvider({ provider: providerId })
      .then((result) =>
        setTestResult(
          result.ok ? t('settings.connected') : (result.reason ?? t('settings.testFailed'))
        )
      )
      .catch(() => setTestResult(t('settings.testCouldNotRun')))
      .finally(() => setTesting(false))
  }

  const testDraft = (): void => {
    if (formBaseUrl.trim() === '' || formModel.trim() === '') {
      setTestResult(t('settings.enterEndpointFirst'))
      return
    }
    setTesting(true)
    setTestResult(null)
    window.agento.settings
      .testProvider({
        baseUrl: formBaseUrl,
        model: formModel,
        ...(formKey.trim() !== '' ? { key: formKey } : {})
      })
      .then((result) =>
        setTestResult(
          result.ok ? t('settings.connected') : (result.reason ?? t('settings.testFailed'))
        )
      )
      .catch(() => setTestResult(t('settings.testCouldNotRun')))
      .finally(() => setTesting(false))
  }

  const doClearSessions = (): void => {
    runGuarded(
      () =>
        window.agento.settings.clearSessions().then(({ sessions }) => {
          setConfirmAction(null)
          setNotice(
            sessions === 0 ? t('settings.clearedNone') : t('settings.cleared', { n: sessions })
          )
          refreshDataSummary()
        }),
      t('settings.clearFailed')
    )
  }

  const doPurgeSnapshots = (): void => {
    runGuarded(
      () =>
        window.agento.settings.purgeSnapshots().then(({ checkpoints }) => {
          setConfirmAction(null)
          setNotice(
            checkpoints === 0 ? t('settings.purgedNone') : t('settings.purged', { n: checkpoints })
          )
          refreshDataSummary()
        }),
      t('settings.purgeFailed')
    )
  }

  if (!open) return null

  const maskedKey = snapshot?.keyLast4 === '' ? '••••' : `•••• ${snapshot?.keyLast4 ?? ''}`
  const tavilyState = snapshot?.searchKeys?.['tavily'] ?? { hasKey: false, keyLast4: '' }
  const maskedTavilyKey = tavilyState.keyLast4 === '' ? '••••' : `•••• ${tavilyState.keyLast4}`
  const activeCustom = snapshot?.customProviders.find((p) => p.id === snapshot.provider)
  const isCustomActive = activeCustom !== undefined

  // Unified "Your providers" rows (docs/04 §3.7): built-ins first (fixed rows —
  // Google/Groq are always available), then user-added custom profiles. Every row
  // carries its own masked key state, so saving a Groq key lights up the Groq row
  // wherever it sits in the list.
  const rows: Array<{
    id: string
    kind: 'settings.builtIn' | 'settings.custom'
    name: string
    model: string
    endpoint: string | null
    hasKey: boolean
    keyLast4: string
    profile: CustomProviderSnapshot | null
  }> =
    snapshot === null
      ? []
      : [
          ...snapshot.providers.map((id) => {
            const keyState = snapshot.providerKeys[id] ?? {
              hasKey: snapshot.provider === id ? snapshot.hasKey : false,
              keyLast4: snapshot.provider === id ? snapshot.keyLast4 : ''
            }
            return {
              id,
              kind: 'settings.builtIn' as const,
              name: PROVIDER_LABELS[id] ?? id,
              model:
                snapshot.provider === id
                  ? snapshot.model
                  : (snapshot.providerModels?.[id]?.[0] ?? ''),
              endpoint: null,
              hasKey: keyState.hasKey,
              keyLast4: keyState.keyLast4,
              profile: null
            }
          }),
          ...snapshot.customProviders.map((profile) => ({
            id: profile.id,
            kind: 'settings.custom' as const,
            name: profile.name,
            model: profile.model,
            endpoint: profile.baseUrl,
            hasKey: profile.hasKey,
            keyLast4: profile.keyLast4,
            profile
          }))
        ]

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
        <div className="settings-title-row">
          <h2 id="settings-title" className="settings-title">
            {t('settings.title')}
          </h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label={t('settings.close')}
          >
            ×
          </button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label={t('settings.categories')}>
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`settings-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-panel-${tab.id}`}
              className="settings-tab"
              onClick={() => setActiveTab(tab.id)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {snapshot === null ? (
          <p className="settings-note">{t('settings.loading')}</p>
        ) : (
          <>
            <section
              className="settings-section"
              id="settings-panel-providers"
              role="tabpanel"
              aria-labelledby="settings-tab-providers"
              aria-label={t('settings.tab.providers')}
              hidden={activeTab !== 'providers'}
            >
              <h3 className="settings-heading">{t('settings.tab.providers')}</h3>

              <div className="settings-field">
                <span className="settings-label" id="settings-provider-label">
                  {t('settings.provider')}
                </span>
                <SettingsPopoverSelect
                  key={`provider-${String(open)}`}
                  labelledBy="settings-provider-label"
                  disabled={busy}
                  value={snapshot.provider}
                  options={[
                    ...snapshot.providers.map((provider) => ({
                      value: provider,
                      label: PROVIDER_LABELS[provider] ?? provider
                    })),
                    ...snapshot.customProviders.map((profile) => ({
                      value: profile.id,
                      label: t('settings.customSuffix', { name: profile.name })
                    }))
                  ]}
                  onChange={changeProvider}
                />
                <p className="settings-note">
                  {t('settings.newRepliesUse', {
                    provider: providerLabel(snapshot.provider, snapshot.customProviders),
                    model: snapshot.model
                  })}
                </p>
              </div>

              <div className="settings-field">
                <span className="settings-label" id="settings-key-label">
                  {t('settings.apiKey')}
                </span>
                {snapshot.hasKey ? (
                  <div className="settings-key-row">
                    <span
                      className="settings-key-display"
                      aria-label={t('settings.storedKeyMasked')}
                    >
                      {maskedKey}
                    </span>
                    <button
                      type="button"
                      className="settings-remove"
                      onClick={removeKey}
                      disabled={busy}
                    >
                      {t('settings.remove')}
                    </button>
                  </div>
                ) : (
                  <div className="settings-key-row">
                    <input
                      type="password"
                      className="settings-input"
                      value={keyDraft}
                      onChange={(event) => setKeyDraft(event.target.value)}
                      placeholder={t(
                        isCustomActive ? 'settings.pasteKeyLocal' : 'settings.pasteKey'
                      )}
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
                      {t('settings.save')}
                    </button>
                  </div>
                )}
                {!snapshot.storageAvailable && (
                  <p className="settings-warning">{t('settings.noEncryption')}</p>
                )}
              </div>

              <div className="settings-field">
                <span className="settings-label" id="settings-model-label">
                  {t('settings.model')}
                </span>
                {isCustomActive ? (
                  <input
                    className="settings-input"
                    value={snapshot.model}
                    aria-labelledby="settings-model-label"
                    disabled={busy}
                    onChange={(event) => changeModel(event.target.value)}
                    onBlur={(event) => {
                      if (event.target.value !== snapshot.model) changeModel(event.target.value)
                    }}
                    placeholder="e.g. llama3.1:8b"
                    autoComplete="off"
                    spellCheck={false}
                  />
                ) : (
                  <SettingsPopoverSelect
                    key={`model-${String(open)}`}
                    labelledBy="settings-model-label"
                    disabled={busy}
                    value={snapshot.model}
                    options={snapshot.models.map((model) => ({
                      value: model,
                      label: model
                    }))}
                    onChange={changeModel}
                  />
                )}
              </div>

              <div className="settings-field">
                <button
                  type="button"
                  className="settings-save"
                  onClick={() => testSaved(snapshot.provider)}
                  disabled={busy || testing}
                >
                  {testing ? t('settings.testing') : t('settings.testConnection')}
                </button>
              </div>

              <div className="settings-field">
                <span className="settings-label">{t('settings.yourProviders')}</span>
                <ul className="settings-custom-list">
                  {rows.map((row) => {
                    const profile = row.profile
                    const active = row.id === snapshot.provider
                    return (
                      <li key={row.id} className="settings-custom-item">
                        <div className="settings-custom-head">
                          <strong>{row.name}</strong>
                          <span className="settings-provider-badge">{t(row.kind)}</span>
                        </div>
                        <div className="settings-custom-meta">
                          <span className="settings-note">{row.model}</span>
                          {row.endpoint !== null && (
                            <span className="settings-note">{row.endpoint}</span>
                          )}
                          <span className="settings-note">
                            {row.hasKey
                              ? t('settings.keySaved', { last4: row.keyLast4 })
                              : t('settings.noKeySaved')}
                            {active ? t('settings.inUse') : ''}
                          </span>
                        </div>
                        <div className="settings-custom-actions">
                          <button
                            type="button"
                            className="settings-save"
                            disabled={busy || active}
                            onClick={() => changeProvider(row.id)}
                          >
                            {t('settings.use')}
                          </button>
                          <button
                            type="button"
                            className="settings-save"
                            disabled={busy || testing}
                            onClick={() => testSaved(row.id)}
                          >
                            {testing ? t('settings.testing') : t('settings.test')}
                          </button>
                          {profile !== null && (
                            <button
                              type="button"
                              className="settings-save"
                              disabled={busy}
                              onClick={() => startEditCustom(profile)}
                            >
                              {t('settings.edit')}
                            </button>
                          )}
                          {profile !== null ? (
                            <button
                              type="button"
                              className="settings-remove"
                              disabled={busy || active}
                              title={t(
                                active
                                  ? 'settings.removeActiveProvider'
                                  : 'settings.removeProviderHint'
                              )}
                              onClick={() => removeCustom(profile.id)}
                            >
                              {t('settings.remove')}
                            </button>
                          ) : row.hasKey ? (
                            <button
                              type="button"
                              className="settings-remove"
                              disabled={busy}
                              title={t('settings.removeKeyHint')}
                              onClick={() => removeKeyFor(row.id)}
                            >
                              {t('settings.removeKey')}
                            </button>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {editingId === undefined ? (
                  <button
                    type="button"
                    className="settings-save"
                    onClick={startAddCustom}
                    disabled={busy}
                  >
                    {t('settings.addCustomProvider')}
                  </button>
                ) : (
                  <div className="settings-custom-form">
                    <label className="settings-label" htmlFor="custom-name">
                      {t('settings.customName')}
                    </label>
                    <input
                      id="custom-name"
                      className="settings-input"
                      value={formName}
                      onChange={(event) => setFormName(event.target.value)}
                      placeholder={t('settings.customNamePlaceholder')}
                      autoComplete="off"
                      maxLength={80}
                    />
                    <label className="settings-label" htmlFor="custom-baseurl">
                      {t('settings.customEndpoint')}
                    </label>
                    <input
                      id="custom-baseurl"
                      className="settings-input"
                      value={formBaseUrl}
                      onChange={(event) => setFormBaseUrl(event.target.value)}
                      placeholder={t('settings.customEndpointPlaceholder')}
                      autoComplete="off"
                      spellCheck={false}
                      inputMode="url"
                    />
                    <p className="settings-note">{t('settings.customEndpointNote')}</p>
                    <label className="settings-label" htmlFor="custom-model">
                      {t('settings.customModelLabel')}
                    </label>
                    <input
                      id="custom-model"
                      className="settings-input"
                      value={formModel}
                      onChange={(event) => setFormModel(event.target.value)}
                      placeholder="e.g. llama3.1:8b"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <label className="settings-label" htmlFor="custom-key">
                      {t('settings.apiKey')}{' '}
                      {t(
                        editingId === null ? 'settings.customKeyOptional' : 'settings.customKeyKeep'
                      )}
                    </label>
                    <input
                      id="custom-key"
                      type="password"
                      className="settings-input"
                      value={formKey}
                      onChange={(event) => setFormKey(event.target.value)}
                      placeholder={t('settings.customKeyPlaceholder')}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="settings-note">{t('settings.customGatewayNote')}</p>
                    <div className="settings-custom-actions">
                      <button
                        type="button"
                        className="settings-save"
                        onClick={saveCustomForm}
                        disabled={busy}
                      >
                        {t(editingId === null ? 'settings.addProvider' : 'settings.saveChanges')}
                      </button>
                      <button
                        type="button"
                        className="settings-save"
                        onClick={testDraft}
                        disabled={busy || testing}
                      >
                        {testing ? t('settings.testing') : t('settings.test')}
                      </button>
                      <button
                        type="button"
                        className="settings-remove"
                        onClick={() => {
                          setEditingId(undefined)
                          setFormKey('')
                          setTestResult(null)
                        }}
                        disabled={busy}
                      >
                        {t('settings.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="settings-field">
                <span className="settings-label" id="settings-tavily-key-label">
                  {t('settings.webSearch')}
                </span>
                <p className="settings-note">{t('settings.webSearchNote')}</p>
                {snapshot.searchKeys === undefined ? (
                  <p className="settings-note">{t('settings.searchKeysRestart')}</p>
                ) : (
                  <>
                    <p className="settings-note">
                      {tavilyState.hasKey
                        ? t('settings.keySaved', { last4: tavilyState.keyLast4 })
                        : t('settings.noKeySaved')}
                    </p>
                    {tavilyState.hasKey ? (
                      <div className="settings-key-row">
                        <span
                          className="settings-key-display"
                          aria-label={t('settings.storedKeyMasked')}
                        >
                          {maskedTavilyKey}
                        </span>
                        <button
                          type="button"
                          className="settings-remove"
                          onClick={removeTavilyKey}
                          disabled={busy}
                        >
                          {t('settings.removeKey')}
                        </button>
                      </div>
                    ) : (
                      <div className="settings-key-row">
                        <input
                          type="password"
                          className="settings-input"
                          value={tavilyKeyDraft}
                          onChange={(event) => setTavilyKeyDraft(event.target.value)}
                          placeholder={t('settings.pasteTavilyKey')}
                          autoComplete="off"
                          spellCheck={false}
                          aria-labelledby="settings-tavily-key-label"
                        />
                        <button
                          type="button"
                          className="settings-save"
                          onClick={saveTavilyKey}
                          disabled={busy || tavilyKeyDraft.trim() === ''}
                        >
                          {t('settings.save')}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>

              {testResult !== null && <p className="settings-note">{testResult}</p>}
            </section>

            <section
              className="settings-section"
              id="settings-panel-appearance"
              role="tabpanel"
              aria-labelledby="settings-tab-appearance"
              aria-label={t('settings.tab.appearance')}
              hidden={activeTab !== 'appearance'}
            >
              <h3 className="settings-heading">{t('settings.tab.appearance')}</h3>
              <div className="settings-field">
                <span className="settings-label" id="settings-appearance-label">
                  {t('settings.theme')}
                </span>
                <SettingsPopoverSelect
                  key={`theme-${String(open)}`}
                  labelledBy="settings-appearance-label"
                  disabled={busy}
                  value={snapshot.appearance}
                  options={[
                    { value: 'dark', label: t('settings.theme.dark') },
                    { value: 'light', label: t('settings.theme.light') },
                    { value: 'system', label: t('settings.theme.system') }
                  ]}
                  onChange={(value) => changeAppearance(value as Appearance)}
                />
              </div>
              <div className="settings-field">
                <span className="settings-label" id="settings-language-label">
                  {t('settings.language')}
                </span>
                <SettingsPopoverSelect
                  key={`language-${String(open)}`}
                  labelledBy="settings-language-label"
                  describedBy="settings-language-note"
                  disabled={busy}
                  value={snapshot.locale ?? 'en'}
                  options={[
                    { value: 'en', label: t('settings.language.english') },
                    { value: 'ar', label: t('settings.language.arabic') }
                  ]}
                  onChange={(value) => changeLocale(value as Locale)}
                />
                <p className="settings-note" id="settings-language-note">
                  {t('settings.language.note')}
                </p>
              </div>
            </section>

            <section
              className="settings-section"
              id="settings-panel-permissions"
              role="tabpanel"
              aria-labelledby="settings-tab-permissions"
              aria-label={t('settings.tab.permissions')}
              hidden={activeTab !== 'permissions'}
            >
              <h3 className="settings-heading">{t('settings.tab.permissions')}</h3>
              <div className="settings-field">
                <span className="settings-label" id="settings-risk1-label">
                  {t('settings.creatingFiles')}
                </span>
                <SettingsPopoverSelect
                  key={`risk1-${String(open)}`}
                  labelledBy="settings-risk1-label"
                  disabled={busy}
                  value={snapshot.permissionDefaults.risk1}
                  options={[
                    { value: 'auto', label: t('settings.runWithoutAsking') },
                    { value: 'ask', label: t('settings.askFirst') }
                  ]}
                  onChange={(value) =>
                    changePermissions(value as 'auto' | 'ask', snapshot.permissionDefaults.risk2)
                  }
                />
              </div>
              <div className="settings-field">
                <span className="settings-label" id="settings-risk2-label">
                  {t('settings.overwriting')}
                </span>
                <SettingsPopoverSelect
                  key={`risk2-${String(open)}`}
                  labelledBy="settings-risk2-label"
                  disabled={busy}
                  value={snapshot.permissionDefaults.risk2}
                  options={[
                    { value: 'ask', label: t('settings.askFirstRecommended') },
                    { value: 'auto', label: t('settings.runWithoutAsking') }
                  ]}
                  onChange={(value) =>
                    changePermissions(snapshot.permissionDefaults.risk1, value as 'auto' | 'ask')
                  }
                />
                {snapshot.permissionDefaults.risk2 === 'auto' && (
                  <p className="settings-warning">{t('settings.overwriteWarning')}</p>
                )}
              </div>
              <p className="settings-note">{t('settings.deleteNote')}</p>
            </section>

            <section
              className="settings-section"
              id="settings-panel-data"
              role="tabpanel"
              aria-labelledby="settings-tab-data"
              aria-label={t('settings.tab.data')}
              hidden={activeTab !== 'data'}
            >
              <h3 className="settings-heading">{t('settings.tab.data')}</h3>
              <p className="settings-note">
                {dataSummary === null
                  ? t('settings.dataUnavailable')
                  : t('settings.dataSummary', {
                      sessions: dataSummary.sessionCount,
                      sessionPlural: dataSummary.sessionCount === 1 ? '' : 's',
                      messages: dataSummary.messageCount,
                      snapshots: dataSummary.activeCheckpointCount
                    })}
              </p>
              <div className="settings-field">
                <div className="settings-custom-actions">
                  <button
                    type="button"
                    className="settings-save"
                    disabled={busy}
                    onClick={() => {
                      runGuarded(
                        () =>
                          window.agento.settings.openDataFolder().then(() => {
                            setNotice(t('settings.openedDataFolder'))
                          }),
                        t('settings.openFolderFailed')
                      )
                    }}
                  >
                    {t('settings.openDataFolder')}
                  </button>
                  <button
                    type="button"
                    className="settings-save"
                    disabled={busy}
                    onClick={() => {
                      runGuarded(
                        () =>
                          window.agento.settings.exportEval().then(({ fileName, sessionCount }) => {
                            setNotice(
                              t('settings.exportedEval', {
                                file: fileName,
                                n: sessionCount
                              })
                            )
                          }),
                        t('settings.exportFailed')
                      )
                    }}
                  >
                    {t('settings.exportEval')}
                  </button>
                </div>
              </div>
              <div className="settings-field">
                {confirmAction === 'clear-sessions' ? (
                  <div className="settings-confirm">
                    <span>{t('settings.clearConfirm')}</span>
                    <div className="settings-custom-actions">
                      <button
                        type="button"
                        className="settings-remove"
                        disabled={busy}
                        onClick={doClearSessions}
                      >
                        {t('settings.clearEverything')}
                      </button>
                      <button
                        type="button"
                        className="settings-save"
                        disabled={busy}
                        onClick={() => setConfirmAction(null)}
                      >
                        {t('settings.keep')}
                      </button>
                    </div>
                  </div>
                ) : confirmAction === 'purge-snapshots' ? (
                  <div className="settings-confirm">
                    <span>{t('settings.purgeConfirm')}</span>
                    <div className="settings-custom-actions">
                      <button
                        type="button"
                        className="settings-remove"
                        disabled={busy}
                        onClick={doPurgeSnapshots}
                      >
                        {t('settings.removeSnapshotsConfirm')}
                      </button>
                      <button
                        type="button"
                        className="settings-save"
                        disabled={busy}
                        onClick={() => setConfirmAction(null)}
                      >
                        {t('settings.keep')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="settings-custom-actions">
                    <button
                      type="button"
                      className="settings-remove"
                      disabled={busy}
                      onClick={() => setConfirmAction('clear-sessions')}
                    >
                      {t('settings.clearConversations')}
                    </button>
                    <button
                      type="button"
                      className="settings-remove"
                      disabled={busy}
                      onClick={() => setConfirmAction('purge-snapshots')}
                    >
                      {t('settings.removeSnapshots')}
                    </button>
                  </div>
                )}
              </div>
            </section>

            {notice !== null && <p className="settings-note">{notice}</p>}
            {error !== null && <p className="settings-error">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}

export default SettingsDialog
