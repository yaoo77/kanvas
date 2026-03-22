# kanvas

A desktop workspace that combines an infinite canvas with terminal multiplexing. Built by merging [Collaborator](https://github.com/collaborator-ai/collab-public) and [cmux](https://github.com/alumican/cmux-tb) into a single Electron app.

## Features

### Canvas
- Infinite pan & zoom canvas with dot grid background
- Draggable, resizable tiles with z-ordering
- Fullscreen mode (all tiles go fullscreen, switch via Sessions panel)
- Double-click canvas to create terminal, right-click for menu

### Terminal
- Multiple terminal tabs within a single tile
- Unlimited recursive pane splitting (vertical & horizontal)
- Resize handles between panes
- Send Command input bar at the bottom
- Claude Code status line support

### File Management
- File tree with real-time sync (auto-updates on disk changes)
- Search files (recursive, 3 levels deep)
- Create files & folders from sidebar
- Right-click: Show in Finder, Copy Path, Rename, Trash
- Shift+click multi-select with bulk Copy Paths
- File change indicators (blue dot)

### Viewer
- Markdown: Preview/Edit toggle with Cmd+S save
- HTML: Source/Preview toggle with live reload
- PDF: Embedded viewer with zoom controls
- Code: Monaco Editor with syntax highlighting
- Image: Zoom controls

### Git
- Branch display with remote URL management
- Pull (auto stash + conflict resolution)
- Commit & Push (auto pull before push)
- Changed files list with color-coded status
- git init for new repos, remote URL setup

### Sessions Panel
- Create tiles: + Terminal, + Browser, + Note
- Switch between tiles (auto-pans in canvas, switches in fullscreen)
- Fullscreen toggle button

## Tech Stack

- **Electron 33** - Desktop shell
- **React 19** - UI framework
- **TypeScript** - Language
- **@xterm/xterm 6** - Terminal emulation
- **Monaco Editor** - Code editing
- **electron-vite** - Build tooling
- **bun** - Package manager
- **node-pty** - PTY management

## Development

```bash
# Install dependencies
bun install

# Development mode (hot reload)
bun run dev

# Build
bun run build

# Run built app
npx electron ./out/main/index.js

# Package for distribution
bun run package
```

## Project Structure

```
src/
  main/           # Electron main process
    index.ts      # App lifecycle, window, IPC
    config.ts     # ~/.kawase/config.json management
    watcher.ts    # File system watcher
    ipc/
      fs-handlers.ts        # File operations
      pty-handlers.ts       # Terminal PTY management
      cmux-handlers.ts      # Internal command routing
      workspace-handlers.ts # Workspace management
      dialog-handlers.ts    # Native dialogs
      image-handlers.ts     # Image processing (sharp)
  preload/
    shell.ts      # Shell window API bridge
    universal.ts  # All webview API bridge
  renderer/
    shell/        # Canvas tile system (vanilla TS)
    nav/          # File tree + Sessions + Git panels (React)
    viewer/       # File viewer (React)
    terminal/     # Sidebar terminal (React)
    terminal-tile/# Canvas terminal with tabs & splits (React)
    graph-tile/   # Knowledge graph (Canvas API)
    settings/     # Settings panel (React)
  components/
    CmuxToolbar.tsx  # Terminal toolbar
packages/
  shared/         # Shared types
  cmux/           # Command definitions
```

## License

MIT
