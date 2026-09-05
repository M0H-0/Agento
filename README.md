# Agento

![Platform](https://img.shields.io/badge/platform-Windows_10%20%7C%2011-blue)
![Desktop](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-24_LTS-339933?logo=nodedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![Status](https://img.shields.io/badge/status-under_active_development-orange)

**A local-first, general-purpose desktop AI agent for people who don't live in a terminal.**

Agento works on your documents, files, and folders: give it a plain-language instruction and it shows you a plan, asks before doing anything risky, shows every action in plain words, verifies its own work, and lets you undo anything it touched. It runs entirely on your machine — your data never passes through any server except the model provider you chose. Built for Windows first.

> Graduation project, built to production standards. **Under active development** — the chat core works today; the agent core (plans, approvals, snapshots, tools) is landing next. See [PROGRESS.md](PROGRESS.md).

## Why Agento is different

1. **A trust layer, not just a chat box.** Every action passes through intent classification, a per-step risk gate, a visible plan, explicit approval for risky operations, and post-hoc completion verification — with a measurable evaluation harness behind it. This is the dissertation's core contribution.
2. **Codex/ZCode cleanliness for everyone.** The interaction model of a modern agent — streaming answers, collapsible action cards, a live task plan — applied to everyday documents and folders, in plain language with no code view anywhere.
3. **Local-first and private.** No backend of ours, no accounts, no telemetry. API keys are stored encrypted on-device. Optional fully-local models via Ollama.

## Features

**Working today**

- Real streaming chat on your API keys — **Google AI Studio** and **Groq** (free-tier friendly), switchable in Settings; more providers planned
- **Sessions** with a sidebar — titles, ordering, and full history persist across restarts (SQLite, WAL mode)
- **Stop button** — aborts a run end-to-end and keeps the partial reply; sessions stay clean and resumable
- **Token usage per session** — recorded locally and shown in the session list
- Encrypted key storage (Electron `safeStorage` / Windows DPAPI) — keys never leave the machine except to the provider endpoint
- Honesty-first failure handling — provider, persistence, and setup failures render as visible sentences, never swallowed

**The v1 target** ([docs/01-product-spec.md](docs/01-product-spec.md))

- Reads, edits, converts, and summarizes documents (`.docx .pdf .pptx .xlsx .csv .md .txt`) via Docling
- Organizes files in bulk ("move all invoices into `Finance/2026`") — one approval, snapshots, undo
- One-shot autonomy: one instruction → planned, executed end-to-end, interrupting only for risky steps
- Web research: fetch and summarize pages; optional search-API integration
- Undo every file change, per change or all at once
- Local models via Ollama

## Quick start

**Prerequisites:** [Node.js 24 LTS](https://nodejs.org/) · npm (bundled) · Python 3.12 + [uv](https://docs.astral.sh/uv/) *(optional today — powers the intelligence sidecar; chat works without it and the status dot reflects its health)*

```powershell
git clone <repo-url> agento
cd agento\app
npm install
npm run dev
```

Then open **Settings → Providers**, paste an API key (Google AI Studio or Groq), pick a model, and start chatting. Keys are stored encrypted in `%APPDATA%/Agento`.

> Development scripts work in both PowerShell and Git Bash. Windows is the primary target; long paths, Unicode names, and drive letters are normal inputs.

## Development

| Command | Where | What |
|---|---|---|
| `npm run dev` | `app/` | Dev app (electron-vite) |
| `npm run typecheck` | `app/` | TypeScript, main + renderer |
| `npm run lint` | `app/` | ESLint (+ prettier rules) |
| `npm run build:win` | `app/` | NSIS installer via electron-builder |
| `uv run pytest` | `services/intelligence/` | Sidecar tests |

Quality gates for every change: typecheck, lint, and the sidecar tests green; the relevant acceptance criteria in [PROGRESS.md](PROGRESS.md) ticked only when genuinely met.

## How it's built

Deliberately **thin own codebase assembled from open source**, so most of the code is maintained by someone else:

| Part | Choice |
|---|---|
| UI | **assistant-ui** (MIT) in an Electron shell — React 19; Tailwind + shadcn/ui tokens arrive with the design-system phase (M1.6) |
| Agent loop | **Vercel AI SDK v5** (`ai`) — streaming, tool calling, multi-provider by API key |
| Tool ecosystem | **Model Context Protocol** client (planned) |
| Documents & trust layer | Python **FastAPI** sidecar with **Docling** parsing + the intelligence endpoints (`127.0.0.1:7891`, never leaves the machine) |
| Storage | SQLite (`better-sqlite3` + Drizzle) — sessions, usage, snapshots, undo |

The full, pinned list with licenses lives in **[STACK.md](STACK.md)** — that file and [AGENTS.md](AGENTS.md) are binding for anyone (human or AI) working on this repo.

## Project structure

```
agento/
├── app/                        # The Electron app (electron-vite)
│   └── src/
│       ├── main/               # Node side: chat pipeline, storage, IPC, settings
│       ├── preload/            # Typed contextBridge — the ONLY renderer bridge
│       └── renderer/           # React UI (assistant-ui)
├── services/intelligence/      # Python sidecar: FastAPI + Docling + trust layer + eval
├── docs/                       # Specs 01–08 (+ archive/)
└── AGENTS.md · STACK.md · PROGRESS.md
```

## Privacy & security

- **Local-first:** no accounts, no telemetry, no update phone-home — the complete network egress inventory is four lines and documented in [docs/06](docs/06-security-and-permissions.md) §8.
- **Encrypted keys:** provider API keys are sealed with OS-level encryption (DPAPI on Windows), decrypted only in the main process, on demand.
- **Safety by code, not prompts:** every file mutation goes through a registry wrapper that enforces validation → sandboxing → risk → approval → snapshot → execute. No shell/terminal tool exists or may be added.

## Documentation

| File | Contents |
|---|---|
| [AGENTS.md](AGENTS.md) | **Start here if you're an agent.** Hard rules, layout, fallback ladder, definition of done |
| [STACK.md](STACK.md) | The pinned stack: every package, role, license, "do not substitute" list |
| [PROGRESS.md](PROGRESS.md) | Milestones M0–M6 broken into 51 half-day sub-phases with acceptance criteria — the build tracker |
| [docs/01-product-spec.md](docs/01-product-spec.md) | Vision, users, feature priorities, non-goals, success criteria |
| [docs/02-architecture.md](docs/02-architecture.md) | Process model, the connection map (how every OSS part wires together), reuse ledger, degradation, packaging |
| [docs/03-agent-core.md](docs/03-agent-core.md) | Agent loop, tool registry, tools + risk tiers, snapshots & undo, storage schema, system prompt |
| [docs/04-ui-spec.md](docs/04-ui-spec.md) | assistant-ui-based UI: layout, cards with before/after excerpts, plan/approval/changes panels, design system (§8: tokens, scrollbars, markdown, motion) |
| [docs/05-intelligence-service.md](docs/05-intelligence-service.md) | Python sidecar: endpoint contracts, LLM-prompted v1, rule table, Docling, eval harness & thesis metrics |
| [docs/06-security-and-permissions.md](docs/06-security-and-permissions.md) | Risk model, approval flow, sandboxing, prompt-injection defenses, secrets, network egress |
| [docs/07-testing-and-demo.md](docs/07-testing-and-demo.md) | Testing strategy, manual checklist, defense demo script |
| [docs/archive/](docs/archive/) | Pre-Agento planning docs ("LocalMind") — superseded, historical only |

## Ground rules for contributors (including AI agents)

- `STACK.md` is the law — no new or substitute dependencies without updating it in the same commit.
- The renderer never touches the filesystem or network; all capability crosses the typed preload bridge.
- Every file mutation goes through the tool registry wrapper — snapshot and approval are code-enforced, never prompted.
- No shell/terminal tool, no code-view UI, no AGPL/GPL dependencies, no copying code from unlicensed repositories.
- Update `PROGRESS.md` as you complete work; log deviations in its Devlog.

## License

Not yet published under an OSS license — a permissive one (MIT or Apache-2.0) will be added with the first public release. All third-party dependencies are permissively licensed (MIT / Apache-2.0 / BSD / ISC) per [STACK.md](STACK.md).
