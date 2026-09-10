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
})
