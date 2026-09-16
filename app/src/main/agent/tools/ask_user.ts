import { z } from 'zod'
import type { ToolDefinition } from '../types'

// P0 conversation tool (docs/03 §5): block the loop on the user's reply in
// the thread — powers the UNDERSTAND step of the system prompt (docs/03 §9).
// Risk 0 (docs/03 §5); the blocking pause is delivered via the AI SDK's
// tool-output-available chunk carrying `{ __askUserAwait, toolCallId,
// question, options? }` (M2.4 design) — the renderer card calls
// `window.agento.toolAnswer({ toolCallId, answer })` and main resolves the
// wrapper's promise. ask_user is intentionally NOT gated on the approval
// hook: it's a conversation primitive, not a destructive action.
const TRIM_QUESTION_LIMIT = 80
const MAX_OPTIONS = 8

// S3-005 one-confirmation rule: an unambiguous affirmative reply to an
// ask_user question authorizes the action the model asked about, so the
// registry consumes it as the approval for the next gated call instead of
// raising a second dialog. Anchored on purpose — "yes, but first…" and other
// qualified replies grant NOTHING (fail-closed: the dialog still appears).
export function isAffirmativeAnswer(answer: string): boolean {
  return /^\s*(yes|yeah|yep|yup|y|ok|okay|sure|approve|approved|go ahead|do it|proceed|confirm|confirmed|correct|right)\s*[.!]*\s*$/i.test(
    answer
  )
}

export const askUserTool: ToolDefinition<
  { question: string; options?: string[] },
  { question: string; answer: string }
> = {
  name: 'ask_user',
  description:
    'Ask the user a single clarifying question and wait for their reply in the thread. Use it ONLY when you cannot proceed without the answer — the request is ambiguous or missing something essential and no reasonable default exists. When the user asks you to create sample content (a story, example text, document) without providing it, invent short suitable content yourself with the file tools — never ask which story or what text to use. Never use it for greetings, small talk, or anything a normal conversational reply covers; answer those as plain text. Only the user can answer it: never answer ask_user yourself, never assume a reply, and never continue as if the user already answered. When you provide options, they must be short, concrete, mutually exclusive answers to the question. Never offer an option that means "proceed with your best judgment", "you decide", or similar — if the user should decide freely, send no options at all.',
  access: 'read',
  // `.nullish()` not `.optional()`: models legitimately send an explicit
  // `options: null` for open-ended questions (observed live: Groq's
  // openai/gpt-oss-120b sent exactly that and the strict optional rejected
  // it with a provider-side tool-validation 400). The transform folds null
  // back to undefined so the parsed output keeps the clean
  // `options?: string[]` contract for describe/execute.
  inputSchema: z.object({
    question: z.string().min(1).max(1000),
    options: z
      .array(z.string().min(1).max(200))
      .max(MAX_OPTIONS)
      .nullish()
      .transform((value) => value ?? undefined)
  }),
  pathFields: [],
  risk: () => ({ level: 0, reason: 'Conversation — blocks on the user reply' }),
  describe: (input) => {
    const trimmed = input.question.trim()
    const oneLine = trimmed.replace(/\s+/g, ' ')
    const shown =
      oneLine.length > TRIM_QUESTION_LIMIT ? `${oneLine.slice(0, TRIM_QUESTION_LIMIT)}…` : oneLine
    return { title: `Ask: ${shown}`, group: 'chat' }
  },
  execute: async (input, ctx) => {
    // toolCallId is injected via the ToolCallOptions the AI SDK passes to
    // `execute` (it isn't on our ToolExecutionContext by default). The
    // registry wrapper must thread it through — see the bridge in
    // src/main/agent/loop.ts. Until the user replies, the run is paused:
    // main forwards the synthetic pause chunk over `chat:part` and the
    // transport keeps the stream open (no finish/abort/error).
    const toolCallId = ctx.activeToolCallId
    if (!toolCallId) {
      // The wrapper treats { ok: false, error } as an honest non-execution
      // (status 'executed', ok=false) — the SDK surfaces the message and the
      // run continues. We carry a degenerate typed output so the generic
      // ToolResult<T> contract holds.
      return {
        ok: false,
        output: { question: input.question, answer: '' },
        error: 'ask_user was called without a toolCallId — the agent loop is misconfigured.'
      }
    }
    const answer = await ctx.requestUserAnswer({
      toolCallId,
      question: input.question,
      options: input.options
    })
    // S3-005: an affirmative answer IS the confirmation for the action asked
    // about — arm the one-shot grant the registry's approval stage consumes.
    if (ctx.askApprovalGrant && isAffirmativeAnswer(answer)) {
      ctx.askApprovalGrant.granted = true
    }
    return { ok: true, output: { question: input.question, answer } }
  }
}
