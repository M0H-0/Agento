import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { editExcerpts } from './edit_file'

export interface DocumentEdit {
  anchor: string
  replacement: string
}

// Demo document editing: `.md`/`.txt` edit directly (same exactly-once
// anchor contract as edit_file); `.docx`/`.pptx`/`.xlsx` ride the sidecar
// (run-level splice for slides/Word, whole-cell match for sheets).
// Anything else refuses honestly — PDFs and images especially: no silent
// rewrite of a binary layout format, no pixel edits. Always risk 2 per the
// rule table (docs/06 §2).
const MAX_EDITS = 10
const TEXT_SUFFIXES = new Set(['.md', '.markdown', '.txt'])
const SIDECAR_SUFFIXES = new Set(['.docx', '.pptx', '.xlsx'])

export function isTextEditable(path: string): boolean {
  return TEXT_SUFFIXES.has(extname(path).toLowerCase())
}

export function isSidecarEditable(path: string): boolean {
  return SIDECAR_SUFFIXES.has(extname(path).toLowerCase())
}

export const editDocumentTool: ToolDefinition<
  { path: string; edits: DocumentEdit[] },
  { path: string; beforeExcerpt: string; afterExcerpt: string; editsApplied: number }
> = {
  name: 'edit_document',
  description:
    "Edit a document from the user's workspace with anchor text: each edit's anchor must match the document exactly once and is replaced (paths relative to the workspace root). Handles .docx/.pptx/.xlsx plus text files like .md and .txt (spreadsheets need whole-cell anchors).",
  access: 'write',
  inputSchema: z.object({
    path: z.string().min(1),
    edits: z
      .array(z.object({ anchor: z.string().min(1), replacement: z.string() }))
      .min(1)
      .max(MAX_EDITS)
  }),
  pathFields: ['path'],
  risk: () => ({ level: 2, reason: 'Edits an existing document (reversible via snapshot)' }),
  describe: (input) => ({ title: `Edit document ${basename(input.path)}`, group: 'documents' }),
  execute: async (input, ctx) => {
    const failed = (
      error: string
    ): {
      ok: false
      output: { path: string; beforeExcerpt: string; afterExcerpt: string; editsApplied: number }
      error: string
    } => ({
      ok: false as const,
      output: { path: input.path, beforeExcerpt: '', afterExcerpt: '', editsApplied: 0 },
      error
    })
    if (isTextEditable(input.path)) {
      if (!ctx.fs.existsSync(input.path)) {
        return failed("I couldn't find that file — it may have been moved or renamed.")
      }
      let current = ctx.fs.readFileSync(input.path)
      const befores: string[] = []
      const afters: string[] = []
      for (const edit of input.edits) {
        const first = current.indexOf(edit.anchor)
        if (first < 0) {
          return failed(
            'That text does not match the file exactly — include more surrounding context so I can find the right spot.'
          )
        }
        if (current.indexOf(edit.anchor, first + edit.anchor.length) >= 0) {
          return failed(
            'That text matches more than one place — include more surrounding context so it matches exactly once.'
          )
        }
        const { beforeExcerpt, afterExcerpt } = editExcerpts(current, edit.anchor, edit.replacement)
        befores.push(beforeExcerpt)
        afters.push(afterExcerpt)
        current =
          current.slice(0, first) + edit.replacement + current.slice(first + edit.anchor.length)
      }
      ctx.fs.writeFileAtomic(input.path, current)
      return {
        ok: true,
        output: {
          path: input.path,
          beforeExcerpt: befores.join('\n…\n').slice(0, 4000),
          afterExcerpt: afters.join('\n…\n').slice(0, 4000),
          editsApplied: input.edits.length
        }
      }
    }
    if (isSidecarEditable(input.path)) {
      if (!ctx.documents?.edit) {
        return failed(
          'Editing Word, PowerPoint, and Excel documents needs the intelligence service, which is not running right now.'
        )
      }
      try {
        const result = await ctx.documents.edit(input.path, input.edits)
        return {
          ok: true,
          output: {
            path: input.path,
            beforeExcerpt: result.beforeExcerpt,
            afterExcerpt: result.afterExcerpt,
            editsApplied: result.editsApplied
          }
        }
      } catch (error) {
        return failed(error instanceof Error ? error.message : 'That document could not be edited.')
      }
    }
    return failed(
      'I can edit Word, PowerPoint, and Excel documents (.docx/.pptx/.xlsx) and text files (.md/.txt) — that file is neither, so I left it untouched.'
    )
  }
}
