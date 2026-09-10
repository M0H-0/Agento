# AGENTS.md — Rules for Coding Agents Working on Agento

**Read this before doing anything. It overrides your defaults.**

Agento is a **local-first desktop AI agent for Windows** (Electron): plain-language file/document work with plan → approve → execute, snapshot undo, and verification. **Not a coding agent:** no terminal/shell tool, no git integration, no code/diff view. Users are everyday people.

Specs live in `docs/01–08`; `PROGRESS.md` (current sub-phase + Devlog) is what you work through. `STACK.md` is the dependency law. `docs/archive/` is historical — never edit it.

## Commands (exact)

Run JS commands from `app/`, Python commands from `services/intelligence/`:

```powershell
cd app
npm run dev                  # electron-vite dev window
npm run typecheck             # node (main+preload) AND web (renderer); or :node / :web alone
npm run lint                  # eslint (+ prettier rules)
npm test                      # vitest run (all)
npx vitest run src/main/agent/<name>.test.ts   # single test file
```

```powershell
cd services\intelligence
uv run pytest                 # sidecar tests
uv run pytest tests/<name>.py -q               # single test file
```

Gate for done: `npm run typecheck && npm run lint && npm test` (in `app/`) + `uv run pytest`. Dev scripts must work in **both PowerShell and Git Bash**; verify the gate in both when touching shared code (PROGRESS precedent). Never `cd` inside chained commands — one `workdir` per call.

## Architecture (what filenames don't tell you)

- **One JS package, no workspaces:** `app/` is the whole Electron app (`electron-vite`). Python sidecar is unpackaged (`[tool.uv] package = false`) — it resolves via cwd, not install.
- `app/src/main/` is the entire backend (agent loop, tools, sandbox, snapshots, SQLite, sidecar spawn, settings). `app/src/main/agent/` **must not import Electron** — plain Node TS only; window/lifecycle stays in `app/src/main/index.ts`.
- `app/src/preload/` (`index.ts` + `index.d.ts`) is the **only** renderer bridge (`window.agento`, typed invokes + `chat:part` / `agent:event` pushes). Renderer never touches `ipcRenderer`, fs, network, or providers.
- **Types are triplicated — keep in sync:** main Zod schema (`src/main/ipc/`) + renderer mirror (`src/renderer/src/chat/agent-events.ts`) + preload TS types. IPC or sidecar contract changes update **code + `docs/03`/`docs/05` in the same commit**.
- **Sidecar contract** (`services/intelligence/`, FastAPI on `127.0.0.1:7891`): spawned as `uv run uvicorn agento_intelligence.main:app --port 7891` with **cwd = `services/intelligence/`**; per-launch random token in child env `AGENTO_INTELLIGENCE_TOKEN`, sent as `X-Agento-Token` on every request via the single `sidecarFetch` helper. All endpoints (incl. `/health`) 403 without it; unset env fails closed. Never send LLM keys to Python — summarization runs TS-side.
- **Storage:** schema of record is `docs/03 §8`; code source is `app/src/main/storage/schema.ts`; generate with `npx drizzle-kit generate`, commit the SQL in `app/drizzle/`; migrations apply at startup via the better-sqlite3 migrator. SQLite runs WAL mode.
- **better-sqlite3 is Electron-ABI:** `postinstall` runs `electron-builder install-app-deps`. It **cannot load under vitest** — unit-test agent logic with in-memory stores / injected facades (M2.2/M2.8 precedent); durable DB round-trips belong in the Electron-harness e2e, not plain vitest.
- **vitest scope:** `environment: node`, `include: ['src/main/**/*.test.ts']` only. No DOM tests without a new project/environment decision.

## Hard product rules (don't negotiate these)

1. **Mutations go through the registry** (`app/src/main/agent/registry.ts`): validate → sandbox → risk → approval → **snapshot** → execute. Tool bodies never call `fs` directly — they use the injected `WorkspaceFs` facade. See `docs/03` §5/§7.
2. **No shell tool.** None may be added (`docs/06` §5).
3. **No code/diff view anywhere.** Changes render as plain-language before/after excerpts (`excerptOf`: 8-line/600-char caps); `MAX_TOOL_OUTPUT_BYTES` is 8 KB. Never add a diff renderer (`docs/04` §3.1).
4. **UI fallback ladder** (`docs/04` §4): assistant-ui primitives first → copy-paste from **prompt-kit (MIT, primary)**; AI Elements is pattern-reference only → fresh implementation from notes for `Haleclipse/CodexDesktop-Rebuild` (unlicensed: read, never copy, never paste into prompts, no OpenAI branding). Every adopted/copied component gets a `STACK.md` row (if it pulls a dep) + a `docs/04` §4 log line in the same commit.
5. **STACK.md is law.** No new/substitute deps without a `STACK.md` row in the same commit + a `PROGRESS.md` Devlog line. Lockfiles (`app/package-lock.json`, `services/intelligence/uv.lock`) are the version truth — never hand-bump majors. All deps permissive only (MIT/Apache-2.0/BSD/ISC); AGPL/GPL banned.
6. **Windows-first.** All paths via `node:path`; long paths, Unicode names, drive letters, junctions are normal inputs. Sandbox: lexical containment → realpath walk of existing components (`lstatSync`, both separators) → mode policy (reads may follow outside links, writes refuse) → protected-name deny list; ELOOP and escapes are plain-language refusals, never hangs (`docs/06` §4). Bridge shows **relative paths only** — the absolute workspace root never crosses IPC.
7. **Workflow:** work the **current `PROGRESS.md` sub-phase top-to-bottom**, tick a box only when verifiably true (ran the thing), move nothing out of order, append a dated Devlog line (`YYYY-MM-DD — what/why — who`) for any deviation. Never-cut items: M3 trust loop, eval harness, snapshot/undo.

## Doc map

| Task | Read first |
|---|---|
| Product, scope, users | `docs/01-product-spec.md` |
| Wiring, process model, packaging | `docs/02-architecture.md` |
| Agent loop, tools, snapshots, storage schema, system prompt | `docs/03-agent-core.md` |
| Any UI work | `docs/04-ui-spec.md` |
| Python sidecar (endpoints, classifiers, Docling, eval) | `docs/05-intelligence-service.md` |
| Risk, approvals, sandbox, secrets | `docs/06-security-and-permissions.md` |
| Testing, eval harness, demo script | `docs/07-testing-and-demo.md` |
| Phase order, parallelism, cut line, risks | `docs/08-roadmap.md` |
| What to do next / what's blocked | `PROGRESS.md` |
