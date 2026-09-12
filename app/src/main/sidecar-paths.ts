import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Packaged-vs-dev path resolution for the M6.6 NSIS installer (docs/02 §5).
// Plain Node only — no Electron imports (AGENTS.md rule 1). Pure functions
// so the packaged-branch logic is unit-testable without an Electron harness.
//
// Layouts:
//   dev:      <repo>/app (appPath) + <repo>/services/intelligence + <app>/drizzle,
//             uv resolved from PATH.
//   packaged: <resources>/sidecar (agento_intelligence sources + pyproject +
//             uv.lock), <resources>/drizzle (migrations), <resources>/bin/uv.exe
//             (pinned bootstrap binary), all via electron-builder extraResources.

export interface PackagedLayout {
  /** True when running from the installed NSIS build. */
  isPackaged: boolean
  /** Electron app.getAppPath() — dev: <repo>/app; packaged: .../resources/app.asar. */
  appPath: string
  /** Electron process.resourcesPath — only meaningful when packaged. */
  resourcesPath: string
}

/** Where uvicorn resolves `agento_intelligence` from (docs/02 §2.4). */
export function resolveSidecarCwd(layout: PackagedLayout): string {
  const packaged = join(layout.resourcesPath, 'sidecar')
  if (layout.isPackaged && existsSync(join(packaged, 'pyproject.toml'))) return packaged
  // Dev fallback — also the honest fallback if a packaged install is damaged:
  // the spawn then fails with a plain-language error instead of a crash.
  return resolve(layout.appPath, '..', 'services', 'intelligence')
}

/** Where the drizzle-kit migrations live for openDatabase(). */
export function resolveMigrationsFolder(layout: PackagedLayout): string {
  const packaged = join(layout.resourcesPath, 'drizzle')
  if (layout.isPackaged && existsSync(join(packaged, 'meta', '_journal.json'))) return packaged
  return join(layout.appPath, 'drizzle')
}

/**
 * Which uv binary bootstraps / runs the sidecar. Packaged: the pinned binary
 * in resources (clean machines have no uv on PATH). Dev / fallback: 'uv'
 * from PATH, exactly as today.
 */
export function resolveUvBinary(layout: PackagedLayout): string {
  const packaged = join(layout.resourcesPath, 'bin', 'uv.exe')
  if (layout.isPackaged && existsSync(packaged)) return packaged
  return 'uv'
}

/** Marker written after a successful first-run bootstrap (under userData). */
export function sidecarReadyMarker(sidecarDataDir: string): string {
  return join(sidecarDataDir, '.agento-sidecar-ready')
}

/**
 * True when the on-disk sidecar environment is ready to spawn: the marker
 * exists AND the venv python is still there (a half-deleted dir re-runs the
 * bootstrap instead of failing obscurely).
 */
export function isSidecarBootstrapped(sidecarDataDir: string): boolean {
  return (
    existsSync(sidecarReadyMarker(sidecarDataDir)) &&
    existsSync(join(sidecarDataDir, '.venv', 'Scripts', 'python.exe'))
  )
}
