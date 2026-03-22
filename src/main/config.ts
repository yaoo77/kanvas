import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

export interface AppConfig {
  workspaces: string[]
  active_workspace: number
  window_state: WindowState | null
  prefs: Record<string, unknown>
}

function configDir(): string {
  return join(app.getPath('home'), '.kawase')
}

function configPath(): string {
  return join(configDir(), 'config.json')
}

export function loadConfig(): AppConfig {
  const dir = configDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const fp = configPath()
  if (!existsSync(fp)) {
    const defaults: AppConfig = {
      workspaces: [],
      active_workspace: -1,
      window_state: null,
      prefs: {}
    }
    writeFileSync(fp, JSON.stringify(defaults, null, 2))
    return defaults
  }

  try {
    return JSON.parse(readFileSync(fp, 'utf-8'))
  } catch {
    return { workspaces: [], active_workspace: -1, window_state: null, prefs: {} }
  }
}

export function saveConfig(config: AppConfig): void {
  const dir = configDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2))
}

export function getPref(config: AppConfig, key: string): unknown {
  return config.prefs?.[key]
}

export function setPref(config: AppConfig, key: string, value: unknown): void {
  if (!config.prefs) config.prefs = {}
  config.prefs[key] = value
  saveConfig(config)
}
