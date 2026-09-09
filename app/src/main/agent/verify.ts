import { z } from 'zod'

// Verification client (M3.5, docs/03 §6 + docs/05 §2 `/completion/verify`).
// The endpoint itself lands in M4.3 — this client is built exactly to its
// fixed HTTP contract now, so it starts talking the moment M4.3 lands.
// Sidecar absent/unhealthy/timeout/non-200/parse failure → `{ skipped }`
// (a badge is never faked; the UI renders "not verified").

const verifyResponseSchema = z.object({
  completion_score: z.number(),
  is_complete: z.boolean(),
  missed_segments: z.array(z.string())
})

export interface VerifyStepInput {
  instructionSegment: string
  stepDescription: string
  actions: { tool: string; input: unknown; result: unknown }[]
  beforeAfter: { before: string | null; after: string | null }
}

export type VerifyVerdict =
  | { verdict: 'skipped' }
  | { verdict: 'complete'; score: number }
  | { verdict: 'incomplete'; score: number; missedSegments: string[] }

export interface VerifyDeps {
  /** 'healthy' when the sidecar is up; anything else skips honestly. */
  sidecarHealth: () => 'healthy' | 'unhealthy' | 'starting'
  /** Injected fetch (sidecar.ts `sidecarFetch` in prod, stub in tests). */
  fetchVerify: (body: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>
  timeoutMs?: number
}

// Tools whose successful outcome implies a filesystem postcondition worth
// verifying (the sidecar's heuristic re-reads those targets). Read-only-only
// steps are skipped honestly — a badge is never faked in either direction.
const MUTATING_TOOLS = new Set([
  'create_dir',
  'write_file',
  'edit_file',
  'move_path',
  'copy_path',
  'delete_path'
])

export function hasMutatingActions(actions: { tool: string }[]): boolean {
  return actions.some((action) => MUTATING_TOOLS.has(action.tool))
}

export async function verifyStep(deps: VerifyDeps, input: VerifyStepInput): Promise<VerifyVerdict> {
  if (deps.sidecarHealth() !== 'healthy') return { verdict: 'skipped' }
  const body = {
    instruction: input.instructionSegment,
    step_description: input.stepDescription,
    actions: input.actions,
    before_after: { before: input.beforeAfter.before, after: input.beforeAfter.after }
  }
  let res: { status: number; json: () => Promise<unknown> }
  try {
    const timeoutMs = deps.timeoutMs ?? 8000
    res = await Promise.race([
      deps.fetchVerify(body),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('verify timeout')), timeoutMs)
      })
    ])
  } catch {
    return { verdict: 'skipped' }
  }
  if (res.status !== 200) return { verdict: 'skipped' }
  let parsed: z.infer<typeof verifyResponseSchema>
  try {
    parsed = verifyResponseSchema.parse(await res.json())
  } catch {
    return { verdict: 'skipped' }
  }
  if (parsed.is_complete || parsed.completion_score >= 0.85) {
    return { verdict: 'complete', score: parsed.completion_score }
  }
  return {
    verdict: 'incomplete',
    score: parsed.completion_score,
    missedSegments: parsed.missed_segments
  }
}
