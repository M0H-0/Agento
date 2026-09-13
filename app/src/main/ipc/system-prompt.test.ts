import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './system-prompt'

// The workspace-aware system prompt: with a workspace the model must know
// which folder it is in (and NOT ask for one); without one it must ask.
describe('buildSystemPrompt', () => {
  it('names the workspace and drops the ask-for-one clause when set', () => {
    const root = 'D:\\Random\\folder'
    const prompt = buildSystemPrompt(root)
    expect(prompt).toContain(root)
    expect(prompt).toContain('WORKSPACE')
    expect(prompt).toContain('pass . for the workspace root')
    expect(prompt).not.toContain('If no workspace is set, ask the user to pick one')
  })

  it('keeps the ask-for-one instruction when no workspace is set', () => {
    const prompt = buildSystemPrompt(null)
    expect(prompt).toContain('If no workspace is set, ask the user to pick one')
    expect(prompt).not.toContain('WORKSPACE')
  })

  it('treats empty-string roots as no workspace', () => {
    // chat.ts passes `workspaceRoot || null`, so '' must behave like null.
    expect(buildSystemPrompt('' as unknown as null)).toContain(
      'If no workspace is set, ask the user to pick one'
    )
  })

  it('keeps the ask_user task-only guard in both workspace variants', () => {
    // The "hey" incident: the model fired ask_user for a greeting. The guard
    // is deliberately present whether or not a workspace is set.
    const guard = 'Greetings and casual conversation get a normal text reply'
    expect(buildSystemPrompt('D:\\Random\\folder')).toContain(guard)
    expect(buildSystemPrompt(null)).toContain(guard)
  })

  it('bans emojis in replies in both workspace variants', () => {
    const ban = 'Never use emojis in a reply'
    expect(buildSystemPrompt('D:\\Random\\folder')).toContain(ban)
    expect(buildSystemPrompt(null)).toContain(ban)
  })

  it('tells the model to invent sample content instead of asking', () => {
    const clause = 'invent short suitable content yourself'
    expect(buildSystemPrompt('D:\\Random\\folder')).toContain(clause)
    expect(buildSystemPrompt(null)).toContain(clause)
  })

  it('forbids mentioning internal tokens or headers', () => {
    const rule = 'Never mention internal tokens, headers'
    expect(buildSystemPrompt('D:\\Random\\folder')).toContain(rule)
    expect(buildSystemPrompt(null)).toContain(rule)
  })
})
