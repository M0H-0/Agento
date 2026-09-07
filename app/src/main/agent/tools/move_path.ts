import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { WorkspaceFsRefusalError } from '../workspace-fs'

// P0 mutating tool (M2.7, docs/03 §5 inventory): move/rename a file or folder.
// Always risk 2 — the source location disappears, so the run blocks on the
// approval hook (docs/04 §5 copy rules: "Approval modal on overwrite/move/
// delete"). Both sides are snapshotted before execute; the source row carries
// dest_path so undo restores the original name (docs/03 §8). An existing dest
// is replaced (its snapshot holds the old content); a missing source or a
// move onto itself is an honest non-mutation.
export const movePathTool: ToolDefinition<
  { from: string; to: string },
  { from: string; to: string; overwritten: boolean }
> = {
  name: 'move_path',
  description:
    'Move or rename a file or folder in the workspace (missing destination folders are created). ALWAYS use this tool to move or rename — never re-create the file elsewhere with read_file + write_file plus a delete. Paths are relative to the workspace root.',
  access: 'write',
  inputSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  pathFields: ['from', 'to'],
  // No disk probe: the level never varies, so the harness risk-stage log
  // stays exact — same doctrine as edit_file (always 2, no probe).
  risk: () => ({ level: 2, reason: 'Moves a file or folder (reversible via snapshot)' }),
  describe: (input) => ({
    title: `Move ${basename(input.from) || input.from}`,
    group: 'files'
  }),
  checkpointDestPath: (input) => input.to,
  execute: async (input, ctx) => {
    // Existence probes go through the fs facade (NOT ctx.exists) so the
    // harness risk-stage log stays exactly [approval, snapshot, snapshot].
    if (input.from === input.to) {
      return { ok: true, output: { from: input.from, to: input.to, overwritten: false } }
    }
    if (!ctx.fs.existsSync(input.from)) {
      return {
        ok: false,
        output: { from: input.from, to: input.to, overwritten: false },
        error: "I couldn't find that file — it may have been moved or renamed."
      }
    }
    const overwritten = ctx.fs.existsSync(input.to)
    try {
      ctx.fs.movePath(input.from, input.to)
    } catch (error) {
      if (error instanceof WorkspaceFsRefusalError) {
        return {
          ok: false,
          output: { from: input.from, to: input.to, overwritten: false },
          error: error.message
        }
      }
      throw error
    }
    return { ok: true, output: { from: input.from, to: input.to, overwritten } }
  }
}
