import { extname } from 'node:path'
import type { ToolExecutionContext } from './types'

// Shared extraction ladder for the MVP document tools (MVP_PLAN.md steps 2–3).
// Binary documents (.pdf/.docx/.pptx/.xlsx) ride the injected sidecar
// capability (pypdf/python-docx/python-pptx/openpyxl behind POST
// /document/extract); images (.png/.jpg/…) are described by the run's vision
// model via the injected vision capability (pixels never leave main);
// every other file reads as UTF-8 text straight through the guarded fs
// facade, so text files (.txt/.md/.csv) keep working when the intelligence
// service is down (docs/05 §6).

const SIDECAR_SUFFIXES = new Set(['.pdf', '.docx', '.pptx', '.xlsx'])

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff'
}

// 10 MB raw-image ceiling: past it the base64 data URL would be a ~14 MB
// prompt part — refuse with plain language instead of an OOM or a doomed
// model call.
const MAX_IMAGE_BYTES = 10_000_000

export function needsSidecarExtraction(path: string): boolean {
  return SIDECAR_SUFFIXES.has(extname(path).toLowerCase())
}

/** MIME type when the path is a readable image, undefined otherwise. */
export function imageMimeType(path: string): string | undefined {
  return IMAGE_MIME_TYPES[extname(path).toLowerCase()]
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
        'Reading PDF, Word, PowerPoint, and Excel documents needs the intelligence service, which is not running right now.'
      )
    }
    return ctx.documents.extract(path)
  }
  const mimeType = imageMimeType(path)
  if (mimeType) {
    if (!ctx.vision) {
      throw new Error('Reading images needs the AI model, which is not available right now.')
    }
    const data = ctx.fs.readFileBytes(path)
    if (data.length > MAX_IMAGE_BYTES) {
      throw new Error('That image is too large to describe — shrink it below 10 MB first.')
    }
    return { text: await ctx.vision.describeImage({ data, mimeType }), truncated: false }
  }
  return { text: ctx.fs.readFileSync(path), truncated: false }
}
