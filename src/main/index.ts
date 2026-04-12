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
import { registerPtyHandlers, saveAllScrollback } from './ipc/pty-handlers'
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
      sandbox: false,
      webviewTag: true
    }
  }

  if (useSaved && state.x != null && state.y != null) {
    windowOptions.x = state.x
    windowOptions.y = state.y
  }

  mainWindow = new BrowserWindow(windowOptions)
  if (state.isMaximized) mainWindow.maximize()

  // Allow File.path in webview guests (needed for Finder file drops)
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.sandbox = false
  })

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

  ipcMain.on('tiles:close', (_e, tileId: string) => {
    forwardToShell('tiles:close', tileId)
  })

  ipcMain.on('tiles:close-all', () => {
    forwardToShell('tiles:close-all')
  })

  ipcMain.on('shell:show-in-folder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.on('shell:open-external', (_e, url: string) => {
    // Open URL in kawase browser tile instead of system browser
    forwardToShell('cmux:new-pane-with-url', url)
  })

  ipcMain.handle('shell:open-path', async (_e, filePath: string) => {
    const { existsSync } = require('fs')
    if (!existsSync(filePath)) return { ok: false, error: 'not-found' }
    const err = await shell.openPath(filePath)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle('clipboard:save-image-to-temp', async () => {
    const { clipboard } = require('electron')
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const { writeFileSync, mkdirSync, existsSync } = require('fs')
    const { join } = require('path')
    const { tmpdir } = require('os')
    const dir = join(tmpdir(), 'kanvas-paste')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const filename = `paste-${Date.now()}.png`
    const filepath = join(dir, filename)
    writeFileSync(filepath, img.toPNG())
    return filepath
  })

  // Phase 4-22: Keyboard shortcuts config at ~/.kanvas/keymap.json
  ipcMain.handle('keymap:load', async () => {
    const { readFileSync, existsSync, writeFileSync, mkdirSync } = require('fs')
    const { join } = require('path')
    const dir = join(app.getPath('home'), '.kanvas')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const fp = join(dir, 'keymap.json')
    if (!existsSync(fp)) {
      const defaults = {
        'toggle-theme': 'mod+shift+t',
        'toggle-right-panel': 'mod+j',
        'new-terminal': 'mod+t',
        'new-note': 'mod+shift+n',
        'start-connection': 'mod+l',
        'smart-copy': 'mod+shift+c',
        'close-tile': 'mod+w',
        'rename-tile': 'mod+r',
        // Chorded example
        'focus-nav': 'mod+k mod+n',
        'focus-terminal': 'mod+k mod+t',
      }
      writeFileSync(fp, JSON.stringify(defaults, null, 2))
      return defaults
    }
    try { return JSON.parse(readFileSync(fp, 'utf-8')) } catch { return {} }
  })
  ipcMain.handle('keymap:save', async (_e, keymap: unknown) => {
    const { writeFileSync, mkdirSync, existsSync } = require('fs')
    const { join } = require('path')
    const dir = join(app.getPath('home'), '.kanvas')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'keymap.json'), JSON.stringify(keymap, null, 2))
  })

  // Phase 3-17: Agent Roles stored at ~/.kanvas/roles.json
  ipcMain.handle('roles:load', async () => {
    const { readFileSync, existsSync, writeFileSync, mkdirSync } = require('fs')
    const { join } = require('path')
    const dir = join(app.getPath('home'), '.kanvas')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const fp = join(dir, 'roles.json')
    if (!existsSync(fp)) {
      const defaults = [
        { id: 'lead',     name: 'Lead',         icon: '🎩', color: '#fbbf24', systemPrompt: 'You are the team lead. Coordinate, delegate, and summarize.' },
        { id: 'coder',    name: 'Vibe Coder',   icon: '⚡', color: '#60a5fa', systemPrompt: 'You are a fast, pragmatic coder. Ship working code quickly.' },
        { id: 'reviewer', name: 'Reviewer',     icon: '🔍', color: '#a78bfa', systemPrompt: 'You are a strict reviewer. Find bugs, missing tests, and bad patterns.' },
        { id: 'tester',   name: 'Tester',       icon: '🧪', color: '#6ee7b7', systemPrompt: 'You are a thorough tester. Design test cases and verify edge cases.' },
        { id: 'docs',     name: 'Docs Goblin',  icon: '📝', color: '#f87171', systemPrompt: 'You are the documentation specialist. Write clear docs and examples.' },
      ]
      writeFileSync(fp, JSON.stringify(defaults, null, 2))
      return defaults
    }
    try { return JSON.parse(readFileSync(fp, 'utf-8')) } catch { return [] }
  })
  ipcMain.handle('roles:save', async (_e, roles: unknown) => {
    const { writeFileSync, mkdirSync, existsSync } = require('fs')
    const { join } = require('path')
    const dir = join(app.getPath('home'), '.kanvas')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'roles.json'), JSON.stringify(roles, null, 2))
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

  // Phase 6: Note file operations — read/write .md files on disk
  ipcMain.handle('note:read-file', async (_e, filePath: string) => {
    const { readFileSync, existsSync } = require('fs')
    if (existsSync(filePath)) return readFileSync(filePath, 'utf-8')
    return ''
  })

  ipcMain.handle('note:write-file', async (_e, { filePath, content }: { filePath: string; content: string }) => {
    const { writeFileSync, mkdirSync } = require('fs')
    const { dirname } = require('path')
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf-8')
  })

  // Phase 4-21: Floors — create/list/remove git worktrees and snapshot canvas state
  ipcMain.handle('floors:list', async () => {
    const { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } = require('fs')
    const { join } = require('path')
    const dir = join(app.getPath('home'), '.kanvas', 'floors')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const manifestFp = join(dir, 'manifest.json')
    if (!existsSync(manifestFp)) writeFileSync(manifestFp, '[]')
    try { return JSON.parse(readFileSync(manifestFp, 'utf-8')) } catch { return [] }
  })
  ipcMain.handle('floors:create', async (_e, opts: { sourceDir: string; name: string; canvasState: unknown }) => {
    const { execSync } = require('child_process')
    const { writeFileSync, mkdirSync, existsSync, readFileSync } = require('fs')
    const { join, basename } = require('path')
    const floorsDir = join(app.getPath('home'), '.kanvas', 'floors')
    if (!existsSync(floorsDir)) mkdirSync(floorsDir, { recursive: true })
    const floorId = `floor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const worktreeDir = join(floorsDir, floorId)
    const branch = `kanvas/${opts.name.replace(/\s+/g, '-').toLowerCase()}-${floorId.slice(-4)}`
    try {
      execSync(`git -C "${opts.sourceDir}" worktree add -b "${branch}" "${worktreeDir}"`, { stdio: 'pipe' })
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    // Save canvas state snapshot
    const stateFp = join(floorsDir, `${floorId}-canvas.json`)
    writeFileSync(stateFp, JSON.stringify(opts.canvasState))
    // Update manifest
    const manifestFp = join(floorsDir, 'manifest.json')
    let manifest: any[] = []
    try { manifest = JSON.parse(readFileSync(manifestFp, 'utf-8')) } catch { manifest = [] }
    manifest.push({
      id: floorId,
      name: opts.name,
      branch,
      worktreeDir,
      sourceDir: opts.sourceDir,
      createdAt: new Date().toISOString(),
    })
    writeFileSync(manifestFp, JSON.stringify(manifest, null, 2))
    return { ok: true, id: floorId, branch, worktreeDir, canvasStateFp: stateFp }
  })
  ipcMain.handle('floors:remove', async (_e, floorId: string) => {
    const { execSync } = require('child_process')
    const { readFileSync, writeFileSync, existsSync, rmSync } = require('fs')
    const { join } = require('path')
    const floorsDir = join(app.getPath('home'), '.kanvas', 'floors')
    const manifestFp = join(floorsDir, 'manifest.json')
    let manifest: any[] = []
    try { manifest = JSON.parse(readFileSync(manifestFp, 'utf-8')) } catch { return { ok: false, error: 'no manifest' } }
    const entry = manifest.find((f) => f.id === floorId)
    if (!entry) return { ok: false, error: 'not found' }
    try {
      execSync(`git -C "${entry.sourceDir}" worktree remove --force "${entry.worktreeDir}"`, { stdio: 'pipe' })
    } catch {}
    if (existsSync(join(floorsDir, `${floorId}-canvas.json`))) {
      try { rmSync(join(floorsDir, `${floorId}-canvas.json`)) } catch {}
    }
    manifest = manifest.filter((f) => f.id !== floorId)
    writeFileSync(manifestFp, JSON.stringify(manifest, null, 2))
    return { ok: true }
  })

  // Phase 4-24: kanvas CLI — Unix domain socket JSON RPC
  setupKanvasCliServer()
}

/* ── Phase 4-24: kanvas CLI socket server ── */

let pendingCliRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function setupKanvasCliServer(): void {
  const net = require('net')
  const fs = require('fs')
  const os = require('os')
  const { join } = require('path')
  const dir = join(os.homedir(), '.kanvas')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const sockPath = join(dir, 'cli.sock')
  try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath) } catch {}

  const server = net.createServer((socket: any) => {
    let buf = ''
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) handleCliRequest(line, socket)
        idx = buf.indexOf('\n')
      }
    })
    socket.on('error', () => {})
  })
  server.listen(sockPath)

  app.on('before-quit', () => {
    server.close()
    try { fs.unlinkSync(sockPath) } catch {}
  })

  // Response from shell renderer
  ipcMain.on('cli:response', (_e, id: string, result: unknown, error: string | null) => {
    const pending = pendingCliRequests.get(id)
    if (!pending) return
    pendingCliRequests.delete(id)
    if (error) pending.reject(new Error(error))
    else pending.resolve(result)
  })
}

async function handleCliRequest(line: string, socket: any): Promise<void> {
  try {
    const { method, params } = JSON.parse(line)
    const id = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const resultPromise = new Promise((resolve, reject) => {
      pendingCliRequests.set(id, { resolve, reject })
      // Timeout after 5 s
      setTimeout(() => {
        if (pendingCliRequests.has(id)) {
          pendingCliRequests.delete(id)
          reject(new Error('timeout waiting for shell'))
        }
      }, 5000)
    })
    mainWindow?.webContents.send('cli:request', id, method, params ?? {})
    const result = await resultPromise
    socket.write(JSON.stringify({ result }))
    socket.end()
  } catch (err) {
    socket.write(JSON.stringify({ error: (err as Error).message }))
    socket.end()
  }
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
      label: 'kanvas',
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
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Toggle Theme',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => forwardToShell('shell:shortcut', 'toggle-theme'),
        },
        {
          label: 'Toggle Draw Mode',
          accelerator: 'CmdOrCtrl+D',
          click: () => forwardToShell('shell:shortcut', 'toggle-draw'),
        },
      ]
    },
    {
      label: 'Canvas',
      submenu: [
        {
          label: 'Toggle Right Panel',
          accelerator: 'CmdOrCtrl+J',
          click: () => forwardToShell('shell:shortcut', 'toggle-right-panel'),
        },
        {
          label: 'Start Connection',
          accelerator: 'CmdOrCtrl+L',
          click: () => forwardToShell('shell:shortcut', 'start-connection'),
        },
        { type: 'separator' },
        {
          label: 'New Terminal',
          accelerator: 'CmdOrCtrl+T',
          click: () => forwardToShell('shell:shortcut', 'new-terminal'),
        },
        {
          label: 'New Note',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => forwardToShell('shell:shortcut', 'new-note'),
        },
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
      // git pull/push output fetch info to stderr even on success
      // Check if it's a real error by looking for fatal/error keywords
      const isRealError = (err.message || '').includes('fatal') || (err.message || '').includes('error:') || (err.message || '').includes('CONFLICT')
      if (!isRealError && output) {
        return { ok: true, output, stderr }
      }
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
      // Send to shell and all webviews (nav, viewer, etc.)
      mainWindow?.webContents.send('fs-changed', events)
      // Also forward to all webviews within the shell
      forwardToWebview('nav', 'fs-changed', events)
      forwardToWebview('viewer', 'fs-changed', events)
    })
  }
})

app.on('before-quit', () => {
  saveAllScrollback()
})

app.on('window-all-closed', () => {
  app.quit()
})
