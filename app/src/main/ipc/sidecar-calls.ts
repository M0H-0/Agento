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

/** POST /embed/embed {texts} → {vectors} (MVP step 5). The generous timeout
 * covers the first-call ~90 MB model download plus a full-workspace batch. */
export function embedTexts(texts: string[]): Promise<number[][]> {
  return postJson('/embed/embed', { texts }, 300_000)
}

/** MVP step 5: pull the embedding model into the local cache at app boot
 * (once the sidecar is healthy) so the first semantic search never waits on
 * a download. Best-effort — failures are swallowed by design. */
export function warmEmbeddingModel(): Promise<unknown> {
  return postJson('/embed/embed', { texts: ['warmup'] }, 300_000).catch((error: unknown) => {
    console.error('[semantic] embedding model warmup failed:', error)
  })
}

/** POST /intent/classify {message} → {intent, confidence} (MVP step 6).
 * Informational only — the loop never blocks on it. */
export function classifyIntent(message: string): Promise<{ intent: string; confidence: string }> {
  return postJson('/intent/classify', { message }, 5_000)
}

/** POST /safety/classify {tool, args} → {risk, reason} (MVP step 6). Audit
 * cross-check only — the registry's rule table stays the approval floor. */
export function classifySafety(
  tool: string,
  args: unknown
): Promise<{ risk: number; reason: string }> {
  return postJson('/safety/classify', { tool, args }, 5_000)
}
