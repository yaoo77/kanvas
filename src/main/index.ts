import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  protocol,
  net,
  session,
  Menu,
  screen
} from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { registerFsHandlers } from './ipc/fs-handlers'
import { registerPtyHandlers } from './ipc/pty-handlers'
import { registerImageHandlers } from './ipc/image-handlers'
import { startWatcher } from './watcher'
import { registerCmuxHandlers } from './ipc/cmux-handlers'
import { registerWorkspaceHandlers } from './ipc/workspace-handlers'
import { registerDialogHandlers } from './ipc/dialog-handlers'
import { loadConfig, saveConfig, AppConfig, getPref, setPref } from './config'

let mainWindow: BrowserWindow | null = null
let config: AppConfig
let settingsOpen = false

/* ── Paths ── */

function getPreloadPath(name: string): string {
  return join(__dirname, `../preload/${name}.js`)
}

function getRendererURL(name: string): string {
  if (process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}/${name}/index.html`
  }
  return pathToFileURL(
    join(__dirname, `../renderer/${name}/index.html`)
  ).href
}

/* ── Window ── */

const DEFAULT_STATE = { width: 1200, height: 800, x: undefined as number | undefined, y: undefined as number | undefined, isMaximized: false }

function boundsVisibleOnAnyDisplay(bounds: { x: number; y: number; width: number; height: number }): boolean {
  const displays = screen.getAllDisplays()
  return displays.some((d) => {
    const { x, y, width, height } = d.workArea
    return (
      bounds.x < x + width &&
      bounds.x + bounds.width > x &&
      bounds.y < y + height &&
      bounds.y + bounds.height > y
    )
  })
}

function createWindow(): void {
  const saved = config.window_state
  const useSaved =
    saved != null &&
    (saved.isMaximized || boundsVisibleOnAnyDisplay(saved))
  const state = useSaved ? saved : DEFAULT_STATE

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    minWidth: 400,
    minHeight: 400,
    titleBarStyle: 'hidden',
    backgroundColor: '#121212',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: getPreloadPath('shell'),
      contextIsolation: true,
      sandbox: true,
      webviewTag: true
    }
  }

  if (useSaved && state.x != null && state.y != null) {
    windowOptions.x = state.x
    windowOptions.y = state.y
  }

  mainWindow = new BrowserWindow(windowOptions)
  if (state.isMaximized) mainWindow.maximize()

  // Save window state on move/resize
  let saveTimeout: NodeJS.Timeout | null = null
  const debouncedSave = (): void => {
    if (saveTimeout) clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const { x, y, width, height } = mainWindow.getNormalBounds()
      config.window_state = { x, y, width, height, isMaximized: mainWindow.isMaximized() }
      saveConfig(config)
    }, 500)
  }
  mainWindow.on('move', debouncedSave)
  mainWindow.on('resize', debouncedSave)

  mainWindow.loadURL(getRendererURL('shell'))
}

/* ── Shell view config ── */

function registerShellIpc(): void {
  ipcMain.handle('shell:get-view-config', () => {
    const preload = pathToFileURL(getPreloadPath('universal')).href
    return {
      nav: { src: getRendererURL('nav'), preload },
      viewer: { src: getRendererURL('viewer'), preload },
      terminal: { src: getRendererURL('terminal'), preload },
      terminalTile: { src: getRendererURL('terminal-tile'), preload },
      graphTile: { src: getRendererURL('graph-tile'), preload },
      settings: { src: getRendererURL('settings'), preload }
    }
  })

  ipcMain.handle('shell:get-workspace-path', () => {
    const idx = config.active_workspace
    return idx >= 0 && idx < config.workspaces.length ? config.workspaces[idx] : null
  })

  ipcMain.handle('config:get', () => {
    const idx = config.active_workspace
    const workspacePath = idx >= 0 && idx < config.workspaces.length ? config.workspaces[idx] : null
    return { ...config, workspacePath }
  })
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('pref:get', (_e, key: string) => getPref(config, key))
  ipcMain.handle('pref:set', (_e, key: string, value: unknown) => {
    setPref(config, key, value)
  })

  // Settings toggle
  ipcMain.on('settings:open', () => setSettingsOpen(true))
  ipcMain.on('settings:close', () => setSettingsOpen(false))
  ipcMain.on('settings:toggle', () => setSettingsOpen(!settingsOpen))

  // Tile list for session panel — request from shell's tile state
  ipcMain.handle('tiles:list', async () => {
    return new Promise((resolve) => {
      const channel = `tiles:list-response-${Date.now()}`
      ipcMain.once(channel, (_e, tiles) => resolve(tiles))
      mainWindow?.webContents.send('tiles:list-request', channel)
      // Timeout fallback
      setTimeout(() => resolve([]), 2000)
    })
  })

  // Focus a tile by ID
  ipcMain.on('tiles:focus', (_e, tileId: string) => {
    forwardToShell('tiles:focus', tileId)
  })

  ipcMain.on('shell:open-external', (_e, url: string) => {
    // Open URL in kawase browser tile instead of system browser
    forwardToShell('cmux:new-pane-with-url', url)
  })

  // Canvas pinch forwarding
  ipcMain.on('canvas:forward-pinch', (_e, deltaY: number) => {
    mainWindow?.webContents.send('canvas:pinch', deltaY)
  })

  ipcMain.handle('canvas:load-state', async () => {
    const { readFileSync, existsSync } = require('fs')
    const { join } = require('path')
    const dir = join(app.getPath('home'), '.kawase')
    const fp = join(dir, 'canvas-state.json')
    if (!existsSync(fp)) return null
    try {
      return JSON.parse(readFileSync(fp, 'utf-8'))
    } catch { return null }
  })

  ipcMain.handle('canvas:save-state', async (_e, state: unknown) => {
    const { writeFileSync, mkdirSync, existsSync } = require('fs')
    const { join } = require('path')
    const dir = join(app.getPath('home'), '.kawase')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'canvas-state.json'), JSON.stringify(state))
  })
}

function setSettingsOpen(open: boolean): void {
  settingsOpen = open
  forwardToShell('shell:settings', open ? 'open' : 'close')
}

/* ── Forward to shell webcontents ── */

export function forwardToShell(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args)
}

export function forwardToWebview(target: string, channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send('shell:forward', target, channel, ...args)
}

/* ── App Menu ── */

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'kawase',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings...', accelerator: 'CmdOrCtrl+,', click: () => setSettingsOpen(true) },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ── App lifecycle ── */

app.whenReady().then(async () => {
  // Browser session UA
  const browserSession = session.fromPartition('persist:browser')
  const electronUA = browserSession.getUserAgent()
  browserSession.setUserAgent(electronUA.replace(/\s*Electron\/\S+/, ''))

  // Custom protocol
  protocol.handle('collab-file', (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname)
    return net.fetch(`file://${filePath}`)
  })

  // Load config
  config = loadConfig()

  // Register IPC handlers
  registerShellIpc()
  registerFsHandlers()
  registerPtyHandlers()
  registerCmuxHandlers()
  registerWorkspaceHandlers(config)
  registerDialogHandlers()
  registerImageHandlers()

  // Git operations
  ipcMain.handle('git:exec', async (_e, args: string[]) => {
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const execFileAsync = promisify(execFile)
    const idx = config.active_workspace
    const cwd = idx >= 0 && idx < config.workspaces.length ? config.workspaces[idx] : process.cwd()
    try {
      const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: 30000 })
      return { ok: true, output: stdout.trim(), stderr: stderr?.trim() || '' }
    } catch (err: any) {
      const output = err.stdout?.trim() || ''
      const stderr = err.stderr?.trim() || ''
      return { ok: false, error: err.message, output, stderr }
    }
  })

  // Build menu and create window
  buildAppMenu()
  createWindow()

  mainWindow!.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('shell:loading-done')
  })

  // Start file watcher for the active workspace
  const idx = config.active_workspace
  const workspacePath = idx >= 0 && idx < config.workspaces.length ? config.workspaces[idx] : null
  if (workspacePath) {
    startWatcher(workspacePath, (events) => {
      mainWindow?.webContents.send('fs-changed', events)
    })
  }
})

app.on('before-quit', () => {
  // Cleanup PTY sessions, etc.
})

app.on('window-all-closed', () => {
  app.quit()
})
