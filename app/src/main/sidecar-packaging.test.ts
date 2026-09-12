import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapSidecar, packagedSidecarEnv } from './sidecar-bootstrap'
import type { SpawnFn } from './sidecar-bootstrap'
import {
  isSidecarBootstrapped,
  resolveMigrationsFolder,
  resolveSidecarCwd,
  resolveUvBinary
} from './sidecar-paths'

// M6.6 NSIS packaging: packaged-vs-dev path resolution + first-run bootstrap,
// all without spawning real processes (the fake below mimics ChildProcess).

function makeLayout(extra: { isPackaged: boolean; appPath: string; resourcesPath: string }): {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
} {
  return extra
}

function fixtureResources(withSidecar: boolean, withDrizzle: boolean, withUv: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'agento-pkg-'))
  if (withSidecar) {
    mkdirSync(join(root, 'sidecar'), { recursive: true })
    writeFileSync(join(root, 'sidecar', 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8')
  }
  if (withDrizzle) {
    mkdirSync(join(root, 'drizzle', 'meta'), { recursive: true })
    writeFileSync(join(root, 'drizzle', 'meta', '_journal.json'), '{}', 'utf8')
  }
  if (withUv) {
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'uv.exe'), 'fake', 'utf8')
  }
  return root
}

interface FakeCall {
  command: string
  args: string[]
  cwd: string
}

function fakeSpawn(exitCodes: number[]): { spawnFn: SpawnFn; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  let step = 0
  const spawnFn = ((
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined> }
  ) => {
    calls.push({ command, args, cwd: options.cwd })
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter
      kill(): boolean
    }
    child.stderr = new EventEmitter()
    child.kill = (): boolean => true
    const code = exitCodes[step] ?? 0
    step += 1
    setImmediate(() => {
      child.emit('close', code)
    })
    return child
  }) as unknown as SpawnFn
  return { spawnFn, calls }
}

describe('resolveSidecarCwd', () => {
  it('uses resources/sidecar when packaged and the sources exist', () => {
    const resources = fixtureResources(true, false, false)
    expect(
      resolveSidecarCwd(
        makeLayout({ isPackaged: true, appPath: 'C:\\x\\app', resourcesPath: resources })
      )
    ).toBe(join(resources, 'sidecar'))
  })

  it('falls back to the dev tree when packaged but damaged', () => {
    const resources = fixtureResources(false, false, false)
    const appPath = join('C:', 'repo', 'app')
    expect(
      resolveSidecarCwd(makeLayout({ isPackaged: true, appPath, resourcesPath: resources }))
    ).toBe(join('C:', 'repo', 'services', 'intelligence'))
  })

  it('uses the dev tree when not packaged', () => {
    const appPath = join('C:', 'repo', 'app')
    expect(
      resolveSidecarCwd(makeLayout({ isPackaged: false, appPath, resourcesPath: 'C:\\nope' }))
    ).toBe(join('C:', 'repo', 'services', 'intelligence'))
  })
})

describe('resolveMigrationsFolder', () => {
  it('uses resources/drizzle when packaged and the journal exists', () => {
    const resources = fixtureResources(false, true, false)
    expect(
      resolveMigrationsFolder(
        makeLayout({ isPackaged: true, appPath: 'C:\\x\\app', resourcesPath: resources })
      )
    ).toBe(join(resources, 'drizzle'))
  })

  it('falls back to app/drizzle otherwise', () => {
    const resources = fixtureResources(false, false, false)
    const appPath = join('C:', 'repo', 'app')
    expect(
      resolveMigrationsFolder(makeLayout({ isPackaged: true, appPath, resourcesPath: resources }))
    ).toBe(join(appPath, 'drizzle'))
  })
})

describe('resolveUvBinary', () => {
  it('uses the pinned binary when packaged and present', () => {
    const resources = fixtureResources(false, false, true)
    expect(
      resolveUvBinary(makeLayout({ isPackaged: true, appPath: 'C:\\x', resourcesPath: resources }))
    ).toBe(join(resources, 'bin', 'uv.exe'))
  })

  it('falls back to PATH uv otherwise', () => {
    const resources = fixtureResources(false, false, false)
    expect(
      resolveUvBinary(makeLayout({ isPackaged: true, appPath: 'C:\\x', resourcesPath: resources }))
    ).toBe('uv')
    expect(
      resolveUvBinary(makeLayout({ isPackaged: false, appPath: 'C:\\x', resourcesPath: resources }))
    ).toBe('uv')
  })
})

describe('isSidecarBootstrapped', () => {
  it('is false on a fresh dir, true only with marker + venv python', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agento-sidecar-'))
    expect(isSidecarBootstrapped(dir)).toBe(false)
    writeFileSync(join(dir, '.agento-sidecar-ready'), 'ready=x\n', 'utf8')
    expect(isSidecarBootstrapped(dir)).toBe(false)
    mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true })
    writeFileSync(join(dir, '.venv', 'Scripts', 'python.exe'), 'fake', 'utf8')
    expect(isSidecarBootstrapped(dir)).toBe(true)
  })
})

describe('bootstrapSidecar', () => {
  it('runs python install then sync and writes the marker', async () => {
    const { spawnFn, calls } = fakeSpawn([0, 0])
    const source = mkdtempSync(join(tmpdir(), 'agento-src-'))
    const data = mkdtempSync(join(tmpdir(), 'agento-data-'))
    const progress: string[] = []
    const result = await bootstrapSidecar(
      {
        uvBinary: 'C:\\r\\bin\\uv.exe',
        sidecarSourceDir: source,
        sidecarDataDir: data,
        onProgress: (detail) => progress.push(detail)
      },
      spawnFn
    )
    expect(result).toEqual({ ok: true })
    expect(calls.map((c) => c.args)).toEqual([
      ['python', 'install', '3.12'],
      ['sync', '--frozen']
    ])
    expect(calls[0]?.command).toBe('C:\\r\\bin\\uv.exe')
    expect(calls[0]?.cwd).toBe(source)
    expect(progress).toHaveLength(2)
    expect(isSidecarBootstrapped(data)).toBe(false) // no venv python in the fake
  })

  it('fails honestly when the Python download fails', async () => {
    const { spawnFn } = fakeSpawn([1])
    const result = await bootstrapSidecar(
      {
        uvBinary: 'uv',
        sidecarSourceDir: mkdtempSync(join(tmpdir(), 'agento-src-')),
        sidecarDataDir: mkdtempSync(join(tmpdir(), 'agento-data-'))
      },
      spawnFn
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.detail).toMatch(/one-time download/i)
      expect(result.detail).toMatch(/restart Agento/i)
    }
  })

  it('fails honestly when the venv sync fails', async () => {
    const { spawnFn, calls } = fakeSpawn([0, 1])
    const result = await bootstrapSidecar(
      {
        uvBinary: 'uv',
        sidecarSourceDir: mkdtempSync(join(tmpdir(), 'agento-src-')),
        sidecarDataDir: mkdtempSync(join(tmpdir(), 'agento-data-'))
      },
      spawnFn
    )
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(2)
  })
})

describe('packagedSidecarEnv', () => {
  it('reuses the bootstrapped venv and stays offline', () => {
    const env = packagedSidecarEnv('C:\\Users\\x\\AppData\\Roaming\\Agento\\sidecar')
    expect(env['UV_OFFLINE']).toBe('1')
    expect(env['UV_PROJECT_ENVIRONMENT']).toContain('.venv')
    expect(env['UV_CACHE_DIR']).toContain('cache')
  })
})
