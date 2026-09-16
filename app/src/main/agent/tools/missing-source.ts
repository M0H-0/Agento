import { basename, relative } from 'node:path'
import type { ToolExecutionContext } from '../types'

// Missing-source self-healing hint (post-recording quality lever): when a
// move/copy source is missing — usually stale plan state, an earlier step
// already moved/renamed it — look the file NAME up workspace-wide and, when
// found, name its current location so the model can self-correct on its next
// step instead of hitting a dead end.
//
// Sandboxed + capped by construction: the walk goes through the injected
// WorkspaceFs facade (never node:fs — containment revalidated inside), stays
// rooted at the workspace, matches names only (never reads content), stops at
// MAX_LOOKUP_FILES, and only enriches the refusal sentence — nothing is ever
// auto-executed. A failed lookup degrades to no hint (the base refusal
// stands), never to a new failure.
const MAX_LOOKUP_FILES = 2000

export function currentLocationHint(
  ctx: ToolExecutionContext,
  missingAbsPath: string,
  verb: 'move' | 'copy'
): string | null {
  const name = basename(missingAbsPath)
  if (!name) return null
  let candidates: string[]
  try {
    candidates = ctx.fs.walkFiles(ctx.workspaceRoot, MAX_LOOKUP_FILES)
  } catch {
    return null
  }
  const lowered = name.toLowerCase()
  const matches = candidates
    .filter((candidate) => (candidate.split(/[\\/]/).pop() ?? '').toLowerCase() === lowered)
    .sort()
  if (matches.length === 0) return null
  const first = matches[0] as string
  // Forward slashes: the sandbox accepts both separators, and the hint reads
  // the same on every platform (relative() yields backslashes on Windows).
  const rel = (relative(ctx.workspaceRoot, first) || first).replace(/\\/g, '/')
  const extra =
    matches.length > 1
      ? ` (plus ${matches.length - 1} other match${matches.length > 2 ? 'es' : ''})`
      : ''
  const action =
    verb === 'move' ? 'move or rename it from there if needed' : 'copy it from there if needed'
  return `That file is already at ${rel}${extra} — ${action}.`
}
