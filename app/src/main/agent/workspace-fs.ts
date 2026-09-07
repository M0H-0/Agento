import { dirname, join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync as nodeReaddirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
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

// Single shallow entry-type tag — keeps the card-meta line honest without
// shelling out to `fs.stat` per child (we already need the stat for the
// isDirectory distinction).
function tagEntryType(name: string, parent: string): 'file' | 'directory' {
  try {
    return statSync(join(parent, name)).isDirectory() ? 'directory' : 'file'
  } catch {
    // Race against a vanished entry (rare; tool errors are caught above).
    return 'file'
  }
}

export function createWorkspaceFs(workspaceRoot: string): WorkspaceFs {
  const facade: WorkspaceFs = {
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
    },
    isDirectory(path: string): boolean {
      assertInsideWorkspace(workspaceRoot, path)
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    mkdir(path: string): void {
      assertInsideWorkspace(workspaceRoot, path)
      try {
        mkdirSync(path, { recursive: true })
      } catch (error) {
        throw new WorkspaceFsRefusalError(
          `I could not create the folder "${relative(workspaceRoot, path)}" — ${
            error instanceof Error ? error.message : String(error)
          }. Nothing was changed.`
        )
      }
    },
    movePath(from: string, to: string): void {
      assertInsideWorkspace(workspaceRoot, from)
      assertInsideWorkspace(workspaceRoot, to)
      if (!existsSync(from)) {
        throw new WorkspaceFsRefusalError(
          `I couldn't find "${relative(workspaceRoot, from)}" — it may have been moved or renamed. Nothing was changed.`
        )
      }
      // Missing dest parents are created (writeFileAtomic doctrine); an
      // existing dest is replaced — the wrapper snapshots both sides first,
      // so undo restores each (docs/03 §8).
      mkdirSync(dirname(to), { recursive: true })
      try {
        if (existsSync(to)) {
          if (statSync(to).isDirectory()) rmdirSync(to)
          else unlinkSync(to)
        }
        renameSync(from, to)
      } catch (error) {
        throw new WorkspaceFsRefusalError(
          `I could not move "${relative(workspaceRoot, from)}" — ${
            error instanceof Error ? error.message : String(error)
          }. Nothing was changed.`
        )
      }
    },
    copyPath(from: string, to: string): number {
      assertInsideWorkspace(workspaceRoot, from)
      assertInsideWorkspace(workspaceRoot, to)
      if (!existsSync(from)) {
        throw new WorkspaceFsRefusalError(
          `I couldn't find "${relative(workspaceRoot, from)}" — it may have been moved or renamed. Nothing was changed.`
        )
      }
      let size = 0
      try {
        size = statSync(from).size
        if (statSync(from).isDirectory()) {
          throw new WorkspaceFsRefusalError(
            `I can only copy files, not folders ("${relative(workspaceRoot, from)}" is a folder). Nothing was changed.`
          )
        }
      } catch (error) {
        if (error instanceof WorkspaceFsRefusalError) throw error
        throw new WorkspaceFsRefusalError(
          `I could not read "${relative(workspaceRoot, from)}" — ${
            error instanceof Error ? error.message : String(error)
          }. Nothing was changed.`
        )
      }
      mkdirSync(dirname(to), { recursive: true })
      try {
        // Byte-exact (not text) so non-text files survive the copy; the
        // snapshot layer stays text-oriented by design (write_file doctrine).
        copyFileSync(from, to)
      } catch (error) {
        throw new WorkspaceFsRefusalError(
          `I could not copy "${relative(workspaceRoot, from)}" — ${
            error instanceof Error ? error.message : String(error)
          }. Nothing was changed.`
        )
      }
      return size
    },
    deletePath(path: string): void {
      assertInsideWorkspace(workspaceRoot, path)
      if (!existsSync(path)) {
        throw new WorkspaceFsRefusalError(
          `I couldn't find "${relative(workspaceRoot, path)}" — it may already be gone. Nothing was changed.`
        )
      }
      try {
        if (statSync(path).isDirectory()) rmdirSync(path)
        else unlinkSync(path)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code === 'ENOTEMPTY' || code === 'EEXIST') {
          throw new WorkspaceFsRefusalError(
            `I won't delete the folder "${relative(workspaceRoot, path)}" because it still has files in it — move or delete those first. Nothing was changed.`
          )
        }
        throw new WorkspaceFsRefusalError(
          `I could not delete "${relative(workspaceRoot, path)}" — ${
            error instanceof Error ? error.message : String(error)
          }. Nothing was changed.`
        )
      }
    },
    readdir(path: string): { name: string; type: 'file' | 'directory' }[] {
      assertInsideWorkspace(workspaceRoot, path)
      let names: string[]
      try {
        names = nodeReaddirSync(path)
      } catch (error) {
        throw new WorkspaceFsReadError(
          `I couldn't list "${relative(workspaceRoot, path)}" — ${
            error instanceof Error ? error.message : String(error)
          }.`
        )
      }
      return names.map((name) => ({ name, type: tagEntryType(name, path) }))
    },
    walkFiles(root: string, limit: number): string[] {
      assertInsideWorkspace(workspaceRoot, root)
      // Iterative DFS, alphabetical, capped at `limit`. Skips directories
      // entirely (the caller wants file paths to search) and never recurses
      // into symlinks (a symlink cycle would not terminate, and the sandbox
      // is the authoritative check on where the walk can go).
      const out: string[] = []
      const stack: string[] = [root]
      while (stack.length > 0 && out.length < limit) {
        const dir = stack.pop() as string
        let names: string[]
        try {
          names = nodeReaddirSync(dir)
        } catch {
          continue
        }
        names.sort()
        for (const name of names) {
          if (out.length >= limit) break
          const child = join(dir, name)
          let isDir = false
          try {
            isDir = statSync(child).isDirectory()
          } catch {
            continue
          }
          if (isDir) {
            stack.push(child)
          } else {
            out.push(child)
          }
        }
      }
      return out
    }
  }
  return facade
}
