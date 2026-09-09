import { extname } from 'node:path'
import type { ToolExecutionContext } from './types'

// Shared extraction ladder for the MVP document tools (MVP_PLAN.md steps 2–3).
// Binary documents (.pdf/.docx) ride the injected sidecar capability
// (pypdf/python-docx behind POST /document/extract); every other file reads
// as UTF-8 text straight through the guarded fs facade, so text files keep
// working when the intelligence service is down (docs/05 §6).

const SIDECAR_SUFFIXES = new Set(['.pdf', '.docx'])

export function needsSidecarExtraction(path: string): boolean {
  return SIDECAR_SUFFIXES.has(extname(path).toLowerCase())
}

/**
 * Extract plain text for a document. Throws plain-language Errors — tool
 * bodies catch them and answer with ok:false (the wrapper never catches
 * execute exceptions, registry.ts stage 6).
 */
export async function readDocumentText(
  ctx: ToolExecutionContext,
  path: string
): Promise<{ text: string; truncated: boolean }> {
  if (needsSidecarExtraction(path)) {
    if (!ctx.documents) {
      throw new Error(
        'Reading PDF and Word documents needs the intelligence service, which is not running right now.'
      )
    }
    return ctx.documents.extract(path)
  }
  return { text: ctx.fs.readFileSync(path), truncated: false }
}
