import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { clearApiKey, getSettings, setApiKey, setModel } from '../settings'

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

export interface ClearApiKeyPayload {
  provider: string
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
    'settings:clear-api-key',
    (_event: IpcMainInvokeEvent, payload: ClearApiKeyPayload) => {
      clearApiKey(requireString(payload?.provider, 'Provider'))
    }
  )
}
