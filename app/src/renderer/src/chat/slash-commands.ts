// Slash commands (docs/04 §3.5): typed `/` shortcuts for capabilities that
// already exist in the agent loop but had no composer entry point — undo via
// the checkpoint IPC, exact/meaning search via prompt templates that still
// travel the normal chat:send path (registry/sandbox/approval/snapshot all
// hold). Pure module (no DOM, no Electron, no node:path) so the menu
// component stays thin and the contract is unit-testable.

export type SlashCommandKind = 'local' | 'template'

export interface SlashCommandDef {
  /** Without the leading slash, lowercase (e.g. 'undo-all'). */
  name: string
  /** One plain-language line shown in the menu. */
  description: string
  /** Shown after the name when the command takes an argument ('' = none). */
  argHint: string
  /** Local commands run in the renderer; template commands expand to prose
   * and send through the normal transport. */
  kind: SlashCommandKind
  requiresArgs: boolean
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'search',
    description: 'Exact words in files.',
    argHint: '<text>',
    kind: 'template',
    requiresArgs: true
  },
  {
    name: 'semantic',
    description: 'Meaning-based: same idea, different wording.',
    argHint: '<topic>',
    kind: 'template',
    requiresArgs: true
  },
  {
    name: 'undo',
    description: 'Restore the last change (asks first).',
    argHint: '',
    kind: 'local',
    requiresArgs: false
  },
  {
    name: 'undo-all',
    description: 'Restore everything from this conversation (asks first).',
    argHint: '',
    kind: 'local',
    requiresArgs: false
  },
  {
    name: 'help',
    description: 'List these commands.',
    argHint: '',
    kind: 'local',
    requiresArgs: false
  }
]

export interface ParsedSlashCommand {
  /** The catalog entry, or null for an unknown `/name`. */
  def: SlashCommandDef | null
  /** Lowercased command name without the slash. */
  name: string
  /** Trimmed trailing text (may be ''). */
  args: string
}

const NAME_RE = /^\/([A-Za-z][A-Za-z-]*)?([\s\S]*)$/

/**
 * Parse a full composer text as a slash invocation. Returns null when the
 * text is not a slash command at all (doesn't start with `/` after leading
 * whitespace, or is a lone `/`). Unknown names still parse (def null) so the
 * caller can show "Try /help" instead of sending raw.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const leading = text.replace(/^\s+/, '')
  if (!leading.startsWith('/')) return null
  const match = NAME_RE.exec(leading)
  if (!match) return null
  const rawName = match[1] ?? ''
  if (rawName === '') return null
  const name = rawName.toLowerCase()
  const args = (match[2] ?? '').trim()
  const def = SLASH_COMMANDS.find((command) => command.name === name) ?? null
  return { def, name, args }
}

/**
 * Filter the catalog for the open menu. The query is the raw text after the
 * `/` (no spaces — once args start, the menu's job is done).
 */
export function filterSlashCommands(query: string): SlashCommandDef[] {
  const normalized = query.trim().toLowerCase().replace(/^\//, '')
  if (normalized === '') return [...SLASH_COMMANDS]
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(normalized))
}

/**
 * Should the autocomplete menu consider opening? The caret must sit inside a
 * leading `/token` with no spaces yet (typing args closes the menu — the send
 * path takes over from there). Returns the filter query, or null.
 */
export function slashMenuQuery(text: string, caret: number): string | null {
  const before = text.slice(0, Math.max(0, caret))
  const trimmed = before.replace(/^\s+/, '')
  if (!trimmed.startsWith('/')) return null
  const after = trimmed.slice(1)
  if (after.includes(' ') || after.includes('\t') || after.includes('\n')) return null
  if (!/^[A-Za-z-]*$/.test(after)) return null
  return after
}

/**
 * Expand a template command to the prose the model receives (the normal
 * chat:send path — no new IPC, no registry bypass).
 */
export function expandSlashTemplate(def: SlashCommandDef, args: string): string {
  const query = args.trim()
  if (def.name === 'search') return `Search for the exact text "${query}" in this folder.`
  if (def.name === 'semantic') return `Where did I write about "${query}"?`
  return query
}
