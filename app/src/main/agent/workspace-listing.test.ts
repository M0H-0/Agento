import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signalsFromFiles, suggestPrompts, toRelativeEntries } from './workspace-listing'

const ROOT = join('C:', 'ws')

function abs(...segments: string[]): string {
  return join(ROOT, ...segments)
}

describe('toRelativeEntries', () => {
  it('maps to forward-slash relative paths and filters case-insensitively', () => {
    const { files, truncated } = toRelativeEntries(
      [abs('report.PDF'), abs('notes', 'todo.md'), abs('img.png')],
      ROOT,
      'pdf',
      500
    )
    expect(truncated).toBe(false)
    expect(files).toEqual([{ relativePath: 'report.PDF', isDir: false }])
  })

  it('drops escaping paths and caps at the limit', () => {
    const paths = [abs('a.txt'), abs('b.txt'), abs('c.txt'), join('C:', 'other', 'x.txt')]
    const { files, truncated } = toRelativeEntries(paths, ROOT, '', 2)
    expect(files.map((f) => f.relativePath)).toEqual(['a.txt', 'b.txt'])
    expect(truncated).toBe(true)
  })
})

describe('suggestPrompts', () => {
  it('suggests PDF + organize + pricing when all evidence exists', () => {
    const signals = signalsFromFiles(
      [
        { relativePath: 'a.pdf', isDir: false },
        { relativePath: 'b.pdf', isDir: false },
        { relativePath: 'c.md', isDir: false },
        { relativePath: 'd.csv', isDir: false },
        { relativePath: 'pricing-notes.txt', isDir: false }
      ],
      false
    )
    expect(suggestPrompts(signals)).toEqual([
      'Make a one-page summary of every PDF in this folder',
      'Organize this folder by file type',
      'Where did I write about pricing?'
    ])
  })

  it('drops the pricing prompt without filename or title evidence', () => {
    const signals = signalsFromFiles(
      [
        { relativePath: 'a.pdf', isDir: false },
        { relativePath: 'b.md', isDir: false },
        { relativePath: 'c.csv', isDir: false }
      ],
      false
    )
    const prompts = suggestPrompts(signals)
    expect(prompts).not.toContain('Where did I write about pricing?')
    expect(prompts.length).toBeGreaterThan(0)
  })

  it('uses title evidence for pricing and singular PDF copy', () => {
    const withTitle = signalsFromFiles([{ relativePath: 'notes.txt', isDir: false }], true)
    expect(suggestPrompts(withTitle)).toEqual(['Where did I write about pricing?'])
    const singlePdf = signalsFromFiles([{ relativePath: 'doc.pdf', isDir: false }], false)
    expect(suggestPrompts(singlePdf)).toEqual(['Make a one-page summary of the PDF in this folder'])
  })

  it('falls back to generic prompts for an empty folder', () => {
    expect(suggestPrompts(signalsFromFiles([], false))).toEqual([
      'List the files in this folder',
      'What can you help me do here?'
    ])
  })
})
