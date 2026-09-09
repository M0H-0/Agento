import { ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { resolve } from 'node:path'
import { resolveWorkspacePath } from '../agent/sandbox'
import { getCurrentWorkspace } from '../workspaces'

// System contract (docs/03 §4 system/*): 'system:open-path' invoke. The
// renderer can ask the OS to open a workspace file with its default app —
// powering the semantic-search card's click-to-open. The path is resolved
// against the CURRENT workspace and passes the same sandbox containment as
// tool paths (a renderer-supplied absolute path is only honored inside the
// workspace), so no arbitrary file on disk is openable.

export interface SystemOpenPathPayload {
  path: string
}

export function registerSystemIpc(): void {
  ipcMain.handle(
    'system:open-path',
    async (
      _event: IpcMainInvokeEvent,
      payload: SystemOpenPathPayload
    ): Promise<{ ok: boolean; reason?: string }> => {
      if (!payload || typeof payload.path !== 'string' || payload.path.trim() === '') {
        return { ok: false, reason: 'A file path is required.' }
      }
      const workspaceRoot = getCurrentWorkspace()
      if (!workspaceRoot) {
        return { ok: false, reason: 'Pick a workspace folder first.' }
      }
      let resolved: string
      try {
        // The sandbox resolver handles relative paths against the workspace
        // root and refuses anything outside it — reads may follow links, so
        // 'read' access is the honest mode for opening.
        resolved = resolveWorkspacePath(workspaceRoot, payload.path, 'read')
      } catch (error) {
        return {
          ok: false,
          reason:
            error instanceof Error ? error.message : 'That path is outside your workspace folder.'
        }
      }
      // resolve() is a no-op for already-absolute resolved paths and a
      // backstop for platform-normalized input.
      const errorMessage = await shell.openPath(resolve(resolved))
      if (errorMessage) return { ok: false, reason: errorMessage }
      return { ok: true }
    }
  )
}
