import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../types'

// P0 mutating tool (M2.6, docs/03 §5 inventory): anchor-based text edit.
// `old_text` must match the file exactly once — zero or multiple matches fail
// with a plain-language error asking the model to include more surrounding
// context — and that single occurrence is replaced. Whole-file rewrites go
// through write_file instead. Always risk 2 per the rule table (docs/06 §2).
const EDIT_CONTEXT_LINES = 3
const EDIT_EXCERPT_MAX_CHARS = 600

function capExcerpt(text: string): string {
  if (text.length > EDIT_EXCERPT_MAX_CHARS) return `${text.slice(0, EDIT_EXCERPT_MAX_CHARS)}…`
  return text
}

// The changed region with ±context lines (docs/03 §5 — the card shows the
// region, no diff library). Exported so the IPC layer's checkpoint backfill
// reuses the tool's own caps (same doctrine as write_file's excerptOf).
export function editExcerpts(
  content: string,
  oldText: string,
  newText: string
): { beforeExcerpt: string; afterExcerpt: string } {
  const idx = content.indexOf(oldText)
  const at = idx >= 0 ? idx : 0
  const lines = content.split(/\r?\n/)
  const startLine = content.slice(0, at).split(/\r?\n/).length - 1
  const oldLineCount = oldText.split(/\r?\n/).length
  const newLineCount = newText.split(/\r?\n/).length
  const next =
    idx >= 0 ? content.slice(0, idx) + newText + content.slice(idx + oldText.length) : content
  const nextLines = next.split(/\r?\n/)
  const from = Math.max(0, startLine - EDIT_CONTEXT_LINES)
  const beforeTo = Math.min(lines.length, startLine + oldLineCount + EDIT_CONTEXT_LINES)
  const afterTo = Math.min(nextLines.length, startLine + newLineCount + EDIT_CONTEXT_LINES)
  return {
    beforeExcerpt: capExcerpt(lines.slice(from, beforeTo).join('\n')),
    afterExcerpt: capExcerpt(nextLines.slice(from, afterTo).join('\n'))
  }
}

export const editFileTool: ToolDefinition<
  { path: string; old_text: string; new_text: string },
  { path: string; beforeExcerpt: string; afterExcerpt: string }
> = {
  name: 'edit_file',
  description:
    'Edit a section of a text file in the workspace: old_text must match the file exactly once and is replaced with new_text. Paths are relative to the workspace root.',
  access: 'write',
  inputSchema: z.object({
    path: z.string().min(1),
    old_text: z.string().min(1),
    new_text: z.string()
  }),
  pathFields: ['path'],
  risk: () => ({ level: 2, reason: 'Edits an existing file (reversible via snapshot)' }),
  describe: (input) => ({ title: `Edit ${basename(input.path)}`, group: 'files' }),
  execute: async (input, ctx) => {
    // Existence probe goes through the fs facade (NOT ctx.exists) so the
    // harness risk-stage log stays exact — same doctrine as write_file.
    if (!ctx.fs.existsSync(input.path)) {
      return {
        ok: false,
        output: { path: input.path, beforeExcerpt: '', afterExcerpt: '' },
        error: "I couldn't find that file — it may have been moved or renamed."
      }
    }
    const current = ctx.fs.readFileSync(input.path)
    const first = current.indexOf(input.old_text)
    if (first < 0) {
      return {
        ok: false,
        output: { path: input.path, beforeExcerpt: '', afterExcerpt: '' },
        error:
          'That text does not match the file exactly — include more surrounding context so I can find the right spot.'
      }
    }
    if (current.indexOf(input.old_text, first + input.old_text.length) >= 0) {
      return {
        ok: false,
        output: { path: input.path, beforeExcerpt: '', afterExcerpt: '' },
        error:
          'That text matches more than one place — include more surrounding context so it matches exactly once.'
      }
    }
    const { beforeExcerpt, afterExcerpt } = editExcerpts(current, input.old_text, input.new_text)
    ctx.fs.writeFileAtomic(
      input.path,
      current.slice(0, first) + input.new_text + current.slice(first + input.old_text.length)
    )
    return { ok: true, output: { path: input.path, beforeExcerpt, afterExcerpt } }
  }
}
