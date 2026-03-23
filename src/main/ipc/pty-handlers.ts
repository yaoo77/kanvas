import { ipcMain, webContents } from 'electron'
import { spawn, IPty } from 'node-pty'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync } from 'fs'

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

    // Create a custom ZDOTDIR with .zshenv that disables PROMPT_SP
    // This runs BEFORE .zshrc so it can't be overridden
    const kanvasZshDir = join(homedir(), '.kawase', 'zsh')
    if (!existsSync(kanvasZshDir)) mkdirSync(kanvasZshDir, { recursive: true })
    const home = homedir()
    // .zshenv: source real .zshenv
    writeFileSync(join(kanvasZshDir, '.zshenv'), [
      `[ -f "${home}/.zshenv" ] && source "${home}/.zshenv"`,
    ].join('\n'))
    // .zshrc: source real .zshrc, THEN disable PROMPT_SP
    writeFileSync(join(kanvasZshDir, '.zshrc'), [
      `[ -f "${home}/.zshrc" ] && source "${home}/.zshrc"`,
      'unsetopt PROMPT_SP 2>/dev/null',
      'export PROMPT_EOL_MARK=""',
    ].join('\n'))

    const pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ZDOTDIR: kanvasZshDir,
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
