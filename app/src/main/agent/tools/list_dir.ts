import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'

// P0 read-only tool (docs/03 §5): list a directory's entries. Always risk 0;
// declarations are *relative intent* against the workspace — the registry
// pre-resolves the path through the sandbox (docs/06 §4) before this body
// runs, so the body never sees raw model paths.
//
// Self-cap (2026-09-16): a messy folder (Downloads with hundreds of files)
// used to return every entry, blowing past the wrapper's 8 KB budget — the
// wrapper then replaced the whole payload with an `outputTruncated` envelope
// and the model lost the listing entirely (plus a huge context bill that
// slowed planning). Cap at MAX_LIST_DIR_ENTRIES with an honest
// domain-level `truncated` + `total` (the registry preserves domain
// `truncated` flags — they are partial results, not the envelope).
export const MAX_LIST_DIR_ENTRIES = 200

export const listDirTool: ToolDefinition<
  { path: string },
  {
    path: string
    entries: { name: string; type: 'file' | 'directory' }[]
    truncated: boolean
    total: number
  }
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
    let entries: { name: string; type: 'file' | 'directory' }[]
    try {
      entries = ctx.fs.readdir(input.path)
    } catch {
      // Phase-1 item 2 honesty: a missing/unreadable directory must never ride
      // the success shape — the card would claim "0 entries / This folder is
      // empty." (live: T2 probed archive/ before it existed). Return ok:false
      // with a complete plain sentence; never the raw fs message, which
      // embeds the absolute path (AGENTS rule 6 — relative paths only).
      const name = basename(input.path) || 'that folder'
      const missing = !ctx.fs.existsSync(input.path)
      const notFolder = !missing && !ctx.fs.isDirectory(input.path)
      return {
        ok: false,
        output: { path: input.path, entries: [], truncated: false, total: 0 },
        error: missing
          ? `I couldn't find the folder "${name}" — it may not exist yet.`
          : notFolder
            ? `"${name}" is a file, not a folder, so there is nothing to list.`
            : `I couldn't list the folder "${name}" — it could not be read.`
      }
    }
    // M3.3 projection feed (docs/03 §5): the file count is what a following
    // same-shape batch (e.g. one move per listed file) projects from when the
    // plan description states no number. Directories excluded — only files
    // get moved/copied/deleted one by one. The projection uses the TRUE total,
    // not the capped page the model sees.
    ctx.noteEnumeration?.(entries.filter((e) => e.type === 'file').length, input.path)
    // Self-cap: the model sees the first page only; the card/panel say how
    // many more exist. Sorted for a stable page across calls.
    const total = entries.length
    if (total > MAX_LIST_DIR_ENTRIES) {
      const page = [...entries]
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_LIST_DIR_ENTRIES)
      return { ok: true, output: { path: input.path, entries: page, truncated: true, total } }
    }
    return { ok: true, output: { path: input.path, entries, truncated: false, total } }
  }
}
