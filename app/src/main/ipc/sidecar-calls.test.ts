import { beforeEach, describe, expect, it, vi } from 'vitest'
import { embedTexts } from './sidecar-calls'
import { sidecarFetch } from '../sidecar'

vi.mock('../sidecar', () => ({
  sidecarFetch: vi.fn()
}))

const mockFetch = vi.mocked(sidecarFetch)

function okResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

function errResponse(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as Response
}

describe('embedTexts — /embed/embed envelope', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('unwraps the {vectors} envelope to a plain array', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        vectors: [
          [1, 0],
          [0, 1]
        ]
      })
    )
    await expect(embedTexts(['a', 'b'])).resolves.toEqual([
      [1, 0],
      [0, 1]
    ])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [path, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/embed/embed')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ texts: ['a', 'b'] })
  })

  it('unwraps an empty batch to []', async () => {
    mockFetch.mockResolvedValue(okResponse({ vectors: [] }))
    await expect(embedTexts([])).resolves.toEqual([])
  })

  it('rejects honestly when the envelope is missing vectors', async () => {
    mockFetch.mockResolvedValue(okResponse({ wrong: [] }))
    await expect(embedTexts(['a'])).rejects.toThrow('unexpected response')
  })

  it('rejects honestly when vectors is not an array', async () => {
    mockFetch.mockResolvedValue(okResponse({ vectors: 'not-an-array' }))
    await expect(embedTexts(['a'])).rejects.toThrow('unexpected response')
  })

  it('propagates the sidecar detail on HTTP errors', async () => {
    mockFetch.mockResolvedValue(errResponse(503, { detail: 'model down' }))
    await expect(embedTexts(['a'])).rejects.toThrow('model down')
  })
})
