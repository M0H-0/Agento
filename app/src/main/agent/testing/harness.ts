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

  const ctx: ToolExecutionContext = {
    workspaceRoot,
    exists: (path) => {
      stages.order.push('risk')
      stages.riskProbes.push(path)
      return fs.existsSync(path)
    },
    snapshot: (path) => {
      stages.order.push('snapshot')
      const entry = {
        path,
        content: fs.existsSync(path) ? fs.readFileSync(path) : null,
        existed: fs.existsSync(path),
        tool: 'write_file',
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
