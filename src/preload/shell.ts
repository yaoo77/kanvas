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
  readDir: (path: string) => ipcRenderer.invoke('fs:readdir', path),
  gitExec: (args: string[]) => ipcRenderer.invoke('git:exec', args),
  rolesLoad: () => ipcRenderer.invoke('roles:load'),
  rolesSave: (roles: unknown) => ipcRenderer.invoke('roles:save', roles),
  keymapLoad: () => ipcRenderer.invoke('keymap:load'),
  keymapSave: (k: unknown) => ipcRenderer.invoke('keymap:save', k),
  floorsList: () => ipcRenderer.invoke('floors:list'),
  floorsCreate: (opts: unknown) => ipcRenderer.invoke('floors:create', opts),
  floorsRemove: (id: string) => ipcRenderer.invoke('floors:remove', id),
  onCliRequest: (cb: (id: string, method: string, params: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, method: string, params: unknown) => cb(id, method, params)
    ipcRenderer.on('cli:request', handler)
    return () => ipcRenderer.removeListener('cli:request', handler)
  },
  cliRespond: (id: string, result: unknown, error: string | null = null) => {
    ipcRenderer.send('cli:response', id, result, error)
  },

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
  },

  noteReadFile: (filePath: string) => ipcRenderer.invoke('note:read-file', filePath),
  noteWriteFile: (filePath: string, content: string) => ipcRenderer.invoke('note:write-file', { filePath, content }),

  // Kanban: task worktree + agent management
  taskWorktreeCreate: (opts: { sourceDir: string; taskId: string; taskName: string }) =>
    ipcRenderer.invoke('task:worktree-create', opts),
  taskWorktreeRemove: (opts: { sourceDir: string; worktreeDir: string }) =>
    ipcRenderer.invoke('task:worktree-remove', opts),
  taskWorktreeDiff: (opts: { worktreeDir: string }) =>
    ipcRenderer.invoke('task:worktree-diff', opts),
  taskWorktreeCommit: (opts: { worktreeDir: string; message: string }) =>
    ipcRenderer.invoke('task:worktree-commit', opts),
  taskWorktreeMerge: (opts: { sourceDir: string; branch: string }) =>
    ipcRenderer.invoke('task:worktree-merge', opts),
  taskSpawnAgent: (opts: { worktreeDir: string; prompt: string; taskId: string; agentId?: string }) =>
    ipcRenderer.invoke('task:spawn-agent', opts),
  taskKillAgent: (taskId: string) =>
    ipcRenderer.invoke('task:kill-agent', taskId),
  onTaskAgentExit: (cb: (taskId: string, exitCode: number) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, taskId: string, code: number) => cb(taskId, code)
    ipcRenderer.on('task:agent-exit', handler)
    return () => ipcRenderer.removeListener('task:agent-exit', handler)
  },
  onTaskAgentOutput: (cb: (taskId: string, output: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, taskId: string, output: string) => cb(taskId, output)
    ipcRenderer.on('task:agent-output', handler)
    return () => ipcRenderer.removeListener('task:agent-output', handler)
  },
  taskAgentList: () => ipcRenderer.invoke('task:agent-list'),

  // Board state
  boardGet: () => ipcRenderer.invoke('board:get'),
  boardAddTask: (opts: { title: string; prompt: string; agentId?: string }) =>
    ipcRenderer.invoke('board:add-task', opts),
  boardMoveTask: (opts: { taskId: string; toStatus: string }) =>
    ipcRenderer.invoke('board:move-task', opts),
  boardUpdateTask: (opts: { taskId: string; updates: Record<string, unknown> }) =>
    ipcRenderer.invoke('board:update-task', opts),
  boardDeleteTask: (opts: { taskId: string }) =>
    ipcRenderer.invoke('board:delete-task', opts),
  boardAddDep: (opts: { from: string; to: string }) =>
    ipcRenderer.invoke('board:add-dep', opts),
  boardRemoveDep: (opts: { from: string; to: string }) =>
    ipcRenderer.invoke('board:remove-dep', opts),
  boardReadyTasks: () => ipcRenderer.invoke('board:ready-tasks'),
})
