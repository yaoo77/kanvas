import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import CmuxToolbar from '../../components/CmuxToolbar'

declare global {
  interface Window {
    api: {
      ptyCreate: (cwd?: string, cols?: number, rows?: number) => Promise<{ sessionId: string }>
      ptyWrite: (id: string, data: string) => Promise<void>
      ptyResize: (id: string, cols: number, rows: number) => Promise<void>
      ptyKill: (id: string) => Promise<void>
      ptyReconnect: (id: string, cols: number, rows: number) => Promise<void>
      onPtyData: (cb: (payload: { sessionId: string; data: string }) => void) => void
      offPtyData: (cb: (payload: { sessionId: string; data: string }) => void) => void
      onPtyExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) => void
      offPtyExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) => void
      notifyPtySessionId: (id: string) => void
      cmuxExec: (args: string[]) => Promise<{ ok: boolean; output?: string; error?: string }>
      onCmuxWrite: (cb: (text: string) => void) => void
      offCmuxWrite: (cb: (text: string) => void) => void
      getConfig: () => Promise<{ workspacePath?: string }>
    }
  }
}

function isURL(text: string): boolean {
  return /^https?:\/\//i.test(text) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(text)
}

function CommandInput({ onSend }: { onSend: (text: string) => void }) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const text = value.trim()
    if (!text) return

    // If it looks like a URL, open in browser tile
    if (isURL(text)) {
      const url = text.startsWith('http') ? text : 'https://' + text
      window.api.cmuxExec(['new-pane', '--type', 'browser', '--url', url])
      setValue('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }

    // If it's a local HTML file path, open in preview tile
    if (text.endsWith('.html') || text.endsWith('.htm')) {
      window.api.cmuxExec(['preview', text])
      setValue('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }

    onSend(text + '\r')
    setValue('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-end', minHeight: 38,
        background: '#1a1a1a', borderTop: '1px solid #333',
        padding: '6px 10px', gap: 6, flexShrink: 0,
      }}
      onPointerDown={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
    >
      <span style={{ fontSize: 14, color: '#555', userSelect: 'none', lineHeight: '26px' }}>{'>'}</span>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={e => { setValue(e.target.value); autoResize(e.target) }}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
          if (e.key === 'Escape') { setValue(''); textareaRef.current?.blur(); if (textareaRef.current) textareaRef.current.style.height = 'auto' }
          e.stopPropagation()
        }}
        placeholder="Send command... (Shift+Enter for newline)"
        rows={1}
        style={{
          flex: 1, background: 'transparent', border: 'none', outline: 'none',
          color: '#e0e0e0', fontSize: 14, padding: '2px 0',
          fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
          resize: 'none', lineHeight: '22px', overflow: 'hidden',
        }}
      />
      <button
        onClick={submit}
        style={{
          background: '#333', border: 'none', color: '#888', borderRadius: 4,
          padding: '4px 12px', fontSize: 12, cursor: 'pointer', marginBottom: 1,
        }}
        onMouseEnter={e => { (e.target as HTMLElement).style.color = '#ccc' }}
        onMouseLeave={e => { (e.target as HTMLElement).style.color = '#888' }}
      >
        Run
      </button>
    </div>
  )
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'exited'>('connecting')

  useEffect(() => {
    if (!containerRef.current) return

    const container = containerRef.current
    const params = new URLSearchParams(window.location.search)
    const cwd = params.get('cwd') ?? undefined

    let sessionId: string | null = null
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let inputDisposable: { dispose: () => void } | null = null
    let resizeDisposable: { dispose: () => void } | null = null
    let resizeObserver: ResizeObserver | null = null
    const pendingData: string[] = []

    const onCmuxWrite = (text: string) => {
      if (sessionId) window.api.ptyWrite(sessionId, text)
    }
    window.api.onCmuxWrite(onCmuxWrite)

    // 1. Estimate terminal size from container before PTY creation
    const charW = 7.8  // approximate char width at 13px SF Mono
    const charH = 17   // approximate char height
    const toolbarH = 28 + 38  // CmuxToolbar + CommandInput
    const estCols = Math.max(20, Math.floor(container.clientWidth / charW))
    const estRows = Math.max(5, Math.floor((container.clientHeight - toolbarH) / charH))

    window.api.ptyCreate(cwd ? cwd : undefined, estCols, estRows).then((result) => {
      const id = result.sessionId
      sessionId = id
      sessionIdRef.current = id
      window.api.notifyPtySessionId(id)

      // 2. Open terminal
      term = new Terminal({
        theme: {
          background: '#121212',
          foreground: '#e0e0e0',
          cursor: '#e0e0e0',
          selectionBackground: '#4a9eff44',
        },
        fontSize: 13,
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        cursorBlink: true,
        scrollback: 10000,
        overviewRuler: { width: 0 },
      })
      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(container)
      fitAddon.fit()

      termRef.current = term
      fitAddonRef.current = fitAddon

      // 3. Connect data listener and resize PTY
      const onData = (payload: { sessionId: string; data: string }) => {
        if (payload.sessionId === id && term) term.write(payload.data)
      }
      const onExit = (payload: { sessionId: string; exitCode: number }) => {
        if (payload.sessionId === id && term) {
          term.write(`\r\n[Process exited with code ${payload.exitCode}]\r\n`)
          setStatus('exited')
        }
      }
      window.api.onPtyData(onData)
      window.api.onPtyExit(onExit)
      ;(container as any).__cleanupPty = () => {
        window.api.offPtyData(onData)
        window.api.offPtyExit(onExit)
      }

      window.api.ptyResize(id, term.cols, term.rows)
      setStatus('connected')

      inputDisposable = term.onData((data) => {
        window.api.ptyWrite(id, data)
      })
      resizeDisposable = term.onResize(({ cols, rows }) => {
        window.api.ptyResize(id, cols, rows)
      })
      resizeObserver = new ResizeObserver(() => {
        fitAddon?.fit()
      })
      resizeObserver.observe(container)
    })

    return () => {
      ;(container as any).__cleanupPty?.()
      window.api.offCmuxWrite(onCmuxWrite)
      inputDisposable?.dispose()
      resizeDisposable?.dispose()
      resizeObserver?.disconnect()
      if (sessionId) window.api.ptyKill(sessionId)
      term?.dispose()
    }
  }, [])

  const handleSendCommand = useCallback((text: string) => {
    const sid = sessionIdRef.current
    if (sid) window.api.ptyWrite(sid, text)
  }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <CmuxToolbar />
      {status === 'connecting' && (
        <div style={{ padding: 8, fontSize: 12, color: '#888' }}>Connecting...</div>
      )}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
      {status === 'connected' && <CommandInput onSend={handleSendCommand} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
