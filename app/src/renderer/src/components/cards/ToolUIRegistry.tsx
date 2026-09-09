import { useEffect } from 'react'
import { useAssistantApi } from '@assistant-ui/react'
import type { ToolCallMessagePartComponent } from '@assistant-ui/react'
import { AskUserCard } from './AskUserCard'
import { CopyPathCard } from './CopyPathCard'
import { CreateDirCard } from './CreateDirCard'
import { DeletePathCard } from './DeletePathCard'
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
import { WriteFileCard } from './WriteFileCard'
import type { ToolCardStatus } from './BaseToolCard'

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

function errorTextFor(part: AuiToolPart): string | undefined {
  if (!part.isError) return undefined
  if (typeof part.result === 'string') return part.result
  if (part.result && typeof part.result === 'object') {
    const message = (part.result as { message?: unknown }).message
    if (typeof message === 'string') return message
    try {
      return JSON.stringify(part.result)
    } catch {
      return 'That step failed.'
    }
  }
  return 'That step failed.'
}

function titleFromToolName(toolName: string): string {
  switch (toolName) {
    case 'list_dir':
      return 'List folder'
    case 'read_file':
      return 'Read file'
    case 'read_document':
      return 'Read document'
    case 'summarize_document':
      return 'Summarize document'
    case 'web_fetch':
      return 'Open web page'
    case 'search_files':
      return 'Search files'
    case 'semantic_search':
      return 'Search by meaning'
    case 'ask_user':
      return 'Ask you something'
    case 'write_file':
      return 'Write file'
    case 'create_dir':
      return 'Create folder'
    case 'edit_file':
      return 'Edit file'
    case 'move_path':
      return 'Move'
    case 'copy_path':
      return 'Copy'
    case 'delete_path':
      return 'Delete'
    default:
      return toolName
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asListEntries(value: unknown): { name: string; type: 'file' | 'directory' }[] {
  if (!isRecord(value)) return []
  const entries = value.entries
  if (!Array.isArray(entries)) return []
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

function renderListDirCard(part: AuiToolPart): React.JSX.Element | null {
  const entries = asListEntries(part.result)
  if (entries.length === 0 && !isRecord(part.result)) return null
  return (
    <ListDirCard
      title={titleFromToolName('list_dir')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      entries={entries}
    />
  )
}

function renderReadFileCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asReadFile(part.result)
  if (!result) return null
  return (
    <ReadFileCard
      title={titleFromToolName('read_file')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderReadDocumentCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asReadDocument(part.result)
  if (!result) return null
  return (
    <ReadDocumentCard
      title={titleFromToolName('read_document')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderSummarizeDocumentCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asSummarizeDocument(part.result)
  if (!result) return null
  return (
    <SummarizeDocumentCard
      title={titleFromToolName('summarize_document')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderWebFetchCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asWebFetch(part.result)
  if (!result) return null
  return (
    <WebFetchCard
      title={titleFromToolName('web_fetch')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderSemanticSearchCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asSemanticResults(part.result)
  if (!result) return null
  return (
    <SemanticSearchCard
      title={titleFromToolName('semantic_search')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderSearchFilesCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asSearchResults(part.result)
  if (!result) return null
  return (
    <SearchFilesCard
      title={titleFromToolName('search_files')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderAskUserCard(part: AuiToolPart): React.JSX.Element | null {
  // ask_user is the only tool whose card is open while the run is paused.
  // The synthetic pause chunk's output carries __agentoAskUser; the answer
  // chunk's output is { question, answer }. Both shapes flow through the
  // same card component.
  const result = part.result
  if (!isRecord(result)) return null
  const question = typeof result.question === 'string' ? result.question : ''
  if (!question) return null
  const options = Array.isArray(result.options)
    ? result.options.filter((o): o is string => typeof o === 'string')
    : undefined
  return (
    <AskUserCard
      title={titleFromToolName('ask_user')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      question={question}
      options={options}
      output={result}
    />
  )
}

function renderWriteFileCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asWriteFile(part.result)
  if (!result) return null
  return (
    <WriteFileCard
      title={titleFromToolName('write_file')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderCreateDirCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asCreateDir(part.result)
  if (!result) return null
  return (
    <CreateDirCard
      title={titleFromToolName('create_dir')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderEditFileCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asEditFile(part.result)
  if (!result) return null
  return (
    <EditFileCard
      title={titleFromToolName('edit_file')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderMovePathCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asMovePath(part.result)
  if (!result) return null
  return (
    <MovePathCard
      title={titleFromToolName('move_path')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderCopyPathCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asCopyPath(part.result)
  if (!result) return null
  return (
    <CopyPathCard
      title={titleFromToolName('copy_path')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

function renderDeletePathCard(part: AuiToolPart): React.JSX.Element | null {
  const result = asDeletePath(part.result)
  if (!result) return null
  return (
    <DeletePathCard
      title={titleFromToolName('delete_path')}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      {...result}
    />
  )
}

// Single renderer per tool: the assistant-ui runtime hands us the ToolCall
// props; we project to a per-tool card (or the generic fallback).
function renderToolCard(part: AuiToolPart): React.JSX.Element {
  if (part.toolName === 'list_dir') {
    const card = renderListDirCard(part)
    if (card) return card
  }
  if (part.toolName === 'read_file') {
    const card = renderReadFileCard(part)
    if (card) return card
  }
  if (part.toolName === 'read_document') {
    const card = renderReadDocumentCard(part)
    if (card) return card
  }
  if (part.toolName === 'summarize_document') {
    const card = renderSummarizeDocumentCard(part)
    if (card) return card
  }
  if (part.toolName === 'web_fetch') {
    const card = renderWebFetchCard(part)
    if (card) return card
  }
  if (part.toolName === 'semantic_search') {
    const card = renderSemanticSearchCard(part)
    if (card) return card
  }
  if (part.toolName === 'search_files') {
    const card = renderSearchFilesCard(part)
    if (card) return card
  }
  if (part.toolName === 'ask_user') {
    const card = renderAskUserCard(part)
    if (card) return card
  }
  if (part.toolName === 'write_file') {
    const card = renderWriteFileCard(part)
    if (card) return card
  }
  if (part.toolName === 'create_dir') {
    const card = renderCreateDirCard(part)
    if (card) return card
  }
  if (part.toolName === 'edit_file') {
    const card = renderEditFileCard(part)
    if (card) return card
  }
  if (part.toolName === 'move_path') {
    const card = renderMovePathCard(part)
    if (card) return card
  }
  if (part.toolName === 'copy_path') {
    const card = renderCopyPathCard(part)
    if (card) return card
  }
  if (part.toolName === 'delete_path') {
    const card = renderDeletePathCard(part)
    if (card) return card
  }
  return (
    <GenericToolCard
      title={titleFromToolName(part.toolName)}
      status={statusFor(part.status)}
      toolCallId={part.toolCallId}
      result={part.result}
      args={part.args}
      errorText={errorTextFor(part)}
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
    return renderToolCard(part)
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
      'semantic_search',
      'web_fetch',
      'search_files',
      'ask_user',
      'write_file',
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
