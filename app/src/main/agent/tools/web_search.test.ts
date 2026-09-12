import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webSearchTool, parseSearchResults, parseTavilyResults } from './web_search'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

const DDG_PAGE = [
  '<html><body>',
  '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpricing&amp;rut=abc">Acme <b>Pricing</b></a>',
  '<a class="result__snippet" href="https://example.com/pricing">Pro is 10 monthly, billed yearly.</a>',
  '<a rel="nofollow" class="result__a" href="https://example.org/docs">Plain Link Docs</a>',
  '<td class="result-snippet">Docs for <b>everything</b> live here.</td>',
  '</body></html>'
].join('')

describe('web_search — read-only', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(webSearchTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('returns unwrapped results with framed snippets', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'acme pricing' },
      ctx: {
        ...harness.ctx,
        web: {
          fetch: async (url: string) => {
            expect(url).toContain('html.duckduckgo.com/html/?q=acme%20pricing')
            return { status: 200, contentType: 'text/html; charset=utf-8', body: DDG_PAGE }
          }
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      query: string
      results: { title: string; url: string; snippet: string }[]
      truncated: boolean
    }
    expect(result.query).toBe('acme pricing')
    expect(result.results).toHaveLength(2)
    expect(result.results[0].url).toBe('https://example.com/pricing')
    expect(result.results[0].title).toBe('Acme Pricing')
    expect(result.results[0].snippet).toContain('BEGIN UNTRUSTED CONTENT')
    expect(result.results[0].snippet).toContain('Pro is 10 monthly')
    expect(result.results[1].url).toBe('https://example.org/docs')
    expect(result.truncated).toBe(false)
  })

  it('names duckduckgo as the answering engine on the keyless path', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'acme pricing' },
      ctx: {
        ...harness.ctx,
        web: {
          fetch: async () => ({ status: 200, contentType: 'text/html', body: DDG_PAGE })
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { provider: string }
    expect(result.provider).toBe('duckduckgo')
  })

  it('honors count and marks truncation honestly', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'acme', count: 1 },
      ctx: {
        ...harness.ctx,
        web: {
          fetch: async () => ({
            status: 200,
            contentType: 'text/html',
            body: DDG_PAGE
          })
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { results: unknown[]; truncated: boolean }
    expect(result.results).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('answers honestly when no web capability is injected', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'acme' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('not available')
  })

  it('surfaces non-200 answers and network failures plainly', async () => {
    const badStatus = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'acme' },
      ctx: {
        ...harness.ctx,
        web: { fetch: async () => ({ status: 500, contentType: 'text/html', body: 'oops' }) }
      }
    })
    expect(badStatus.ok).toBe(false)
    expect(badStatus.message).toContain('500')

    const network = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'acme' },
      ctx: {
        ...harness.ctx,
        web: {
          fetch: async () => {
            throw new Error('getaddrinfo ENOTFOUND html.duckduckgo.com')
          }
        }
      }
    })
    expect(network.ok).toBe(false)
    expect(network.message).toContain('could not run')
  })

  it('returns an empty list (not an error) when nothing matches', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'zzz-no-such-thing' },
      ctx: {
        ...harness.ctx,
        web: {
          fetch: async () => ({ status: 200, contentType: 'text/html', body: '<html></html>' })
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { results: unknown[] }
    expect(result.results).toEqual([])
  })
})

describe('parseSearchResults — unit', () => {
  it('skips entries whose address will not unwrap', () => {
    const results = parseSearchResults(
      '<a class="result__a" href="/l/?kh=no-uddg">No target</a>' +
        '<a class="result__snippet" href="/l/">snippet</a>'
    )
    expect(results).toEqual([])
  })
})

describe('web_search — Tavily primary + keyless fallback', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(webSearchTool)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    ws.cleanup()
    vi.restoreAllMocks()
  })

  const tavilyHits = [
    { title: 'Acme Pricing', url: 'https://example.com/pricing', snippet: 'Pro is 10 monthly.' },
    { title: 'Acme Docs', url: 'https://example.com/docs', snippet: '' }
  ]

  it('answers from Tavily without touching the keyless path', async () => {
    const keyless = vi.fn(async () => ({
      status: 200,
      contentType: 'text/html',
      body: DDG_PAGE
    }))
    const primary = vi.fn(async (query: string, maxResults: number) => {
      expect(query).toBe('acme pricing')
      expect(maxResults).toBe(5)
      return tavilyHits
    })
    const outcome = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'acme pricing' },
      ctx: { ...harness.ctx, web: { fetch: keyless, tavily: { search: primary } } }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as {
      query: string
      results: { title: string; url: string; snippet: string }[]
      truncated: boolean
      provider: string
    }
    expect(result.provider).toBe('tavily')
    expect(result.results).toHaveLength(2)
    expect(result.results[0].url).toBe('https://example.com/pricing')
    expect(result.results[0].snippet).toContain('BEGIN UNTRUSTED CONTENT')
    expect(result.truncated).toBe(false)
    expect(primary).toHaveBeenCalledTimes(1)
    expect(keyless).not.toHaveBeenCalled()
  })

  it('falls back to keyless results when Tavily throws (bad key, no credits, network)', async () => {
    for (const reason of [
      'The Tavily key was refused — check it in Settings → Web search.',
      'Tavily is out of credits or rate-limiting this key.',
      'The Tavily search could not run — check your connection.'
    ]) {
      const outcome = await harness.registry.run({
        tool: 'web_search',
        args: { query: 'acme pricing' },
        ctx: {
          ...harness.ctx,
          web: {
            fetch: async () => ({ status: 200, contentType: 'text/html', body: DDG_PAGE }),
            tavily: {
              search: async () => {
                throw new Error(reason)
              }
            }
          }
        }
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok || !outcome.result) throw new Error('expected result')
      const result = outcome.result as {
        results: { url: string }[]
        provider: string
      }
      expect(result.provider).toBe('duckduckgo')
      expect(result.results).toHaveLength(2)
      expect(result.results[0].url).toBe('https://example.com/pricing')
    }
  })

  it('treats an empty Tavily answer as honest (no fallback, no error)', async () => {
    const keyless = vi.fn(async () => ({
      status: 200,
      contentType: 'text/html',
      body: DDG_PAGE
    }))
    const outcome = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'zzz-no-such-thing' },
      ctx: {
        ...harness.ctx,
        web: { fetch: keyless, tavily: { search: async () => [] } }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { results: unknown[]; provider: string }
    expect(result.results).toEqual([])
    expect(result.provider).toBe('tavily')
    expect(keyless).not.toHaveBeenCalled()
  })

  it('still fails honestly when the fallback fails too', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_search',
      args: { query: 'acme' },
      ctx: {
        ...harness.ctx,
        web: {
          fetch: async () => ({ status: 500, contentType: 'text/html', body: 'oops' }),
          tavily: {
            search: async () => {
              throw new Error('Tavily is out of credits or rate-limiting this key.')
            }
          }
        }
      }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('500')
  })
})

describe('parseTavilyResults — unit', () => {
  it('maps the Tavily envelope to title/url/snippet hits', () => {
    const hits = parseTavilyResults({
      query: 'acme',
      results: [
        {
          title: 'Acme Pricing',
          url: 'https://example.com/pricing',
          content: 'Pro is 10 monthly.',
          score: 0.98
        },
        { title: 'Acme Docs', url: 'https://example.com/docs', content: '', score: 0.9 }
      ]
    })
    expect(hits).toEqual([
      { title: 'Acme Pricing', url: 'https://example.com/pricing', snippet: 'Pro is 10 monthly.' },
      { title: 'Acme Docs', url: 'https://example.com/docs', snippet: '' }
    ])
  })

  it('skips entries without a usable title or http(s) address', () => {
    const hits = parseTavilyResults({
      results: [
        { title: '', url: 'https://example.com/empty-title', content: 'x' },
        { title: 'No URL', url: '', content: 'x' },
        { title: 'FTP', url: 'ftp://example.com/file', content: 'x' },
        { title: 'Good', url: 'https://example.com/good', content: 'kept' }
      ]
    })
    expect(hits).toEqual([{ title: 'Good', url: 'https://example.com/good', snippet: 'kept' }])
  })

  it('caps hits and snippet length like the keyless path', () => {
    const results = Array.from({ length: 20 }, (_, i) => ({
      title: `Hit ${i}`,
      url: `https://example.com/${i}`,
      content: 'x'.repeat(1000)
    }))
    const hits = parseTavilyResults({ results })
    expect(hits).toHaveLength(8)
    expect(hits[0].snippet).toHaveLength(300)
  })

  it('throws plainly on a malformed envelope', () => {
    for (const bad of [null, 'nope', {}, { results: 'nope' }, { results: null }]) {
      expect(() => parseTavilyResults(bad)).toThrow('shape I cannot read')
    }
  })
})
