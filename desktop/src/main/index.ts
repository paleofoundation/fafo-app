import { BrowserWindow, Notification, app, shell } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { openDb } from './db'
import { overdueDeadlines } from './db/queries'
import { migrateBootstrapSecrets } from './secrets'
import { startScheduler } from './services/scheduler'

// Pin the data directory to a stable name so the SQLite file survives
// app renames and never lands in the shared "Electron" dev folder.
app.setPath('userData', path.join(app.getPath('appData'), 'FAFO'))

// One writer, always: a second launch (user double-click or the future
// launchd wake-up) hands off to the running instance instead of opening
// a second SQLite connection.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpc()
    migrateBootstrapSecrets()

    // FAFO_SMOKE=1: verify the app boots — DB opens, migrations/seed run,
    // IPC registers — then report and quit without showing a window.
    if (process.env['FAFO_SMOKE']) {
      const db = openDb()
      const today = new Date().toISOString().slice(0, 10)
      const n = overdueDeadlines(db, today).length
      console.log(`FAFO SMOKE OK — db at ${app.getPath('userData')}, ${n} overdue deadline(s)`)
      app.quit()
      return
    }

    startScheduler(openDb())
    createWindow()
    notifyOverdue()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 600,
    title: 'FAFO',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/**
 * The deadline surface must be impossible to miss: overdue items fire a
 * native notification at every launch until satisfied or dismissed.
 * Missed deadlines are legally unrecoverable — this is the whole point.
 */
function notifyOverdue(): void {
  const db = openDb()
  const today = new Date().toISOString().slice(0, 10)
  const overdue = overdueDeadlines(db, today)
  if (overdue.length === 0 || !Notification.isSupported()) return
  const first = overdue[0]!
  const body =
    overdue.length === 1
      ? `${first.title} (due ${first.dueAt})`
      : `${first.title} (due ${first.dueAt}) — and ${overdue.length - 1} more overdue`
  new Notification({ title: `FAFO: ${overdue.length} overdue deadline${overdue.length > 1 ? 's' : ''}`, body }).show()
}
