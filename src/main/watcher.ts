import { watch, FSWatcher } from 'fs'
import { join } from 'path'

export interface WatchEvent {
  path: string
  type: string
}

export function startWatcher(
  workspacePath: string,
  onChange: (events: WatchEvent[]) => void
): () => void {
  let debounceTimeout: NodeJS.Timeout | null = null
  let pendingEvents: WatchEvent[] = []

  const watcher: FSWatcher = watch(
    workspacePath,
    { recursive: true },
    (eventType, filename) => {
      if (!filename || filename.startsWith('.')) return
      pendingEvents.push({
        path: join(workspacePath, filename),
        type: eventType
      })
      if (debounceTimeout) clearTimeout(debounceTimeout)
      debounceTimeout = setTimeout(() => {
        const events = pendingEvents
        pendingEvents = []
        onChange(events)
      }, 300)
    }
  )

  return () => {
    if (debounceTimeout) clearTimeout(debounceTimeout)
    watcher.close()
  }
}
