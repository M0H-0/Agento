import { sidecarFetch } from '../sidecar'

// Typed helpers for the sidecar endpoints the MVP wires into tool contexts
// (MVP_PLAN.md). Everything goes through sidecarFetch (token + default 2 s
// timeout); long-running calls pass their own AbortSignal. Failures throw an
// Error carrying the sidecar's plain-language detail — tool bodies catch it
// and answer honestly (docs/05 §6 degraded doctrine).

async function readDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === 'string' && body.detail) return body.detail
  } catch {
    // fall through to the generic message
  }
  return `The intelligence service answered with status ${response.status}.`
}

async function postJson<T>(path: string, payload: unknown, timeoutMs: number): Promise<T> {
  const response = await sidecarFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(await readDetail(response))
  return (await response.json()) as T
}

/** POST /document/extract {path} → {text, truncated} (MVP step 1). */
export function extractDocument(path: string): Promise<{ text: string; truncated: boolean }> {
  return postJson('/document/extract', { path }, 15_000)
}
