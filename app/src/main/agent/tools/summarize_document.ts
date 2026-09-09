import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { readDocumentText } from '../document-text'

// MVP tool (MVP_PLAN.md): summarize a document. Extraction rides the same
// ladder as read_document (text direct, .pdf/.docx via the sidecar); the
// summarization itself is a one-shot LLM call over the user's configured
// provider through ctx.llm (keys never leave the Electron main process).
// MVP-sized files only: a hard 12k-char extract cap, no chunking strategy.

// Below the wrapper's 8 KB output cap so the model sees the summary plus
// metadata, never the generic "result was large" hint.
const MAX_PROMPT_CHARS = 12_000
const MAX_SUMMARY_CHARS = 4_000

export const summarizeDocumentTool: ToolDefinition<
  { path: string; focus?: string },
  { path: string; summary: string; truncated: boolean }
> = {
  name: 'summarize_document',
  description:
    'Summarize a document from the user\'s workspace in plain language (path relative to the workspace root). Optional focus steers the summary, e.g. "the pricing section".',
  access: 'read',
  inputSchema: z.object({
    path: z.string().min(1),
    focus: z.string().min(1).optional()
  }),
  pathFields: ['path'],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: (input) => ({ title: `Summarize ${basename(input.path)}`, group: 'documents' }),
  execute: async (input, ctx) => {
    try {
      if (!ctx.llm) {
        throw new Error('Summarizing needs the AI model, which is not available right now.')
      }
      const { text } = await readDocumentText(ctx, input.path)
      const extract = text.slice(0, MAX_PROMPT_CHARS)
      const prompt = [
        'Summarize the following document in clear, plain language.',
        input.focus ? `Focus especially on: ${input.focus}.` : 'Cover the main points.',
        'Keep it under 250 words.',
        extract.length < text.length
          ? 'The text below is only the beginning of a longer document — say so briefly.'
          : '',
        '--- DOCUMENT TEXT ---',
        extract
      ]
        .filter((line) => line !== '')
        .join('\n')
      const summary = (await ctx.llm.complete(prompt)).slice(0, MAX_SUMMARY_CHARS)
      return {
        ok: true,
        output: {
          path: input.path,
          summary,
          truncated: extract.length < text.length
        }
      }
    } catch (error) {
      return {
        ok: false,
        output: { path: input.path, summary: '', truncated: false },
        error: error instanceof Error ? error.message : 'That document could not be summarized.'
      }
    }
  }
}
