import { contextBridge, ipcRenderer } from 'electron'

const ALLOWED_PANELS = new Set(['nav', 'viewer', 'terminal', 'terminalTile', 'graphTile', 'settings'])

let loadingDoneReceived = false
ipcRenderer.on('shell:loading-done', () => {
  loadingDoneReceived = true
})

const pendingForwards: Array<[string, string, ...unknown[]]> = []
ipcRenderer.on('shell:forward', (_event, target: string, channel: string, ...args: unknown[]) => {
  pendingForwards.push([target, channel, ...args])
})

contextBridge.exposeInMainWorld('shellApi', {
  getViewConfig: () => ipcRenderer.invoke('shell:get-view-config'),
  getPref: (key: string) => ipcRenderer.invoke('pref:get', key),
  setPref: (key: string, value: unknown) => ipcRenderer.invoke('pref:set', key, value),

  onForwardToWebview: (cb: (target: string, channel: string, ...args: unknown[]) => void) => {
    for (const [target, channel, ...args] of pendingForwards) {
      cb(target, channel, ...args)
    }
    pendingForwards.length = 0
    ipcRenderer.removeAllListeners('shell:forward')
    const handler = (_event: Electron.IpcRendererEvent, target: string, channel: string, ...args: unknown[]) =>
      cb(target, channel, ...args)
    ipcRenderer.on('shell:forward', handler)
    return () => ipcRenderer.removeListener('shell:forward', handler)
  },

  onSettingsToggle: (cb: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => cb(action)
    ipcRenderer.on('shell:settings', handler)
    return () => ipcRenderer.removeListener('shell:settings', handler)
  },

  onLoadingDone: (cb: () => void) => {
    if (loadingDoneReceived) {
      cb()
      return () => {}
    }
    const handler = () => {
      loadingDoneReceived = true
      cb()
    }
    ipcRenderer.on('shell:loading-done', handler)
    return () => ipcRenderer.removeListener('shell:loading-done', handler)
  },

  onShortcut: (cb: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => cb(action)
    ipcRenderer.on('shell:shortcut', handler)
    return () => ipcRenderer.removeListener('shell:shortcut', handler)
  },

  openSettings: () => ipcRenderer.send('settings:open'),
  closeSettings: () => ipcRenderer.send('settings:close'),
  toggleSettings: () => ipcRenderer.send('settings:toggle'),

  logFromWebview: (panel: string, level: string, message: string, source?: string) => {
    if (!ALLOWED_PANELS.has(panel)) return
    ipcRenderer.send('webview:console', panel, level, message, source)
  },

  selectFile: (path: string) => ipcRenderer.send('nav:select-file', path),
  getWorkspacePath: () => ipcRenderer.invoke('shell:get-workspace-path'),

  workspaceAdd: () => ipcRenderer.invoke('workspace:add'),
  workspaceRemove: (index: number) => ipcRenderer.invoke('workspace:remove', index),
  workspaceSwitch: (index: number) => ipcRenderer.invoke('workspace:switch', index),
  workspaceList: () => ipcRenderer.invoke('workspace:list'),

  onWorkspaceChanged: (cb: (path: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, path: string) => cb(path)
    ipcRenderer.on('shell:workspace-changed', handler)
    return () => ipcRenderer.removeListener('shell:workspace-changed', handler)
  },

  canvasLoadState: () => ipcRenderer.invoke('canvas:load-state'),
  canvasSaveState: (state: unknown) => ipcRenderer.invoke('canvas:save-state', state),
  getDragPaths: () => ipcRenderer.invoke('drag:get-paths'),
  showConfirmDialog: (opts: { message: string; detail?: string }) =>
    ipcRenderer.invoke('dialog:confirm', opts),
  showContextMenu: (items: Array<{ label: string; id: string }>) =>
    ipcRenderer.invoke('context-menu:show', items),
  openExternal: (url: string) => ipcRenderer.send('shell:open-external', url),

  onCanvasPinch: (cb: (deltaY: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, deltaY: number) => cb(deltaY)
    ipcRenderer.on('canvas:pinch', handler)
    return () => ipcRenderer.removeListener('canvas:pinch', handler)
  },

  // cmux internal events
  onCmuxSplit: (cb: (direction: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, dir: string) => cb(dir)
    ipcRenderer.on('cmux:split', handler)
    return () => ipcRenderer.removeListener('cmux:split', handler)
  },
  onCmuxNewPane: (cb: (paneType: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, type: string) => cb(type)
    ipcRenderer.on('cmux:new-pane', handler)
    return () => ipcRenderer.removeListener('cmux:new-pane', handler)
  },
  onCmuxNewWorkspace: (cb: () => void) => {
    ipcRenderer.on('cmux:new-workspace', cb)
    return () => ipcRenderer.removeListener('cmux:new-workspace', cb)
  },
  onCmuxSendText: (cb: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => cb(text)
    ipcRenderer.on('cmux:send-text', handler)
    return () => ipcRenderer.removeListener('cmux:send-text', handler)
  },
  onCmuxOpenFile: (cb: (path: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, path: string) => cb(path)
    ipcRenderer.on('cmux:open-file', handler)
    return () => ipcRenderer.removeListener('cmux:open-file', handler)
  },
  onCmuxFullscreen: (cb: () => void) => {
    ipcRenderer.on('cmux:fullscreen', cb)
    return () => ipcRenderer.removeListener('cmux:fullscreen', cb)
  },
  onCmuxNewPaneWithUrl: (cb: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => cb(url)
    ipcRenderer.on('cmux:new-pane-with-url', handler)
    return () => ipcRenderer.removeListener('cmux:new-pane-with-url', handler)
  },

  // Tile list for session panel
  onTilesListRequest: (cb: (responseChannel: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, channel: string) => cb(channel)
    ipcRenderer.on('tiles:list-request', handler)
    return () => ipcRenderer.removeListener('tiles:list-request', handler)
  },
  sendTilesListResponse: (channel: string, tiles: unknown) => {
    ipcRenderer.send(channel, tiles)
  },

  onTilesFocus: (cb: (tileId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string) => cb(id)
    ipcRenderer.on('tiles:focus', handler)
    return () => ipcRenderer.removeListener('tiles:focus', handler)
  },
  onTilesClose: (cb: (tileId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string) => cb(id)
    ipcRenderer.on('tiles:close', handler)
    return () => ipcRenderer.removeListener('tiles:close', handler)
  },
  onTilesCloseAll: (cb: () => void) => {
    ipcRenderer.on('tiles:close-all', cb)
    return () => ipcRenderer.removeListener('tiles:close-all', cb)
  }
})
