import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

declare global {
  interface Window {
    api: {
      getPref: (key: string) => Promise<unknown>
      setPref: (key: string, value: unknown) => Promise<void>
      getConfig: () => Promise<Record<string, unknown>>
      getAppVersion: () => Promise<string>
      openFolder: () => Promise<string | null>
      close: () => void
    }
  }
}

interface SectionProps {
  title: string
  children: React.ReactNode
}

function Section({ title, children }: SectionProps) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#ccc', textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</h2>
      {children}
    </div>
  )
}

interface ToggleRowProps {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}

function ToggleRow({ label, value, onChange }: ToggleRowProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #333' }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        style={{
          width: 40,
          height: 22,
          borderRadius: 11,
          border: 'none',
          cursor: 'pointer',
          background: value ? '#4a9eff' : '#555',
          position: 'relative',
          transition: 'background 0.2s',
        }}
      >
        <div style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          background: '#fff',
          position: 'absolute',
          top: 2,
          left: value ? 20 : 2,
          transition: 'left 0.2s',
        }} />
      </button>
    </div>
  )
}

function App() {
  const [version, setVersion] = useState('')
  const [fontSize, setFontSize] = useState(13)
  const [showHidden, setShowHidden] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
    window.api.getPref('editor.fontSize').then((v) => { if (typeof v === 'number') setFontSize(v) })
    window.api.getPref('nav.showHidden').then((v) => { if (typeof v === 'boolean') setShowHidden(v) })
    window.api.getPref('theme').then((v) => { if (v === 'dark' || v === 'light') setTheme(v) })
  }, [])

  const updatePref = useCallback((key: string, value: unknown) => {
    window.api.setPref(key, value)
  }, [])

  return (
    <div style={{ padding: 24, maxWidth: 500, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Settings</h1>
        <button
          onClick={() => window.api.close()}
          style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 18 }}
        >
          x
        </button>
      </div>

      <Section title="Appearance">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #333' }}>
          <span style={{ fontSize: 13 }}>Theme</span>
          <select
            value={theme}
            onChange={(e) => {
              const v = e.target.value as 'dark' | 'light'
              setTheme(v)
              updatePref('theme', v)
            }}
            style={{ background: '#333', border: '1px solid #555', color: '#e0e0e0', borderRadius: 4, padding: '4px 8px', fontSize: 13 }}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #333' }}>
          <span style={{ fontSize: 13 }}>Font Size</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => { const v = Math.max(10, fontSize - 1); setFontSize(v); updatePref('editor.fontSize', v) }}
              style={{ background: '#333', border: '1px solid #555', color: '#e0e0e0', borderRadius: 4, width: 28, height: 28, cursor: 'pointer' }}
            >-</button>
            <span style={{ fontSize: 13, minWidth: 24, textAlign: 'center' }}>{fontSize}</span>
            <button
              onClick={() => { const v = Math.min(24, fontSize + 1); setFontSize(v); updatePref('editor.fontSize', v) }}
              style={{ background: '#333', border: '1px solid #555', color: '#e0e0e0', borderRadius: 4, width: 28, height: 28, cursor: 'pointer' }}
            >+</button>
          </div>
        </div>
      </Section>

      <Section title="Navigator">
        <ToggleRow
          label="Show hidden files"
          value={showHidden}
          onChange={(v) => { setShowHidden(v); updatePref('nav.showHidden', v) }}
        />
      </Section>

      <Section title="About">
        <div style={{ fontSize: 13, color: '#888', padding: '8px 0' }}>
          kawase v{version || '...'}
        </div>
      </Section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
