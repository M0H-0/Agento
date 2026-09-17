import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { wrapUntrusted } from '../untrusted'

// P0 read-only tool (docs/03 §5): read a text file. Optional startLine/maxLines
// for large files — without them the wrapper's 8 KB truncation (docs/03 §5
// `MAX_TOOL_OUTPUT_BYTES`) would already cap the output, but a targeted
// read keeps both the model prompt and the card body focused.
export const readFileTool: ToolDefinition<
  { path: string; startLine?: number; maxLines?: number },
  {
    path: string
    content: string
    startLine: number
    endLine: number
    totalLines: number
    truncated: boolean
  }
> = {
  name: 'read_file',
  description:
    "Read a text file from the user's workspace (path relative to the workspace root). Optional startLine/maxLines for large files — startLine is a 0-based line offset (0 = the first line); omit both for a full read.",
  access: 'read',
  inputSchema: z.object({
    path: z.string().min(1),
    startLine: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('0-based line offset to start from (0 = first line); omit for a full read'),
    // No `.max()` cap on purpose (M3.7 gate finding — same as search_files):
    // provider-side validation would kill the turn; `execute` clamps via the
    // `?? 2000` default + slice bounds below.
    maxLines: z.number().int().min(1).optional().describe('Max lines to return (default 2000)')
  }),
  pathFields: ['path'],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: (input) => ({ title: `Read ${basename(input.path)}`, group: 'files' }),
  execute: async (input, ctx) => {
    const emptyOutput = {
      path: input.path,
      content: '',
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      truncated: false
    }
    try {
      if (!ctx.fs.existsSync(input.path)) {
        return {
          ok: false,
          output: emptyOutput,
          error: "I couldn't find that file — it may have been moved or renamed."
        }
      }
      const full = ctx.fs.readFileSync(input.path)
      // Split on line boundaries; `split` of `"a\nb\n"` returns ["a","b",""]
      // — the trailing empty is the expected "no content after the last \n"
      // marker. We strip it so totalLines is honest (3 lines, not 4).
      const lines = full.split(/\r?\n/)
      const lastIsEmpty = lines.length > 0 && lines[lines.length - 1] === ''
      const meaningful = lastIsEmpty ? lines.slice(0, -1) : lines
      const start = input.startLine ?? 0
      const max = input.maxLines ?? 2000
      const end = Math.min(meaningful.length, start + max)
      const slice = meaningful.slice(start, end).join('\n')
      return {
        ok: true,
        output: {
          path: input.path,
          content: wrapUntrusted(`file ${basename(input.path)}`, slice),
          startLine: start,
          endLine: end,
          totalLines: meaningful.length,
          truncated: end < meaningful.length
        }
      }
    } catch (error) {
      return {
        ok: false,
        output: emptyOutput,
        error:
          error instanceof Error
            ? error.message
            : "I couldn't find that file — it may have been moved or renamed."
      }
    }
  }
}
