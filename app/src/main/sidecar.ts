import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// Sidecar lifecycle (docs/02 §2.4): spawn the intelligence service, poll
// /health, and attach the per-launch token to every sidecar request. Plain
// Node only — no Electron imports (AGENTS.md rule 1); window/lifecycle wiring
// lives in src/main/index.ts.

export type SidecarStatus = 'starting' | 'healthy' | 'unhealthy'

export interface SidecarStatusEvent {
  status: SidecarStatus
  detail?: string
}

const SIDECAR_PORT = 7891
const SIDECAR_ORIGIN = `http://127.0.0.1:${SIDECAR_PORT}`
const AUTH_HEADER = 'X-Agento-Token'
const BOOT_POLL_MS = 500
const LIGHT_POLL_MS = 5000
const BOOT_CEILING_MS = 15000
const REQUEST_TIMEOUT_MS = 2000
const STDERR_TAIL_LINES = 8

let child: ChildProcess | null = null
let authToken: string | null = null
let status: SidecarStatusEvent = { status: 'starting' }
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollInFlight = false
let shuttingDown = false
let bootDeadline = 0
const stderrTail: string[] = []
const statusListeners = new Set<(event: SidecarStatusEvent) => void>()

/** Per-launch random token (docs/02 §2.4); called once per app launch. */
export function generateSidecarToken(): string {
  return randomBytes(32).toString('hex')
}

export function getSidecarStatus(): SidecarStatusEvent {
  return status
}

export function onSidecarStatusChange(listener: (event: SidecarStatusEvent) => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

function setStatus(next: SidecarStatusEvent): void {
  // Push transitions only — the 5 s light poll must not re-send 'healthy'.
  if (next.status === status.status) return
  status = next
  for (const listener of statusListeners) listener(status)
}

/**
 * The one fetch helper for sidecar calls: attaches X-Agento-Token to every
 * request (docs/02 §2.4). All main-process sidecar calls must go through it.
 */
export function sidecarFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (authToken !== null) headers.set(AUTH_HEADER, authToken)
  return fetch(`${SIDECAR_ORIGIN}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
}

function captureStderr(chunk: Buffer): void {
  for (const line of chunk.toString('utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    stderrTail.push(line)
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
  }
}

function stderrDetail(): string {
  return stderrTail.length > 0 ? ` Sidecar stderr: ${stderrTail.join(' | ')}` : ''
}

function setPollCadence(intervalMs: number): void {
  if (pollTimer !== null) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    void poll()
  }, intervalMs)
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await sidecarFetch('/health')
    if (response.status !== 200) return false
    const body = (await response.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}

async function poll(): Promise<void> {
  if (shuttingDown || pollInFlight) return
  pollInFlight = true
  try {
    if (await isHealthy()) {
      setStatus({ status: 'healthy' })
      setPollCadence(LIGHT_POLL_MS)
      return
    }
    // During boot, /health refusing connections is expected — only the 15 s
    // ceiling (or a spawn error / exit) declares 'unhealthy'.
    if (status.status === 'healthy') {
      setStatus({ status: 'unhealthy', detail: `Health check failed.${stderrDetail()}` })
    } else if (status.status === 'starting' && Date.now() >= bootDeadline) {
      setStatus({
        status: 'unhealthy',
        detail: `Sidecar did not answer /health within ${BOOT_CEILING_MS} ms.${stderrDetail()}`
      })
      setPollCadence(LIGHT_POLL_MS)
    }
  } finally {
    pollInFlight = false
  }
}

export function startSidecar(token: string, sidecarCwd: string, fastembedCachePath?: string): void {
  if (child !== null) return
  authToken = token
  bootDeadline = Date.now() + BOOT_CEILING_MS

  // Spawn contract (docs/02 §2.4, M0.4 report): exact command, and cwd =
  // services/intelligence because uvicorn resolves agento_intelligence off
  // the cwd on sys.path — the project is unpackaged.
  child = spawn(
    'uv',
    ['run', 'uvicorn', 'agento_intelligence.main:app', '--port', String(SIDECAR_PORT)],
    {
      cwd: sidecarCwd,
      env: {
        ...process.env,
        AGENTO_INTELLIGENCE_TOKEN: token,
        UV_LINK_MODE: 'copy',
        // MVP semantic search (2026-09-10): fastembed 0.8 defaults its cache
        // to the TEMP directory (Windows cleanup would delete the ~90 MB
        // model), so the caller pins a durable app-owned path. HF_HUB_OFFLINE=1:
        // the hub's file CDN hangs indefinitely on this network (the API
        // answers but file downloads stall — no error, so fastembed's GCS
        // fallback never fires), while its GCS mirror is fast. The model is
        // seeded manually into the cache (Devlog); a fresh machine must seed
        // it once or semantic_search answers 503 honestly.
        ...(fastembedCachePath !== undefined ? { FASTEMBED_CACHE_PATH: fastembedCachePath } : {}),
        HF_HUB_OFFLINE: '1'
      },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )

  child.stderr?.on('data', captureStderr)
  child.on('error', (error) => {
    if (shuttingDown) return
    setStatus({
      status: 'unhealthy',
      detail: `Failed to spawn sidecar: ${error.message}.${stderrDetail()}`
    })
    setPollCadence(LIGHT_POLL_MS)
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    setStatus({
      status: 'unhealthy',
      detail: `Sidecar process exited (code ${String(code)}, signal ${String(signal)}).${stderrDetail()}`
    })
    setPollCadence(LIGHT_POLL_MS)
  })

  setPollCadence(BOOT_POLL_MS)
}

export function killSidecar(): void {
  if (shuttingDown) return
  shuttingDown = true
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  const pid = child?.pid
  if (pid !== undefined) {
    // `uv run` is a uv→uvicorn→python chain: child.kill() would orphan python
    // still holding port 7891, so tree-kill the whole chain instead. detached
    // spawns with CREATE_BREAKAWAY_FROM_JOB — without it the taskkill inherits
    // Electron's job object (kill-on-close) and dies mid-tree-kill when the
    // app exits, orphaning the chain. Verified against that exact failure.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    })
  }
}

// Dev guards: the Electron 'before-quit' hook (src/main/index.ts) covers
// normal quits; these catch Ctrl+C / hard exits so a dev relaunch never hits
// a busy port. 'exit' handlers are synchronous-only — the taskkill spawn is
// best-effort but the created process runs independently of ours.
process.once('SIGINT', () => {
  killSidecar()
  process.exit(0)
})
process.once('SIGTERM', () => {
  killSidecar()
  process.exit(0)
})
process.on('exit', () => {
  killSidecar()
})
