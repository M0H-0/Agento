import { z } from 'zod'
import type {
  RiskClassification,
  ToolCallOutcome,
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
  run(input: { tool: string; args: unknown; ctx: ToolExecutionContext }): Promise<ToolCallOutcome>
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
  }): Promise<ToolCallOutcome> {
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
    // workspace; a refusal aborts BEFORE risk/approval/snapshot/execute.
    const resolvedInput: Record<string, unknown> = { ...(parsed as Record<string, unknown>) }
    for (const field of tool.pathFields) {
      try {
        resolvedInput[String(field)] = resolveWorkspacePath(
          input.ctx.workspaceRoot,
          (parsed as Record<string, unknown>)[String(field)]
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
    if (risk.level >= 1 || tool.access === 'write') {
      for (const field of tool.pathFields) {
        input.ctx.snapshot(String(resolvedInput[String(field)]))
      }
    }

    // 6 — execute. The tool body sees only pre-resolved, guarded paths and the
    // injected WorkspaceFs — it cannot bypass the sandbox.
    const result = await tool.execute(resolvedInput as never, input.ctx)
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

  return { define, get: (name) => tools.get(name), run }
}
