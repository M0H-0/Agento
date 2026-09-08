import { app, dialog, shell, BrowserWindow } from 'electron'
import { join, resolve } from 'path'
import icon from '../../resources/icon.png?asset'
import { isSessionRunActive, registerChatIpc } from './ipc/chat'
import { registerSessionsIpc } from './ipc/sessions'
import { registerSettingsIpc } from './ipc/settings'
import { registerSidecarIpc } from './ipc/sidecar'
import { registerChangesIpc } from './ipc/changes'
import { registerWorkspacesIpc } from './ipc/workspaces'
import { getCurrentWorkspace } from './workspaces'
import { initSettings } from './settings'
import { dbFilePath, openDatabase, runSmokeQuery } from './storage/db'
import { generateSidecarToken, killSidecar, onSidecarStatusChange, startSidecar } from './sidecar'
import { initWorkspaces } from './workspaces'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    title: 'Agento',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  app.setAppUserModelId('com.agento.app')

  // Storage gate (docs/02 §2.5, §4 step 1): open SQLite, run the drizzle-kit
  // migrations, and prove it works before anything else starts. Docs/08 §7 DB
  // gate — the select-1 smoke under Electron. On failure the launch is over:
  // say so plainly and quit; the repos report their own errors afterwards.
  // The migrations folder lives beside the sources in dev; how it reaches a
  // packaged build is an M6.6 question (app is dev-only until then).
  try {
    const migrationsFolder = join(app.getAppPath(), 'drizzle')
    const db = await openDatabase(app.getPath('userData'), migrationsFolder)
    runSmokeQuery(db)
    const journalMode = db.pragma('journal_mode', { simple: true })
    console.log(
      `[storage] opened ${dbFilePath(app.getPath('userData'))} — journal_mode=${String(journalMode)}, migrations applied from ${migrationsFolder}, select-1 smoke ok`
    )
  } catch (err) {
    console.error('[storage] DB gate failed:', err)
    dialog.showErrorBox(
      'Agento',
      `Agento could not open its data file at ${dbFilePath(app.getPath('userData'))}. ` +
        (err instanceof Error ? err.message : String(err))
    )
    app.quit()
    return
  }

  // Settings + secrets (docs/06 §7 split): preferences in settings.json,
  // provider keys ONLY in safeStorage-encrypted secrets.bin. Runs before its
  // IPC registers so every handler answers from initialized state.
  initSettings(app.getPath('userData'))

  // Workspace selection + recents (docs/03 §4 workspace/*): plain-JSON state in
  // <userData>/workspaces.json. Initialized before session:create so a new
  // session always stamps the CURRENT workspace, not the placeholder.
  initWorkspaces(app.getPath('userData'))

  // Chat transport contract (docs/02 §2.1): 'chat:send' invoke + 'chat:part' events.
  registerChatIpc()

  // Sessions contract (docs/03 §4): 'session:create' + 'session:list' +
  // 'session:messages' invokes — lazy session rows for the sidebar.
  registerSessionsIpc()

  // Workspace contract (docs/03 §4 workspace/*): native folder pick + recents,
  // owned by main — 'workspace:get' / 'workspace:pick' / 'workspace:set' /
  // 'workspace:list'.
  registerWorkspacesIpc()

  // Settings contract (docs/03 §4): 'settings:get' + 'settings:set-api-key' +
  // 'settings:set-model' + 'settings:clear-api-key' invokes.
  registerSettingsIpc()

  // Sidecar status contract (docs/03 §4): 'sidecar:get-status' invoke +
  // 'sidecar:status' push. Subscribe before spawning so no transition is missed.
  registerSidecarIpc()
  // Changes contract (M2.8 panel; docs/03 §4 + §7-8): 'changes:list' +
  // 'changes:undo' + 'changes:undo-all' — a session's checkpoints with
  // per-item undo and Undo all. Undo is blocked mid-run via chat's map.
  registerChangesIpc(
    () => getCurrentWorkspace(),
    (sessionId) => isSessionRunActive(sessionId)
  )
  onSidecarStatusChange((event) => {
    // Push to every window — the focused window alone goes stale when blurred.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sidecar:status', event)
    }
  })

  // Sidecar lifecycle (docs/02 §2.4): per-launch token, spawn, /health polling.
  // Dev layout: services/intelligence sits beside app/; packaged layout is M6.6.
  startSidecar(generateSidecarToken(), resolve(app.getAppPath(), '..', 'services', 'intelligence'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Tree-kill the sidecar process chain (uv→uvicorn→python) on quit so nothing
// is left holding port 7891 (docs/02 §2.4).
app.on('before-quit', () => {
  killSidecar()
})
