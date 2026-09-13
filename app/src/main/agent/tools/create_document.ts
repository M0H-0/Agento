import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'

// Demo document creation: build a `.docx` document, `.pptx` deck, or `.xlsx`
// workbook from plain strings via the sidecar (POST /document/create). The
// result shape matches write_file ({path, size, beforeExcerpt: null,
// afterExcerpt}) so the WriteFileCard renders it with no new UI. Risk mirrors
// write_file (docs/06 §2): a fresh path is risk 1, overwriting an existing
// file is risk 2 — the wrapper snapshots either way (docs/03 §7).
const MAX_ITEMS = 200
const CREATABLE_SUFFIXES = new Set(['.docx', '.pptx', '.xlsx'])

export function isCreatableDocument(path: string): boolean {
  return CREATABLE_SUFFIXES.has(extname(path).toLowerCase())
}

export const createDocumentTool: ToolDefinition<
  { path: string; title: string; items: string[] },
  { path: string; size: number; beforeExcerpt: null; afterExcerpt: string }
> = {
  name: 'create_document',
  description:
    "Create a Word (.docx), PowerPoint (.pptx), or Excel (.xlsx) file in the user's workspace from plain text (path relative to the workspace root). Give a title plus one item per paragraph/slide/row — use a newline inside an item for a heading and body. Text files go through write_file; PDFs go through convert_document.",
  access: 'write',
  inputSchema: z.object({
    path: z.string().min(1),
    title: z.string().min(1),
    items: z.array(z.string().min(1)).min(1).max(MAX_ITEMS)
  }),
  pathFields: ['path'],
  risk: (input, ctx) =>
    ctx.exists(input.path)
      ? { level: 2, reason: 'Overwrites an existing file' }
      : { level: 1, reason: 'Creates a new file' },
  describe: (input) => ({ title: `Create document ${basename(input.path)}`, group: 'documents' }),
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
    if (!isCreatableDocument(input.path)) {
      return failed(
        'I can create Word (.docx), PowerPoint (.pptx), and Excel (.xlsx) files — that file is neither, so I left it untouched. Text files go through write_file; PDFs go through convert_document.'
      )
    }
    if (!ctx.documents?.create) {
      return failed(
        'Creating Word, presentation, and spreadsheet documents needs the intelligence service, which is not running right now.'
      )
    }
    try {
      const result = await ctx.documents.create(input.path, input.title, input.items)
      return {
        ok: true,
        output: {
          path: input.path,
          size: result.sizeBytes,
          beforeExcerpt: null,
          afterExcerpt: result.afterExcerpt
        }
      }
    } catch (error) {
      return failed(error instanceof Error ? error.message : 'That document could not be created.')
    }
  }
}
