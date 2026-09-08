# AGENTS.md — Rules for Coding Agents Working on Agento

**Read this file before doing anything. It overrides your defaults.**

Agento is a **local-first, general-purpose desktop AI agent** for Windows: it works on documents, files, and folders — reading, editing, organizing, converting, summarizing, and doing web research — with a visible plan, per-step risk approvals, completion verification, and snapshot-based undo. It is **not a coding agent**: no terminal, no Git integration, no IDE views, no code-focused UI. Users are everyday people, not developers.

Everything about the intended product lives in `docs/` (map below). `PROGRESS.md` tracks what is done and what comes next.

## The stack is fixed — see [STACK.md](STACK.md)

`STACK.md` lists every package this project uses, with role and license. **That list is the law:**

- Never introduce a new dependency, and never substitute an equivalent (e.g., do not swap assistant-ui for another chat UI, `ai` v5 for v4, Docling for another parser). If a dependency is genuinely required, **update `STACK.md` in the same commit** and note why in `PROGRESS.md` → Devlog.
- Versions: the lockfiles (`package-lock.json`, `uv.lock`) are the source of truth for exact versions. Do not hand-bump majors.

## Repository layout

```
agento/
├── AGENTS.md · STACK.md · PROGRESS.md · README.md
├── docs/                      # specs (01–08) + archive/ (historical, do not edit)
├── app/                       # THE JS/TS project — one Electron app (electron-vite)
│   └── src/
│       ├── main/              # Node side = the entire "backend": agent loop, tools,
│       │   ├── agent/         #   sandbox, snapshots, verification (src/main/agent)
│       │   ├── storage/       #   SQLite schema + repos (src/main/storage)
│       │   └── ipc/           #   typed channel contracts (src/main/ipc)
│       ├── preload/           # contextBridge — the ONLY bridge to the renderer
│       └── renderer/          # React + assistant-ui UI
│           └── src/components/  # custom components (PlanPanel, ChangesPanel, …)
└── services/intelligence/     # Python sidecar: FastAPI + Docling + trust layer + eval
```

## Hard rules

1. **Boundary discipline.** The renderer never touches the filesystem, network, or model providers. All capability lives in `src/main/` and crosses via the typed preload bridge. `src/main/agent/` must not import Electron — it is plain Node TypeScript (window/lifecycle code stays in `src/main/index.ts`).
2. **Mutations go through the registry.** Every file-modifying tool executes through the tool registry wrapper (validate → sandbox → risk → approval → **snapshot** → execute). Tool bodies never call `fs` directly. This is the product's core safety guarantee — see `docs/03-agent-core.md` §5 and §7.
3. **No shell tool.** There is no terminal/command execution and none may be added (`docs/06-security-and-permissions.md` §5).
4. **UI fallback ladder** (when the UI needs something assistant-ui doesn't provide):
   1. Compose it from assistant-ui primitives first.
   2. If that truly doesn't cover it, adopt a component from a **licensed shadcn-style registry**: **prompt-kit (MIT) is the primary source; AI Elements (Apache-2.0) is pattern-reference only.** Both are copy-paste registries — any npm dependency a copied component pulls in gets a `STACK.md` row in the same commit. Log every adopted component in `docs/04-ui-spec.md` §4.
   3. If that doesn't cover it either, you may **read** `Haleclipse/CodexDesktop-Rebuild` (GitHub) as a *reference* and **write a fresh implementation** of the behavior: study it, write notes on what it does, then implement from your notes.
   4. **Never** copy code verbatim or near-verbatim from it (the repo has **no license** — all rights reserved), never paste its files into a prompt as generation reference, never use OpenAI's name or branding. Log every such custom component in `docs/04-ui-spec.md` §4.
5. **No code view anywhere.** File changes render as plain-language before/after excerpts (see `docs/04-ui-spec.md` §3.1) — not diffs, not editors, not terminal aesthetics.
6. **Contracts change in one commit.** IPC contracts (`src/main/ipc/`) and the Python contracts (`services/intelligence/`) are documented in `docs/03` and `docs/05`. Any change updates code + doc together.
7. **Windows-first.** All paths via `node:path`; never assume POSIX. Long paths, Unicode names, and drive letters are normal inputs. Dev scripts must work in PowerShell **and** Git Bash.
8. **Update `PROGRESS.md` as you work.** Tick checkboxes when acceptance criteria are genuinely met (run the checks), move nothing out of order, and append a dated Devlog line for any deviation or decision not covered by the docs.
9. **Permissive licenses only.** All JS/TS dependencies must be MIT / Apache-2.0 / BSD / ISC. AGPL/GPL is not allowed (this rule is why Cherry Studio, for example, is rejected). Python side: MIT/BSD/Apache.
10. **Do not edit `docs/archive/`** except never. It is historical record.

## Which doc to read for your task

| Task | Read first |
|---|---|
| Understanding the product, scope, users | `docs/01-product-spec.md` |
| Wiring components together, process model, packaging | `docs/02-architecture.md` |
| Agent loop, tools, snapshots, storage schema, system prompt | `docs/03-agent-core.md` |
| Any UI work | `docs/04-ui-spec.md` |
| The Python sidecar (endpoints, classifiers, Docling, eval) | `docs/05-intelligence-service.md` |
| Anything touching risk, approvals, sandbox, secrets | `docs/06-security-and-permissions.md` |
| Testing, the eval harness, the demo script | `docs/07-testing-and-demo.md` |
| The build plan: phase order, parallelism, cut line, risk register | `docs/08-roadmap.md` |
| What to do next / what's blocked | `PROGRESS.md` |

## Definition of done

Typecheck, lint, and tests pass (`npm run typecheck && npm run lint && npm test` in `app/`; `uv run pytest` in `services/intelligence/`); the relevant `PROGRESS.md` acceptance criteria are met and ticked; docs touched per rule 6 if contracts changed; Devlog updated.
