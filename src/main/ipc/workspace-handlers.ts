import { ipcMain, dialog } from 'electron'
import { AppConfig, saveConfig } from '../config'
import { forwardToWebview, forwardToShell } from '../index'

let selectedFilePath: string | null = null

export function registerWorkspaceHandlers(config: AppConfig): void {
  // Selected file tracking
  ipcMain.handle('nav:get-selected-file', () => selectedFilePath)

  ipcMain.handle('workspace:list', () => ({
    workspaces: config.workspaces,
    active: config.active_workspace
  }))

  ipcMain.handle('workspace:add', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose workspace folder'
    })
    if (result.canceled || !result.filePaths.length) {
      return { workspaces: config.workspaces, active: config.active_workspace }
    }

    const chosen = result.filePaths[0]
    const existingIndex = config.workspaces.indexOf(chosen)

    if (existingIndex >= 0) {
      if (existingIndex !== config.active_workspace) {
        config.active_workspace = existingIndex
        saveConfig(config)
      }
      return { workspaces: config.workspaces, active: config.active_workspace, switched: true }
    }

    config.workspaces.push(chosen)
    config.active_workspace = config.workspaces.length - 1
    saveConfig(config)

    forwardToShell('shell:workspace-changed', chosen)
    forwardToWebview('nav', 'workspace-changed', chosen)
    forwardToWebview('viewer', 'workspace-changed', chosen)

    return { workspaces: config.workspaces, active: config.active_workspace, added: true }
  })

  ipcMain.handle('workspace:remove', (_e, index: number) => {
    if (index < 0 || index >= config.workspaces.length) {
      return { workspaces: config.workspaces, active: config.active_workspace }
    }

    const wasActive = index === config.active_workspace
    config.workspaces.splice(index, 1)

    if (config.workspaces.length === 0) {
      config.active_workspace = -1
    } else {
      config.active_workspace = Math.min(config.active_workspace, config.workspaces.length - 1)
      if (config.active_workspace > index) {
        config.active_workspace -= 1
      }
    }
    saveConfig(config)

    if (wasActive && config.active_workspace >= 0) {
      const newPath = config.workspaces[config.active_workspace]
      forwardToShell('shell:workspace-changed', newPath)
      forwardToWebview('nav', 'workspace-changed', newPath)
      forwardToWebview('viewer', 'workspace-changed', newPath)
    }

    return { workspaces: config.workspaces, active: config.active_workspace }
  })

  ipcMain.handle('workspace:switch', (_e, index: number) => {
    if (index < 0 || index >= config.workspaces.length || index === config.active_workspace) {
      return
    }
    config.active_workspace = index
    saveConfig(config)

    const newPath = config.workspaces[index]
    forwardToShell('shell:workspace-changed', newPath)
    forwardToWebview('nav', 'workspace-changed', newPath)
    forwardToWebview('viewer', 'workspace-changed', newPath)
  })

  // Forward events between panels
  ipcMain.on('nav:select-file', (_e, path: string) => {
    selectedFilePath = path
    forwardToWebview('viewer', 'file-selected', path)
  })

  ipcMain.on('nav:select-folder', (_e, path: string) => {
    forwardToWebview('viewer', 'folder-selected', path)
  })

  ipcMain.on('nav:open-in-terminal', (_e, path: string) => {
    forwardToWebview('canvas', 'open-terminal', path)
  })

  ipcMain.on('nav:create-graph-tile', (_e, folderPath: string) => {
    forwardToWebview('canvas', 'create-graph-tile', folderPath)
  })

  ipcMain.on('viewer:run-in-terminal', (_e, command: string) => {
    forwardToWebview('terminal', 'run-in-terminal', command)
  })

  // Drag & drop between webviews
  let pendingDragPaths: string[] = []
  ipcMain.on('drag:set-paths', (_e, paths: string[]) => {
    pendingDragPaths = paths
    forwardToWebview('viewer', 'nav-drag-active', true)
  })
  ipcMain.on('drag:clear-paths', () => {
    pendingDragPaths = []
    forwardToWebview('viewer', 'nav-drag-active', false)
  })
  ipcMain.handle('drag:get-paths', () => {
    const paths = pendingDragPaths
    pendingDragPaths = []
    return paths
  })
}
