import { ipcMain, webContents } from 'electron'
import { forwardToShell } from '../index'

/**
 * cmux command router — all commands are handled internally by kawase.
 * No external cmux binary dependency.
 *
 * Commands map to kawase's canvas tile system:
 *   new-split <dir>     → create adjacent terminal tile
 *   new-workspace       → trigger workspace add dialog
 *   new-pane --type X   → create tile of type X
 *   send <text>         → write to focused terminal PTY
 *   send-key <key>      → send key to focused terminal PTY
 *   sidebar-state       → return workspace/notification info
 *   markdown open <path>→ open file in viewer tile
 *   read-screen         → read terminal buffer text
 */

interface CmuxResult {
  ok: boolean
  output?: string
  error?: string
}

function success(output = ''): CmuxResult {
  return { ok: true, output }
}

function fail(error: string): CmuxResult {
  return { ok: false, error }
}

export function registerCmuxHandlers(): void {
  ipcMain.handle('cmux:exec', async (_e, args: string[]): Promise<CmuxResult> => {
    if (!args.length) return fail('No command')

    const cmd = args[0]
    const rest = args.slice(1)

    switch (cmd) {
      case 'new-split': {
        const direction = rest[0] || 'right'
        if (!['left', 'right', 'up', 'down'].includes(direction)) {
          return fail(`Invalid split direction: ${direction}`)
        }
        forwardToShell('cmux:split', direction)
        return success(`Split ${direction}`)
      }

      case 'new-workspace': {
        forwardToShell('cmux:new-workspace')
        return success('Workspace dialog opened')
      }

      case 'new-pane': {
        const typeIdx = rest.indexOf('--type')
        const paneType = typeIdx >= 0 ? rest[typeIdx + 1] : 'terminal'
        const urlIdx = rest.indexOf('--url')
        const url = urlIdx >= 0 ? rest[urlIdx + 1] : undefined
        if (paneType === 'browser' && url) {
          forwardToShell('cmux:new-pane-with-url', url)
        } else {
          forwardToShell('cmux:new-pane', paneType)
        }
        return success(`New ${paneType} pane`)
      }

      case 'send': {
        const text = rest.join(' ')
        if (!text) return fail('No text to send')
        forwardToShell('cmux:send-text', text)
        return success()
      }

      case 'send-key': {
        const key = rest[0]
        if (!key) return fail('No key specified')
        // Map key names to actual sequences
        const keyMap: Record<string, string> = {
          'Return': '\r', 'Enter': '\r',
          'Tab': '\t', 'Escape': '\x1b',
          'Up': '\x1b[A', 'Down': '\x1b[B',
          'Right': '\x1b[C', 'Left': '\x1b[D',
          'Backspace': '\x7f',
          'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-z': '\x1a',
        }
        const seq = keyMap[key] || key
        forwardToShell('cmux:send-text', seq)
        return success()
      }

      case 'preview': {
        const filePath = rest.join(' ')
        if (!filePath) return fail('No file path')
        forwardToShell('cmux:open-file', filePath)
        return success(`Preview: ${filePath}`)
      }

      case 'markdown': {
        if (rest[0] === 'open' && rest[1]) {
          forwardToShell('cmux:open-file', rest[1])
          return success(`Opening ${rest[1]}`)
        }
        return fail('Usage: markdown open <path>')
      }

      case 'fullscreen': {
        forwardToShell('cmux:fullscreen')
        return success('Fullscreen toggled')
      }

      case 'sidebar-state': {
        // Return internal state instead of calling external binary
        forwardToShell('cmux:get-state')
        return success('status: ready')
      }

      case 'read-screen': {
        forwardToShell('cmux:read-screen')
        return success()
      }

      default:
        return fail(`Unknown command: ${cmd}`)
    }
  })

  // Legacy shellExec — route through same internal handler
  ipcMain.handle('shell:exec', async (_e, command: string) => {
    const parts = command.trim().split(/\s+/)
    const result = await ipcMain.emit('cmux:exec', _e, parts)
    return ''
  })
}
