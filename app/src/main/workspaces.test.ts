import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getCurrentWorkspace,
  initWorkspaces,
  listRecentWorkspaces,
  setCurrentWorkspace
} from './workspaces'

// Workspaces store (M2.2): the recents file survives restarts, is capped,
// tolerates corruption, never leaves atomic-write temp files behind, and
// stores the canonical (realpath'd) path. No DB involved — the store is plain
// Node; the SQLite attach-to-sessions proof lives in the Electron harness
// (phase-reports/m22-attach-*.mjs) because better-sqlite3 is Electron-ABI on
// this box.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agento-ws-test-'))
  mkdirSync(join(dir, 'ws'))
  mkdirSync(join(dir, 'ws', 'nested'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A "restart" is re-init(): the persisted FILE is what survives across app
// launches, so re-calling initWorkspaces(sameDir) reloads exactly what a fresh
// process would read from workspaces.json.
function restart(): void {
  initWorkspaces(dir)
}

describe('workspaces store — recents across restarts', () => {
  it('empty data dir starts with no workspace and no recents', () => {
    initWorkspaces(dir)
    expect(getCurrentWorkspace()).toBeNull()
    expect(listRecentWorkspaces()).toEqual([])
  })

  it('setCurrent persists; re-init (restart) reads current + recent back', () => {
    initWorkspaces(dir)
    const wsDir = join(dir, 'ws')
    const resolved = setCurrentWorkspace(wsDir)
    expect(resolved).toBe(wsDir)

    restart()
    expect(getCurrentWorkspace()).toBe(wsDir)
    const recents = listRecentWorkspaces()
    expect(recents).toHaveLength(1)
    expect(recents[0].path).toBe(wsDir)
  })

  it('caps recents at MAX_RECENTS, most recent first, dedupes by path', () => {
    initWorkspaces(dir)
    for (let i = 0; i < 14; i++) {
      const folder = join(dir, `folder-${i}`)
      mkdirSync(folder)
      setCurrentWorkspace(folder)
    }
    const recents = listRecentWorkspaces()
    expect(recents).toHaveLength(10)
    expect(recents[0].path).toBe(join(dir, 'folder-13'))
    expect(recents[9].path).toBe(join(dir, 'folder-4'))

    // Re-picking an existing recent moves it to the front and keeps one entry.
    setCurrentWorkspace(join(dir, 'folder-7'))
    const after = listRecentWorkspaces()
    expect(after).toHaveLength(10)
    expect(after[0].path).toBe(join(dir, 'folder-7'))
    expect(after.filter((entry) => entry.path === join(dir, 'folder-7'))).toHaveLength(1)
  })

  it('tolerates an absent or corrupt workspaces.json', () => {
    writeFileSync(join(dir, 'workspaces.json'), 'not json {{{', 'utf8')
    initWorkspaces(dir)
    expect(getCurrentWorkspace()).toBeNull()
    expect(listRecentWorkspaces()).toEqual([])
    // And recovers: setting a workspace overwrites the corrupt file.
    const wsDir = join(dir, 'ws')
    setCurrentWorkspace(wsDir)
    restart()
    expect(getCurrentWorkspace()).toBe(wsDir)
  })

  it('leaves no atomic-write temp files after persist', () => {
    initWorkspaces(dir)
    setCurrentWorkspace(join(dir, 'ws'))
    const leftovers = readdirSync(dir).filter((name) => name.includes('.agento-tmp'))
    expect(leftovers).toEqual([])
  })

  it('refuses a missing folder', () => {
    initWorkspaces(dir)
    expect(() => setCurrentWorkspace(join(dir, 'nope'))).toThrowError(/isn't accessible/)
  })

  it('accepts nested folders', () => {
    initWorkspaces(dir)
    expect(() => setCurrentWorkspace(join(dir, 'ws', 'nested'))).not.toThrow()
  })
})
