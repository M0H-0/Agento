// Fetches the pinned uv Windows binary for the NSIS payload (M6.6).
//
// The clean-machine installer bootstraps Python via a bundled uv binary
// (`uv python install` needs no system Python). This script downloads the
// pinned release zip, extracts `uv.exe` into `app/build-cache/uv/`, and
// prints its sha256 for the Devlog record. Shell-agnostic (plain Node) so
// it runs in both PowerShell and Git Bash.
//
// The version is pinned to the toolchain this repo was built with —
// `uv --version` on the dev box — never bumped by hand (AGENTS.md rule 5:
// lockfiles are the version truth; this constant is the equivalent pin
// for a build-time binary that cannot live in a lockfile).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { get } from 'node:https'
import { join, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const UV_VERSION = '0.12.8'
const ZIP_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`
const DEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build-cache', 'uv')
const DEST_EXE = join(DEST_DIR, 'uv.exe')

/** @returns {Promise<void>} resolves when the file is fully written */
function fetchToFile(url, destPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    get(url, { headers: { 'User-Agent': 'agento-build-fetch-uv' } }, (response) => {
      // Follow GitHub's release-asset redirect (github.com -> objects.githubusercontent.com).
      if (
        response.statusCode !== null &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume()
        resolvePromise(fetchToFile(response.headers.location, destPath))
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        rejectPromise(new Error(`Download failed: HTTP ${String(response.statusCode)} for ${url}`))
        return
      }
      pipeline(response, createWriteStream(destPath))
        .then(() => resolvePromise(undefined))
        .catch(rejectPromise)
    }).on('error', rejectPromise)
  })
}

/** @returns {Promise<void>} */
async function main() {
  if (existsSync(DEST_EXE)) {
    console.log(`[fetch:uv] already cached at ${DEST_EXE} — delete it to re-fetch.`)
    return
  }
  mkdirSync(DEST_DIR, { recursive: true })
  const zipPath = join(DEST_DIR, `uv-${UV_VERSION}.zip`)
  console.log(`[fetch:uv] downloading ${ZIP_URL}`)
  await fetchToFile(ZIP_URL, zipPath)
  // Extract via Expand-Archive (powershell.exe ships with Windows, so this
  // works from both PowerShell and Git Bash). The zip holds uv.exe directly.
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${DEST_DIR}' -Force`
      ],
      { stdio: 'inherit' }
    )
  } catch {
    throw new Error(
      '[fetch:uv] Expand-Archive failed — extract uv.exe from the zip by hand into app/build-cache/uv/.'
    )
  }
  if (!existsSync(DEST_EXE))
    throw new Error(`[fetch:uv] uv.exe missing after extract (${DEST_DIR}).`)
  const sha256 = createHash('sha256').update(readFileSync(DEST_EXE)).digest('hex')
  console.log(`[fetch:uv] cached ${DEST_EXE}`)
  console.log(`[fetch:uv] sha256(uv.exe) = ${sha256}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
