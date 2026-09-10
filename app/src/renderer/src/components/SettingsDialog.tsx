import { useEffect, useRef, useState } from 'react'

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
  appearance: Appearance
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
  groq: 'Groq'
}

function providerLabel(id: string, customs: CustomProviderSnapshot[]): string {
  if (PROVIDER_LABELS[id]) return PROVIDER_LABELS[id]
  return customs.find((p) => p.id === id)?.name ?? id
}

type SettingsTab = 'providers' | 'appearance' | 'permissions' | 'data'

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'data', label: 'Data' }
]

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

function SettingsDialog({ open, onClose }: SettingsDialogProps): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
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
        setError('Could not load settings.')
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
        setEditingId(undefined)
        setActiveTab('providers')
      })
      .catch(() => {
        if (cancelled) return
        setError('Could not load settings.')
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
      'Saving the key failed.'
    )
  }

  const removeKey = (): void => {
    if (snapshot === null) return
    const provider = snapshot.provider
    runGuarded(
      () => window.agento.settings.clearApiKey({ provider }).then(refresh),
      'Removing the key failed.'
    )
  }

  const changeModel = (model: string): void => {
    if (snapshot === null) return
    runGuarded(
      () => window.agento.settings.setModel({ model }).then(refresh),
      'Changing the model failed.'
    )
  }

  const changeProvider = (provider: string): void => {
    if (snapshot === null || provider === snapshot.provider) return
    // Clear any in-progress key draft: it belonged to the previous provider.
    setKeyDraft('')
    setTestResult(null)
    runGuarded(
      () => window.agento.settings.setProvider({ provider }).then(refresh),
      'Changing the provider failed.'
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
      'Changing the appearance failed.'
    )
  }

  const changePermissions = (risk1: 'auto' | 'ask', risk2: 'auto' | 'ask'): void => {
    runGuarded(
      () =>
        window.agento.settings
          .setPermissionDefaults({ risk1, risk2 })
          .then((next) =>
            setSnapshot((prev) => (prev === null ? prev : { ...prev, permissionDefaults: next }))
          ),
      'Changing the permission defaults failed.'
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
      setError('Fill in the provider name, endpoint URL, and model name.')
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
          setNotice('Custom provider added and selected.')
        })
        .catch((saveError: unknown) =>
          setError(saveError instanceof Error ? saveError.message : 'Adding the provider failed.')
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
          setNotice('Custom provider updated.')
        })
        .catch((saveError: unknown) =>
          setError(saveError instanceof Error ? saveError.message : 'Updating the provider failed.')
        )
        .finally(() => setBusy(false))
    }
  }

  const removeCustom = (id: string): void => {
    runGuarded(
      () =>
        window.agento.settings.deleteCustomProvider({ id }).then((next) => {
          setSnapshot(next)
          setNotice('Custom provider removed — its stored key was removed too.')
        }),
      'Removing the provider failed.'
    )
  }

  const testSaved = (providerId: string): void => {
    setTesting(true)
    setTestResult(null)
    window.agento.settings
      .testProvider({ provider: providerId })
      .then((result) =>
        setTestResult(result.ok ? 'Connected.' : (result.reason ?? 'The test failed.'))
      )
      .catch(() => setTestResult('The test could not run.'))
      .finally(() => setTesting(false))
  }

  const testDraft = (): void => {
    if (formBaseUrl.trim() === '' || formModel.trim() === '') {
      setTestResult('Enter the endpoint URL and model name first.')
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
        setTestResult(result.ok ? 'Connected.' : (result.reason ?? 'The test failed.'))
      )
      .catch(() => setTestResult('The test could not run.'))
      .finally(() => setTesting(false))
  }

  const doClearSessions = (): void => {
    runGuarded(
      () =>
        window.agento.settings.clearSessions().then(({ sessions }) => {
          setConfirmAction(null)
          setNotice(
            sessions === 0
              ? 'There were no conversations to clear.'
              : `Cleared ${sessions} conversation${sessions === 1 ? '' : 's'}.`
          )
          refreshDataSummary()
        }),
      'Clearing conversations failed.'
    )
  }

  const doPurgeSnapshots = (): void => {
    runGuarded(
      () =>
        window.agento.settings.purgeSnapshots().then(({ checkpoints }) => {
          setConfirmAction(null)
          setNotice(
            checkpoints === 0
              ? 'There were no undo snapshots to remove.'
              : `Removed ${checkpoints} undo snapshot${checkpoints === 1 ? '' : 's'}. Undo history for past changes is gone.`
          )
          refreshDataSummary()
        }),
      'Removing snapshots failed.'
    )
  }

  if (!open) return null

  const maskedKey = snapshot?.keyLast4 === '' ? '••••' : `•••• ${snapshot?.keyLast4 ?? ''}`
  const activeCustom = snapshot?.customProviders.find((p) => p.id === snapshot.provider)
  const isCustomActive = activeCustom !== undefined

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
            Settings
          </h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Settings categories">
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
              {tab.label}
            </button>
          ))}
        </div>

        {snapshot === null ? (
          <p className="settings-note">Loading settings…</p>
        ) : (
          <>
            <section
              className="settings-section"
              id="settings-panel-providers"
              role="tabpanel"
              aria-labelledby="settings-tab-providers"
              aria-label="Providers"
              hidden={activeTab !== 'providers'}
            >
              <h3 className="settings-heading">Providers</h3>

              <div className="settings-field">
                <span className="settings-label" id="settings-provider-label">
                  Provider
                </span>
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
                  {snapshot.customProviders.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} (custom)
                    </option>
                  ))}
                </select>
                <p className="settings-note">
                  New replies in this conversation will use{' '}
                  {providerLabel(snapshot.provider, snapshot.customProviders)}
                  {' · '}
                  {snapshot.model}.
                </p>
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
                      placeholder={
                        isCustomActive
                          ? 'Paste the key (leave empty for a local server with none)'
                          : 'Paste your API key'
                      }
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
                  <select
                    className="settings-select"
                    value={snapshot.model}
                    aria-labelledby="settings-model-label"
                    disabled={busy}
                    onChange={(event) => changeModel(event.target.value)}
                  >
                    {snapshot.models.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="settings-field">
                <button
                  type="button"
                  className="settings-save"
                  onClick={() => testSaved(snapshot.provider)}
                  disabled={busy || testing}
                >
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
              </div>

              <div className="settings-field">
                <span className="settings-label">Custom providers</span>
                {snapshot.customProviders.length === 0 ? (
                  <p className="settings-note">
                    None yet. Add an OpenAI-compatible endpoint — a hosted gateway, or a local
                    server such as LM Studio or Ollama.
                  </p>
                ) : (
                  <ul className="settings-custom-list">
                    {snapshot.customProviders.map((profile) => (
                      <li key={profile.id} className="settings-custom-item">
                        <div className="settings-custom-meta">
                          <strong>{profile.name}</strong>
                          <span className="settings-note">{profile.model}</span>
                          <span className="settings-note">{profile.baseUrl}</span>
                          <span className="settings-note">
                            {profile.hasKey
                              ? `Key saved (•••• ${profile.keyLast4})`
                              : 'No key saved'}
                            {profile.id === snapshot.provider ? ' · in use' : ''}
                          </span>
                        </div>
                        <div className="settings-custom-actions">
                          <button
                            type="button"
                            className="settings-save"
                            disabled={busy}
                            onClick={() => changeProvider(profile.id)}
                          >
                            Use
                          </button>
                          <button
                            type="button"
                            className="settings-save"
                            disabled={busy}
                            onClick={() => startEditCustom(profile)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="settings-remove"
                            disabled={busy || profile.id === snapshot.provider}
                            title={
                              profile.id === snapshot.provider
                                ? 'Pick another provider before removing this one.'
                                : 'Remove this provider and its stored key.'
                            }
                            onClick={() => removeCustom(profile.id)}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {editingId === undefined ? (
                  <button
                    type="button"
                    className="settings-save"
                    onClick={startAddCustom}
                    disabled={busy}
                  >
                    Add custom provider…
                  </button>
                ) : (
                  <div className="settings-custom-form">
                    <label className="settings-label" htmlFor="custom-name">
                      Name
                    </label>
                    <input
                      id="custom-name"
                      className="settings-input"
                      value={formName}
                      onChange={(event) => setFormName(event.target.value)}
                      placeholder="e.g. Work gateway"
                      autoComplete="off"
                      maxLength={80}
                    />
                    <label className="settings-label" htmlFor="custom-baseurl">
                      API endpoint
                    </label>
                    <input
                      id="custom-baseurl"
                      className="settings-input"
                      value={formBaseUrl}
                      onChange={(event) => setFormBaseUrl(event.target.value)}
                      placeholder="https://… or http://127.0.0.1:11434/v1"
                      autoComplete="off"
                      spellCheck={false}
                      inputMode="url"
                    />
                    <p className="settings-note">
                      Enter the endpoint exactly as documented. Plain http:// is only allowed for
                      local servers.
                    </p>
                    <label className="settings-label" htmlFor="custom-model">
                      Model
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
                      API key{' '}
                      {editingId === null
                        ? '(optional — leave empty for a keyless local server)'
                        : '(leave empty to keep the saved key)'}
                    </label>
                    <input
                      id="custom-key"
                      type="password"
                      className="settings-input"
                      value={formKey}
                      onChange={(event) => setFormKey(event.target.value)}
                      placeholder="Paste the key, if this endpoint needs one"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="settings-note">
                      Streaming and tool calling are required for file work. Many compatible
                      gateways implement only part of the API — test before relying on one.
                    </p>
                    <div className="settings-custom-actions">
                      <button
                        type="button"
                        className="settings-save"
                        onClick={saveCustomForm}
                        disabled={busy}
                      >
                        {editingId === null ? 'Add provider' : 'Save changes'}
                      </button>
                      <button
                        type="button"
                        className="settings-save"
                        onClick={testDraft}
                        disabled={busy || testing}
                      >
                        {testing ? 'Testing…' : 'Test'}
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
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {testResult !== null && <p className="settings-note">{testResult}</p>}
            </section>

            <section
              className="settings-section"
              id="settings-panel-appearance"
              role="tabpanel"
              aria-labelledby="settings-tab-appearance"
              aria-label="Appearance"
              hidden={activeTab !== 'appearance'}
            >
              <h3 className="settings-heading">Appearance</h3>
              <div className="settings-field">
                <span className="settings-label" id="settings-appearance-label">
                  Theme
                </span>
                <select
                  className="settings-select"
                  value={snapshot.appearance}
                  aria-labelledby="settings-appearance-label"
                  disabled={busy}
                  onChange={(event) => changeAppearance(event.target.value as Appearance)}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">Follow system</option>
                </select>
              </div>
            </section>

            <section
              className="settings-section"
              id="settings-panel-permissions"
              role="tabpanel"
              aria-labelledby="settings-tab-permissions"
              aria-label="Permissions"
              hidden={activeTab !== 'permissions'}
            >
              <h3 className="settings-heading">Permissions</h3>
              <div className="settings-field">
                <span className="settings-label" id="settings-risk1-label">
                  Creating new files
                </span>
                <select
                  className="settings-select"
                  value={snapshot.permissionDefaults.risk1}
                  aria-labelledby="settings-risk1-label"
                  disabled={busy}
                  onChange={(event) =>
                    changePermissions(
                      event.target.value as 'auto' | 'ask',
                      snapshot.permissionDefaults.risk2
                    )
                  }
                >
                  <option value="auto">Run without asking</option>
                  <option value="ask">Ask first</option>
                </select>
              </div>
              <div className="settings-field">
                <span className="settings-label" id="settings-risk2-label">
                  Overwriting or moving existing files
                </span>
                <select
                  className="settings-select"
                  value={snapshot.permissionDefaults.risk2}
                  aria-labelledby="settings-risk2-label"
                  disabled={busy}
                  onChange={(event) =>
                    changePermissions(
                      snapshot.permissionDefaults.risk1,
                      event.target.value as 'auto' | 'ask'
                    )
                  }
                >
                  <option value="ask">Ask first (recommended)</option>
                  <option value="auto">Run without asking</option>
                </select>
                {snapshot.permissionDefaults.risk2 === 'auto' && (
                  <p className="settings-warning">
                    Overwrites will not ask first. Every change can still be undone.
                  </p>
                )}
              </div>
              <p className="settings-note">
                Deleting files always asks first — that cannot be changed.
              </p>
            </section>

            <section
              className="settings-section"
              id="settings-panel-data"
              role="tabpanel"
              aria-labelledby="settings-tab-data"
              aria-label="Data"
              hidden={activeTab !== 'data'}
            >
              <h3 className="settings-heading">Data</h3>
              <p className="settings-note">
                {dataSummary === null
                  ? 'Usage totals are unavailable right now.'
                  : `${dataSummary.sessionCount} conversation${dataSummary.sessionCount === 1 ? '' : 's'} · ${dataSummary.messageCount} messages · ${dataSummary.activeCheckpointCount} undo snapshots`}
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
                            setNotice('Opened the data folder.')
                          }),
                        'Could not open the data folder.'
                      )
                    }}
                  >
                    Open data folder
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
                              `Saved ${fileName} in the data folder (${sessionCount} conversation${sessionCount === 1 ? '' : 's'}, no message content or keys).`
                            )
                          }),
                        'The export failed.'
                      )
                    }}
                  >
                    Export eval data
                  </button>
                </div>
              </div>
              <div className="settings-field">
                {confirmAction === 'clear-sessions' ? (
                  <div className="settings-confirm">
                    <span>Clear all conversations? This cannot be undone.</span>
                    <div className="settings-custom-actions">
                      <button
                        type="button"
                        className="settings-remove"
                        disabled={busy}
                        onClick={doClearSessions}
                      >
                        Clear everything
                      </button>
                      <button
                        type="button"
                        className="settings-save"
                        disabled={busy}
                        onClick={() => setConfirmAction(null)}
                      >
                        Keep
                      </button>
                    </div>
                  </div>
                ) : confirmAction === 'purge-snapshots' ? (
                  <div className="settings-confirm">
                    <span>Remove all undo snapshots? Past changes could no longer be undone.</span>
                    <div className="settings-custom-actions">
                      <button
                        type="button"
                        className="settings-remove"
                        disabled={busy}
                        onClick={doPurgeSnapshots}
                      >
                        Remove snapshots
                      </button>
                      <button
                        type="button"
                        className="settings-save"
                        disabled={busy}
                        onClick={() => setConfirmAction(null)}
                      >
                        Keep
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
                      Clear conversations…
                    </button>
                    <button
                      type="button"
                      className="settings-remove"
                      disabled={busy}
                      onClick={() => setConfirmAction('purge-snapshots')}
                    >
                      Remove undo snapshots…
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
