import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'

// P0 mutating tool (M2.5, docs/03 §5 inventory): create a folder (recursive).
// Risk 1 when new (reversible — undo deletes the empty chain); risk 2 when it
// already exists as a folder (the run is a no-op, but the model asked for a
// mutation and the honest classification is "touches an existing path").
// The snapshot stage records existed:0 for a new dir (undo deletes) and
// existed:1 for an existing one (no-op restore).
export const createDirTool: ToolDefinition<{ path: string }, { path: string; existed: boolean }> = {
  name: 'create_dir',
  description:
    'Create a folder in the workspace (any missing parents are created too). Paths are relative to the workspace root.',
  access: 'write',
  inputSchema: z.object({ path: z.string().min(1) }),
  pathFields: ['path'],
  risk: (input, ctx) =>
    // One probe only (the harness risk log counts ctx.exists calls): the
    // facade probe distinguishes file-vs-folder without a second risk entry.
    ctx.fs.isDirectory(input.path)
      ? { level: 2, reason: 'A folder already exists at that path' }
      : ctx.exists(input.path)
        ? { level: 2, reason: 'A file already exists at that path' }
        : { level: 1, reason: 'Creates a new folder (reversible)' },
  describe: (input) => ({
    title: `Create folder ${basename(input.path) || input.path}`,
    group: 'files'
  }),
  execute: async (input, ctx) => {
    // Existence probes go through the fs facade (NOT ctx.exists) so the
    // harness risk-stage log stays exactly [risk, (approval,) snapshot].
    const existed = ctx.fs.isDirectory(input.path)
    if (existed) {
      // Honest no-op: the folder is already there.
      return { ok: true, output: { path: input.path, existed: true } }
    }
    if (ctx.fs.existsSync(input.path)) {
      return {
        ok: false,
        output: { path: input.path, existed: true },
        error: 'That path already exists and is a file, not a folder.'
      }
    }
    ctx.fs.mkdir(input.path)
    return { ok: true, output: { path: input.path, existed: false } }
  }
}
