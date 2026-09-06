import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
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
})
