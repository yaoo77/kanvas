import { contextBridge, ipcRenderer } from 'electron'

/* ── Listener sets for high-frequency events ── */

const dataListeners = new Set<(payload: { sessionId: string; data: string }) => void>()
const exitListeners = new Set<(payload: { sessionId: string; exitCode: number }) => void>()
const cdToListeners = new Set<(path: string) => void>()
const runInTerminalListeners = new Set<(command: string) => void>()
const focusTabListeners = new Set<(id: string) => void>()
const shellBlurListeners = new Set<() => void>()

ipcRenderer.on('pty:data', (_e, payload) => {
  for (const cb of dataListeners) cb(payload)
})
ipcRenderer.on('pty:exit', (_e, payload) => {
  for (const cb of exitListeners) cb(payload)
})
ipcRenderer.on('cd-to', (_e, path) => {
  for (const cb of cdToListeners) cb(path)
})
ipcRenderer.on('run-in-terminal', (_e, command) => {
  for (const cb of runInTerminalListeners) cb(command)
})
ipcRenderer.on('focus-tab', (_e, id) => {
  for (const cb of focusTabListeners) cb(id)
})
ipcRenderer.on('shell-blur', () => {
  for (const cb of shellBlurListeners) cb()
})

/* ── cmux write-to-pty from shell ── */
const cmuxWriteListeners = new Set<(text: string) => void>()
ipcRenderer.on('cmux:write-to-pty', (_e, text) => {
  for (const cb of cmuxWriteListeners) cb(text)
})

/* ── Buffered workspace path ── */

let bufferedWorkspacePath: string | null = null
ipcRenderer.on('workspace-changed', (_e, path) => {
  bufferedWorkspacePath = path
})

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getPref: (key: string) => ipcRenderer.invoke('pref:get', key),
  setPref: (key: string, value: unknown) => ipcRenderer.invoke('pref:set', key, value),

  // Nav + Viewer
  getSelectedFile: () => ipcRenderer.invoke('nav:get-selected-file'),
  selectFile: (path: string) => ipcRenderer.send('nav:select-file', path),
  readDir: (path: string) => ipcRenderer.invoke('fs:readdir', path),
  countFiles: (path: string) => ipcRenderer.invoke('fs:count-files', path),
  trashFile: (path: string) => ipcRenderer.invoke('fs:trash', path),
  createDir: (path: string) => ipcRenderer.invoke('fs:mkdir', path),
  moveFile: (old: string, newDir: string) => ipcRenderer.invoke('fs:move', old, newDir),
  selectFolder: (path: string) => ipcRenderer.send('nav:select-folder', path),
  readFolderTable: (folder: string) => ipcRenderer.invoke('fs:read-folder-table', folder),
  openInTerminal: (path: string) => ipcRenderer.send('nav:open-in-terminal', path),
  createGraphTile: (folder: string) => ipcRenderer.send('nav:create-graph-tile', folder),
  runInTerminal: (command: string) => ipcRenderer.send('viewer:run-in-terminal', command),

  // File operations
  readFile: (path: string) => ipcRenderer.invoke('fs:readfile', path),
  writeFile: (path: string, content: string, expectedMtime?: string) =>
    ipcRenderer.invoke('fs:writefile', path, content, expectedMtime),
  renameFile: (old: string, newTitle: string) => ipcRenderer.invoke('fs:rename', old, newTitle),
  getFileStats: (path: string) => ipcRenderer.invoke('fs:stat', path),

  // Image
  getImageThumbnail: (path: string, size: number) => ipcRenderer.invoke('image:thumbnail', path, size),
  getImageFull: (path: string) => ipcRenderer.invoke('image:full', path),
  resolveImagePath: (ref: string, from: string) => ipcRenderer.invoke('image:resolve-path', ref, from),
  openImageDialog: () => ipcRenderer.invoke('dialog:open-image'),

  // Workspace
  readTree: (params: unknown) => ipcRenderer.invoke('workspace:read-tree', params),
  showContextMenu: (items: unknown) => ipcRenderer.invoke('context-menu:show', items),
  close: () => ipcRenderer.send('settings:close'),

  // PTY
  ptyCreate: (cwd?: string, cols?: number, rows?: number) => ipcRenderer.invoke('pty:create', { cwd, cols, rows }),
  ptyWrite: (id: string, data: string) => ipcRenderer.invoke('pty:write', { sessionId: id, data }),
  ptySendRawKeys: (id: string, data: string) => ipcRenderer.invoke('pty:send-raw-keys', { sessionId: id, data }),
  ptyResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', { sessionId: id, cols, rows }),
  ptyKill: (id: string) => ipcRenderer.invoke('pty:kill', { sessionId: id }),
  ptyReconnect: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:reconnect', { sessionId: id, cols, rows }),
  ptyDiscover: () => ipcRenderer.invoke('pty:discover'),

  onPtyData: (cb: (payload: { sessionId: string; data: string }) => void) => { dataListeners.add(cb) },
  offPtyData: (cb: (payload: { sessionId: string; data: string }) => void) => { dataListeners.delete(cb) },
  onPtyExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) => { exitListeners.add(cb) },
  offPtyExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) => { exitListeners.delete(cb) },
  notifyPtySessionId: (id: string) => ipcRenderer.sendToHost('pty-session-id', id),

  onCdTo: (cb: (path: string) => void) => { cdToListeners.add(cb) },
  offCdTo: (cb: (path: string) => void) => { cdToListeners.delete(cb) },
  onRunInTerminal: (cb: (cmd: string) => void) => { runInTerminalListeners.add(cb) },
  offRunInTerminal: (cb: (cmd: string) => void) => { runInTerminalListeners.delete(cb) },

  // Cross-webview drag
  setDragPaths: (paths: string[]) => ipcRenderer.send('drag:set-paths', paths),
  clearDragPaths: () => ipcRenderer.send('drag:clear-paths'),
  getDragPaths: () => ipcRenderer.invoke('drag:get-paths'),
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),

  // Event listeners
  onWorkspaceChanged: (cb: (path: string) => void) => {
    if (bufferedWorkspacePath !== null) {
      cb(bufferedWorkspacePath)
      bufferedWorkspacePath = null
    }
    const handler = (_e: Electron.IpcRendererEvent, path: string) => cb(path)
    ipcRenderer.on('workspace-changed', handler)
    return () => ipcRenderer.removeListener('workspace-changed', handler)
  },
  onFileSelected: (cb: (path: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, path: string) => cb(path)
    ipcRenderer.on('file-selected', handler)
    return () => ipcRenderer.removeListener('file-selected', handler)
  },
  onFolderSelected: (cb: (path: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, path: string) => cb(path)
    ipcRenderer.on('folder-selected', handler)
    return () => ipcRenderer.removeListener('folder-selected', handler)
  },
  onFsChanged: (cb: (events: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, events: unknown) => cb(events)
    ipcRenderer.on('fs-changed', handler)
    return () => ipcRenderer.removeListener('fs-changed', handler)
  },
  onFocusTab: (cb: (id: string) => void) => {
    focusTabListeners.add(cb)
    return () => { focusTabListeners.delete(cb) }
  },
  onShellBlur: (cb: () => void) => {
    shellBlurListeners.add(cb)
    return () => { shellBlurListeners.delete(cb) }
  },

  // Canvas pinch
  forwardPinch: (deltaY: number) => ipcRenderer.send('canvas:forward-pinch', deltaY),

  // Tile/session management
  listTiles: () => ipcRenderer.invoke('tiles:list'),
  focusTile: (tileId: string) => ipcRenderer.send('tiles:focus', tileId),
  closeTile: (tileId: string) => ipcRenderer.send('tiles:close', tileId),
  closeAllTiles: () => ipcRenderer.send('tiles:close-all'),

  // cmux integration — internal API (no external binary)
  cmuxExec: (args: string[]) => ipcRenderer.invoke('cmux:exec', args),

  // cmux write-to-pty (from shell via webview message)
  onCmuxWrite: (cb: (text: string) => void) => { cmuxWriteListeners.add(cb) },
  offCmuxWrite: (cb: (text: string) => void) => { cmuxWriteListeners.delete(cb) },

  // Git operations
  gitExec: (args: string[]) => ipcRenderer.invoke('git:exec', args),

  // Clipboard & Finder
  copyToClipboard: (text: string) => { navigator.clipboard.writeText(text) },
  showInFolder: (path: string) => ipcRenderer.send('shell:show-in-folder', path)
})

// Prevent ctrl+wheel from zooming the webview
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault()
    ipcRenderer.send('canvas:forward-pinch', e.deltaY)
  }
}, { passive: false })
