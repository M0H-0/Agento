import { isAbsolute, join, normalize, relative, sep } from 'node:path'

// Workspace sandbox — docs/06 §4. M2.1 implements the path-STRING rules
// (workbook floor: reject absolute paths, drive/UNC/device shapes, and `..`
// escapes; model paths are relative intent). The M2.3 hardening pass adds the
// realpath walk, symlink/junction escape detection, mode-aware policies, and
// the protected-name deny list on top of the helpers here.
//
// Plain Node only. All refusals are plain-language (docs/06 §4.4) and typed so
// the loop can tell a sandbox refusal from a schema/execution failure.

export class ToolRefusalError extends Error {
  readonly kind: 'schema' | 'sandbox'

  constructor(kind: 'schema' | 'sandbox', message: string) {
    super(message)
    this.name = 'ToolRefusalError'
    this.kind = kind
  }
}

/** True when `target` (an absolute path) is lexically inside `root`. */
export function worksWithRoot(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolve a model-provided relative path inside the workspace.
 *
 * The string rules (M2.1 stage of docs/06 §4.1):
 * - absolute paths, `C:`-shaped paths (including drive-relative `c:foo`), UNC
 *   (`\\server`), device paths (`\\?\`), and empty paths are refused outright;
 * - the joined+narrowed result must stay lexically inside the root — a
 *   remaining `..` escape is refused with the plain-language copy.
 *
 * NOTE — this is deliberately lexical for M2.1: junction/symlink escapes need
 * the realpath walk, which M2.3 adds in this same module (`resolveAccessPath`).
 */
export function resolveWorkspacePath(workspaceRoot: string, rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new ToolRefusalError('sandbox', 'I need a file or folder path inside your workspace.')
  }
  const raw = rawPath.trim()
  if (
    isAbsolute(raw) ||
    raw.startsWith('\\\\') ||
    raw.startsWith('\\\\.\\') ||
    // Drive-relative `c:foo` is a Windows-only shape that resolves against the
    // current directory of a drive — never a safe relative path.
    /^[A-Za-z]:/.test(raw)
  ) {
    throw new ToolRefusalError(
      'sandbox',
      'Please give me a path inside your workspace — not an absolute or drive path.'
    )
  }

  // join() alone does not eliminate leading `..` segments (`join(root, '../x')`
  // returns `<parent>/x`), so normalize() the joinder and re-check containment.
  const joined = join(workspaceRoot, raw)
  const normalized = normalize(joined)
  if (!worksWithRoot(normalized, workspaceRoot)) {
    throw new ToolRefusalError(
      'sandbox',
      'That path would leave your workspace folder. Work with me inside the workspace instead.'
    )
  }
  return normalized
}
