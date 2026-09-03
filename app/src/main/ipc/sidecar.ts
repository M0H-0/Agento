import { ipcMain } from 'electron'
import { getSidecarStatus } from '../sidecar'

// Sidecar status contract (docs/03 §4): app-level, deliberately NOT a
// session-scoped 'agent:event' — no sessionId/runId exists for it. Main
// pushes 'sidecar:status' on every transition (wired in src/main/index.ts);
// this invoke lets a late-mounting renderer catch up on the current status.
export function registerSidecarIpc(): void {
  ipcMain.handle('sidecar:get-status', () => getSidecarStatus())
}
