import { contextBridge, ipcRenderer } from 'electron'

// Minimal typed API exposed to the renderer — the ONLY bridge surface.
// Real chat transport + contracts arrive in M0.2/M0.3 (docs/02 §2.1);
// channel naming follows the `agento:<domain>:<action>` convention.
const agento = {
  ping: (): Promise<string> => ipcRenderer.invoke('agento:ping')
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('agento', agento)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.agento = agento
}
