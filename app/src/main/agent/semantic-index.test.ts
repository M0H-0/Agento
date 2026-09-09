import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { cachePathForWorkspace, chunkText, semanticSearch } from './semantic-index'
import { createWorkspaceFs } from './workspace-fs'

// Deterministic fake embedder: one dim per vocab word, 1 when the word
// appears — topic ranking is assertable without a real model.
function makeFakeEmbedder(vocab: string[]): {
  embedTexts(texts: string[]): Promise<number[][]>
  embeddedTexts: string[]
} {
  const embeddedTexts: string[] = []
  const embedTexts = async (texts: string[]): Promise<number[][]> => {
    embeddedTexts.push(...texts)
    return texts.map((text) => {
      const lowered = text.toLowerCase()
      return vocab.map((word) => (lowered.includes(word) ? 1 : 0))
    })
  }
  return { embedTexts, embeddedTexts }
}

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agento-semantic-'))
}

describe('semanticSearch — indexer + ranking', () => {
  let root: string
  let cacheRoot: string

  beforeEach(() => {
    root = makeTempRoot()
    // The cache lives OUTSIDE the workspace (mirroring userData in prod) —
    // inside it, the walker would index the cache file itself.
    cacheRoot = makeTempRoot()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(cacheRoot, { recursive: true, force: true })
  })

  function makeDeps(vocab: string[]): {
    deps: import('./semantic-index').SemanticIndexDeps
    embeddedTexts: string[]
  } {
    const fake = makeFakeEmbedder(vocab)
    return {
      deps: {
        fs: createWorkspaceFs(root),
        embedTexts: fake.embedTexts,
        cachePath: join(cacheRoot, 'cache.json')
      },
      embeddedTexts: fake.embeddedTexts
    }
  }

  it('indexes text files, ranks by topic, and returns workspace-relative snippets', async () => {
    const { deps } = makeDeps(['pricing', 'recipe'])
    const fs = createWorkspaceFs(root)
    fs.writeFileAtomic(
      join(root, 'pricing.md'),
      'Our pricing plans and invoice schedules live here.'
    )
    fs.writeFileAtomic(join(root, 'cooking.txt'), 'A recipe for sourdough bread and starters.')

    const results = await semanticSearch(deps, root, 'where are my pricing notes?')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].path).toBe('pricing.md')
    expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score)
    expect(results[0].snippet).toContain('pricing')
  })

  it('re-embeds only changed files on a second search', async () => {
    const { deps, embeddedTexts } = makeDeps(['pricing'])
    const fs = createWorkspaceFs(root)
    fs.writeFileAtomic(join(root, 'pricing.md'), 'All the pricing details.')

    await semanticSearch(deps, root, 'pricing')
    const afterFirst = embeddedTexts.length
    expect(afterFirst).toBeGreaterThan(1) // file chunks + query

    await semanticSearch(deps, root, 'pricing again')
    // Only the new query — the unchanged file's chunks came from cache.
    expect(embeddedTexts.length).toBe(afterFirst + 1)
    expect(embeddedTexts[embeddedTexts.length - 1]).toBe('pricing again')

    // A content change re-embeds that file.
    fs.writeFileAtomic(join(root, 'pricing.md'), 'Updated pricing with new tiers.')
    await semanticSearch(deps, root, 'pricing')
    expect(embeddedTexts.length).toBeGreaterThan(afterFirst + 1)
  })

  it('skips binary documents without an extractor and uses it when provided', async () => {
    const { deps, embeddedTexts } = makeDeps(['pricing'])
    const fs = createWorkspaceFs(root)
    fs.writeFileAtomic(join(root, 'report.pdf'), '%PDF-fake')

    const without = await semanticSearch(deps, root, 'pricing')
    expect(without).toEqual([])

    const withExtractor = {
      ...deps,
      extractDocument: async () => ({
        text: 'The report discusses pricing at length.',
        truncated: false
      })
    }
    const results = await semanticSearch(withExtractor, root, 'pricing')
    expect(results.length).toBe(1)
    expect(results[0].path).toBe('report.pdf')
    expect(embeddedTexts.length).toBeGreaterThan(1)
  })

  it('survives a corrupt cache file', async () => {
    const { deps } = makeDeps(['pricing'])
    const fs = createWorkspaceFs(root)
    writeFileSync(deps.cachePath, '{not json at all', 'utf8')
    fs.writeFileAtomic(join(root, 'pricing.md'), 'Pricing overview.')

    const results = await semanticSearch(deps, root, 'pricing')
    expect(results.length).toBe(1)
  })

  it('drops entries for files that no longer exist', async () => {
    const { deps } = makeDeps(['pricing'])
    const fs = createWorkspaceFs(root)
    fs.writeFileAtomic(join(root, 'pricing.md'), 'Pricing details here.')
    await semanticSearch(deps, root, 'pricing')

    fs.deletePath(join(root, 'pricing.md'))
    const results = await semanticSearch(deps, root, 'pricing')
    expect(results).toEqual([])
  })

  it('clamps topK to a sane range', async () => {
    const { deps } = makeDeps(['pricing', 'recipe'])
    const fs = createWorkspaceFs(root)
    fs.writeFileAtomic(join(root, 'a.md'), 'pricing pricing pricing')
    fs.writeFileAtomic(join(root, 'b.md'), 'recipe recipe recipe')

    const results = await semanticSearch(deps, root, 'pricing', 99)
    expect(results.length).toBe(2)
  })
})

describe('chunkText — windows', () => {
  it('returns one chunk for short text and windows long text near the cap', () => {
    expect(chunkText('short')).toEqual(['short'])
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkText(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1_800)
    // No content lost: reassembly covers every word.
    expect(chunks.join(' ')).toContain('word0')
    expect(chunks.join(' ')).toContain('word299')
  })

  it('caps the number of chunks per file', () => {
    const huge = Array.from({ length: 100_000 }, (_, i) => `w${i}`).join(' ')
    expect(chunkText(huge).length).toBeLessThanOrEqual(40)
  })
})

describe('cachePathForWorkspace — userData keying', () => {
  it('keys the cache file by workspace root and lands in the given dir', () => {
    const a = cachePathForWorkspace('/userData', 'C:/ws/one')
    const b = cachePathForWorkspace('/userData', 'C:/ws/two')
    const again = cachePathForWorkspace('/userData', 'C:/ws/one')
    expect(a).not.toBe(b)
    expect(a).toBe(again)
    expect(a.startsWith(join('/userData', 'semantic-index'))).toBe(true)
    expect(a.endsWith('.json')).toBe(true)
  })
})
