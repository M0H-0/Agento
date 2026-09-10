import type { ApprovalDecision, ApprovalRequest } from './types'

// Approval coalescing (docs/03 §5, M3.3): consecutive same-tool calls inside
// one run ask ONCE with a projected count, then reconcile.
//
// Group key = tool name (step/shape narrowing lands with the plan-step
// mapping). First call opens the group and awaits the real approval hook;
// buffered calls await the same shared promise; post-decision calls run
// immediately under the recorded decision (no second modal).
//
// Projection (the count the one dialog shows): the adapter passes the
// projected batch size per call — parsed from the plan step's description
// when it states one ("move 42 files"), else the step's own enumeration
// (list_dir file count / search match count). The group adopts the first
// non-null projection it sees. When no projection exists, the running
// buffered count is shown once it exceeds one.
//
// 25% re-ask (docs/03 §5): if the actual set exceeds the projection by more
// than 25 %, the wrapper pauses and re-asks ONCE with the real count — a
// projection must never quietly grow. Implemented as a second generation:
// calls arriving past the threshold open a fresh group (fresh approvalId,
// fresh dialog) while already-approved calls keep their decision.
// (Bulk > 25 paths ⇒ risk 3 lives in docs/06 §2 and stays deferred.)

type GroupState = {
  decision: ApprovalDecision | null
  shared: Promise<ApprovalDecision> | null
  count: number
  /** Adopted projection (null = none stated/enumerated). */
  projected: number | null
  /** True once the 25% re-ask fired — exactly one re-ask per group. */
  reasked: boolean
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50
}

// "move 42 files" / "all six .txt files" → 42 / 6. Digits first (exact),
// then number words. Null when the text states no batch size.
export function parseCountFromText(text: string): number | null {
  const digit = text.match(
    /(\d+)\s*(files?|items?|documents?|notes?|pdfs?|images?|photos?|matches|entries)/i
  )
  if (digit?.[1]) {
    const n = Number.parseInt(digit[1], 10)
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  const word = text.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)\b\s*(files?|items?|documents?|notes?|pdfs?|images?|photos?|matches|entries)?/i
  )
  if (word?.[1]) {
    const n = NUMBER_WORDS[word[1].toLowerCase()]
    if (n !== undefined) return n
  }
  return null
}

export function createApprovalCoalescer(
  requestOne: (request: ApprovalRequest, displayCount: number | null) => Promise<ApprovalDecision>,
  hooks?: {
    /** Fired whenever another same-shape call lands on the group — the
     * adapter re-emits `approval/requested` with the display count so the
     * one dialog shows the batch size live. */
    onBuffered?: (tool: string, displayCount: number | null, generation: number) => void
  }
): {
  request: (request: ApprovalRequest, projected?: number | null) => Promise<ApprovalDecision>
  groupCount: (tool: string) => number
  generation: (tool: string) => number
} {
  const groups = new Map<string, GroupState & { generation: number }>()

  const displayCountFor = (state: { count: number; projected: number | null }): number | null => {
    if (state.projected !== null) return state.projected
    return state.count > 1 ? state.count : null
  }

  const groupKeyFor = (req: ApprovalRequest): string =>
    `${req.tool}:${req.riskLevel}${req.stepId ? `:${req.stepId}` : ''}`

  const request = (req: ApprovalRequest, projected?: number | null): Promise<ApprovalDecision> => {
    const key = groupKeyFor(req)
    const existing = groups.get(key)
    if (existing) {
      // 25% re-ask: past the threshold with a decision already recorded,
      // open a fresh generation (fresh dialog, real count) exactly once.
      if (
        existing.decision !== null &&
        existing.projected !== null &&
        !existing.reasked &&
        existing.count + 1 > Math.floor(existing.projected * 1.25)
      ) {
        existing.reasked = true
        // Fresh generation, fresh dialog — with the REAL count (not 1), so
        // the re-ask states what actually arrived (docs/03 §5).
        const realCount = existing.count + 1
        const next = {
          decision: null as ApprovalDecision | null,
          shared: null as Promise<ApprovalDecision> | null,
          count: 1,
          projected: null as number | null,
          reasked: true,
          generation: existing.generation + 1
        }
        groups.set(key, next)
        next.shared = requestOne(req, realCount).then((decision) => {
          next.decision = decision
          return decision
        })
        return next.shared
      }
      existing.count += 1
      if (existing.projected === null && projected !== undefined && projected !== null) {
        existing.projected = projected
      }
      try {
        hooks?.onBuffered?.(req.tool, displayCountFor(existing), existing.generation)
      } catch {
        // count projection is best-effort — the shared decision is the contract
      }
      if (existing.decision !== null) return Promise.resolve(existing.decision)
      // Buffered: await the open group's shared promise (never executes
      // before the decision resolves — asserted in tests via the order log).
      return existing.shared as Promise<ApprovalDecision>
    }
    const state = {
      decision: null as ApprovalDecision | null,
      shared: null as Promise<ApprovalDecision> | null,
      count: 1,
      projected: projected ?? null,
      reasked: false,
      generation: 0
    }
    groups.set(key, state)
    state.shared = requestOne(req, displayCountFor(state)).then((decision) => {
      state.decision = decision
      return decision
    })
    return state.shared
  }

  return {
    request,
    groupCount: (tool: string) => {
      let total = 0
      for (const [k, v] of groups) {
        if (k === tool || k.startsWith(`${tool}:`)) total += v.count
      }
      return total
    },
    generation: (tool: string) => {
      let max = 0
      let found = false
      for (const [k, v] of groups) {
        if (k === tool || k.startsWith(`${tool}:`)) {
          found = true
          if (v.generation > max) max = v.generation
        }
      }
      return found ? max : 0
    }
  }
}
