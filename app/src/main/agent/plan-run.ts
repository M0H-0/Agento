import { APICallError, RetryError, stepCountIs, streamText } from 'ai'
import type { LanguageModel, LanguageModelUsage, ModelMessage, UIMessage, UIMessageChunk } from 'ai'
import { convertToModelMessages } from 'ai'
import { AssistantMessageAccumulator } from './assistant-accumulator'
import { stripStepReasoning } from './prepare-step'
import { createThinkStripper, thinkTailParts } from './think-strip'
import { ToolFailureError } from './registry'
import type { ToolRegistry } from './registry'
import type { ToolExecutionContext } from './types'
import { planStepsSchema } from './tools/emit_plan'
import type { PlanStep } from './tools/emit_plan'

// The two-phase run loop (docs/03 §2, M3.1) — extracted from ipc/chat.ts so
// the loop lives in the plain-Node agent tree (deps injected, no Electron,
// AGENTS.md rule 1) and chat.ts becomes a thin IPC adapter.
//
// Phase 1 — PLAN (mechanism proven by plan-mechanism.spike.test.ts on the
// pinned ai@5.0.250): streamText with ONLY the emit_plan tool available and
// `toolChoice: { type: 'tool', toolName: 'emit_plan' }` + `stepCountIs(1)` —
// plan-first is structural, not prompted (the model cannot call anything
// else). When the plan call lands: onPlanCreated (the adapter persists
// plan_steps rows + emits `plan/created`), then the loop BLOCKS on the
// plan-start promise — execution starts only when the user presses Start
// (or replies "go ahead"; the renderer calls `plan/start` for both).
//
// Phase 2 — EXECUTE: streamText with the FULL registry tool set, fed the
// original conversation PLUS the plan phase's own response messages (so the
// model keeps its plan in context), with the same streaming / abort /
// step-guard / usage handling chat.ts has always run (extracted, not
// rewritten).
//
// `emit_plan` tool parts are dropped from the chat:part stream: the plan's
// user-facing surface is the PlanPanel (docs/04 §3.3), not a thread tool
// card — a raw JSON args card in the thread would violate the plain-language
// copy rules (docs/04 §3.1). The recorded plan/created event is the wire the
// panel reads.

/** Default step guard carried over from chat.ts (docs/03 §2). */
const MAX_STEPS = 25

// docs/04 §5 copy rules: provider failures never surface as raw codes or
// stack traces. Google signals a rejected key as 400 INVALID_ARGUMENT
// ("API key not valid"), so 401-class detection also matches that shape.
const KEY_REJECTED_COPY =
  "The API key for this provider isn't working. Check it in Settings → Providers."
const RATE_LIMITED_COPY = "The model is rate-limiting us. I'll wait a moment and retry."
// M3.8 copy classification: a 400 in the plan phase is almost always the
// provider refusing the forced tool choice (Groq gpt-oss-120b live:
// `tool_use_failed`) — "check your connection" would be a flat-out lie for
// it, so the plan phase maps non-key 400s to an honest plan-specific copy.
const PLAN_REFUSED_COPY = "I couldn't create a plan for that. Try rephrasing the request."
// A mutating request with no usable plan is an honest refusal, never a
// silent unplanned mutation (docs/04 §5 copy rules — plain language). Shared
// by the legacy plan-first path and the explicit Plan mode turn.
const PLAN_FAILED_COPY =
  "I couldn't make a plan for that request, so I didn't change anything. Try rephrasing it."
const GENERIC_PROVIDER_COPY =
  'Something went wrong talking to the model provider. Check your connection and try again.'

// M3.8 diagnosability: friendlyProviderError used to classify and then
// discard the raw error, so any confusing user-facing copy was impossible to
// trace (PROGRESS Devlog 2026-09-11). Log the status + provider message +
// response body to the main-process console only — the RESPONSE headers carry
// the API key and requestBodyValues may echo conversation content, so neither
// ever gets logged. A provider's responseBody is its own payload. Logging is
// wrapped: it is diagnostic-only and must never break the run.
function logProviderError(cause: APICallError): void {
  try {
    console.error(
      `[provider] ${cause.statusCode ?? 'unknown'}: ${cause.message}` +
        (cause.responseBody ? ` body=${cause.responseBody}` : '')
    )
  } catch {
    // Diagnostic only — never throw into the stream path.
  }
}

// Heuristic: does the user's request look like it wants files changed?
// Used ONLY to choose honest copy when planning fails (a text-only reply to
// "make a txt file" would look like the run silently stopped). Never a safety
// gate — mutations still require a valid plan + wrapper snapshot + approval.
// Arabic (2026-09-16): the same heuristic applies to Arabic requests —
// `\b` word boundaries do not match Arabic script, so Arabic verbs/markers
// are plain-substring matched. Summary-only words (لخص/ملخص) stay out on both
// sides: a pure summary is Q&A, not a mutation (mirrors English, where
// "summarize" is not a verb here).
const AR_VERBS = [
  'رتب',
  'نظم',
  'تنظيم',
  'ترتيب',
  'انشئ',
  'أنشئ',
  'انشاء',
  'إنشاء',
  'اكتب',
  'كتابة',
  'احذف',
  'حذف',
  'امسح',
  'مسح',
  'انقل',
  'نقل',
  'انسخ',
  'نسخ',
  'حول',
  'تحويل',
  'صنف',
  'تصنيف',
  'فرز',
  'ادمج',
  'دمج',
  'عدل',
  'تعديل',
  'تحديث',
  'احفظ',
  'حفظ',
  'أضف',
  'اضف',
  'إضافة',
  'اضافة',
  'نظف',
  'تنظيف',
  'استخرج',
  'استخراج'
]
const AR_MARKERS = [
  'ملف',
  'ملفات',
  'مجلد',
  'مجلدات',
  'مستند',
  'مستندات',
  'وثيقة',
  'وثائق',
  'تقرير',
  'تقارير',
  'التنزيلات',
  'تنزيلات',
  'التحميلات',
  'تحميلات',
  'التسعير',
  'تسعير',
  'سعر',
  'أسعار',
  'اسعار',
  'صورة',
  'صور',
  'فيديو',
  'نصوص'
]
export function isLikelyMutatingRequest(text: string): boolean {
  const lower = text.toLowerCase()
  const verbs =
    /\b(create|make|write|add|save|generate|update|edit|change|fix|move|copy|rename|delete|remove|organize|organise|tidy|sort|arrange|convert|merge|split|extract|backup)\b/
  const markers =
    /\b(file|files|folder|folders|directory|directories|note|notes|document|report|downloads|txt|text file|pdfs?|csvs?|docx?|pptx?|xlsx?)\b|\.txt\b|\.md\b|\.docx\b|\.pdf\b/
  if (verbs.test(lower) && markers.test(lower)) return true
  // Strip tashkeel/tatweel so رتّب matches رتب.
  const ar = text.replace(/[\u064B-\u0653\u0670\u0640]/g, '')
  const hasArVerb = AR_VERBS.some((v) => ar.includes(v))
  if (!hasArVerb) return false
  return AR_MARKERS.some((m) => ar.includes(m))
}

// Deterministic fallback plan (2026-09-13): providers that refuse the forced
// emit_plan call (Ollama gpt-oss:120b live: "make a plan to make a txt and
// docx and pdf file of a fish story" → PLAN_FAILED_COPY) must not leave Plan
// mode with no plan for an obvious document request. When the text asks to
// CREATE a document (creation verb + named target), synthesize the same
// write-then-convert steps the Act loop would take — write the source text
// first, then convert to each other format. Organize/move/sort requests never
// take this path even when they mention "PDF" — they go through normal
// planning instead of a fake "Create the .pdf file" step.
// Structural safety is unchanged: the fallback only *proposes* steps for the
// panel; execution still requires approval + wrapper snapshot per tool.
export function buildFallbackDocumentPlan(text: string): PlanStep[] | null {
  const lower = text.toLowerCase()
  if (!isLikelyMutatingRequest(text)) return null
  // Creation-only gate (2026-09-13 fix): a bare mention of "PDF"/"docx"/...
  // is not intent to CREATE one. "move every PDF into Finance" must never
  // synthesize "Create the .pdf file". Only fire on creation verbs, and never
  // when organization verbs are present (those go through normal planning).
  // Arabic (2026-09-16): same gates, substring-matched (no \b for Arabic),
  // tashkeel-stripped like the heuristic above.
  const arLower = text.replace(/[\u064B-\u0653\u0670\u0640]/g, '')
  const hasCreation =
    /\b(create|make|write|generate|save|draft|convert)\b/.test(lower) ||
    ['انشئ', 'أنشئ', 'انشاء', 'إنشاء', 'اكتب', 'احفظ', 'حول', 'أضف', 'اضف'].some((v) =>
      arLower.includes(v)
    )
  if (!hasCreation) return null
  const hasOrganize =
    /\b(move|copy|rename|organize|organise|tidy|sort|arrange|backup|delete|remove)\b/.test(lower) ||
    ['رتب', 'نظم', 'صنف', 'انقل', 'انسخ', 'احذف', 'امسح', 'فرز', 'نظف'].some((v) =>
      arLower.includes(v)
    )
  if (hasOrganize) return null
  const wantsTxt = /\btxt\b|\.txt\b|text file/.test(lower)
  const wantsMd = /\bmd\b|\.md\b|markdown/.test(lower)
  const wantsDocx = /\bdocx?\b|\.docx\b/.test(lower)
  const wantsPdf = /\bpdfs?\b|\.pdf\b/.test(lower)
  const targets = [
    ...(wantsTxt ? (['txt'] as const) : []),
    ...(wantsMd ? (['md'] as const) : []),
    ...(wantsDocx ? (['docx'] as const) : []),
    ...(wantsPdf ? (['pdf'] as const) : [])
  ]
  if (targets.length === 0) return null
  // Source is the plain-text format when requested, else the first target.
  const source: 'txt' | 'md' | 'docx' | 'pdf' = wantsTxt ? 'txt' : wantsMd ? 'md' : targets[0]
  const topic = 'the requested content'
  const steps: PlanStep[] = [
    {
      id: '1',
      description:
        source === 'txt' || source === 'md'
          ? `Write ${topic} to a .${source} file`
          : `Create the .${source} file with ${topic}`,
      tool: source === 'docx' ? 'create_document' : 'write_file',
      riskLevel: 1,
      requiresApproval: false
    }
  ]
  let id = 2
  for (const target of targets) {
    if (target === source) continue
    steps.push({
      id: String(id++),
      description: `Convert it to .${target}`,
      tool: 'convert_document',
      riskLevel: 1,
      requiresApproval: false
    })
  }
  return steps
}

export interface DiscoveryListing {
  entries: { name: string; type: 'file' | 'directory' }[]
}

// Entry validation shared by the live stash and the history scan —
// listings are validated, never trusted blind.
function validListingEntries(raw: unknown): DiscoveryListing['entries'] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const e = entry as { name?: unknown; type?: unknown }
    return typeof e.name === 'string' && (e.type === 'file' || e.type === 'directory')
      ? [{ name: e.name, type: e.type }]
      : []
  })
}

// Conversation-history listings (2026-09-16): the organize fallback must
// also fire when THIS run listed nothing — live, the previous turn had
// already listed the folder (persisted `tool-list_dir` part), so the model
// skipped tools, only talked, and the fallback found no grounding. History
// parts persist in the `tool-${name}` shape with `state` + `output`.
// Freshest listing first; current-run listings stay ahead of these.
export function historyListings(messages: UIMessage[]): DiscoveryListing[] {
  const found: DiscoveryListing[] = []
  for (const message of messages) {
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (typeof part !== 'object' || part === null) continue
      const p = part as { type?: unknown; state?: unknown; output?: unknown }
      if (p.type !== 'tool-list_dir' || p.state !== 'output-available') continue
      const output = p.output as { entries?: unknown } | null
      const entries = output ? validListingEntries(output.entries) : []
      if (entries.length > 0) found.push({ entries })
    }
  }
  return found.reverse()
}

// Extension → folder bucket for the organize fallback (by file TYPE, never by
// language or name script — an earlier model plan over-cleverly proposed "an
// Arabic folder"). Buckets stay small and predictable for messy folders.
const ORGANIZE_BUCKETS: { folder: string; exts: string[]; one: string; many: string }[] = [
  { folder: 'PDFs', exts: ['pdf'], one: 'PDF file', many: 'PDF files' },
  { folder: 'Documents', exts: ['doc', 'docx', 'odt', 'rtf'], one: 'document', many: 'documents' },
  {
    folder: 'Spreadsheets',
    exts: ['xls', 'xlsx', 'csv', 'ods'],
    one: 'spreadsheet',
    many: 'spreadsheets'
  },
  {
    folder: 'Presentations',
    exts: ['ppt', 'pptx', 'odp'],
    one: 'presentation',
    many: 'presentations'
  },
  {
    folder: 'Images',
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
    one: 'image',
    many: 'images'
  },
  { folder: 'Videos', exts: ['mp4', 'mov', 'avi', 'mkv'], one: 'video', many: 'videos' },
  { folder: 'Audio', exts: ['mp3', 'wav', 'ogg'], one: 'audio file', many: 'audio files' },
  { folder: 'Text', exts: ['txt', 'md'], one: 'text file', many: 'text files' },
  { folder: 'Archives', exts: ['zip', 'rar', '7z', 'tar', 'gz'], one: 'archive', many: 'archives' }
]

function bucketForFile(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  for (const bucket of ORGANIZE_BUCKETS) {
    if (bucket.exts.includes(ext)) return bucket.folder
  }
  return 'Others'
}

function bucketLabel(folder: string, count: number): string {
  if (folder === 'Others') return count === 1 ? 'remaining file' : 'remaining files'
  const bucket = ORGANIZE_BUCKETS.find((b) => b.folder === folder)
  if (!bucket) return count === 1 ? 'file' : 'files'
  return count === 1 ? bucket.one : bucket.many
}

// Deterministic organize fallback (2026-09-16): the mirror of
// buildFallbackDocumentPlan for the other stereotyped failure — "organize my
// files by type (+ summarize the pricing docs)" recurring as prose-without-a-
// plan on providers that ignore forced tool choice. Grounded in the
// discovery listing the run already produced (one move step per populated
// bucket, counts in the description so batch approval projects honestly),
// plus read + write tail steps when the request also asks for a summary.
// Creation-only doc requests never reach here (no organize verbs); without a
// usable listing it returns null and the honest failure stands.
export function buildFallbackOrganizePlan(
  text: string,
  listings: DiscoveryListing[]
): PlanStep[] | null {
  const lower = text.toLowerCase()
  const ar = text.replace(/[\u064B-\u0653\u0670\u0640]/g, '')
  const hasOrganize =
    /\b(move|copy|rename|organize|organise|tidy|sort|arrange|backup)\b/.test(lower) ||
    ['رتب', 'نظم', 'صنف', 'انقل', 'انسخ', 'فرز', 'نظف'].some((v) => ar.includes(v))
  if (!hasOrganize) return null
  const hasMarkers =
    /\b(file|files|folder|folders|directory|directories|document|downloads|pdfs?|csvs?|docx?|pptx?|xlsx?)\b|\.txt\b|\.md\b|\.docx\b|\.pdf\b/.test(
      lower
    ) || AR_MARKERS.some((m) => ar.includes(m))
  if (!hasMarkers) return null
  // Richest listing wins (the model may have listed subfolders too).
  let best: { name: string; type: string }[] | null = null
  for (const listing of listings) {
    const files = listing.entries.filter((e) => e.type === 'file')
    if (best === null || files.length > best.filter((e) => e.type === 'file').length) {
      best = listing.entries
    }
  }
  const files = (best ?? []).filter((e) => e.type === 'file')
  if (files.length === 0) return null
  const groups = new Map<string, number>()
  for (const file of files) {
    const folder = bucketForFile(file.name)
    groups.set(folder, (groups.get(folder) ?? 0) + 1)
  }
  const folders = [...groups.keys()]
  const steps: PlanStep[] = [
    {
      id: '1',
      description: `Create a folder for each file type: ${folders.join(', ')}`,
      tool: 'create_dir',
      riskLevel: 1,
      requiresApproval: false
    }
  ]
  let id = 2
  for (const [folder, count] of groups) {
    steps.push({
      id: String(id++),
      description: `Move the ${count} ${bucketLabel(folder, count)} into ${folder}`,
      tool: 'move_path',
      riskLevel: 2,
      requiresApproval: true
    })
  }
  const wantsSummary =
    /summar|summary|ملخص|لخص|تلخيص|pricing|التسعير|تسعير|تقرير|تقارير|report/.test(lower) ||
    ['ملخص', 'لخص', 'تلخيص', 'التسعير', 'تسعير', 'تقرير', 'تقارير'].some((v) => ar.includes(v))
  if (wantsSummary) {
    steps.push({
      id: String(id++),
      description: 'Read the pricing documents',
      tool: 'read_file',
      riskLevel: 0,
      requiresApproval: false
    })
    steps.push({
      id: String(id++),
      description: 'Write the short pricing summary to pricing_summary.txt',
      tool: 'write_file',
      riskLevel: 1,
      requiresApproval: false
    })
  }
  return steps
}

// Plan-JSON recovery (2026-09-13): some providers ignore a forced toolChoice
// (Ollama gpt-oss:120b live: both plan attempts come back as plain text —
// no emit_plan call, no error — and Plan mode ended silently with no plan).
// parsePlanJson scans free model text for a balanced JSON object that
// validates against planStepsSchema (same echo family as the renderer's
// stripAskUserJsonEcho); extractPlanSteps makes one final no-tools
// completion ask for ONLY the plan JSON, for providers that never surface
// the tool call at all. Both are best-effort recovery of the SAME structured
// contract — schema validation is unchanged, so a bad plan still never
// reaches the panel.
// Providers drift on emit_plan argument conventions (live Ollama gpt-oss:120b:
// `risk` / `requires_approval` instead of `riskLevel` / `requiresApproval`,
// and the `id` omitted). A plan that names the right steps with the wrong
// key names still reaches the panel: normalize onto the frozen contract
// before Zod validation. A plan that misses steps or text entirely still
// fails validation — this is repair, never invention.
export function normalizePlanSteps(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== 'object') return candidate
  const source = candidate as Record<string, unknown>
  const rawSteps = Array.isArray(candidate)
    ? candidate
    : Array.isArray(source.steps)
      ? source.steps
      : null
  if (rawSteps === null) return candidate
  const steps = rawSteps.map((raw, index) => {
    if (!raw || typeof raw !== 'object') return raw
    const step = raw as Record<string, unknown>
    const id = typeof step.id === 'string' && step.id.trim() !== '' ? step.id : String(index + 1)
    const riskLevel =
      typeof step.riskLevel === 'number'
        ? step.riskLevel
        : typeof step.risk === 'number'
          ? step.risk
          : typeof step.risk_level === 'number'
            ? step.risk_level
            : 0
    // Approval variants must never flatten to false: an explicit true under
    // any known key name stays true (fail-closed on approval intent).
    const requiresApproval =
      step.requiresApproval === true ||
      step.requires_approval === true ||
      step.needsApproval === true ||
      step.needs_approval === true
        ? true
        : typeof step.requiresApproval === 'boolean'
          ? step.requiresApproval
          : typeof step.requires_approval === 'boolean'
            ? step.requires_approval
            : typeof step.needsApproval === 'boolean'
              ? step.needsApproval
              : typeof step.needs_approval === 'boolean'
                ? step.needs_approval
                : false
    return {
      id,
      description: step.description,
      tool: step.tool,
      riskLevel,
      requiresApproval
    }
  })
  return { steps }
}

// Tool-name aliases (2026-09-16): models invent plausible-but-wrong tool
// names in plans (live: make_dir, move_file, final_message on an organize
// request). An unknown name would refuse at execution and never trace to its
// step, so ingest canonicalizes known aliases onto real registry tools —
// panel, tracing, and coalescing then agree. Keys are by-construction never
// real tool names; anything unmapped (final_message — "reply in text") passes
// through untouched and simply never traces.
const PLAN_TOOL_ALIASES: Record<string, string> = {
  make_dir: 'create_dir',
  mkdir: 'create_dir',
  create_folder: 'create_dir',
  make_folder: 'create_dir',
  move_file: 'move_path',
  move_files: 'move_path',
  copy_file: 'copy_path',
  copy_files: 'copy_path',
  delete_file: 'delete_path',
  delete_files: 'delete_path',
  remove_file: 'delete_path',
  create_file: 'write_file',
  make_file: 'write_file',
  new_file: 'write_file',
  list_files: 'list_dir',
  list_folder: 'list_dir',
  read_files: 'read_file',
  search_file: 'search_files'
}

export function canonicalPlanToolName(tool: string): string {
  const key = tool.toLowerCase().replace(/[\s-]+/g, '_')
  return PLAN_TOOL_ALIASES[key] ?? tool
}

export function canonicalizePlanTools(steps: PlanStep[]): PlanStep[] {
  return steps.map((step) => {
    const tool = canonicalPlanToolName(step.tool)
    return tool === step.tool ? step : { ...step, tool }
  })
}

// Thread-visible plan summary (2026-09-16): the PlanPanel is the plan's
// surface, but the thread must always show WHAT was planned and WHAT to do
// next. Exactly one summary is synthesized on EVERY plan success — model
// narration is dropped (it used to arrive as a wall of prose above the
// plan), so the thread is always tool cards + this summary + Act handoff
// (the same shape the document-fallback path already sends).
function planSummaryChunks(steps: PlanStep[], textId: string): UIMessageChunk[] {
  const summary = `Here's my plan:\n${steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}\n\nReview it on the right — switch to Act and say "go ahead" to run it.`
  return [
    { type: 'text-start', id: textId },
    { type: 'text-delta', id: textId, delta: summary },
    { type: 'text-end', id: textId }
  ]
}

export function parsePlanJson(text: string): PlanStep[] | null {
  let start = text.indexOf('{')
  while (start !== -1) {
    let inString = false
    let escaped = false
    let depth = 0
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          let candidate: unknown
          try {
            candidate = JSON.parse(text.slice(start, i + 1))
          } catch {
            break
          }
          const parsed = planStepsSchema.safeParse(normalizePlanSteps(candidate))
          if (parsed.success) return parsed.data.steps
          break
        }
      }
    }
    start = text.indexOf('{', start + 1)
  }
  return null
}

// The extraction pass runs with NO tools — plain completion, so it works on
// providers where forced tool choice itself is the broken part.
const EXTRACT_PLAN_SUFFIX = `\nOutput ONLY a JSON object of the plan, exactly this shape: {"steps":[{"id":"1","description":"<plain-language step>","tool":"<tool name>","riskLevel":0,"requiresApproval":false}]}. No prose, no code fences, no other keys.`

async function extractPlanSteps(
  model: LanguageModel,
  system: string,
  messages: ModelMessage[],
  signal: AbortSignal
): Promise<PlanStep[] | null> {
  try {
    // streamText (not generateText) so the run stays on one code path with
    // the plan attempts and tests can script the pass with a stream mock.
    const result = streamText({
      model,
      system: `${system}${EXTRACT_PLAN_SUFFIX}`,
      messages,
      abortSignal: signal,
      prepareStep: ({ messages: stepMessages }) => ({
        messages: stripStepReasoning(stepMessages)
      })
    })
    return parsePlanJson(await result.text)
  } catch {
    return null
  }
}

// Exported for the plan-run tests (copy classification). `phase: 'plan'`
// narrows the 400 branch: in the plan phase a non-key 400 is the model or
// provider refusing to plan, not a connectivity problem.
export function friendlyProviderError(error: unknown, phase?: 'plan'): string {
  // A tool refusal/failure is not a provider problem: the wrapper already
  // wrote the user-facing sentence (Phase-1 item 1 — live DNS-failed
  // web_fetch wore "Something went wrong talking to the model provider").
  if (error instanceof ToolFailureError) return error.message
  // streamText retries transient failures and surfaces them as a RetryError
  // wrapping the provider's own APICallError — unwrap before classifying, or
  // a rate limit (429) falls through to the generic copy (docs/04 §5).
  const cause = RetryError.isInstance(error) ? error.lastError : error
  if (APICallError.isInstance(cause)) {
    logProviderError(cause)
    const body = `${cause.message} ${cause.responseBody ?? ''}`
    if (cause.statusCode === 401 || cause.statusCode === 403) return KEY_REJECTED_COPY
    if (cause.statusCode === 400 && /api key/i.test(body)) return KEY_REJECTED_COPY
    if (cause.statusCode === 429) return RATE_LIMITED_COPY
    if (phase === 'plan' && cause.statusCode === 400) return PLAN_REFUSED_COPY
  }
  return GENERIC_PROVIDER_COPY
}

export type PlanRunMode = 'plan' | 'act'

/** Affirmative continuations that execute the session's saved plan in Act mode. */
export function isGoAheadMessage(text: string): boolean {
  return /^\s*(go ahead|go-ahead|yes[,\s]+go ahead|execute the plan|carry out the plan|do the plan|start)\s*[.!]*\s*$/i.test(
    text
  )
}

export interface PlanRunDeps {
  model: LanguageModel
  system: string
  messages: UIMessage[]
  registry: ToolRegistry
  ctx: ToolExecutionContext
  /** The run's plan-start gate (context.ts). Resolves { approved } on decision. */
  requestPlanStart?: (stepIds: string[]) => Promise<{ approved: boolean }>
  /** Stream sink — chat.ts wraps webContents.send. */
  sendPart: (part: UIMessageChunk) => void
  /** M2.5 audit sink, threaded into every registry tool wrapper. */
  onOutcome?: Parameters<ToolRegistry['run']>[0]['onOutcome']
  /** Fired once per plan: the adapter persists plan_steps rows and emits
   * `plan/created` (docs/03 §4). */
  onPlanCreated: (steps: PlanStep[]) => void
  /** Abort controller's signal (chat:stop aborts mid-stream). */
  signal: AbortSignal
  maxSteps?: number
  /** M3.5 verification (optional, injected): called once per mutating run
   * after execution settles. Absent → honest "not verified" (M3.7 degraded).
   * `onVerification` carries the badge payload to the adapter. */
  verify?: (input: {
    instructionSegment: string
    stepDescription: string
  }) => Promise<
    | { verdict: 'skipped' }
    | { verdict: 'complete'; score: number }
    | { verdict: 'incomplete'; score: number; missedSegments: string[] }
  >
  onVerification?: (result: {
    stepId: string
    isComplete: boolean
    score: number | null
    missedSegments?: string[]
  }) => void
}

export interface PlanRunOutcome {
  aborted: boolean
  /** True when an 'error' part was already sent inside the loop. */
  terminalSent: boolean
  accumulatorFailed: boolean
  /** The accumulated assistant UIMessage (null when nothing textual arrived). */
  assistantMessage: UIMessage | null
  /** The provider's 'finish' part, held for the settle point (chat.ts). */
  heldFinish: UIMessageChunk | null
  /** Combined plan + execution usage; undefined when nothing resolved. */
  usage: { inputTokens: number | null; outputTokens: number | null } | undefined
  stepsTaken: number
  stepLimitReached: boolean
  /** True when a plan was emitted via onPlanCreated. */
  planEmitted: boolean
  /** True only when the gate approved execution (decline/stop → false). */
  planApproved: boolean
}

// Reasoning parts are model-internal scratch (thinking models like
// openai/gpt-oss-* emit them). The renderer replays the full UIMessage history
// on every send, and OpenAI-compatible providers reject reasoning content on
// input (Groq: "property 'reasoning_content' is unsupported") — reasoning
// never persists either (the accumulator keeps text only). Strip it from
// assistant messages before building model messages.
function replayable(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) =>
    message.role === 'assistant'
      ? { ...message, parts: message.parts.filter((part) => part.type !== 'reasoning') }
      : message
  )
}

// convertToModelMessages is exported by `ai` and takes UIMessage[]. Kept as a
// tiny indirection so the loop's import surface stays explicit.
function convertToModelMessagesSafe(
  messages: UIMessage[]
): ReturnType<typeof convertToModelMessages> {
  return convertToModelMessages(messages)
}

// ask_user rejections and plan-start rejections (both "the run was stopped")
// share this message; a stop that lands on either pause must unwind the
// in-flight step instead of surfacing a provider error.
function isStopRejection(error: unknown): boolean {
  return error instanceof Error && /Run stopped before the user replied\./.test(error.message)
}

function sumUsage(
  a: LanguageModelUsage | undefined,
  b: LanguageModelUsage | undefined
): { inputTokens: number | null; outputTokens: number | null } | undefined {
  if (a === undefined && b === undefined) return undefined
  const pick = (x: number | undefined, y: number | undefined): number | null => {
    const values = [x, y].filter((v): v is number => typeof v === 'number')
    return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) : null
  }
  return {
    inputTokens: pick(a?.inputTokens, b?.inputTokens),
    outputTokens: pick(a?.outputTokens, b?.outputTokens)
  }
}

export async function runPlanFirstTurn(deps: PlanRunDeps): Promise<PlanRunOutcome> {
  const maxSteps = deps.maxSteps ?? MAX_STEPS
  const accumulator = new AssistantMessageAccumulator()
  let heldFinish: UIMessageChunk | null = null
  let aborted = false
  let terminalSent = false
  let stepsTaken = 0
  let stepLimitReached = false
  let capturedUsage: LanguageModelUsage | undefined
  let planUsage: LanguageModelUsage | undefined
  let planEmitted = false
  let planApproved = false
  let planResponseMessages: ModelMessage[] | null = null

  // toolCallIds of emit_plan calls seen on the wire — their input AND output
  // parts are suppressed from the thread (the PlanPanel is the plan's surface).
  const emitPlanCallIds = new Set<string>()

  // Shared stream forwarding (both phases): accumulate for persistence, hold
  // the finish for the settle point, treat error-on-abort as the abort
  // signature, drop streaming tool-input deltas (the append-only argsText
  // invariant — M2.5 gate finding), and drop emit_plan parts (see header).
  // Raw `<think>…</think>` deliberation is stripped from text deltas before
  // either sink sees it — thinking models on OpenAI-compatible providers
  // emit it as text, and it must never reach the thread or persistence.
  // One instance per run, fed in stream order (tags may split across deltas).
  const thinkStrip = createThinkStripper()
  let thinkTailSeq = 0
  // Release a stream-end held fragment (visible text ending in `<…`) through
  // the live sinks — without this the trailing chars would be dropped.
  const flushThinkTailLive = (): void => {
    thinkTailSeq += 1
    const triple = thinkTailParts(`think-tail-${thinkTailSeq}`, thinkStrip.flush())
    if (triple) {
      for (const tailPart of triple) {
        accumulator.addChunk(tailPart)
        deps.sendPart(tailPart)
      }
    }
  }
  //
  // IMPORTANT (M3.1 mechanism finding): the UI stream MUST be consumed to the
  // terminal `finish` with the SAME observable sequence chat.ts used (per-part
  // `await` — no microtask batching tricks). The SDK's `steps`/`response`
  // settlement interleaves with the UI transform: the tool result is not
  // considered settled (and `response.messages` stays unavailable) until the
  // corresponding `tool-output-available` part has been pulled from the UI
  // stream. Slower consumption breaks `planResponseMessages` timing.
  const forwardStream = async (result: {
    toUIMessageStream: (opts: { onError: (e: unknown) => string }) => AsyncIterable<UIMessageChunk>
  }): Promise<void> => {
    for await (const raw of result.toUIMessageStream({ onError: friendlyProviderError })) {
      // Think-tag strip FIRST: raw deliberation must reach neither the
      // accumulator nor the thread. Empty remainders are dropped entirely
      // (text-start/end still flow, rendering nothing on their own).
      let part = raw
      if (raw.type === 'text-delta') {
        const visible = thinkStrip.push(raw.delta)
        if (visible.length === 0) continue
        part = { ...raw, delta: visible }
      }
      accumulator.addChunk(part)
      if (part.type === 'finish') {
        heldFinish = part
        continue
      }
      if (part.type === 'abort') {
        aborted = true
        continue
      }
      if (part.type === 'error' && deps.signal.aborted) {
        // An error chunk arriving on an aborted signal is the abort
        // signature (the onError transform has no context that we stopped
        // this run) — never surface the generic provider copy for it.
        aborted = true
        continue
      }
      if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
      if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
        emitPlanCallIds.add(part.toolCallId)
        continue
      }
      if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) {
        continue
      }
      deps.sendPart(part)
    }
    flushThinkTailLive()
  }

  const baseModelMessages = convertToModelMessagesSafe(replayable(deps.messages))

  try {
    // ── Phase 1: the plan call ─────────────────────────────────────────────
    // Attempt 1 is the forced call (plan-first is structural, not prompted).
    // Attempt 2 is the M3.7 gate-driven fallback: some providers (Groq
    // gpt-oss-120b live) refuse forced tool choice with `tool_use_failed`,
    // so we retry once with `toolChoice: 'auto'` over the SAME single-tool
    // set — the model can only plan or answer in text.
    //
    // M3.8: EVERY plan-phase part is HELD per attempt (text, reasoning, step
    // markers — not just errors) and committed — forwarded to the thread and
    // accumulated for persistence — only for the ONE attempt that resolves
    // the run. A failed attempt's partial text used to stream live AND into
    // the shared accumulator, so when Groq refused the forced call mid
    // preamble the retry's greeting doubled in the bubble and in the reply.
    const emitPlanWrapped = deps.registry.toAiSdkTool('emit_plan', deps.ctx, {
      onOutcome: deps.onOutcome
    })
    interface PlanAttemptResult {
      /** Parsed plan steps — non-null only when the attempt actually planned. */
      steps: PlanStep[] | null
      /** The plan phase's response messages (kept for the execution call). */
      messages: ModelMessage[] | null
      /** Non-tool parts the attempt produced (forwarded only on commit). */
      heldParts: UIMessageChunk[]
      /** The attempt's natural finish (null when it ended without one). */
      finish: UIMessageChunk | null
      /** First held provider-error copy (null when no error part arrived). */
      errorText: string | null
      /** True when the attempt streamed text (a text-only reply is possible). */
      hadText: boolean
    }
    const attemptPlanCall = async (opts: {
      toolChoice: { type: 'tool'; toolName: 'emit_plan' } | 'auto'
      system: string
      tool: NonNullable<typeof emitPlanWrapped>
    }): Promise<PlanAttemptResult> => {
      const heldParts: UIMessageChunk[] = []
      const heldErrors: UIMessageChunk[] = []
      let finish: UIMessageChunk | null = null
      let hadText = false
      let errorText: string | null = null
      const planResult = streamText({
        model: deps.model,
        system: opts.system,
        messages: baseModelMessages,
        tools: { emit_plan: opts.tool },
        toolChoice: opts.toolChoice,
        stopWhen: [stepCountIs(1)],
        abortSignal: deps.signal,
        prepareStep: ({ messages: stepMessages }) => ({
          messages: stripStepReasoning(stepMessages)
        }),
        onAbort: () => {
          aborted = true
        },
        onFinish: (event) => {
          planUsage = event.totalUsage
        }
      })
      try {
        // Same forwarding shape as the shared stream path, but every part is
        // held — error parts and text alike — so the caller can drop the
        // attempt wholesale if it fails and is going to be retried.
        for await (const part of planResult.toUIMessageStream({
          // Plan-phase 400s (the provider refusing the forced tool choice)
          // get the honest plan copy, never "check your connection" (M3.8).
          onError: (error) => friendlyProviderError(error, 'plan')
        })) {
          if (part.type === 'finish') {
            finish = part
            heldFinish = part
            continue
          }
          if (part.type === 'abort') {
            aborted = true
            continue
          }
          if (part.type === 'error' && deps.signal.aborted) {
            aborted = true
            continue
          }
          if (part.type === 'error') {
            heldErrors.push(part)
            continue
          }
          if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
          if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
            emitPlanCallIds.add(part.toolCallId)
            continue
          }
          if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) {
            continue
          }
          if (part.type === 'text-delta') {
            // Think-tag strip: held deliberation must never commit to the
            // thread, persistence, or plan-JSON recovery — and think-only
            // text must not count as a reply (hadText).
            const visible = thinkStrip.push(part.delta)
            if (visible.length === 0) continue
            heldParts.push({ ...part, delta: visible })
            hadText = true
            continue
          }
          if (part.type === 'text-start') hadText = true
          heldParts.push(part)
        }
        // Stream-end held fragment (visible text ending in `<…`) joins the
        // held buffer — dropping it here would lose trailing chars on commit.
        thinkTailSeq += 1
        const tailTriple = thinkTailParts(`think-tail-${thinkTailSeq}`, thinkStrip.flush())
        if (tailTriple) {
          heldParts.push(...tailTriple)
          hadText = true
        }
        // An error part marks the attempt failed; remember its copy for the
        // final failure (a retry that succeeds discards it via the caller).
        const firstError = heldErrors[0]
        if (firstError && firstError.type === 'error') {
          errorText = firstError.errorText
        }
        if (aborted) {
          return { steps: null, messages: null, heldParts, finish, errorText, hadText }
        }
        // Extract the parsed steps from the emit_plan tool call (normalize
        // provider arg-variant names — live gpt-oss ships snake_case).
        const steps = await planResult.steps
        let found: PlanStep[] | null = null
        for (const step of steps) {
          for (const toolCall of step.toolCalls) {
            if (toolCall.toolName !== 'emit_plan') continue
            const parsed = planStepsSchema.safeParse(normalizePlanSteps(toolCall.input))
            if (parsed.success) {
              found = canonicalizePlanTools(parsed.data.steps)
              break
            }
          }
          if (found) break
        }
        if (found) {
          // Keep the plan phase's own messages (the tool call + its result)
          // so the execution phase starts with the plan already in context.
          const messages = (await planResult.response).messages
          return { steps: found, messages, heldParts, finish, errorText, hadText }
        }
        return { steps: null, messages: null, heldParts, finish, errorText, hadText }
      } catch {
        // Provider refusal (e.g. forced-toolChoice 400) or unsettled steps:
        // the attempt produced no plan and its held parts (if any) are dropped
        // — the caller decides whether a final error copy surfaces.
        return { steps: null, messages: null, heldParts, finish, errorText, hadText }
      }
    }
    let planAttempt: PlanAttemptResult | null = null
    if (emitPlanWrapped) {
      // The run's user-facing surface is exactly ONE plan attempt: the one
      // that resolves the run. Its held parts (preamble text, step markers)
      // are committed — forwarded to the thread AND accumulated for
      // persistence — at this point; failed attempts never reach either
      // (M3.8, the doubled-greeting fix).
      const commitAttempt = (attempt: PlanAttemptResult): void => {
        for (const part of attempt.heldParts) {
          accumulator.addChunk(part)
          deps.sendPart(part)
        }
      }
      planAttempt = await attemptPlanCall({
        toolChoice: { type: 'tool', toolName: 'emit_plan' },
        system: deps.system,
        tool: emitPlanWrapped
      })
      if (!planAttempt.steps && !deps.signal.aborted) {
        planAttempt = await attemptPlanCall({
          toolChoice: 'auto',
          system: `${deps.system}\nFirst, respond ONLY by calling the emit_plan tool with the step-by-step plan.`,
          tool: emitPlanWrapped
        })
      }
      if (planAttempt.steps) {
        // The plan landed — commit the attempt and keep its response messages
        // so the execution phase starts with the plan already in context.
        commitAttempt(planAttempt)
        planResponseMessages = planAttempt.messages
      } else if (!deps.signal.aborted) {
        // No plan after both attempts. The plan-first guarantee still holds —
        // nothing below can execute — but what the user SEES must be honest:
        //  - a naturally completed text-only attempt IS a valid reply ("hey"
        //    → the model answers in text; no provider error happened). The
        //    forced attempt's held 400 is discarded, and the reply is
        //    delivered through the normal settle point (persisted + finish).
        //  - a genuine failure (a stream error part, or no natural finish at
        //    all) keeps the honest refusal — now with plan-appropriate copy
        //    for the common non-key 400 (tool_use_failed) instead of a lie
        //    about the connection (M3.8).
        const genuineError = planAttempt.errorText !== null || planAttempt.finish === null
        if (!genuineError && planAttempt.hadText) {
          // A text-only answer to a file-changing request is NOT a valid
          // reply — delivering "Sure!" with no file looks exactly like the
          // run silently stopped. Fail loudly so the user can rephrase/retry.
          const userText = deps.messages
            .filter((m) => m.role === 'user')
            .flatMap((m) => m.parts)
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text: string }).text)
            .join(' ')
          if (isLikelyMutatingRequest(userText)) {
            if (!terminalSent) {
              deps.sendPart({ type: 'error', errorText: PLAN_FAILED_COPY })
              terminalSent = true
            }
            return {
              aborted,
              terminalSent,
              accumulatorFailed: accumulator.isFailed(),
              assistantMessage: accumulator.toUIMessage(),
              heldFinish,
              usage: sumUsage(planUsage, undefined),
              stepsTaken,
              stepLimitReached,
              planEmitted,
              planApproved
            }
          }
          commitAttempt(planAttempt)
          return {
            aborted,
            terminalSent,
            accumulatorFailed: accumulator.isFailed(),
            assistantMessage: accumulator.toUIMessage(),
            heldFinish,
            usage: sumUsage(planUsage, undefined),
            stepsTaken,
            stepLimitReached,
            planEmitted,
            planApproved
          }
        }
        // Gate is `!terminalSent` ONLY (not `!accumulator.isFailed()`): plan
        // attempts HOLD error parts, so a failed accumulator here means the
        // terminal never went out — without this the run ends silent.
        if (!terminalSent) {
          deps.sendPart({ type: 'error', errorText: planAttempt.errorText ?? PLAN_FAILED_COPY })
          terminalSent = true
        }
        return {
          aborted,
          terminalSent,
          accumulatorFailed: accumulator.isFailed(),
          assistantMessage: accumulator.toUIMessage(),
          heldFinish,
          usage: sumUsage(planUsage, undefined),
          stepsTaken,
          stepLimitReached,
          planEmitted,
          planApproved
        }
      }
    }

    const planSteps: PlanStep[] | null = planAttempt ? planAttempt.steps : null
    if (planSteps) {
      planEmitted = true
      deps.onPlanCreated(planSteps)
      // THE GATE (legacy plan-first path only — new Plan mode never blocks
      // and Act mode never plans; both bypass this). Nothing below runs until
      // the user presses Start (or a stop rejects this promise).
      if (deps.requestPlanStart) {
        const decision = await deps.requestPlanStart(planSteps.map((s) => s.id))
        planApproved = decision.approved
      }
    }

    // ── Phase 2: the full-tool execution call ─────────────────────────────
    // Plan-less degradation (no emit_plan tool): run execution unconditionally.
    // Otherwise run only after the gate approved.
    // M3.4 cancel semantics: a 'cancel' approval decision stops the run AFTER
    // the current step (never mid-mutation) via a run-level flag consumed by
    // `stopWhen` at step boundaries. `skip` needs nothing — the SDK continues.
    let cancelled = false
    const ctxWithCancel: ToolExecutionContext = {
      ...deps.ctx,
      requestApproval: async (request) => {
        const decision = await deps.ctx.requestApproval(request)
        if (decision === 'cancel') cancelled = true
        return decision
      }
    }
    // Real tool-call counter for the execution phase: stepsTaken counts
    // provider round-trips, so a prose-only run still advances it — it cannot
    // detect the "narrated the claim, called nothing" failure. Every wrapper
    // outcome (executed/refused/skipped/cancelled) fires onOutcome once, so a
    // refused/skipped call still counts as acting.
    let execCallsMade = 0
    const execOnOutcome: typeof deps.onOutcome = (entry) => {
      execCallsMade += 1
      deps.onOutcome?.(entry)
    }
    const execUserText = deps.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join(' ')
    const expectsExecActions = planApproved || isLikelyMutatingRequest(execUserText)
    if (!planEmitted || planApproved) {
      // M3.7 gate finding: without an explicit handoff the model treats the
      // execution call as "present the plan and ask to proceed" (live run:
      // settled with a text reply, zero tool calls). The gate decision IS the
      // user's reply — append it so the model executes instead of asking.
      const approvalHandoff: ModelMessage[] = planApproved
        ? [
            {
              role: 'user',
              content:
                'Approved — execute the plan now. Start with step 1 and use the file tools; do not ask for confirmation again.'
            }
          ]
        : []
      const baseExecMessages = planResponseMessages
        ? [...baseModelMessages, ...planResponseMessages, ...approvalHandoff]
        : baseModelMessages
      const runExecutionOnce = async (opts: {
        systemSuffix: string
        toolChoice: 'auto' | 'required'
      }): Promise<void> => {
        const executionResult = streamText({
          model: deps.model,
          system: opts.systemSuffix ? `${deps.system}${opts.systemSuffix}` : deps.system,
          messages: baseExecMessages,
          tools: deps.registry.toAiSdkTools(ctxWithCancel, { onOutcome: execOnOutcome }),
          toolChoice: opts.toolChoice,
          abortSignal: deps.signal,
          stopWhen: [stepCountIs(maxSteps), () => cancelled],
          // Every step's provider request is scrubbed of reasoning parts (see
          // stripStepReasoning): without this, step 2+ of any tool turn whose
          // first step reasoned dies on Groq's reasoning_content rejection.
          prepareStep: ({ messages: stepMessages }) => ({
            messages: stripStepReasoning(stepMessages)
          }),
          onAbort: () => {
            aborted = true
          },
          onStepFinish: () => {
            stepsTaken += 1
          },
          onFinish: (event) => {
            // Sum across retries — the second attempt must not discard the
            // first attempt's usage.
            const next = event.totalUsage
            if (capturedUsage === undefined) {
              capturedUsage = next
            } else if (next !== undefined) {
              const inT = (capturedUsage.inputTokens ?? 0) + (next.inputTokens ?? 0)
              const outT = (capturedUsage.outputTokens ?? 0) + (next.outputTokens ?? 0)
              capturedUsage = { ...capturedUsage, inputTokens: inT, outputTokens: outT }
            }
          }
        })
        await forwardStream(executionResult)
      }
      await runExecutionOnce({ systemSuffix: '', toolChoice: 'auto' })
      // Execution retry: some providers answer the approved plan with prose
      // and zero tool calls (looks like "stopped, no file"). Retry once with
      // toolChoice 'required' + an explicit execute-now suffix — the wrapper
      // still guards every call, so forcing *a* tool cannot force a mutation.
      if (planApproved && !aborted && !cancelled && execCallsMade === 0) {
        await runExecutionOnce({
          systemSuffix:
            '\nYou must act now using the file tools to carry out the approved plan. Call the first tool immediately; do not reply in text first.',
          toolChoice: 'required'
        })
      }
      // Zero-action guard: a mutating request that produced no tool calls — even
      // one answered in prose — is a silent failure. End loudly instead of with
      // a success finish, so the user knows nothing changed. A real tool call
      // (executed/refused/skipped/cancelled) already proves the run acted.
      if (expectsExecActions && !aborted && !cancelled && execCallsMade === 0) {
        if (!terminalSent) {
          deps.sendPart({
            type: 'error',
            errorText:
              "I prepared the plan but didn't take any actions, so nothing changed. Try saying which file to create and what to put in it."
          })
          terminalSent = true
        }
      }
      // The step guard's effect: the SDK stops calling tools after the cap,
      // emits a finish part with reason 'tool-calls' or 'length', and never
      // throws. We surface a one-line friendly note so the user can ask
      // "continue" without a separate UI affordance.
      if (!aborted && stepsTaken >= maxSteps) {
        stepLimitReached = true
      }
      // M3.5 verification (one shot + one retry handled by the adapter's
      // injected `verify`; default absent → skipped). The loop emits the
      // badge payload; the adapter persists/emits `verification/finished`.
      // One retry on missed segments: re-invoked by the adapter via a second
      // `verify` call is out of scope for the 1-hour slice — the client
      // contract + skipped-honest path is what the degraded gate needs.
      if (deps.verify && !aborted) {
        try {
          // Current instruction (last user message), not the first in a
          // resumed history — verifying against a stale turn fakes the badge.
          const userMessages = deps.messages.filter((m) => m.role === 'user')
          const lastText = userMessages[userMessages.length - 1]
          const instructionSegment =
            lastText && lastText.parts[0] && lastText.parts[0].type === 'text'
              ? (lastText.parts[0] as { text: string }).text.slice(0, 500)
              : 'run'
          const verdict = await deps.verify({
            instructionSegment,
            stepDescription: 'execution'
          })
          if (verdict.verdict === 'complete') {
            deps.onVerification?.({
              stepId: 'run',
              isComplete: true,
              score: verdict.score
            })
          } else if (verdict.verdict === 'incomplete') {
            // ONE retry: ask the injected verifier once more with the missed
            // segments folded in (the adapter's stub decides); second failure
            // surfaces as a failed step with plain-language missed segments.
            const retry = await deps.verify({
              instructionSegment: `${instructionSegment}\nMissed: ${verdict.missedSegments.join('; ')}`,
              stepDescription: 'execution-retry'
            })
            if (retry.verdict === 'complete') {
              deps.onVerification?.({ stepId: 'run', isComplete: true, score: retry.score })
            } else if (retry.verdict === 'incomplete') {
              deps.onVerification?.({
                stepId: 'run',
                isComplete: false,
                score: retry.score,
                missedSegments: retry.missedSegments
              })
            } else {
              deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
            }
          } else {
            deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
          }
        } catch {
          deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
        }
      }
    }
  } catch (error) {
    if (!aborted && stepsTaken >= maxSteps) stepLimitReached = true
    // ask_user / plan-start rejections (the run was stopped) and other
    // unhandled errors come through here. The provider-error transform
    // handles RetryError/APICallError specifically; anything else gets the
    // generic copy unless we know the run was stopped.
    if (deps.signal.aborted) {
      aborted = true
    } else if (!accumulator.isFailed() && !terminalSent) {
      const message = isStopRejection(error)
        ? 'Stopped before the reply was sent.'
        : friendlyProviderError(error)
      deps.sendPart({ type: 'error', errorText: message })
      terminalSent = true
    }
  }

  return {
    aborted,
    terminalSent,
    accumulatorFailed: accumulator.isFailed(),
    assistantMessage: accumulator.toUIMessage(),
    heldFinish,
    usage: sumUsage(planUsage, capturedUsage),
    stepsTaken,
    stepLimitReached,
    planEmitted,
    planApproved
  }
}

// ── Explicit Plan/Act modes (composer tabs, docs/03 §2) ─────────────────────
// The legacy runPlanFirstTurn above stays as the tested plan-first-with-gate
// path. Production now routes on the session's persisted mode instead:
//
// - Plan mode (runPlanModeTurn): STRUCTURALLY read-only. Discovery exposes
//   only access==='read' tools, then a forced emit_plan call produces the
//   structured plan. Write-access tools are never in any tool set handed to
//   the model, so the model cannot mutate even if prompted. The plan is
//   persisted/emitted via onPlanCreated and the run settles — no plan-start
//   gate exists, so nothing can ever execute from a Plan run.
// - Act mode (runActTurn): direct execution with the full registry MINUS
//   emit_plan. Every mutation still flows through the registry wrapper
//   (validate → sandbox → risk → approval → snapshot → execute), so all
//   trust guarantees hold; there is simply no planning phase.

const MAX_DISCOVERY_STEPS = 3

export interface ModeTurnDeps {
  model: LanguageModel
  system: string
  messages: UIMessage[]
  registry: ToolRegistry
  ctx: ToolExecutionContext
  onOutcome?: Parameters<ToolRegistry['run']>[0]['onOutcome']
  sendPart: (part: UIMessageChunk) => void
  signal: AbortSignal
  maxSteps?: number
  verify?: PlanRunDeps['verify']
  onVerification?: PlanRunDeps['onVerification']
}

// ask_user is a run PAUSE, not a read: in Plan discovery the loop has no
// execution context, so a clarifying question answers nothing the plan can
// use — live it stalled the turn (model asked whether it may "attempt to
// create the file using a write capability"). Plan stays read + plan only.
function readToolNames(registry: ToolRegistry): string[] {
  return registry
    .names()
    .filter(
      (name) => name !== 'emit_plan' && name !== 'ask_user' && registry.get(name)?.access === 'read'
    )
}

export async function runPlanModeTurn(
  deps: ModeTurnDeps & { onPlanCreated: (steps: PlanStep[]) => void }
): Promise<PlanRunOutcome> {
  const maxSteps = deps.maxSteps ?? MAX_STEPS
  const accumulator = new AssistantMessageAccumulator()
  let heldFinish: UIMessageChunk | null = null
  let aborted = false
  let terminalSent = false
  let planUsage: LanguageModelUsage | undefined
  let discoveryUsage: LanguageModelUsage | undefined
  let discoveryMessages: ModelMessage[] = []
  const emitPlanCallIds = new Set<string>()
  // Think-tag strip (one instance per run — tags may split across deltas).
  const thinkStrip = createThinkStripper()
  let thinkTailSeq = 0
  const baseModelMessages = convertToModelMessagesSafe(replayable(deps.messages))

  // Held discovery (2026-09-13 fix): discovery TEXT is buffered and only
  // committed once the plan outcome is known. Streaming prose live caused the
  // reported "answered immediately, then red error" — e.g. "make a txt file
  // with a cat story" streamed the full story in discovery, then the forced
  // emit_plan failed and PLAN_FAILED_COPY landed under it. Holding gives a
  // single outcome: plan (+ summary) on success, answer on Q&A, single error
  // on mutating failure with no orphan prose.
  //
  // Tool parts are NOT held (2026-09-16): discovery is a full second model
  // pass before planning, and holding everything left the thread frozen on
  // "Reading and preparing your plan..." for minutes with zero feedback —
  // the reported "taking too long" on every model. Read-tool cards stream
  // live so the run visibly works (List folder → plan); they are facts, not
  // prose, so a later plan failure never orphans a misleading sentence.
  // (The discovery prompt already forbids writing file/story content.)
  const commitLiveToolPart = (part: UIMessageChunk): boolean => {
    if (
      part.type === 'tool-input-available' ||
      part.type === 'tool-output-available' ||
      part.type === 'tool-output-error'
    ) {
      if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
        emitPlanCallIds.add(part.toolCallId)
        return true
      }
      if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) {
        return true
      }
      accumulator.addChunk(part)
      deps.sendPart(part)
      return true
    }
    return false
  }
  const commitHeld = (parts: UIMessageChunk[]): void => {
    for (const part of parts) {
      accumulator.addChunk(part)
      deps.sendPart(part)
    }
  }
  // Plan-success commit (2026-09-16): when a plan lands, the panel IS the
  // plan — model narration ("I see a mix of PDFs...", "I'll now emit...")
  // is dropped from the thread and exactly one synthesized summary is
  // shown instead (live: the model narrated a full essay before emitting,
  // so the plan arrived under a wall of prose). Tool cards already streamed
  // live and stay. Q&A and failure paths below still commit prose — there
  // the text IS the answer.
  const commitHeldNonText = (parts: UIMessageChunk[]): void => {
    for (const part of parts) {
      if (part.type === 'text-start' || part.type === 'text-delta' || part.type === 'text-end') {
        continue
      }
      accumulator.addChunk(part)
      deps.sendPart(part)
    }
  }
  const commitPlanSummary = (steps: PlanStep[], textId: string): void => {
    for (const part of planSummaryChunks(steps, textId)) {
      accumulator.addChunk(part)
      deps.sendPart(part)
    }
  }
  const userTextForDiscovery = deps.messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join(' ')
  const discoveryMutating = isLikelyMutatingRequest(userTextForDiscovery)
  // Directory listings seen during discovery (2026-09-16): the organize
  // fallback grounds its plan in these instead of inventing folders.
  // Attributed by toolCallId — output parts carry no tool name.
  const discoveryListings: DiscoveryListing[] = []
  const listDirCallIds = new Set<string>()

  try {
    // Discovery: read-only tools only (structurally — write tools are never
    // in this set). Read-tool cards stream live (progress); the text summary
    // stays held until the outcome is known — on plan success it is dropped
    // (the synthesized summary replaces it), on Q&A it IS the answer.
    const discoveryHeld: UIMessageChunk[] = []
    let discoveryError: UIMessageChunk | null = null
    const readNames = readToolNames(deps.registry)
    if (readNames.length > 0 && !deps.signal.aborted) {
      try {
        const discoveryResult = streamText({
          model: deps.model,
          system: `${deps.system}\nYou are in read-only planning mode. Inspect what you need with the available tools, then answer briefly in text (one short sentence): what you found and what you will put in the plan. Do not write file or story content — describe only. Do not claim to change anything.`,
          messages: baseModelMessages,
          tools: deps.registry.toAiSdkTools(
            { ...deps.ctx },
            { onOutcome: deps.onOutcome },
            { include: readNames }
          ),
          toolChoice: 'auto',
          stopWhen: [stepCountIs(Math.min(MAX_DISCOVERY_STEPS, maxSteps))],
          abortSignal: deps.signal,
          prepareStep: ({ messages: stepMessages }) => ({
            messages: stripStepReasoning(stepMessages)
          }),
          onAbort: () => {
            aborted = true
          },
          onFinish: (event) => {
            discoveryUsage = event.totalUsage
          }
        })
        for await (const part of discoveryResult.toUIMessageStream({
          // A discovery failure on a mutating turn is the same refusal class
          // as a plan-phase 400 — never "check your connection" (M3.8).
          onError: (error) => friendlyProviderError(error, discoveryMutating ? 'plan' : undefined)
        })) {
          if (part.type === 'finish') {
            heldFinish = part
            continue
          }
          if (part.type === 'abort') {
            aborted = true
            continue
          }
          if (part.type === 'error' && deps.signal.aborted) {
            aborted = true
            continue
          }
          if (part.type === 'error') {
            discoveryError = part
            continue
          }
          if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
          if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
            emitPlanCallIds.add(part.toolCallId)
            continue
          }
          if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) {
            continue
          }
          // Stash directory listings for the organize fallback (by callId —
          // output parts carry no tool name). Validated, never trusted blind.
          if (part.type === 'tool-input-available' && part.toolName === 'list_dir') {
            listDirCallIds.add(part.toolCallId)
          }
          if (part.type === 'tool-output-available' && listDirCallIds.has(part.toolCallId)) {
            const output = (part as { output?: unknown }).output as {
              entries?: unknown
            } | null
            const entries = output ? validListingEntries(output.entries) : []
            if (entries.length > 0) discoveryListings.push({ entries })
          }
          // Read-tool activity streams live (see commitLiveToolPart above);
          // prose stays held for the single-outcome commit below.
          if (commitLiveToolPart(part)) continue
          if (part.type === 'text-delta') {
            // Think-tag strip: held deliberation never commits to the thread.
            const visible = thinkStrip.push(part.delta)
            if (visible.length === 0) continue
            discoveryHeld.push({ ...part, delta: visible })
            continue
          }
          discoveryHeld.push(part)
        }
        // Stream-end held fragment joins the held buffer like any visible text.
        thinkTailSeq += 1
        const discoveryTail = thinkTailParts(`think-tail-${thinkTailSeq}`, thinkStrip.flush())
        if (discoveryTail) discoveryHeld.push(...discoveryTail)
        if (!aborted && !discoveryError) {
          try {
            discoveryMessages = (await discoveryResult.response).messages
          } catch {
            discoveryMessages = []
          }
        }
      } catch {
        // Discovery is best-effort context — the forced plan attempt below
        // produces the honest outcome (plan or plan-phase error copy).
        if (deps.signal.aborted) aborted = true
      }
    }
    if (deps.signal.aborted || aborted) {
      return {
        aborted: true,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }
    // Discovery is best-effort context, never the verdict: a discovery
    // failure falls through to the forced plan below (live: a flaky provider
    // failed Plan mode before planning even started). The held discovery
    // error only surfaces if the plan also fails to produce anything.

    // Forced plan: ONLY emit_plan is available — the model must plan.
    const emitPlanWrapped = deps.registry.toAiSdkTool('emit_plan', deps.ctx, {
      onOutcome: deps.onOutcome
    })
    if (!emitPlanWrapped) {
      // No plan tool registered: Q&A can still use the held discovery answer;
      // mutating requests get the single honest failure (held summary dropped).
      if (!discoveryMutating && discoveryHeld.length > 0) {
        commitHeld(discoveryHeld)
        return {
          aborted,
          terminalSent,
          accumulatorFailed: accumulator.isFailed(),
          assistantMessage: accumulator.toUIMessage(),
          heldFinish,
          usage: sumUsage(discoveryUsage, planUsage),
          stepsTaken: 0,
          stepLimitReached: false,
          planEmitted: false,
          planApproved: false
        }
      }
      if (!terminalSent) {
        deps.sendPart({ type: 'error', errorText: PLAN_FAILED_COPY })
        terminalSent = true
      }
      return {
        aborted,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }
    const planMessages: ModelMessage[] = [...baseModelMessages, ...discoveryMessages]
    interface HeldAttempt {
      steps: PlanStep[] | null
      heldParts: UIMessageChunk[]
      finish: UIMessageChunk | null
      errorText: string | null
      hadText: boolean
    }
    const attemptPlan = async (opts: {
      toolChoice: { type: 'tool'; toolName: 'emit_plan' } | 'auto'
      systemSuffix: string
    }): Promise<HeldAttempt> => {
      const heldParts: UIMessageChunk[] = []
      const heldErrors: UIMessageChunk[] = []
      let finish: UIMessageChunk | null = null
      let hadText = false
      let errorText: string | null = null
      const planResult = streamText({
        model: deps.model,
        system: opts.systemSuffix ? `${deps.system}${opts.systemSuffix}` : deps.system,
        messages: planMessages,
        tools: { emit_plan: emitPlanWrapped },
        toolChoice: opts.toolChoice,
        stopWhen: [stepCountIs(1)],
        abortSignal: deps.signal,
        prepareStep: ({ messages: stepMessages }) => ({
          messages: stripStepReasoning(stepMessages)
        }),
        onAbort: () => {
          aborted = true
        },
        onFinish: (event) => {
          planUsage = event.totalUsage
        }
      })
      try {
        for await (const part of planResult.toUIMessageStream({
          onError: (error) => friendlyProviderError(error, 'plan')
        })) {
          if (part.type === 'finish') {
            finish = part
            heldFinish = part
            continue
          }
          if (part.type === 'abort') {
            aborted = true
            continue
          }
          if (part.type === 'error' && deps.signal.aborted) {
            aborted = true
            continue
          }
          if (part.type === 'error') {
            heldErrors.push(part)
            continue
          }
          if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
          if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
            emitPlanCallIds.add(part.toolCallId)
            continue
          }
          if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) {
            continue
          }
          if (part.type === 'text-delta') {
            // Think-tag strip: held deliberation must never commit to the
            // thread, persistence, or plan-JSON recovery — and think-only
            // text must not count as a reply (hadText).
            const visible = thinkStrip.push(part.delta)
            if (visible.length === 0) continue
            heldParts.push({ ...part, delta: visible })
            hadText = true
            continue
          }
          if (part.type === 'text-start') hadText = true
          heldParts.push(part)
        }
        // Stream-end held fragment (visible text ending in `<…`) joins the
        // held buffer — dropping it here would lose trailing chars on commit.
        thinkTailSeq += 1
        const planTailTriple = thinkTailParts(`think-tail-${thinkTailSeq}`, thinkStrip.flush())
        if (planTailTriple) {
          heldParts.push(...planTailTriple)
          hadText = true
        }
        const firstError = heldErrors[0]
        if (firstError && firstError.type === 'error') errorText = firstError.errorText
        if (aborted) return { steps: null, heldParts, finish, errorText, hadText }
        const steps = await planResult.steps
        let found: PlanStep[] | null = null
        for (const step of steps) {
          for (const toolCall of step.toolCalls) {
            if (toolCall.toolName !== 'emit_plan') continue
            const parsed = planStepsSchema.safeParse(normalizePlanSteps(toolCall.input))
            if (parsed.success) {
              found = canonicalizePlanTools(parsed.data.steps)
              break
            }
          }
          if (found) break
        }
        return { steps: found, heldParts, finish, errorText, hadText }
      } catch {
        return { steps: null, heldParts, finish, errorText, hadText }
      }
    }
    let attempt = await attemptPlan({
      toolChoice: { type: 'tool', toolName: 'emit_plan' },
      systemSuffix: ''
    })
    if (!attempt.steps && !deps.signal.aborted && !aborted) {
      attempt = await attemptPlan({
        toolChoice: 'auto',
        systemSuffix: '\nRespond ONLY by calling the emit_plan tool with the step-by-step plan.'
      })
    }
    // Text-only recovery (2026-09-13): when the provider never surfaces the
    // emit_plan call (forced toolChoice ignored — Ollama gpt-oss:120b live),
    // recover the SAME structured contract from the model's text: first the
    // plan attempts' own text (a JSON echo), then one no-tools completion
    // asking for the plan JSON. Schema validation is unchanged, so an
    // invalid plan still never reaches the panel; without a valid plan the
    // run falls through to the honest outcome below.
    if (!attempt.steps && !deps.signal.aborted && !aborted) {
      const attemptText = attempt.heldParts
        .filter((part) => part.type === 'text-delta')
        .map((part) => (part as { delta?: string }).delta ?? '')
        .join('')
      const echoed = parsePlanJson(attemptText)
      const recoveredRaw =
        echoed ?? (await extractPlanSteps(deps.model, deps.system, planMessages, deps.signal))
      const recovered = recoveredRaw ? canonicalizePlanTools(recoveredRaw) : null
      if (recovered) {
        // Plan-success commit: narration dropped, one summary (see
        // commitHeldNonText above) — never the model prose, never a raw
        // JSON echo.
        commitHeldNonText(discoveryHeld)
        commitHeldNonText(attempt.heldParts)
        commitPlanSummary(recovered, 'plan-summary-recovered')
        deps.onPlanCreated(recovered)
        return {
          aborted,
          terminalSent,
          accumulatorFailed: accumulator.isFailed(),
          assistantMessage: accumulator.toUIMessage(),
          heldFinish,
          usage: sumUsage(discoveryUsage, planUsage),
          stepsTaken: 0,
          stepLimitReached: false,
          planEmitted: true,
          planApproved: false
        }
      }
    }
    // Deterministic fallback: obvious document requests never end with
    // PLAN_FAILED_COPY just because the provider refused the forced tool.
    // Held prose is dropped (no story/content leak) — the panel gets a real
    // plan the user can start.
    if (!attempt.steps && !deps.signal.aborted && !aborted) {
      const fallback = buildFallbackDocumentPlan(userTextForDiscovery)
      if (fallback) {
        // The thread would otherwise stay empty (just the user bubble) —
        // the panel gets the structured plan, the thread gets one plain
        // summary line per step so the run visibly answered.
        for (const part of planSummaryChunks(fallback, 'fallback-plan-summary')) {
          accumulator.addChunk(part)
          deps.sendPart(part)
        }
        deps.onPlanCreated(fallback)
        return {
          aborted,
          terminalSent,
          accumulatorFailed: accumulator.isFailed(),
          assistantMessage: accumulator.toUIMessage(),
          heldFinish,
          usage: sumUsage(discoveryUsage, planUsage),
          stepsTaken: 0,
          stepLimitReached: false,
          planEmitted: true,
          planApproved: false
        }
      }
      // Organize fallback (2026-09-16): same doctrine for the stereotyped
      // organize-by-type request (live: Arabic organize returned
      // prose-without-a-plan on every attempt). Grounded in the discovery
      // listing — real buckets, real counts — so the panel is actionable.
      // When this run listed nothing (a previous turn already did, so the
      // model skipped tools), the conversation's freshest listing grounds
      // it instead. With no listing anywhere the honest failure below
      // still stands.
      const organize = buildFallbackOrganizePlan(userTextForDiscovery, [
        ...discoveryListings,
        ...historyListings(deps.messages)
      ])
      if (organize) {
        for (const part of planSummaryChunks(organize, 'fallback-organize-summary')) {
          accumulator.addChunk(part)
          deps.sendPart(part)
        }
        deps.onPlanCreated(organize)
        return {
          aborted,
          terminalSent,
          accumulatorFailed: accumulator.isFailed(),
          assistantMessage: accumulator.toUIMessage(),
          heldFinish,
          usage: sumUsage(discoveryUsage, planUsage),
          stepsTaken: 0,
          stepLimitReached: false,
          planEmitted: true,
          planApproved: false
        }
      }
    }
    if (attempt.steps) {
      // Plan-success commit: tool cards (already live) + one synthesized
      // summary. Model narration is dropped — the panel carries the plan.
      commitHeldNonText(discoveryHeld)
      commitHeldNonText(attempt.heldParts)
      commitPlanSummary(attempt.steps, 'plan-summary')
      deps.onPlanCreated(attempt.steps)
      return {
        aborted,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: true,
        planApproved: false
      }
    }
    if (deps.signal.aborted || aborted) {
      return {
        aborted: true,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }
    const genuineError = attempt.errorText !== null || attempt.finish === null
    if (!genuineError && attempt.hadText) {
      // Mutating requests drop BOTH held buffers (no story/content leak) and
      // end with the single honest copy. Q&A flushes discovery + attempt text.
      if (discoveryMutating) {
        if (!terminalSent) {
          deps.sendPart({ type: 'error', errorText: PLAN_FAILED_COPY })
          terminalSent = true
        }
        return {
          aborted,
          terminalSent,
          accumulatorFailed: accumulator.isFailed(),
          assistantMessage: accumulator.toUIMessage(),
          heldFinish,
          usage: sumUsage(discoveryUsage, planUsage),
          stepsTaken: 0,
          stepLimitReached: false,
          planEmitted: false,
          planApproved: false
        }
      }
      commitHeld(discoveryHeld)
      commitHeld(attempt.heldParts)
      return {
        aborted,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }
    // Genuine plan failure: mutating requests drop held discovery prose and
    // send the single honest copy (the reported story-then-error fix).
    // Non-mutating requests with a usable held discovery answer deliver it
    // with no error — erroring "hello" because emit_plan 400'd is the same
    // lie class M3.8 removed for the plan phase. (A failed discovery sets
    // discoveryError, so it never takes this silent path — the error below
    // surfaces instead.)
    if (!discoveryMutating && discoveryHeld.length > 0 && discoveryError === null) {
      commitHeld(discoveryHeld)
      return {
        aborted,
        terminalSent,
        accumulatorFailed: accumulator.isFailed(),
        assistantMessage: accumulator.toUIMessage(),
        heldFinish,
        usage: sumUsage(discoveryUsage, planUsage),
        stepsTaken: 0,
        stepLimitReached: false,
        planEmitted: false,
        planApproved: false
      }
    }
    if (!terminalSent) {
      const discoveryCopy =
        discoveryError !== null && discoveryError.type === 'error' ? discoveryError.errorText : null
      deps.sendPart({
        type: 'error',
        errorText: attempt.errorText ?? discoveryCopy ?? PLAN_FAILED_COPY
      })
      terminalSent = true
    }
    return {
      aborted,
      terminalSent,
      accumulatorFailed: accumulator.isFailed(),
      assistantMessage: accumulator.toUIMessage(),
      heldFinish,
      usage: sumUsage(discoveryUsage, planUsage),
      stepsTaken: 0,
      stepLimitReached: false,
      planEmitted: false,
      planApproved: false
    }
  } catch (error) {
    if (deps.signal.aborted) {
      aborted = true
    } else if (!accumulator.isFailed() && !terminalSent) {
      const message = isStopRejection(error)
        ? 'Stopped before the reply was sent.'
        : friendlyProviderError(error)
      deps.sendPart({ type: 'error', errorText: message })
      terminalSent = true
    }
    return {
      aborted,
      terminalSent,
      accumulatorFailed: accumulator.isFailed(),
      assistantMessage: accumulator.toUIMessage(),
      heldFinish,
      usage: sumUsage(discoveryUsage, planUsage),
      stepsTaken: 0,
      stepLimitReached: false,
      planEmitted: false,
      planApproved: false
    }
  }
}

export async function runActTurn(
  deps: ModeTurnDeps & { planHandoff?: PlanStep[] }
): Promise<PlanRunOutcome> {
  const maxSteps = deps.maxSteps ?? MAX_STEPS
  const accumulator = new AssistantMessageAccumulator()
  let heldFinish: UIMessageChunk | null = null
  let aborted = false
  let terminalSent = false
  let stepsTaken = 0
  let stepLimitReached = false
  let capturedUsage: LanguageModelUsage | undefined
  const emitPlanCallIds = new Set<string>()
  // Think-tag strip (one instance per run — tags may split across deltas).
  const thinkStrip = createThinkStripper()
  let thinkTailSeq = 0
  // Release a stream-end held fragment (visible text ending in `<…`) through
  // the live sinks — without this the trailing chars would be dropped.
  const flushThinkTailLive = (): void => {
    thinkTailSeq += 1
    const triple = thinkTailParts(`think-tail-${thinkTailSeq}`, thinkStrip.flush())
    if (triple) {
      for (const tailPart of triple) {
        accumulator.addChunk(tailPart)
        deps.sendPart(tailPart)
      }
    }
  }
  let cancelled = false
  // Real tool-call counter (every wrapper outcome: executed/refused/skipped/
  // cancelled). `stepsTaken` counts provider round-trips — a prose-only run
  // with zero tool calls still advances it, so it cannot detect the
  // "narrated the claim, called nothing" failure. Every onOutcome fires once
  // per tool-call attempt, so a refused/skipped call still counts as acting.
  let callsMade = 0
  // Phase-1 item 1: the last tool failure's plain-language message becomes the
  // persisted closing sentence when the model leaves the thread empty after
  // tools ran (live: a failed web_fetch with no closing prose ended as a bare
  // user bubble — nothing persisted). Tool messages are already plain-language;
  // the audit sink keeps the technical detail in tool_calls regardless.
  let lastFailureMessage: string | null = null
  const countCalls: typeof deps.onOutcome = (entry) => {
    callsMade += 1
    if (!entry.ok && typeof entry.message === 'string' && entry.message.trim() !== '') {
      lastFailureMessage = entry.message
    }
    deps.onOutcome?.(entry)
  }
  // A mutating request that produces prose and zero tool calls looks like the
  // run silently stopped — the retry + guard below fire for both an explicit
  // go-ahead and a plain Act request (live: models sometimes narrate the
  // claim and never call anything). Function scope so the catch block can
  // reuse it for the forced-refusal mapping.
  const actUserTexts = deps.messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join(' ')
  const expectsActions =
    (deps.planHandoff && deps.planHandoff.length > 0) || isLikelyMutatingRequest(actUserTexts)
  const ctxWithCancel: ToolExecutionContext = {
    ...deps.ctx,
    requestApproval: async (request) => {
      const decision = await deps.ctx.requestApproval(request)
      if (decision === 'cancel') cancelled = true
      return decision
    }
  }

  const forwardLive = async (result: {
    toUIMessageStream: (opts: { onError: (e: unknown) => string }) => AsyncIterable<UIMessageChunk>
  }): Promise<void> => {
    for await (const raw of result.toUIMessageStream({ onError: friendlyProviderError })) {
      // Think-tag strip FIRST (same demo-breaker rule as the plan path).
      let part = raw
      if (raw.type === 'text-delta') {
        const visible = thinkStrip.push(raw.delta)
        if (visible.length === 0) continue
        part = { ...raw, delta: visible }
      }
      accumulator.addChunk(part)
      if (part.type === 'finish') {
        heldFinish = part
        continue
      }
      if (part.type === 'abort') {
        aborted = true
        continue
      }
      if (part.type === 'error' && deps.signal.aborted) {
        aborted = true
        continue
      }
      if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') continue
      if (part.type === 'tool-input-available' && part.toolName === 'emit_plan') {
        emitPlanCallIds.add(part.toolCallId)
        continue
      }
      if (part.type === 'tool-output-available' && emitPlanCallIds.has(part.toolCallId)) continue
      deps.sendPart(part)
    }
    flushThinkTailLive()
  }

  try {
    // The reviewed plan is advisory context, never privileged execution data:
    // every resulting tool call still passes the registry wrapper. Only added
    // for an explicit go-ahead (chat.ts decides); a normal Act message runs
    // on the conversation alone.
    const handoff: ModelMessage[] =
      deps.planHandoff && deps.planHandoff.length > 0
        ? [
            {
              role: 'user',
              content: `The plan we reviewed:\n${deps.planHandoff.map((s, i) => `${i + 1}. ${s.description} (tool: ${s.tool})`).join('\n')}\nCarry it out now with the file tools; follow the existing approval behavior for anything risky.`
            }
          ]
        : []
    const baseExecMessages = [...convertToModelMessagesSafe(replayable(deps.messages)), ...handoff]
    const runOnce = async (opts: {
      systemSuffix: string
      toolChoice: 'auto' | 'required'
    }): Promise<void> => {
      const executionResult = streamText({
        model: deps.model,
        system: opts.systemSuffix ? `${deps.system}${opts.systemSuffix}` : deps.system,
        messages: baseExecMessages,
        tools: deps.registry.toAiSdkTools(
          ctxWithCancel,
          { onOutcome: countCalls },
          {
            exclude: ['emit_plan']
          }
        ),
        toolChoice: opts.toolChoice,
        abortSignal: deps.signal,
        stopWhen: [stepCountIs(maxSteps), () => cancelled],
        prepareStep: ({ messages: stepMessages }) => ({
          messages: stripStepReasoning(stepMessages)
        }),
        onAbort: () => {
          aborted = true
        },
        onStepFinish: () => {
          stepsTaken += 1
        },
        onFinish: (event) => {
          const next = event.totalUsage
          if (capturedUsage === undefined) {
            capturedUsage = next
          } else if (next !== undefined) {
            const inT = (capturedUsage.inputTokens ?? 0) + (next.inputTokens ?? 0)
            const outT = (capturedUsage.outputTokens ?? 0) + (next.outputTokens ?? 0)
            capturedUsage = { ...capturedUsage, inputTokens: inT, outputTokens: outT }
          }
        }
      })
      await forwardLive(executionResult)
    }
    await runOnce({ systemSuffix: '', toolChoice: 'auto' })
    // A mutating request that produced prose and zero tool calls looks like
    // the run silently stopped — retry once with a tool call required. The
    // wrapper still guards every call, so forcing *a* tool cannot force a
    // mutation. Covers both an explicit go-ahead and a plain Act request
    // (live: models sometimes narrate the claim and never call anything).
    if (!aborted && !cancelled && callsMade === 0 && expectsActions) {
      await runOnce({
        systemSuffix:
          deps.planHandoff && deps.planHandoff.length > 0
            ? '\nAct now using the file tools to carry out the reviewed plan. Call the first tool immediately; do not reply in text first.'
            : '\nYou must act now using your tools to carry out the request. Call the first tool immediately; do not reply in text first.',
        toolChoice: 'required'
      })
    }
    if (!aborted && !cancelled && callsMade === 0 && expectsActions) {
      if (!terminalSent) {
        deps.sendPart({
          type: 'error',
          errorText:
            "I didn't take any actions, so nothing changed. Try saying which file to work on and what to do with it."
        })
        terminalSent = true
      }
    }
    // Phase-1 item 1: tools ran but the model produced no closing prose — the
    // thread would settle as a bare user bubble with nothing persisted (live:
    // failed web_fetch). Synthesize one persisted text sentence (not an error
    // part — error parts never persist) so the thread always ends with an
    // honest assistant sentence. Prefer the last tool failure's plain-language
    // message; otherwise state completion briefly.
    if (!aborted && !cancelled && callsMade > 0 && !accumulator.hasText()) {
      const fallback = lastFailureMessage ?? 'Done — the results are in the cards above.'
      const textId = 'act-fallback-close'
      const fallbackParts: UIMessageChunk[] = [
        { type: 'text-start', id: textId },
        { type: 'text-delta', id: textId, delta: fallback },
        { type: 'text-end', id: textId }
      ]
      for (const part of fallbackParts) {
        accumulator.addChunk(part)
        deps.sendPart(part)
      }
    }
    if (!aborted && stepsTaken >= maxSteps) stepLimitReached = true
    if (deps.verify && !aborted) {
      try {
        const userMessages = deps.messages.filter((m) => m.role === 'user')
        const lastText = userMessages[userMessages.length - 1]
        const instructionSegment =
          lastText && lastText.parts[0] && lastText.parts[0].type === 'text'
            ? (lastText.parts[0] as { text: string }).text.slice(0, 500)
            : 'run'
        const verdict = await deps.verify({
          instructionSegment,
          stepDescription: 'execution'
        })
        if (verdict.verdict === 'complete') {
          deps.onVerification?.({ stepId: 'run', isComplete: true, score: verdict.score })
        } else if (verdict.verdict === 'incomplete') {
          const retry = await deps.verify({
            instructionSegment: `${instructionSegment}\nMissed: ${verdict.missedSegments.join('; ')}`,
            stepDescription: 'execution-retry'
          })
          if (retry.verdict === 'complete') {
            deps.onVerification?.({ stepId: 'run', isComplete: true, score: retry.score })
          } else if (retry.verdict === 'incomplete') {
            deps.onVerification?.({
              stepId: 'run',
              isComplete: false,
              score: retry.score,
              missedSegments: retry.missedSegments
            })
          } else {
            deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
          }
        } else {
          deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
        }
      } catch {
        deps.onVerification?.({ stepId: 'run', isComplete: false, score: null })
      }
    }
  } catch (error) {
    // A provider that refuses the retry's required tool choice (forced-call
    // refusal class, e.g. ToolCallError) lands here: the run took no action,
    // and the honest zero-action copy below must still surface — the raw
    // refusal's generic "check your connection" text must not replace it.
    if (
      error instanceof Error &&
      /did not call a tool/i.test(error.message) &&
      callsMade === 0 &&
      expectsActions
    ) {
      if (!terminalSent) {
        deps.sendPart({
          type: 'error',
          errorText:
            "I didn't take any actions, so nothing changed. Try saying which file to work on and what to do with it."
        })
        terminalSent = true
      }
    } else if (!accumulator.isFailed() && !terminalSent) {
      const message = isStopRejection(error)
        ? 'Stopped before the reply was sent.'
        : friendlyProviderError(error)
      deps.sendPart({ type: 'error', errorText: message })
      terminalSent = true
    }
  }
  return {
    aborted,
    terminalSent,
    accumulatorFailed: accumulator.isFailed(),
    assistantMessage: accumulator.toUIMessage(),
    heldFinish,
    usage: sumUsage(capturedUsage, undefined),
    stepsTaken,
    stepLimitReached,
    planEmitted: false,
    planApproved: false
  }
}
