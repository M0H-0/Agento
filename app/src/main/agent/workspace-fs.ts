import { dirname, join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
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
import { assertAbsoluteInsideWorkspace, worksWithRoot } from './sandbox'

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

// S3-006: node:fs errno detail embeds ABSOLUTE rename ends
// (`ENOENT: … rename 'C:\ws\a' → 'C:\ws\b'`), which used to ride the card
// sentence verbatim into the thread. Redact every rooted path in the detail
// to its workspace-relative form — the quoted headline is already relative,
// and the technical row in `tool_calls` inherits the same redacted string.
function redactRoot(root: string, message: string): string {
  if (!root) return message
  const norm = root.replace(/\\/g, '/').replace(/\/$/, '')
  if (!norm) return message
  const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]')
  const re = new RegExp(`${escaped}([\\\\/][^"'\\s]*)?`, 'gi')
  return message.replace(re, (_match, rest?: string) => {
    if (!rest) return '.'
    return rest.replace(/^[\\/]+/, '').replace(/\\/g, '/')
  })
}

function detailOf(root: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactRoot(root, message)
}

function revalidate(root: string, target: string, access: 'read' | 'write'): void {
  assertInsideWorkspace(root, target)
  try {
    assertAbsoluteInsideWorkspace(root, target, access)
  } catch (error) {
    if (error instanceof Error && 'kind' in error) {
      throw new WorkspaceFsRefusalError(error.message)
    }
    throw error
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

function writeBufferAtomic(workspaceRoot: string, path: string, data: Buffer): number {
  revalidate(workspaceRoot, path, 'write')
  mkdirSync(dirname(path), { recursive: true })
  // Revalidate the parent chain after mkdir: a concurrent swap could have
  // replaced a parent with a link between the first check and the write.
  revalidate(workspaceRoot, path, 'write')
  const tempPath = `${path}.${randomBytes(6).toString('hex')}.agento-tmp`
  try {
    writeFileSync(tempPath, data)
    renameSync(tempPath, path)
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // noop — cleanup is best-effort only
    }
    throw new WorkspaceFsRefusalError(
      `I could not write "${relative(workspaceRoot, path)}" — ${detailOf(
        workspaceRoot,
        error
      )}. Nothing was changed.`
    )
  }
  return data.length
}

export function createWorkspaceFs(workspaceRoot: string): WorkspaceFs {
  const facade: WorkspaceFs = {
    existsSync(path: string): boolean {
      assertInsideWorkspace(workspaceRoot, path)
      return existsSync(path)
    },
    readFileSync(path: string): string {
      revalidate(workspaceRoot, path, 'read')
      try {
        return readFileSync(path, 'utf8')
      } catch (error) {
        throw new WorkspaceFsReadError(
          `I could not read "${relative(workspaceRoot, path)}" — ${detailOf(workspaceRoot, error)}.`
        )
      }
    },
    readFileBytes(path: string): Buffer {
      revalidate(workspaceRoot, path, 'read')
      try {
        return readFileSync(path)
      } catch (error) {
        throw new WorkspaceFsReadError(
          `I could not read "${relative(workspaceRoot, path)}" — ${detailOf(workspaceRoot, error)}.`
        )
      }
    },
    writeFileAtomic(path: string, content: string): number {
      return writeBufferAtomic(workspaceRoot, path, Buffer.from(content, 'utf8'))
    },
    writeFileBytes(path: string, data: Buffer): number {
      return writeBufferAtomic(workspaceRoot, path, data)
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
      revalidate(workspaceRoot, path, 'write')
      try {
        mkdirSync(path, { recursive: true })
      } catch (error) {
        throw new WorkspaceFsRefusalError(
          `I could not create the folder "${relative(workspaceRoot, path)}" — ${detailOf(
            workspaceRoot,
            error
          )}. Nothing was changed.`
        )
      }
    },
    movePath(from: string, to: string): void {
      revalidate(workspaceRoot, from, 'write')
      revalidate(workspaceRoot, to, 'write')
      if (!existsSync(from)) {
        throw new WorkspaceFsRefusalError(
          `I couldn't find "${relative(workspaceRoot, from)}" — it may have been moved or renamed. Nothing was changed.`
        )
      }
      mkdirSync(dirname(to), { recursive: true })
      revalidate(workspaceRoot, from, 'write')
      revalidate(workspaceRoot, to, 'write')
      try {
        if (existsSync(to)) {
          if (statSync(to).isDirectory()) rmdirSync(to)
          else unlinkSync(to)
        }
        renameSync(from, to)
      } catch (error) {
        throw new WorkspaceFsRefusalError(
          `I could not move "${relative(workspaceRoot, from)}" — ${detailOf(
            workspaceRoot,
            error
          )}. Nothing was changed.`
        )
      }
    },
    copyPath(from: string, to: string): number {
      revalidate(workspaceRoot, from, 'read')
      revalidate(workspaceRoot, to, 'write')
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
          `I could not read "${relative(workspaceRoot, from)}" — ${detailOf(
            workspaceRoot,
            error
          )}. Nothing was changed.`
        )
      }
      mkdirSync(dirname(to), { recursive: true })
      revalidate(workspaceRoot, to, 'write')
      try {
        copyFileSync(from, to)
      } catch (error) {
        throw new WorkspaceFsRefusalError(
          `I could not copy "${relative(workspaceRoot, from)}" — ${detailOf(
            workspaceRoot,
            error
          )}. Nothing was changed.`
        )
      }
      return size
    },
    deletePath(path: string): void {
      revalidate(workspaceRoot, path, 'write')
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
          `I could not delete "${relative(workspaceRoot, path)}" — ${detailOf(
            workspaceRoot,
            error
          )}. Nothing was changed.`
        )
      }
    },
    readdir(path: string): { name: string; type: 'file' | 'directory' }[] {
      revalidate(workspaceRoot, path, 'read')
      let names: string[]
      try {
        names = nodeReaddirSync(path)
      } catch (error) {
        throw new WorkspaceFsReadError(
          `I couldn't list "${relative(workspaceRoot, path)}" — ${detailOf(workspaceRoot, error)}.`
        )
      }
      return names.map((name) => ({ name, type: tagEntryType(name, path) }))
    },
    walkFiles(root: string, limit: number): string[] {
      revalidate(workspaceRoot, root, 'read')
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
            const lst = lstatSync(child)
            if (lst.isSymbolicLink()) continue
            isDir = lst.isDirectory()
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
