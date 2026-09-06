import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'

// P0 mutating tool — the docs/03 §5 example verbatim (risk = exists ? 2 : 1).
// Whole-file content replacement; anchor-based edits arrive with edit_file (M2.6).
export const writeFileTool: ToolDefinition<
  { path: string; content: string },
  { path: string; size: number }
> = {
  name: 'write_file',
  description: 'Create or overwrite a text file',
  access: 'write',
  inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
  pathFields: ['path'],
  risk: (input, ctx) =>
    ctx.exists(input.path)
      ? { level: 2, reason: 'Overwrites an existing file' }
      : { level: 1, reason: 'Creates a new file' },
  describe: (input) => ({ title: `Write ${basename(input.path)}`, group: 'files' }),
  execute: async (input, ctx) => {
    const size = ctx.fs.writeFileAtomic(input.path, input.content)
    return { ok: true, output: { path: input.path, size } }
  }
}
