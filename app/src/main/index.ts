import { app, shell, BrowserWindow } from 'electron'
import { join, resolve } from 'path'
import icon from '../../resources/icon.png?asset'
import { registerChatIpc } from './ipc/chat'
import { registerSidecarIpc } from './ipc/sidecar'
import { generateSidecarToken, killSidecar, onSidecarStatusChange, startSidecar } from './sidecar'

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
app.whenReady().then(() => {
  // Set app user model id for windows
  app.setAppUserModelId('com.agento.app')

  // Chat transport contract (docs/02 §2.1): 'chat:send' invoke + 'chat:part' events.
  registerChatIpc()

  // Sidecar status contract (docs/03 §4): 'sidecar:get-status' invoke +
  // 'sidecar:status' push. Subscribe before spawning so no transition is missed.
  registerSidecarIpc()
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
