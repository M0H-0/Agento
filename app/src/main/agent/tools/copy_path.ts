import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { WorkspaceFsRefusalError } from '../workspace-fs'

// P0 mutating tool (M2.7, docs/03 §5 inventory): byte-exact copy of one file.
// Mirrors write_file's risk shape — risk 1 onto a new path, risk 2 when the
// destination exists (the old content is replaced). Folders are refused with
// plain language (recursive copy is out of scope). Only the DESTINATION is
// snapshotted (snapshotFields → ['to']): copy never mutates its source, so a
// source snapshot would let undo rewrite it to the pre-copy state — reverting
// any unrelated edit made to it after the copy (M2.8 review fix).
export const copyPathTool: ToolDefinition<
  { from: string; to: string },
  { from: string; to: string; size: number; overwritten: boolean }
> = {
  name: 'copy_path',
  description:
    'Copy a file in the workspace (missing destination folders are created; an existing destination is replaced). ALWAYS use this tool to duplicate a file — never re-create copies with read_file + write_file. Paths are relative to the workspace root.',
  access: 'write',
  inputSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  pathFields: ['from', 'to'],
  // Only the destination is snapshotted — the source is read-only input and
  // must never be written back by undo (M2.8 review fix; docs/03 §5).
  snapshotFields: () => ['to'],
  risk: (input, ctx) =>
    ctx.exists(input.to)
      ? { level: 2, reason: 'Replaces the file at the destination' }
      : { level: 1, reason: 'Copies a file (reversible)' },
  describe: (input) => ({
    title: `Copy ${basename(input.from) || input.from}`,
    group: 'files'
  }),
  execute: async (input, ctx) => {
    // Existence probes go through the fs facade (NOT ctx.exists) so the
    // harness risk-stage log stays exact — ctx.exists is the risk stage's
    // own probe (write_file doctrine). Copying onto itself runs through
    // normally (a byte-exact no-op overwrite, still snapshotted).
    if (!ctx.fs.existsSync(input.from)) {
      return {
        ok: false,
        output: { from: input.from, to: input.to, size: 0, overwritten: false },
        error: "I couldn't find that file — it may have been moved or renamed."
      }
    }
    if (ctx.fs.isDirectory(input.from)) {
      return {
        ok: false,
        output: { from: input.from, to: input.to, size: 0, overwritten: false },
        error: 'I can only copy files, not folders. Nothing was changed.'
      }
    }
    const overwritten = ctx.fs.existsSync(input.to)
    let size = 0
    try {
      size = ctx.fs.copyPath(input.from, input.to)
    } catch (error) {
      if (error instanceof WorkspaceFsRefusalError) {
        return {
          ok: false,
          output: { from: input.from, to: input.to, size: 0, overwritten: false },
          error: error.message
        }
      }
      throw error
    }
    return { ok: true, output: { from: input.from, to: input.to, size, overwritten } }
  }
}
