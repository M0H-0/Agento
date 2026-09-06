import { dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { getCurrentWorkspace, listRecentWorkspaces, setCurrentWorkspace } from '../workspaces'
import type { WorkspaceRecent } from '../workspaces'

// Workspace contract (docs/03 §4 workspace/*): the picker's native folder
// dialog is owned ENTIRELY by the main process (a renderer never supplies an
// arbitrary path as a workspace choice — the only set-able paths are ones this
// module produced: a fresh dialog pick or an entry from our own recents list).
// 'workspace:get' returns the current workspace + recents so a renderer that
// mounts late gets the full state.

export interface WorkspaceSnapshotPayload {
  current: string | null
  recents: WorkspaceRecent[]
}

export interface WorkspaceSetPayload {
  path: string
}

function toSnapshot(): WorkspaceSnapshotPayload {
  return { current: getCurrentWorkspace(), recents: listRecentWorkspaces() }
}

export function registerWorkspacesIpc(): void {
  ipcMain.handle('workspace:get', (): WorkspaceSnapshotPayload => toSnapshot())

  ipcMain.handle('workspace:list', (): WorkspaceRecent[] => listRecentWorkspaces())

  // Native folder dialog — the ONLY source of an arbitrary new workspace path.
  ipcMain.handle('workspace:pick', async (): Promise<{ path: string } | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a workspace folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // setCurrentWorkspace throws a plain-language Error for an invalid pick the
    // same way settings setters do — the renderer's invoke promise rejects and
    // the picker shows the message.
    const path = setCurrentWorkspace(result.filePaths[0])
    return { path }
  })

  // Re-apply a recent (a path this module wrote to recents earlier — not an
  // arbitrary renderer-supplied path).
  ipcMain.handle(
    'workspace:set',
    (_event: IpcMainInvokeEvent, payload: WorkspaceSetPayload): { path: string } => {
      if (!payload || typeof payload.path !== 'string' || payload.path.trim() === '') {
        throw new Error('A workspace path is required.')
      }
      const path = setCurrentWorkspace(payload.path)
      return { path }
    }
  )
}
