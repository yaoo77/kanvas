import { ipcMain, shell } from 'electron'
import { readdir, readFile, writeFile, stat, mkdir, rename, cp } from 'fs/promises'
import { join, dirname, basename, extname } from 'path'
import { existsSync } from 'fs'

export function registerFsHandlers(): void {
  ipcMain.handle('fs:readdir', async (_e, dirPath: string) => {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          path: join(dirPath, e.name),
          isDir: e.isDirectory()
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:readfile', async (_e, filePath: string) => {
    return readFile(filePath, 'utf-8')
  })

  ipcMain.handle('fs:writefile', async (_e, filePath: string, content: string, expectedMtime?: string) => {
    if (expectedMtime) {
      try {
        const s = await stat(filePath)
        if (s.mtime.toISOString() !== expectedMtime) {
          return { ok: false, reason: 'mtime_conflict' }
        }
      } catch {
        // File doesn't exist yet, that's ok
      }
    }
    await writeFile(filePath, content, 'utf-8')
    return { ok: true }
  })

  ipcMain.handle('fs:stat', async (_e, filePath: string) => {
    const s = await stat(filePath)
    return {
      size: s.size,
      mtime: s.mtime.toISOString(),
      ctime: s.birthtime.toISOString(),
      isDirectory: s.isDirectory()
    }
  })

  ipcMain.handle('fs:trash', async (_e, filePath: string) => {
    await shell.trashItem(filePath)
    return { ok: true }
  })

  ipcMain.handle('fs:mkdir', async (_e, dirPath: string) => {
    await mkdir(dirPath, { recursive: true })
    return { ok: true }
  })

  ipcMain.handle('fs:move', async (_e, oldPath: string, newParentDir: string) => {
    const name = basename(oldPath)
    const newPath = join(newParentDir, name)
    if (existsSync(newPath)) {
      return { ok: false, reason: 'exists' }
    }
    await rename(oldPath, newPath)
    return { ok: true, newPath }
  })

  ipcMain.handle('fs:rename', async (_e, oldPath: string, newTitle: string) => {
    const dir = dirname(oldPath)
    const ext = extname(oldPath)
    const newPath = join(dir, newTitle + ext)
    await rename(oldPath, newPath)
    return { ok: true, newPath }
  })

  ipcMain.handle('fs:count-files', async (_e, dirPath: string) => {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.filter((e) => e.isFile() && !e.name.startsWith('.')).length
    } catch {
      return 0
    }
  })

  ipcMain.handle('fs:read-folder-table', async (_e, folderPath: string) => {
    try {
      const entries = await readdir(folderPath, { withFileTypes: true })
      const files = await Promise.all(
        entries
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map(async (e) => {
            const fp = join(folderPath, e.name)
            const s = await stat(fp)
            return {
              path: fp,
              filename: e.name,
              frontmatter: {},
              mtime: s.mtime.toISOString(),
              ctime: s.birthtime.toISOString()
            }
          })
      )
      return { folderPath, files, columns: ['filename', 'mtime'] }
    } catch {
      return { folderPath, files: [], columns: [] }
    }
  })
}
