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
    }
  }
}

interface ViewConfig {
  [key: string]: { src: string; preload: string }
}

interface Tile {
  id: string
  type: 'terminal' | 'graph' | 'browser' | 'viewer' | 'file' | 'note'
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  filePath?: string
  folderPath?: string
  url?: string
  sessionId?: string
}

interface CanvasState {
  panX: number
  panY: number
  zoom: number
  tiles: Tile[]
  nextZ: number
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
}

// ─── State ───────────────────────────────────────────────────────────

let viewConfig: ViewConfig = {}
const webviews = new Map<string, WebviewEntry>()
const tileElements = new Map<string, HTMLDivElement>()

let tiles: Tile[] = []
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
    const state = raw as CanvasState
    if (Array.isArray(state.tiles)) {
      panX = state.panX ?? 0
      panY = state.panY ?? 0
      zoom = state.zoom ?? 1
      nextZ = state.nextZ ?? 1
      for (const t of state.tiles) {
        tiles.push(t)
        renderTileElement(t)
      }
      applyCanvasTransform()
    }
  } catch { /* first run, no state */ }
}

function scheduleSave(): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    const state: CanvasState = { panX, panY, zoom, tiles, nextZ }
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

  const dotOffX = ((panX % step) + step) % step
  const dotOffY = ((panY % step) + step) % step
  const dotSize = Math.max(1, 1.5 * zoom)

  // Minor dots
  gridCtx.fillStyle = 'rgba(255,255,255,0.22)'
  for (let x = dotOffX; x <= w; x += step) {
    for (let y = dotOffY; y <= h; y += step) {
      gridCtx.fillRect(Math.round(x), Math.round(y), dotSize, dotSize)
    }
  }

  // Major dots
  const majOffX = ((panX % majorStep) + majorStep) % majorStep
  const majOffY = ((panY % majorStep) + majorStep) % majorStep
  gridCtx.fillStyle = 'rgba(255,255,255,0.40)'
  for (let x = majOffX; x <= w; x += majorStep) {
    for (let y = majOffY; y <= h; y += majorStep) {
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
  const defaults = DEFAULT_SIZES[type]
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
  }
}

let terminalCounter = 0
let browserCounter = 0
let noteCounter = 0
const tileLabelMap = new Map<string, string>()

function tileLabel(tile: Tile): string {
  if (tileLabelMap.has(tile.id)) return tileLabelMap.get(tile.id)!
  let label: string
  switch (tile.type) {
    case 'terminal': label = `Terminal ${++terminalCounter}`; break
    case 'graph':    label = 'Graph'; break
    case 'browser':  label = tile.url ? new URL(tile.url).hostname : `Browser ${++browserCounter}`; break
    case 'viewer':   label = 'Viewer'; break
    case 'file':     label = tile.filePath?.split('/').pop() || 'File'; break
    case 'note':     label = `Note ${++noteCounter}`; break
    default:         label = tile.type
  }
  tileLabelMap.set(tile.id, label)
  return label
}

// ─── Tile webview creation ───────────────────────────────────────────

function createTileWebview(tile: Tile, container: HTMLDivElement): void {
  if (tile.type === 'note') {
    const textarea = document.createElement('textarea')
    textarea.style.cssText = `
      width: 100%; height: 100%; background: #1a1a1a; color: #e0e0e0;
      border: none; outline: none; resize: none; padding: 12px;
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px;
      line-height: 1.6;
    `
    textarea.placeholder = 'Type your notes here...'
    textarea.addEventListener('mousedown', (e) => e.stopPropagation())
    container.appendChild(textarea)
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
  if (tile.type === 'terminal' && tile.sessionId) {
    src += `?sessionId=${encodeURIComponent(tile.sessionId)}`
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
  }

  const onUp = () => {
    overlay.remove()
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
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
  createCanvasTile('terminal', snapToGrid(cx), snapToGrid(cy))
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
