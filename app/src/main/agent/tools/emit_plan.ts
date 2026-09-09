import { z } from 'zod'
import type { ToolDefinition } from '../types'

// The plan tool (docs/03 §2 + §5, M3.1): the structured plan the loop forces
// the model to emit FIRST on every mutating request. Plan-first is structural,
// not prompted: the plan phase calls streamText with ONLY this tool available
// and `toolChoice: { type: 'tool', toolName: 'emit_plan' }` (mechanism proven
// by plan-mechanism.spike.test.ts on the pinned ai@5.0.250), so the model
// literally cannot do anything else before the plan exists.
//
// Risk 0 / read access (docs/03 §5 inventory): emit_plan proposes work, it
// never touches the disk — through the registry wrapper it exercises only
// validate → sandbox (no pathFields) → risk, never approval or snapshot.
// The plan-run layer turns the executed call into the `plan/created` event
// and blocks on the plan-start promise (context.ts); the tool's execute just
// echoes the steps back as its output (the SDK ships them to the model as the
// tool result, so the execution phase keeps the plan in context).
export const planStepsSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1),
        tool: z.string().min(1),
        riskLevel: z.number().int().min(0).max(3),
        requiresApproval: z.boolean()
      })
    )
    .min(1)
})

export type PlanStepList = z.infer<typeof planStepsSchema>
export type PlanStep = PlanStepList['steps'][number]

export const emitPlanTool: ToolDefinition<PlanStepList, PlanStepList> = {
  name: 'emit_plan',
  description:
    'Emit the structured plan for the user to review before any work begins. One entry per step: a plain-language description of what will happen, the tool that will do it, its risk level (0 safe – 3 destructive), and whether it needs approval.',
  access: 'read',
  inputSchema: planStepsSchema,
  pathFields: [],
  risk: () => ({ level: 0, reason: 'Plan proposal — reads nothing, changes nothing' }),
  describe: () => ({ title: 'Prepared a plan', group: 'plan' }),
  execute: async (input) => ({ ok: true, output: input })
}
