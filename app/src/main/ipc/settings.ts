import { ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { generateText } from 'ai'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLanguageModel, friendlyTestError, providerRequiresKey } from '../providers'
import {
  clearApiKey,
  createCustomProvider,
  deleteCustomProvider,
  getPermissionDefaults,
  getSettings,
  requireDataDir,
  resolveActiveBaseUrl,
  resolveProviderKey,
  setApiKey,
  setAppearance,
  setModel,
  setPermissionDefaults,
  setProvider,
  updateCustomProvider
} from '../settings'
import {
  buildEvalExport,
  clearAllSessions,
  getDataSummary,
  purgeSnapshots
} from '../storage/maintenance'

// Settings contract (docs/03 §4, docs/06 §7): plain invokes. Key material
// travels renderer → main ONLY; 'settings:get' answers with a snapshot that
// never contains the key — hasKey/keyLast4 at most. Throwing keeps the
// established error path: the renderer's invoke promise rejects.
export interface SetApiKeyPayload {
  provider: string
  key: string
}

export interface SetModelPayload {
  model: string
}

export interface SetProviderPayload {
  provider: string
}

export interface ClearApiKeyPayload {
  provider: string
}

export interface SetAppearancePayload {
  appearance: string
}

export interface SetPermissionDefaultsPayload {
  risk1?: string
  risk2?: string
}

export interface CreateCustomProviderPayload {
  name: string
  baseUrl: string
  model: string
}

export interface UpdateCustomProviderPayload {
  id: string
  name?: string
  baseUrl?: string
  model?: string
}

export interface DeleteCustomProviderPayload {
  id: string
}

export interface TestProviderPayload {
  /** Saved profile/built-in id to test (uses the stored key). */
  provider?: string
  /** Draft endpoint for testing before saving. */
  baseUrl?: string
  /** Draft model for testing before saving. */
  model?: string
  /** Draft key for testing before saving (renderer → main only, never stored here). */
  key?: string
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`)
  }
  return value
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle(
    'settings:set-api-key',
    (_event: IpcMainInvokeEvent, payload: SetApiKeyPayload) => {
      setApiKey(
        requireString(payload?.provider, 'Provider'),
        requireString(payload?.key, 'API key')
      )
    }
  )
  ipcMain.handle('settings:set-model', (_event: IpcMainInvokeEvent, payload: SetModelPayload) => {
    setModel(requireString(payload?.model, 'Model'))
  })
  ipcMain.handle(
    'settings:set-provider',
    (_event: IpcMainInvokeEvent, payload: SetProviderPayload) => {
      setProvider(requireString(payload?.provider, 'Provider'))
    }
  )
  ipcMain.handle(
    'settings:clear-api-key',
    (_event: IpcMainInvokeEvent, payload: ClearApiKeyPayload) => {
      clearApiKey(requireString(payload?.provider, 'Provider'))
    }
  )
  ipcMain.handle(
    'settings:set-appearance',
    (_event: IpcMainInvokeEvent, payload: SetAppearancePayload) => {
      setAppearance(requireString(payload?.appearance, 'Appearance'))
      return getSettings()
    }
  )
  ipcMain.handle(
    'settings:set-permission-defaults',
    (_event: IpcMainInvokeEvent, payload: SetPermissionDefaultsPayload) => {
      // Risk 3 is hard-locked to always-ask — no such field exists (docs/06 §2).
      return setPermissionDefaults({ risk1: payload?.risk1, risk2: payload?.risk2 })
    }
  )
  ipcMain.handle(
    'settings:create-custom-provider',
    (_event: IpcMainInvokeEvent, payload: CreateCustomProviderPayload) => {
      const profile = createCustomProvider({
        name: requireString(payload?.name, 'Name'),
        baseUrl: requireString(payload?.baseUrl, 'Endpoint URL'),
        model: requireString(payload?.model, 'Model')
      })
      return { id: profile.id }
    }
  )
  ipcMain.handle(
    'settings:update-custom-provider',
    (_event: IpcMainInvokeEvent, payload: UpdateCustomProviderPayload) => {
      updateCustomProvider(requireString(payload?.id, 'Provider'), {
        ...(payload?.name !== undefined ? { name: payload.name } : {}),
        ...(payload?.baseUrl !== undefined ? { baseUrl: payload.baseUrl } : {}),
        ...(payload?.model !== undefined ? { model: payload.model } : {})
      })
      return getSettings()
    }
  )
  ipcMain.handle(
    'settings:delete-custom-provider',
    (_event: IpcMainInvokeEvent, payload: DeleteCustomProviderPayload) => {
      deleteCustomProvider(requireString(payload?.id, 'Provider'))
      return getSettings()
    }
  )
  ipcMain.handle(
    'settings:test-provider',
    async (
      _event: IpcMainInvokeEvent,
      payload: TestProviderPayload
    ): Promise<{ ok: boolean; reason?: string }> => {
      // Resolve what to test: a saved provider id (stored key) or a draft
      // endpoint/model/key (never persisted here). All client construction
      // and key use stays in main; the renderer gets only a plain verdict.
      let providerId: string
      let model: string
      let baseUrl: string | undefined
      let apiKey: string | undefined
      if (typeof payload?.provider === 'string' && payload.provider.trim() !== '') {
        const snapshot = getSettings()
        providerId = payload.provider.trim()
        if (providerId !== snapshot.provider) {
          const custom = snapshot.customProviders.find((p) => p.id === providerId)
          if (providerId !== 'google' && providerId !== 'groq' && !custom) {
            throw new Error('That provider no longer exists.')
          }
          model = custom ? custom.model : (snapshot.models[0] ?? snapshot.model)
          baseUrl = custom?.baseUrl
        } else {
          model = snapshot.model
          baseUrl = resolveActiveBaseUrl()
        }
        try {
          apiKey = resolveProviderKey(providerId)
        } catch {
          apiKey = undefined
        }
      } else {
        baseUrl = requireString(payload?.baseUrl, 'Endpoint URL')
        model = requireString(payload?.model, 'Model').trim()
        providerId = 'custom:draft'
        if (typeof payload?.key === 'string' && payload.key.trim() !== '') {
          apiKey = payload.key.trim()
        }
      }
      if (providerRequiresKey(providerId) && apiKey === undefined) {
        return { ok: false, reason: 'There is no API key for this provider yet.' }
      }
      try {
        // Draft ids (`custom:draft`) route through the OpenAI-compatible
        // factory like saved custom profiles (buildLanguageModel keys custom
        // routing on the `custom:` prefix).
        const languageModel = buildLanguageModel({ provider: providerId, model, apiKey, baseUrl })
        await generateText({
          model: languageModel,
          prompt: 'Reply with exactly: ok',
          maxOutputTokens: 16,
          abortSignal: AbortSignal.timeout(20_000)
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: friendlyTestError(error) }
      }
    }
  )
  ipcMain.handle('settings:get-data-summary', () => getDataSummary())
  ipcMain.handle('settings:open-data-folder', async () => {
    const dir = requireDataDir()
    const errorMessage = await shell.openPath(dir)
    if (errorMessage) throw new Error('Could not open the data folder.')
    return { ok: true as const }
  })
  ipcMain.handle('settings:clear-sessions', () => {
    // Permission-gated upstream by the renderer's inline confirm; main does
    // the delete. Returns the removed count for the honest confirmation copy.
    return clearAllSessions()
  })
  ipcMain.handle('settings:purge-snapshots', () => purgeSnapshots())
  ipcMain.handle('settings:export-eval', () => {
    // Redacted eval/audit export (docs/05 §5): counts + metadata only — no
    // message/checkpoint content, no keys, no paths. Written to the app data
    // dir (never the workspace) and the file name returned for the copy.
    const payload = buildEvalExport()
    const dir = requireDataDir()
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `eval-export-${stamp}.json`
    writeFileSync(join(dir, fileName), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
    return { fileName, sessionCount: payload.sessionCount }
  })
}

export function getSettingsPermissionDefaults(): { risk1: 'auto' | 'ask'; risk2: 'auto' | 'ask' } {
  return getPermissionDefaults()
}
