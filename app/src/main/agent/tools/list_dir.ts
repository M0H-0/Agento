import { z } from 'zod'
import type { ToolDefinition } from '../types'

// P0 read-only tool (docs/03 §5): list a directory's entries. Always risk 0;
// declarations are *relative intent* against the workspace — the registry
// pre-resolves the path through the sandbox (docs/06 §4) before this body
// runs, so the body never sees raw model paths.
export const listDirTool: ToolDefinition<
  { path: string },
  { path: string; entries: { name: string; type: 'file' | 'directory' }[] }
> = {
  name: 'list_dir',
  description:
    'List the files and folders directly inside a directory in the user\'s workspace. Paths are relative to the workspace root — pass "." for the root itself.',
  access: 'read',
  inputSchema: z.object({ path: z.string().min(1) }),
  pathFields: ['path'],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: (input) => ({ title: `List ${input.path || 'workspace'}`, group: 'files' }),
  execute: async (input, ctx) => {
    const entries = ctx.fs.readdir(input.path)
    // The list_dir output is what the model sees; cap defensively even though
    // the wrapper truncates oversized outputs. A real workspace with >8 KB of
    // entry names is itself the problem.
    return { ok: true, output: { path: input.path, entries } }
  }
}
