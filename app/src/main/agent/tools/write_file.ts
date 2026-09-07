import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'

// P0 mutating tool — the docs/03 §5 example verbatim (risk = exists ? 2 : 1).
// Whole-file content replacement; anchor-based edits arrive with edit_file (M2.6).
// M2.5: the result carries before/after excerpts (docs/03 §5 — the card shows
// the changed region, no diff library). write_file replaces the whole file,
// so the excerpts are head-capped previews of the old/new content.
const EXCERPT_MAX_LINES = 8
const EXCERPT_MAX_CHARS = 600

export function excerptOf(content: string): string {
  const lines = content.split(/\r?\n/).slice(0, EXCERPT_MAX_LINES)
  let out = lines.join('\n')
  if (out.length > EXCERPT_MAX_CHARS) out = `${out.slice(0, EXCERPT_MAX_CHARS)}…`
  if (content.includes('\n') && lines.length === EXCERPT_MAX_LINES) out += '\n…'
  return out
}

export const writeFileTool: ToolDefinition<
  { path: string; content: string },
  { path: string; size: number; beforeExcerpt: string | null; afterExcerpt: string }
> = {
  name: 'write_file',
  description:
    'Create or overwrite a text file in the workspace (whole content — use edit_file for changes). Paths are relative to the workspace root.',
  access: 'write',
  inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
  pathFields: ['path'],
  risk: (input, ctx) =>
    ctx.exists(input.path)
      ? { level: 2, reason: 'Overwrites an existing file' }
      : { level: 1, reason: 'Creates a new file' },
  describe: (input) => ({ title: `Write ${basename(input.path)}`, group: 'files' }),
  execute: async (input, ctx) => {
    // Existence probe goes through the fs facade (NOT ctx.exists) so the
    // harness risk-stage log stays exactly [risk, snapshot] — ctx.exists is
    // the risk stage's own probe and reusing it here would double-log.
    const existed = ctx.fs.existsSync(input.path)
    const beforeExcerpt = existed ? excerptOf(ctx.fs.readFileSync(input.path)) : null
    const size = ctx.fs.writeFileAtomic(input.path, input.content)
    return {
      ok: true,
      output: {
        path: input.path,
        size,
        beforeExcerpt,
        afterExcerpt: excerptOf(input.content)
      }
    }
  }
}
