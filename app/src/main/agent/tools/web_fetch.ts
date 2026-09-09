import { z } from 'zod'
import type { ToolDefinition } from '../types'

// MVP tool (MVP_PLAN.md): fetch a web page over plain HTTP GET and return
// readable text. No search engine, no JS rendering. The network call itself
// is the injected ctx.web capability (Node global fetch in the IPC layer);
// the HTML→text cleanup is a crude dependency-free strip — the MVP plan's
// documented cut-inside-the-step fallback.

// Below the wrapper's 8 KB output cap so the honest `truncated` marker ships.
const MAX_TEXT_CHARS = 6_000

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
}

export function htmlToText(html: string): { title?: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{2,}/g, '\n\n')
  ).trim()
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : undefined
  return { title: title || undefined, text }
}

function failure(
  output: { url: string },
  error: string
): {
  ok: false
  output: { url: string; title: undefined; text: string; truncated: boolean }
  error: string
} {
  return {
    ok: false,
    output: { ...output, title: undefined, text: '', truncated: false },
    error
  }
}

export const webFetchTool: ToolDefinition<
  { url: string },
  { url: string; title?: string; text: string; truncated: boolean }
> = {
  name: 'web_fetch',
  description:
    'Fetch one web page (a http(s):// address) and return its readable text. Plain pages only — no search engines, no JavaScript-heavy apps.',
  access: 'read',
  inputSchema: z.object({
    url: z.string().min(1)
  }),
  pathFields: [],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: (input) => ({ title: `Open web page ${input.url}`, group: 'web' }),
  execute: async (input, ctx) => {
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      return failure(input, 'That does not look like a web address.')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return failure(input, 'I can only open web addresses starting with http:// or https://.')
    }
    if (!ctx.web) {
      return failure(input, 'Opening web pages is not available right now.')
    }
    try {
      const response = await ctx.web.fetch(input.url)
      if (response.status !== 200) {
        return failure(
          input,
          `That page answered with status ${response.status}, not a readable 200.`
        )
      }
      const contentType = response.contentType.toLowerCase()
      if (
        !contentType.includes('text/html') &&
        !contentType.includes('text/plain') &&
        !contentType.includes('json')
      ) {
        return failure(
          input,
          'That address is a file type I cannot read — I can only open web pages (HTML or plain text).'
        )
      }
      const { title, text: fullText } = contentType.includes('text/html')
        ? htmlToText(response.body)
        : { title: undefined, text: response.body }
      const slice = fullText.slice(0, MAX_TEXT_CHARS)
      return {
        ok: true,
        output: {
          url: input.url,
          ...(title !== undefined ? { title } : {}),
          text: slice,
          truncated: slice.length < fullText.length
        }
      }
    } catch (error) {
      return failure(
        input,
        error instanceof Error
          ? `That page could not be fetched — ${error.message}.`
          : 'That page could not be fetched.'
      )
    }
  }
}
