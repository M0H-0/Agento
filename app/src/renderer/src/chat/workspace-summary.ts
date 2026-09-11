// Workspace snapshot counts (Workspace Overview): pure derivation from the
// capped `workspace:list-files` result. No node:, no window — the component
// (DOM surface, manual checklist) stays out of vitest; this contract is the
// behavior proof. Extension sets are deliberately small and product-worded
// (Documents / Images / Spreadsheets / Other), never MIME types.

export interface SnapshotFile {
  relativePath: string
  isDir: boolean
}

export interface WorkspaceSnapshot {
  fileCount: number
  folderCount: number
  documents: number
  images: number
  spreadsheets: number
  others: number
}

const DOCUMENT_EXTS = new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'ppt', 'pptx'])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic'])

const SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'csv'])

function extensionOf(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function summarizeWorkspaceFiles(files: SnapshotFile[]): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = {
    fileCount: 0,
    folderCount: 0,
    documents: 0,
    images: 0,
    spreadsheets: 0,
    others: 0
  }
  for (const file of files) {
    if (file.isDir) {
      snapshot.folderCount += 1
      continue
    }
    snapshot.fileCount += 1
    const ext = extensionOf(file.relativePath)
    if (DOCUMENT_EXTS.has(ext)) snapshot.documents += 1
    else if (IMAGE_EXTS.has(ext)) snapshot.images += 1
    else if (SPREADSHEET_EXTS.has(ext)) snapshot.spreadsheets += 1
    else snapshot.others += 1
  }
  return snapshot
}

// Tail of a workspace path for the overview header — same "last two
// segments" treatment as the sidebar chip, so the two never disagree.
export function workspaceTail(path: string): string {
  if (path.length <= 46) return path
  const segments = path.split(/[\\/]/).filter(Boolean)
  return `…\\${segments.slice(-2).join('\\')}`
}
