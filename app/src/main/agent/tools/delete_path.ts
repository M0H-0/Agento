import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { WorkspaceFsRefusalError } from '../workspace-fs'

// P0 mutating tool (M2.7, docs/03 §5 inventory): delete a file or an empty
// folder. Always risk 3 per the rule table — the run blocks on the approval
// hook with the red-verb dialog (docs/04 §3.2). The snapshot holds the full
// pre-mutation content, so undo restores it (docs/03 §8). Non-empty folders
// are refused honestly (recursive delete is out of scope).
export const deletePathTool: ToolDefinition<{ path: string }, { path: string }> = {
  name: 'delete_path',
  description:
    'Delete a file or an empty folder in the workspace. Paths are relative to the workspace root.',
  access: 'write',
  inputSchema: z.object({ path: z.string().min(1) }),
  pathFields: ['path'],
  // No disk probe: always 3, so the harness log stays [approval, snapshot].
  risk: () => ({
    level: 3,
    reason: 'Permanently deletes a file or folder (reversible via snapshot)'
  }),
  describe: (input) => ({
    title: `Delete ${basename(input.path) || input.path}`,
    group: 'files'
  }),
  execute: async (input, ctx) => {
    // Existence probe goes through the fs facade (NOT ctx.exists) so the
    // harness risk-stage log stays exactly [approval, snapshot].
    if (!ctx.fs.existsSync(input.path)) {
      return {
        ok: false,
        output: { path: input.path },
        error: "I couldn't find that file — it may already be gone. Nothing was changed."
      }
    }
    try {
      ctx.fs.deletePath(input.path)
    } catch (error) {
      if (error instanceof WorkspaceFsRefusalError) {
        return {
          ok: false,
          output: { path: input.path },
          error: error.message
        }
      }
      throw error
    }
    return { ok: true, output: { path: input.path } }
  }
}
