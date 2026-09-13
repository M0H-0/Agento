import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { wrapTextAsHtml } from '../document-html'

// Format conversion (docs/02 §2.6, docs/03 §5): turn an existing workspace file
// into another format — the "make the same story a .docx/.pdf" path. Result
// shape matches write_file so the WriteFileCard renders it with no new UI.
// Risk mirrors write_file: fresh dest is risk 1, overwrite is risk 2.
//
// Snapshot note (M2.8 doctrine): the destination is computed (same folder,
// swapped extension), not an input key, so the wrapper cannot pre-snapshot it
// — `snapshotFields` returns [] (the read-only source is never snapshotted)
// and execute snapshots the dest explicitly before writing.
const TARGETS = ['docx', 'pdf', 'md', 'txt'] as const
type Target = (typeof TARGETS)[number]

const TEXT_SUFFIXES = new Set(['.txt', '.md', '.markdown', '.html', '.csv'])
const SIDECAR_SUFFIXES = new Set(['.pdf', '.docx', '.pptx', '.xlsx'])

export function destForConvert(sourceAbsPath: string, target: Target): string {
  const dot = sourceAbsPath.lastIndexOf('.')
  const base = dot >= 0 ? sourceAbsPath.slice(0, dot) : sourceAbsPath
  return `${base}.${target}`
}

function blocksOf(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
}

export const convertDocumentTool: ToolDefinition<
  { path: string; target: Target },
  { path: string; size: number; beforeExcerpt: null; afterExcerpt: string }
> = {
  name: 'convert_document',
  description:
    "Convert a workspace file to another format (path relative to the workspace root): target one of docx, pdf, md, txt. Reads .txt/.md/.html directly and .pdf/.docx/.pptx/.xlsx via the intelligence service; writes the converted file next to the source with the new extension. Use this for 'make it a .docx/.pdf' — never an online service or a script.",
  access: 'write',
  inputSchema: z.object({
    path: z.string().min(1),
    target: z.enum(TARGETS)
  }),
  pathFields: ['path'],
  snapshotFields: () => [],
  risk: (input, ctx) => {
    const dest = destForConvert(input.path, input.target)
    return ctx.exists(dest)
      ? { level: 2, reason: 'Overwrites an existing converted file' }
      : { level: 1, reason: 'Creates a new converted file' }
  },
  describe: (input) => ({
    title: `Convert ${basename(input.path)} to .${input.target}`,
    group: 'documents'
  }),
  execute: async (input, ctx) => {
    const failed = (
      error: string
    ): {
      ok: false
      output: { path: string; size: number; beforeExcerpt: null; afterExcerpt: string }
      error: string
    } => ({
      ok: false as const,
      output: { path: input.path, size: 0, beforeExcerpt: null, afterExcerpt: '' },
      error
    })
    const sourceSuffix = extname(input.path).toLowerCase()
    const destSuffix = `.${input.target}`
    if (sourceSuffix === destSuffix || (sourceSuffix === '.markdown' && destSuffix === '.md')) {
      return failed('That file is already in that format — I left it untouched.')
    }
    const readable = TEXT_SUFFIXES.has(sourceSuffix) || SIDECAR_SUFFIXES.has(sourceSuffix)
    if (!readable) {
      return failed(
        'I can convert text files (.txt/.md/.html) and documents (.pdf/.docx/.pptx/.xlsx) — that file is neither, so I left it untouched.'
      )
    }
    if (!ctx.fs.existsSync(input.path)) {
      return failed("I couldn't find that file — it may have been moved or renamed.")
    }
    // Read the source: text directly, binary formats via the sidecar.
    let text: string
    if (TEXT_SUFFIXES.has(sourceSuffix)) {
      text = ctx.fs.readFileSync(input.path)
    } else if (!ctx.documents) {
      return failed(
        'Reading that document needs the intelligence service, which is not running right now.'
      )
    } else {
      try {
        const extracted = await ctx.documents.extract(input.path)
        text = extracted.text
      } catch (error) {
        return failed(error instanceof Error ? error.message : 'That document could not be read.')
      }
    }
    if (!text.trim()) {
      return failed('That file has no readable text to convert — I left it untouched.')
    }
    const title = basename(input.path).replace(/\.[^.]+$/, '') || 'Document'
    const dest = destForConvert(input.path, input.target)
    ctx.snapshot(dest, { tool: 'convert_document' })
    try {
      if (input.target === 'docx') {
        if (!ctx.documents?.create) {
          return failed(
            'Creating Word documents needs the intelligence service, which is not running right now.'
          )
        }
        const blocks = blocksOf(text)
        const docTitle = (blocks[0]?.split('\n')[0] ?? title).slice(0, 120) || title
        // Drop the title line from the body so it isn't duplicated.
        const firstRest = (blocks[0] ?? '').split('\n').slice(1).join('\n').trim()
        const rest = [...(firstRest ? [firstRest] : []), ...blocks.slice(1)]
        const result = await ctx.documents.create(
          dest,
          docTitle,
          rest.length > 0 ? rest : [blocks[0] ?? text]
        )
        return {
          ok: true,
          output: {
            path: dest,
            size: result.sizeBytes,
            beforeExcerpt: null,
            afterExcerpt: result.afterExcerpt
          }
        }
      }
      if (input.target === 'pdf') {
        if (!ctx.pdf) {
          return failed(
            'Creating PDFs needs the desktop export step, which is not available right now.'
          )
        }
        const html =
          sourceSuffix === '.html' && /<html[\s>]/i.test(text) ? text : wrapTextAsHtml(title, text)
        const result = await ctx.pdf.exportHtml(dest, html)
        return {
          ok: true,
          output: {
            path: dest,
            size: result.sizeBytes,
            beforeExcerpt: null,
            afterExcerpt: `Converted ${basename(input.path)} to PDF (${result.sizeBytes} bytes).`
          }
        }
      }
      // md / txt: plain-text write of the extracted content.
      const size = ctx.fs.writeFileAtomic(dest, text)
      return {
        ok: true,
        output: { path: dest, size, beforeExcerpt: null, afterExcerpt: text.slice(0, 600) }
      }
    } catch (error) {
      return failed(error instanceof Error ? error.message : 'That file could not be converted.')
    }
  }
}
