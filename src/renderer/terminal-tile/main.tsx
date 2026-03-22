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

/* ── Tab types ── */

interface SplitState {
  direction: 'horizontal' | 'vertical'
  secondSessionId: string | null
  secondStatus: 'connecting' | 'connected' | 'exited'
  sizes: [number, number]  // percentage for each pane
}

interface TabInfo {
  id: string
  sessionId: string | null
  title: string
  status: 'connecting' | 'connected' | 'exited'
  split: SplitState | null
  focusedPane: 'primary' | 'secondary'  // which pane receives command input
}

let tabCounter = 0
function createTabId(): string {
  return `tab-${++tabCounter}-${Date.now()}`
}

/* ── Per-tab terminal session ── */

interface TerminalSessionProps {
  tab: TabInfo
  visible: boolean
  cwd: string | undefined
  onSessionReady: (tabId: string, sessionId: string) => void
  onStatusChange: (tabId: string, status: TabInfo['status']) => void
  onTitleChange: (tabId: string, title: string) => void
}

function TerminalSession({ tab, visible, cwd, onSessionReady, onStatusChange, onTitleChange }: TerminalSessionProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return
    initializedRef.current = true

    const container = containerRef.current

    let sessionId: string | null = null
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let inputDisposable: { dispose: () => void } | null = null
    let resizeDisposable: { dispose: () => void } | null = null
    let titleDisposable: { dispose: () => void } | null = null
    let resizeObserver: ResizeObserver | null = null

    // 1. Estimate terminal size from container before PTY creation
    const charW = 7.8  // approximate char width at 13px SF Mono
    const charH = 17   // approximate char height
    const toolbarH = 28 + 26 + 38  // CmuxToolbar + TabBar + CommandInput
    const estCols = Math.max(20, Math.floor(container.clientWidth / charW))
    const estRows = Math.max(5, Math.floor((container.clientHeight - toolbarH) / charH))

    window.api.ptyCreate(cwd ? cwd : undefined, estCols, estRows).then((result) => {
      const id = result.sessionId
      sessionId = id
      sessionIdRef.current = id
      onSessionReady(tab.id, id)
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
          onStatusChange(tab.id, 'exited')
        }
      }
      window.api.onPtyData(onData)
      window.api.onPtyExit(onExit)
      ;(container as any).__cleanupPty = () => {
        window.api.offPtyData(onData)
        window.api.offPtyExit(onExit)
      }

      window.api.ptyResize(id, term.cols, term.rows)
      onStatusChange(tab.id, 'connected')

      inputDisposable = term.onData((data) => {
        window.api.ptyWrite(id, data)
      })
      resizeDisposable = term.onResize(({ cols, rows }) => {
        window.api.ptyResize(id, cols, rows)
      })

      // Track title changes from terminal escape sequences
      titleDisposable = term.onTitleChange((title) => {
        if (title) onTitleChange(tab.id, title)
      })

      resizeObserver = new ResizeObserver(() => {
        fitAddon?.fit()
      })
      resizeObserver.observe(container)
    })

    return () => {
      ;(container as any).__cleanupPty?.()
      inputDisposable?.dispose()
      resizeDisposable?.dispose()
      titleDisposable?.dispose()
      resizeObserver?.disconnect()
      if (sessionId) window.api.ptyKill(sessionId)
      term?.dispose()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when becoming visible
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      // Small delay to ensure container is measured
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit()
      })
    }
  }, [visible])

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        display: visible ? 'block' : 'none',
      }}
    />
  )
}

/* ── Split Resize Handle ── */

function SplitResizeHandle({
  direction,
  onResize,
}: {
  direction: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
}) {
  const dragging = useRef(false)
  const lastPos = useRef(0)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    lastPos.current = direction === 'vertical' ? e.clientX : e.clientY
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [direction])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const pos = direction === 'vertical' ? e.clientX : e.clientY
    const delta = pos - lastPos.current
    lastPos.current = pos
    onResize(delta)
  }, [direction, onResize])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }, [])

  const isVert = direction === 'vertical'

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        flexShrink: 0,
        width: isVert ? 4 : '100%',
        height: isVert ? '100%' : 4,
        cursor: isVert ? 'col-resize' : 'row-resize',
        background: 'transparent',
        position: 'relative',
        zIndex: 10,
      }}
    >
      {/* Visible line */}
      <div
        style={{
          position: 'absolute',
          ...(isVert
            ? { top: 0, bottom: 0, left: 1, width: 2 }
            : { left: 0, right: 0, top: 1, height: 2 }),
          background: '#333',
          borderRadius: 1,
        }}
      />
    </div>
  )
}

/* ── Main App ── */

function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const tabsRef = useRef<TabInfo[]>([])
  const cwdRef = useRef<string | undefined>(undefined)

  // Keep ref in sync
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  // Read cwd from URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    cwdRef.current = params.get('cwd') ?? undefined
  }, [])

  // Create first tab on mount
  useEffect(() => {
    addTab()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // cmuxWrite forwards to the active tab's focused pane PTY
  useEffect(() => {
    const onCmuxWrite = (text: string) => {
      const active = tabsRef.current.find(t => t.id === activeTabId)
      if (!active) return
      if (active.split && active.focusedPane === 'secondary') {
        if (active.split.secondSessionId) {
          window.api.ptyWrite(active.split.secondSessionId, text)
        }
      } else {
        if (active.sessionId) {
          window.api.ptyWrite(active.sessionId, text)
        }
      }
    }
    window.api.onCmuxWrite(onCmuxWrite)
    return () => {
      window.api.offCmuxWrite(onCmuxWrite)
    }
  }, [activeTabId])

  // Expose addTab globally for cmux:new-tab IPC
  useEffect(() => {
    const handler = () => addTab()
    ;(window as any).__kawaseNewTab = handler
    return () => {
      delete (window as any).__kawaseNewTab
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const addTab = useCallback(() => {
    const id = createTabId()
    const tabNum = tabsRef.current.length + 1
    const newTab: TabInfo = {
      id,
      sessionId: null,
      title: `Tab ${tabNum}`,
      status: 'connecting',
      split: null,
      focusedPane: 'primary',
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(id)
  }, [])

  const closeTab = useCallback((tabId: string) => {
    // Kill secondary split session if present
    const closing = tabsRef.current.find(t => t.id === tabId)
    if (closing?.split?.secondSessionId) {
      window.api.ptyKill(closing.split.secondSessionId)
    }
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId)
      if (idx === -1) return prev
      const next = prev.filter(t => t.id !== tabId)
      // If closing the active tab, switch to adjacent
      if (tabId === activeTabId && next.length > 0) {
        const newIdx = Math.min(idx, next.length - 1)
        setActiveTabId(next[newIdx].id)
      }
      // If no tabs left, create a new one
      if (next.length === 0) {
        // Defer to avoid state update conflict
        setTimeout(() => addTab(), 0)
      }
      return next
    })
  }, [activeTabId, addTab])

  const handleSessionReady = useCallback((tabId: string, sessionId: string) => {
    // Check if this is for a split secondary pane
    if (tabId.endsWith('__split')) {
      const realTabId = tabId.replace('__split', '')
      setTabs(prev => prev.map(t =>
        t.id === realTabId && t.split
          ? { ...t, split: { ...t.split, secondSessionId: sessionId } }
          : t
      ))
      return
    }
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, sessionId } : t))
    // Notify the first tab's session to main process
    if (tabsRef.current.length <= 1) {
      window.api.notifyPtySessionId(sessionId)
    }
  }, [])

  const handleStatusChange = useCallback((tabId: string, status: TabInfo['status']) => {
    // Check if this is for a split secondary pane
    if (tabId.endsWith('__split')) {
      const realTabId = tabId.replace('__split', '')
      setTabs(prev => prev.map(t =>
        t.id === realTabId && t.split
          ? { ...t, split: { ...t.split, secondStatus: status } }
          : t
      ))
      return
    }
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, status } : t))
  }, [])

  const handleTitleChange = useCallback((tabId: string, title: string) => {
    // Truncate to reasonable length for tab display
    const display = title.length > 20 ? title.slice(0, 20) + '...' : title
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, title: display } : t))
  }, [])

  const handleSendCommand = useCallback((text: string) => {
    const active = tabsRef.current.find(t => t.id === activeTabId)
    if (!active) return
    // Send to the focused pane's session
    if (active.split && active.focusedPane === 'secondary') {
      if (active.split.secondSessionId) {
        window.api.ptyWrite(active.split.secondSessionId, text)
      }
    } else {
      if (active.sessionId) {
        window.api.ptyWrite(active.sessionId, text)
      }
    }
  }, [activeTabId])

  const handleSplit = useCallback((direction: 'horizontal' | 'vertical') => {
    const active = tabsRef.current.find(t => t.id === activeTabId)
    if (!active || active.split) return  // Already split or no active tab

    // Create the split state - the secondary TerminalSession will create its own PTY
    setTabs(prev => prev.map(t =>
      t.id === activeTabId
        ? {
            ...t,
            split: {
              direction,
              secondSessionId: null,
              secondStatus: 'connecting' as const,
              sizes: [50, 50] as [number, number],
            },
            focusedPane: 'primary' as const,
          }
        : t
    ))
  }, [activeTabId])

  const handleUnsplit = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== tabId || !t.split) return t
      // Kill the secondary session
      if (t.split.secondSessionId) {
        window.api.ptyKill(t.split.secondSessionId)
      }
      return { ...t, split: null, focusedPane: 'primary' as const }
    }))
  }, [])

  const handleFocusPane = useCallback((tabId: string, pane: 'primary' | 'secondary') => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, focusedPane: pane } : t
    ))
  }, [])

  const handleSplitResize = useCallback((tabId: string, sizes: [number, number]) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId && t.split
        ? { ...t, split: { ...t.split, sizes } }
        : t
    ))
  }, [])

  const activeTab = tabs.find(t => t.id === activeTabId)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <CmuxToolbar onNewTab={addTab} onSplit={handleSplit} />

      {/* Tab Bar */}
      {tabs.length > 0 && (
        <div
          style={{
            display: 'flex',
            height: 26,
            background: '#1a1a1a',
            borderBottom: '1px solid #333',
            overflow: 'auto',
            flexShrink: 0,
          }}
          onPointerDown={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
        >
          {tabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              style={{
                padding: '0 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12,
                color: tab.id === activeTabId ? '#e0e0e0' : '#888',
                cursor: 'pointer',
                borderBottom: tab.id === activeTabId ? '2px solid #4a9eff' : '2px solid transparent',
                background: tab.id === activeTabId ? '#252525' : 'transparent',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {tab.split && (
                <span style={{ fontSize: 9, color: '#4a9eff', marginRight: 2 }}>
                  {tab.split.direction === 'vertical' ? '||' : '='}
                </span>
              )}
              <span>{tab.title}</span>
              {tab.status === 'exited' && (
                <span style={{ fontSize: 9, color: '#f44', marginLeft: 2 }}>exited</span>
              )}
              {tab.split && tab.id === activeTabId && (
                <span
                  onClick={(e) => { e.stopPropagation(); handleUnsplit(tab.id) }}
                  title="Close split"
                  style={{
                    marginLeft: 2,
                    fontSize: 9,
                    color: '#4a9eff88',
                    cursor: 'pointer',
                    lineHeight: 1,
                    padding: '0 2px',
                  }}
                  onMouseEnter={e => { (e.target as HTMLElement).style.color = '#4a9eff' }}
                  onMouseLeave={e => { (e.target as HTMLElement).style.color = '#4a9eff88' }}
                >
                  unsplit
                </span>
              )}
              {tabs.length > 1 && (
                <span
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                  style={{
                    marginLeft: 4,
                    fontSize: 10,
                    color: '#666',
                    cursor: 'pointer',
                    lineHeight: 1,
                    padding: '0 2px',
                    borderRadius: 2,
                  }}
                  onMouseEnter={e => { (e.target as HTMLElement).style.color = '#e0e0e0' }}
                  onMouseLeave={e => { (e.target as HTMLElement).style.color = '#666' }}
                >
                  x
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Terminal area */}
      {activeTab?.status === 'connecting' && !activeTab.split && (
        <div style={{ padding: 8, fontSize: 12, color: '#888' }}>Connecting...</div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTabId
          const split = tab.split
          const isVert = split?.direction === 'vertical'

          return (
            <div
              key={tab.id}
              data-split-container={tab.id}
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                display: isActive ? 'flex' : 'none',
                flexDirection: split ? (isVert ? 'row' : 'column') : 'column',
              }}
            >
              {/* Primary pane - always rendered with stable key */}
              <div
                onClick={split ? () => handleFocusPane(tab.id, 'primary') : undefined}
                style={{
                  ...(split
                    ? {
                        [isVert ? 'width' : 'height']: `calc(${split.sizes[0]}% - 2px)`,
                        outline: tab.focusedPane === 'primary' ? '1px solid #4a9eff55' : 'none',
                        outlineOffset: -1,
                      }
                    : {}),
                  flex: split ? undefined : 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <TerminalSession
                  tab={tab}
                  visible={isActive}
                  cwd={cwdRef.current}
                  onSessionReady={handleSessionReady}
                  onStatusChange={handleStatusChange}
                  onTitleChange={handleTitleChange}
                />
              </div>

              {/* Resize handle + secondary pane - only when split */}
              {split && (
                <>
                  <SplitResizeHandle
                    direction={split.direction}
                    onResize={(delta) => {
                      const container = document.querySelector(`[data-split-container="${tab.id}"]`) as HTMLElement | null
                      if (!container) return
                      const containerSize = isVert ? container.clientWidth : container.clientHeight
                      if (containerSize === 0) return
                      const pctDelta = (delta / containerSize) * 100
                      const newFirst = Math.max(20, Math.min(80, split.sizes[0] + pctDelta))
                      handleSplitResize(tab.id, [newFirst, 100 - newFirst])
                    }}
                  />
                  <div
                    onClick={() => handleFocusPane(tab.id, 'secondary')}
                    style={{
                      [isVert ? 'width' : 'height']: `calc(${split.sizes[1]}% - 2px)`,
                      minHeight: 0,
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      outline: tab.focusedPane === 'secondary' ? '1px solid #4a9eff55' : 'none',
                      outlineOffset: -1,
                    }}
                  >
                    <TerminalSession
                      tab={{
                        id: tab.id + '__split',
                        sessionId: split.secondSessionId,
                        title: '',
                        status: split.secondStatus,
                        split: null,
                        focusedPane: 'primary',
                      }}
                      visible={true}
                      cwd={cwdRef.current}
                      onSessionReady={(_, sid) => handleSessionReady(tab.id + '__split', sid)}
                      onStatusChange={(_, st) => handleStatusChange(tab.id + '__split', st)}
                      onTitleChange={() => {}}
                    />
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      {(activeTab?.status === 'connected' || (activeTab?.split && (activeTab.status === 'connected' || activeTab.split.secondStatus === 'connected'))) && (
        <CommandInput onSend={handleSendCommand} />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
