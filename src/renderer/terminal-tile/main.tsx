import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
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
    const maxH = 176 // ~8 lines at 22px line-height (cmux-style)
    const newH = Math.min(el.scrollHeight, maxH)
    el.style.height = newH + 'px'
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden'
  }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-end', minHeight: 38,
        background: '#121212', borderTop: '1px solid #333',
        padding: '6px 10px', gap: 6, flexShrink: 0,
        position: 'relative' as const, zIndex: 5,
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
          color: '#e0e0e0', fontSize: 14, padding: '4px 0',
          fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
          resize: 'none', lineHeight: '22px', overflow: 'hidden',
          maxHeight: 176,
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

/* ── Recursive Split Tree ── */

type SplitTree =
  | { type: 'terminal'; id: string; sessionId: string | null; status: 'connecting' | 'connected' | 'exited' }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; children: SplitTree[]; sizes: number[] }

/* ── Tab types ── */

interface TabInfo {
  id: string
  title: string
  tree: SplitTree
  focusedTermId: string  // which terminal leaf in the tree receives commands
}

let tabCounter = 0
function createTabId(): string {
  return `tab-${++tabCounter}-${Date.now()}`
}

let termCounter = 0
function createTermId(): string {
  return `term-${++termCounter}-${Date.now()}`
}

/* ── Tree helper functions ── */

/** Collect all terminal IDs in a tree */
function collectTermIds(tree: SplitTree): string[] {
  if (tree.type === 'terminal') return [tree.id]
  return tree.children.flatMap(collectTermIds)
}

/** Collect all session IDs in a tree (for cleanup) */
function collectSessionIds(tree: SplitTree): string[] {
  if (tree.type === 'terminal') return tree.sessionId ? [tree.sessionId] : []
  return tree.children.flatMap(collectSessionIds)
}

/** Find a terminal node by its ID */
function findTermNode(tree: SplitTree, termId: string): SplitTree | null {
  if (tree.type === 'terminal') return tree.id === termId ? tree : null
  for (const child of tree.children) {
    const found = findTermNode(child, termId)
    if (found) return found
  }
  return null
}

/** Check if any terminal in the tree has a given status */
function hasStatus(tree: SplitTree, status: 'connecting' | 'connected' | 'exited'): boolean {
  if (tree.type === 'terminal') return tree.status === status
  return tree.children.some(c => hasStatus(c, status))
}

/** Count the number of split nodes (for tab indicator) */
function countSplits(tree: SplitTree): number {
  if (tree.type === 'terminal') return 0
  return 1 + tree.children.reduce((sum, c) => sum + countSplits(c), 0)
}

/** Get the dominant split direction (for tab indicator) */
function getDominantDirection(tree: SplitTree): 'vertical' | 'horizontal' | null {
  if (tree.type === 'terminal') return null
  return tree.direction
}

/** Replace a terminal node in the tree with a new subtree (immutable) */
function replaceTermNode(tree: SplitTree, termId: string, replacement: SplitTree): SplitTree {
  if (tree.type === 'terminal') {
    return tree.id === termId ? replacement : tree
  }
  const newChildren = tree.children.map(c => replaceTermNode(c, termId, replacement))
  // Check if anything changed
  const changed = newChildren.some((c, i) => c !== tree.children[i])
  return changed ? { ...tree, children: newChildren } : tree
}

/** Update a terminal node's properties (immutable) */
function updateTermNode(
  tree: SplitTree,
  termId: string,
  updater: (node: Extract<SplitTree, { type: 'terminal' }>) => SplitTree
): SplitTree {
  if (tree.type === 'terminal') {
    return tree.id === termId ? updater(tree) : tree
  }
  const newChildren = tree.children.map(c => updateTermNode(c, termId, updater))
  const changed = newChildren.some((c, i) => c !== tree.children[i])
  return changed ? { ...tree, children: newChildren } : tree
}

/** Remove a terminal node from the tree, collapsing parent if needed (immutable).
 *  Returns the new tree, or null if the tree becomes empty. */
function removeTermNode(tree: SplitTree, termId: string): SplitTree | null {
  if (tree.type === 'terminal') {
    return tree.id === termId ? null : tree
  }
  const newChildren: SplitTree[] = []
  for (const child of tree.children) {
    const result = removeTermNode(child, termId)
    if (result !== null) newChildren.push(result)
  }
  if (newChildren.length === 0) return null
  if (newChildren.length === 1) return newChildren[0]
  // Recalculate sizes proportionally
  const oldIndices = newChildren.map((_, i) => {
    // Find the index in the original children
    return tree.children.indexOf(newChildren.length === tree.children.length ? tree.children[i] : tree.children.find(c => {
      const result = removeTermNode(c, termId)
      return result === newChildren[i]
    })!)
  })
  // Simpler approach: distribute sizes evenly among remaining children
  const totalSize = newChildren.length
  const sizes = newChildren.map(() => 100 / totalSize)
  return { ...tree, children: newChildren, sizes }
}

/** Update sizes for a specific split node that contains a child at a given path.
 *  We identify the split by its position in the tree using a path of child indices. */
function updateSplitSizes(tree: SplitTree, path: number[], sizes: number[]): SplitTree {
  if (tree.type === 'terminal') return tree
  if (path.length === 0) {
    return { ...tree, sizes }
  }
  const [head, ...rest] = path
  const newChildren = tree.children.map((c, i) =>
    i === head ? updateSplitSizes(c, rest, sizes) : c
  )
  return { ...tree, children: newChildren }
}

/* ── Session Registry: persists PTY sessions across React remounts ── */

interface RegistryEntry {
  sessionId: string
  term: Terminal
  fitAddon: FitAddon
  container: HTMLDivElement  // detached xterm container element
  resizeObserver: ResizeObserver
  cleanupPty: () => void
  inputDisposable: { dispose: () => void }
  resizeDisposable: { dispose: () => void }
  titleDisposable: { dispose: () => void }
}

const sessionRegistry = new Map<string, RegistryEntry>()

/** Explicitly destroy a session (call when closing a tab or pane) */
function destroyRegistryEntry(termId: string) {
  const entry = sessionRegistry.get(termId)
  if (!entry) return
  entry.cleanupPty()
  entry.inputDisposable.dispose()
  entry.resizeDisposable.dispose()
  entry.titleDisposable.dispose()
  entry.resizeObserver.disconnect()
  window.api.ptyKill(entry.sessionId)
  entry.term.dispose()
  sessionRegistry.delete(termId)
}

/* ── Per-terminal session component ── */

interface TerminalSessionProps {
  termId: string
  visible: boolean
  focused: boolean
  cwd: string | undefined
  onSessionReady: (termId: string, sessionId: string) => void
  onStatusChange: (termId: string, status: 'connecting' | 'connected' | 'exited') => void
  onTitleChange: (termId: string, title: string) => void
  onFocus: () => void
}

function TerminalSession({ termId, visible, focused, cwd, onSessionReady, onStatusChange, onTitleChange, onFocus }: TerminalSessionProps) {
  const placeholderRef = useRef<HTMLDivElement>(null)
  const attachedRef = useRef(false)

  // Attach or re-attach the registry's container div into the placeholder
  useEffect(() => {
    const placeholder = placeholderRef.current
    if (!placeholder) return

    const existing = sessionRegistry.get(termId)
    if (existing) {
      // Re-attach the existing xterm container into the new placeholder position
      placeholder.appendChild(existing.container)
      attachedRef.current = true
      // Re-fit after re-attach since layout may have changed
      requestAnimationFrame(() => {
        existing.fitAddon.fit()
      })
      return () => {
        // On unmount, detach the container but do NOT destroy the session
        if (existing.container.parentNode === placeholder) {
          placeholder.removeChild(existing.container)
        }
        attachedRef.current = false
      }
    }

    // No existing session -- create a new one
    const xtermContainer = document.createElement('div')
    xtermContainer.style.width = '100%'
    xtermContainer.style.height = '100%'
    placeholder.appendChild(xtermContainer)
    attachedRef.current = true

    // Estimate terminal size from placeholder before PTY creation
    const charW = 7.8
    const charH = 17
    const toolbarH = 28 + 26 + 38
    const estCols = Math.max(20, Math.floor(placeholder.clientWidth / charW))
    const estRows = Math.max(5, Math.floor((placeholder.clientHeight - toolbarH) / charH))

    let cancelled = false

    window.api.ptyCreate(cwd ? cwd : undefined, estCols, estRows).then((result) => {
      if (cancelled) {
        // Component unmounted before PTY was ready -- kill it immediately
        window.api.ptyKill(result.sessionId)
        return
      }

      const id = result.sessionId
      onSessionReady(termId, id)
      window.api.notifyPtySessionId(id)

      const term = new Terminal({
        theme: {
          background: '#121212',
          foreground: '#e0e0e0',
          cursor: '#121212',
          cursorAccent: '#121212',
          selectionBackground: '#3a3a3a',
          black: '#1a1a1a',
          red: '#f87171',
          green: '#6ee7b7',
          yellow: '#fbbf24',
          blue: '#60a5fa',
          magenta: '#c084fc',
          cyan: '#67e8f9',
          white: '#e0e0e0',
          brightBlack: '#666666',
          brightRed: '#fca5a5',
          brightGreen: '#86efac',
          brightYellow: '#fcd34d',
          brightBlue: '#93c5fd',
          brightMagenta: '#d8b4fe',
          brightCyan: '#a5f3fc',
          brightWhite: '#ffffff',
        },
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', monospace",
        letterSpacing: 0,
        lineHeight: 1.0,
        cursorBlink: false,
        cursorStyle: 'bar',
        cursorWidth: 1,
        scrollback: 10000,
        overviewRuler: { width: 0 },
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(xtermContainer)
      fitAddon.fit()

      // Connect data listener
      let gotFirstPrompt = false
      const onData = (payload: { sessionId: string; data: string }) => {
        if (payload.sessionId === id) {
          const urlMatch = payload.data.match(/kanvas-open:(https?:\/\/[^\x07\x1b]+)/)
          if (urlMatch) {
            window.api.cmuxExec(['new-pane', '--type', 'browser', '--url', urlMatch[1].trim()])
            const cleaned = payload.data.replace(/\x1b\]7;kanvas-open:[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
            if (cleaned) term.write(cleaned)
          } else {
            term.write(payload.data)
          }
          if (!gotFirstPrompt) {
            gotFirstPrompt = true
            term.options.cursorBlink = true
            term.options.theme = { ...term.options.theme, cursor: '#e0e0e0' }
          }
        }
      }
      const onExit = (payload: { sessionId: string; exitCode: number }) => {
        if (payload.sessionId === id) {
          term.write(`\r\n[Process exited with code ${payload.exitCode}]\r\n`)
          onStatusChange(termId, 'exited')
        }
      }
      window.api.onPtyData(onData)
      window.api.onPtyExit(onExit)
      const cleanupPty = () => {
        window.api.offPtyData(onData)
        window.api.offPtyExit(onExit)
      }

      window.api.ptyResize(id, term.cols, term.rows)
      onStatusChange(termId, 'connected')

      const inputDisposable = term.onData((data) => {
        window.api.ptyWrite(id, data)
      })
      const resizeDisposable = term.onResize(({ cols, rows }) => {
        window.api.ptyResize(id, cols, rows)
      })
      const titleDisposable = term.onTitleChange((title) => {
        if (title) onTitleChange(termId, title)
      })

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit()
      })
      resizeObserver.observe(xtermContainer)

      // Store in the global registry
      sessionRegistry.set(termId, {
        sessionId: id,
        term,
        fitAddon,
        container: xtermContainer,
        resizeObserver,
        cleanupPty,
        inputDisposable,
        resizeDisposable,
        titleDisposable,
      })
    })

    return () => {
      cancelled = true
      // On unmount during initial creation: detach but do NOT destroy.
      // If the PTY hasn't finished creating yet, `cancelled` flag handles it.
      if (xtermContainer.parentNode === placeholder) {
        placeholder.removeChild(xtermContainer)
      }
      attachedRef.current = false
    }
  }, [termId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when becoming visible or when focused changes (split resize)
  useEffect(() => {
    if (visible) {
      const entry = sessionRegistry.get(termId)
      if (entry) {
        requestAnimationFrame(() => {
          entry.fitAddon.fit()
        })
      }
    }
  }, [visible, termId])

  // File drop from Finder → paste path into terminal
  useEffect(() => {
    const el = placeholderRef.current
    if (!el) return

    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      el.style.outline = '2px solid #4a9eff'
      el.style.background = 'rgba(74,158,255,0.08)'
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget && el.contains(e.relatedTarget as Node)) return
      el.style.outline = focused ? '1px solid #4a9eff55' : 'none'
      el.style.background = ''
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      el.style.outline = focused ? '1px solid #4a9eff55' : 'none'
      el.style.background = ''

      const entry = sessionRegistry.get(termId)
      if (!entry) return

      // File.path from Electron (requires sandbox=false)
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        const paths: string[] = []
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const f = e.dataTransfer.files[i] as any
          if (f.path) paths.push(f.path.includes(' ') ? `'${f.path}'` : f.path)
        }
        if (paths.length > 0) {
          window.api.ptyWrite(entry.sessionId, paths.join(' ') + ' ')
          return
        }
      }
      // Fallback: plain text
      const text = e.dataTransfer?.getData('text/plain')
      if (text) window.api.ptyWrite(entry.sessionId, text + ' ')
    }

    // Capture phase to intercept before xterm
    el.addEventListener('dragover', onDragOver, true)
    el.addEventListener('dragleave', onDragLeave, true)
    el.addEventListener('drop', onDrop, true)
    return () => {
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('dragleave', onDragLeave, true)
      el.removeEventListener('drop', onDrop, true)
    }
  }, [termId, focused])

  return (
    <div
      ref={placeholderRef}
      onClick={onFocus}
      style={{
        flex: 1,
        minHeight: 0,
        display: visible ? 'block' : 'none',
        outline: focused ? '1px solid #4a9eff55' : 'none',
        outlineOffset: -1,
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

/* ── Recursive SplitPane renderer ── */

interface SplitPaneProps {
  tree: SplitTree
  visible: boolean
  focusedTermId: string
  cwd: string | undefined
  onFocusTerm: (termId: string) => void
  onSessionReady: (termId: string, sessionId: string) => void
  onStatusChange: (termId: string, status: 'connecting' | 'connected' | 'exited') => void
  onTitleChange: (termId: string, title: string) => void
  onResize: (path: number[], sizes: number[]) => void
  path: number[]  // path from root to this node for resize identification
}

function SplitPane({ tree, visible, focusedTermId, cwd, onFocusTerm, onSessionReady, onStatusChange, onTitleChange, onResize, path }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  if (tree.type === 'terminal') {
    return (
      <TerminalSession
        key={tree.id}
        termId={tree.id}
        visible={visible}
        focused={tree.id === focusedTermId}
        cwd={cwd}
        onSessionReady={onSessionReady}
        onStatusChange={onStatusChange}
        onTitleChange={onTitleChange}
        onFocus={() => onFocusTerm(tree.id)}
      />
    )
  }

  // Split node: render children with resize handles between them
  const isVert = tree.direction === 'vertical'
  const handleSize = 4 // px for each resize handle
  const totalHandles = tree.children.length - 1
  const totalHandlePx = totalHandles * handleSize

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: isVert ? 'row' : 'column',
        width: '100%',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
      }}
    >
      {tree.children.map((child, i) => {
        const childKey = child.type === 'terminal' ? child.id : `split-${path.join('-')}-${i}`
        return (
        <React.Fragment key={childKey}>
          {i > 0 && (
            <SplitResizeHandle
              direction={tree.direction}
              onResize={(delta) => {
                const container = containerRef.current
                if (!container) return
                const containerSize = isVert ? container.clientWidth : container.clientHeight
                if (containerSize === 0) return
                const pctDelta = (delta / containerSize) * 100
                const newSizes = [...tree.sizes]
                const newPrev = Math.max(10, Math.min(90, newSizes[i - 1] + pctDelta))
                const diff = newPrev - newSizes[i - 1]
                newSizes[i - 1] = newPrev
                newSizes[i] = Math.max(10, newSizes[i] - diff)
                onResize(path, newSizes)
              }}
            />
          )}
          <div
            style={{
              [isVert ? 'width' : 'height']: `calc(${tree.sizes[i]}% - ${(totalHandlePx * tree.sizes[i]) / 100}px)`,
              minHeight: 0,
              minWidth: 0,
              overflow: 'hidden',
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <SplitPane
              tree={child}
              visible={visible}
              focusedTermId={focusedTermId}
              cwd={cwd}
              onFocusTerm={onFocusTerm}
              onSessionReady={onSessionReady}
              onStatusChange={onStatusChange}
              onTitleChange={onTitleChange}
              onResize={onResize}
              path={[...path, i]}
            />
          </div>
        </React.Fragment>
      )})}
    </div>
  )
}

/* ── Main App ── */

function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const tabsRef = useRef<TabInfo[]>([])
  const cwdRef = useRef<string | undefined>(undefined)

  // Map termId -> sessionId for PTY writes
  const termSessionMap = useRef<Map<string, string>>(new Map())

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

  // cmuxWrite forwards to the active tab's focused terminal PTY
  useEffect(() => {
    const onCmuxWrite = (text: string) => {
      const active = tabsRef.current.find(t => t.id === activeTabId)
      if (!active) return
      const sessionId = termSessionMap.current.get(active.focusedTermId)
      if (sessionId) {
        window.api.ptyWrite(sessionId, text)
      }
    }
    window.api.onCmuxWrite(onCmuxWrite)
    return () => {
      window.api.offCmuxWrite(onCmuxWrite)
    }
  }, [activeTabId])

  // Cmd+W: close focused pane → tab → tile (progressive)
  useEffect(() => {
    const closePaneOrTab = () => {
      const tabs = tabsRef.current
      const active = tabs.find(t => t.id === activeTabId)
      if (!active) return

      if (active.tree.type === 'split') {
        handleCloseFocusedPane(active.id)
        return
      }

      if (tabs.length > 1) {
        closeTab(active.id)
        return
      }

      window.api.requestRemoveTile()
    }

    // Listen via IPC (from shell when canvas has focus)
    window.api.onClosePaneOrTab(closePaneOrTab)

    // Listen via keydown (when terminal webview has focus)
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault()
        closePaneOrTab()
      }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      window.api.offClosePaneOrTab(closePaneOrTab)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [activeTabId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Expose addTab globally for cmux:new-tab IPC
  useEffect(() => {
    const handler = () => addTab()
    ;(window as any).__kawaseNewTab = handler
    return () => {
      delete (window as any).__kawaseNewTab
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const addTab = useCallback(() => {
    const tabId = createTabId()
    const termId = createTermId()
    const tabNum = tabsRef.current.length + 1
    const newTab: TabInfo = {
      id: tabId,
      title: `Tab ${tabNum}`,
      tree: { type: 'terminal', id: termId, sessionId: null, status: 'connecting' },
      focusedTermId: termId,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(tabId)
  }, [])

  const closeTab = useCallback((tabId: string) => {
    // Kill all sessions in the tab's tree via the registry
    const closing = tabsRef.current.find(t => t.id === tabId)
    if (closing) {
      const termIds = collectTermIds(closing.tree)
      for (const tid of termIds) {
        destroyRegistryEntry(tid)
        termSessionMap.current.delete(tid)
      }
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
        setTimeout(() => addTab(), 0)
      }
      return next
    })
  }, [activeTabId, addTab])

  const handleSessionReady = useCallback((termId: string, sessionId: string) => {
    termSessionMap.current.set(termId, sessionId)
    setTabs(prev => prev.map(t => ({
      ...t,
      tree: updateTermNode(t.tree, termId, node => ({ ...node, sessionId })),
    })))
    // Notify the first tab's session to main process
    if (tabsRef.current.length <= 1) {
      window.api.notifyPtySessionId(sessionId)
    }
  }, [])

  const handleStatusChange = useCallback((termId: string, status: 'connecting' | 'connected' | 'exited') => {
    setTabs(prev => prev.map(t => ({
      ...t,
      tree: updateTermNode(t.tree, termId, node => ({ ...node, status })),
    })))
  }, [])

  const handleTitleChange = useCallback((termId: string, title: string) => {
    // Only update tab title if this terminal is the focused one in its tab
    const display = title.length > 20 ? title.slice(0, 20) + '...' : title
    setTabs(prev => prev.map(t => {
      if (t.focusedTermId === termId) {
        return { ...t, title: display }
      }
      return t
    }))
  }, [])

  const handleSendCommand = useCallback((text: string) => {
    const active = tabsRef.current.find(t => t.id === activeTabId)
    if (!active) return
    const sessionId = termSessionMap.current.get(active.focusedTermId)
    if (sessionId) {
      window.api.ptyWrite(sessionId, text)
    }
  }, [activeTabId])

  const handleFocusTerm = useCallback((tabId: string, termId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, focusedTermId: termId } : t
    ))
  }, [])

  const handleSplit = useCallback((direction: 'horizontal' | 'vertical') => {
    const active = tabsRef.current.find(t => t.id === activeTabId)
    if (!active) return

    const focusedTermId = active.focusedTermId
    const focusedNode = findTermNode(active.tree, focusedTermId)
    if (!focusedNode || focusedNode.type !== 'terminal') return

    // Create a new terminal to be the sibling
    const newTermId = createTermId()
    const newTermNode: SplitTree = {
      type: 'terminal',
      id: newTermId,
      sessionId: null,
      status: 'connecting',
    }

    // Replace the focused terminal with a split containing the original + new terminal
    const splitNode: SplitTree = {
      type: 'split',
      direction,
      children: [focusedNode, newTermNode],
      sizes: [50, 50],
    }

    const newTree = replaceTermNode(active.tree, focusedTermId, splitNode)

    setTabs(prev => prev.map(t =>
      t.id === activeTabId ? { ...t, tree: newTree } : t
    ))
  }, [activeTabId])

  const handleUnsplit = useCallback((tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId)
    if (!tab) return

    // If the tree is just a single terminal, nothing to unsplit
    if (tab.tree.type === 'terminal') return

    // Collect all terminal IDs and session IDs, keep only the focused one
    const allTermIds = collectTermIds(tab.tree)
    const keepTermId = tab.focusedTermId
    const keepNode = findTermNode(tab.tree, keepTermId) as Extract<SplitTree, { type: 'terminal' }> | null

    if (!keepNode) return

    // Kill all other sessions via the registry
    for (const tid of allTermIds) {
      if (tid !== keepTermId) {
        destroyRegistryEntry(tid)
        termSessionMap.current.delete(tid)
      }
    }

    // Replace entire tree with just the focused terminal
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, tree: keepNode, focusedTermId: keepTermId } : t
    ))
  }, [])

  /** Close only the focused pane (remove from tree, collapse if needed) */
  const handleCloseFocusedPane = useCallback((tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId)
    if (!tab || tab.tree.type === 'terminal') return // Can't close the only terminal

    const termId = tab.focusedTermId
    destroyRegistryEntry(termId)
    termSessionMap.current.delete(termId)

    const newTree = removeTermNode(tab.tree, termId)
    if (!newTree) return // Should not happen since we checked it's not the only terminal

    // Pick a new focused terminal from the remaining tree
    const remainingTermIds = collectTermIds(newTree)
    const newFocusedTermId = remainingTermIds[0] || tab.focusedTermId

    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, tree: newTree, focusedTermId: newFocusedTermId } : t
    ))
  }, [])

  const handleTreeResize = useCallback((tabId: string, path: number[], sizes: number[]) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, tree: updateSplitSizes(t.tree, path, sizes) } : t
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
          {tabs.map(tab => {
            const splitCount = countSplits(tab.tree)
            const dominantDir = getDominantDirection(tab.tree)
            const hasSplit = splitCount > 0
            const termIds = collectTermIds(tab.tree)
            const hasExited = hasStatus(tab.tree, 'exited')

            return (
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
                {hasSplit && (
                  <span style={{ fontSize: 9, color: '#4a9eff', marginRight: 2 }}>
                    {dominantDir === 'vertical' ? '||' : '='}{termIds.length > 2 ? `${termIds.length}` : ''}
                  </span>
                )}
                <span>{tab.title}</span>
                {hasExited && (
                  <span style={{ fontSize: 9, color: '#f44', marginLeft: 2 }}>exited</span>
                )}
                {hasSplit && tab.id === activeTabId && (
                  <>
                    <span
                      onClick={(e) => { e.stopPropagation(); handleCloseFocusedPane(tab.id) }}
                      title="Close focused pane"
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
                      close pane
                    </span>
                    <span
                      onClick={(e) => { e.stopPropagation(); handleUnsplit(tab.id) }}
                      title="Close all splits (keep focused pane)"
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
                  </>
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
            )
          })}
        </div>
      )}

      {/* Terminal area */}
      {activeTab?.tree.type === 'terminal' && activeTab.tree.status === 'connecting' && (
        <div style={{ padding: 8, fontSize: 12, color: '#888' }}>Connecting...</div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTabId

          return (
            <div
              key={tab.id}
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                display: isActive ? 'flex' : 'none',
                flexDirection: 'column',
              }}
            >
              <SplitPane
                tree={tab.tree}
                visible={isActive}
                focusedTermId={tab.focusedTermId}
                cwd={cwdRef.current}
                onFocusTerm={(termId) => handleFocusTerm(tab.id, termId)}
                onSessionReady={handleSessionReady}
                onStatusChange={handleStatusChange}
                onTitleChange={handleTitleChange}
                onResize={(path, sizes) => handleTreeResize(tab.id, path, sizes)}
                path={[]}
              />
            </div>
          )
        })}
      </div>

      {activeTab && hasStatus(activeTab.tree, 'connected') && (
        <CommandInput onSend={handleSendCommand} />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
