// Contextual prompt selection (gap 3): evidence-backed chips from a light
// workspace + titles scan. Thresholds mirror src/main/agent/workspace-listing.ts
// (the tested canonical copy) — the renderer cannot import that module
// (it pulls node:path, unavailable in the sandboxed renderer), so the two
// are kept in sync by contract, not by import.

export interface ScannedFile {
  relativePath: string
}

const GENERIC_FALLBACKS = ['List the files in this folder', 'What can you help me do here?']

export function suggestPromptsFromScan(files: ScannedFile[], titles: string[]): string[] {
  let pdfCount = 0
  const extensions = new Set<string>()
  let pricingEvidence = titles.some((title) => title.toLowerCase().includes('pric'))
  for (const file of files) {
    const base = file.relativePath.split('/').pop() ?? file.relativePath
    const dot = base.lastIndexOf('.')
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
    if (ext) extensions.add(ext)
    if (ext === 'pdf') pdfCount += 1
    if (!pricingEvidence && file.relativePath.toLowerCase().includes('pric')) {
      pricingEvidence = true
    }
  }
  const prompts: string[] = []
  if (pdfCount === 1) {
    prompts.push('Make a one-page summary of the PDF in this folder')
  } else if (pdfCount > 1) {
    prompts.push('Make a one-page summary of every PDF in this folder')
  }
  if (extensions.size >= 3 || files.length >= 10) {
    prompts.push('Organize this folder by file type')
  }
  if (pricingEvidence) {
    prompts.push('Where did I write about pricing?')
  }
  return prompts.length > 0 ? prompts.slice(0, 3) : [...GENERIC_FALLBACKS]
}

export function genericPrompts(): string[] {
  return [...GENERIC_FALLBACKS]
}
