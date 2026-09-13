// LIVE agent-loop probe (2026-09-13, dev tool): runs the REAL runActTurn and
// runPlanModeTurn against the user's REAL configured provider+key (Ollama
// gpt-oss:120b by default) to verify the core contract:
//   - Act mode executes normally (steps taken, file lands).
//   - Plan mode only reads and produces a plan (never executes).
// The key is handed over via a transient TSV from scripts/unseal-live-keys.cjs
// (docs/06 §7: never committed, never logged, deleted after reading).
// Skipped without the TSV, so the default gate never needs a key.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stepCountIs, streamText } from 'ai'
import { createToolRegistry } from './registry'
import { buildRunContext } from './context'
import { buildSystemPrompt } from '../ipc/system-prompt'
import { buildLanguageModel } from '../providers'
import { runActTurn, runPlanModeTurn } from './plan-run'
import {
  askUserTool,
  copyPathTool,
  createDirTool,
  deletePathTool,
  editFileTool,
  emitPlanTool,
  listDirTool,
  movePathTool,
  readDocumentTool,
  readFileTool,
  searchFilesTool,
  webFetchTool,
  webSearchTool,
  writeFileTool
} from './index'
import type { PlanStep } from './tools/emit_plan'

const KEYS_TSV = process.env.AGENTO_LIVE_KEYS_TSV ?? join(tmpdir(), 'agento-live-keys.tsv')
const DEFAULT_PROVIDER = process.env.AGENTO_LIVE_PROVIDER ?? 'ollama'
const DEFAULT_MODEL = process.env.AGENTO_LIVE_MODEL ?? 'gpt-oss:120b'
const CLEANUP = process.env.AGENTO_LIVE_KEEP !== '1'

function loadKeys(): { id: string; key: string }[] {
  try {
    return readFileSync(KEYS_TSV, 'utf-8')
      .split(/[\r\n]+/)
      .filter((line) => line.includes('\t') && line.trim() !== '')
      .map((line) => {
        const [id, key] = line.split('\t')
        return { id, key }
      })
  } catch {
    return []
  }
}

function buildRegistry(): ReturnType<typeof createToolRegistry> {
  const registry = createToolRegistry()
  registry.define(listDirTool)
  registry.define(readFileTool)
  registry.define(readDocumentTool)
  registry.define(searchFilesTool)
  registry.define(webFetchTool)
  registry.define(webSearchTool)
  registry.define(askUserTool)
  registry.define(emitPlanTool)
  registry.define(writeFileTool)
  registry.define(createDirTool)
  registry.define(editFileTool)
  registry.define(movePathTool)
  registry.define(copyPathTool)
  registry.define(deletePathTool)
  return registry
}

function buildWriteOnlyRegistry(): ReturnType<typeof createToolRegistry> {
  const reg = createToolRegistry()
  reg.define(emitPlanTool)
  reg.define(writeFileTool)
  reg.define(createDirTool)
  reg.define(editFileTool)
  reg.define(movePathTool)
  reg.define(copyPathTool)
  reg.define(deletePathTool)
  return reg
}

const rows = loadKeys()
const hasLiveKey = rows.some((r) => r.id === DEFAULT_PROVIDER)
const registry = buildRegistry()

function textMessage(
  text: string
): { id: string; role: 'user'; parts: { type: 'text'; text: string }[] }[] {
  return [{ id: 'live-user', role: 'user' as const, parts: [{ type: 'text' as const, text }] }]
}
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agento-live-ws-'))
  writeFileSync(join(dir, 'seed.txt'), 'seed content\n', 'utf-8')
  return dir
}
function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
function cleanupWorkspace(dir: string): void {
  if (CLEANUP && dir) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort: a leftover temp workspace is harmless.
    }
  }
}

describe.skipIf(!hasLiveKey)('LIVE agent loop (real provider, docs/03 §2 contract)', () => {
  const model = hasLiveKey
    ? buildLanguageModel({
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        apiKey: rows.find((r) => r.id === DEFAULT_PROVIDER)?.key
      })
    : null

  it('ACT mode executes: file lands in the workspace', { timeout: 420_000 }, async () => {
    const ws = makeWorkspace()
    try {
      const { ctx } = buildRunContext({
        sender: { emit: () => {} },
        sessionId: 'live-act',
        runId: 'live-act-run',
        workspaceRoot: ws
      })
      const parts: string[] = []
      const outcome = await runActTurn({
        model: model!,
        system: buildSystemPrompt(ws),
        messages: textMessage(
          'create a text file named live-probe.txt in the workspace root with the content: hello from the live probe 123'
        ),
        registry,
        ctx,
        sendPart: (part) => parts.push(part.type),
        signal: AbortSignal.timeout(360_000)
      })
      const files = listFiles(ws)
      const firstPart = outcome.assistantMessage?.parts[0] as { text?: string } | undefined
      console.log(
        `[live] ACT steps=${outcome.stepsTaken} aborted=${outcome.aborted} parts=${parts.join(',')} msg=${firstPart?.text?.slice(0, 300) ?? ''}`
      )
      console.log(`[live] ACT workspace files after=${JSON.stringify(files)}`)
      expect(outcome.stepsTaken).toBeGreaterThan(0)
      expect(files.some((f) => f.startsWith('live-probe'))).toBe(true)
    } finally {
      cleanupWorkspace(ws)
    }
  })

  it('PLAN mode is read-only: plan emitted, no file created', { timeout: 420_000 }, async () => {
    const ws = makeWorkspace()
    const before = listFiles(ws)
    const plans: PlanStep[][] = []
    try {
      const run = async (reg: ReturnType<typeof buildRegistry>): Promise<unknown> => {
        const { ctx } = buildRunContext({
          sender: { emit: () => {} },
          sessionId: 'live-plan',
          runId: `live-plan-${Date.now()}-${Math.random()}`,
          workspaceRoot: ws
        })
        const parts: string[] = []
        const outcome = await runPlanModeTurn({
          model: model!,
          system: buildSystemPrompt(ws),
          messages: textMessage(
            'make a text file named live-probe-plan.txt in the workspace root containing: plan probe 456'
          ),
          registry: reg,
          ctx,
          sendPart: (part) =>
            parts.push(part.type === 'error' ? `error:${part.errorText}` : part.type),
          onPlanCreated: (steps) => plans.push(steps),
          signal: AbortSignal.timeout(360_000)
        })
        const firstPart = outcome.assistantMessage?.parts[0] as { text?: string } | undefined
        return {
          emitted: outcome.planEmitted,
          steps: outcome.stepsTaken,
          parts: parts.join(','),
          msg: firstPart?.text?.slice(0, 200) ?? null
        }
      }
      const fullReg = (await run(registry)) as { emitted: boolean; parts: string }
      const writeOnlyReg = (await run(buildWriteOnlyRegistry())) as {
        emitted: boolean
        parts: string
      }
      const after = listFiles(ws)
      console.log(
        `[live] PLAN fullRegistry=${JSON.stringify(fullReg)} writeOnlyRegistry=${JSON.stringify(writeOnlyReg)}`
      )
      console.log(
        `[live] PLAN workspace before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
      )
      expect(fullReg.emitted).toBe(true)
      expect(writeOnlyReg.emitted).toBe(true)
      expect(plans.length).toBeGreaterThan(0)
      expect(plans.every((p) => p.length > 0)).toBe(true)
      expect(after).toEqual(before)
    } finally {
      cleanupWorkspace(ws)
    }
  })

  it(
    'PLAN diagnostics: raw provider behavior for forced tool choice vs text recovery',
    { timeout: 420_000 },
    async () => {
      const { ctx: diagCtx } = buildRunContext({
        sender: { emit: () => {} },
        sessionId: 'live-diag',
        runId: 'live-diag-run',
        workspaceRoot: makeWorkspace()
      })
      const planTool = registry.toAiSdkTool('emit_plan', diagCtx, {})
      const sys = buildSystemPrompt(makeWorkspace())
      const msgs = [
        {
          role: 'user' as const,
          content:
            'make a text file named live-probe-plan.txt in the workspace root containing: plan probe 456'
        }
      ]
      const collect = async (label: string, opts: Record<string, unknown>): Promise<unknown> => {
        try {
          const result = streamText({
            model: model!,
            system: sys,
            messages: msgs,
            abortSignal: AbortSignal.timeout(120_000),
            ...opts
          })
          const parts: string[] = []
          let text = ''
          let finish = ''
          let toolCalls: { name: string; inputPreview: unknown }[] = []
          try {
            for await (const part of result.toUIMessageStream({ onError: (e) => String(e) })) {
              parts.push(part.type)
              if (part.type === 'text-delta') text += part.delta
              if (part.type === 'finish') finish = part.finishReason ?? ''
            }
            toolCalls = await result.steps.then(
              (steps) =>
                steps.flatMap((s) =>
                  s.toolCalls.map((tc) => ({
                    name: tc.toolName,
                    inputPreview: typeof tc.input === 'string' ? tc.input.slice(0, 120) : tc.input
                  }))
                ),
              () => []
            )
          } catch (e) {
            parts.push(`THREW:${String(e)}`)
          }
          return {
            label,
            parts: parts.slice(0, 14),
            text: text.slice(0, 400),
            finish,
            toolCalls
          }
        } catch (e) {
          return { label, outerError: String(e) }
        }
      }

      const forced = await collect('forced-tool-choice', {
        tools: { emit_plan: planTool! },
        toolChoice: { type: 'tool', toolName: 'emit_plan' },
        stopWhen: [stepCountIs(1)]
      })
      const auto = await collect('auto-single-tool', {
        tools: { emit_plan: planTool! },
        toolChoice: 'auto',
        system: `${sys}\nFirst, respond ONLY by calling the emit_plan tool with the step-by-step plan.`
      })
      const extract = await collect('extraction-no-tools', {
        system: `${sys}\nOutput ONLY a JSON object of the plan, exactly this shape: {"steps":[{"id":"1","description":"<plain-language step>","tool":"<tool name>","riskLevel":0,"requiresApproval":false}]}. No prose, no code fences, no other keys.`
      })
      console.log(
        `[live] DIAG forced=${JSON.stringify(forced)} auto=${JSON.stringify(auto)} extract=${JSON.stringify(extract)}`
      )
    }
  )
})
