import { describe, expect, it } from 'vitest'
import { genericPrompts, suggestPromptsFromScan } from './suggestions'

// Renderer mirror of the main suggestPrompts contract
// (src/main/agent/workspace-listing.ts): empty folders get onboarding
// questions, non-empty folders without evidence get the generic fallbacks.
describe('suggestPromptsFromScan', () => {
  it('asks onboarding questions for an empty folder', () => {
    expect(suggestPromptsFromScan([], [])).toEqual([
      'What can you help me do here?',
      'How do I add files to this folder?'
    ])
  })

  it('falls back to generic prompts when files exist but no signal fires', () => {
    expect(suggestPromptsFromScan([{ relativePath: 'notes.txt' }], [])).toEqual(genericPrompts())
    expect(genericPrompts()).toEqual([
      'List the files in this folder',
      'What can you help me do here?'
    ])
  })

  it('suggests a PDF summary when a PDF is present', () => {
    expect(suggestPromptsFromScan([{ relativePath: 'doc.pdf' }], [])).toEqual([
      'Make a one-page summary of the PDF in this folder'
    ])
  })

  it('uses title evidence for the pricing prompt', () => {
    expect(suggestPromptsFromScan([{ relativePath: 'notes.txt' }], ['Q3 Pricing'])).toEqual([
      'Where did I write about pricing?'
    ])
  })
})
