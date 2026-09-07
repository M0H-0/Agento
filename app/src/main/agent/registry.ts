import { tool as aiTool, zodSchema } from 'ai'
import { z } from 'zod'
import type {
  RiskClassification,
  ToolCallOutcome,
  ToolCallStatus,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult
} from './types'
import { ToolRefusalError, resolveWorkspacePath } from './sandbox'

// Tool registry + wrapper (docs/03-agent-core.md §5, docs/06 §2-3).
//
// The wrapper is the product's core safety guarantee: every tool executes
// through `validate → sandbox resolve → risk → approval-hook → snapshot →
// execute → truncate`, in exactly that order, with no raw path (AGENTS.md
// rule 2 — "Mutations go through the registry"). Tools cannot opt out and
// there is no bypass.
//
// Plain Node only — no Electron imports; the approval hook and snapshot store
// are injected by the caller.

/** Result cap: large outputs never reach the model (docs/03 §5). Byte length
 *  of the serialized output; documented here so the Devlog and tests share one
 *  constant. 8 KB is generous for tool metadata while keeping the context lean. */
export const MAX_TOOL_OUTPUT_BYTES = 8 * 1024

export interface ToolRegistry {
  define<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void
  get(name: string): ToolDefinition | undefined
  /** The wrapper entry point — the loop (M2.4 slot) calls this per model tool call. */
  run(input: {
    tool: string
    args: unknown
    ctx: ToolExecutionContext
    /** AI SDK v5's toolCallId for the current call (defaults to the tool name). */
    toolCallId?: string
    /** M2.5 audit observer — notified once per wrapper run with the outcome
     * (every status: executed/refused/skipped/cancelled). Storage lives in
     * the IPC layer; the agent tree stays storage-free. */
    onOutcome?: (entry: {
      tool: string
      toolCallId: string | null
      input: unknown
      ok: boolean
      status: ToolCallStatus
      message: string
      riskLevel: number
      durationMs: number
    }) => void
  }): Promise<ToolCallOutcome>
  /**
   * Build the `tools` field of `streamText` from every defined tool. The loop
   * calls this once per run with the per-run ctx. Each returned tool is
   * `ai.tool({...})` whose `execute` goes through the registry wrapper, so
   * the same validate → sandbox → risk → approval-hook → snapshot → execute
   * → truncate order runs in the loop exactly as it does in the unit tests
   * (docs/03 §5, AGENTS.md rule 2).
   */
  toAiSdkTools(
    ctx: ToolExecutionContext,
    hooks?: {
      /** M2.5 audit sink — one notification per wrapper run (every status). */
      onOutcome?: (entry: {
        tool: string
        toolCallId: string | null
        input: unknown
        ok: boolean
        status: ToolCallStatus
        message: string
        riskLevel: number
        durationMs: number
      }) => void
    }
  ): Record<string, ReturnType<typeof aiTool>>
}

// Stage refusals are normal outcomes (a refused call is not a crash): the tool
// loop receives an honest plain-language message on the 'refused' status.
function refusal(message: string, opts?: { reason?: string }): ToolCallOutcome {
  return {
    ok: false,
    status: 'refused',
    tool: '',
    message,
    error: opts?.reason ?? message
  }
}

function truncatedResult(tool: string, result: ToolResult): ToolCallOutcome {
  const serialized = JSON.stringify(result.output)
  const size = serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8')
  if (size <= MAX_TOOL_OUTPUT_BYTES) {
    return { ok: result.ok, status: 'executed', tool, message: 'Done.', result: result.output }
  }
  return {
    ok: result.ok,
    status: 'executed',
    tool,
    message: 'Done (result was large — the full detail is in the session log).',
    result: { truncated: true, size, hint: 'Large tool result; check the session log.' }
  }
}
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>()

  function define<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (tools.has(tool.name)) {
      throw new Error(`Duplicate tool definition: ${tool.name}`)
    }
    tools.set(tool.name, tool as ToolDefinition)
  }

  async function run(input: {
    tool: string
    args: unknown
    ctx: ToolExecutionContext
    toolCallId?: string
    onOutcome?: (entry: {
      tool: string
      toolCallId: string | null
      input: unknown
      ok: boolean
      status: ToolCallStatus
      message: string
      riskLevel: number
      durationMs: number
    }) => void
  }): Promise<ToolCallOutcome> {
    const startedAt = Date.now()
    // runInner records the classified level here (its own stage-3 result —
    // never a second classification, which would double-run ctx.exists and
    // pollute the harness stage log).
    const audit: { riskLevel: number } = { riskLevel: 0 }
    const notify = (ok: boolean, status: ToolCallStatus, message: string): void => {
      input.onOutcome?.({
        tool: status === 'refused' ? input.tool : (tools.get(input.tool)?.name ?? input.tool),
        toolCallId: input.toolCallId ?? null,
        input: input.args,
        ok,
        status,
        message,
        riskLevel: audit.riskLevel,
        durationMs: Date.now() - startedAt
      })
    }
    let outcome: ToolCallOutcome
    try {
      outcome = await runInner(input, audit)
    } catch (error) {
      // A wrapper crash (never expected — stages catch their own) still
      // notifies the audit trail with ok=false.
      notify(false, 'refused', error instanceof Error ? error.message : String(error))
      throw error
    }
    notify(outcome.ok, outcome.status, outcome.message)
    return outcome
  }

  async function runInner(
    input: {
      tool: string
      args: unknown
      ctx: ToolExecutionContext
      toolCallId?: string
    },
    audit: { riskLevel: number }
  ): Promise<ToolCallOutcome> {
    const tool = tools.get(input.tool)
    if (!tool)
      return refusal(`I don't have a tool called "${input.tool}".`, { reason: 'unknown tool' })

    // 1 — validate (schema rejection short-circuits: no sandbox, no risk, no side effects).
    let parsed: unknown
    try {
      parsed = tool.inputSchema.parse(input.args)
    } catch (error) {
      const issues = error instanceof z.ZodError ? error.issues : []
      const detail = issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      return refusal(`The arguments for ${tool.name} were not right: ${detail.join('; ')}.`, {
        reason: 'schema validation'
      })
    }

    // 2 — sandbox resolve: every path field becomes an absolute path inside the
    // workspace; a refusal aborts BEFORE risk/approval/snapshot/execute. The
    // tool's access mode drives the link policy (docs/06 §4.3): reads may
    // follow an outside-pointing link, writes never may.
    const resolvedInput: Record<string, unknown> = { ...(parsed as Record<string, unknown>) }
    for (const field of tool.pathFields) {
      try {
        resolvedInput[String(field)] = resolveWorkspacePath(
          input.ctx.workspaceRoot,
          (parsed as Record<string, unknown>)[String(field)],
          tool.access
        )
      } catch (error) {
        if (error instanceof ToolRefusalError) {
          return refusal(error.message, { reason: 'sandbox' })
        }
        throw error
      }
    }

    // 3 — risk classification (rule-table floor; the sidecar may raise, never
    // lower, from M4 — docs/06 §2).
    const risk: RiskClassification = tool.risk(resolvedInput as never, input.ctx)
    audit.riskLevel = risk.level

    // 4 — approval hook: risk ≥ 2 blocks. 'skip'/'cancel' are honest
    // non-executions — no snapshot, no mutation, run semantics left to the loop.
    if (risk.level >= 2) {
      const decision = await input.ctx.requestApproval({
        tool: tool.name,
        title: tool.describe(resolvedInput as never).title,
        riskLevel: risk.level === 3 ? 3 : 2,
        reason: risk.reason,
        paths: tool.pathFields.map((field) => String(resolvedInput[String(field)]))
      })
      if (decision === 'skip') {
        return {
          ok: true,
          status: 'skipped',
          tool: tool.name,
          message: 'You asked me to skip this one, so I left it untouched.'
        }
      }
      if (decision === 'cancel') {
        return {
          ok: true,
          status: 'cancelled',
          tool: tool.name,
          message: 'Stopped — nothing was changed.'
        }
      }
    }

    // 5 — mandatory snapshot: every risk ≥ 1 (or write-access) target is
    // snapshotted BEFORE execution (docs/03 §7). There is no way to skip this.
    // The meta keys the durable checkpoint row (M2.5).
    if (risk.level >= 1 || tool.access === 'write') {
      for (const field of tool.pathFields) {
        input.ctx.snapshot(String(resolvedInput[String(field)]), {
          tool: tool.name,
          toolCallId: input.toolCallId
        })
      }
    }

    // 6 — execute. The tool body sees only pre-resolved, guarded paths and the
    // injected WorkspaceFs — it cannot bypass the sandbox. The active
    // toolCallId is injected into the per-call context so ask_user can pass it
    // through to the renderer pause protocol.
    const callCtx: ToolExecutionContext = input.toolCallId
      ? { ...input.ctx, activeToolCallId: input.toolCallId }
      : input.ctx
    const result = await tool.execute(resolvedInput as never, callCtx)
    if (!result.ok) {
      return {
        ok: false,
        status: 'executed',
        tool: tool.name,
        message: result.error ?? 'That step failed.',
        error: result.error
      }
    }

    // 7 — truncate: the model never sees oversized outputs (docs/03 §5).
    return truncatedResult(tool.name, result)
  }

  function toAiSdkTools(
    ctx: ToolExecutionContext,
    hooks?: {
      /** M2.5 audit sink — one notification per wrapper run (every status). */
      onOutcome?: Parameters<ToolRegistry['run']>[0]['onOutcome']
    }
  ): Record<string, ReturnType<typeof aiTool>> {
    const out: Record<string, ReturnType<typeof aiTool>> = {}
    for (const [name, tool] of tools) {
      // The AI SDK's `tool()` helper is generic on INPUT/OUTPUT. Our registry
      // stores the untyped ToolDefinition (the schema is Zod-typed and the
      // runtime re-validates). We build the AI SDK tool with `unknown` shape
      // — the wrapper handles validation, so the SDK just plumbs args through.
      // The execute callback receives `(input, options)` where options carries
      // the AI SDK's `toolCallId` and `messages`; we pass toolCallId through
      // so ask_user can identify its pause request on the renderer side.
      const wrapped = aiTool({
        description: tool.description,
        inputSchema: zodSchema(tool.inputSchema as unknown as z.ZodTypeAny) as never,
        execute: async (input: unknown, options: { toolCallId: string }): Promise<unknown> => {
          // One-line lifecycle log per tool call (main stdout → dev log).
          // Permanent value, not gate scaffolding: until the M3 audit log
          // lands, this is the only record of what the loop actually ran.
          console.log(`[tools] call ${name} ${JSON.stringify(input)?.slice(0, 200)}`)
          const outcome = await run({
            tool: name,
            args: input,
            ctx,
            toolCallId: options.toolCallId,
            onOutcome: hooks?.onOutcome
          })
          console.log(`[tools] ${name} -> ${outcome.status} ok=${outcome.ok}`)
          // The AI SDK consumes whatever the execute returns as the tool
          // output (and renders it in the card body). Refusals/skips/
          // cancellations become a plain-language message object so the
          // card is honest about what happened.
          if (outcome.status === 'refused') {
            throw new Error(outcome.message)
          }
          if (outcome.status === 'skipped') {
            return { __agentoOutcome: 'skipped', message: outcome.message }
          }
          if (outcome.status === 'cancelled') {
            return { __agentoOutcome: 'cancelled', message: outcome.message }
          }
          if (outcome.ok === false) {
            throw new Error(outcome.message)
          }
          // 'executed' (the success path) — `outcome.result` is the wrapper's
          // shape (may be the `truncated` envelope); unwrap when present.
          const result = outcome.result as { truncated?: boolean; hint?: string } | undefined
          if (result && typeof result === 'object' && 'truncated' in result && result.truncated) {
            return { truncated: true, hint: result.hint ?? 'Large result; see session log.' }
          }
          return result
        }
      }) as unknown as ReturnType<typeof aiTool>
      out[name] = wrapped
    }
    return out
  }

  return { define, get: (name) => tools.get(name), run, toAiSdkTools }
}
