import { useEffect } from 'react'
import { useAssistantApi } from '@assistant-ui/react'
import type { ToolCallMessagePartComponent } from '@assistant-ui/react'
import { AskUserCard } from './AskUserCard'
import { CopyPathCard } from './CopyPathCard'
import { CreateDirCard } from './CreateDirCard'
import { DeletePathCard } from './DeletePathCard'
import { EditDocumentCard } from './EditDocumentCard'
import { EditFileCard } from './EditFileCard'
import { GenericToolCard } from './GenericToolCard'
import { ListDirCard } from './ListDirCard'
import { MovePathCard } from './MovePathCard'
import { ReadDocumentCard } from './ReadDocumentCard'
import { ReadFileCard } from './ReadFileCard'
import { SearchFilesCard } from './SearchFilesCard'
import { SemanticSearchCard } from './SemanticSearchCard'
import { SummarizeDocumentCard } from './SummarizeDocumentCard'
import { WebFetchCard } from './WebFetchCard'
import { WebSearchCard } from './WebSearchCard'
import { WriteFileCard } from './WriteFileCard'
import type { ToolCardStatus } from './BaseToolCard'
import { useLocale } from '../locale-context'
import type { StringKey } from '../../chat/locale'

// Tool card registry: mounts every per-tool card via the assistant-ui
// runtime's tools API (`setToolUI`). The ToolUIRegistry runs ONCE per
// AssistantRuntimeProvider mount — subscriptions are torn down on unmount.
// Unknown tool names fall back to GenericToolCard (no behavior change for
// future tools whose custom card lands later).
//
// assistant-ui 0.11.56 hands ToolCallMessagePartComponent a part shaped as
// { type: 'tool-call', toolCallId, toolName, args, result?, isError?, ... }
// plus runtime props { status: MessagePartState-ish, addResult, resume }.
// The props type (ToolCallMessagePartProps) is the contract; we narrow from
// `unknown` inside each renderer so a shape change degrades to the generic
// card instead of a crash.

interface AuiToolPart {
  toolName: string
  toolCallId: string
  args: unknown
  argsText?: string
  result?: unknown
  isError?: boolean
  status?: { type?: string; reason?: string } | string
  addResult?: (result: unknown) => void
}

// The runtime's status is a { type } object ('running' | 'complete' |
// 'incomplete' | 'requires-action' | ...); cards only distinguish the four
// BaseToolCard states.
function statusFor(value: AuiToolPart['status']): ToolCardStatus {
  if (!value) return 'disabled'
  if (typeof value === 'string') {
    if (value === 'running') return 'running'
    if (value === 'complete') return 'complete'
    if (value === 'incomplete') return 'incomplete'
    return 'disabled'
  }
  const t = value.type
  if (t === 'running' || t === 'requires-action') return 'running'
  if (t === 'complete') return 'complete'
  if (t === 'incomplete') return 'incomplete'
  return 'disabled'
}

// DEMO-007: soft refusals (move/copy onto a missing source) travel as a
// `tool-output-error` part — the adapter reports status 'complete' with
// isError set, so status alone reads "step succeeded" (green ✓) next to the
// failure sentence. A result record carrying an `error` string is the same
// story told as data. Either one forces the incomplete (⚠) state + warn
// styling — a card never shows ✓ together with an error body.
function hasErrorResult(result: unknown): boolean {
  // Inline record check (isRecord is declared further below; this keeps the
  // failure helpers self-contained at the top of the module).
  if (typeof result !== 'object' || result === null) return false
  return typeof (result as { error?: unknown }).error === 'string'
}

function isFailurePart(part: AuiToolPart): boolean {
  return part.isError === true || hasErrorResult(part.result)
}

function statusForPart(part: AuiToolPart): ToolCardStatus {
  if (isFailurePart(part)) return 'incomplete'
  return statusFor(part.status)
}

// Some tools report failure as {"error": "…"} — show the plain sentence,
// never raw JSON (docs/04 plain-language rule).
function plainToolError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    if (typeof parsed.error === 'string') return parsed.error
    if (typeof parsed.message === 'string') return parsed.message
  } catch {
    // Not JSON — show as-is.
  }
  return text
}

function errorTextFor(part: AuiToolPart): string | undefined {
  // The soft-refusal sentence lives on the result record itself ({ error }) —
  // readable with or without isError, so an error-data result still shows its
  // own sentence instead of the generic fallback. (`message` stays
  // isError-gated below: skipped/cancelled outcomes carry a `message` on a
  // successful part, and that is not a failure.)
  if (part.result && typeof part.result === 'object') {
    const error = (part.result as { error?: unknown }).error
    if (typeof error === 'string') return error
  }
  if (!part.isError) return undefined
  if (typeof part.result === 'string') return plainToolError(part.result)
  if (part.result && typeof part.result === 'object') {
    const message = (part.result as { message?: unknown }).message
    if (typeof message === 'string') return message
    try {
      return plainToolError(JSON.stringify(part.result))
    } catch {
      return undefined
    }
  }
  return undefined
}

// Card titles live in the locale dictionary (cards.tool.*) — the Shim owns
// useLocale and resolves the title once per part, so the pure render
// functions below stay locale-free and thread a plain `title` string.
function titleKeyFromToolName(toolName: string): StringKey | null {
  switch (toolName) {
    case 'list_dir':
      return 'cards.tool.listDir'
    case 'read_file':
      return 'cards.tool.readFile'
    case 'read_document':
      return 'cards.tool.readDocument'
    case 'summarize_document':
      return 'cards.tool.summarize'
    case 'web_fetch':
      return 'cards.tool.webFetch'
    case 'web_search':
      return 'cards.tool.webSearch'
    case 'search_files':
      return 'cards.tool.searchFiles'
    case 'semantic_search':
      return 'cards.tool.semantic'
    case 'ask_user':
      return 'cards.tool.askUser'
    case 'write_file':
      return 'cards.tool.writeFile'
    case 'create_document':
      return 'cards.tool.createDocument'
    case 'create_dir':
      return 'cards.tool.createDir'
    case 'edit_file':
      return 'cards.tool.editFile'
    case 'edit_document':
      return 'cards.tool.editDocument'
    case 'move_path':
      return 'cards.tool.move'
    case 'copy_path':
      return 'cards.tool.copy'
    case 'delete_path':
      return 'cards.tool.delete'
    default:
      return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asListEntries(value: unknown): { name: string; type: 'file' | 'directory' }[] | null {
  // Phase-1 item 2: only a record carrying an `entries` ARRAY is a listing.
  // Anything else (an error record `{ error: … }`, a still-running part with
  // no result) returns null so the card falls back to the generic error/
  // running rendering — never "0 entries / This folder is empty".
  if (!isRecord(value)) return null
  const entries = value.entries
  if (!Array.isArray(entries)) return null
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (typeof entry.name !== 'string') return []
    if (entry.type !== 'file' && entry.type !== 'directory') return []
    return [{ name: entry.name, type: entry.type }]
  })
}

function asReadFile(value: unknown): {
  content: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
} | null {
  if (!isRecord(value)) return null
  if (typeof value.content !== 'string') return null
  if (
    typeof value.startLine !== 'number' ||
    typeof value.endLine !== 'number' ||
    typeof value.totalLines !== 'number' ||
    typeof value.truncated !== 'boolean'
  ) {
    return null
  }
  return {
    content: value.content,
    startLine: value.startLine,
    endLine: value.endLine,
    totalLines: value.totalLines,
    truncated: value.truncated
  }
}

function asReadDocument(value: unknown): {
  text: string
  truncated: boolean
} | null {
  if (!isRecord(value)) return null
  if (typeof value.text !== 'string' || typeof value.truncated !== 'boolean') return null
  return { text: value.text, truncated: value.truncated }
}

function asSummarizeDocument(value: unknown): {
  summary: string
  truncated: boolean
} | null {
  if (!isRecord(value)) return null
  if (typeof value.summary !== 'string' || typeof value.truncated !== 'boolean') return null
  return { summary: value.summary, truncated: value.truncated }
}

function asWebFetch(value: unknown): {
  pageTitle?: string
  text: string
  truncated: boolean
} | null {
  if (!isRecord(value)) return null
  if (typeof value.text !== 'string' || typeof value.truncated !== 'boolean') return null
  const pageTitle = typeof value.title === 'string' ? value.title : undefined
  return { pageTitle, text: value.text, truncated: value.truncated }
}

function asWebSearch(value: unknown): {
  query: string
  results: { title: string; url: string; snippet: string }[]
  provider?: 'tavily' | 'duckduckgo'
  truncated?: boolean
} | null {
  if (!isRecord(value)) return null
  if (typeof value.query !== 'string' || !Array.isArray(value.results)) return null
  const results = value.results.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (
      typeof entry.title !== 'string' ||
      typeof entry.url !== 'string' ||
      typeof entry.snippet !== 'string'
    ) {
      return []
    }
    return [{ title: entry.title, url: entry.url, snippet: entry.snippet }]
  })
  const provider =
    value.provider === 'tavily' || value.provider === 'duckduckgo' ? value.provider : undefined
  // Phase-1 item 1: the tool's honest self-cap flag passes through so the card
  // can say the ranking is partial. The wrapper's `outputTruncated` envelope is
  // a different shape (no query/results) and still falls to GenericToolCard.
  const truncated = value.truncated === true ? true : undefined
  return {
    query: value.query,
    results,
    ...(provider === undefined ? {} : { provider }),
    ...(truncated === undefined ? {} : { truncated })
  }
}

function asSemanticResults(value: unknown): {
  query: string
  results: { path: string; snippet: string; score: number }[]
} | null {
  if (!isRecord(value)) return null
  if (typeof value.query !== 'string' || !Array.isArray(value.results)) return null
  const results = value.results.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (
      typeof entry.path !== 'string' ||
      typeof entry.snippet !== 'string' ||
      typeof entry.score !== 'number'
    ) {
      return []
    }
    return [{ path: entry.path, snippet: entry.snippet, score: entry.score }]
  })
  return { query: value.query, results }
}

function asSearchResults(value: unknown): {
  query: string
  matches: { path: string; line: number; preview: string }[]
  truncated: boolean
} | null {
  if (!isRecord(value)) return null
  if (typeof value.query !== 'string') return null
  if (!Array.isArray(value.matches)) return null
  if (typeof value.truncated !== 'boolean') return null
  const matches = value.matches.flatMap((m) => {
    if (!isRecord(m)) return []
    if (typeof m.path !== 'string' || typeof m.line !== 'number' || typeof m.preview !== 'string') {
      return []
    }
    return [{ path: m.path, line: m.line, preview: m.preview }]
  })
  return { query: value.query, matches, truncated: value.truncated }
}

function asWriteFile(value: unknown): {
  size: number
  beforeExcerpt: string | null
  afterExcerpt: string
} | null {
  if (!isRecord(value)) return null
  if (typeof value.afterExcerpt !== 'string' || typeof value.size !== 'number') return null
  const before = typeof value.beforeExcerpt === 'string' ? value.beforeExcerpt : null
  return { size: value.size, beforeExcerpt: before, afterExcerpt: value.afterExcerpt }
}

function asCreateDir(value: unknown): { existed: boolean } | null {
  if (!isRecord(value)) return null
  if (typeof value.existed !== 'boolean') return null
  return { existed: value.existed }
}

function asEditFile(value: unknown): {
  beforeExcerpt: string
  afterExcerpt: string
} | null {
  if (!isRecord(value)) return null
  if (typeof value.beforeExcerpt !== 'string' || typeof value.afterExcerpt !== 'string') {
    return null
  }
  return { beforeExcerpt: value.beforeExcerpt, afterExcerpt: value.afterExcerpt }
}

function asEditDocument(value: unknown): {
  beforeExcerpt: string
  afterExcerpt: string
  editsApplied: number
} | null {
  if (!isRecord(value)) return null
  if (typeof value.beforeExcerpt !== 'string' || typeof value.afterExcerpt !== 'string') {
    return null
  }
  if (typeof value.editsApplied !== 'number') return null
  return {
    beforeExcerpt: value.beforeExcerpt,
    afterExcerpt: value.afterExcerpt,
    editsApplied: value.editsApplied
  }
}

function asMovePath(value: unknown): {
  from: string
  to: string
  overwritten: boolean
} | null {
  if (!isRecord(value)) return null
  if (typeof value.from !== 'string' || typeof value.to !== 'string') return null
  if (typeof value.overwritten !== 'boolean') return null
  return { from: value.from, to: value.to, overwritten: value.overwritten }
}

function asCopyPath(value: unknown): {
  from: string
  to: string
  overwritten: boolean
  size: number
} | null {
  if (!isRecord(value)) return null
  if (typeof value.from !== 'string' || typeof value.to !== 'string') return null
  if (typeof value.overwritten !== 'boolean' || typeof value.size !== 'number') return null
  return { from: value.from, to: value.to, overwritten: value.overwritten, size: value.size }
}

function asDeletePath(value: unknown): { path: string } | null {
  if (!isRecord(value)) return null
  if (typeof value.path !== 'string') return null
  return { path: value.path }
}

function renderListDirCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  // A failed call must never render as an empty folder (Phase-1 item 2): bail
  // to the generic card, whose errorTextFor shows the tool's own sentence.
  if (part.isError) return null
  const entries = asListEntries(part.result)
  if (entries === null) return null
  return (
    <ListDirCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      entries={entries}
    />
  )
}

function renderReadFileCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asReadFile(part.result)
  if (!result) return null
  return (
    <ReadFileCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderReadDocumentCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asReadDocument(part.result)
  if (!result) return null
  return (
    <ReadDocumentCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderSummarizeDocumentCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asSummarizeDocument(part.result)
  if (!result) return null
  return (
    <SummarizeDocumentCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderWebFetchCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asWebFetch(part.result)
  if (!result) return null
  return (
    <WebFetchCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderWebSearchCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asWebSearch(part.result)
  if (!result) return null
  return (
    <WebSearchCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderSemanticSearchCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asSemanticResults(part.result)
  if (!result) return null
  return (
    <SemanticSearchCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderSearchFilesCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asSearchResults(part.result)
  if (!result) return null
  return (
    <SearchFilesCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderAskUserCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  // ask_user is the only tool whose card is open while the run is paused.
  // The synthetic pause chunk's output carries __agentoAskUser — the reply
  // happens in the main composer (App.tsx reply mode), so this card is
  // display-only; the answer chunk's output is { question, answer }. Both
  // shapes flow through the same card component.
  const result = part.result
  if (!isRecord(result)) return null
  const question = typeof result.question === 'string' ? result.question : ''
  if (!question) return null
  return (
    <AskUserCard title={title} status={statusForPart(part)} question={question} output={result} />
  )
}

function renderWriteFileCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asWriteFile(part.result)
  if (!result) return null
  return (
    <WriteFileCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderCreateDirCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asCreateDir(part.result)
  if (!result) return null
  return (
    <CreateDirCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderEditFileCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asEditFile(part.result)
  if (!result) return null
  return (
    <EditFileCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderEditDocumentCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asEditDocument(part.result)
  if (!result) return null
  return (
    <EditDocumentCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderMovePathCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asMovePath(part.result)
  if (!result) return null
  return (
    <MovePathCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderCopyPathCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asCopyPath(part.result)
  if (!result) return null
  return (
    <CopyPathCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderDeletePathCard(part: AuiToolPart, title: string): React.JSX.Element | null {
  const result = asDeletePath(part.result)
  if (!result) return null
  return (
    <DeletePathCard
      title={title}
      status={statusForPart(part)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

// Single renderer per tool: the assistant-ui runtime hands us the ToolCall
// props; we project to a per-tool card (or the generic fallback). A failed
// part (DEMO-007) never reaches the per-tool renderers — their meta lines
// describe success ("Moved X to Y"), so a failure must fall through to the
// generic card, whose error line shows the tool's own sentence under the ⚠
// glyph (statusForPart forces incomplete below).
function renderToolCard(part: AuiToolPart, title: string, stepFailed: string): React.JSX.Element {
  const failed = isFailurePart(part)
  if (!failed && part.toolName === 'list_dir') {
    const card = renderListDirCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'read_file') {
    const card = renderReadFileCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'read_document') {
    const card = renderReadDocumentCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'summarize_document') {
    const card = renderSummarizeDocumentCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'web_fetch') {
    const card = renderWebFetchCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'web_search') {
    const card = renderWebSearchCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'semantic_search') {
    const card = renderSemanticSearchCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'search_files') {
    const card = renderSearchFilesCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'ask_user') {
    const card = renderAskUserCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'write_file') {
    const card = renderWriteFileCard(part, title)
    if (card) return card
  }
  // create_document returns the write_file result shape ({size,
  // beforeExcerpt: null, afterExcerpt}) — the same card, new title.
  if (!failed && part.toolName === 'create_document') {
    const card = renderWriteFileCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'create_dir') {
    const card = renderCreateDirCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'edit_file') {
    const card = renderEditFileCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'edit_document') {
    const card = renderEditDocumentCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'move_path') {
    const card = renderMovePathCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'copy_path') {
    const card = renderCopyPathCard(part, title)
    if (card) return card
  }
  if (!failed && part.toolName === 'delete_path') {
    const card = renderDeletePathCard(part, title)
    if (card) return card
  }
  // The generic fallback must not cry failure while the step is still
  // running: a tool parked on the ApprovalDialog has no result yet, so every
  // per-tool renderer above returned null and we land here with a live step.
  // The failure line attaches only to a genuinely failed step; real backend
  // errors still win through errorTextFor in every state. statusForPart maps
  // any failure (isError or an { error } data result) to incomplete, so no
  // card ever shows ✓ together with an error body (DEMO-007).
  const status = statusForPart(part)
  return (
    <GenericToolCard
      title={title}
      status={status}
      toolCallId={part.toolCallId}
      result={part.result}
      args={part.args}
      errorText={status === 'incomplete' ? (errorTextFor(part) ?? stepFailed) : errorTextFor(part)}
    />
  )
}

// The assistant-ui tool-UI hook lets the runtime know which React component
// to use for a given tool part. We register a single shim that adapts the
// assistant-ui ToolCallMessagePartProps into our per-tool card. The shim is
// stable (it does not capture per-render state), so re-registering it on
// every render is harmless.
function makeToolCardShim(toolName: string): ToolCallMessagePartComponent {
  const Shim = (props: unknown): React.JSX.Element => {
    // The Shim is a real component under App's LocaleProvider, so it owns
    // the locale read; the pure render functions below take plain strings.
    const { t } = useLocale()
    // assistant-ui passes { status, toolCallId, args, argsText, result,
    // isError, addResult, resume, ... }. We only read the documented part
    // fields plus `status`; everything else degrades to the generic card.
    const p = (props ?? {}) as Partial<AuiToolPart>
    const part: AuiToolPart = {
      toolName,
      toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : '',
      args: p.args,
      argsText: typeof p.argsText === 'string' ? p.argsText : undefined,
      result: p.result,
      isError: p.isError,
      status: p.status
    }
    const key = titleKeyFromToolName(toolName)
    const title = key ? t(key) : toolName
    return renderToolCard(part, title, t('cards.stepFailed'))
  }
  return Shim as ToolCallMessagePartComponent
}

export function ToolUIRegistry(): null {
  const api = useAssistantApi()
  // Register once; the runtime holds the subscription until unmount. We
  // intentionally don't memoise: setToolUI is idempotent and returns an
  // unsubscribe (the runtime collects it on unmount).
  useEffect(() => {
    // `api.tools` is an AssistantApiField — a callable resolving the tools
    // API — not the API itself.
    const tools = api.tools()
    const unsubscribers: Array<() => void> = []
    for (const name of [
      'list_dir',
      'read_file',
      'read_document',
      'summarize_document',
      'edit_document',
      'semantic_search',
      'web_fetch',
      'web_search',
      'search_files',
      'ask_user',
      'write_file',
      'create_document',
      'create_dir',
      'edit_file',
      'move_path',
      'copy_path',
      'delete_path'
    ]) {
      unsubscribers.push(tools.setToolUI(name, makeToolCardShim(name)))
    }
    return () => {
      for (const unsub of unsubscribers) unsub()
    }
  }, [api])
  return null
}
