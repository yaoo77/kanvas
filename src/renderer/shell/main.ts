/**
 * Shell: Canvas-based tile management system.
 * Manages webview panels as draggable/resizable tiles on a 2D pannable/zoomable canvas.
 * Vanilla TypeScript — no framework imports.
 */

// ─── Type declarations ───────────────────────────────────────────────

declare global {
  interface Window {
    shellApi: {
      getViewConfig: () => Promise<Record<string, { src: string; preload: string }>>
      getPref: (key: string) => Promise<unknown>
      setPref: (key: string, value: unknown) => Promise<void>
      onForwardToWebview: (cb: (target: string, channel: string, ...args: unknown[]) => void) => () => void
      onSettingsToggle: (cb: (action: string) => void) => () => void
      onLoadingDone: (cb: () => void) => () => void
      onShortcut: (cb: (action: string) => void) => () => void
      openSettings: () => void
      closeSettings: () => void
      getWorkspacePath: () => Promise<string | null>
      workspaceAdd: () => Promise<{ workspaces: string[]; active: number }>
      workspaceRemove: (index: number) => Promise<{ workspaces: string[]; active: number }>
      workspaceSwitch: (index: number) => Promise<void>
      workspaceList: () => Promise<{ workspaces: string[]; active: number }>
      canvasLoadState: () => Promise<unknown>
      canvasSaveState: (state: unknown) => Promise<void>
      onWorkspaceChanged: (cb: (path: string) => void) => () => void
      onCanvasPinch: (cb: (deltaY: number) => void) => () => void
      showConfirmDialog: (opts: { message: string }) => Promise<boolean>
      showContextMenu: (items: Array<{ label: string; id: string }>) => Promise<string | null>
      selectFile: (path: string) => void
      openExternal: (url: string) => void
      readDir: (path: string) => Promise<Array<{ name: string; isDirectory: boolean }>>
      gitExec: (args: string[]) => Promise<{ ok: boolean; output?: string; error?: string }>
      rolesLoad: () => Promise<AgentRole[]>
      rolesSave: (roles: AgentRole[]) => Promise<void>
      onCliRequest: (cb: (id: string, method: string, params: unknown) => void) => () => void
      cliRespond: (id: string, result: unknown, error?: string | null) => void
      keymapLoad: () => Promise<Record<string, string>>
      keymapSave: (k: Record<string, string>) => Promise<void>
      floorsList: () => Promise<Array<{ id: string; name: string; branch: string; worktreeDir: string; sourceDir: string; createdAt: string }>>
      floorsCreate: (opts: { sourceDir: string; name: string; canvasState: unknown }) => Promise<{ ok: boolean; id?: string; branch?: string; worktreeDir?: string; error?: string }>
      floorsRemove: (id: string) => Promise<{ ok: boolean; error?: string }>
      getDragPaths: () => Promise<string[]>
      // cmux internal events
      onCmuxSplit: (cb: (direction: string) => void) => () => void
      onCmuxNewPane: (cb: (paneType: string) => void) => () => void
      onCmuxNewWorkspace: (cb: () => void) => () => void
      onCmuxSendText: (cb: (text: string) => void) => () => void
      onCmuxOpenFile: (cb: (path: string) => void) => () => void
      onCmuxNewPaneWithUrl: (cb: (url: string) => void) => () => void
      onCmuxFullscreen: (cb: () => void) => () => void
      onTilesListRequest: (cb: (channel: string) => void) => () => void
      sendTilesListResponse: (channel: string, tiles: unknown) => void
      onTilesFocus: (cb: (tileId: string) => void) => () => void
      onTilesClose: (cb: (tileId: string) => void) => () => void
      onTilesCloseAll: (cb: () => void) => () => void
    }
  }
}

interface ViewConfig {
  [key: string]: { src: string; preload: string }
}

interface Tile {
  id: string
  type: 'terminal' | 'graph' | 'browser' | 'viewer' | 'file' | 'note' | 'filetree'
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  filePath?: string
  folderPath?: string
  url?: string
  sessionId?: string
  customName?: string       // Phase 1b-28: user-set tile title
  cwd?: string              // Phase 1b-27: remembered working directory
  roleId?: string           // Phase 3-17: assigned agent role
  noteContent?: string      // Phase 3-14: sticky note markdown body
}

interface CanvasState {
  panX: number
  panY: number
  zoom: number
  tiles: Tile[]
  nextZ: number
  connections?: Connection[]
  shapes?: Shape[]
}

// Phase 3-15: Connection between two tiles
interface Connection {
  id: string
  from: string           // source tile id
  to: string             // target tile id
  // future: label, style, direction
}

// Phase 3-17: Agent Role
interface AgentRole {
  id: string
  name: string
  icon: string
  color: string
  systemPrompt: string
}

// Phase 3-19: Hand-drawn shape on the canvas
interface Shape {
  id: string
  kind: 'free'
  points: Array<[number, number]>  // canvas-space coordinates
  color: string
  width: number
}

interface WebviewEntry {
  id: string
  webview: HTMLElement
  type: string
}

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

// ─── Constants ───────────────────────────────────────────────────────

const GRID_CELL = 20
const TITLEBAR_H = 28
const RESIZE_HANDLE_W = 6
const MIN_W = 300
const MIN_H = 200
const MIN_TERM_W = 400
const MIN_TERM_H = 250
const ZOOM_MIN = 0.33
const ZOOM_MAX = 1
const ZOOM_RUBBER_BAND_K = 400

const DEFAULT_SIZES: Record<Tile['type'], { w: number; h: number }> = {
  terminal: { w: 750, h: 550 },
  graph:    { w: 600, h: 500 },
  browser:  { w: 800, h: 600 },
  viewer:   { w: 700, h: 500 },
  file:     { w: 700, h: 500 },
  note:     { w: 400, h: 300 },
  filetree: { w: 320, h: 500 },
}

// Phase 1b-26: Remember last size per type (updated when a tile is resized)
const lastTileSizes: Partial<Record<Tile['type'], { w: number; h: number }>> = {}
function getDefaultSize(type: Tile['type']): { w: number; h: number } {
  return lastTileSizes[type] ?? DEFAULT_SIZES[type]
}
function rememberTileSize(type: Tile['type'], w: number, h: number): void {
  lastTileSizes[type] = { w, h }
}

// ─── State ───────────────────────────────────────────────────────────

let viewConfig: ViewConfig = {}
const webviews = new Map<string, WebviewEntry>()
const tileElements = new Map<string, HTMLDivElement>()

let tiles: Tile[] = []
let connections: Connection[] = []  // Phase 3-15
let roles: AgentRole[] = []          // Phase 3-17
let shapes: Shape[] = []              // Phase 3-19
let drawLayer: SVGSVGElement
let drawMode = false
let currentShape: Shape | null = null

// Phase 4b-34: Canvas event log — ring buffer kept in memory
interface CanvasEvent {
  ts: number
  kind: string
  tileId?: string
  tileName?: string
  payload?: unknown
}
const canvasEventLog: CanvasEvent[] = []
const CANVAS_EVENT_LOG_MAX = 500
function logCanvasEvent(ev: CanvasEvent): void {
  canvasEventLog.push(ev)
  if (canvasEventLog.length > CANVAS_EVENT_LOG_MAX) canvasEventLog.shift()
  renderEventLog()
}
function renderEventLog(): void {
  // Minimal UI: the drawer is rendered elsewhere; this is a hook.
  // A full UI is deferred to a later pass; the log is queryable via
  // `kanvas events`.
}
let draftingConnection: { fromId: string } | null = null  // Phase 3-18 drag state
let connLayer: SVGSVGElement
let nextZ = 1
let panX = 0
let panY = 0
let zoom = 1

let focusedTileId: string | null = null
let selectedTileIds = new Set<string>()
let spaceHeld = false

// Fullscreen state (module-scoped for createCanvasTile access)
let isFullscreen = false
let activeFsTileId: string | null = null
let savedPositions = new Map<string, { x: number; y: number; width: number; height: number }>()
let savedViewport = { panX: 0, panY: 0, zoom: 1 }
let isPanning = false
let zoomSnapTimer: ReturnType<typeof setTimeout> | null = null
let zoomSnapRaf: number | null = null
let lastZoomFocalX = 0
let lastZoomFocalY = 0
let panStartX = 0
let panStartY = 0
let panStartPanX = 0
let panStartPanY = 0

let saveTimeout: ReturnType<typeof setTimeout> | null = null

// ─── DOM refs ────────────────────────────────────────────────────────

let gridCanvas: HTMLCanvasElement
let gridCtx: CanvasRenderingContext2D
let tileLayer: HTMLDivElement
let panelViewer: HTMLDivElement
let zoomIndicator: HTMLDivElement

// ─── Init ────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  viewConfig = await window.shellApi.getViewConfig()

  connLayer = document.getElementById('conn-layer') as unknown as SVGSVGElement
  drawLayer = document.getElementById('draw-layer') as unknown as SVGSVGElement
  gridCanvas = document.getElementById('grid-canvas') as HTMLCanvasElement
  gridCtx = gridCanvas.getContext('2d')!
  tileLayer = document.getElementById('tile-layer') as HTMLDivElement
  panelViewer = document.getElementById('panel-viewer') as HTMLDivElement
  zoomIndicator = document.getElementById('zoom-indicator') as HTMLDivElement

  // Nav panel webview
  createPanelWebview('nav', 'panel-nav')

  // Forward IPC messages to webviews
  window.shellApi.onForwardToWebview((target, channel, ...args) => {
    // File selected → always create a new file tile
    if (target === 'viewer' && channel === 'file-selected' && typeof args[0] === 'string') {
      const filePath = args[0] as string
      // Offset each new tile slightly to avoid stacking
      const existing = tiles.filter(t => t.type === 'file' || t.type === 'viewer')
      const offset = existing.length * 30
      const rect = panelViewer.getBoundingClientRect()
      const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.file.w / 2 + offset
      const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.file.h / 2 + offset
      createCanvasTile('file', snapToGrid(cx), snapToGrid(cy), { filePath })
      return
    }
    for (const [, entry] of webviews) {
      if (entry.type === target || (target === 'canvas' && entry.type === 'viewer')) {
        ;(entry.webview as any).send(channel, ...args)
      }
    }
  })

  // Settings toggle
  window.shellApi.onSettingsToggle((action) => {
    const overlay = document.getElementById('settings-overlay')!
    overlay.style.display = action === 'open' ? 'block' : 'none'
    if (action === 'open' && !webviews.has('settings')) {
      createPanelWebview('settings', 'settings-modal')
    }
  })

  // Phase 3-17: Load agent roles
  try {
    roles = await window.shellApi.rolesLoad()
  } catch { roles = [] }

  // Phase 4-23: React Grab (Cmd+Shift+G) — capture hovered element from a browser tile
  // and send its innerText/outerHTML to the most recently focused terminal tile.
  let lastFocusedTerminalId: string | null = null
  // Track terminal focus
  document.addEventListener('focusin', () => {
    if (focusedTileId) {
      const t = tiles.find((x) => x.id === focusedTileId)
      if (t?.type === 'terminal') lastFocusedTerminalId = t.id
    }
  })
  document.addEventListener('keydown', async (e) => {
    if (!(e.metaKey && e.shiftKey && (e.key === 'g' || e.key === 'G'))) return
    e.preventDefault()
    if (!focusedTileId) return
    const tile = tiles.find((x) => x.id === focusedTileId)
    if (!tile || tile.type !== 'browser') return
    const wv = webviews.get(tile.id)
    if (!wv) return
    try {
      const result = await (wv.webview as any).executeJavaScript(`
        (function() {
          const el = document.activeElement || document.documentElement;
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            text: (el.innerText || '').slice(0, 2000),
            html: el.outerHTML.slice(0, 4000),
            url: location.href,
          }
        })()
      `)
      // Find target terminal (last focused, or first connected terminal)
      let targetId = lastFocusedTerminalId
      if (!targetId) {
        const conn = connections.find((c) => c.from === tile.id || c.to === tile.id)
        if (conn) {
          const other = conn.from === tile.id ? conn.to : conn.from
          const otherTile = tiles.find((t) => t.id === other)
          if (otherTile?.type === 'terminal') targetId = other
        }
      }
      if (!targetId) return
      const targetWv = webviews.get(targetId)
      if (!targetWv) return
      const blob = `\n[from ${result.url}]\n${result.text}\n`
      ;(targetWv.webview as any).send('cmux:write-to-pty', blob)
      logCanvasEvent({ ts: Date.now(), kind: 'react-grab', tileId: tile.id, payload: { url: result.url, tag: result.tag } })
    } catch {}
  })

  // Phase 4-22: Keyboard shortcut engine with chord support
  let keymap: Record<string, string> = {}
  try { keymap = await window.shellApi.keymapLoad() } catch { keymap = {} }
  setupKeybindings(keymap)

  // Phase 4-24: kanvas CLI request handler
  window.shellApi.onCliRequest(async (id, method, params: any) => {
    try {
      const result = await handleCliMethod(method, params ?? {})
      window.shellApi.cliRespond(id, result, null)
    } catch (err) {
      window.shellApi.cliRespond(id, null, (err as Error).message)
    }
  })

  // Phase 1b-30: Theme system — load pref and apply
  const savedTheme = (await window.shellApi.getPref('theme') as 'dark' | 'light' | undefined) ?? 'dark'
  document.body.setAttribute('data-theme', savedTheme)
  // Cmd+Shift+T toggles theme
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault()
      const cur = document.body.getAttribute('data-theme') ?? 'dark'
      const next = cur === 'dark' ? 'light' : 'dark'
      document.body.setAttribute('data-theme', next)
      window.shellApi.setPref('theme', next)
    }
  })

  // Phase 3-18: Cmd+L to start connection from focused tile
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      if (!focusedTileId) return
      e.preventDefault()
      startDrafting(focusedTileId)
    }
    if (e.key === 'Escape' && draftingConnection) {
      cancelDrafting()
    }
    // Phase 3-19: Cmd+D to toggle draw mode
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault()
      toggleDrawMode()
    }
    if (e.key === 'Escape' && drawMode) toggleDrawMode()
  })

  // Phase 3-19: record freehand drawing when in draw mode
  drawLayer.addEventListener('mousedown', (e) => {
    if (!drawMode) return
    e.preventDefault()
    e.stopPropagation()
    const rect = panelViewer.getBoundingClientRect()
    const cx = (e.clientX - rect.left - panX) / zoom
    const cy = (e.clientY - rect.top - panY) / zoom
    currentShape = {
      id: `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'free',
      points: [[cx, cy]],
      color: 'rgba(255,200,80,0.9)',
      width: 3,
    }
    const onMove = (ev: MouseEvent) => {
      if (!currentShape) return
      const nx = (ev.clientX - rect.left - panX) / zoom
      const ny = (ev.clientY - rect.top - panY) / zoom
      const last = currentShape.points[currentShape.points.length - 1]
      if (Math.abs(nx - last[0]) + Math.abs(ny - last[1]) > 1.5) {
        currentShape.points.push([nx, ny])
        drawShapes()
      }
    }
    const onUp = () => {
      if (currentShape && currentShape.points.length > 1) {
        shapes.push(currentShape)
        scheduleSave()
      }
      currentShape = null
      drawShapes()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
  // Track mouse for drafting line
  panelViewer.addEventListener('mousemove', (e) => {
    if (draftingConnection) {
      const rect = panelViewer.getBoundingClientRect()
      draftingMouse = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      drawConnections()
    }
  })
  // Click on tile while drafting completes the connection
  // Use document-level capture to catch clicks even inside tile content areas
  // that call stopPropagation (filetree, note textarea, etc.)
  document.addEventListener('mousedown', (e) => {
    if (!draftingConnection) return
    const target = (e.target as HTMLElement).closest('.canvas-tile') as HTMLElement | null
    if (target) {
      const id = target.dataset.tileId
      if (id) {
        e.preventDefault()
        e.stopPropagation()
        completeDraftingTo(id)
        return
      }
    }
    // Click on empty canvas or nav → cancel
    if (!(e.target as HTMLElement).closest('.quick-create-menu')) {
      cancelDrafting()
    }
  }, true)  // capture phase

  // Phase 2-11: Canvas-level right sidebar terminal (Cmd+J toggles)
  const rightPanel = document.getElementById('panel-right')!
  const rightToggle = document.getElementById('right-toggle')!
  let rightTerminalCreated = false
  const openRightPanel = () => {
    rightPanel.classList.add('open')
    rightToggle.classList.add('active')
    if (!rightTerminalCreated) {
      const host = document.getElementById('right-terminal-host')!
      const config = viewConfig['terminalTile']
      if (config) {
        const wv = document.createElement('webview')
        wv.setAttribute('src', config.src)
        wv.setAttribute('preload', config.preload)
        wv.setAttribute('webpreferences', 'contextIsolation=yes')
        wv.style.cssText = 'width:100%;height:100%;border:none;'
        host.appendChild(wv)
        rightTerminalCreated = true
      }
    }
  }
  const closeRightPanel = () => {
    rightPanel.classList.remove('open')
    rightToggle.classList.remove('active')
  }
  rightToggle.addEventListener('click', () => {
    if (rightPanel.classList.contains('open')) closeRightPanel()
    else openRightPanel()
  })
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault()
      if (rightPanel.classList.contains('open')) closeRightPanel()
      else openRightPanel()
    }
  })

  // Nav resize
  setupNavResize()

  // Workspace dropdown
  setupWorkspaceDropdown()

  // Loading done
  window.shellApi.onLoadingDone(() => {
    document.getElementById('loading-overlay')!.classList.add('hidden')
  })

  // Nav toggle
  let navVisible = true
  const navToggleBtn = document.getElementById('nav-toggle')!
  const navEl = document.getElementById('panel-nav')!
  const navResizeEl = document.getElementById('nav-resize')!

  function applyNavVisibility(): void {
    if (navVisible) {
      navEl.style.display = ''
      navEl.style.flex = '0 0 260px'
      navResizeEl.style.display = ''
      navToggleBtn.title = 'Hide Navigator'
    } else {
      navEl.style.display = 'none'
      navResizeEl.style.display = 'none'
      navToggleBtn.title = 'Show Navigator'
    }
  }

  navToggleBtn.addEventListener('click', () => {
    navVisible = !navVisible
    applyNavVisibility()
  })

  // Settings backdrop close
  document.getElementById('settings-backdrop')!.addEventListener('click', () => {
    window.shellApi.closeSettings()
  })

  // Keyboard shortcuts
  window.shellApi.onShortcut((action) => {
    handleShortcut(action)
  })

  // Canvas interactions
  setupCanvasInteractions()

  // Pinch zoom from trackpad (forwarded from webviews)
  window.shellApi.onCanvasPinch((deltaY) => {
    applyZoom(deltaY)
  })

  // ─── cmux internal handlers ───────────────────────────────────────
  setupCmuxHandlers()

  // Zoom controls
  const zoomControls = document.getElementById('zoom-controls')!
  zoomControls.addEventListener('mousedown', (e) => e.stopPropagation())
  zoomControls.addEventListener('dblclick', (e) => e.stopPropagation())
  zoomControls.addEventListener('pointerdown', (e) => e.stopPropagation())
  document.getElementById('zoom-in')!.addEventListener('click', (e) => { e.stopPropagation(); applyZoom(-50) })
  document.getElementById('zoom-out')!.addEventListener('click', (e) => { e.stopPropagation(); applyZoom(50) })
  document.getElementById('zoom-reset')!.addEventListener('click', (e) => { e.stopPropagation(); resetView() })

  // Phase 1b-25: New-tile FAB (top-right) with dropdown menu
  const fab = document.getElementById('new-tile-fab')!
  const fabMenu = document.getElementById('new-tile-menu')!
  fab.addEventListener('mousedown', (e) => e.stopPropagation())
  fab.addEventListener('click', (e) => {
    e.stopPropagation()
    fabMenu.classList.toggle('open')
  })
  fabMenu.querySelectorAll('button[data-kind]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const kind = (btn as HTMLButtonElement).dataset.kind as Tile['type']
      const rect = panelViewer.getBoundingClientRect()
      const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.terminal.w / 2
      const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.terminal.h / 2
      if (kind === 'terminal' || kind === 'note' || kind === 'browser' || kind === 'filetree') {
        const tile = createCanvasTile(kind, snapToGrid(cx), snapToGrid(cy))
        if (kind === 'filetree') {
          window.shellApi.getWorkspacePath().then((wp) => {
            if (wp) { tile.folderPath = wp; scheduleSave() }
          })
        }
      }
      fabMenu.classList.remove('open')
    })
  })
  document.addEventListener('mousedown', (e) => {
    if (!fabMenu.contains(e.target as Node) && !fab.contains(e.target as Node)) {
      fabMenu.classList.remove('open')
    }
  })

  // Resize observer for grid redraw
  const ro = new ResizeObserver(() => drawGrid())
  ro.observe(panelViewer)

  // Load saved state
  await loadCanvasState()

  // If no tiles exist, create a default terminal
  if (tiles.length === 0) {
    const rect = panelViewer.getBoundingClientRect()
    const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.terminal.w / 2
    const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.terminal.h / 2
    createCanvasTile('terminal', snapToGrid(cx), snapToGrid(cy))
  }

  drawGrid()
  updateZoomIndicator()
}

// ─── Canvas state persistence ────────────────────────────────────────

async function loadCanvasState(): Promise<void> {
  try {
    const raw = await window.shellApi.canvasLoadState()
    if (!raw || typeof raw !== 'object') return
    const state = raw as CanvasState & { centerX?: number; centerY?: number }
    if (Array.isArray(state.tiles)) {
      zoom = state.zoom ?? 1
      nextZ = state.nextZ ?? 1
      // Phase 2-8: prefer centerpoint-based viewport restoration if present
      if (typeof state.centerX === 'number' && typeof state.centerY === 'number') {
        const rect = panelViewer.getBoundingClientRect()
        panX = rect.width / 2 - state.centerX * zoom
        panY = rect.height / 2 - state.centerY * zoom
      } else {
        panX = state.panX ?? 0
        panY = state.panY ?? 0
      }
      for (const t of state.tiles) {
        tiles.push(t)
        renderTileElement(t)
        // Phase 3-17: restore role badge
        if (t.roleId) assignRoleToTile(t, t.roleId)
      }
      // Phase 3-15: restore connections
      if (Array.isArray(state.connections)) {
        connections = state.connections
      }
      // Phase 3-19: restore shapes
      if (Array.isArray(state.shapes)) {
        shapes = state.shapes
      }
      applyCanvasTransform()
    }
  } catch { /* first run, no state */ }
}

function scheduleSave(): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    // Phase 2-8: save centerpoint so viewport survives window resize
    const rect = panelViewer.getBoundingClientRect()
    const centerX = (rect.width / 2 - panX) / zoom
    const centerY = (rect.height / 2 - panY) / zoom
    const state: CanvasState & { centerX: number; centerY: number } = {
      panX, panY, zoom, tiles, nextZ, centerX, centerY,
      connections, shapes,
    }
    window.shellApi.canvasSaveState(state)
  }, 500)
}

// ─── Grid drawing ────────────────────────────────────────────────────

function drawGrid(): void {
  const dpr = window.devicePixelRatio || 1
  const w = panelViewer.clientWidth
  const h = panelViewer.clientHeight
  gridCanvas.width = w * dpr
  gridCanvas.height = h * dpr
  gridCanvas.style.width = `${w}px`
  gridCanvas.style.height = `${h}px`
  gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

  gridCtx.clearRect(0, 0, w, h)

  const step = GRID_CELL * zoom
  const majorStep = 80 * zoom // every 4th cell
  if (step < 4) return

  // Phase 2b-32: fade dots as we zoom out
  const zoomFade = Math.max(0, Math.min(1, (zoom - 0.4) / 0.3))
  if (zoomFade <= 0) return

  const dotOffX = ((panX % step) + step) % step
  const dotOffY = ((panY % step) + step) % step
  const dotSize = Math.max(1, 1.5 * zoom)

  // Phase 2b-32: compute tile cutout rects in screen space to skip dots under tiles
  const cutouts: Array<[number, number, number, number]> = []
  for (const t of tiles) {
    const sx = t.x * zoom + panX
    const sy = t.y * zoom + panY
    const sw = t.width * zoom
    const sh = t.height * zoom
    if (sx + sw < 0 || sy + sh < 0 || sx > w || sy > h) continue
    cutouts.push([sx, sy, sx + sw, sy + sh])
  }
  const isCutout = (x: number, y: number): boolean => {
    for (const [x1, y1, x2, y2] of cutouts) {
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) return true
    }
    return false
  }

  // Minor dots
  gridCtx.fillStyle = `rgba(255,255,255,${0.22 * zoomFade})`
  for (let x = dotOffX; x <= w; x += step) {
    for (let y = dotOffY; y <= h; y += step) {
      if (isCutout(x, y)) continue
      gridCtx.fillRect(Math.round(x), Math.round(y), dotSize, dotSize)
    }
  }

  // Major dots
  const majOffX = ((panX % majorStep) + majorStep) % majorStep
  const majOffY = ((panY % majorStep) + majorStep) % majorStep
  gridCtx.fillStyle = `rgba(255,255,255,${0.40 * zoomFade})`
  for (let x = majOffX; x <= w; x += majorStep) {
    for (let y = majOffY; y <= h; y += majorStep) {
      if (isCutout(x, y)) continue
      gridCtx.fillRect(Math.round(x), Math.round(y), dotSize, dotSize)
    }
  }
}

// ─── Zoom (Collaborator-style: exponential + rubber-band) ───────────

function snapBackZoom(): void {
  const fx = lastZoomFocalX
  const fy = lastZoomFocalY
  const target = zoom > ZOOM_MAX ? ZOOM_MAX : ZOOM_MIN

  function animate() {
    const prevScale = zoom
    zoom += (target - zoom) * 0.15
    if (Math.abs(zoom - target) < 1e-3) zoom = target

    const ratio = zoom / prevScale - 1
    panX -= (fx - panX) * ratio
    panY -= (fy - panY) * ratio

    applyCanvasTransform()
    drawGrid()
    updateZoomIndicator()

    if (zoom === target) {
      zoomSnapRaf = null
      scheduleSave()
      return
    }
    zoomSnapRaf = requestAnimationFrame(animate)
  }
  zoomSnapRaf = requestAnimationFrame(animate)
}

function applyZoom(deltaY: number, focalX?: number, focalY?: number): void {
  if (zoomSnapRaf) {
    cancelAnimationFrame(zoomSnapRaf)
    zoomSnapRaf = null
  }
  if (zoomSnapTimer) clearTimeout(zoomSnapTimer)

  const rect = panelViewer.getBoundingClientRect()
  const fx = focalX ?? rect.width / 2
  const fy = focalY ?? rect.height / 2

  const prevScale = zoom
  let factor = Math.exp(-deltaY * 0.6 / 100)

  // Rubber-band damping at limits
  if (zoom >= ZOOM_MAX && factor > 1) {
    const overshoot = zoom / ZOOM_MAX - 1
    const damping = 1 / (1 + overshoot * ZOOM_RUBBER_BAND_K)
    factor = 1 + (factor - 1) * damping
  } else if (zoom <= ZOOM_MIN && factor < 1) {
    const overshoot = ZOOM_MIN / zoom - 1
    const damping = 1 / (1 + overshoot * ZOOM_RUBBER_BAND_K)
    factor = 1 - (1 - factor) * damping
  }

  zoom *= factor

  const ratio = zoom / prevScale - 1
  panX -= (fx - panX) * ratio
  panY -= (fy - panY) * ratio

  lastZoomFocalX = fx
  lastZoomFocalY = fy

  // Snap back if overshot
  if (zoom > ZOOM_MAX || zoom < ZOOM_MIN) {
    zoomSnapTimer = setTimeout(snapBackZoom, 150)
  }

  applyCanvasTransform()
  drawGrid()
  updateZoomIndicator()
  scheduleSave()
}

function updateZoomIndicator(): void {
  zoomIndicator.textContent = `${Math.round(zoom * 100)}%`
}

function applyCanvasTransform(): void {
  tileLayer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`
  tileLayer.style.transformOrigin = '0 0'
  // conn-layer and draw-layer are inside tile-layer, so they inherit the transform
  drawConnections()
  drawShapes()
}

// Phase 3-19: Drawing layer
function drawShapes(): void {
  if (!drawLayer) return
  // Use canvas space (draw-layer has same CSS transform as tile-layer)
  drawLayer.setAttribute('viewBox', '0 0 10000 10000')
  while (drawLayer.firstChild) drawLayer.removeChild(drawLayer.firstChild)
  const allShapes = currentShape ? [...shapes, currentShape] : shapes
  for (const shape of allShapes) {
    if (shape.points.length < 2) continue
    const d = shape.points
      .map(([cx, cy], i) => {
        return `${i === 0 ? 'M' : 'L'} ${cx.toFixed(1)} ${cy.toFixed(1)}`
      })
      .join(' ')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('stroke', shape.color)
    path.setAttribute('stroke-width', String(shape.width))
    path.classList.add('shape')
    path.setAttribute('data-shape-id', shape.id)
    path.addEventListener('click', (e) => {
      if (drawMode) return
      e.stopPropagation()
      shapes = shapes.filter((s) => s.id !== shape.id)
      drawShapes()
      scheduleSave()
    })
    drawLayer.appendChild(path)
  }
}

function toggleDrawMode(): void {
  drawMode = !drawMode
  document.body.classList.toggle('draw-mode', drawMode)
}

// ─── Phase 3-15: Connection rendering ────────────────────────────────

function getTileCenter(tile: Tile): { x: number; y: number } {
  return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 }
}

// Get edge point on tile closest to target point
function getTileEdge(tile: Tile, target: { x: number; y: number }): { x: number; y: number } {
  const cx = tile.x + tile.width / 2
  const cy = tile.y + tile.height / 2
  const dx = target.x - cx
  const dy = target.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)
  const hw = tile.width / 2
  const hh = tile.height / 2
  // Determine which edge to use
  if (absDx / hw > absDy / hh) {
    // horizontal edge
    const t = hw / absDx
    return { x: cx + dx * t, y: cy + dy * t }
  } else {
    const t = hh / absDy
    return { x: cx + dx * t, y: cy + dy * t }
  }
}

function screenFromCanvas(cx: number, cy: number): { x: number; y: number } {
  return { x: cx * zoom + panX, y: cy * zoom + panY }
}

function drawConnections(): void {
  if (!connLayer) return
  // Use a large viewBox in canvas space (conn-layer has same CSS transform as tile-layer)
  // SVG is inside tile-layer at (0,0), 10000x10000. Canvas coords work directly.
  connLayer.setAttribute('viewBox', '0 0 10000 10000')
  while (connLayer.firstChild) connLayer.removeChild(connLayer.firstChild)
  for (const conn of connections) {
    const from = tiles.find((t) => t.id === conn.from)
    const to = tiles.find((t) => t.id === conn.to)
    if (!from || !to) continue
    // Use tile edge points (not centers) so lines are visible even when tiles are large
    const ac = getTileCenter(from)
    const bc = getTileCenter(to)
    const a = getTileEdge(from, bc)
    const b = getTileEdge(to, ac)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const curvature = 0.3
    const c1x = a.x + dx * curvature
    const c1y = a.y + dy * 0.8
    const c2x = a.x + dx * (1 - curvature)
    const c2y = a.y + dy * 0.2
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`)
    path.classList.add('conn-line')
    path.setAttribute('data-conn-id', conn.id)
    path.addEventListener('click', (e) => {
      e.stopPropagation()
      connections = connections.filter((c) => c.id !== conn.id)
      drawConnections()
      scheduleSave()
    })
    connLayer.appendChild(path)
  }
  // Drafting line (mouse position needs to be in canvas coords)
  if (draftingConnection && draftingMouse) {
    const from = tiles.find((t) => t.id === draftingConnection.fromId)
    if (from) {
      const a = getTileCenter(from)
      // Convert draftingMouse from screen to canvas
      const rect = panelViewer.getBoundingClientRect()
      const mx = (draftingMouse.x - panX) / zoom
      const my = (draftingMouse.y - panY) / zoom
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', `M ${a.x} ${a.y} L ${mx} ${my}`)
      path.classList.add('conn-line', 'drafting')
      connLayer.appendChild(path)
    }
  }
}

let draftingMouse: { x: number; y: number } | null = null

// Phase 3-17: Assign a role to a tile and update badge
function assignRoleToTile(tile: Tile, roleId: string | undefined): void {
  tile.roleId = roleId
  const el = tileElements.get(tile.id)
  if (el) {
    const existingBadge = el.querySelector('.role-badge')
    if (existingBadge) existingBadge.remove()
    if (roleId) {
      const role = roles.find((r) => r.id === roleId)
      if (role) {
        const badge = document.createElement('span')
        badge.className = 'role-badge'
        badge.textContent = `${role.icon} ${role.name}`
        badge.style.cssText = [
          'display:inline-flex',
          'align-items:center',
          'gap:4px',
          'padding:2px 6px',
          'border-radius:4px',
          'font-size:10px',
          'margin-right:4px',
          `background:${role.color}22`,
          `color:${role.color}`,
          'user-select:none',
        ].join(';')
        const titlebar = el.querySelector('.tile-titlebar')
        const titleText = titlebar?.querySelector('.tile-title-text')
        if (titleText && titlebar) {
          titlebar.insertBefore(badge, titleText)
        }
      }
    }
  }
  scheduleSave()
  // If the tile has a terminal session, send a system note via cmux:write-to-pty
  const role = roleId ? roles.find((r) => r.id === roleId) : null
  if (role && tile.type === 'terminal') {
    const wv = webviews.get(tile.id)
    if (wv) {
      const msg = `# Role: ${role.name}\n# ${role.systemPrompt}\n`
      ;(wv.webview as any).send('cmux:write-to-pty', `\n# [kanvas] assigned role: ${role.name} (${role.icon})\n`)
      void msg
    }
  }
}

// Phase 3-16: Send content to connected tiles (prompt + execute)
function sendToConnected(tile: Tile): void {
  const connIds = connections
    .filter((c) => c.from === tile.id || c.to === tile.id)
    .map((c) => (c.from === tile.id ? c.to : c.from))
  if (connIds.length === 0) return
  // Prompt user for message
  const message = window.prompt(`Send to ${connIds.length} connected tile(s):`, '')
  if (!message) return
  for (const targetId of connIds) {
    const target = tiles.find((t) => t.id === targetId)
    if (!target) continue
    if (target.type === 'terminal') {
      const wv = webviews.get(target.id)
      if (wv) (wv.webview as any).send('cmux:write-to-pty', message + '\r')
    } else if (target.type === 'note') {
      target.noteContent = (target.noteContent ?? '') + '\n' + message
      // Trigger a redraw of the note textarea
      const el = tileElements.get(target.id)
      const ta = el?.querySelector('textarea') as HTMLTextAreaElement | null
      if (ta) ta.value = target.noteContent
      scheduleSave()
    }
  }
}

// Phase 4-22: Keybinding engine — supports chorded shortcuts like "mod+k mod+t"
function normalizeKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
  parts.push(k)
  return parts.join('+')
}

function dispatchKeybinding(action: string): boolean {
  switch (action) {
    case 'toggle-theme': {
      const cur = document.body.getAttribute('data-theme') ?? 'dark'
      const next = cur === 'dark' ? 'light' : 'dark'
      document.body.setAttribute('data-theme', next)
      window.shellApi.setPref('theme', next)
      return true
    }
    case 'new-terminal': {
      const rect = panelViewer.getBoundingClientRect()
      const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.terminal.w / 2
      const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.terminal.h / 2
      createCanvasTile('terminal', snapToGrid(cx), snapToGrid(cy))
      return true
    }
    case 'new-note': {
      const rect = panelViewer.getBoundingClientRect()
      const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.note.w / 2
      const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.note.h / 2
      createCanvasTile('note', snapToGrid(cx), snapToGrid(cy))
      return true
    }
    case 'start-connection': {
      if (focusedTileId) startDrafting(focusedTileId)
      return true
    }
    case 'rename-tile': {
      if (!focusedTileId) return false
      const t = tiles.find((x) => x.id === focusedTileId)
      if (!t) return false
      const el = tileElements.get(t.id)
      const rect = el?.getBoundingClientRect()
      if (rect) openTileRenamePopover(t, rect.left, rect.top + 32)
      return true
    }
    default:
      return false
  }
}

function setupKeybindings(keymap: Record<string, string>): void {
  // Invert: key-sequence -> action
  const sequences: Array<{ seq: string[]; action: string }> = []
  for (const [action, binding] of Object.entries(keymap)) {
    const parts = binding.split(/\s+/)
    sequences.push({ seq: parts, action })
  }
  let pending: string[] = []
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  document.addEventListener('keydown', (e) => {
    if (isInputFocused()) return
    const key = normalizeKeyEvent(e)
    pending.push(key)
    if (pendingTimer) clearTimeout(pendingTimer)

    // Check exact match
    const match = sequences.find((s) => s.seq.length === pending.length && s.seq.every((k, i) => k === pending[i]))
    if (match) {
      if (dispatchKeybinding(match.action)) {
        e.preventDefault()
        pending = []
        return
      }
    }
    // Check if pending is a prefix of any longer sequence
    const hasPrefix = sequences.some((s) => s.seq.length > pending.length && s.seq.slice(0, pending.length).every((k, i) => k === pending[i]))
    if (hasPrefix) {
      e.preventDefault()
      pendingTimer = setTimeout(() => { pending = [] }, 800)
    } else {
      pending = []
    }
  })
}

// Phase 4-24: kanvas CLI method dispatcher
async function handleCliMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'tiles.list':
      return tiles.map((t) => ({
        id: t.id, type: t.type, name: tileLabel(t),
        x: t.x, y: t.y, width: t.width, height: t.height,
        cwd: t.cwd, filePath: t.filePath, url: t.url, roleId: t.roleId,
      }))
    case 'tile.get': {
      const t = tiles.find((x) => x.id === params.id)
      if (!t) throw new Error('tile not found')
      return { ...t, name: tileLabel(t) }
    }
    case 'tile.create': {
      const type = (params.type as Tile['type']) ?? 'terminal'
      const rect = panelViewer.getBoundingClientRect()
      const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES[type].w / 2
      const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES[type].h / 2
      const tile = createCanvasTile(type, snapToGrid(cx), snapToGrid(cy))
      if (typeof params.noteContent === 'string') tile.noteContent = params.noteContent
      if (typeof params.cwd === 'string') tile.cwd = params.cwd
      scheduleSave()
      return { id: tile.id, type: tile.type }
    }
    case 'tile.focus': {
      const t = tiles.find((x) => x.id === params.id)
      if (!t) throw new Error('tile not found')
      bringToFront(t.id)
      centerViewportOnTile(t, true)
      return { ok: true }
    }
    case 'note.write': {
      const t = tiles.find((x) => x.id === params.id)
      if (!t || t.type !== 'note') throw new Error('note not found')
      t.noteContent = String(params.content ?? '')
      const el = tileElements.get(t.id)
      const ta = el?.querySelector('textarea') as HTMLTextAreaElement | null
      if (ta) ta.value = t.noteContent
      scheduleSave()
      return { ok: true }
    }
    case 'note.append': {
      const t = tiles.find((x) => x.id === params.id)
      if (!t || t.type !== 'note') throw new Error('note not found')
      t.noteContent = (t.noteContent ?? '') + String(params.content ?? '')
      const el = tileElements.get(t.id)
      const ta = el?.querySelector('textarea') as HTMLTextAreaElement | null
      if (ta) ta.value = t.noteContent
      scheduleSave()
      return { ok: true }
    }
    case 'note.read': {
      const t = tiles.find((x) => x.id === params.id)
      if (!t || t.type !== 'note') throw new Error('note not found')
      return t.noteContent ?? ''
    }
    case 'connection.create': {
      const from = String(params.from ?? '')
      const to = String(params.to ?? '')
      if (!tiles.some((t) => t.id === from) || !tiles.some((t) => t.id === to)) {
        throw new Error('tile not found')
      }
      const conn: Connection = {
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from, to,
      }
      connections.push(conn)
      drawConnections()
      scheduleSave()
      return { id: conn.id }
    }
    case 'terminal.send': {
      const t = tiles.find((x) => x.id === params.id)
      if (!t || t.type !== 'terminal') throw new Error('terminal tile not found')
      const wv = webviews.get(t.id)
      if (!wv) throw new Error('webview not ready')
      ;(wv.webview as any).send('cmux:write-to-pty', String(params.text ?? ''))
      return { ok: true }
    }
    case 'events.list':
      return canvasEventLog.slice(-50).reverse()
    case 'floors.list':
      return await window.shellApi.floorsList()
    case 'floors.create': {
      const sourceDir = String(params.sourceDir ?? '') || (await window.shellApi.getWorkspacePath()) || ''
      if (!sourceDir) throw new Error('sourceDir required')
      const name = String(params.name ?? 'floor')
      const result = await window.shellApi.floorsCreate({
        sourceDir,
        name,
        canvasState: { panX, panY, zoom, tiles, nextZ, connections, shapes },
      })
      if (!result.ok) throw new Error(result.error ?? 'create failed')
      logCanvasEvent({ ts: Date.now(), kind: 'floor.create', payload: { id: result.id, name } })
      return result
    }
    case 'floors.remove': {
      const id = String(params.id ?? '')
      if (!id) throw new Error('id required')
      const result = await window.shellApi.floorsRemove(id)
      logCanvasEvent({ ts: Date.now(), kind: 'floor.remove', payload: { id } })
      return result
    }
    case 'roles.list':
      return roles
    case 'role.assign': {
      const t = tiles.find((x) => x.id === params.id)
      if (!t) throw new Error('tile not found')
      assignRoleToTile(t, String(params.roleId ?? ''))
      return { ok: true }
    }
    default:
      throw new Error(`unknown method: ${method}`)
  }
}

// Phase 3-20 hook: notify connected terminals when a note is edited
function notifyNoteChanged(noteId: string, content: string): void {
  // Find connections where `from` or `to` is the note id
  for (const conn of connections) {
    const otherId = conn.from === noteId ? conn.to : (conn.to === noteId ? conn.from : null)
    if (!otherId) continue
    const otherTile = tiles.find((t) => t.id === otherId)
    if (!otherTile) continue
    if (otherTile.type === 'terminal') {
      // Deliver first line as a system comment; agents can poll or use CLI
      const firstLine = content.split('\n')[0] ?? ''
      const wv = webviews.get(otherTile.id)
      if (wv) {
        ;(wv.webview as any).send('cmux:write-to-pty', '')
        // Actual agent-to-agent note sync is Phase 3-20 + /kanvas CLI
        void firstLine
      }
    }
  }
}

function startDrafting(fromId: string): void {
  draftingConnection = { fromId }
  const tile = tiles.find((t) => t.id === fromId)
  if (tile) {
    const c = getTileCenter(tile)
    const s = screenFromCanvas(c.x, c.y)
    draftingMouse = s
  }
  drawConnections()
}
function cancelDrafting(): void {
  draftingConnection = null
  draftingMouse = null
  drawConnections()
}
function completeDraftingTo(toId: string): void {
  if (!draftingConnection) return
  if (draftingConnection.fromId === toId) { cancelDrafting(); return }
  const conn: Connection = {
    id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: draftingConnection.fromId,
    to: toId,
  }
  connections.push(conn)
  cancelDrafting()
  logCanvasEvent({ ts: Date.now(), kind: 'connection.create', payload: { from: conn.from, to: conn.to } })
  scheduleSave()
}

// ─── Viewport helpers ─────────────────────────────────────────────────

function centerViewportOnTile(tile: Tile, animate = true): void {
  const rect = panelViewer.getBoundingClientRect()
  const targetPanX = rect.width / 2 - (tile.x + tile.width / 2) * zoom
  const targetPanY = rect.height / 2 - (tile.y + tile.height / 2) * zoom
  if (!animate) {
    panX = targetPanX
    panY = targetPanY
    applyCanvasTransform()
    drawGrid()
    scheduleSave()
    return
  }
  const startX = panX
  const startY = panY
  const duration = 280
  const t0 = performance.now()
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / duration)
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
    panX = startX + (targetPanX - startX) * ease
    panY = startY + (targetPanY - startY) * ease
    applyCanvasTransform()
    drawGrid()
    if (p < 1) requestAnimationFrame(step)
    else scheduleSave()
  }
  requestAnimationFrame(step)
}

// ─── Snap ────────────────────────────────────────────────────────────

function snapToGrid(v: number): number {
  return Math.round(v / GRID_CELL) * GRID_CELL
}

// ─── Tile CRUD ───────────────────────────────────────────────────────

function generateTileId(): string {
  return `tile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createCanvasTile(
  type: Tile['type'],
  x: number,
  y: number,
  extra?: { filePath?: string; folderPath?: string; url?: string; width?: number; height?: number }
): Tile {
  const defaults = getDefaultSize(type)
  const tile: Tile = {
    id: generateTileId(),
    type,
    x: snapToGrid(x),
    y: snapToGrid(y),
    width: extra?.width ?? defaults.w,
    height: extra?.height ?? defaults.h,
    zIndex: nextZ++,
    filePath: extra?.filePath,
    folderPath: extra?.folderPath,
    url: extra?.url,
  }

  tiles.push(tile)
  renderTileElement(tile)
  bringToFront(tile.id)
  logCanvasEvent({ ts: Date.now(), kind: 'tile.create', tileId: tile.id, tileName: tileLabel(tile), payload: { type } })

  // If in fullscreen, make new tile fullscreen and show it
  if (isFullscreen) {
    const rect = panelViewer.getBoundingClientRect()
    savedPositions.set(tile.id, { x: tile.x, y: tile.y, width: tile.width, height: tile.height })
    tile.x = 0
    tile.y = 0
    tile.width = rect.width
    tile.height = rect.height
    const el = tileElements.get(tile.id)
    if (el) applyTilePosition(el, tile)
    // Hide previous active, show new
    if (activeFsTileId) {
      const prevEl = tileElements.get(activeFsTileId)
      if (prevEl) prevEl.style.display = 'none'
    }
    activeFsTileId = tile.id
  }

  scheduleSave()
  return tile
}

function removeTile(id: string): void {
  tiles = tiles.filter(t => t.id !== id)
  const el = tileElements.get(id)
  if (el) {
    el.remove()
    tileElements.delete(id)
  }
  // Clean up webview
  const wv = webviews.get(id)
  if (wv) {
    webviews.delete(id)
  }
  if (focusedTileId === id) focusedTileId = null
  selectedTileIds.delete(id)
  scheduleSave()
}

function findTileAtPoint(clientX: number, clientY: number): Tile | null {
  const rect = panelViewer.getBoundingClientRect()
  const canvasX = (clientX - rect.left - panX) / zoom
  const canvasY = (clientY - rect.top - panY) / zoom
  // Find topmost tile (highest zIndex) that contains the point
  let best: Tile | null = null
  for (const tile of tiles) {
    if (canvasX >= tile.x && canvasX <= tile.x + tile.width &&
        canvasY >= tile.y && canvasY <= tile.y + tile.height) {
      if (!best || tile.zIndex > best.zIndex) best = tile
    }
  }
  return best
}

function bringToFront(id: string): void {
  const tile = tiles.find(t => t.id === id)
  if (!tile) return
  tile.zIndex = nextZ++
  const el = tileElements.get(id)
  if (el) el.style.zIndex = `${tile.zIndex}`
  focusedTileId = id
  updateTileFocusStyles()
  scheduleSave()
}

function updateTileFocusStyles(): void {
  for (const [id, el] of tileElements) {
    const titlebar = el.querySelector('.tile-titlebar') as HTMLDivElement | null
    if (titlebar) {
      titlebar.style.background = id === focusedTileId ? '#2a2a2a' : '#1e1e1e'
    }
    el.style.boxShadow = id === focusedTileId
      ? '0 0 0 1px #4a9eff, 0 4px 20px rgba(0,0,0,0.5)'
      : '0 0 0 1px #333, 0 2px 10px rgba(0,0,0,0.3)'
  }
}

// ─── Tile DOM rendering ──────────────────────────────────────────────

function renderTileElement(tile: Tile): void {
  const container = document.createElement('div')
  container.className = `canvas-tile tile-${tile.type}`
  container.dataset.tileId = tile.id
  applyTilePosition(container, tile)
  container.style.cssText += `
    position: absolute;
    border-radius: 6px;
    overflow: hidden;
    background: #1e1e1e;
    display: flex;
    flex-direction: column;
  `
  container.style.zIndex = `${tile.zIndex}`
  container.style.boxShadow = '0 0 0 1px #333, 0 2px 10px rgba(0,0,0,0.3)'

  // Titlebar
  const titlebar = document.createElement('div')
  titlebar.className = 'tile-titlebar'
  titlebar.style.cssText = `
    height: ${TITLEBAR_H}px;
    background: #1e1e1e;
    display: flex;
    align-items: center;
    padding: 0 8px;
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
    border-bottom: 1px solid #333;
  `

  const typeIcon = document.createElement('span')
  typeIcon.style.cssText = 'font-size: 12px; margin-right: 6px; color: #888;'
  typeIcon.textContent = tileIcon(tile.type)

  const titleText = document.createElement('span')
  titleText.className = 'tile-title-text'
  titleText.style.cssText = 'flex: 1; font-size: 12px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
  titleText.textContent = tileLabel(tile)

  const closeBtn = document.createElement('button')
  closeBtn.style.cssText = `
    background: none; border: none; color: #666; font-size: 14px;
    cursor: pointer; width: 20px; height: 20px; display: flex;
    align-items: center; justify-content: center; border-radius: 3px;
    padding: 0;
  `
  closeBtn.textContent = '\u00d7'
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#ff5f56'; closeBtn.style.color = '#fff' })
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'none'; closeBtn.style.color = '#666' })
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeTile(tile.id) })

  titlebar.appendChild(typeIcon)
  titlebar.appendChild(titleText)
  titlebar.appendChild(closeBtn)

  // Content area — stop mouse events from leaking to canvas/tile drag
  const content = document.createElement('div')
  content.className = 'tile-content'
  content.style.cssText = 'flex: 1; position: relative; overflow: hidden;'
  content.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    bringToFront(tile.id)
  })

  // Drop visual feedback for terminal tiles
  // Actual drop handling is in terminal-tile webview (File.path available with sandbox=false)
  if (tile.type === 'terminal') {
    const dropOverlay = document.createElement('div')
    // pointer-events:none — purely visual, lets drops pass through to webview
    dropOverlay.style.cssText = 'position:absolute;inset:0;z-index:10;display:none;pointer-events:none;'

    container.addEventListener('dragenter', (e) => {
      e.preventDefault()
      dropOverlay.style.display = 'block'
      dropOverlay.style.background = 'rgba(74,158,255,0.1)'
      dropOverlay.style.border = '2px solid #4a9eff'
      dropOverlay.style.borderRadius = '4px'
    })
    container.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && container.contains(e.relatedTarget as Node)) return
      dropOverlay.style.display = 'none'
    })
    container.addEventListener('dragover', (e) => {
      e.preventDefault()
    })
    container.addEventListener('drop', () => {
      dropOverlay.style.display = 'none'
    })

    content.appendChild(dropOverlay)
  }

  // URL bar for browser tiles
  if (tile.type === 'browser') {
    const urlBar = document.createElement('div')
    urlBar.style.cssText = `
      height: 28px; background: #252525; display: flex; align-items: center;
      padding: 0 8px; border-bottom: 1px solid #333; flex-shrink: 0;
    `
    const urlInput = document.createElement('input')
    urlInput.type = 'text'
    urlInput.value = tile.url || ''
    urlInput.placeholder = 'Enter URL...'
    urlInput.style.cssText = `
      flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 3px;
      color: #ccc; padding: 2px 8px; font-size: 12px; outline: none;
    `
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        let url = urlInput.value.trim()
        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url
        }
        const wv = webviews.get(tile.id)
        if (wv) {
          ;(wv.webview as any).loadURL(url)
        }
        tile.url = url
        scheduleSave()
      }
    })
    urlBar.appendChild(urlInput)
    container.appendChild(titlebar)
    container.appendChild(urlBar)
    container.appendChild(content)
  } else {
    container.appendChild(titlebar)
    container.appendChild(content)
  }

  // Resize handles (8 directions)
  createResizeHandles(container, tile)

  // Drag on titlebar
  setupTileDrag(titlebar, tile)

  // Phase 1b-28/29: Right-click titlebar → context menu
  titlebar.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openTileContextMenu(tile, e.clientX, e.clientY)
  })

  // Click to focus
  container.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    bringToFront(tile.id)
    if (e.shiftKey) {
      if (selectedTileIds.has(tile.id)) {
        selectedTileIds.delete(tile.id)
      } else {
        selectedTileIds.add(tile.id)
      }
    } else {
      selectedTileIds.clear()
      selectedTileIds.add(tile.id)
    }
  })

  tileLayer.appendChild(container)
  tileElements.set(tile.id, container)

  // Create webview inside content area
  createTileWebview(tile, content)
}

function applyTilePosition(el: HTMLDivElement, tile: Tile): void {
  el.style.left = `${tile.x}px`
  el.style.top = `${tile.y}px`
  el.style.width = `${tile.width}px`
  el.style.height = `${tile.height}px`
}

function tileIcon(type: Tile['type']): string {
  switch (type) {
    case 'terminal': return '\u25b8'  // >
    case 'graph':    return '\u25c9'  // ◉
    case 'browser':  return '\u25cb'  // ○
    case 'viewer':   return '\u25a1'  // □
    case 'file':     return '\u25a0'  // ■
    case 'note':     return '\u270e'  // ✎
    case 'filetree': return '\u2630'  // ☰
  }
}

let terminalCounter = 0
let browserCounter = 0
let noteCounter = 0
const tileLabelMap = new Map<string, string>()

function tileLabel(tile: Tile): string {
  if (tile.customName) return tile.customName
  if (tileLabelMap.has(tile.id)) return tileLabelMap.get(tile.id)!
  let label: string
  switch (tile.type) {
    case 'terminal': label = `Terminal ${++terminalCounter}`; break
    case 'graph':    label = 'Graph'; break
    case 'browser':  label = tile.url ? new URL(tile.url).hostname : `Browser ${++browserCounter}`; break
    case 'viewer':   label = 'Viewer'; break
    case 'file':     label = tile.filePath?.split('/').pop() || 'File'; break
    case 'note':     label = `Note ${++noteCounter}`; break
    case 'filetree': label = tile.folderPath?.split('/').pop() || 'Files'; break
    default:         label = tile.type
  }
  tileLabelMap.set(tile.id, label)
  return label
}

// Phase 1b-28: Tile rename popover
function openTileRenamePopover(tile: Tile, clientX: number, clientY: number): void {
  const popover = document.getElementById('tile-rename-popover') as HTMLDivElement
  const input = document.getElementById('tile-rename-input') as HTMLInputElement
  popover.style.left = `${clientX}px`
  popover.style.top = `${clientY}px`
  input.value = tile.customName ?? tileLabel(tile)
  popover.classList.add('open')
  input.focus()
  input.select()
  const close = () => {
    popover.classList.remove('open')
    input.removeEventListener('keydown', onKey)
    document.removeEventListener('mousedown', onOutside, true)
  }
  const save = () => {
    const v = input.value.trim()
    tile.customName = v || undefined
    const el = tileElements.get(tile.id)
    const tt = el?.querySelector('.tile-title-text')
    if (tt) tt.textContent = tileLabel(tile)
    scheduleSave()
    close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); save() }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }
  const onOutside = (e: MouseEvent) => {
    if (!popover.contains(e.target as Node)) save()
  }
  input.addEventListener('keydown', onKey)
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 50)
}

// Phase 1b-29: Duplicate a tile
function duplicateTile(tile: Tile): void {
  const clone = createCanvasTile(tile.type, tile.x + 30, tile.y + 30, {
    filePath: tile.filePath,
    folderPath: tile.folderPath,
    url: tile.url,
    width: tile.width,
    height: tile.height,
  })
  if (tile.customName) {
    clone.customName = tile.customName + ' (copy)'
    const el = tileElements.get(clone.id)
    const tt = el?.querySelector('.tile-title-text')
    if (tt) tt.textContent = tileLabel(clone)
  }
  scheduleSave()
}

// Phase 1b-28/29: Right-click context menu on tile titlebar
function openTileContextMenu(tile: Tile, clientX: number, clientY: number): void {
  const menu = document.getElementById('tile-ctx-menu') as HTMLDivElement
  menu.innerHTML = ''
  menu.style.left = `${clientX}px`
  menu.style.top = `${clientY}px`
  const mk = (label: string, action: () => void, opts?: { danger?: boolean }) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    if (opts?.danger) b.style.color = '#f87171'
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      action()
      menu.classList.remove('open')
    })
    menu.appendChild(b)
  }
  const divider = () => {
    const d = document.createElement('div')
    d.className = 'divider'
    menu.appendChild(d)
  }
  mk('Rename…', () => openTileRenamePopover(tile, clientX, clientY))
  mk('Duplicate', () => duplicateTile(tile))
  mk('Bring to Front', () => bringToFront(tile.id))
  divider()
  // Phase 3-18: start connection from this tile
  mk('Start Connection (⌘L)', () => startDrafting(tile.id))
  // Phase 3-16: send current selection / note content to connected tiles
  if (connections.some((c) => c.from === tile.id || c.to === tile.id)) {
    mk('Send to Connected…', () => sendToConnected(tile))
  }
  // Phase 3-17: role assignment submenu (flat for simplicity)
  if (tile.type === 'terminal' && roles.length > 0) {
    divider()
    const currentRoleId = tile.roleId
    for (const r of roles) {
      const label = (r.id === currentRoleId ? '✓ ' : '   ') + `${r.icon} ${r.name}`
      mk(label, () => assignRoleToTile(tile, r.id))
    }
    if (currentRoleId) {
      mk('   Clear Role', () => assignRoleToTile(tile, undefined))
    }
  }
  divider()
  mk('Close', () => removeTile(tile.id), { danger: true })
  menu.classList.add('open')
  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.classList.remove('open')
      document.removeEventListener('mousedown', onOutside, true)
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 50)
}

// ─── Tile webview creation ───────────────────────────────────────────

function createTileWebview(tile: Tile, container: HTMLDivElement): void {
  // Phase 5-12: File Tree Node — inline DOM file browser with git badges
  if (tile.type === 'filetree') {
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'width:100%;height:100%;overflow:auto;background:var(--bg-panel);color:var(--text-primary);font-size:12px;'
    wrapper.addEventListener('mousedown', (e) => e.stopPropagation())
    container.appendChild(wrapper)

    const toolbar = document.createElement('div')
    toolbar.style.cssText = 'padding:6px 8px;display:flex;gap:4px;border-bottom:1px solid var(--border);align-items:center;'
    const pathLabel = document.createElement('span')
    pathLabel.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted);font-size:11px;'
    pathLabel.textContent = tile.folderPath?.split('/').pop() ?? 'Files'
    toolbar.appendChild(pathLabel)
    wrapper.appendChild(toolbar)

    const list = document.createElement('div')
    list.style.cssText = 'padding:4px 0;'
    wrapper.appendChild(list)

    const folderPath = tile.folderPath || '.'

    async function loadDir(dir: string) {
      list.innerHTML = ''
      pathLabel.textContent = dir.split('/').pop() || dir
      try {
        const entries = await window.shellApi.readDir(dir)
        // Get git status for badge display
        let gitStatus: Record<string, string> = {}
        try {
          const gitResult = await window.shellApi.gitExec(['status', '--porcelain', '-uall', dir])
          if (gitResult?.ok && gitResult.output) {
            for (const line of gitResult.output.split('\n')) {
              if (line.length < 4) continue
              const status = line.slice(0, 2).trim()
              const fp = line.slice(3).trim()
              gitStatus[fp] = status
            }
          }
        } catch {}

        // Parent (..) entry
        if (dir !== '/' && dir !== '.') {
          const row = createFileRow('..', '📁', '', () => {
            const parent = dir.split('/').slice(0, -1).join('/') || '/'
            tile.folderPath = parent
            scheduleSave()
            loadDir(parent)
          })
          list.appendChild(row)
        }

        // Sort: folders first, then files
        const sorted = [...entries].sort((a: any, b: any) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })

        for (const entry of sorted as any[]) {
          const fullPath = `${dir}/${entry.name}`
          const relPath = fullPath.replace(/^\.\//, '')
          const badge = gitStatus[relPath] || ''
          const icon = entry.isDir ? '📁' : '📄'
          const row = createFileRow(entry.name, icon, badge, () => {
            if (entry.isDir) {
              tile.folderPath = fullPath
              scheduleSave()
              loadDir(fullPath)
            } else {
              // Click file → open in viewer
              window.shellApi.selectFile(fullPath)
            }
          }, fullPath)
          list.appendChild(row)
        }
      } catch (err) {
        list.textContent = `Error: ${(err as Error).message}`
      }
    }

    function createFileRow(name: string, icon: string, badge: string, onClick: () => void, dragPath?: string): HTMLDivElement {
      const row = document.createElement('div')
      row.style.cssText = 'padding:3px 8px;display:flex;align-items:center;gap:6px;cursor:pointer;border-radius:3px;'
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover)' })
      row.addEventListener('mouseleave', () => { row.style.background = '' })
      row.addEventListener('click', onClick)

      // Drag file path to terminal
      if (dragPath) {
        row.draggable = true
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('text/plain', dragPath)
        })
      }

      const iconEl = document.createElement('span')
      iconEl.textContent = icon
      iconEl.style.fontSize = '12px'
      row.appendChild(iconEl)

      const nameEl = document.createElement('span')
      nameEl.textContent = name
      nameEl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      row.appendChild(nameEl)

      if (badge) {
        const badgeEl = document.createElement('span')
        badgeEl.textContent = badge
        badgeEl.style.cssText = 'font-size:10px;padding:1px 4px;border-radius:3px;' +
          (badge === 'M' ? 'color:#fbbf24;background:rgba(251,191,36,0.15);' :
           badge === '?' || badge === '??' ? 'color:#6ee7b7;background:rgba(110,231,183,0.15);' :
           badge === 'D' ? 'color:#f87171;background:rgba(248,113,113,0.15);' :
           badge === 'A' ? 'color:#60a5fa;background:rgba(96,165,250,0.15);' :
           'color:var(--text-muted);')
        row.appendChild(badgeEl)
      }
      return row
    }

    loadDir(folderPath)
    return
  }

  if (tile.type === 'note') {
    // Phase 3-14: Sticky Note — textarea bound to tile.noteContent, persisted via canvas state
    // If tile.filePath is set, load/save from disk; otherwise keep in canvas state
    const textarea = document.createElement('textarea')
    textarea.style.cssText = `
      width: 100%; height: 100%; background: var(--bg-panel); color: var(--text-primary);
      border: none; outline: none; resize: none; padding: 12px;
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px;
      line-height: 1.6;
    `
    textarea.placeholder = '# Note\n\nType your notes here...'
    textarea.addEventListener('mousedown', (e) => e.stopPropagation())
    container.appendChild(textarea)

    // Hydrate
    textarea.value = tile.noteContent ?? ''

    // Save on input (debounced)
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    textarea.addEventListener('input', () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        tile.noteContent = textarea.value
        scheduleSave()
        notifyNoteChanged(tile.id, textarea.value)
      }, 300)
    })
    return
  }

  let configKey: string
  let src: string | null = null

  switch (tile.type) {
    case 'terminal':
      configKey = 'terminalTile'
      break
    case 'graph':
      configKey = 'graphTile'
      break
    case 'browser':
      configKey = ''  // browser uses direct URL
      break
    case 'viewer':
    case 'file':
      configKey = 'viewer'
      break
    default:
      return
  }

  if (tile.type === 'browser') {
    // Browser tile: create webview with direct URL
    const webview = document.createElement('webview')
    webview.setAttribute('src', tile.url || 'about:blank')
    webview.setAttribute('webpreferences', 'contextIsolation=yes')
    webview.style.cssText = 'width: 100%; height: 100%; border: none;'

    container.appendChild(webview)
    webviews.set(tile.id, { id: tile.id, webview, type: 'browser' })

    webview.addEventListener('did-navigate', (e: any) => {
      tile.url = e.url
      const titleText = tileElements.get(tile.id)?.querySelector('.tile-title-text')
      if (titleText) titleText.textContent = e.url
      scheduleSave()
    })
    return
  }

  const config = viewConfig[configKey]
  if (!config) return

  src = config.src
  if (tile.type === 'terminal') {
    const params: string[] = []
    if (tile.sessionId) params.push(`sessionId=${encodeURIComponent(tile.sessionId)}`)
    if (tile.cwd) params.push(`cwd=${encodeURIComponent(tile.cwd)}`)
    if (params.length) src += `?${params.join('&')}`
  }
  if ((tile.type === 'viewer' || tile.type === 'file') && tile.filePath) {
    src += `?file=${encodeURIComponent(tile.filePath)}`
  }

  const webview = document.createElement('webview')
  webview.setAttribute('src', src)
  webview.setAttribute('preload', config.preload)
  webview.setAttribute('webpreferences', 'contextIsolation=yes')
  webview.style.cssText = 'width: 100%; height: 100%; border: none;'

  container.appendChild(webview)
  webviews.set(tile.id, { id: tile.id, webview, type: configKey })

  webview.addEventListener('ipc-message', (event: any) => {
    if (event.channel === 'pty-session-id') {
      tile.sessionId = event.args?.[0]
      scheduleSave()
    }
    if (event.channel === 'request-remove-tile') {
      removeTile(tile.id)
    }
    // Phase 1b-27: Terminal reports its cwd (OSC 7)
    if (event.channel === 'terminal-cwd-update') {
      const newCwd = event.args?.[0]
      if (typeof newCwd === 'string' && newCwd) {
        tile.cwd = newCwd
        scheduleSave()
      }
    }
    // Phase 4b-34/35: Terminal lifecycle events (OSC 133)
    if (event.channel === 'terminal-event') {
      const kind = event.args?.[0] as string
      const payload = event.args?.[1]
      logCanvasEvent({
        ts: Date.now(),
        kind: `terminal.${kind}`,
        tileId: tile.id,
        tileName: tileLabel(tile),
        payload,
      })
    }
  })
}

// ─── Panel webview (nav, settings) ──────────────────────────────────

function createPanelWebview(type: string, containerId: string): void {
  const config = viewConfig[type]
  if (!config) return
  const container = document.getElementById(containerId)
  if (!container) return

  const webview = document.createElement('webview')
  webview.setAttribute('src', config.src)
  webview.setAttribute('preload', config.preload)
  webview.setAttribute('webpreferences', 'contextIsolation=yes')
  webview.style.cssText = 'width: 100%; height: 100%; border: none;'

  container.appendChild(webview)
  webviews.set(type, { id: type, webview, type })

  webview.addEventListener('ipc-message', (event: any) => {
    // Handle nav events that should create tiles
    if (event.channel === 'open-file') {
      const filePath = event.args?.[0]
      if (filePath) {
        const rect = panelViewer.getBoundingClientRect()
        const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.file.w / 2
        const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.file.h / 2
        createCanvasTile('file', snapToGrid(cx), snapToGrid(cy), { filePath })
      }
    }
  })
}

// ─── Tile drag ───────────────────────────────────────────────────────

function setupTileDrag(titlebar: HTMLDivElement, tile: Tile): void {
  let dragStartX = 0
  let dragStartY = 0
  let tileStartX = 0
  let tileStartY = 0
  let isDragging = false

  // Phase 1-5: double-click titlebar to center viewport on this tile
  titlebar.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    e.stopPropagation()
    centerViewportOnTile(tile, true)
  })

  titlebar.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    if (e.button !== 0) return
    e.preventDefault()

    isDragging = true
    dragStartX = e.clientX
    dragStartY = e.clientY
    tileStartX = tile.x
    tileStartY = tile.y
    titlebar.style.cursor = 'grabbing'

    // Overlay to prevent webview from stealing mouse events
    const overlay = createMouseOverlay()

    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - dragStartX) / zoom
      const dy = (ev.clientY - dragStartY) / zoom
      tile.x = snapToGrid(tileStartX + dx)
      tile.y = snapToGrid(tileStartY + dy)
      const el = tileElements.get(tile.id)
      if (el) {
        el.style.left = `${tile.x}px`
        el.style.top = `${tile.y}px`
      }
      drawGrid()
    }

    const onUp = () => {
      isDragging = false
      titlebar.style.cursor = 'grab'
      overlay.remove()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      scheduleSave()
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
}

// ─── Resize handles ──────────────────────────────────────────────────

function createResizeHandles(container: HTMLDivElement, tile: Tile): void {
  const dirs: { dir: ResizeDir; css: string; cursor: string }[] = [
    { dir: 'n',  css: `top:0;left:${RESIZE_HANDLE_W}px;right:${RESIZE_HANDLE_W}px;height:${RESIZE_HANDLE_W}px;`, cursor: 'ns-resize' },
    { dir: 's',  css: `bottom:0;left:${RESIZE_HANDLE_W}px;right:${RESIZE_HANDLE_W}px;height:${RESIZE_HANDLE_W}px;`, cursor: 'ns-resize' },
    { dir: 'e',  css: `right:0;top:${RESIZE_HANDLE_W}px;bottom:${RESIZE_HANDLE_W}px;width:${RESIZE_HANDLE_W}px;`, cursor: 'ew-resize' },
    { dir: 'w',  css: `left:0;top:${RESIZE_HANDLE_W}px;bottom:${RESIZE_HANDLE_W}px;width:${RESIZE_HANDLE_W}px;`, cursor: 'ew-resize' },
    { dir: 'ne', css: `top:0;right:0;width:${RESIZE_HANDLE_W}px;height:${RESIZE_HANDLE_W}px;`, cursor: 'nesw-resize' },
    { dir: 'nw', css: `top:0;left:0;width:${RESIZE_HANDLE_W}px;height:${RESIZE_HANDLE_W}px;`, cursor: 'nesw-resize' },
    { dir: 'se', css: `bottom:0;right:0;width:${RESIZE_HANDLE_W}px;height:${RESIZE_HANDLE_W}px;`, cursor: 'nwse-resize' },
    { dir: 'sw', css: `bottom:0;left:0;width:${RESIZE_HANDLE_W}px;height:${RESIZE_HANDLE_W}px;`, cursor: 'nwse-resize' },
  ]

  for (const { dir, css, cursor } of dirs) {
    const handle = document.createElement('div')
    handle.className = `resize-handle resize-${dir}`
    handle.style.cssText = `position:absolute;${css}cursor:${cursor};z-index:2;`
    handle.addEventListener('mousedown', (e) => startResize(e, tile, dir))
    container.appendChild(handle)
  }
}

function startResize(e: MouseEvent, tile: Tile, dir: ResizeDir): void {
  e.preventDefault()
  e.stopPropagation()

  const startX = e.clientX
  const startY = e.clientY
  const startTileX = tile.x
  const startTileY = tile.y
  const startW = tile.width
  const startH = tile.height

  const minW = tile.type === 'terminal' ? MIN_TERM_W : MIN_W
  const minH = tile.type === 'terminal' ? MIN_TERM_H : MIN_H

  const overlay = createMouseOverlay()

  const onMove = (ev: MouseEvent) => {
    const dx = (ev.clientX - startX) / zoom
    const dy = (ev.clientY - startY) / zoom

    let newX = startTileX
    let newY = startTileY
    let newW = startW
    let newH = startH

    if (dir.includes('e')) newW = Math.max(minW, startW + dx)
    if (dir.includes('w')) {
      newW = Math.max(minW, startW - dx)
      newX = startTileX + startW - newW
    }
    if (dir.includes('s')) newH = Math.max(minH, startH + dy)
    if (dir.includes('n')) {
      newH = Math.max(minH, startH - dy)
      newY = startTileY + startH - newH
    }

    tile.x = snapToGrid(newX)
    tile.y = snapToGrid(newY)
    tile.width = snapToGrid(newW)
    tile.height = snapToGrid(newH)

    const el = tileElements.get(tile.id)
    if (el) applyTilePosition(el, tile)
    drawGrid()
  }

  const onUp = () => {
    overlay.remove()
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    rememberTileSize(tile.type, tile.width, tile.height)
    scheduleSave()
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ─── Canvas pan & zoom interactions ──────────────────────────────────

function setupCanvasInteractions(): void {
  // Wheel: zoom (Ctrl/pinch) or pan (Shift+scroll or scroll on empty canvas)
  panelViewer.addEventListener('wheel', (e) => {
    const target = e.target as HTMLElement
    const onTile = target.closest('.canvas-tile')

    if (e.ctrlKey) {
      // Trackpad pinch or Ctrl+scroll → zoom
      e.preventDefault()
      const rect = panelViewer.getBoundingClientRect()
      applyZoom(e.deltaY, e.clientX - rect.left, e.clientY - rect.top)
    } else if (!onTile || e.shiftKey) {
      // Scroll on empty canvas, or Shift+scroll on tile → pan canvas
      e.preventDefault()
      panX -= e.deltaX * 1.2
      panY -= e.deltaY * 1.2
      applyCanvasTransform()
      drawGrid()
      scheduleSave()
    }
    // else: scroll on tile → let webview handle it (terminal scroll)
  }, { passive: false })

  // Middle-click pan or space+drag pan
  panelViewer.addEventListener('mousedown', (e) => {
    // Only pan if clicking on the canvas background (not on a tile)
    const target = e.target as HTMLElement
    const isTile = target.closest('.canvas-tile')

    if (e.button === 1 || (e.button === 0 && spaceHeld && !isTile)) {
      e.preventDefault()
      isPanning = true
      panStartX = e.clientX
      panStartY = e.clientY
      panStartPanX = panX
      panStartPanY = panY
      panelViewer.style.cursor = 'grabbing'

      const overlay = createMouseOverlay()

      const onMove = (ev: MouseEvent) => {
        panX = panStartPanX + (ev.clientX - panStartX)
        panY = panStartPanY + (ev.clientY - panStartY)
        applyCanvasTransform()
        drawGrid()
      }

      const onUp = () => {
        isPanning = false
        panelViewer.style.cursor = ''
        overlay.remove()
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        scheduleSave()
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }

    // Click on empty canvas background → deselect
    if (e.button === 0 && !isTile && !spaceHeld) {
      selectedTileIds.clear()
      focusedTileId = null
      updateTileFocusStyles()
    }
  })

  // Space key tracking
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isInputFocused()) {
      e.preventDefault()
      spaceHeld = true
      if (!isPanning) panelViewer.style.cursor = 'grab'
    }
    // Cmd+W to close focused pane/tab/tile (progressive)
    if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
      e.preventDefault()
      if (focusedTileId) {
        const wv = webviews.get(focusedTileId)
        if (wv && wv.type === 'terminal') {
          ;(wv.webview as any).send('close-pane-or-tab')
        } else {
          removeTile(focusedTileId)
        }
      }
    }
  })

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceHeld = false
      if (!isPanning) panelViewer.style.cursor = ''
    }
  })

  // Double-click on background → new terminal
  panelViewer.addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('.canvas-tile')) return
    const rect = panelViewer.getBoundingClientRect()
    const canvasX = (e.clientX - rect.left - panX) / zoom
    const canvasY = (e.clientY - rect.top - panY) / zoom
    createCanvasTile('terminal', snapToGrid(canvasX), snapToGrid(canvasY))
  })

  // Phase 1-6: Quick-create menu — click empty canvas to get instant [+ Terminal] [+ Note]
  let quickMenuEl: HTMLDivElement | null = null
  const closeQuickMenu = () => {
    if (quickMenuEl) {
      quickMenuEl.remove()
      quickMenuEl = null
    }
  }
  const showQuickCreateMenu = (clientX: number, clientY: number, canvasX: number, canvasY: number) => {
    closeQuickMenu()
    const menu = document.createElement('div')
    menu.className = 'quick-create-menu'
    menu.style.cssText = [
      'position:fixed',
      `left:${clientX + 4}px`,
      `top:${clientY + 4}px`,
      'background:rgba(30,30,30,0.95)',
      'border:1px solid #555',
      'border-radius:6px',
      'padding:4px',
      'display:flex',
      'gap:4px',
      'z-index:9999',
      'box-shadow:0 4px 12px rgba(0,0,0,0.4)',
      'font-size:12px',
      'color:#e0e0e0',
      "font-family:'SF Pro', sans-serif",
    ].join(';')
    const mkBtn = (label: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.style.cssText = [
        'background:transparent',
        'border:none',
        'color:inherit',
        'padding:6px 10px',
        'cursor:pointer',
        'border-radius:4px',
        'font-size:inherit',
      ].join(';')
      b.addEventListener('mouseenter', () => { b.style.background = '#3a3a3a' })
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent' })
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        onClick()
        closeQuickMenu()
      })
      return b
    }
    menu.appendChild(mkBtn('+ Terminal', () => {
      createCanvasTile('terminal', snapToGrid(canvasX), snapToGrid(canvasY))
    }))
    menu.appendChild(mkBtn('+ Note', () => {
      createCanvasTile('note', snapToGrid(canvasX), snapToGrid(canvasY))
    }))
    menu.appendChild(mkBtn('✕', () => {}))
    document.body.appendChild(menu)
    quickMenuEl = menu
    const timer = window.setTimeout(closeQuickMenu, 4000)
    const dismiss = (ev: MouseEvent) => {
      if (quickMenuEl && !quickMenuEl.contains(ev.target as Node)) {
        closeQuickMenu()
        window.clearTimeout(timer)
        document.removeEventListener('mousedown', dismiss, true)
      }
    }
    window.setTimeout(() => {
      document.addEventListener('mousedown', dismiss, true)
    }, 100)
  }

  // Track clicks on empty canvas — detect pure clicks (no drag) and show quick menu
  let qmDownX = 0
  let qmDownY = 0
  let qmDownTime = 0
  panelViewer.addEventListener('mousedown', (e) => {
    qmDownX = e.clientX
    qmDownY = e.clientY
    qmDownTime = Date.now()
  }, true)
  panelViewer.addEventListener('mouseup', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('.canvas-tile')) return
    if (target.closest('.quick-create-menu')) return
    if (target.closest('#new-tile-fab')) return
    if (target.closest('#new-tile-menu')) return
    if (target.closest('#tile-ctx-menu')) return
    if (target.closest('#tile-rename-popover')) return
    if (e.button !== 0) return
    if (spaceHeld) return
    if (draftingConnection) return
    const dx = Math.abs(e.clientX - qmDownX)
    const dy = Math.abs(e.clientY - qmDownY)
    const dt = Date.now() - qmDownTime
    // Pure click: minimal movement, short time
    if (dx < 4 && dy < 4 && dt < 300) {
      const rect = panelViewer.getBoundingClientRect()
      const canvasX = (e.clientX - rect.left - panX) / zoom
      const canvasY = (e.clientY - rect.top - panY) / zoom
      showQuickCreateMenu(e.clientX, e.clientY, canvasX, canvasY)
    }
  })

  // Drop files from navigator onto canvas → create file tiles
  panelViewer.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  })
  panelViewer.addEventListener('drop', async (e) => {
    e.preventDefault()
    // Get paths from main process (set by nav webview on dragstart)
    const paths = await window.shellApi.getDragPaths()
    if (!paths || paths.length === 0) return
    const rect = panelViewer.getBoundingClientRect()
    const baseX = (e.clientX - rect.left - panX) / zoom
    const baseY = (e.clientY - rect.top - panY) / zoom
    for (let i = 0; i < paths.length; i++) {
      const filePath = paths[i]
      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      const offset = i * 30
      if (['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext)) {
        createCanvasTile('file', snapToGrid(baseX + offset), snapToGrid(baseY + offset), { filePath })
      } else {
        createCanvasTile('file', snapToGrid(baseX + offset), snapToGrid(baseY + offset), { filePath })
      }
    }
  })

  // Finder file drop onto terminal tiles (document-level to catch drops on webview areas)
  document.addEventListener('dragover', (e) => {
    // Allow drops from Finder (files from OS have types including 'Files')
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  })
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return
    // Check if drop is over a terminal tile by hit-testing coordinates
    const targetTile = findTileAtPoint(e.clientX, e.clientY)
    if (!targetTile || targetTile.type !== 'terminal') return
    e.preventDefault()
    const paths: string[] = []
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      const f = e.dataTransfer.files[i] as any
      if (f.path) paths.push(f.path.includes(' ') ? `'${f.path}'` : f.path)
    }
    if (paths.length > 0) {
      const wv = webviews.get(targetTile.id)
      if (wv) (wv.webview as any).send('cmux:write-to-pty', paths.join(' ') + ' ')
    }
  })

  // Context menu on background
  panelViewer.addEventListener('contextmenu', async (e) => {
    const target = e.target as HTMLElement
    if (target.closest('.canvas-tile')) return
    e.preventDefault()

    const rect = panelViewer.getBoundingClientRect()
    const canvasX = (e.clientX - rect.left - panX) / zoom
    const canvasY = (e.clientY - rect.top - panY) / zoom

    const result = await window.shellApi.showContextMenu([
      { label: 'New Terminal', id: 'new-terminal' },
      { label: 'New Graph', id: 'new-graph' },
      { label: 'New Browser', id: 'new-browser' },
      { label: 'New Note', id: 'new-note' },
      { label: 'Reset View', id: 'reset-view' },
    ])

    if (result === 'new-terminal') createCanvasTile('terminal', snapToGrid(canvasX), snapToGrid(canvasY))
    else if (result === 'new-graph') createCanvasTile('graph', snapToGrid(canvasX), snapToGrid(canvasY))
    else if (result === 'new-browser') createCanvasTile('browser', snapToGrid(canvasX), snapToGrid(canvasY), { url: 'https://google.com' })
    else if (result === 'new-note') createCanvasTile('note', snapToGrid(canvasX), snapToGrid(canvasY))
    else if (result === 'reset-view') resetView()
  })
}

function resetView(): void {
  panX = 0
  panY = 0
  zoom = 1
  applyCanvasTransform()
  drawGrid()
  updateZoomIndicator()
  scheduleSave()
}

// ─── Keyboard shortcuts ──────────────────────────────────────────────

function handleShortcut(action: string): void {
  switch (action) {
    case 'new-terminal': {
      const rect = panelViewer.getBoundingClientRect()
      const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.terminal.w / 2
      const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.terminal.h / 2
      createCanvasTile('terminal', snapToGrid(cx), snapToGrid(cy))
      break
    }
    case 'new-graph': {
      const rect = panelViewer.getBoundingClientRect()
      const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.graph.w / 2
      const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.graph.h / 2
      createCanvasTile('graph', snapToGrid(cx), snapToGrid(cy))
      break
    }
    case 'new-note': {
      const rect = panelViewer.getBoundingClientRect()
      const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.note.w / 2
      const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.note.h / 2
      createCanvasTile('note', snapToGrid(cx), snapToGrid(cy))
      break
    }
    case 'close-tile': {
      if (focusedTileId) removeTile(focusedTileId)
      break
    }
    case 'zoom-in':
      applyZoom(-50)
      break
    case 'zoom-out':
      applyZoom(50)
      break
    case 'zoom-reset':
      resetView()
      break
    case 'toggle-settings':
      window.shellApi.openSettings()
      break
    case 'toggle-theme': {
      const cur = document.body.getAttribute('data-theme') ?? 'dark'
      const next = cur === 'dark' ? 'light' : 'dark'
      document.body.setAttribute('data-theme', next)
      window.shellApi.setPref('theme', next)
      break
    }
    case 'toggle-draw':
      toggleDrawMode()
      break
    case 'toggle-right-panel': {
      const rp = document.getElementById('panel-right')!
      if (rp.classList.contains('open')) {
        rp.classList.remove('open')
        document.getElementById('right-toggle')?.classList.remove('active')
      } else {
        rp.classList.add('open')
        document.getElementById('right-toggle')?.classList.add('active')
      }
      break
    }
    case 'start-connection':
      if (focusedTileId) startDrafting(focusedTileId)
      break
  }
}

// ─── Nav resize ──────────────────────────────────────────────────────

function setupNavResize(): void {
  const handle = document.getElementById('nav-resize')!
  const nav = document.getElementById('panel-nav')!
  const toggle = document.getElementById('nav-toggle')!
  let startX = 0
  let startWidth = 0

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    startX = e.clientX
    startWidth = nav.offsetWidth

    const overlay = createMouseOverlay()
    overlay.style.cursor = 'col-resize'

    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(180, Math.min(500, startWidth + (ev.clientX - startX)))
      nav.style.flex = `0 0 ${newWidth}px`
      toggle.style.left = `${newWidth + 8}px`
    }

    const onUp = () => {
      overlay.remove()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
}

// ─── Workspace dropdown ──────────────────────────────────────────────

async function setupWorkspaceDropdown(): Promise<void> {
  const trigger = document.getElementById('workspace-trigger')!
  const nameEl = document.getElementById('workspace-trigger-name')!

  const { workspaces, active } = await window.shellApi.workspaceList()
  if (active >= 0 && active < workspaces.length) {
    const path = workspaces[active]
    nameEl.textContent = path.split('/').pop() || path
  }

  trigger.addEventListener('click', async () => {
    const { workspaces: ws, active: a } = await window.shellApi.workspaceList()
    const items = ws.map((w, i) => ({
      label: `${i === a ? '\u25cf ' : '  '}${w.split('/').pop() || w}`,
      id: `switch-${i}`
    }))
    items.push({ label: '+ Add workspace\u2026', id: 'add' })

    const result = await window.shellApi.showContextMenu(items)
    if (!result) return
    if (result === 'add') {
      await window.shellApi.workspaceAdd()
    } else if (result.startsWith('switch-')) {
      const idx = parseInt(result.slice(7))
      await window.shellApi.workspaceSwitch(idx)
    }
  })

  window.shellApi.onWorkspaceChanged((path) => {
    nameEl.textContent = path.split('/').pop() || path
  })
}

// ─── Utilities ───────────────────────────────────────────────────────

function createMouseOverlay(): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:inherit;'
  document.body.appendChild(overlay)
  return overlay
}

function isInputFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable
}

// ─── Exported API for other modules ──────────────────────────────────

export function createTerminalTile(cwd?: string): void {
  const rect = panelViewer.getBoundingClientRect()
  const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.terminal.w / 2
  const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.terminal.h / 2
  const tile = createCanvasTile('terminal', snapToGrid(cx), snapToGrid(cy))
  if (cwd) {
    tile.cwd = cwd
    scheduleSave()
  }
}

// ─── cmux internal handlers ──────────────────────────────────────────

function setupCmuxHandlers(): void {
  // Split: create a new terminal tile adjacent to the focused tile
  window.shellApi.onCmuxSplit((direction) => {
    const focused = focusedTileId ? tiles.find(t => t.id === focusedTileId) : null
    const GAP = 20

    let x: number, y: number
    if (focused) {
      switch (direction) {
        case 'right':
          x = focused.x + focused.width + GAP
          y = focused.y
          break
        case 'left':
          x = focused.x - DEFAULT_SIZES.terminal.w - GAP
          y = focused.y
          break
        case 'down':
          x = focused.x
          y = focused.y + focused.height + GAP
          break
        case 'up':
          x = focused.x
          y = focused.y - DEFAULT_SIZES.terminal.h - GAP
          break
        default:
          x = focused.x + focused.width + GAP
          y = focused.y
      }
    } else {
      const rect = panelViewer.getBoundingClientRect()
      x = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.terminal.w / 2
      y = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.terminal.h / 2
    }
    const newTile = createCanvasTile('terminal', snapToGrid(x), snapToGrid(y))
    // Pan canvas to show new tile
    const rect = panelViewer.getBoundingClientRect()
    panX = rect.width / 2 - (newTile.x + newTile.width / 2) * zoom
    panY = rect.height / 2 - (newTile.y + newTile.height / 2) * zoom
    applyCanvasTransform()
    drawGrid()
    scheduleSave()
  })

  // New pane: create tile by type
  window.shellApi.onCmuxNewPane((paneType) => {
    const rect = panelViewer.getBoundingClientRect()
    const cx = (-panX + rect.width / 2) / zoom
    const cy = (-panY + rect.height / 2) / zoom

    switch (paneType) {
      case 'browser':
        createCanvasTile('browser', snapToGrid(cx - DEFAULT_SIZES.browser.w / 2), snapToGrid(cy - DEFAULT_SIZES.browser.h / 2), { url: 'https://google.com' })
        break
      case 'note':
        createCanvasTile('note', snapToGrid(cx - DEFAULT_SIZES.note.w / 2), snapToGrid(cy - DEFAULT_SIZES.note.h / 2))
        break
      case 'terminal':
      default:
        createCanvasTile('terminal', snapToGrid(cx - DEFAULT_SIZES.terminal.w / 2), snapToGrid(cy - DEFAULT_SIZES.terminal.h / 2))
        break
    }
  })

  // New workspace
  window.shellApi.onCmuxNewWorkspace(async () => {
    await window.shellApi.workspaceAdd()
  })

  // Send text to focused terminal
  window.shellApi.onCmuxSendText((text) => {
    // Find the focused terminal tile's webview and send PTY write
    if (!focusedTileId) return
    const tile = tiles.find(t => t.id === focusedTileId)
    if (!tile || tile.type !== 'terminal') return
    const wv = webviews.get(tile.id)
    if (wv) {
      ;(wv.webview as any).send('cmux:write-to-pty', text)
    }
  })

  // Open file in viewer tile
  window.shellApi.onCmuxOpenFile((filePath) => {
    const rect = panelViewer.getBoundingClientRect()
    const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.file.w / 2
    const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.file.h / 2
    createCanvasTile('file', snapToGrid(cx), snapToGrid(cy), { filePath })
  })

  // Open URL in kawase browser tile (instead of system browser)
  window.shellApi.onCmuxNewPaneWithUrl((url) => {
    const rect = panelViewer.getBoundingClientRect()
    const cx = (-panX + rect.width / 2) / zoom - DEFAULT_SIZES.browser.w / 2
    const cy = (-panY + rect.height / 2) / zoom - DEFAULT_SIZES.browser.h / 2
    createCanvasTile('browser', snapToGrid(cx), snapToGrid(cy), { url })
  })

  // Fullscreen toggle: expand focused tile to fill canvas, or restore
  // Fullscreen: ALL tiles go fullscreen, switch between them via Sessions
  function enterFullscreenAll(): void {
    isFullscreen = true
    savedViewport = { panX, panY, zoom }
    savedPositions.clear()

    const rect = panelViewer.getBoundingClientRect()

    // Save all positions, resize all to full canvas
    for (const tile of tiles) {
      savedPositions.set(tile.id, { x: tile.x, y: tile.y, width: tile.width, height: tile.height })
      tile.x = 0
      tile.y = 0
      tile.width = rect.width
      tile.height = rect.height
      const el = tileElements.get(tile.id)
      if (el) applyTilePosition(el, tile)
    }

    // Show only focused tile
    activeFsTileId = focusedTileId || tiles[0]?.id || null
    for (const [tid, tel] of tileElements) {
      tel.style.display = tid === activeFsTileId ? '' : 'none'
    }

    panX = 0
    panY = 0
    zoom = 1
    applyCanvasTransform()
    drawGrid()
    updateZoomIndicator()
  }

  function switchFullscreenTile(tileId: string): void {
    if (!isFullscreen) return
    activeFsTileId = tileId
    // Resize to current canvas (in case window was resized)
    const rect = panelViewer.getBoundingClientRect()
    const tile = tiles.find(t => t.id === tileId)
    if (tile) {
      tile.width = rect.width
      tile.height = rect.height
      const el = tileElements.get(tileId)
      if (el) applyTilePosition(el, tile)
    }
    for (const [tid, tel] of tileElements) {
      tel.style.display = tid === tileId ? '' : 'none'
    }
    bringToFront(tileId)
  }

  function exitFullscreenAll(): void {
    // Restore all tile positions
    for (const tile of tiles) {
      const saved = savedPositions.get(tile.id)
      if (saved) {
        tile.x = saved.x
        tile.y = saved.y
        tile.width = saved.width
        tile.height = saved.height
      }
      const el = tileElements.get(tile.id)
      if (el) {
        el.style.display = ''
        applyTilePosition(el, tile)
      }
    }
    panX = savedViewport.panX
    panY = savedViewport.panY
    zoom = savedViewport.zoom
    applyCanvasTransform()
    drawGrid()
    updateZoomIndicator()
    window.dispatchEvent(new Event('resize'))
    isFullscreen = false
    activeFsTileId = null
    savedPositions.clear()
  }

  window.shellApi.onCmuxFullscreen(() => {
    if (isFullscreen) {
      exitFullscreenAll()
    } else {
      enterFullscreenAll()
    }
    scheduleSave()
  })

  // Sessions panel tile focus
  window.shellApi.onTilesFocus((tileId) => {
    if (isFullscreen) {
      switchFullscreenTile(tileId)
    } else {
      bringToFront(tileId)
      const tile = tiles.find(t => t.id === tileId)
      if (tile) {
        const rect = panelViewer.getBoundingClientRect()
        panX = rect.width / 2 - (tile.x + tile.width / 2) * zoom
        panY = rect.height / 2 - (tile.y + tile.height / 2) * zoom
        applyCanvasTransform()
        drawGrid()
        scheduleSave()
      }
    }
    if (!isFullscreen) {
      const tile = tiles.find(t => t.id === tileId)
      if (tile) {
        const rect = panelViewer.getBoundingClientRect()
        panX = rect.width / 2 - (tile.x + tile.width / 2) * zoom
        panY = rect.height / 2 - (tile.y + tile.height / 2) * zoom
        applyCanvasTransform()
        drawGrid()
        scheduleSave()
      }
    }
  })

  // Close tile from session panel
  window.shellApi.onTilesClose((tileId) => {
    removeTile(tileId)
  })

  // Close all tiles
  window.shellApi.onTilesCloseAll(() => {
    const ids = tiles.map(t => t.id)
    for (const id of ids) removeTile(id)
  })

  // Tile list for session panel in nav
  window.shellApi.onTilesListRequest((channel) => {
    const tileList = tiles.map(t => ({
      id: t.id,
      type: t.type,
      sessionId: t.sessionId,
      filePath: t.filePath,
      url: t.url,
      focused: t.id === focusedTileId
    }))
    window.shellApi.sendTilesListResponse(channel, tileList)
  })

}

// ─── Boot ────────────────────────────────────────────────────────────

init()
