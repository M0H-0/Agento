import { sidecarFetch } from '../sidecar'

// Typed helpers for the sidecar endpoints the MVP wires into tool contexts
// (MVP_PLAN.md). Everything goes through sidecarFetch (token + default 2 s
// timeout); long-running calls pass their own AbortSignal. Failures throw an
// Error carrying the sidecar's plain-language detail — tool bodies catch it
// and answer honestly (docs/05 §6 degraded doctrine).

async function readDetail(response: Response): Promise<string> {
  // 403 is the sidecar's per-launch token refusal (docs/02 §2.4) — an internal
  // auth detail that must never reach the model or the thread (live: the model
  // repeated "X-Agento-Token header" to the user). Answer with the same honest
  // "service unavailable" copy the tools use when the sidecar is down.
  if (response.status === 403) {
    try {
      await response.json()
    } catch {
      // Body is irrelevant — the copy below is the whole answer.
    }
    return 'The intelligence service is not ready right now.'
  }
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === 'string' && body.detail) {
      // Belt-and-braces: no internal header/token name ever leaves this module.
      if (/X-Agento-Token|AGENTO_INTELLIGENCE_TOKEN/i.test(body.detail)) {
        return 'The intelligence service is not ready right now.'
      }
      return body.detail
    }
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

/** POST /document/edit {path, edits} → excerpts (demo document editing).
 * `.docx`/`.pptx`/`.xlsx` — text formats edit directly in TS. */
export function editDocxDocument(
  path: string,
  edits: { anchor: string; replacement: string }[]
): Promise<{ beforeExcerpt: string; afterExcerpt: string; editsApplied: number }> {
  return postJson<{ before_excerpt: string; after_excerpt: string; edits_applied: number }>(
    '/document/edit',
    { path, edits },
    15_000
  ).then((body) => ({
    beforeExcerpt: body.before_excerpt,
    afterExcerpt: body.after_excerpt,
    editsApplied: body.edits_applied
  }))
}

/** POST /document/create {path, title, items} → excerpt + size (demo).
 * `.docx`/`.pptx`/`.xlsx` — text files go through write_file, PDFs through
 * the printToPDF export in `./pdf-export`. */
export function createDocument(
  path: string,
  title: string,
  items: string[]
): Promise<{ afterExcerpt: string; sizeBytes: number }> {
  return postJson<{ after_excerpt: string; size_bytes: number }>(
    '/document/create',
    { path, title, items },
    15_000
  ).then((body) => ({ afterExcerpt: body.after_excerpt, sizeBytes: body.size_bytes }))
}

/** POST /embed/embed {texts} → {vectors} (MVP step 5). The generous timeout
 * covers the first-call ~90 MB model download plus a full-workspace batch.
 * Unwraps the `{vectors}` envelope — returning the raw body (the pre-fix
 * shape) breaks every caller with a length mismatch. */
export function embedTexts(texts: string[]): Promise<number[][]> {
  return postJson<{ vectors: unknown }>('/embed/embed', { texts }, 300_000).then((body) => {
    if (body === null || typeof body !== 'object' || !Array.isArray(body.vectors)) {
      throw new Error('The embedding service returned an unexpected response.')
    }
    return body.vectors as number[][]
  })
}

/** MVP step 5: pull the embedding model into the local cache at app boot
 * (once the sidecar is healthy) so the first semantic search never waits on
 * a download. Best-effort — failures are swallowed by design. */
export function warmEmbeddingModel(): Promise<unknown> {
  return postJson<{ vectors: unknown }>('/embed/embed', { texts: ['warmup'] }, 300_000).catch(
    (error: unknown) => {
      console.error('[semantic] embedding model warmup failed:', error)
    }
  )
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
