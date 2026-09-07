import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createHandlerHarness, createTempWorkspace } from './testing/harness'
import type { ToolDefinition } from './types'

// The bridge between the registry wrapper and the AI SDK: `toAiSdkTools(ctx)`
// returns a `Record<string, Tool>` that `streamText({ tools })` consumes.
// The critical contract is that the bridge calls `registry.run(...)` per
// call, so the same validate → sandbox → risk → approval-hook → snapshot →
// execute → truncate order runs in the loop exactly as in the unit tests.

describe('toAiSdkTools — AI SDK bridge', () => {
  it('produces an AI-SDK-shaped ToolSet for every defined tool', () => {
    const ws = createTempWorkspace()
    try {
      const harness = createHandlerHarness(ws.root)
      const greet: ToolDefinition<{ name: string }, { greeting: string }> = {
        name: 'greet',
        description: 'Say hello',
        access: 'read',
        inputSchema: z.object({ name: z.string().min(1) }),
        pathFields: [],
        risk: () => ({ level: 0, reason: 'Read-only' }),
        describe: (input) => ({ title: `Greet ${input.name}`, group: 'chat' }),
        execute: async (input) => ({
          ok: true,
          output: { greeting: `hello ${input.name}` }
        })
      }
      harness.registry.define(greet)
      const tools = harness.registry.toAiSdkTools(harness.ctx)
      expect(Object.keys(tools)).toEqual(['greet'])
      const t = tools.greet as { description?: string; execute?: unknown; inputSchema?: unknown }
      expect(t.description).toBe('Say hello')
      expect(typeof t.execute).toBe('function')
      expect(t.inputSchema).toBeDefined()
    } finally {
      ws.cleanup()
    }
  })

  it('routes execute() through the wrapper — schema rejection short-circuits', async () => {
    const ws = createTempWorkspace()
    try {
      const harness = createHandlerHarness(ws.root)
      harness.registry.define({
        name: 'strict',
        description: 'refuses empty input',
        access: 'read',
        inputSchema: z.object({ name: z.string().min(2) }),
        pathFields: [],
        risk: () => ({ level: 0, reason: 'Read-only' }),
        describe: () => ({ title: 'Strict', group: 'chat' }),
        execute: async (input) => ({ ok: true, output: { ok: input.name } })
      })
      const tools = harness.registry.toAiSdkTools(harness.ctx)
      const tool = tools.strict as unknown as {
        execute: (input: unknown, opts: { toolCallId: string }) => Promise<unknown>
      }
      await expect(tool.execute({ name: 'a' }, { toolCallId: 't-1' })).rejects.toThrow(/not right/i)
      expect(harness.stages.order).toEqual([]) // schema rejection → no other stage
    } finally {
      ws.cleanup()
    }
  })

  it('routes execute() through the wrapper — happy path calls execute with the parsed input', async () => {
    const ws = createTempWorkspace()
    try {
      const harness = createHandlerHarness(ws.root)
      let received: { name: string; toolCallId: string } | null = null
      harness.registry.define({
        name: 'echo',
        description: 'echoes',
        access: 'read',
        inputSchema: z.object({ name: z.string() }),
        pathFields: [],
        risk: () => ({ level: 0, reason: 'Read-only' }),
        describe: () => ({ title: 'Echo', group: 'chat' }),
        execute: async (input, ctx) => {
          received = { name: input.name, toolCallId: ctx.activeToolCallId ?? '' }
          return { ok: true, output: { name: input.name } }
        }
      })
      const tools = harness.registry.toAiSdkTools(harness.ctx)
      const tool = tools.echo as unknown as {
        execute: (input: unknown, opts: { toolCallId: string }) => Promise<unknown>
      }
      const out = await tool.execute({ name: 'hi' }, { toolCallId: 't-2' })
      expect(out).toEqual({ name: 'hi' })
      expect(received).toEqual({ name: 'hi', toolCallId: 't-2' })
    } finally {
      ws.cleanup()
    }
  })

  it('rejects an unknown tool id with the same refusal shape the registry uses', async () => {
    const ws = createTempWorkspace()
    try {
      const harness = createHandlerHarness(ws.root)
      const tools = harness.registry.toAiSdkTools(harness.ctx)
      // The bridge only includes defined tools; an unknown id never enters
      // the bridge (the AI SDK's streamText handles that). The pure-registry
      // path remains a refused outcome — assert the type.
      const outcome = await harness.registry.run({
        tool: 'nope',
        args: {},
        ctx: harness.ctx
      })
      expect(outcome.status).toBe('refused')
      expect(outcome.message).toContain('nope')
      expect(Object.keys(tools)).toEqual([])
    } finally {
      ws.cleanup()
    }
  })
})
