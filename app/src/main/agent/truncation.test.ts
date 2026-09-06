import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createToolRegistry, MAX_TOOL_OUTPUT_BYTES } from './registry'
import { createTempWorkspace } from './testing/harness'
import { createWorkspaceFs } from './workspace-fs'
import type { ToolDefinition } from './types'

// Large tool outputs must never reach the model unreduced (docs/03 §5: result
// truncation is a wrapper stage, not a tool decision).

const bigOutputTool: ToolDefinition = {
  name: 'big_output',
  description: 'test-only tool that returns an oversized result',
  access: 'read',
  inputSchema: z.object({}),
  pathFields: [],
  risk: () => ({ level: 0, reason: 'test' }),
  describe: () => ({ title: 'Big output', group: 'test' }),
  execute: async () => ({ ok: true, output: { blob: 'x'.repeat(MAX_TOOL_OUTPUT_BYTES + 1) } })
}

describe('wrapper — result truncation', () => {
  it('reduces oversized results to a truncation marker', async () => {
    const ws = createTempWorkspace()
    try {
      const registry = createToolRegistry()
      registry.define(bigOutputTool)
      const outcome = await registry.run({
        tool: 'big_output',
        args: {},
        ctx: {
          workspaceRoot: ws.root,
          exists: () => false,
          snapshot: () => undefined,
          requestApproval: async () => 'approve',
          fs: createWorkspaceFs(ws.root)
        }
      })
      expect(outcome.ok).toBe(true)
      expect(outcome.result).toMatchObject({ truncated: true })
      expect((outcome.result as { size: number }).size).toBeGreaterThan(MAX_TOOL_OUTPUT_BYTES)
    } finally {
      ws.cleanup()
    }
  })

  it('passes small results through untruncated', async () => {
    const ws = createTempWorkspace()
    try {
      const registry = createToolRegistry()
      const smallTool: ToolDefinition = {
        name: 'small_output',
        description: 'test-only',
        access: 'read',
        inputSchema: z.object({}),
        pathFields: [],
        risk: () => ({ level: 0, reason: 'test' }),
        describe: () => ({ title: 'Small', group: 'test' }),
        execute: async () => ({ ok: true, output: { answer: 42 } })
      }
      registry.define(smallTool)
      const outcome = await registry.run({
        tool: 'small_output',
        args: {},
        ctx: {
          workspaceRoot: ws.root,
          exists: () => false,
          snapshot: () => undefined,
          requestApproval: async () => 'approve',
          fs: createWorkspaceFs(ws.root)
        }
      })
      expect(outcome.result).toEqual({ answer: 42 })
    } finally {
      ws.cleanup()
    }
  })
})
