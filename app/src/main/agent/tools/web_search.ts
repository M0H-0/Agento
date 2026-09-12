import { z } from 'zod'
import type { TavilySearchHit, ToolDefinition } from '../types'
import { containsAssistantAddressedText, wrapUntrusted } from '../untrusted'

// Web search with a primary/fallback ladder: keyed Tavily first (injected as
// ctx.web.tavily by the IPC layer only when a Tavily key is stored in
// Settings), keyless DuckDuckGo HTML over the injected ctx.web capability
// otherwise — or when Tavily fails for any reason (bad key, no credits,
// rate limit, network). No new dep, no sidecar. Returns ranked titles +
// addresses + snippets; the model opens a result with web_fetch for the full
// page. Snippets are untrusted-framed like every other network blob
// (docs/06 §6). The output names the engine that answered (`provider`) so
// the card can say so honestly.

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/?q='
const MAX_RESULTS = 8
const MAX_SNIPPET_CHARS = 300

export type WebSearchProvider = 'tavily' | 'duckduckgo'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
}

function stripTags(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

// Result links are either the target directly or a same-site redirect
// carrying the target in the `uddg` query param — unwrap to the real address.
function unwrapResultHref(rawHref: string): string | null {
  let candidate = rawHref.trim().replace(/&amp;/gi, '&')
  if (!candidate) return null
  if (candidate.startsWith('//')) candidate = `https:${candidate}`
  const uddg = candidate.match(/[?&]uddg=([^&]+)/)
  if (uddg?.[1]) {
    try {
      candidate = decodeURIComponent(uddg[1])
    } catch {
      return null
    }
  } else if (candidate.startsWith('/')) {
    return null
  }
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) return candidate
  return null
}

// Dependency-free parse of the results page: titles ride `result__a`
// anchors, snippets ride `result__snippet` blocks in the same order —
// zip them positionally, skipping entries whose address won't unwrap.
export function parseSearchResults(html: string): WebSearchResult[] {
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi
  const links: { url: string; title: string }[] = []
  for (let match = linkRe.exec(html); match !== null; match = linkRe.exec(html)) {
    const url = unwrapResultHref(match[1])
    if (!url) continue
    const title = stripTags(match[2])
    if (!title) continue
    links.push({ url, title })
  }
  const snippets: string[] = []
  for (let match = snippetRe.exec(html); match !== null; match = snippetRe.exec(html)) {
    snippets.push(stripTags(match[1]))
  }
  return links.slice(0, MAX_RESULTS).map((link, index) => ({
    ...link,
    snippet: (snippets[index] ?? '').slice(0, MAX_SNIPPET_CHARS)
  }))
}

// Tavily `/search` answers `{ results: [{ title, url, content, score }] }`.
// Pure mapper (chat.ts owns the HTTP): validates the envelope, drops entries
// without a usable http(s) address or title, and caps snippet length to the
// same budget the keyless path uses. Throws a plain-language Error on a
// malformed envelope — the tool treats that as a Tavily failure and falls
// back to the keyless path.
export function parseTavilyResults(data: unknown): TavilySearchHit[] {
  if (typeof data !== 'object' || data === null) {
    throw new Error('The search answered in a shape I cannot read.')
  }
  const results = (data as { results?: unknown }).results
  if (!Array.isArray(results)) {
    throw new Error('The search answered in a shape I cannot read.')
  }
  const hits: TavilySearchHit[] = []
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.title !== 'string' || typeof record.url !== 'string') continue
    const title = record.title.trim()
    const url = record.url.trim()
    if (!title || !(url.startsWith('http://') || url.startsWith('https://'))) continue
    const snippet =
      typeof record.content === 'string' ? record.content.slice(0, MAX_SNIPPET_CHARS) : ''
    hits.push({ title, url, snippet })
    if (hits.length >= MAX_RESULTS) break
  }
  return hits
}

function failure(
  query: string,
  error: string,
  provider: WebSearchProvider
): {
  ok: false
  output: {
    query: string
    results: WebSearchResult[]
    truncated: boolean
    provider: WebSearchProvider
  }
  error: string
} {
  return {
    ok: false,
    output: {
      query,
      results: [],
      truncated: false,
      provider
    },
    error
  }
}

function success(
  query: string,
  hits: { title: string; url: string; snippet: string }[],
  limit: number,
  parsedTotal: number,
  provider: WebSearchProvider
): {
  ok: true
  output: {
    query: string
    results: WebSearchResult[]
    truncated: boolean
    provider: WebSearchProvider
    suspicious?: boolean
  }
} {
  const results = hits.slice(0, limit).map((result) => ({
    ...result,
    snippet: result.snippet
      ? wrapUntrusted(`search result ${result.url}`, result.snippet)
      : result.snippet
  }))
  return {
    ok: true,
    output: {
      query,
      results,
      truncated: parsedTotal > results.length,
      provider,
      ...(results.some((result) => containsAssistantAddressedText(result.snippet))
        ? { suspicious: true as const }
        : {})
    }
  }
}

export const webSearchTool: ToolDefinition<
  { query: string; count?: number },
  {
    query: string
    results: WebSearchResult[]
    truncated: boolean
    provider: WebSearchProvider
    suspicious?: boolean
  }
> = {
  name: 'web_search',
  description:
    'Search the web for current or external facts. Uses Tavily when a key is saved in Settings, otherwise keyless results. Returns titles, addresses, and snippets — open the most promising result with web_fetch to read the full page.',
  access: 'read',
  inputSchema: z.object({
    query: z.string().min(1),
    count: z.number().int().min(1).max(MAX_RESULTS).optional()
  }),
  pathFields: [],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: (input) => ({ title: `Search the web for ${input.query}`, group: 'web' }),
  execute: async (input, ctx) => {
    if (!ctx.web) {
      return failure(input.query, 'Searching the web is not available right now.', 'duckduckgo')
    }
    const limit = input.count ?? 5
    // Primary: keyed Tavily. Any failure (bad key, no credits, rate limit,
    // network, malformed envelope) falls through to the keyless path below —
    // the user still gets an answer. An empty Tavily result is NOT a failure:
    // it returns honestly as an empty list.
    if (ctx.web.tavily) {
      try {
        const hits = await ctx.web.tavily.search(input.query, limit)
        return success(input.query, hits, limit, hits.length, 'tavily')
      } catch (error) {
        // Diagnosability without key material: capability errors carry only
        // statuses and fixed copy, never the key. The user sees which engine
        // answered via the output's `provider`.
        console.error(
          '[web_search] Tavily failed, falling back to keyless:',
          error instanceof Error ? error.message : error
        )
      }
    }
    try {
      const response = await ctx.web.fetch(`${SEARCH_ENDPOINT}${encodeURIComponent(input.query)}`)
      if (response.status !== 200) {
        return failure(
          input.query,
          `The search answered with status ${response.status} — try again in a moment.`,
          'duckduckgo'
        )
      }
      const parsed = parseSearchResults(response.body)
      return success(input.query, parsed, limit, parsed.length, 'duckduckgo')
    } catch (error) {
      return failure(
        input.query,
        error instanceof Error
          ? `That search could not run — ${error.message}.`
          : 'That search could not run.',
        'duckduckgo'
      )
    }
  }
}
