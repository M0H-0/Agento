import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { sidecarReadyMarker } from './sidecar-paths'

// First-run sidecar bootstrap for the packaged NSIS build (docs/02 §5).
// Clean machines have no Python and no uv: the installer ships a pinned uv
// binary + the sidecar sources, and this module downloads everything else
// once (CPython 3.12 + the locked venv) into the user's data dir. Plain Node
// only — no Electron imports (AGENTS.md rule 1).
//
// Failure doctrine (docs/05 §6): any failure returns `{ ok: false, detail }`
// with a plain-language message. The caller keeps the app in degraded mode —
// file tools keep working, document tools answer honestly offline.

export const SIDECAR_PYTHON_VERSION = '3.12'
/** One-time downloads can be slow (CPython + ~150 MB of wheels + model later). */
export const BOOTSTRAP_STEP_TIMEOUT_MS = 10 * 60 * 1000

export interface BootstrapOptions {
  /** Pinned `uv` binary (packaged) or 'uv' from PATH (dev fallback). */
  uvBinary: string
  /** Directory holding pyproject.toml + uv.lock (resources/sidecar packaged). */
  sidecarSourceDir: string
  /** App-owned dir for the venv + caches (`<userData>/sidecar`). */
  sidecarDataDir: string
  /** Progress copy for the status-dot detail (already plain-language). */
  onProgress?: (detail: string) => void
}

export type BootstrapResult = { ok: true } | { ok: false; detail: string }

/** Minimal spawn surface so tests can inject a fake without processes. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> }
) => ChildProcess

function defaultEnv(dataDir: string): Record<string, string | undefined> {
  return {
    ...process.env,
    UV_PROJECT_ENVIRONMENT: `${dataDir}\\.venv`,
    UV_CACHE_DIR: `${dataDir}\\cache`,
    UV_PYTHON_INSTALL_DIR: `${dataDir}\\python`,
    UV_LINK_MODE: 'copy'
  }
}

function runStep(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
  timeoutMs: number
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnFn(command, args, options)
    const stderrChunks: string[] = []
    let settled = false
    const finish = (code: number | null, stderr: string): void => {
      if (settled) return
      settled = true
      resolve({ code, stderr })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // best-effort — the result below reports the timeout either way
      }
      finish(null, `Timed out after ${Math.round(timeoutMs / 60000)} minutes.`)
    }, timeoutMs)
    // The real ChildProcess always has these; the test fake mimics them.
    const stderr = (child as { stderr?: { on(ev: string, cb: (c: Buffer) => void): void } }).stderr
    stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'))
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      finish(null, error.message)
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      finish(code, stderrChunks.join('').trim().slice(-2000))
    })
  })
}

export async function bootstrapSidecar(
  options: BootstrapOptions,
  spawnFn: SpawnFn = spawn as unknown as SpawnFn
): Promise<BootstrapResult> {
  const { uvBinary, sidecarSourceDir, sidecarDataDir, onProgress } = options
  mkdirSync(sidecarDataDir, { recursive: true })
  const env = defaultEnv(sidecarDataDir)

  onProgress?.('Setting up document tools — downloading Python (once)…')
  const python = await runStep(
    spawnFn,
    uvBinary,
    ['python', 'install', SIDECAR_PYTHON_VERSION],
    { cwd: sidecarSourceDir, env },
    BOOTSTRAP_STEP_TIMEOUT_MS
  )
  if (python.code !== 0) {
    return {
      ok: false,
      detail:
        `Document tools need a one-time download (Python ${SIDECAR_PYTHON_VERSION}) that just failed` +
        `${python.stderr !== '' ? `: ${python.stderr}` : '.'} Check your connection and restart Agento to retry — your files are untouched.`
    }
  }

  onProgress?.('Setting up document tools — installing document support (once)…')
  const sync = await runStep(
    spawnFn,
    uvBinary,
    ['sync', '--frozen'],
    { cwd: sidecarSourceDir, env },
    BOOTSTRAP_STEP_TIMEOUT_MS
  )
  if (sync.code !== 0) {
    return {
      ok: false,
      detail:
        'Document tools need a one-time download (document support) that just failed' +
        `${sync.stderr !== '' ? `: ${sync.stderr}` : '.'} Check your connection and restart Agento to retry — your files are untouched.`
    }
  }

  writeFileSync(
    sidecarReadyMarker(sidecarDataDir),
    `ready=${new Date().toISOString()} uv=${uvBinary} python=${SIDECAR_PYTHON_VERSION}\n`,
    'utf8'
  )
  return { ok: true }
}

/** Env a packaged `uv run` needs to reuse the bootstrapped venv offline. */
export function packagedSidecarEnv(sidecarDataDir: string): Record<string, string> {
  return {
    UV_PROJECT_ENVIRONMENT: `${sidecarDataDir}\\.venv`,
    UV_CACHE_DIR: `${sidecarDataDir}\\cache`,
    UV_PYTHON_INSTALL_DIR: `${sidecarDataDir}\\python`,
    UV_LINK_MODE: 'copy',
    UV_OFFLINE: '1'
  }
}
