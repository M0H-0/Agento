import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolRefusalError, resolveWorkspacePath } from './sandbox'
import { writeFileTool } from './tools/write_file'
import { createHandlerHarness } from './testing/harness'

// Adversarial fixture suite (docs/06 §4 + docs/07 §2 — RELEASE-BLOCKING).
// Real fixture trees in temp dirs: `..` chains, junction/symlink escapes,
// symlink loops, Unicode names, long/deep paths, case-insensitivity, protected
// names, drive letters/UNC/device shapes. The junction cases always run
// (junctions need no privileges on Windows); true symlink cases
// feature-detect creation (Developer Mode/admin) and are skipped honestly
// when the box cannot create them.

let parent: string
let root: string
let outside: string

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'agento-sbx-'))
  root = join(parent, 'workspace')
  outside = join(parent, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', 'file.txt'), 'inside', 'utf8')
  writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8')
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

// Feature detection (once): can this box create real symlinks?
let symlinkSupport: boolean | undefined
function canSymlink(): boolean {
  if (symlinkSupport === undefined) {
    try {
      const probeDir = mkdtempSync(join(tmpdir(), 'agento-sbx-probe-'))
      try {
        symlinkSync(probeDir, join(probeDir, 'self-dir'), 'dir')
        symlinkSupport = true
      } finally {
        rmSync(probeDir, { recursive: true, force: true })
      }
    } catch {
      symlinkSupport = false
    }
  }
  return symlinkSupport
}

describe('sandbox fixtures — lexical escapes (docs/06 §4.1)', () => {
  it('refuses `..` chains in both separators', () => {
    expect(() => resolveWorkspacePath(root, 'sub/../../outside')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, 'sub\\..\\..\\outside')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, '..')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, 'sub/..')).not.toThrowError() // stays inside
  })

  it('refuses drive-letter, drive-relative, UNC and device paths', () => {
    expect(() => resolveWorkspacePath(root, 'C:\\Windows')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, 'c:documents')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, '\\\\server\\share\\x')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, '\\\\.\\PhysicalDrive0')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, '/etc/passwd')).toThrowError(ToolRefusalError)
  })
})

describe('sandbox fixtures — junction escapes (always available on Windows)', () => {
  it('refuses a junction pointing outside the workspace for writes', () => {
    symlinkSync(outside, join(root, 'escape-junction'), 'junction')
    expect(() => resolveWorkspacePath(root, 'escape-junction/secret.txt', 'write')).toThrowError(
      /folder link outside your workspace/
    )
  })

  it('allows READS through an outside-pointing junction (docs/06 §4.3) and refuses writes', () => {
    symlinkSync(outside, join(root, 'escape-junction'), 'junction')
    const readPath = resolveWorkspacePath(root, 'escape-junction/secret.txt', 'read')
    expect(readPath.startsWith(root)).toBe(true) // the RESOLVED path stays lexical; the OS follows the link on read
    // And the read itself genuinely works through the real fs:
    const content = readFileSync(readPath, 'utf8')
    expect(content).toBe('outside')
  })

  it('refuses a write through an escaping junction ANCESTOR even when the leaf does not exist', () => {
    symlinkSync(outside, join(root, 'escape-junction'), 'junction')
    expect(() => resolveWorkspacePath(root, 'escape-junction/new-file.txt', 'write')).toThrowError(
      ToolRefusalError
    )
  })

  it('allows a junction pointing INSIDE the workspace for both modes', () => {
    symlinkSync(join(root, 'sub'), join(root, 'inside-junction'), 'junction')
    expect(resolveWorkspacePath(root, 'inside-junction/file.txt', 'write')).toBeTruthy()
    expect(resolveWorkspacePath(root, 'inside-junction/file.txt', 'read')).toBeTruthy()
  })

  // Junction LOOPS trigger ELOOP on realpath — refused cleanly, never a hang.
  // Works without symlink privileges (unlike true symlink loops, which need
  // Developer Mode). A self-junction is refused by the OS (EEXIST), so the
  // loop is two cross-pointing junctions; cleanup is best-effort because a
  // loop can make the OS reluctant to remove the tree.
  it('refuses a junction LOOP with a clean error, not a hang', () => {
    const loopA = join(root, 'loop-a')
    const loopB = join(root, 'loop-b')
    symlinkSync(loopB, loopA, 'junction')
    symlinkSync(loopA, loopB, 'junction')
    try {
      expect(() => resolveWorkspacePath(root, 'loop-a/anything.txt', 'read')).toThrowError(
        ToolRefusalError
      )
      expect(() => resolveWorkspacePath(root, 'loop-a/anything.txt', 'write')).toThrowError(
        ToolRefusalError
      )
    } finally {
      for (const p of [loopA, loopB]) {
        try {
          rmSync(p, { recursive: true, force: true })
        } catch {
          // junction loop trees sometimes refuse a clean rm — non-fatal in a temp dir
        }
      }
    }
  })
})
describe.skipIf(!canSymlink())('sandbox fixtures — true symlink escapes', () => {
  it('refuses a directory symlink pointing outside for writes, allows reads', () => {
    symlinkSync(outside, join(root, 'escape-symlink'), 'dir')
    expect(() => resolveWorkspacePath(root, 'escape-symlink/secret.txt', 'write')).toThrowError(
      ToolRefusalError
    )
    expect(resolveWorkspacePath(root, 'escape-symlink/secret.txt', 'read')).toBeTruthy()
  })

  it('refuses a symlink LOOP with a clean error, not a hang', () => {
    symlinkSync(join(root, 'loop-b'), join(root, 'loop-a'), 'dir')
    symlinkSync(join(root, 'loop-a'), join(root, 'loop-b'), 'dir')
    expect(() => resolveWorkspacePath(root, 'loop-a/anything.txt', 'read')).toThrowError(
      ToolRefusalError
    )
    expect(() => resolveWorkspacePath(root, 'loop-a/anything.txt', 'write')).toThrowError(
      ToolRefusalError
    )
  })
})

describe('sandbox fixtures — Windows path edges', () => {
  it('round-trips Unicode names (Arabic, CJK, emoji)', () => {
    const unicodeDir = join(root, 'مجلد-资料-📁')
    mkdirSync(unicodeDir)
    const resolved = resolveWorkspacePath(root, 'مجلد-资料-📁/تقرير.txt', 'write')
    expect(resolved).toBe(join(unicodeDir, 'تقرير.txt'))
    // Round-trip through the real fs.
    writeFileSync(resolved, 'unicode content', 'utf8')
    expect(readFileSync(resolved, 'utf8')).toBe('unicode content')
  })

  it('survives deep/long paths (create when the OS allows, refuse gracefully otherwise)', () => {
    let deep = root
    for (let i = 0; i < 32; i++) {
      const next = join(deep, `level-${String(i).padStart(2, '0')}`)
      try {
        mkdirSync(next)
      } catch {
        break // OS long-path limit reached — assert graceful refusal below
      }
      deep = next
    }
    const target = join(deep, 'leaf.txt')
    // Either the fs created the deep tree (resolve works) or it refused at
    // creation (resolve refuses gracefully) — either way NO crash/hang.
    try {
      const resolved = resolveWorkspacePath(root, target.slice(root.length + 1), 'write')
      expect(resolved.startsWith(root)).toBe(true)
    } catch (error) {
      expect(error).toBeInstanceOf(ToolRefusalError)
    }
    // A path far beyond any limit is refused cleanly by the fs layer.
    const absurd = `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}`
    try {
      resolveWorkspacePath(root, absurd, 'write')
    } catch (error) {
      expect(error).toBeInstanceOf(ToolRefusalError)
    }
  })

  it('treats case-variant paths as the same file (Windows case-insensitivity)', () => {
    if (process.platform !== 'win32') return
    const resolved = resolveWorkspacePath(root, 'SUB/FILE.TXT', 'write')
    expect(resolved.toLowerCase()).toBe(join(root, 'sub', 'file.txt').toLowerCase())
    // The real file is reachable through the case-variant spelling.
    expect(readFileSync(resolved, 'utf8')).toBe('inside')
  })

  it('refuses protected names (id_rsa, .ssh, credentials) inside the workspace', () => {
    expect(() => resolveWorkspacePath(root, 'id_rsa', 'write')).toThrowError(/protected list/)
    expect(() => resolveWorkspacePath(root, '.ssh/known_hosts', 'write')).toThrowError(
      /protected list/
    )
    expect(() => resolveWorkspacePath(root, 'config/credentials.json', 'write')).toThrowError(
      /protected list/
    )
    // Case-insensitive: ID_RSA is still refused.
    expect(() => resolveWorkspacePath(root, 'ID_RSA', 'read')).toThrowError(/protected list/)
  })

  it('honors a per-path override for the protected-name list', () => {
    // Overrides are workspace-RELATIVE paths (the Settings override UI will
    // store exactly this shape).
    const resolved = resolveWorkspacePath(root, 'config/credentials.json', 'write', {
      protectedPathOverrides: new Set([join('config', 'credentials.json')])
    })
    expect(resolved).toBe(join(root, 'config', 'credentials.json'))
  })
})

describe('sandbox fixtures — wrapper integration', () => {
  it('a write_file run through the wrapper refuses a junction escape and writes NOTHING outside', async () => {
    symlinkSync(outside, join(root, 'escape-junction'), 'junction')
    const harness = createHandlerHarness(root, 'approve')
    harness.registry.define(writeFileTool)
    const outcome = await harness.registry.run({
      tool: 'write_file',
      args: { path: 'escape-junction/secret.txt', content: 'pwned' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('refused')
    expect(outcome.error).toBe('sandbox')
    expect(harness.stages.order).toEqual([]) // refused before risk/snapshot/execute
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside') // untouched
  })
})
