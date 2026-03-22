import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          shell: resolve(__dirname, 'src/preload/shell.ts'),
          universal: resolve(__dirname, 'src/preload/universal.ts')
        }
      }
    }
  },
  renderer: {
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          shell: resolve(__dirname, 'src/renderer/shell/index.html'),
          nav: resolve(__dirname, 'src/renderer/nav/index.html'),
          viewer: resolve(__dirname, 'src/renderer/viewer/index.html'),
          terminal: resolve(__dirname, 'src/renderer/terminal/index.html'),
          'terminal-tile': resolve(__dirname, 'src/renderer/terminal-tile/index.html'),
          'graph-tile': resolve(__dirname, 'src/renderer/graph-tile/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html')
        }
      }
    }
  }
})
