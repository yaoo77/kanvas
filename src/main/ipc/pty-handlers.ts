import { ipcMain, webContents } from 'electron'
import { spawn, IPty } from 'node-pty'
import { homedir } from 'os'

interface PtySession {
  pty: IPty
  sessionId: string
  webContentsId: number
}

const sessions = new Map<string, PtySession>()
let nextId = 1

function defaultShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

export function registerPtyHandlers(): void {
  ipcMain.handle('pty:create', (_event, params?: { cwd?: string; cols?: number; rows?: number }) => {
    const sessionId = `pty-${nextId++}`
    const cwd = params?.cwd || homedir()
    const cols = params?.cols || 80
    const rows = params?.rows || 24
    const webContentsId = _event.sender.id

    const shell = defaultShell()
    const shellArgs = shell.endsWith('zsh') ? ['-o', 'NO_PROMPT_SP'] : []
    const pty = spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PROMPT_EOL_MARK: ''
      } as Record<string, string>
    })

    const session: PtySession = { pty, sessionId, webContentsId }
    sessions.set(sessionId, session)

    pty.onData((data) => {
      try {
        const wc = webContents.fromId(webContentsId)
        wc?.send('pty:data', { sessionId, data })
      } catch {
        // webcontents may be destroyed
      }
    })

    pty.onExit(({ exitCode }) => {
      try {
        const wc = webContents.fromId(webContentsId)
        wc?.send('pty:exit', { sessionId, exitCode })
      } catch {
        // ignore
      }
      sessions.delete(sessionId)
    })

    return { sessionId }
  })

  ipcMain.handle('pty:write', (_e, { sessionId, data }: { sessionId: string; data: string }) => {
    const s = sessions.get(sessionId)
    if (s) s.pty.write(data)
  })

  ipcMain.handle('pty:send-raw-keys', (_e, { sessionId, data }: { sessionId: string; data: string }) => {
    const s = sessions.get(sessionId)
    if (s) s.pty.write(data)
  })

  ipcMain.handle('pty:resize', (_e, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
    const s = sessions.get(sessionId)
    if (s) s.pty.resize(cols, rows)
  })

  ipcMain.handle('pty:kill', (_e, { sessionId }: { sessionId: string }) => {
    const s = sessions.get(sessionId)
    if (s) {
      s.pty.kill()
      sessions.delete(sessionId)
    }
  })

  ipcMain.handle('pty:reconnect', (_e, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
    const s = sessions.get(sessionId)
    if (s) {
      s.pty.resize(cols, rows)
      return { ok: true }
    }
    return { ok: false }
  })

  ipcMain.handle('pty:discover', () => {
    return Array.from(sessions.keys())
  })
}

export function killAllSessions(): void {
  for (const [id, session] of sessions) {
    try {
      session.pty.kill()
    } catch {
      // ignore
    }
    sessions.delete(id)
  }
}
