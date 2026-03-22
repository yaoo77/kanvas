import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

declare global {
  interface Window {
    api: {
      readFile: (path: string) => Promise<string>
      writeFile: (path: string, content: string, expectedMtime?: string) => Promise<{ ok: boolean; reason?: string }>
      getFileStats: (path: string) => Promise<{ size: number; mtime: string }>
      getImageFull: (path: string) => Promise<string>
      getImageThumbnail: (path: string, size: number) => Promise<string>
      resolveImagePath: (ref: string, from: string) => Promise<string>
      onFileSelected: (cb: (path: string) => void) => () => void
      onWorkspaceChanged: (cb: (path: string) => void) => () => void
      onFsChanged: (cb: () => void) => () => void
      getSelectedFile: () => Promise<string | null>
      getConfig: () => Promise<{ workspacePath?: string }>
    }
  }
}

type FileType = 'markdown' | 'image' | 'code' | 'html' | 'pdf' | 'unknown'

function detectFileType(path: string): FileType {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (ext === 'pdf') return 'pdf'
  if ([
    'ts', 'tsx', 'js', 'jsx', 'json', 'py', 'sh', 'bash', 'zsh',
    'yaml', 'yml', 'toml', 'css', 'xml', 'sql', 'rs', 'go',
    'rb', 'lua', 'c', 'cpp', 'h', 'swift', 'kt', 'java', 'txt',
    'cfg', 'ini', 'conf', 'env', 'gitignore', 'dockerfile',
    'makefile', 'csv', 'log'
  ].includes(ext)) return 'code'
  return 'unknown'
}

function getMonacoLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', css: 'css', html: 'html',
    xml: 'xml', sql: 'sql', rs: 'rust', go: 'go', rb: 'ruby', lua: 'lua',
    c: 'c', cpp: 'cpp', h: 'c', swift: 'swift', kt: 'kotlin', java: 'java',
    txt: 'plaintext', csv: 'plaintext', log: 'plaintext',
    cfg: 'ini', ini: 'ini', conf: 'ini', dockerfile: 'dockerfile',
    makefile: 'makefile', md: 'markdown', markdown: 'markdown'
  }
  return map[ext] ?? 'plaintext'
}

/* ── BlockNote Markdown Editor ── */

function MarkdownEditor({ content, filePath }: { content: string; filePath: string }) {
  const pathRef = useRef(filePath)
  pathRef.current = filePath

  // Save handler (Cmd+S)
  const save = useCallback(async () => {
    await window.api.writeFile(pathRef.current, content)
  }, [content])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save])

  return <FallbackMarkdown content={content} />
}

/* ── Markdown renderer ── */

function FallbackMarkdown({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  let inCodeBlock = false
  let codeLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={i} style={{ background: '#1e1e1e', padding: 12, borderRadius: 4, overflow: 'auto', fontSize: 13, margin: '8px 0' }}>
            <code>{codeLines.join('\n')}</code>
          </pre>
        )
        codeLines = []
        inCodeBlock = false
      } else {
        inCodeBlock = true
      }
      continue
    }
    if (inCodeBlock) { codeLines.push(line); continue }
    if (line.startsWith('# ')) {
      elements.push(<h1 key={i} style={{ fontSize: 24, margin: '16px 0 8px', fontWeight: 600 }}>{line.slice(2)}</h1>)
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i} style={{ fontSize: 20, margin: '14px 0 6px', fontWeight: 600 }}>{line.slice(3)}</h2>)
    } else if (line.startsWith('### ')) {
      elements.push(<h3 key={i} style={{ fontSize: 16, margin: '12px 0 4px', fontWeight: 600 }}>{line.slice(4)}</h3>)
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(<li key={i} style={{ marginLeft: 20, fontSize: 14, lineHeight: 1.6 }}>{line.slice(2)}</li>)
    } else if (line.trim() === '') {
      elements.push(<div key={i} style={{ height: 8 }} />)
    } else {
      elements.push(<p key={i} style={{ fontSize: 14, lineHeight: 1.6, margin: '4px 0' }}>{line}</p>)
    }
  }
  return <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>{elements}</div>
}

/* ── Monaco Code Editor ── */

function CodeEditor({ content, filePath }: { content: string; filePath: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)
  const pathRef = useRef(filePath)
  pathRef.current = filePath

  const isReadOnly = content.length > 1_000_000

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false
    let monacoInstance: typeof import('monaco-editor') | null = null

    import('monaco-editor').then((monaco) => {
      if (disposed || !containerRef.current) return
      monacoInstance = monaco

      const ed = monaco.editor.create(containerRef.current, {
        value: content,
        language: getMonacoLanguage(filePath),
        theme: 'vs-dark',
        readOnly: isReadOnly,
        minimap: { enabled: content.length > 5000 },
        fontSize: 13,
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        automaticLayout: true,
        padding: { top: 8 }
      })
      editorRef.current = ed

      // Cmd+S to save
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        const val = ed.getValue()
        try {
          await window.api.writeFile(pathRef.current, val)
        } catch (err) {
          console.error('Save failed:', err)
        }
      })
    }).catch((err) => {
      console.error('Failed to load Monaco:', err)
    })

    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = null
    }
  }, [content, filePath, isReadOnly])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {isReadOnly && (
        <div style={{ padding: '4px 12px', fontSize: 11, color: '#888', background: '#1a1a1a', borderBottom: '1px solid #333' }}>
          Read-only (file &gt; 1MB)
        </div>
      )}
      <div ref={containerRef} style={{ flex: 1 }} />
    </div>
  )
}

/* ── Image Viewer with Zoom ── */

function ImageView({ filePath }: { filePath: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    setZoom(1)
    window.api.getImageFull(filePath).then(setSrc)
  }, [filePath])

  if (!src) return <div style={{ padding: 24, color: '#888' }}>Loading image...</div>

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 12px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid #333', background: '#1a1a1a' }}>
        <button
          onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))}
          style={{ background: '#333', color: '#e0e0e0', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 13 }}
        >
          -
        </button>
        <span style={{ fontSize: 12, color: '#888', minWidth: 50, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
          style={{ background: '#333', color: '#e0e0e0', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 13 }}
        >
          +
        </button>
        <button
          onClick={() => setZoom(1)}
          style={{ background: '#333', color: '#888', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
        >
          Reset
        </button>
        <span style={{ fontSize: 11, color: '#666', marginLeft: 'auto' }}>
          {filePath.split('/').pop()}
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
        <img
          src={src}
          alt={filePath.split('/').pop()}
          style={{ transform: `scale(${zoom})`, transformOrigin: 'center', maxWidth: zoom <= 1 ? '100%' : undefined, transition: 'transform 0.15s ease' }}
        />
      </div>
    </div>
  )
}

/* ── HTML Preview ── */

function HtmlPreview({ content, filePath }: { content: string; filePath: string }) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    setRefreshKey((k) => k + 1)
  }, [content])

  const btnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? '#555' : '#333',
    color: active ? '#fff' : '#888',
    border: 'none',
    borderRadius: 4,
    padding: '2px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
  })

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 12px', display: 'flex', gap: 4, alignItems: 'center', borderBottom: '1px solid #333', background: '#1a1a1a' }}>
        <button onClick={() => setMode('source')} style={btnStyle(mode === 'source')}>Source</button>
        <button onClick={() => setMode('preview')} style={btnStyle(mode === 'preview')}>Preview</button>
        <span style={{ fontSize: 11, color: '#666', marginLeft: 'auto' }}>
          {filePath.split('/').pop()}
        </span>
      </div>
      {mode === 'source' ? (
        <CodeEditor content={content} filePath={filePath} />
      ) : (
        <iframe
          key={refreshKey}
          srcDoc={content}
          sandbox="allow-same-origin"
          style={{ flex: 1, border: 'none', background: '#fff' }}
          title="HTML Preview"
        />
      )}
    </div>
  )
}

/* ── PDF Preview ── */

function PdfPreview({ filePath }: { filePath: string }) {
  const [zoom, setZoom] = useState(1)
  const pdfSrc = `collab-file://${filePath}`

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#1a1a1a' }}>
      <div style={{ padding: '4px 12px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid #333', background: '#1a1a1a' }}>
        <button
          onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
          style={{ background: '#333', color: '#e0e0e0', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 13 }}
        >
          -
        </button>
        <span style={{ fontSize: 12, color: '#888', minWidth: 50, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
          style={{ background: '#333', color: '#e0e0e0', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 13 }}
        >
          +
        </button>
        <button
          onClick={() => setZoom(1)}
          style={{ background: '#333', color: '#888', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
        >
          Reset
        </button>
        <span style={{ fontSize: 11, color: '#666', marginLeft: 'auto' }}>
          {filePath.split('/').pop()}
        </span>
      </div>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'auto', padding: 16 }}>
        <iframe
          src={pdfSrc}
          style={{
            width: `${zoom * 100}%`,
            height: `${zoom * 100}%`,
            border: 'none',
            background: '#fff',
            transformOrigin: 'center',
            transition: 'width 0.15s ease, height 0.15s ease',
          }}
          title="PDF Preview"
        />
      </div>
    </div>
  )
}

/* ── App ── */

function App() {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [fileType, setFileType] = useState<FileType>('unknown')

  const loadFile = useCallback(async (path: string) => {
    setFilePath(path)
    const type = detectFileType(path)
    setFileType(type)
    if (type !== 'image' && type !== 'pdf') {
      try {
        const result = await window.api.readFile(path)
        // readFile may return string or { content, mtime }
        const text = typeof result === 'string' ? result : (result as { content: string }).content
        setContent(text)
      } catch (err) {
        console.error('Failed to read file:', err)
        setContent(null)
        setFileType('unknown')
      }
    } else {
      setContent(null)
    }
  }, [])

  useEffect(() => {
    window.api.getSelectedFile().then((path) => {
      if (path) loadFile(path)
    })

    const unsub = window.api.onFileSelected((path) => {
      loadFile(path)
    })
    return unsub
  }, [loadFile])

  useEffect(() => {
    if (!filePath) return
    const unsub = window.api.onFsChanged(() => {
      // Reload current file on any fs change
      loadFile(filePath)
    })
    return unsub
  }, [filePath, loadFile])

  if (!filePath) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 14 }}>
        Select a file to view
      </div>
    )
  }

  if (fileType === 'image') {
    return <ImageView filePath={filePath} />
  }

  if (fileType === 'pdf') {
    return <PdfPreview filePath={filePath} />
  }

  if (content === null) {
    return <div style={{ padding: 24, color: '#888' }}>Loading...</div>
  }

  if (fileType === 'html') {
    return <HtmlPreview content={content} filePath={filePath} />
  }

  if (fileType === 'markdown') {
    return <MarkdownEditor content={content} filePath={filePath} />
  }

  if (fileType === 'code') {
    return <CodeEditor content={content} filePath={filePath} />
  }

  // Unknown type - try to display as text if it looks like text
  const isBinary = content.includes('\0')
  if (isBinary) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 14 }}>
        Cannot display binary file
      </div>
    )
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }}>
      <pre style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</pre>
    </div>
  )
}

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[viewer] React error:', error.message, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return <div style={{padding: 24, color: '#f88'}}><h3>Viewer Error</h3><pre>{this.state.error.message}</pre></div>
    }
    return this.props.children
  }
}

const rootEl = document.getElementById('root')
if (rootEl) {
  console.log('[viewer] mounting')
  createRoot(rootEl).render(<ErrorBoundary><App /></ErrorBoundary>)
  console.log('[viewer] render scheduled')
}
