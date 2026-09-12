import { z } from 'zod'
import type { ToolDefinition } from '../types'

// L1 session recall, part 2: on-demand summary of this conversation. The
// summarization itself is a one-shot LLM call over the user's configured
// provider through ctx.llm (keys never leave the Electron main process —
// same doctrine as summarize_document). No stored summary, no auto-trigger:
// the model calls this when the user asks ("catch me up", "what did we
// decide") or before a long execution needs compression. Read-only, risk 0.

// Below the wrapper's 8 KB output cap so the model sees the summary plus
// metadata, never the generic "result was large" hint.
const MAX_PROMPT_CHARS = 12_000
const MAX_SUMMARY_CHARS = 4_000
const MAX_MESSAGES_DEFAULT = 30
const MAX_MESSAGES_CAP = 50

export const summarizeHistoryTool: ToolDefinition<
  { focus?: string; max_messages?: number },
  { summary: string; messagesCovered: number; truncated: boolean }
> = {
  name: 'summarize_history',
  description:
    "Summarize this conversation so far in plain language — decisions made, work done, open items. Optional focus steers the summary, e.g. 'the pricing decisions'.",
  access: 'read',
  inputSchema: z.object({
    focus: z.string().min(1).optional(),
    // No `.max()` cap on purpose (M3.7 gate finding): clamped in execute.
    max_messages: z.number().int().min(1).optional()
  }),
  pathFields: [],
  risk: () => ({ level: 0, reason: 'Read-only' }),
  describe: () => ({ title: 'Summarize this conversation', group: 'search' }),
  execute: async (input, ctx) => {
    try {
      if (!ctx.history) {
        throw new Error('Conversation recall is not available right now.')
      }
      if (!ctx.llm) {
        throw new Error('Summarizing needs the AI model, which is not available right now.')
      }
      const maxMessages = Math.min(input.max_messages ?? MAX_MESSAGES_DEFAULT, MAX_MESSAGES_CAP)
      const recent = await ctx.history.listRecent(maxMessages)
      if (recent.length === 0) {
        return {
          ok: true,
          output: {
            summary: 'Nothing in this conversation yet.',
            messagesCovered: 0,
            truncated: false
          }
        }
      }
      // Oldest-first for narrative order (listRecent is newest-first).
      const ordered = [...recent].reverse()
      const lines: string[] = []
      let chars = 0
      let truncated = false
      for (const entry of ordered) {
        const line = `[${entry.seq} ${entry.role}]: ${entry.text}`
        if (chars + line.length > MAX_PROMPT_CHARS) {
          truncated = true
          break
        }
        lines.push(line)
        chars += line.length
      }
      const prompt = [
        'Summarize the following conversation in clear, plain language.',
        input.focus
          ? `Focus especially on: ${input.focus}.`
          : 'Cover the decisions made, work done, and open items.',
        'Keep it under 200 words.',
        lines.length < ordered.length
          ? 'The text below is only the most recent part of a longer conversation — say so briefly.'
          : '',
        lines.join('\n')
      ]
        .filter((line) => line !== '')
        .join('\n')
      const summary = (await ctx.llm.complete(prompt)).slice(0, MAX_SUMMARY_CHARS)
      return {
        ok: true,
        output: {
          summary,
          messagesCovered: lines.length,
          truncated: truncated || lines.length < ordered.length
        }
      }
    } catch (error) {
      return {
        ok: false,
        output: { summary: '', messagesCovered: 0, truncated: false },
        error: error instanceof Error ? error.message : 'That conversation could not be summarized.'
      }
    }
  }
}
