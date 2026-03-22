import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

declare global {
  interface Window {
    api: {
      ptyCreate: (cwd?: string) => Promise<{ sessionId: string }>
      ptyWrite: (id: string, data: string) => Promise<void>
      ptyResize: (id: string, cols: number, rows: number) => Promise<void>
      ptyKill: (id: string) => Promise<void>
      ptyReconnect: (id: string, cols: number, rows: number) => Promise<void>
      onPtyData: (cb: (payload: { sessionId: string; data: string }) => void) => void
      offPtyData: (cb: (payload: { sessionId: string; data: string }) => void) => void
      onPtyExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) => void
      offPtyExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) => void
      notifyPtySessionId: (id: string) => void
      onCdTo: (cb: (path: string) => void) => void
      offCdTo: (cb: (path: string) => void) => void
      onRunInTerminal: (cb: (cmd: string) => void) => void
      offRunInTerminal: (cb: (cmd: string) => void) => void
      getConfig: () => Promise<{ workspacePath?: string }>
    }
  }
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'exited'>('connecting')

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: {
        background: '#121212',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#4a9eff44',
      },
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      cursorBlink: true,
      allowProposedApi: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    const params = new URLSearchParams(window.location.search)
    const cwd = params.get('cwd') ?? undefined

    let sessionId: string | null = null

    const onData = (payload: { sessionId: string; data: string }) => {
      if (payload.sessionId === sessionId) {
        term.write(payload.data)
      }
    }
    const onExit = (payload: { sessionId: string; exitCode: number }) => {
      if (payload.sessionId === sessionId) {
        term.write(`\r\n[Process exited with code ${payload.exitCode}]\r\n`)
        setStatus('exited')
      }
    }

    window.api.onPtyData(onData)
    window.api.onPtyExit(onExit)

    window.api.ptyCreate(cwd).then((result) => {
      const id = result.sessionId
      sessionId = id
      sessionIdRef.current = id
      setStatus('connected')
      window.api.notifyPtySessionId(id)
      window.api.ptyResize(id, term.cols, term.rows)
    })

    const inputDisposable = term.onData((data) => {
      if (sessionId) window.api.ptyWrite(sessionId, data)
    })

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (sessionId) window.api.ptyResize(sessionId, cols, rows)
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
    })
    resizeObserver.observe(containerRef.current)

    // Handle cd-to from nav
    const onCdTo = (path: string) => {
      if (sessionId) {
        window.api.ptyWrite(sessionId, `cd ${JSON.stringify(path)}\n`)
      }
    }
    const onRunInTerminal = (cmd: string) => {
      if (sessionId) {
        window.api.ptyWrite(sessionId, cmd + '\n')
      }
    }
    window.api.onCdTo(onCdTo)
    window.api.onRunInTerminal(onRunInTerminal)

    return () => {
      window.api.offPtyData(onData)
      window.api.offPtyExit(onExit)
      window.api.offCdTo(onCdTo)
      window.api.offRunInTerminal(onRunInTerminal)
      inputDisposable.dispose()
      resizeDisposable.dispose()
      resizeObserver.disconnect()
      if (sessionId) window.api.ptyKill(sessionId)
      term.dispose()
    }
  }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {status === 'connecting' && (
        <div style={{ padding: 8, fontSize: 12, color: '#888' }}>Connecting...</div>
      )}
      <div ref={containerRef} style={{ flex: 1 }} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
