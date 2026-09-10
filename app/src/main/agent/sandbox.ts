import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import type { ToolAccess } from './types'

// Workspace sandbox — docs/06 §4 (hardened in M2.3; the string rules are the
// M2.1 floor). Model paths are RELATIVE INTENT, never taken literally: the
// resolver turns them into pre-resolved absolute paths inside the workspace or
// refuses with plain language.
//
// Full guard, in order:
//  1. string rules — reject absolute paths, drive/UNC/device shapes, and any
//     `..` that escapes the workspace lexically (both separators);
//  2. realpath walk — every EXISTING component is realpath'd; a component
//     whose real path escapes the real workspace root is refused (this is what
//     catches junction/symlink escapes — Windows junctions resolve through
//     fs.realpathSync);
//  3. mode policy — for `read`, following an outside-pointing symlink/junction
//     is allowed (docs/06 §4.3); for `write` (writes/moves/deletes) any
//     escaping link on the way is refused;
//  4. symlink loops — a realpath ELOOP becomes a plain-language refusal, never
//     a hang;
//  5. protected-name deny list — even inside the workspace (docs/06 §4.4),
//     overridable per-path later from Settings (default: no overrides).
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

// Protected-name deny list (docs/06 §4.4): private keys, credential stores,
// and the SSH/GPG/AWS config dirs, matched case-insensitively against EVERY
// path segment inside the workspace. Conservative by design — extending it is
// a documented decision, not a reflex.
const PROTECTED_SEGMENTS = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.ssh',
  '.gnupg',
  '.aws',
  '.netrc',
  'credentials'
])

export interface SandboxOptions {
  /** Full normalized paths exempt from the protected-name check (Settings override; default none). */
  protectedPathOverrides?: ReadonlySet<string>
}

function isProtected(relativePath: string, overrides?: ReadonlySet<string>): boolean {
  if (overrides && overrides.size > 0) {
    const lowerRel = relativePath.toLowerCase()
    for (const override of overrides) {
      if (override.toLowerCase() === lowerRel) return false
    }
  }
  const segments = relativePath.split(sep).filter(Boolean)
  return segments.some((segment) => {
    const lower = segment.toLowerCase()
    if (PROTECTED_SEGMENTS.has(lower)) return true
    // `credentials.json` / `id_rsa.pub` — the credential NAME with any single
    // extension is still the credential.
    const base = lower.replace(/\.[^.]+$/, '')
    return base !== lower && PROTECTED_SEGMENTS.has(base)
  })
}

function realInsideRoot(candidate: string, rootReal: string): boolean | undefined {
  // true/false when realpath resolved (inside / outside rootReal); undefined
  // when the component vanished mid-walk (treated as non-existing). ELOOP and
  // other errors propagate to the caller's refusal path.
  try {
    const real = realpathSync(candidate)
    return worksWithRoot(real, rootReal)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  }
}

function refusal(message: string): never {
  throw new ToolRefusalError('sandbox', message)
}

/**
 * Revalidate an already-resolved absolute path immediately before touching
 * the disk (TOCTOU backstop for the wrapper's pre-resolved paths).
 *
 * Mirrors resolveWorkspacePath's realpath walk + protected-name + mode policy,
 * but starts from an absolute path instead of model-relative intent. Every
 * WorkspaceFs mutation calls this first so a concurrently swapped
 * junction/symlink cannot redirect a checked path outside the workspace.
 */
export function assertAbsoluteInsideWorkspace(
  workspaceRoot: string,
  absolutePath: string,
  access: ToolAccess = 'write',
  options: SandboxOptions = {}
): void {
  if (!workspaceRoot) {
    throw new ToolRefusalError('sandbox', 'I need a workspace folder before I can touch files.')
  }
  if (!worksWithRoot(absolutePath, workspaceRoot)) {
    throw new ToolRefusalError(
      'sandbox',
      'I can only read and write inside your workspace folder (the filesystem guard refused this path).'
    )
  }
  let rootReal: string
  try {
    rootReal = realpathSync(workspaceRoot)
  } catch {
    throw new ToolRefusalError('sandbox', "Your workspace folder isn't accessible right now.")
  }
  const relFromRoot = relative(workspaceRoot, absolutePath)
  if (isProtected(relFromRoot, options.protectedPathOverrides)) {
    throw new ToolRefusalError(
      'sandbox',
      "That path is on the protected list (private keys and credential stores), so I won't touch it. You can allow this specific path in Settings if you really mean it."
    )
  }
  const segments = relFromRoot.split(sep).filter(Boolean)
  let walked = workspaceRoot
  let traversedOutside = false
  for (const segment of segments) {
    walked = join(walked, segment)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(walked)
    } catch {
      break
    }
    const link = stat.isSymbolicLink()
    let inside: boolean | undefined
    try {
      inside = realInsideRoot(walked, rootReal)
    } catch (error) {
      throw new ToolRefusalError(
        'sandbox',
        `I couldn't follow that path safely (${
          error instanceof Error ? error.message : "the folder link can't be resolved"
        }).`
      )
    }
    if (inside === undefined) break
    if (!inside) {
      if (access === 'read' && (link || traversedOutside)) {
        traversedOutside = true
        continue
      }
      throw new ToolRefusalError(
        'sandbox',
        access === 'read'
          ? "That path sits outside your workspace (or its folder link points outside it), so I can't work with it."
          : "That path would follow a folder link outside your workspace, and I won't write, move, or delete through it."
      )
    }
  }
}

/**
 * Resolve a model-provided relative path inside the workspace.
 *
 * `access` selects the link policy (docs/06 §4.3): 'read' may follow an
 * outside-pointing symlink/junction; 'write' refuses one anywhere on the way.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  rawPath: unknown,
  access: ToolAccess = 'write',
  options: SandboxOptions = {}
): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    refusal('I need a file or folder path inside your workspace.')
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
    refusal('Please give me a path inside your workspace — not an absolute or drive path.')
  }

  // 1 — lexical containment: join() alone does not eliminate leading `..`
  // segments (`join(root, '../x')` returns `<parent>/x`), so normalize() the
  // joined path and re-check.
  const joined = join(workspaceRoot, raw)
  const normalized = normalize(joined)
  if (!worksWithRoot(normalized, workspaceRoot)) {
    refusal(
      'That path would leave your workspace folder. Work with me inside the workspace instead.'
    )
  }

  // The comparison base is the workspace root's OWN realpath: a user may
  // legitimately pick a workspace that is itself a junction (OneDrive-
  // redirected folders), and everything is then measured against where it
  // really lives.
  let rootReal: string
  try {
    rootReal = realpathSync(workspaceRoot)
  } catch {
    refusal("Your workspace folder isn't accessible right now.")
  }

  const relFromRoot = relative(workspaceRoot, normalized)
  const segments = relFromRoot.split(sep).filter(Boolean)

  // 5 — protected names, checked on the requested (lexical) shape so a link
  // named `.ssh` cannot dodge the deny list by pointing elsewhere.
  if (isProtected(relFromRoot, options.protectedPathOverrides)) {
    refusal(
      "That path is on the protected list (private keys and credential stores), so I won't touch it. You can allow this specific path in Settings if you really mean it."
    )
  }

  // 2+3 — realpath walk over every EXISTING component. We probe existence
  // with lstatSync (NOT existsSync): existsSync FOLLOWS symlinks, so a junction
  // whose target is itself part of a loop reports false and would hide the
  // loop. lstatSync reports the link itself, which is what the containment
  // check needs.
  let walked = workspaceRoot
  let traversedOutside = false // stepped through an outside link already (read mode)
  for (const segment of segments) {
    walked = join(walked, segment)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(walked)
    } catch {
      break // nothing at this depth (and nothing deeper) — lexical path is inside
    }
    const link = stat.isSymbolicLink()
    let inside: boolean | undefined
    try {
      inside = realInsideRoot(walked, rootReal)
    } catch (error) {
      // 4 — symlink loop (ELOOP) or an unreadable component: a plain-language
      // refusal, never a hang.
      refusal(
        `I couldn't follow that path safely (${
          error instanceof Error ? error.message : "the folder link can't be resolved"
        }).`
      )
    }
    if (inside === undefined) break // raced away mid-walk — treat as absent
    if (!inside) {
      // This existing component's realpath escapes the workspace root. Reads
      // may pass through an outside-pointing LINK (docs/06 §4.3) — and once
      // they have, everything beneath it is only reachable that way, so the
      // traversal stays permitted for reads. Writes refuse either way.
      if (access === 'read' && (link || traversedOutside)) {
        traversedOutside = true
        continue
      }
      refusal(
        access === 'read'
          ? "That path sits outside your workspace (or its folder link points outside it), so I can't work with it."
          : "That path would follow a folder link outside your workspace, and I won't write, move, or delete through it."
      )
    }
  }

  return normalized
}
