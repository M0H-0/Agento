import { relative } from 'node:path'

// Electron-free helpers for the composer file picker + contextual prompts
// (AGENTS.md: src/main/agent must not import Electron). The IPC layer
// (src/main/ipc/workspace-files.ts) and the renderer picker share this
// filtering/suggestion logic by contract — both sides keep the caps below.

export interface RelativeFileEntry {
  relativePath: string
  isDir: boolean
}

/** Map absolute walk results to workspace-relative forward-slash paths,
 * dropping anything that escapes the root. Case-insensitive substring
 * filter; caps at `limit` and reports truncation. */
export function toRelativeEntries(
  absolutePaths: string[],
  root: string,
  prefix: string,
  limit: number
): { files: RelativeFileEntry[]; truncated: boolean } {
  const needle = prefix.trim().toLowerCase()
  const files: RelativeFileEntry[] = []
  let truncated = absolutePaths.length >= limit
  for (const abs of absolutePaths) {
    const rel = relative(root, abs).split('\\').join('/')
    if (!rel || rel.startsWith('..')) continue
    if (needle && !rel.toLowerCase().includes(needle)) continue
    files.push({ relativePath: rel, isDir: false })
    if (files.length >= limit) {
      truncated = true
      break
    }
  }
  return { files, truncated }
}

export interface PromptSignals {
  pdfCount: number
  distinctExtensions: number
  fileCount: number
  pricingEvidence: boolean
}

/** Derive prompt signals from a relative file list + session-title hits.
 * Pure so both the renderer scanner and tests share the thresholds. */
export function signalsFromFiles(
  files: RelativeFileEntry[],
  pricingInTitles: boolean
): PromptSignals {
  let pdfCount = 0
  const exts = new Set<string>()
  let pricingEvidence = pricingInTitles
  for (const file of files) {
    const rel = file.relativePath
    const base = rel.split('/').pop() ?? rel
    const dot = base.lastIndexOf('.')
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
    if (ext) exts.add(ext)
    if (ext === 'pdf') pdfCount += 1
    if (!pricingEvidence && rel.toLowerCase().includes('pric')) pricingEvidence = true
  }
  return { pdfCount, distinctExtensions: exts.size, fileCount: files.length, pricingEvidence }
}

/** Contextual prompt selection (docs/04 §3.5): evidence-backed chips first,
 * generic fallbacks only when the folder is empty or a signal is absent. */
export function suggestPrompts(signals: PromptSignals): string[] {
  const prompts: string[] = []
  if (signals.pdfCount > 0) {
    prompts.push(
      signals.pdfCount === 1
        ? 'Make a one-page summary of the PDF in this folder'
        : `Make a one-page summary of every PDF in this folder`
    )
  }
  if (signals.distinctExtensions >= 3 || signals.fileCount >= 10) {
    prompts.push('Organize this folder by file type')
  }
  if (signals.pricingEvidence) {
    prompts.push('Where did I write about pricing?')
  }
  if (prompts.length === 0) {
    return ['List the files in this folder', 'What can you help me do here?']
  }
  return prompts.slice(0, 3)
}
