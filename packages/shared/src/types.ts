/* ── Tree ── */

export interface TreeNode {
  path: string
  name: string
  kind: 'folder' | 'file'
  ctime: string
  mtime: string
  frontmatter?: Record<string, unknown>
  preview?: string
  fileCount?: number
  children?: TreeNode[]
}

/* ── Viewer ── */

export interface ViewerItem {
  id: string
  title: string
  type: string
  isEditable: boolean
  isTitleEditable?: boolean
  url?: string
  fileUrl?: string
  summary?: string
  text?: string
  createdAt: number
  modifiedAt: number
  frontmatter?: Record<string, unknown>
}

/* ── File System ── */

export type FileChangeType = 1 | 2 | 3 // Added | Updated | Deleted

export interface FileChange {
  path: string
  type: FileChangeType
}

export interface FsChangeEvent {
  dirPath: string
  changes: FileChange[]
}

export interface FolderTableFile {
  path: string
  filename: string
  frontmatter: Record<string, unknown>
  mtime: string
  ctime: string
}

export interface FolderTableData {
  folderPath: string
  files: FolderTableFile[]
  columns: string[]
}

/* ── Config ── */

export interface AppConfig {
  workspaces: string[]
  active_workspace: number
}

/* ── Graph ── */

export interface GraphNode {
  id: string
  name: string
  path: string
  type: string
  degree?: number
}

export interface GraphLink {
  source: string
  target: string
  type: string
}

export interface WorkspaceGraph {
  nodes: GraphNode[]
  links: GraphLink[]
}

/* ── PTY ── */

export interface PtyDataPayload {
  sessionId: string
  data: string
}

export interface PtyExitPayload {
  sessionId: string
  exitCode: number
  signal?: number
}

/* ── CmuxExec ── */

export interface CmuxResult {
  ok: boolean
  output?: string
  error?: string
}
