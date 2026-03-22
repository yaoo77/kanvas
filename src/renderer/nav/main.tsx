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
      cmuxExec: (args: string[]) => Promise<{ ok: boolean; output?: string; error?: string }>
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
  changedFiles?: Set<string>
}

function TreeNode({ entry, depth, onSelect, changedFiles }: TreeNodeProps) {
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
        {changedFiles?.has(entry.path) && <span style={{ color: '#4a9eff', fontSize: 10, marginLeft: 4 }}>{'\u25CF'}</span>}
      </div>
      {expanded && children.map((child) => (
        <TreeNode key={child.path} entry={child} depth={depth + 1} onSelect={onSelect} changedFiles={changedFiles} />
      ))}
    </div>
  )
}

async function recursiveScan(dirPath: string, query: string, maxDepth: number, depth: number = 0): Promise<DirEntry[]> {
  if (depth > maxDepth) return []
  let entries: DirEntry[]
  try {
    entries = await window.api.readDir(dirPath)
  } catch {
    return []
  }
  const lowerQuery = query.toLowerCase()
  const results: DirEntry[] = []
  for (const entry of entries) {
    if (entry.name.toLowerCase().includes(lowerQuery)) {
      results.push(entry)
    }
    if (entry.isDir) {
      const subResults = await recursiveScan(entry.path, query, maxDepth, depth + 1)
      results.push(...subResults)
    }
  }
  return results
}

function SearchResults({ query, onSelect, changedFiles, workspacePath }: { query: string; onSelect: (path: string, isDir: boolean) => void; changedFiles?: Set<string>; workspacePath: string | null }) {
  const [matches, setMatches] = useState<DirEntry[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!query || !workspacePath) {
      setMatches([])
      return
    }
    let cancelled = false
    setSearching(true)
    recursiveScan(workspacePath, query, 3).then((results) => {
      if (!cancelled) {
        setMatches(results)
        setSearching(false)
      }
    })
    return () => { cancelled = true }
  }, [query, workspacePath])

  if (searching) {
    return <div style={{ padding: 16, color: '#888', fontSize: 13 }}>Searching...</div>
  }

  if (matches.length === 0) {
    return <div style={{ padding: 16, color: '#666', fontSize: 13 }}>No results for &ldquo;{query}&rdquo;</div>
  }

  return (
    <>
      {matches.map(entry => (
        <div
          key={entry.path}
          onClick={() => onSelect(entry.path, entry.isDir)}
          style={{
            padding: '3px 8px',
            cursor: 'pointer',
            fontSize: 13,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            userSelect: 'none',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
        >
          <span style={{ width: 14, display: 'inline-block', color: '#888' }}>{entry.isDir ? '\u25B8' : ' '}</span>
          {entry.name}
          <span style={{ color: '#555', fontSize: 11, marginLeft: 8 }}>{entry.path.replace(workspacePath + '/', '')}</span>
          {changedFiles?.has(entry.path) && <span style={{ color: '#4a9eff', fontSize: 10, marginLeft: 4 }}>{'\u25CF'}</span>}
        </div>
      ))}
    </>
  )
}

function FilesPanel({ entries, onSelect, searchQuery, changedFiles, workspacePath }: { entries: DirEntry[]; onSelect: (path: string, isDir: boolean) => void; searchQuery: string; changedFiles?: Set<string>; workspacePath: string | null }) {
  if (searchQuery) {
    return (
      <div style={{ flex: 1, overflow: 'auto' }}>
        <SearchResults query={searchQuery} onSelect={onSelect} changedFiles={changedFiles} workspacePath={workspacePath} />
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      {entries.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} onSelect={onSelect} changedFiles={changedFiles} />
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

  const createTile = useCallback((type: string) => {
    window.api.cmuxExec(['new-pane', '--type', type])
    setTimeout(refresh, 500)
  }, [refresh])

  const actionBtnStyle: React.CSSProperties = {
    flex: 1, background: '#252525', border: '1px solid #444', color: '#ccc',
    borderRadius: 4, padding: '6px 0', cursor: 'pointer', fontSize: 11, textAlign: 'center' as const,
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
      {/* Action buttons */}
      <div style={{ padding: '8px 12px', display: 'flex', gap: 4 }}>
        <button style={actionBtnStyle} onClick={() => createTile('terminal')}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#333' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#252525' }}
        >+ Terminal</button>
        <button style={actionBtnStyle} onClick={() => createTile('browser')}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#333' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#252525' }}
        >+ Browser</button>
        <button style={actionBtnStyle} onClick={() => createTile('note')}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#333' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#252525' }}
        >+ Note</button>
        <button style={{...actionBtnStyle, background: '#333'}} onClick={() => { window.api.cmuxExec(['fullscreen']); setTimeout(refresh, 300) }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#4a9eff' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#333' }}
        >⛶</button>
      </div>

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
  const [searchQuery, setSearchQuery] = useState('')
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set())

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
    const unsub = window.api.onFsChanged((events: unknown) => {
      loadRoot(workspace)
      const paths = Array.isArray(events) ? events.map((e: any) => e.path).filter(Boolean) as string[] : []
      if (paths.length > 0) {
        setChangedFiles(prev => new Set([...prev, ...paths]))
        setTimeout(() => {
          setChangedFiles(prev => {
            const next = new Set(prev)
            paths.forEach((p: string) => next.delete(p))
            return next
          })
        }, 10000)
      }
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
      {tab === 'files' && (
        <div style={{ padding: '6px 8px', flexShrink: 0 }}>
          <div style={{ position: 'relative' }}>
            <input
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                background: '#1e1e1e',
                border: '1px solid #444',
                borderRadius: 4,
                padding: '4px 24px 4px 8px',
                fontSize: 12,
                color: '#e0e0e0',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{
                  position: 'absolute',
                  right: 4,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: '#888',
                  cursor: 'pointer',
                  fontSize: 14,
                  padding: '0 2px',
                  lineHeight: 1,
                }}
              >
                {'\u00D7'}
              </button>
            )}
          </div>
        </div>
      )}
      {tab === 'files' ? (
        <FilesPanel entries={entries} onSelect={handleSelect} searchQuery={searchQuery} changedFiles={changedFiles} workspacePath={workspace} />
      ) : (
        <SessionsPanel />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
