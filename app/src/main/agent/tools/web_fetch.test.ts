import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { webFetchTool, htmlToText } from './web_fetch'
import { createHandlerHarness, createTempWorkspace } from '../testing/harness'
import type { TempWorkspace } from '../testing/harness'

describe('web_fetch — read-only', () => {
  let ws: TempWorkspace
  let harness: ReturnType<typeof createHandlerHarness>

  beforeEach(() => {
    ws = createTempWorkspace()
    harness = createHandlerHarness(ws.root)
    harness.registry.define(webFetchTool)
  })

  afterEach(() => {
    ws.cleanup()
  })

  it('strips an HTML page to readable text and pulls the title', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_fetch',
      args: { url: 'https://example.com/pricing' },
      ctx: {
        ...harness.ctx,
        web: {
          fetch: async () => ({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body:
              '<html><head><title>Acme Pricing</title><style>body{color:red}</style></head>' +
              '<body><script>evil()</script><h1>Plans</h1><p>Pro is &amp;10 monthly.</p>' +
              '<p>Second paragraph</p></body></html>'
          })
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { title?: string; text: string; truncated: boolean }
    expect(result.title).toBe('Acme Pricing')
    expect(result.text).toContain('Plans')
    expect(result.text).toContain('Pro is &10 monthly.')
    expect(result.text).toContain('Second paragraph')
    expect(result.text).not.toContain('evil()')
    expect(result.text).not.toContain('color:red')
    expect(result.truncated).toBe(false)
  })

  it('passes plain-text pages through with an honest truncation marker', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_fetch',
      args: { url: 'https://example.com/big.txt' },
      ctx: {
        ...harness.ctx,
        web: {
          fetch: async () => ({
            status: 200,
            contentType: 'text/plain',
            body: 'z'.repeat(9_000)
          })
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.result) throw new Error('expected result')
    const result = outcome.result as { text: string; truncated: boolean }
    expect(result.text).toContain('BEGIN UNTRUSTED CONTENT')
    expect(result.text.length).toBeGreaterThan(6_000)
    expect(result.truncated).toBe(true)
  })

  it('refuses non-http(s) schemes', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_fetch',
      args: { url: 'file:///C:/Windows/win.ini' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('http:// or https://')
  })

  it('answers honestly when no web capability is injected', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_fetch',
      args: { url: 'https://example.com/' },
      ctx: harness.ctx
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('not available')
  })

  it('refuses non-200 answers and unreadable content types in plain language', async () => {
    const notFound = await harness.registry.run({
      tool: 'web_fetch',
      args: { url: 'https://example.com/missing' },
      ctx: {
        ...harness.ctx,
        web: { fetch: async () => ({ status: 404, contentType: 'text/html', body: 'nope' }) }
      }
    })
    expect(notFound.ok).toBe(false)
    expect(notFound.message).toContain('404')

    const binary = await harness.registry.run({
      tool: 'web_fetch',
      args: { url: 'https://example.com/image.png' },
      ctx: {
        ...harness.ctx,
        web: { fetch: async () => ({ status: 200, contentType: 'image/png', body: '\x89PNG' }) }
      }
    })
    expect(binary.ok).toBe(false)
    expect(binary.message).toContain('file type')
  })

  it('surfaces network failures as plain-language errors', async () => {
    const outcome = await harness.registry.run({
      tool: 'web_fetch',
      args: { url: 'https://no-such-host.invalid/' },
      ctx: {
        ...harness.ctx,
        web: {
          fetch: async () => {
            throw new Error('getaddrinfo ENOTFOUND no-such-host.invalid')
          }
        }
      }
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('could not be fetched')
  })
})

describe('htmlToText — unit', () => {
  it('collapses whitespace and keeps paragraph breaks', () => {
    const { text } = htmlToText('<p>One</p>\n<p>Two</p>   <p>Three</p>')
    expect(text).toBe('One\nTwo\nThree')
  })
})
