import { relative } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { wrapUntrusted } from '../untrusted'

// P0 read-only tool (docs/03 §5): case-insensitive substring search over text
// files in a directory. Returns up to N matches with a one-line preview each.
// The default recursion goes from `path`; pass a `glob` suffix to filter
// (e.g. "*.md"). Implemented as an in-tree walker — see the M2.4 Devlog for
// why @vscode/ripgrep is deferred (child-process spawn is unnecessary for v1
// and a ~60-line walker is honest about the trade-off).
const MAX_MATCHES = 200
const MAX_PREVIEW_CHARS = 120
const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB per file — keep search snappy
const MAX_WALKED_FILES = 5000

function matchesGlob(name: string, glob: string): boolean {
  // The only shape the model reasonably types: a literal extension like
  // "*.md" or "*.txt". We don't need full glob — extending it is a human
  // decision (docs/03 §5 stays a v1 minimal surface).
  if (!glob.startsWith('*.')) return true
  return name.toLowerCase().endsWith(glob.slice(1).toLowerCase())
}

function lineNumberOfIndex(content: string, index: number): number {
  // 0-based line index of the character at `index` — converts to 1-based for
  // the model in the call site.
  let line = 0
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1
  }
  return line
}

function previewLine(line: string): string {
  if (line.length <= MAX_PREVIEW_CHARS) return line
  return `${line.slice(0, MAX_PREVIEW_CHARS)}…`
}

export const searchFilesTool: ToolDefinition<
  { path: string; query: string; glob?: string; maxResults?: number },
  { query: string; matches: { path: string; line: number; preview: string }[]; truncated: boolean }
> = {
  name: 'search_files',
  description:
    'Search for a literal substring in text files under a folder (path relative to the workspace root — pass "." to search everything). Case-insensitive. Optional glob (e.g. \'*.md\').',
  access: 'read',
  inputSchema: z.object({
    path: z.string().min(1),
    query: z.string().min(1),
    glob: z.string().min(1).optional(),
    // No `.max()` cap on purpose (M3.7 gate finding): the provider validates
    // the model's arguments against this schema BEFORE our wrapper sees them,
    // and a breach kills the whole turn provider-side. Over-large values are
    // clamped in `execute` instead (`Math.min(maxResults, MAX_MATCHES)`).
    maxResults: z.number().int().min(1).optional()
  }),
  pathFields: ['path'],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: (input) => ({
    title: `Search for "${input.query.length > 32 ? `${input.query.slice(0, 32)}…` : input.query}"`,
    group: 'files'
  }),
  execute: async (input, ctx) => {
    const maxResults = input.maxResults ?? 50
    const limit = Math.min(maxResults, MAX_MATCHES)
    const lowered = input.query.toLowerCase()
    const filePaths = ctx.fs.walkFiles(input.path, MAX_WALKED_FILES)
    const matches: { path: string; line: number; preview: string }[] = []
    let truncated = false
    outer: for (const filePath of filePaths) {
      const base = filePath.split(/[\\/]/).pop() ?? filePath
      if (input.glob && !matchesGlob(base, input.glob)) continue
      let content: string
      try {
        // Read through the fs facade for the workspace backstop; large files
        // are skipped rather than partially scanned (a partial scan is worse
        // than an honest "too big to search" miss).
        content = ctx.fs.readFileSync(filePath)
      } catch {
        continue
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) continue
      const loweredContent = content.toLowerCase()
      let from = 0
      while (true) {
        const idx = loweredContent.indexOf(lowered, from)
        if (idx === -1) break
        const line = lineNumberOfIndex(content, idx) + 1
        // Preview is the line containing the match.
        const lineStart = content.lastIndexOf('\n', idx - 1) + 1
        const lineEnd = content.indexOf('\n', idx)
        const rawLine = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd)
        matches.push({
          path: relative(ctx.workspaceRoot, filePath) || filePath,
          line,
          preview: wrapUntrusted('file excerpt', previewLine(rawLine.trim()))
        })
        if (matches.length > limit) {
          truncated = true
          break outer
        }
        from = idx + input.query.length
      }
    }
    // M3.3 projection feed (docs/03 §5): match count, same doctrine as
    // list_dir's file count — last enumeration wins at the approval hook.
    ctx.noteEnumeration?.(matches.length, input.path)
    return { ok: true, output: { query: input.query, matches, truncated } }
  }
}
