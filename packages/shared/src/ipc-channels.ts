/**
 * All IPC channel names used between main ↔ renderer.
 * Using a const enum for tree-shaking and type safety.
 */

// Config
export const IPC_CONFIG_GET = 'config:get'
export const IPC_APP_VERSION = 'app:version'
export const IPC_PREF_GET = 'pref:get'
export const IPC_PREF_SET = 'pref:set'

// Shell
export const IPC_SHELL_VIEW_CONFIG = 'shell:get-view-config'
export const IPC_SHELL_WORKSPACE_PATH = 'shell:get-workspace-path'
export const IPC_SHELL_LOADING_DONE = 'shell:loading-done'
export const IPC_SHELL_FORWARD = 'shell:forward'
export const IPC_SHELL_SETTINGS = 'shell:settings'
export const IPC_SHELL_SHORTCUT = 'shell:shortcut'
export const IPC_SHELL_OPEN_EXTERNAL = 'shell:open-external'

// File system
export const IPC_FS_READDIR = 'fs:readdir'
export const IPC_FS_READFILE = 'fs:readfile'
export const IPC_FS_WRITEFILE = 'fs:writefile'
export const IPC_FS_STAT = 'fs:stat'
export const IPC_FS_TRASH = 'fs:trash'
export const IPC_FS_MKDIR = 'fs:mkdir'
export const IPC_FS_MOVE = 'fs:move'
export const IPC_FS_RENAME = 'fs:rename'
export const IPC_FS_COUNT_FILES = 'fs:count-files'
export const IPC_FS_READ_FOLDER_TABLE = 'fs:read-folder-table'

// Navigation
export const IPC_NAV_SELECT_FILE = 'nav:select-file'
export const IPC_NAV_SELECT_FOLDER = 'nav:select-folder'
export const IPC_NAV_OPEN_IN_TERMINAL = 'nav:open-in-terminal'
export const IPC_NAV_CREATE_GRAPH_TILE = 'nav:create-graph-tile'

// Viewer
export const IPC_VIEWER_RUN_IN_TERMINAL = 'viewer:run-in-terminal'

// PTY
export const IPC_PTY_CREATE = 'pty:create'
export const IPC_PTY_WRITE = 'pty:write'
export const IPC_PTY_SEND_RAW_KEYS = 'pty:send-raw-keys'
export const IPC_PTY_RESIZE = 'pty:resize'
export const IPC_PTY_KILL = 'pty:kill'
export const IPC_PTY_RECONNECT = 'pty:reconnect'
export const IPC_PTY_DISCOVER = 'pty:discover'
export const IPC_PTY_DATA = 'pty:data'
export const IPC_PTY_EXIT = 'pty:exit'

// cmux
export const IPC_CMUX_EXEC = 'cmux:exec'
export const IPC_SHELL_EXEC = 'shell:exec' // legacy

// Workspace
export const IPC_WORKSPACE_LIST = 'workspace:list'
export const IPC_WORKSPACE_ADD = 'workspace:add'
export const IPC_WORKSPACE_REMOVE = 'workspace:remove'
export const IPC_WORKSPACE_SWITCH = 'workspace:switch'
export const IPC_WORKSPACE_READ_TREE = 'workspace:read-tree'
export const IPC_WORKSPACE_GET_GRAPH = 'workspace:get-graph'

// Dialogs
export const IPC_DIALOG_OPEN_FOLDER = 'dialog:open-folder'
export const IPC_DIALOG_OPEN_IMAGE = 'dialog:open-image'
export const IPC_DIALOG_CONFIRM = 'dialog:confirm'
export const IPC_CONTEXT_MENU_SHOW = 'context-menu:show'

// Drag
export const IPC_DRAG_SET_PATHS = 'drag:set-paths'
export const IPC_DRAG_CLEAR_PATHS = 'drag:clear-paths'
export const IPC_DRAG_GET_PATHS = 'drag:get-paths'

// Canvas
export const IPC_CANVAS_LOAD_STATE = 'canvas:load-state'
export const IPC_CANVAS_SAVE_STATE = 'canvas:save-state'
export const IPC_CANVAS_FORWARD_PINCH = 'canvas:forward-pinch'
