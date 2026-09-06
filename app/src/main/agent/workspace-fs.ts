import { dirname, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { WorkspaceFs } from './types'
import { worksWithRoot } from './sandbox'

// The registry-injected fs facade (AGENTS.md rule 2): tool bodies never call
// node:fs directly; every mutation crosses this facade, which re-checks
// containment against the workspace root before touching the disk — defense in
// depth behind the wrapper's pre-resolved sandbox paths (docs/06 §4).
//
// Writes are temp-file + atomic rename on the same volume (docs/06 §4.5): a
// failed edit never leaves a half-written file, and the target path either
// exists in full or not at all.

export class WorkspaceFsRefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceFsRefusalError'
  }
}

export class WorkspaceFsReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceFsReadError'
  }
}

function assertInsideWorkspace(root: string, target: string): void {
  if (!worksWithRoot(target, root)) {
    throw new WorkspaceFsRefusalError(
      'I can only read and write inside your workspace folder (the filesystem guard refused this path).'
    )
  }
}

export function createWorkspaceFs(workspaceRoot: string): WorkspaceFs {
  return {
    existsSync(path: string): boolean {
      assertInsideWorkspace(workspaceRoot, path)
      return existsSync(path)
    },
    readFileSync(path: string): string {
      assertInsideWorkspace(workspaceRoot, path)
      try {
        return readFileSync(path, 'utf8')
      } catch (error) {
        throw new WorkspaceFsReadError(
          `I could not read "${relative(workspaceRoot, path)}" — ${
            error instanceof Error ? error.message : String(error)
          }.`
        )
      }
    },
    writeFileAtomic(path: string, content: string): number {
      assertInsideWorkspace(workspaceRoot, path)
      // Temp file lives NEXT to the target (same directory = same volume, so
      // the rename is atomic on Windows and POSIX alike). mkdirSync only
      // creates a missing parent for the target — never outside the workspace
      // (assertInsideWorkspace already ran on `path`).
      mkdirSync(dirname(path), { recursive: true })
      const tempPath = `${path}.${randomBytes(6).toString('hex')}.agento-tmp`
      try {
        writeFileSync(tempPath, content, 'utf8')
        renameSync(tempPath, path)
      } catch (error) {
        // Best-effort cleanup of the temp file on failure; the target is
        // untouched because the rename never happened.
        try {
          if (existsSync(tempPath)) unlinkSync(tempPath)
        } catch {
          // noop — cleanup is best-effort only
        }
        throw new WorkspaceFsRefusalError(
          `I could not write "${relative(workspaceRoot, path)}" — ${
            error instanceof Error ? error.message : String(error)
          }. Nothing was changed.`
        )
      }
      return Buffer.byteLength(content, 'utf8')
    }
  }
}
