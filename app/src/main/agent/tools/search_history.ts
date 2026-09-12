import { z } from 'zod'
import { cosine } from '../semantic-index'
import type { ToolDefinition } from '../types'

// L1 session recall: search THIS conversation's earlier messages. Semantic
// ladder (docs/03 §5): on-device embeddings first (paraphrase matches —
// "pricing" finds "cost breakdown"), keyword fallback when the sidecar/model
// is down. The output names the answering engine so cards stay honest.
// Read-only, risk 0, no pathFields (the query is not a path).

const MAX_CANDIDATES = 100
const MAX_CANDIDATE_CHARS = 1_800
const MAX_EXCERPT_CHARS = 300

function excerptOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= MAX_EXCERPT_CHARS ? oneLine : `${oneLine.slice(0, MAX_EXCERPT_CHARS)}…`
}

export const searchHistoryTool: ToolDefinition<
  { query: string; limit?: number },
  {
    query: string
    engine: 'semantic' | 'keyword'
    matches: { seq: number; role: string; excerpt: string; score?: number }[]
  }
> = {
  name: 'search_history',
  description:
    "Search this conversation's earlier messages for a topic — e.g. what the user said about pricing. Finds paraphrases, not just exact words; falls back to exact matching when the on-device model is unavailable.",
  access: 'read',
  inputSchema: z.object({
    query: z.string().min(1),
    // No `.max()` cap on purpose (M3.7 gate finding): clamped in execute.
    limit: z.number().int().min(1).optional()
  }),
  pathFields: [],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: (input) => ({
    title: `Recall "${input.query.length > 32 ? `${input.query.slice(0, 32)}…` : input.query}"`,
    group: 'search'
  }),
  execute: async (input, ctx) => {
    const limit = Math.min(input.limit ?? 5, 10)
    if (!ctx.history) {
      return {
        ok: false,
        output: { query: input.query, engine: 'keyword' as const, matches: [] },
        error: 'Conversation recall is not available right now.'
      }
    }
    // Semantic primary: embed the query + recent candidates in one batch and
    // cosine-rank. Embeddings are per-call and discarded — nothing cached, so
    // nothing to invalidate when a stopped run re-persists a partial.
    if (ctx.embed) {
      try {
        const recent = await ctx.history.listRecent(MAX_CANDIDATES)
        const candidates = recent
          .map((entry) => ({ ...entry, text: entry.text.slice(0, MAX_CANDIDATE_CHARS) }))
          .filter((entry) => entry.text.trim().length > 0)
        if (candidates.length > 0) {
          const vectors = await ctx.embed.embedTexts([
            input.query,
            ...candidates.map((entry) => entry.text)
          ])
          const [queryVector, ...candidateVectors] = vectors as [number[], ...number[][]]
          if (queryVector && candidateVectors.length === candidates.length) {
            const ranked = candidates
              .map((entry, i) => ({
                seq: entry.seq,
                role: entry.role,
                excerpt: excerptOf(entry.text),
                score:
                  Math.round(cosine(queryVector, candidateVectors[i] as number[]) * 1000) / 1000
              }))
              .sort((a, b) => (b.score as number) - (a.score as number))
              .slice(0, limit)
            return {
              ok: true,
              output: { query: input.query, engine: 'semantic' as const, matches: ranked }
            }
          }
        } else {
          return {
            ok: true,
            output: { query: input.query, engine: 'semantic' as const, matches: [] }
          }
        }
      } catch {
        // Fall through to the keyword path — a down sidecar never fails recall.
      }
    }
    const matches = await ctx.history.search(input.query, limit)
    return { ok: true, output: { query: input.query, engine: 'keyword' as const, matches } }
  }
}
