import { ipcMain } from 'electron'
import { dirname, resolve, extname } from 'path'

export function registerImageHandlers(): void {
  ipcMain.handle('image:thumbnail', async (_e, filePath: string, _size: number) => {
    try {
      const sharp = require('sharp')
      const buffer = await sharp(filePath)
        .resize(_size, _size, { fit: 'inside' })
        .toBuffer()
      const ext = extname(filePath).slice(1).toLowerCase()
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
      return `data:${mime};base64,${buffer.toString('base64')}`
    } catch {
      return `collab-file://${filePath}`
    }
  })

  ipcMain.handle('image:full', async (_e, filePath: string) => {
    return `collab-file://${filePath}`
  })

  ipcMain.handle('image:resolve-path', async (_e, reference: string, fromNotePath: string) => {
    const dir = dirname(fromNotePath)
    return resolve(dir, reference)
  })

  ipcMain.handle('image:save-dropped', async (_e, noteDir: string, fileName: string, buffer: ArrayBuffer) => {
    const { writeFile, mkdir } = require('fs/promises')
    const imagesDir = resolve(noteDir, 'images')
    await mkdir(imagesDir, { recursive: true })
    const dest = resolve(imagesDir, fileName)
    await writeFile(dest, Buffer.from(buffer))
    return { ok: true, path: dest }
  })
}
