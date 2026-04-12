import { ipcMain, webContents } from 'electron'
import { spawn, IPty } from 'node-pty'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync } from 'fs'

interface PtySession {
  pty: IPty
  sessionId: string
  webContentsId: number
  scrollback: string[]        // Phase 5-13: ring buffer of raw pty output
  scrollbackBytes: number
}

const MAX_SCROLLBACK_BYTES = 512 * 1024  // 512KB per session
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

    // Resolve kanvas CLI bin directory (from packages/kanvas-cli/bin)
    const kanvasCliBin = join(__dirname, '../../packages/kanvas-cli/bin')

    // Auto-install SKILL.md for Claude Code discovery
    const skillDir = join(cwd, '.claude', 'skills')
    const skillDst = join(skillDir, 'kanvas.md')
    const skillSrc = join(__dirname, '../../packages/kanvas-cli/SKILL.md')
    try {
      if (existsSync(skillSrc) && !existsSync(skillDst)) {
        if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true })
        const { copyFileSync } = require('fs')
        copyFileSync(skillSrc, skillDst)
      }
    } catch {}

    // Create kanvas bin directory with custom `open` wrapper for URLs
    const kanvasBin = join(kanvasZshDir, 'bin')
    if (!existsSync(kanvasBin)) mkdirSync(kanvasBin, { recursive: true })

    // Custom `open` that intercepts URLs → kanvas browser tile, passes rest to real open
    const openWrapper = join(kanvasBin, 'open')
    writeFileSync(openWrapper, [
      '#!/bin/bash',
      '# kanvas: intercept URLs to open in internal browser',
      'for arg in "$@"; do',
      '  if [[ "$arg" =~ ^https?:// ]]; then',
      '    printf "\\033]7;kanvas-open:%s\\033\\\\" "$arg"',
      '    exit 0',
      '  fi',
      'done',
      '/usr/bin/open "$@"',
    ].join('\n'), { mode: 0o755 })

    // BROWSER env var also points to kanvas opener
    const browserScript = join(kanvasBin, 'kanvas-browser')
    writeFileSync(browserScript, [
      '#!/bin/bash',
      'printf "\\033]7;kanvas-open:%s\\033\\\\" "$1"',
    ].join('\n'), { mode: 0o755 })

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
        BROWSER: browserScript,
        PATH: kanvasCliBin + ':' + kanvasBin + ':' + (process.env.PATH || ''),
        KANVAS_SOCKET: join(homedir(), '.kanvas', 'cli.sock'),
      } as Record<string, string>
    })

    const session: PtySession = { pty, sessionId, webContentsId, scrollback: [], scrollbackBytes: 0 }
    sessions.set(sessionId, session)

    pty.onData((data) => {
      // Phase 5-13: record scrollback
      session.scrollback.push(data)
      session.scrollbackBytes += data.length
      // Trim from front if over limit
      while (session.scrollbackBytes > MAX_SCROLLBACK_BYTES && session.scrollback.length > 1) {
        const removed = session.scrollback.shift()!
        session.scrollbackBytes -= removed.length
      }

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

  // Phase 5-13: get scrollback buffer for a session (for re-hydration after webview reload)
  ipcMain.handle('pty:get-scrollback', (_e, { sessionId }: { sessionId: string }) => {
    const s = sessions.get(sessionId)
    if (!s) return null
    return s.scrollback.join('')
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

// Phase 5-13: save all scrollback buffers to disk before quit
export function saveAllScrollback(): void {
  const sessionsDir = join(homedir(), '.kawase', 'sessions')
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true })
  for (const [id, session] of sessions) {
    try {
      const data = session.scrollback.join('')
      if (data.length > 0) {
        writeFileSync(join(sessionsDir, `${id}.scrollback`), data)
      }
    } catch {}
  }
}

// Phase 5-13: load scrollback from disk for a session ID
export function loadScrollback(sessionId: string): string | null {
  const fp = join(homedir(), '.kawase', 'sessions', `${sessionId}.scrollback`)
  try {
    if (existsSync(fp)) {
      const { readFileSync } = require('fs')
      return readFileSync(fp, 'utf-8')
    }
  } catch {}
  return null
}
