import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { wrapUntrusted } from '../untrusted'
import { readDocumentText, relativeDocError } from '../document-text'

// MVP tool (MVP_PLAN.md): read a document as plain text. Binary formats
// (.pdf/.docx/.pptx/.xlsx) ride the intelligence sidecar; text files
// (.txt/.md/.csv) read directly so they keep working with the sidecar down
// (docs/05 §6 degraded doctrine). Images (.png/.jpg/…) come back as a
// model-generated description via ctx.vision. The tool caps the text BELOW
// The tool caps the text BELOW the wrapper's 8 KB output cap
// (MAX_TOOL_OUTPUT_BYTES) — past it the wrapper would replace the whole
// result with a generic "large" hint and the honest `truncated` marker
// would never reach the model or the card.
const MAX_DOCUMENT_CHARS = 6_000

export const readDocumentTool: ToolDefinition<
  { path: string },
  { path: string; text: string; truncated: boolean }
> = {
  name: 'read_document',
  description:
    "Read a document from the user's workspace as plain text (path relative to the workspace root). Handles .pdf, .docx, .pptx, and .xlsx (via the intelligence service), text files like .txt, .md, and .csv, and images (.png/.jpg/.gif/.bmp/.webp/.tiff) — images come back as a description written by the AI model.",
  access: 'read',
  inputSchema: z.object({
    path: z.string().min(1)
  }),
  pathFields: ['path'],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: (input) => ({ title: `Read document ${basename(input.path)}`, group: 'documents' }),
  execute: async (input, ctx) => {
    try {
      const { text, truncated: sidecarTruncated } = await readDocumentText(ctx, input.path)
      const slice = text.slice(0, MAX_DOCUMENT_CHARS)
      return {
        ok: true,
        output: {
          path: input.path,
          text: wrapUntrusted(`document ${basename(input.path)}`, slice),
          truncated: sidecarTruncated || slice.length < text.length
        }
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'That document could not be read.'
      return {
        ok: false,
        output: { path: input.path, text: '', truncated: false },
        error: relativeDocError(ctx, input.path, raw)
      }
    }
  }
}
