# Agento

**A local-first, general-purpose desktop AI agent for people who don't live in a terminal.**

Agento works on your documents, files, and folders: give it a plain-language instruction and it shows you a plan, asks before doing anything risky, shows every action in plain words, verifies its own work, and lets you undo anything it touched. It runs entirely on your machine — your API keys and data never pass through any server except the model provider you chose. Built for Windows first.

> Graduation project, built to production standards. Status: **specification phase** (no code yet).

## The three ideas that make Agento stand out

1. **A trust layer, not just a chat box.** Every action passes through intent classification, a per-step risk gate, a visible plan, explicit approval for risky operations, and post-hoc completion verification — with a measurable evaluation harness behind it. This is the dissertation's core contribution.
2. **Codex/ZCode cleanliness for everyone.** The interaction model of a modern agent — streaming answers, collapsible action cards, a live task plan — applied to everyday documents and folders, in plain language with no code view anywhere.
3. **Local-first and private.** No backend of ours, no accounts, no telemetry. API keys are stored encrypted on-device. Optional fully-local models via Ollama.

## How it's built (the short version)

Deliberately **thin own codebase assembled from open source**, so most of the code is maintained by someone else:

| Part | Choice |
|---|---|
| UI | **assistant-ui** (MIT) in an Electron shell — React 18, Tailwind, shadcn/ui |
| Agent loop | **Vercel AI SDK v5** (`ai`) — streaming, tool calling, multi-provider by API key |
| Tool ecosystem | **Model Context Protocol** client |
| Documents & trust layer | Python **FastAPI** sidecar with **Docling** parsing + the intelligence endpoints |
| Storage | SQLite (`better-sqlite3` + Drizzle) — sessions, snapshots, undo |

The full, pinned list with licenses lives in **[STACK.md](STACK.md)** — that file and [AGENTS.md](AGENTS.md) are binding for anyone (human or AI) working on this repo.

## Documentation map

| File | Contents |
|---|---|
| [AGENTS.md](AGENTS.md) | **Start here if you're an agent.** Hard rules, layout, fallback ladder, definition of done |
| [STACK.md](STACK.md) | The pinned stack: every package, role, license, "do not substitute" list |
| [PROGRESS.md](PROGRESS.md) | Milestones M0–M6 broken into 49 half-day sub-phases (M0.1…M6.8) with acceptance criteria — the build tracker |
| [docs/01-product-spec.md](docs/01-product-spec.md) | Vision, users, feature priorities, non-goals, success criteria |
| [docs/02-architecture.md](docs/02-architecture.md) | Process model, the connection map (how every OSS part wires together), reuse ledger, degradation, packaging |
| [docs/03-agent-core.md](docs/03-agent-core.md) | Agent loop, tool registry, tools + risk tiers, snapshots & undo, storage schema, system prompt |
| [docs/04-ui-spec.md](docs/04-ui-spec.md) | assistant-ui-based UI: layout, cards with before/after excerpts, plan/approval/changes panels, theming |
| [docs/05-intelligence-service.md](docs/05-intelligence-service.md) | Python sidecar: endpoint contracts, LLM-prompted v1, rule table, Docling, eval harness & thesis metrics |
| [docs/06-security-and-permissions.md](docs/06-security-and-permissions.md) | Risk model, approval flow, sandboxing, prompt-injection defenses, secrets, network egress |
| [docs/07-testing-and-demo.md](docs/07-testing-and-demo.md) | Testing strategy, manual checklist, defense demo script |
| [docs/archive/](docs/archive/) | Pre-Agento planning docs ("LocalMind") — superseded, historical only |

## What it does (v1)

- Chat-style sessions in a chosen **workspace folder**
- Reads, edits, converts, and summarizes **documents** (`.docx .pdf .pptx .xlsx .csv .md .txt`)
- **Organizes files in bulk** ("move all invoices into `Finance/2026`") — one approval, snapshots, undo
- **One-shot autonomy:** one instruction → planned, executed end-to-end, interrupting only for risky steps
- **Web research**: fetch and summarize pages; optional search-API integration
- **Undo** every file change, per change or all at once
- Multiple **model providers by API key** (free-tier friendly defaults documented), plus local models via Ollama

## Ground rules for contributors (including AI agents)

- `STACK.md` is the law — no new or substitute dependencies without updating it in the same commit.
- The renderer never touches the filesystem or network; all capability crosses the typed preload bridge.
- Every file mutation goes through the tool registry wrapper — snapshot and approval are code-enforced, never prompted.
- No shell/terminal tool, no code-view UI, no AGPL/GPL dependencies, no copying code from unlicensed repositories.
- Update `PROGRESS.md` as you complete work; log deviations in its Devlog.
