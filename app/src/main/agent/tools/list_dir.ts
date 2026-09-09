import { basename } from 'node:path'
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
  describe: (input) => ({
    // The wrapper hands describe the PRE-RESOLVED (absolute) path — render
    // the folder name only, never the absolute path (docs/04 §3.1 card-title
    // rule; M2.8 review fix).
    title: `List ${basename(input.path) || 'workspace'}`,
    group: 'files'
  }),
  execute: async (input, ctx) => {
    const entries = ctx.fs.readdir(input.path)
    // M3.3 projection feed (docs/03 §5): the file count is what a following
    // same-shape batch (e.g. one move per listed file) projects from when the
    // plan description states no number. Directories excluded — only files
    // get moved/copied/deleted one by one.
    ctx.noteEnumeration?.(entries.filter((e) => e.type === 'file').length)
    // The list_dir output is what the model sees; cap defensively even though
    // the wrapper truncates oversized outputs. A real workspace with >8 KB of
    // entry names is itself the problem.
    return { ok: true, output: { path: input.path, entries } }
  }
}
