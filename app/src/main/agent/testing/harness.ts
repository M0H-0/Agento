import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SnapshotEntry, ToolCallOutcome, ToolExecutionContext } from '../types'
import { createWorkspaceFs } from '../workspace-fs'
import { createToolRegistry } from '../registry'

// Wrapper test harness (docs/07 §2 Sandbox guard / Registry wrapper rows):
// builds a real temp workspace, a scriptable approval hook, an in-memory
// snapshot store, and a stage-order call log, then runs a tool through the
// wrapper. Reused by the M2.4+ tool suites.
//
// The stage-order log is the crux — it proves the wrapper executes stages in
// exactly validate → sandbox → risk → approval-hook → snapshot → execute.

export interface HarnessStages {
  /** Risk-stage probes (resolved path → exists?). */
  riskProbes: string[]
  snapshots: SnapshotEntry[]
  approvals: { request: unknown; decision: 'approve' | 'skip' | 'cancel' }[]
  /** Every ask_user request the tool made. */
  askUserRequests: { toolCallId: string; question: string; options?: string[] }[]
  /** Scriptable answer for the next ask_user call. Resolved answers are
   *  removed; defaults are an empty string. */
  pendingAnswer: () => string | undefined
  setPendingAnswer: (answer: string | undefined) => void
  executions: string[]
  order: string[]
}

export function createHandlerHarness(
  workspaceRoot: string,
  decision: 'approve' | 'skip' | 'cancel' = 'approve'
): {
  ctx: ToolExecutionContext
  stages: HarnessStages
  registry: ReturnType<typeof createToolRegistry>
} {
  const stages: HarnessStages = {
    riskProbes: [],
    snapshots: [],
    approvals: [],
    askUserRequests: [],
    pendingAnswer: () => undefined,
    setPendingAnswer: () => undefined,
    executions: [],
    order: []
  }
  const snapshots: {
    path: string
    content: string | null
    existed: boolean
    tool: string
    ts: number
  }[] = []
  const fs = createWorkspaceFs(workspaceRoot)
  let nextAnswer: string | undefined = undefined
  stages.setPendingAnswer = (answer) => {
    nextAnswer = answer
  }
  stages.pendingAnswer = () => nextAnswer

  const ctx: ToolExecutionContext = {
    workspaceRoot,
    exists: (path) => {
      stages.order.push('risk')
      stages.riskProbes.push(path)
      return fs.existsSync(path)
    },
    snapshot: (path, meta) => {
      stages.order.push('snapshot')
      // A directory target has no file content to restore — the checkpoint
      // records existed + path only (undo deletes the created dir).
      const isDir = fs.isDirectory(path)
      const entry = {
        path,
        content: !isDir && fs.existsSync(path) ? fs.readFileSync(path) : null,
        existed: fs.existsSync(path),
        tool: 'write_file',
        destPath: meta?.destPath ?? null,
        ts: Date.now()
      }
      snapshots.push(entry)
      stages.snapshots.push(entry)
    },
    requestApproval: async (request) => {
      stages.order.push('approval')
      stages.approvals.push({ request, decision })
      return decision
    },
    requestUserAnswer: async (request) => {
      stages.askUserRequests.push({
        toolCallId: request.toolCallId,
        question: request.question,
        options: request.options
      })
      const answer = nextAnswer ?? ''
      nextAnswer = undefined
      return answer
    },
    fs
  }

  const registry = createToolRegistry()
  return { ctx, stages, registry }
}

export interface TempWorkspace {
  root: string
  write(relPath: string, content: string): void
  read(relPath: string): string
  cleanup(): void
}

export function createTempWorkspace(): TempWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'agento-test-ws-'))
  return {
    root,
    write(relPath, content) {
      writeFileSync(join(root, relPath), content, 'utf8')
    },
    read(relPath) {
      return readFileSync(join(root, relPath), 'utf8')
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** Convenience: registry must already have the tool defined. */
export async function runToolThroughWrapper(input: {
  registry: ReturnType<typeof createToolRegistry>
  ctx: ToolExecutionContext
  tool: string
  args: unknown
}): Promise<ToolCallOutcome> {
  return input.registry.run({ tool: input.tool, args: input.args, ctx: input.ctx })
}
