import { useEffect, useState } from 'react'
import { useLocale } from './locale-context'
import SidecarStatusDot from './SidecarStatusDot'
import { canStartChat } from '../chat/provider-gate'

// Onboarding (MVP_PLAN.md; the M6.1 cut): ONE static screen — welcome, pick
// a workspace folder, enter an API key. The gate in App.tsx shows this
// screen until both exist. Every flow here is the SAME IPC Settings uses
// (workspaces.pick already persists the choice main-side; key material is
// dropped from renderer state the moment main has it) — no new channels,
// no multi-step tour, nothing decorative.

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google AI Studio',
  groq: 'Groq',
  ollama: 'Ollama Cloud'
}

// Structural mirror of the preload snapshots — window.agento is typed
// globally and the renderer never imports preload (SettingsDialog precedent).
interface OnboardingSettings {
  provider: string
  hasKey: boolean
  providers: string[]
  storageAvailable: boolean
  customProviders: { id: string; name: string }[]
}

interface OnboardingProps {
  onDone: () => void
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function Onboarding({ onDone }: OnboardingProps): React.JSX.Element {
  const { t } = useLocale()
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [settings, setSettings] = useState<OnboardingSettings | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Initial pull; setState only in async continuations (same rule as
    // SettingsDialog). Failures leave the honest empty state.
    let cancelled = false
    window.agento.workspaces
      .get()
      .then((snapshot) => {
        if (!cancelled) setWorkspacePath(snapshot.current)
      })
      .catch(() => {})
    window.agento.settings
      .get()
      .then((snapshot) => {
        if (cancelled) return
        setSettings({
          provider: snapshot.provider,
          hasKey: snapshot.hasKey,
          providers: snapshot.providers,
          storageAvailable: snapshot.storageAvailable,
          customProviders: snapshot.customProviders ?? []
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const refreshSettings = (): Promise<void> =>
    window.agento.settings.get().then((snapshot) => {
      setSettings({
        provider: snapshot.provider,
        hasKey: snapshot.hasKey,
        providers: snapshot.providers,
        storageAvailable: snapshot.storageAvailable,
        customProviders: snapshot.customProviders ?? []
      })
    })

  const pickWorkspace = (): void => {
    setBusy(true)
    // workspace:pick IS the setter — main persists the picked folder.
    window.agento.workspaces
      .pick()
      .then((picked) => {
        if (picked) setWorkspacePath(picked.path)
        setError(null)
      })
      .catch((pickError: unknown) =>
        setError(pickError instanceof Error ? pickError.message : t('onboarding.pickFailed'))
      )
      .finally(() => setBusy(false))
  }

  const changeProvider = (provider: string): void => {
    if (settings === null || provider === settings.provider) return
    setBusy(true)
    setKeyDraft('') // a draft belonged to the previous provider
    window.agento.settings
      .setProvider({ provider })
      .then(refreshSettings)
      .then(() => setError(null))
      .catch(() => setError(t('onboarding.providerFailed')))
      .finally(() => setBusy(false))
  }

  const saveKey = (): void => {
    if (settings === null || keyDraft.trim() === '') return
    setBusy(true)
    window.agento.settings
      .setApiKey({ provider: settings.provider, key: keyDraft })
      .then(() => setKeyDraft(''))
      .then(refreshSettings)
      .then(() => setError(null))
      .catch(() => setError(t('onboarding.saveFailed')))
      .finally(() => setBusy(false))
  }

  const removeKey = (): void => {
    if (settings === null) return
    setBusy(true)
    window.agento.settings
      .clearApiKey({ provider: settings.provider })
      .then(refreshSettings)
      .then(() => setError(null))
      .catch(() => setError(t('onboarding.removeFailed')))
      .finally(() => setBusy(false))
  }

  // Keyless custom profiles (local servers) are startable without a key
  // (docs/03 §10) — readiness must not trap them behind the key step.
  const ready =
    workspacePath !== null && settings !== null && canStartChat(settings.provider, settings.hasKey)

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        <h1 className="onboarding-title">{t('onboarding.welcome')}</h1>
        <p className="onboarding-lede">{t('onboarding.lede')}</p>

        <section className="settings-section" aria-label={t('onboarding.workspaceSection')}>
          <h3 className="settings-heading">{t('onboarding.step1')}</h3>
          <p className="settings-note">{t('onboarding.step1Note')}</p>
          <div className="settings-field">
            {workspacePath ? (
              <div className="settings-key-row">
                <span className="settings-key-display" aria-label={t('onboarding.chosenFolder')}>
                  {folderName(workspacePath)}
                </span>
                <button
                  type="button"
                  className="settings-remove"
                  onClick={pickWorkspace}
                  disabled={busy}
                >
                  {t('onboarding.change')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="settings-save"
                onClick={pickWorkspace}
                disabled={busy}
              >
                {t('onboarding.pickFolder')}
              </button>
            )}
          </div>
        </section>

        <section className="settings-section" aria-label={t('onboarding.providerSection')}>
          <h3 className="settings-heading">{t('onboarding.step2')}</h3>
          <div className="settings-field">
            <span className="settings-label" id="onboarding-provider-label">
              {t('onboarding.provider')}
            </span>
            <select
              className="settings-select"
              value={settings?.provider ?? ''}
              aria-labelledby="onboarding-provider-label"
              disabled={busy || settings === null}
              onChange={(event) => changeProvider(event.target.value)}
            >
              {(settings?.providers ?? []).map((provider) => (
                <option key={provider} value={provider}>
                  {PROVIDER_LABELS[provider] ?? provider}
                </option>
              ))}
              {(settings?.customProviders ?? []).map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {t('onboarding.customSuffix', { name: profile.name })}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-field">
            <span className="settings-label" id="onboarding-key-label">
              {t('onboarding.apiKey')}
            </span>
            {settings?.hasKey ? (
              <div className="settings-key-row">
                <span className="settings-key-display" aria-label={t('onboarding.storedKeyMasked')}>
                  {t('onboarding.saved')}
                </span>
                <button
                  type="button"
                  className="settings-remove"
                  onClick={removeKey}
                  disabled={busy}
                >
                  {t('onboarding.remove')}
                </button>
              </div>
            ) : (
              <div className="settings-key-row">
                <input
                  type="password"
                  className="settings-input"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && keyDraft.trim() !== '') saveKey()
                  }}
                  placeholder={t('onboarding.pasteKey')}
                  autoComplete="off"
                  spellCheck={false}
                  aria-labelledby="onboarding-key-label"
                />
                <button
                  type="button"
                  className="settings-save"
                  onClick={saveKey}
                  disabled={busy || keyDraft.trim() === ''}
                >
                  {t('onboarding.save')}
                </button>
              </div>
            )}
            {settings !== null && !settings.storageAvailable && (
              <p className="settings-warning">{t('onboarding.noEncryption')}</p>
            )}
          </div>
        </section>

        {error !== null && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          className="onboarding-start"
          onClick={onDone}
          disabled={busy || !ready}
        >
          {t('onboarding.getStarted')}
        </button>

        {/* S1-001: the shell's Full/Degraded dot lives behind this overlay —
            surface the same signal here so setup shows sidecar health too. */}
        <div className="onboarding-sidecar">
          <SidecarStatusDot />
          <span>{t('onboarding.sidecarNote')}</span>
        </div>
      </div>
    </div>
  )
}
