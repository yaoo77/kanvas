import React, { useState, useEffect, useRef, useCallback } from 'react'

declare global {
  interface Window {
    api: {
      cmuxExec: (args: string[]) => Promise<{ ok: boolean; output?: string; error?: string }>
      focusTile: (tileId: string) => void
    }
  }
}

interface CmuxToolbarProps {
  sessionId?: string
  onNewTab?: () => void
}

/* ── SVG Icons (14×14, stroke-based) ── */

const SplitLeftIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1" y="2" width="14" height="12" rx="1" /><line x1="8" y1="2" x2="8" y2="14" />
    <line x1="3" y1="8" x2="5" y2="6" strokeLinecap="round" /><line x1="3" y1="8" x2="5" y2="10" strokeLinecap="round" />
  </svg>
)
const SplitRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1" y="2" width="14" height="12" rx="1" /><line x1="8" y1="2" x2="8" y2="14" />
    <line x1="13" y1="8" x2="11" y2="6" strokeLinecap="round" /><line x1="13" y1="8" x2="11" y2="10" strokeLinecap="round" />
  </svg>
)
const SplitUpIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1" y="2" width="14" height="12" rx="1" /><line x1="1" y1="8" x2="15" y2="8" />
    <line x1="8" y1="4" x2="6" y2="6" strokeLinecap="round" /><line x1="8" y1="4" x2="10" y2="6" strokeLinecap="round" />
  </svg>
)
const SplitDownIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1" y="2" width="14" height="12" rx="1" /><line x1="1" y1="8" x2="15" y2="8" />
    <line x1="8" y1="12" x2="6" y2="10" strokeLinecap="round" /><line x1="8" y1="12" x2="10" y2="10" strokeLinecap="round" />
  </svg>
)
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" />
  </svg>
)
const GlobeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <circle cx="8" cy="8" r="5.5" /><ellipse cx="8" cy="8" rx="2.5" ry="5.5" /><line x1="2.5" y1="8" x2="13.5" y2="8" />
  </svg>
)
const DocIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" /><path d="M9 2v4h4" />
  </svg>
)
const TerminalIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1" y="2" width="14" height="12" rx="1.5" />
    <polyline points="4,6 7,8 4,10" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="8" y1="10" x2="12" y2="10" strokeLinecap="round" />
  </svg>
)

const FullscreenIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <polyline points="2,6 2,2 6,2" /><polyline points="10,2 14,2 14,6" />
    <polyline points="14,10 14,14 10,14" /><polyline points="6,14 2,14 2,10" />
  </svg>
)

/* ── Button config ── */

interface ToolbarButton {
  id: string
  title: string
  icon: React.ReactNode
  action: string[]
  needsInput?: 'markdown' | 'command'
}

const BUTTONS: ToolbarButton[][] = [
  [
    { id: 'split-left', title: 'Split Left', icon: <SplitLeftIcon />, action: ['new-split', 'left'] },
    { id: 'split-right', title: 'Split Right', icon: <SplitRightIcon />, action: ['new-split', 'right'] },
    { id: 'split-up', title: 'Split Up', icon: <SplitUpIcon />, action: ['new-split', 'up'] },
    { id: 'split-down', title: 'Split Down', icon: <SplitDownIcon />, action: ['new-split', 'down'] },
  ],
  [
    { id: 'new-tab', title: 'New Tab', icon: <PlusIcon />, action: ['new-tab'] },
    { id: 'new-browser', title: 'Open Browser', icon: <GlobeIcon />, action: ['new-pane', '--type', 'browser'] },
  ],
  [
    { id: 'cmd-palette', title: 'Send Command', icon: <TerminalIcon />, action: [], needsInput: 'command' },
  ],
]

/* ── Component ── */

export default function CmuxToolbar({ sessionId, onNewTab }: CmuxToolbarProps) {
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [modal, setModal] = useState<{ type: 'markdown' | 'command'; value: string } | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Status polling
  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const result = await window.api.cmuxExec(['sidebar-state'])
        if (!active || !result.ok) return
        const output = result.output || ''
        const statusMatch = output.match(/status:\s*(.+)/i)
        if (statusMatch) setStatus(statusMatch[1].trim())
        const progressMatch = output.match(/progress:\s*([\d.]+)/i)
        if (progressMatch) {
          setProgress(Math.round(parseFloat(progressMatch[1]) * 100))
        } else {
          setProgress(null)
        }
      } catch {
        // cmux not available
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  // Focus input when modal opens
  useEffect(() => {
    if (modal) setTimeout(() => inputRef.current?.focus(), 50)
  }, [modal])

  const exec = useCallback(async (args: string[]) => {
    await window.api.cmuxExec(args)
  }, [])

  const handleClick = useCallback((btn: ToolbarButton) => {
    if (btn.needsInput) {
      setModal({ type: btn.needsInput, value: '' })
      return
    }
    // Intercept new-tab: call prop instead of cmuxExec
    if (btn.id === 'new-tab' && onNewTab) {
      setFlashId(btn.id)
      setTimeout(() => setFlashId(null), 120)
      onNewTab()
      return
    }
    // Visual feedback
    setFlashId(btn.id)
    setTimeout(() => setFlashId(null), 120)
    exec(btn.action)
  }, [exec, onNewTab])

  const handleModalSubmit = useCallback(() => {
    if (!modal || !modal.value.trim()) { setModal(null); return }
    if (modal.type === 'markdown') {
      exec(['markdown', 'open', modal.value.trim()])
    } else {
      exec(['send', modal.value.trim()]).then(() => exec(['send-key', 'Return']))
    }
    setModal(null)
  }, [modal, exec])

  const stopPropagation = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
  }, [])

  return (
    <>
      <div
        style={{
          display: 'flex', alignItems: 'center', height: 28,
          background: '#1a1a1a', borderBottom: '1px solid #333',
          padding: '0 4px', gap: 2, userSelect: 'none', position: 'relative',
        }}
        onPointerDown={stopPropagation}
        onPointerUp={stopPropagation}
        onMouseDown={stopPropagation}
        onClick={stopPropagation}
      >
        {BUTTONS.map((group, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <div style={{ width: 1, height: 16, background: '#333', margin: '0 2px' }} />}
            {group.map((btn) => (
              <button
                key={btn.id}
                title={btn.title}
                onClick={() => handleClick(btn)}
                style={{
                  width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'transparent', border: 'none', color: '#888', cursor: 'pointer',
                  borderRadius: 3, opacity: flashId === btn.id ? 0.5 : 1,
                  transition: 'opacity 0.12s',
                }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.color = '#ccc' }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.color = '#888' }}
              >
                {btn.icon}
              </button>
            ))}
          </React.Fragment>
        ))}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Status */}
        {status && (
          <span style={{ fontSize: 11, color: '#666', marginRight: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>
            {status}
          </span>
        )}

        {/* Fullscreen toggle */}
        <button
          title="Toggle Fullscreen"
          onClick={() => window.api.cmuxExec(['fullscreen'])}
          style={{
            width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', borderRadius: 3,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ccc' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#888' }}
        >
          <FullscreenIcon />
        </button>
      </div>

      {/* Progress bar */}
      {progress != null && (
        <div style={{ height: 2, background: '#333', position: 'relative' }}>
          <div style={{ height: '100%', background: '#4a9eff', width: `${progress}%`, transition: 'width 0.3s' }} />
        </div>
      )}

      {/* Modal */}
      {modal && (
        <div
          style={{
            position: 'absolute', top: 30, left: '50%', transform: 'translateX(-50%)',
            background: '#252526', border: '1px solid #444', borderRadius: 6,
            padding: 8, zIndex: 100, minWidth: 260, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
        >
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
            {modal.type === 'markdown' ? 'Markdown file path:' : 'Command to send:'}
          </div>
          <input
            ref={inputRef}
            value={modal.value}
            onChange={(e) => setModal({ ...modal, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleModalSubmit()
              if (e.key === 'Escape') setModal(null)
            }}
            style={{
              width: '100%', background: '#1e1e1e', border: '1px solid #555',
              color: '#e0e0e0', padding: '4px 8px', borderRadius: 3, fontSize: 13,
              outline: 'none',
            }}
          />
          <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
            Enter to submit · Esc to cancel
          </div>
        </div>
      )}
    </>
  )
}
