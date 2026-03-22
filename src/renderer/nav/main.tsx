import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

declare global {
  interface Window {
    api: {
      readDir: (path: string) => Promise<Array<{ name: string; isDir: boolean; path: string }>>
      selectFile: (path: string) => void
      selectFolder: (path: string) => void
      trashFile: (path: string) => Promise<void>
      createDir: (path: string) => Promise<void>
      moveFile: (old: string, newDir: string) => Promise<void>
      openInTerminal: (path: string) => void
      showContextMenu: (items: Array<{ label: string; id: string }>) => Promise<string | null>
      onWorkspaceChanged: (cb: (path: string) => void) => () => void
      onFsChanged: (cb: (events: unknown) => void) => () => void
      readTree: (params: unknown) => Promise<unknown>
      getConfig: () => Promise<{ workspacePath?: string }>
      getPref: (key: string) => Promise<unknown>
      setPref: (key: string, value: unknown) => Promise<void>
      listTiles: () => Promise<Array<{ id: string; type: string; sessionId?: string; filePath?: string; url?: string; focused: boolean }>>
      focusTile: (tileId: string) => void
    }
  }
}

interface DirEntry {
  name: string
  isDir: boolean
  path: string
}

/* ── Tab Bar ── */

type NavTab = 'files' | 'sessions'

function TabBar({ active, onChange }: { active: NavTab; onChange: (tab: NavTab) => void }) {
  const tabStyle = (tab: NavTab): React.CSSProperties => ({
    flex: 1, background: 'none', border: 'none', borderBottom: active === tab ? '2px solid #4a9eff' : '2px solid transparent',
    color: active === tab ? '#e0e0e0' : '#666', fontSize: 12, padding: '6px 0', cursor: 'pointer',
    fontWeight: active === tab ? 600 : 400, transition: 'color 0.1s',
  })

  return (
    <div style={{ display: 'flex', borderBottom: '1px solid #333', flexShrink: 0 }}>
      <button style={tabStyle('files')} onClick={() => onChange('files')}>Files</button>
      <button style={tabStyle('sessions')} onClick={() => onChange('sessions')}>Sessions</button>
    </div>
  )
}

/* ── File Tree ── */

interface TreeNodeProps {
  entry: DirEntry
  depth: number
  onSelect: (path: string, isDir: boolean) => void
}

function TreeNode({ entry, depth, onSelect }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<DirEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  const toggle = useCallback(async () => {
    if (!entry.isDir) {
      onSelect(entry.path, false)
      return
    }
    if (!loaded) {
      const items = await window.api.readDir(entry.path)
      const sorted = items.sort((a: DirEntry, b: DirEntry) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      setChildren(sorted)
      setLoaded(true)
    }
    setExpanded((prev) => !prev)
    onSelect(entry.path, true)
  }, [entry, loaded, onSelect])

  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    const items = [
      { label: 'Open in Terminal', id: 'terminal' },
      { label: 'Trash', id: 'trash' },
    ]
    const result = await window.api.showContextMenu(items)
    if (result === 'terminal') window.api.openInTerminal(entry.path)
    else if (result === 'trash') await window.api.trashFile(entry.path)
  }, [entry.path])

  const icon = entry.isDir ? (expanded ? '\u25BE' : '\u25B8') : ' '

  return (
    <div>
      <div
        onClick={toggle}
        onContextMenu={handleContextMenu}
        style={{
          padding: '3px 8px',
          paddingLeft: `${depth * 16 + 8}px`,
          cursor: 'pointer',
          fontSize: 13,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          userSelect: 'none',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}
      >
        <span style={{ width: 14, display: 'inline-block', color: '#888' }}>{icon}</span>
        {entry.name}
      </div>
      {expanded && children.map((child) => (
        <TreeNode key={child.path} entry={child} depth={depth + 1} onSelect={onSelect} />
      ))}
    </div>
  )
}

function FilesPanel({ entries, onSelect }: { entries: DirEntry[]; onSelect: (path: string, isDir: boolean) => void }) {
  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      {entries.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} onSelect={onSelect} />
      ))}
      {entries.length === 0 && (
        <div style={{ padding: 16, color: '#666', fontSize: 13 }}>No workspace open</div>
      )}
    </div>
  )
}

/* ── Sessions Panel ── */

interface TileInfo {
  id: string
  type: string
  sessionId?: string
  filePath?: string
  url?: string
  focused: boolean
}

function tileIcon(type: string): string {
  switch (type) {
    case 'terminal': return '\u25b8'
    case 'browser': return '\u25cb'
    case 'graph': return '\u25c9'
    case 'file':
    case 'viewer': return '\u25a0'
    default: return '\u25a1'
  }
}

function tileLabel(tile: TileInfo): string {
  switch (tile.type) {
    case 'terminal': return tile.sessionId ? `Terminal (${tile.sessionId})` : 'Terminal'
    case 'browser': return tile.url ? new URL(tile.url).hostname : 'Browser'
    case 'graph': return 'Graph'
    case 'file':
    case 'viewer': return tile.filePath?.split('/').pop() || 'File'
    default: return tile.type
  }
}

function SessionsPanel() {
  const [tiles, setTiles] = useState<TileInfo[]>([])

  const refresh = useCallback(async () => {
    try {
      const list = await window.api.listTiles()
      setTiles(list || [])
    } catch {
      setTiles([])
    }
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 2000)
    return () => clearInterval(interval)
  }, [refresh])

  const handleClick = useCallback((tileId: string) => {
    window.api.focusTile(tileId)
    // Refresh to update focused state
    setTimeout(refresh, 100)
  }, [refresh])

  const terminals = tiles.filter(t => t.type === 'terminal')
  const others = tiles.filter(t => t.type !== 'terminal')

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
      {terminals.length > 0 && (
        <>
          <div style={{ padding: '6px 12px', fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Terminals ({terminals.length})
          </div>
          {terminals.map(tile => (
            <div
              key={tile.id}
              onClick={() => handleClick(tile.id)}
              style={{
                padding: '6px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
                cursor: 'pointer', fontSize: 13,
                background: tile.focused ? '#2a2a2a' : 'transparent',
                borderLeft: tile.focused ? '2px solid #4a9eff' : '2px solid transparent',
              }}
              onMouseEnter={e => { if (!tile.focused) (e.currentTarget as HTMLElement).style.background = '#252525' }}
              onMouseLeave={e => { if (!tile.focused) (e.currentTarget as HTMLElement).style.background = '' }}
            >
              <span style={{ color: tile.focused ? '#4a9eff' : '#888', fontSize: 12 }}>{tileIcon(tile.type)}</span>
              <span style={{ color: tile.focused ? '#e0e0e0' : '#aaa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tileLabel(tile)}
              </span>
            </div>
          ))}
        </>
      )}
      {others.length > 0 && (
        <>
          <div style={{ padding: '6px 12px', fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: terminals.length > 0 ? 8 : 0 }}>
            Other ({others.length})
          </div>
          {others.map(tile => (
            <div
              key={tile.id}
              onClick={() => handleClick(tile.id)}
              style={{
                padding: '6px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
                cursor: 'pointer', fontSize: 13,
                background: tile.focused ? '#2a2a2a' : 'transparent',
                borderLeft: tile.focused ? '2px solid #4a9eff' : '2px solid transparent',
              }}
              onMouseEnter={e => { if (!tile.focused) (e.currentTarget as HTMLElement).style.background = '#252525' }}
              onMouseLeave={e => { if (!tile.focused) (e.currentTarget as HTMLElement).style.background = '' }}
            >
              <span style={{ color: tile.focused ? '#4a9eff' : '#888', fontSize: 12 }}>{tileIcon(tile.type)}</span>
              <span style={{ color: tile.focused ? '#e0e0e0' : '#aaa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tileLabel(tile)}
              </span>
            </div>
          ))}
        </>
      )}
      {tiles.length === 0 && (
        <div style={{ padding: 16, color: '#666', fontSize: 13 }}>No active sessions</div>
      )}
    </div>
  )
}

/* ── App ── */

function App() {
  const [tab, setTab] = useState<NavTab>('files')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [workspace, setWorkspace] = useState<string | null>(null)

  const loadRoot = useCallback(async (path: string) => {
    const items = await window.api.readDir(path)
    const sorted = items.sort((a: DirEntry, b: DirEntry) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    setEntries(sorted)
    setWorkspace(path)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const wsPath = params.get('workspace')
    if (wsPath) {
      loadRoot(wsPath)
    } else {
      window.api.getConfig().then((cfg) => {
        if (cfg.workspacePath) loadRoot(cfg.workspacePath)
      })
    }

    const unsub = window.api.onWorkspaceChanged((path) => {
      loadRoot(path)
    })
    return unsub
  }, [loadRoot])

  useEffect(() => {
    if (!workspace) return
    const unsub = window.api.onFsChanged(() => {
      loadRoot(workspace)
    })
    return unsub
  }, [workspace, loadRoot])

  const handleSelect = useCallback((path: string, isDir: boolean) => {
    if (isDir) {
      window.api.selectFolder(path)
    } else {
      window.api.selectFile(path)
    }
  }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <TabBar active={tab} onChange={setTab} />
      {tab === 'files' ? (
        <FilesPanel entries={entries} onSelect={handleSelect} />
      ) : (
        <SessionsPanel />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
