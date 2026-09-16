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
          requestUserAnswer: async () => '',
          fs: createWorkspaceFs(ws.root)
        }
      })
      expect(outcome.ok).toBe(true)
      // The wrapper envelope uses `outputTruncated` — never the domain-level
      // `truncated` key (Phase-1 item 1: the shared key dropped honest partial
      // results at the AI SDK boundary).
      expect(outcome.result).toMatchObject({ outputTruncated: true })
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
          requestUserAnswer: async () => '',
          fs: createWorkspaceFs(ws.root)
        }
      })
      expect(outcome.result).toEqual({ answer: 42 })
    } finally {
      ws.cleanup()
    }
  })

  it('keeps a tool-level truncated flag with its content at the AI SDK boundary', async () => {
    // Phase-1 item 1 collision: honest partial output (e.g. a capped ranking
    // with `truncated: true`) must reach the model intact — only the wrapper's
    // `outputTruncated` envelope becomes the short notice shape.
    const ws = createTempWorkspace()
    try {
      const registry = createToolRegistry()
      const partialTool: ToolDefinition = {
        name: 'partial_output',
        description: 'test-only',
        access: 'read',
        inputSchema: z.object({}),
        pathFields: [],
        risk: () => ({ level: 0, reason: 'test' }),
        describe: () => ({ title: 'Partial', group: 'test' }),
        execute: async () => ({
          ok: true,
          output: { query: 'acme', results: [{ title: 'Hit' }], truncated: true }
        })
      }
      registry.define(partialTool)
      const ctx = {
        workspaceRoot: ws.root,
        exists: () => false,
        snapshot: () => undefined,
        requestApproval: async () => 'approve' as const,
        requestUserAnswer: async () => '',
        fs: createWorkspaceFs(ws.root)
      }
      const wrapped = registry.toAiSdkTool('partial_output', ctx)
      if (!wrapped) throw new Error('expected wrapped tool')
      const seen = (await (
        wrapped as unknown as {
          execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown>
        }
      ).execute({}, { toolCallId: 't-partial' })) as Record<string, unknown>
      expect(seen).toMatchObject({
        query: 'acme',
        results: [{ title: 'Hit' }],
        truncated: true
      })
      expect(seen).not.toHaveProperty('outputTruncated')
    } finally {
      ws.cleanup()
    }
  })
})
