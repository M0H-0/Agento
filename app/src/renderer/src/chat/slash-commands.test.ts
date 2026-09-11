import { describe, expect, it } from 'vitest'
import {
  expandSlashTemplate,
  filterSlashCommands,
  parseSlashCommand,
  SLASH_COMMANDS,
  slashMenuQuery
} from './slash-commands'

// Slash command contract (docs/04 §3.5): the composer menu + send
// interception in components/SlashMenu.tsx both ride these pure helpers, so
// the matrix below is the behavior proof (node env — no DOM needed).
describe('parseSlashCommand', () => {
  it('returns null for plain prose', () => {
    expect(parseSlashCommand('organize my folder')).toBeNull()
    expect(parseSlashCommand('')).toBeNull()
    expect(parseSlashCommand('   ')).toBeNull()
  })

  it('returns null for a lone slash (menu trigger, not a command)', () => {
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand('/ ')).toBeNull()
  })

  it('parses known commands case-insensitively with trimmed args', () => {
    expect(parseSlashCommand('/search invoice')).toEqual({
      def: SLASH_COMMANDS[0],
      name: 'search',
      args: 'invoice'
    })
    expect(parseSlashCommand('/SEMANTIC  pricing  ')).toMatchObject({
      name: 'semantic',
      args: 'pricing'
    })
    expect(parseSlashCommand('/Undo-All')).toMatchObject({ name: 'undo-all', args: '' })
    expect(parseSlashCommand('/help')).toMatchObject({ name: 'help', args: '' })
  })

  it('tolerates leading whitespace before the slash', () => {
    expect(parseSlashCommand('  /undo')).toMatchObject({ name: 'undo', args: '' })
  })

  it('keeps unknown names parseable with a null def (caller hints /help)', () => {
    expect(parseSlashCommand('/frobnicate x')).toEqual({ def: null, name: 'frobnicate', args: 'x' })
  })

  it('does not treat mid-message slashes as commands', () => {
    expect(parseSlashCommand('please /undo this')).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  it('returns the full catalog on an empty query', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length)
    expect(filterSlashCommands('/')).toHaveLength(SLASH_COMMANDS.length)
  })

  it('prefix-filters case-insensitively', () => {
    expect(
      filterSlashCommands('se')
        .map((c) => c.name)
        .sort()
    ).toEqual(['search', 'semantic'])
    expect(
      filterSlashCommands('UNDO')
        .map((c) => c.name)
        .sort()
    ).toEqual(['undo', 'undo-all'])
    expect(filterSlashCommands('xyz')).toEqual([])
  })
})

describe('slashMenuQuery', () => {
  it('opens on a leading /token with the caret inside it', () => {
    expect(slashMenuQuery('/se', 3)).toBe('se')
    expect(slashMenuQuery('/', 1)).toBe('')
    expect(slashMenuQuery('/undo-all', 9)).toBe('undo-all')
  })

  it('stays closed for prose, mid-message slashes, and once args start', () => {
    expect(slashMenuQuery('organize this', 5)).toBeNull()
    expect(slashMenuQuery('a /search x', 10)).toBeNull()
    expect(slashMenuQuery('/search invo', 12)).toBeNull()
    expect(slashMenuQuery('/search', 3)).toBe('se')
  })
})

describe('expandSlashTemplate', () => {
  it('expands search to exact-text prose and semantic to meaning prose', () => {
    const search = SLASH_COMMANDS.find((c) => c.name === 'search')
    const semantic = SLASH_COMMANDS.find((c) => c.name === 'semantic')
    expect(expandSlashTemplate(search!, 'invoice 42')).toBe(
      'Search for the exact text "invoice 42" in this folder.'
    )
    expect(expandSlashTemplate(semantic!, 'pricing')).toBe('Where did I write about "pricing"?')
  })
})
