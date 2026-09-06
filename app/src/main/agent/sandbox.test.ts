import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { ToolRefusalError, resolveWorkspacePath } from './sandbox'

// M2.1 sandbox string rules (docs/06 §4.1 floor): relative intent only,
// absolute/drive/UNC/device paths and `..` escapes refused. The realpath
// junction/symlink walk arrives with the M2.3 hardening pass.

describe('resolveWorkspacePath (M2.1 string rules)', () => {
  const root = join('D:', 'ws', 'project')

  it('resolves a plain relative path inside the workspace', () => {
    expect(resolveWorkspacePath(root, 'report.txt')).toBe(join(root, 'report.txt'))
  })

  it('accepts nested relative paths and forward slashes', () => {
    expect(resolveWorkspacePath(root, 'docs/notes.md')).toBe(join(root, 'docs', 'notes.md'))
    expect(resolveWorkspacePath(root, './docs')).toBe(join(root, 'docs'))
  })

  it('collapses interior dot segments', () => {
    expect(resolveWorkspacePath(root, 'a/./b')).toBe(join(root, 'a', 'b'))
  })

  it('refuses an outright `..` escape', () => {
    expect(() => resolveWorkspacePath(root, '..')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, '../secret.txt')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, 'docs/../../secret.txt')).toThrowError(ToolRefusalError)
  })

  it('refuses drive-relative and absolute windows paths', () => {
    expect(() => resolveWorkspacePath(root, 'C:\\Windows\\secret')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, 'D:\\elsewhere\\x.txt')).toThrowError(ToolRefusalError)
    // `c:foo` is drive-relative, never a safe relative path.
    expect(() => resolveWorkspacePath(root, 'c:traversal')).toThrowError(ToolRefusalError)
  })

  it('refuses posix absolute and UNC / device paths', () => {
    expect(() => resolveWorkspacePath(root, '/etc/passwd')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, '\\\\server\\share')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, '\\\\.\\PhysicalDrive0')).toThrowError(ToolRefusalError)
  })

  it('refuses non-string and empty inputs', () => {
    expect(() => resolveWorkspacePath(root, '')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, '   ')).toThrowError(ToolRefusalError)
    expect(() => resolveWorkspacePath(root, 42)).toThrowError(ToolRefusalError)
  })
})
