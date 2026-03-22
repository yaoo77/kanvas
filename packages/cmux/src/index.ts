/**
 * @kawase/cmux - CLI wrapper for cmux commands.
 * Used by the main process cmux IPC handler.
 */

export interface CmuxCommand {
  name: string
  args: string[]
  description: string
}

/**
 * All cmux commands used by the toolbar.
 */
export const CMUX_COMMANDS = {
  splitLeft: { name: 'new-split', args: ['left'], description: 'Split pane left' },
  splitRight: { name: 'new-split', args: ['right'], description: 'Split pane right' },
  splitUp: { name: 'new-split', args: ['up'], description: 'Split pane up' },
  splitDown: { name: 'new-split', args: ['down'], description: 'Split pane down' },
  newWorkspace: { name: 'new-workspace', args: [], description: 'Create new workspace' },
  newBrowser: { name: 'new-pane', args: ['--type', 'browser'], description: 'Open browser pane' },
  markdownOpen: (path: string) => ({
    name: 'markdown',
    args: ['open', path],
    description: `Open markdown: ${path}`
  }),
  send: (text: string) => ({
    name: 'send',
    args: [text],
    description: `Send command: ${text}`
  }),
  sendKey: (key: string) => ({
    name: 'send-key',
    args: [key],
    description: `Send key: ${key}`
  }),
  sidebarState: { name: 'sidebar-state', args: [], description: 'Get sidebar status' }
} as const

/**
 * Build a flat args array for execFile from a command.
 */
export function buildArgs(cmd: CmuxCommand | { name: string; args: string[] }): string[] {
  return [cmd.name, ...cmd.args]
}
