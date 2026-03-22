import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

declare global {
  interface Window {
    api: {
      readDir: (path: string) => Promise<Array<{ name: string; isDir: boolean; path: string }>>
      readFile: (path: string) => Promise<{ content: string; mtime: string }>
      selectFile: (path: string) => void
      onWorkspaceChanged: (cb: (path: string) => void) => () => void
      getConfig: () => Promise<{ workspacePath?: string }>
    }
  }
}

interface GraphNode {
  id: string
  label: string
  x: number
  y: number
  vx: number
  vy: number
}

interface GraphLink {
  source: string
  target: string
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<GraphNode[]>([])
  const linksRef = useRef<GraphLink[]>([])
  const animRef = useRef<number>(0)
  const [status, setStatus] = useState('Initializing graph...')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const folder = params.get('folder')

    async function loadGraph(rootPath: string) {
      setStatus('Scanning files...')
      const entries = await window.api.readDir(rootPath)
      const mdFiles = entries.filter((e) => !e.isDir && e.name.endsWith('.md'))

      const nodes: GraphNode[] = mdFiles.slice(0, 100).map((f, i) => ({
        id: f.path,
        label: f.name.replace('.md', ''),
        x: 300 + Math.cos(i * 0.5) * (100 + i * 3),
        y: 300 + Math.sin(i * 0.5) * (100 + i * 3),
        vx: 0,
        vy: 0,
      }))

      const nodeSet = new Set(nodes.map((n) => n.label.toLowerCase()))
      const links: GraphLink[] = []

      for (const node of nodes.slice(0, 50)) {
        try {
          const { content } = await window.api.readFile(node.id)
          const wikilinks = content.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g) || []
          for (const wl of wikilinks) {
            const target = wl.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/, '$1').toLowerCase()
            if (nodeSet.has(target)) {
              const targetNode = nodes.find((n) => n.label.toLowerCase() === target)
              if (targetNode) links.push({ source: node.id, target: targetNode.id })
            }
          }
        } catch {
          // skip unreadable files
        }
      }

      nodesRef.current = nodes
      linksRef.current = links
      setStatus(`${nodes.length} nodes, ${links.length} links`)
    }

    if (folder) {
      loadGraph(folder)
    } else {
      window.api.getConfig().then((cfg) => {
        if (cfg.workspacePath) loadGraph(cfg.workspacePath)
        else setStatus('No workspace')
      })
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    function tick() {
      const nodes = nodesRef.current
      const links = linksRef.current
      if (!canvas || !ctx) return

      canvas.width = canvas.offsetWidth * devicePixelRatio
      canvas.height = canvas.offsetHeight * devicePixelRatio
      ctx.scale(devicePixelRatio, devicePixelRatio)
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x
          const dy = nodes[j].y - nodes[i].y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const force = 200 / (dist * dist)
          nodes[i].vx -= (dx / dist) * force
          nodes[i].vy -= (dy / dist) * force
          nodes[j].vx += (dx / dist) * force
          nodes[j].vy += (dy / dist) * force
        }
      }

      const nodeMap = new Map(nodes.map((n) => [n.id, n]))
      for (const link of links) {
        const s = nodeMap.get(link.source)
        const t = nodeMap.get(link.target)
        if (!s || !t) continue
        const dx = t.x - s.x
        const dy = t.y - s.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (dist - 80) * 0.01
        s.vx += (dx / dist) * force
        s.vy += (dy / dist) * force
        t.vx -= (dx / dist) * force
        t.vy -= (dy / dist) * force
      }

      for (const node of nodes) {
        node.vx += (w / 2 - node.x) * 0.001
        node.vy += (h / 2 - node.y) * 0.001
        node.vx *= 0.9
        node.vy *= 0.9
        node.x += node.vx
        node.y += node.vy
      }

      ctx.clearRect(0, 0, w, h)

      ctx.strokeStyle = '#333'
      ctx.lineWidth = 0.5
      for (const link of links) {
        const s = nodeMap.get(link.source)
        const t = nodeMap.get(link.target)
        if (!s || !t) continue
        ctx.beginPath()
        ctx.moveTo(s.x, s.y)
        ctx.lineTo(t.x, t.y)
        ctx.stroke()
      }

      for (const node of nodes) {
        ctx.fillStyle = '#4a9eff'
        ctx.beginPath()
        ctx.arc(node.x, node.y, 4, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = '#888'
        ctx.font = '10px -apple-system, sans-serif'
        ctx.fillText(node.label, node.x + 6, node.y + 3)
      }

      animRef.current = requestAnimationFrame(tick)
    }

    animRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animRef.current)
  }, [])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    for (const node of nodesRef.current) {
      const dx = node.x - x
      const dy = node.y - y
      if (dx * dx + dy * dy < 100) {
        window.api.selectFile(node.id)
        break
      }
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '6px 12px', fontSize: 12, color: '#888', borderBottom: '1px solid #333' }}>
        Graph {status}
      </div>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ flex: 1, cursor: 'crosshair' }}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
