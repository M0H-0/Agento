import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import type { WorkspaceFs } from './types'

// MVP semantic search index (MVP_PLAN.md standout feature): chunk the
// workspace's readable files, embed via the sidecar's fastembed model, and
// cosine-rank a query against the cached vectors. Everything runs on-device;
// no API tokens, no vector DB — a flat JSON cache is plenty at workspace
// scale.
//
// fs discipline: workspace content is read ONLY through the injected
// WorkspaceFs facade (walkFiles/readFileSync — same doctrine as
// search_files). node:fs is used solely for the cache file, which lives in
// the app's own userData directory (outside every workspace — a risk-0 tool
// must never write into the user's folder, it would bypass the snapshot
// pipeline; deviation from MVP_PLAN's `.agento/` note, see Devlog).

// Index bounds — MVP-sized workspaces only.
const MAX_INDEX_FILES = 2_000
const MAX_FILE_BYTES = 5 * 1024 * 1024
const CHUNK_CHARS = 1_800
const MAX_CHUNKS_PER_FILE = 40
const MAX_TOTAL_CHUNKS = 5_000
const EMBED_BATCH = 128

const TEXT_SUFFIXES = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.csv',
  '.log',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.ini',
  '.toml',
  '.html',
  '.htm',
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.sql',
  '.sh',
  '.ps1',
  '.java',
  '.cs',
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cpp'
])
const SIDECAR_SUFFIXES = new Set(['.pdf', '.docx'])

export interface SemanticIndexDeps {
  fs: WorkspaceFs
  embedTexts(texts: string[]): Promise<number[][]>
  /** Sidecar extraction for .pdf/.docx during indexing; when absent (or
   * failing) binary documents are skipped — they are optional cargo. */
  extractDocument?(path: string): Promise<{ text: string; truncated: boolean }>
  /** Absolute path of the JSON cache file (userData — see header note). */
  cachePath: string
}

export interface SemanticSearchResult {
  path: string
  snippet: string
  score: number
}

interface CacheChunk {
  text: string
  vector: number[]
}

interface CacheEntry {
  hash: string
  chunks: CacheChunk[]
}

interface CacheFile {
  version: 1
  entries: Record<string, CacheEntry>
}

function emptyCache(): CacheFile {
  return { version: 1, entries: {} }
}

function loadCache(cachePath: string): CacheFile {
  try {
    if (!existsSync(cachePath)) return emptyCache()
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as CacheFile
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return emptyCache()
    }
    return parsed
  } catch {
    // A corrupt cache is never fatal — worst case everything re-embeds.
    return emptyCache()
  }
}

function saveCache(cachePath: string, cache: CacheFile): void {
  // Temp file + rename in the SAME directory (atomic on Windows and POSIX).
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    const tempPath = `${cachePath}.${Date.now()}.tmp`
    writeFileSync(tempPath, JSON.stringify(cache), 'utf8')
    renameSync(tempPath, cachePath)
  } catch {
    // Cache persistence is best-effort; the in-memory copy still serves
    // this run's queries.
  }
}

function hashContent(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex')
}

export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = []
  let index = 0
  while (index < text.length && chunks.length < MAX_CHUNKS_PER_FILE) {
    let end = Math.min(text.length, index + size)
    if (end < text.length) {
      // Prefer a whitespace boundary past the midpoint of the window.
      const breakPos = text.lastIndexOf(' ', end)
      if (breakPos > index + size / 2) end = breakPos
    }
    const piece = text.slice(index, end).trim()
    if (piece.length > 0) chunks.push(piece)
    index = end
  }
  return chunks
}

/** Cosine similarity — shared with the L1 session-recall tool so ranking
 * math is defined once (file chunks and history candidates rank alike). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

function snippetOf(chunk: string): string {
  const oneLine = chunk.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 160)}…`
}

/**
 * Ensure the workspace index is fresh (re-embedding only files whose content
 * hash changed), then embed the query and return the top-k matches.
 */
export async function semanticSearch(
  deps: SemanticIndexDeps,
  workspaceRoot: string,
  query: string,
  topK?: number
): Promise<SemanticSearchResult[]> {
  const limit = Math.min(Math.max(topK ?? 5, 1), 20)
  const cache = loadCache(deps.cachePath)
  const filePaths = deps.fs.walkFiles(workspaceRoot, MAX_INDEX_FILES)

  // Pass 1 — read every indexable file and decide which need (re-)embedding.
  const freshPaths = new Set<string>()
  const pending: { filePath: string; hash: string; texts: string[] }[] = []
  let totalChunks = 0
  for (const filePath of filePaths) {
    const suffix = extname(filePath).toLowerCase()
    let content: string | null = null
    if (TEXT_SUFFIXES.has(suffix)) {
      try {
        content = deps.fs.readFileSync(filePath)
      } catch {
        continue
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) continue
    } else if (SIDECAR_SUFFIXES.has(suffix) && deps.extractDocument) {
      try {
        content = (await deps.extractDocument(filePath)).text
      } catch {
        continue // binary documents are optional cargo during indexing
      }
    } else {
      continue
    }

    const hash = hashContent(content)
    const existing = cache.entries[filePath]
    if (existing !== undefined && existing.hash === hash) {
      freshPaths.add(filePath)
      totalChunks += existing.chunks.length
      continue
    }

    const texts = chunkText(content)
    if (texts.length === 0 || totalChunks + texts.length > MAX_TOTAL_CHUNKS) {
      // Unchanged entries for dropped files are swept below via freshPaths.
      continue
    }
    totalChunks += texts.length
    pending.push({ filePath, hash, texts })
    freshPaths.add(filePath)
  }
  // Anything not seen in this walk (or kept above) is stale — dropped.
  for (const key of Object.keys(cache.entries)) {
    if (!freshPaths.has(key)) delete cache.entries[key]
  }

  // Pass 2 — embed everything pending, in batches, then fold into the cache.
  if (pending.length > 0) {
    const texts = pending.flatMap((file) => file.texts)
    const vectors: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH)
      const batchVectors = await deps.embedTexts(batch)
      if (!Array.isArray(batchVectors) || batchVectors.length !== batch.length) {
        throw new Error('The embedding service returned the wrong number of vectors.')
      }
      vectors.push(...batchVectors)
    }
    let cursor = 0
    for (const file of pending) {
      const chunks: CacheChunk[] = []
      for (const text of file.texts) {
        chunks.push({ text, vector: vectors[cursor] })
        cursor += 1
      }
      cache.entries[file.filePath] = { hash: file.hash, chunks }
    }
    saveCache(deps.cachePath, cache)
  }

  // Pass 3 — embed the query and rank every cached chunk by cosine similarity.
  // Validated like Pass 2: a missing/short query vector used to explode later
  // as a cryptic TypeError inside cosine() instead of the honest copy above.
  const queryVectors = await deps.embedTexts([query])
  const queryVector = queryVectors[0]
  if (
    !Array.isArray(queryVectors) ||
    queryVectors.length !== 1 ||
    !Array.isArray(queryVector) ||
    queryVector.length === 0
  ) {
    throw new Error('The embedding service returned the wrong number of vectors.')
  }
  const ranked: { filePath: string; chunk: CacheChunk }[] = []
  for (const [filePath, entry] of Object.entries(cache.entries)) {
    for (const chunk of entry.chunks) ranked.push({ filePath, chunk })
  }
  // A stale cache (older model dims) must fail honestly, not rank NaN.
  for (const { chunk } of ranked) {
    if (!Array.isArray(chunk.vector) || chunk.vector.length !== queryVector.length) {
      throw new Error('The embedding service returned an unexpected response.')
    }
  }
  return ranked
    .map(({ filePath, chunk }) => ({ filePath, chunk, score: cosine(queryVector, chunk.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ filePath, chunk, score }) => ({
      path: relative(workspaceRoot, filePath) || filePath,
      snippet: snippetOf(chunk.text),
      score: Math.round(score * 1000) / 1000
    }))
}

/** Cache path for a workspace: userData/semantic-index/<sha1(root)>.json.
 * Kept here so chat.ts needs only the userData dir (agent tree stays
 * Electron-free). */
export function cachePathForWorkspace(userDataDir: string, workspaceRoot: string): string {
  const key = createHash('sha1').update(workspaceRoot, 'utf8').digest('hex')
  return join(userDataDir, 'semantic-index', `${key}.json`)
}
