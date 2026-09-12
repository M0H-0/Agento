# 02 — Architecture & Integration Map

Agento is a **thin codebase assembled from open source**. This document's job: show exactly which OSS part does what, and — the part most docs skip — **exactly how each piece connects to the next**, with real wiring snippets. If you can read this document, you can add a feature without guessing at the plumbing.

## 1. Process model

Three cooperating processes on the user's machine. Nothing else exists.

```
┌────────────────────────────────────────────────────────────────────┐
│  Renderer (React + assistant-ui)                                   │
│  Thread · Composer · action cards · PlanPanel · ApprovalDialog     │
│  — no fs, no network, no providers. Renders state, sends intents.  │
└───────────────▲────────────────────────────────────────────────────┘
                │ typed IPC via preload contextBridge (zod-validated)
┌───────────────┴────────────────────────────────────────────────────┐
│  Main process (Electron, Node 24)  —  the entire "backend"         │
│  src/main/agent/   AI SDK v5 loop · tool registry · sandbox        │
│  src/main/storage/ better-sqlite3 + Drizzle (sessions, snapshots)  │
│  src/main/ipc/     contracts · chat transport · event forwarding   │
└──────────────┬─────────────────────────────────┬───────────────────┘
               │ HTTP 127.0.0.1:7891             │ HTTPS (user's key)
┌──────────────▼──────────────────────┐          ▼
│  Intelligence sidecar (Python 3.12) │   Model providers
│  FastAPI · Docling · intent/safety/ │   Google · Groq · OpenRouter
│  verification · eval endpoints      │   OpenAI · Anthropic · Ollama
└─────────────────────────────────────┘
```

There is **one JS package** (`app/`) — no workspace monorepo. The Electron main process *is* the backend; `src/main/agent/` is written as plain Node TypeScript (no Electron imports) so it stays testable and conceptually separate. The Python sidecar is the second project (`services/intelligence/`).

## 2. The connection map

### 2.1 Chat pipeline — renderer ⇄ main ⇄ provider

The most important wire in the app. The AI SDK's UI message stream is forwarded raw across IPC, so assistant-ui's streaming rendering works unchanged even though the model call happens in another process.

```
assistant-ui Thread → useChat (custom IPC transport) → preload → ipcMain
→ main: streamText({ model, system, messages, tools, abortSignal })
→ result.toUIMessageStream()  (async iterable of UI message stream parts)
→ win.webContents.send('chat:part', part)  → renderer transport → assistant-ui

stop: composer Cancel / Esc → useChat aborts the send's AbortSignal
→ renderer transport's abort listener → invoke 'chat:stop' { sessionId }
→ main: Map<sessionId, AbortController> → controller.abort() → streamText stops
```

```ts
// src/main/ipc/chat.ts (main)
ipcMain.handle('chat:send', async ({ sender }, { sessionId, messages }) => {
  const controller = new AbortController();
  activeRuns.set(sessionId, controller);            // chat:stop aborts this
  const result = streamText({ model, system, messages: convertToModelMessages(messages),
                              tools: registry.toAiSdkTools(ctx), abortSignal: controller.signal });
  for await (const part of result.toUIMessageStream()) {
    if (part.type === 'finish') { heldFinish = part; continue; }  // held
    sender.send('chat:part', { sessionId, part });   // UI message stream parts, verbatim
  }
  // persistence completes BEFORE the terminal part goes out
  appendMessage(sessionId, accumulator.toUIMessage());              // full or partial
  sender.send('chat:part', { sessionId, heldFinish });              // natural end
});
ipcMain.handle('chat:stop', ({ }, { sessionId }) => { activeRuns.get(sessionId)?.abort(); });
```

**Wire contract — every run ends with exactly one terminal part:** `finish` (natural end; the provider's own part is *held* and forwarded only after persistence succeeds), `abort` (user stop — the native v5 `{ type: 'abort' }` chunk, sent after the partial reply is persisted; the accumulator's mid-stream-valid `toUIMessage()` snapshot is what gets saved), or `error` (provider failure via the friendly-copy transform, or a persistence failure — a save failure *replaces* the finish/abort terminal, so it is rendered in the thread and never swallowed). The renderer transport closes its stream on the first of these three and treats a stopped run as a normal outcome, never as a provider failure. **One stream per session, enforced main-side:** a `chat:send` for a session with an active run is rejected before anything is persisted (the renderer adds its own in-flight guard, but main — where the streams live — is the authority).

`sessionId` is not sent by the renderer — it lives main-side (a hardcoded placeholder constant until M1.3 introduces real sessions) and is stamped onto every `chat:part` envelope. In M0.3 the `streamText` call is replaced by a canned generator that emits the same ai-v5 `UIMessageChunk` sequence (`start` → `start-step` → `text-start` → `text-delta`×N → `text-end` → `finish-step` → `finish`) with no model call; M1.2 swaps the generator for the real `streamText`.

```ts
// src/renderer/chat/transport.ts (renderer) — AI SDK v5 custom ChatTransport
const ipcTransport: ChatTransport<UIMessage> = {
  sendMessages: async ({ messages, abortSignal }) => {
    // subscribe to 'chat:part' via the preload bridge (window.agento.chat.onPart),
    // invoke window.agento.chat.send({ sessionId, messages }), and enqueue every part
    // verbatim into a ReadableStream<UIMessageChunk>; close on the first
    // finish | error | abort part. abortSignal gets a listener that turns it
    // into window.agento.chat.stop({ sessionId }) — a stopped run is NOT a
    // failed run. A second send while a run is active is rejected here.
  },
  reconnectToStream: async () => null,                  // nothing to reconnect locally
};
const chat = useChat({ transport: ipcTransport });      // @ai-sdk/react
const runtime = useAISDKRuntime(chat);                  // @assistant-ui/react-ai-sdk
<AssistantRuntimeProvider runtime={runtime}>{/* <Thread /> etc. */}</AssistantRuntimeProvider>
```

> Exact function signatures evolve — verify against the current `ai` v5 and assistant-ui docs during M0/M1 and record findings in the Devlog. The *shape* above is the stable part: stream parts cross IPC verbatim. M0 proves this wire before anything else: the Thread runs on the real IPC transport with a canned echo stream from main (no model key needed). Verified against the pinned versions during M0.3: `ChatTransport`/`UIMessage`/`UIMessageChunk` are exported from `ai` (not re-exported by `@ai-sdk/react`); `useChat({ transport })` from `@ai-sdk/react@2.0.253`; and `useAISDKRuntime(chat)` from `@assistant-ui/react-ai-sdk@1.1.21` — that bridge's `useChatRuntime` takes `ChatInit` options (it creates its own `useChat` internally), not a `chat` param.

**Action cards:** assistant-ui renders tool parts with per-tool UIs. Each tool in the registry registers a card component mapping `toolName → component` (M2.4 ships this as `setToolUI` on the runtime's tools API — `useAssistantApi().tools()` — since the installed assistant-ui 0.11.56 line deprecated the older hook form):

```tsx
const tools = useAssistantApi().tools()
tools.setToolUI('edit_file', BeforeAfterCard)
```

### 2.2 Trust pipeline — registry → intelligence service → UI

Model-driven approvals are **not** used (`needsApproval` stays off); the gate is mechanical, in the registry wrapper, so the model can't bypass it:

```
tool execute (risk ≥ 2) → wrapper → POST /safety/classify → risk ≥ 2?
  → emit approval/requested over 'agent:event' → renderer ApprovalDialog
  → user decision → 'approval:respond' IPC → wrapper resolves its promise
  → snapshot → execute → POST /completion/verify → verification event
```

The wrapper blocks on a plain promise; the loop is simply paused while the dialog shows. Two parallel event flows reach the renderer: the *chat stream* (§2.1, rendered by assistant-ui) and *agent events* (plan/notice/usage/state — rendered by our custom panels, fed into zustand). See `docs/03-agent-core.md` §4 for both contracts.

### 2.3 MCP — community tools, one pipeline

`@modelcontextprotocol/sdk` client runs in the main process. At session start it connects configured servers, lists their tools, and wraps each as a registry tool: zod input schema from the MCP tool's JSON schema, risk floor 1 (configurable per server, never above 2 — nothing third-party is pre-trusted for destructive ops), plain-language title from the server + tool name. From there MCP tools are indistinguishable from built-ins: same cards, same approvals, same snapshots.

### 2.4 Sidecar — spawn, health, auth, degradation

Electron main spawns `uv run uvicorn agento_intelligence.main:app --port 7891` (dev) or a packaged equivalent (§5), generates a per-launch random token, and sends it as `X-Agento-Token` on every request. `/health` is polled during startup (15 s ceiling). If the sidecar never comes up, everything in `src/main/agent/` keeps working — the TS-mirrored rule table answers safety queries and verification is skipped with honest "not verified" badges (`docs/05` §6, `docs/06` §1).

### 2.5 Storage — SQLite in the main process

`better-sqlite3` + Drizzle, WAL mode, `drizzle-kit` migrations run at startup against `%APPDATA%/Agento/agento.db`. Repositories (`src/main/storage/`) are the only code that touches the DB. Schema and snapshot/undo semantics: `docs/03-agent-core.md` §7–8.

### 2.6 Documents & conversions — where each format gets done

| Task | Where | How |
|---|---|---|
| Parse `.pdf .docx .pptx .xlsx .csv .html` | sidecar | Docling `POST /documents/parse` → markdown + structure |
| Edit `.md` / `.txt` | main | registry edit tools directly |
| Edit `.docx` | sidecar | `python-docx` text round-trip `POST /documents/edit` |
| `.md/.html → .pdf` | main | render HTML in a hidden Electron window → `webContents.printToPDF` |
| `.xlsx → .csv`, `.docx → .md` | sidecar | Docling export endpoints |
| Search files | main | spawns the `@vscode/ripgrep` binary |

## 3. Reuse ledger — what OSS gives us vs. what we write

| OSS part | Gives us | We write around it |
|---|---|---|
| assistant-ui | Message list, composer, streaming markdown, runtime, tool-UI slots | App shell, custom panels (Plan/Changes/Approval), tool cards, before/after card |
| `ai` v5 + provider packages | The loop: streaming, tool calling, retries, provider abstraction | System prompt, registry, sandbox, snapshots, verification wiring |
| MCP SDK | Thousands of community tools | The wrapping into our risk pipeline |
| Docling | Best-in-class document parsing | Endpoint glue, edit/convert workflows |
| FastAPI/Pydantic | Typed HTTP service | The three classifier endpoints, rule table, eval scripts |
| better-sqlite3 + Drizzle | Typed storage + migrations | Schema, repositories, snapshot engine |
| Electron + electron-vite + builder | Shell, IPC, safeStorage, printToPDF, NSIS | Window/menu code, sidecar lifecycle, settings |
| shadcn/ui + Tailwind + lucide | Primitives + tokens | Our components on top |
| undici + readability | Page fetching + extraction | The `web_fetch` tool wrapper |

Everything in the right column is small, documented here, and owned by us. That is the whole product.

## 4. Startup sequence

1. Resolve data dir (`%APPDATA%/Agento/`) → open SQLite → run migrations
2. Generate per-launch sidecar token → spawn sidecar → begin `/health` polling
3. Create window; renderer boots, subscribes to IPC channels
4. Renderer reflects mode: **Full** (sidecar OK) or **Degraded** (banner) — 15 s ceiling, never blocks the window
5. First-run without an API key → onboarding, not an error state

## 5. Packaging & distribution

- **Target: Windows first.** electron-builder → NSIS installer; app name `Agento`, appId `com.agento.app`. **Per-user install** (`%LocalAppData%`, no admin prompt, user data in `%APPDATA%` survives uninstall), **unsigned** (expect the SmartScreen click-through on a clean machine). M6.6 shipped this.
- **Clean-machine sidecar (M6.6, "download on first run").** The installer cannot assume Python or uv, so it ships both seeds and downloads the rest once:
  - *In the installer* (`extraResources` → `<resources>/`): the sidecar sources (`sidecar/agento_intelligence` + `pyproject.toml` + `uv.lock`, no `.venv`/tests), the drizzle migrations (`drizzle/`), and a pinned `uv` binary (`bin/uv.exe`, fetched by `npm run fetch:uv`, version = the dev toolchain, sha256 on record in the Devlog).
  - *On first launch (packaged only):* `src/main/sidecar-paths.ts` resolves the packaged layout, `src/main/sidecar-bootstrap.ts` runs `uv python install 3.12` + `uv sync --frozen` into `<userData>/sidecar/` (venv + caches + marker file), then the normal `startSidecar` spawns through the pinned binary with `UV_OFFLINE=1`. The window opens FIRST — the status dot shows setup progress, file tools work immediately, document tools answer honestly offline until healthy. Any bootstrap failure pins the dot red with a plain-language retry-on-restart message, never a crash (docs/05 §6).
  - *The ~90 MB fastembed model* stays on-demand (pinned `<userData>/fastembed` cache, boot-time warmup); first semantic search downloads it once.
- Dev layout is unchanged (`uv` from PATH, `services/intelligence` beside `app/`); `resolveSidecarCwd`/`resolveMigrationsFolder`/`resolveUvBinary` prefer the packaged copy only when it exists, so a damaged install degrades honestly. Teardown is the existing `taskkill /T /F` tree-kill (verified against the packaged chain: one call reaps uv→uvicorn→python and frees 7891).
- Auto-update: out of scope for v1.

## 6. Decision log

| # | Decision | Rationale |
|---|---|---|
| ADR-1 | Agent loop = Vercel AI SDK v5; no embedded agent CLI/engine | Light, API-key-based, per project direction; SDK is a library we own on top of |
| ADR-2 | UI = assistant-ui; fallback = read-and-rebuild from CodexDesktop-Rebuild (no verbatim code, AGENTS.md rule 4) | Purpose-built MIT agent UI; fallback covers gaps without license risk |
| ADR-3 | One JS package; Electron main process is the backend | Simplest possible surface for agent-driven development; `src/main/agent/` stays Electron-free for testability |
| ADR-4 | Trust layer = separate Python sidecar with HTTP contract | Docling is Python; the thesis layer stays isolated, evaluable, swappable |
| ADR-5 | Approvals/snapshots are framework-enforced (registry wrapper), never model-prompted | A prompt can be ignored; a wrapper cannot |
| ADR-6 | SQLite snapshots, not shadow-git | Users' folders aren't git repos; simpler restore semantics |
| ADR-7 | Before/after excerpts, no diff renderer | Product decision (no code view) + one less dependency |
| ADR-8 | MCP for third-party tools, through the same risk pipeline | Ecosystem breadth; zero new trust paths |
| ADR-9 | npm, no workspaces; Windows-first | Fewest failure modes for free-tier agents on Windows |
