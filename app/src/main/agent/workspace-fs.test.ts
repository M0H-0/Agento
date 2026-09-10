import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkspaceFs, WorkspaceFsRefusalError } from './workspace-fs'
import { createTempWorkspace } from './testing/harness'

// The registry-injected fs facade (AGENTS.md rule 2 backstop): even though the
// wrapper pre-resolves sandboxed paths, the facade itself refuses any path
// outside the workspace root — tools structurally cannot reach the disk
// directly, and no facade call can escape.

describe('createWorkspaceFs — containment backstop', () => {
  it('reads and writes inside the workspace', () => {
    const ws = createTempWorkspace()
    try {
      const fs = createWorkspaceFs(ws.root)
      fs.writeFileAtomic(join(ws.root, 'a.txt'), 'hello')
      expect(fs.readFileSync(join(ws.root, 'a.txt'))).toBe('hello')
      expect(fs.existsSync(join(ws.root, 'a.txt'))).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('refuses writes and reads that escape the workspace root', () => {
    const ws = createTempWorkspace()
    const outside = createTempWorkspace() // a sibling temp dir — the escape target
    try {
      const fs = createWorkspaceFs(ws.root)
      // Direct lexical escape
      expect(() => fs.writeFileAtomic(join(outside.root, 'x.txt'), 'pwn')).toThrowError(
        WorkspaceFsRefusalError
      )
      expect(() => fs.readFileSync(join(outside.root, 'x.txt'))).toThrowError(
        WorkspaceFsRefusalError
      )
      expect(existsSync(join(outside.root, 'x.txt'))).toBe(false)
      // Verbatim traversal string a tool might feed the facade
      expect(() => fs.writeFileAtomic(ws.root + '\\..\\outside.txt', 'pwn')).toThrowError(
        WorkspaceFsRefusalError
      )
    } finally {
      ws.cleanup()
      outside.cleanup()
    }
  })

  it('returns the byte size of what it wrote', () => {
    const ws = createTempWorkspace()
    try {
      const fs = createWorkspaceFs(ws.root)
      const size = fs.writeFileAtomic(join(ws.root, 'size.txt'), 'héllo')
      expect(size).toBe(Buffer.byteLength('héllo', 'utf8'))
    } finally {
      ws.cleanup()
    }
  })

  it('lists directory entries with a type tag and refuses to escape', () => {
    const ws = createTempWorkspace()
    try {
      ws.write('top.txt', 'x')
      // Manually create a subdirectory (the harness only knows files).
      mkdirSync(join(ws.root, 'docs'))
      const fs = createWorkspaceFs(ws.root)
      const entries = fs.readdir(ws.root)
      const names = entries.map((entry) => entry.name).sort()
      expect(names).toEqual(['docs', 'top.txt'])
      const typed = Object.fromEntries(entries.map((entry) => [entry.name, entry.type]))
      expect(typed['top.txt']).toBe('file')
      expect(typed['docs']).toBe('directory')
      expect(fs.isDirectory(join(ws.root, 'docs'))).toBe(true)
      expect(fs.isDirectory(join(ws.root, 'top.txt'))).toBe(false)
      // Outside-workspace readdir refuses
      const outside = createTempWorkspace()
      try {
        expect(() => fs.readdir(outside.root)).toThrowError(WorkspaceFsRefusalError)
      } finally {
        outside.cleanup()
      }
    } finally {
      ws.cleanup()
    }
  })

  it('walks files recursively (directories excluded) and respects the limit', () => {
    const ws = createTempWorkspace()
    try {
      mkdirSync(join(ws.root, 'a'))
      mkdirSync(join(ws.root, 'a', 'b'))
      ws.write('a/one.md', '1')
      ws.write('a/b/two.md', '2')
      ws.write('three.md', '3')
      const fs = createWorkspaceFs(ws.root)
      const all = fs.walkFiles(ws.root, 100).map((p) =>
        p
          .replace(ws.root, '')
          .replace(/^[\\/]/, '')
          .replace(/\\/g, '/')
      )
      expect(all.sort()).toEqual(['a/b/two.md', 'a/one.md', 'three.md'])
      const capped = fs.walkFiles(ws.root, 2)
      expect(capped.length).toBe(2)
    } finally {
      ws.cleanup()
    }
  })

  it('walkFiles never recurses through a junction (or symlink) directory', () => {
    const ws = createTempWorkspace()
    const outside = createTempWorkspace() // the junction target
    try {
      try {
        // Junctions need no privileges on Windows (sandbox fixtures precedent).
        symlinkSync(outside.root, join(ws.root, 'linked'), 'junction')
      } catch {
        return // no junction support on this box — skip silently
      }
      ws.write('plain.txt', 'x')
      outside.write('secret.txt', 'x')
      const fs = createWorkspaceFs(ws.root)
      const all = fs.walkFiles(ws.root, 100).map((p) =>
        p
          .replace(ws.root, '')
          .replace(/^[\\/]/, '')
          .replace(/\\/g, '/')
      )
      // The linked dir's files must NOT appear — the walk never follows links
      // (their targets may sit outside the workspace or be a cycle; M2.8 fix).
      expect(all).toEqual(['plain.txt'])
    } finally {
      ws.cleanup()
      outside.cleanup()
    }
  })

  it('round-trips invalid-UTF-8 bytes without corruption', () => {
    const ws = createTempWorkspace()
    try {
      const fs = createWorkspaceFs(ws.root)
      const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80, 0x81])
      fs.writeFileBytes(join(ws.root, 'bin.dat'), raw)
      expect(fs.readFileBytes(join(ws.root, 'bin.dat')).equals(raw)).toBe(true)
    } finally {
      ws.cleanup()
    }
  })
})
