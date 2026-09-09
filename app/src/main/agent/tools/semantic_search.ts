import { z } from 'zod'
import type { ToolDefinition } from '../types'

// MVP standout tool (MVP_PLAN.md): find files by MEANING, not exact text —
// on-device sentence embeddings (all-MiniLM-L6-v2 via the sidecar's fastembed)
// ranked by cosine similarity over a cached index. Read-only, risk 0, no
// pathFields (the query is not a path).

export const semanticSearchTool: ToolDefinition<
  { query: string; top_k?: number },
  { query: string; results: { path: string; snippet: string; score: number }[] }
> = {
  name: 'semantic_search',
  description:
    'Find files in the user\'s workspace by MEANING, not exact wording — e.g. "where did I write about pricing?". Use this instead of search_files when the user describes a topic rather than quoting exact text.',
  access: 'read',
  inputSchema: z.object({
    query: z.string().min(1),
    // No `.max()` cap on purpose (M3.7 gate finding) — clamped in execute.
    top_k: z.number().int().min(1).optional()
  }),
  pathFields: [],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: (input) => ({
    title: `Search by meaning "${input.query.length > 32 ? `${input.query.slice(0, 32)}…` : input.query}"`,
    group: 'search'
  }),
  execute: async (input, ctx) => {
    try {
      if (!ctx.semantic) {
        throw new Error('Semantic search is not available right now.')
      }
      const results = await ctx.semantic.search(input.query, input.top_k)
      return { ok: true, output: { query: input.query, results } }
    } catch (error) {
      return {
        ok: false,
        output: { query: input.query, results: [] },
        error:
          error instanceof Error ? error.message : 'The semantic search could not run this time.'
      }
    }
  }
}
