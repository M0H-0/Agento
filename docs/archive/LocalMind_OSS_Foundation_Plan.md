# LocalMind — Open-Source Foundation Plan

**How to use this document:** Give this to your coding agent *alongside* `LocalMind_Implementation_Guide.md`. That guide defines *what* to build (the 5 components, the API contracts, the UI spec). This document tells the coding agent *what not to build from scratch*, and which specific open-source projects to install, fork, or reference for each piece instead. Where this document and the original guide disagree on approach, this document wins — the API contracts, SQLite schema, and UI spec in the original guide stay unchanged either way, so nothing downstream breaks.

All recommended projects use permissive licenses (Apache 2.0 / MIT) — safe for a commercial desktop product, no copyleft obligations.

---

## Stack at a glance

| Component | Original plan | Recommended foundation | License |
|---|---|---|---|
| Agent loop, plan/approve/checkpoint | build from scratch | **Cline** engine (via its SDK) | Apache 2.0 |
| Desktop UI shell | build from scratch | **AnythingLLM** (fork/reference) or Cline's own `webview-ui` components | MIT / Apache 2.0 |
| Document read/edit/convert | python-docx + PyMuPDF + python-pptx + openpyxl, wired by hand | **Docling** (+ `docling-mcp`) | MIT |
| Web research tool | build from scratch | **browser-use** | MIT |
| File organization UX | build from scratch | reference **llama-fs**'s design (don't depend on the repo directly) | MIT |
| Intent / safety / completion "ML backend" | train 3 custom classifiers before you have data | LLM-prompted v1 + deterministic risk rules, train later on your own logs | — |

---

## 1. Agent Layer — Cline's engine, not a hand-built agent loop

**What it is:** [github.com/cline/cline](https://github.com/cline/cline) — Apache 2.0, 61K+ GitHub stars, 5M+ installs. Originally a VS Code extension ("Claude Dev"), it's grown into an agent engine that also ships as a CLI, a JetBrains plugin, and — critically for you — an **SDK for embedding the same engine in your own app** ("Node.js programmatic agent API and extension exports," per Cline's own docs).

**Why it's the right base:** it already solved, in production, the exact problems Components 2–4 of your guide describe:

| Your spec calls for | Cline already has |
|---|---|
| `create_task_plan` / Task Plan Panel | Plan mode — explores, asks clarifying questions, lays out a strategy before any execution |
| `request_approval` / risk badges / Permission Modal | Per-action approval with configurable auto-approve thresholds by risk category |
| `log_action` + `revert_action` / Revert Timeline / Undo | Checkpoints — automatic shadow-git commits before risky edits, with three restore modes (files only, task only, both) |
| Document Preview split view | Diff view on every file edit, built in |

**How to use it:** don't embed the VS Code extension. Pull in Cline's core engine package via its SDK (check `docs.cline.bot` for the current package name and install steps — this is a newer offering and moves fast, so verify at build time rather than trusting a hardcoded name here) and run it inside your Electron **main process**, which is already Node.js. Your `localmind:*` IPC events map almost 1:1 onto Cline's own plan/approval/checkpoint events — most of Component 2's "LocalMind Planner Tools" become thin adapters over events Cline already emits, not new logic.

**Alternative:** [Anthropic's Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/permissions) (Python and TypeScript). It gives you the same category of primitive — a `canUseTool` callback, permission modes, and `PreToolUse`/`PostToolUse` hooks — but as a lower-level building block rather than a finished product engine. No built-in checkpoint/revert system, so you'd build that part yourself using the `log_action`/`revert_action` SQLite design your guide already specifies. Pick this if you want a single-vendor, minimal-dependency stack and don't mind building checkpoints yourself; pick Cline if you want the plan/approve/checkpoint UX already built and battle-tested.

---

## 2. Desktop UI Shell — fork a reference, don't start from a blank Electron app

**What it is:** [github.com/Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) — MIT, 63K+ stars. Electron + Docker desktop app, document ingestion (PDF/DOCX/etc.), workspaces, built-in agent support, MCP support.

**Why:** it gives you a working Electron main-process setup, a folder/workspace picker pattern, a document preview pane, and a chat UI — a lot of Feature 1 and Feature 3 of your Component 4 spec, already wired to Electron's `dialog.showOpenDialog` and IPC.

**Caution:** AnythingLLM is built for a different user (RAG power-users managing multiple workspaces and vector DBs) and is heavier than LocalMind needs. Treat it as a **skeleton to strip down**, not a final shell — plan to delete the multi-user/vector-DB/workspace-sharing surface area and replace the chat pane with your Task Plan Panel + Permission Modal + Revert Timeline.

**Lighter alternative:** if a full fork feels like more demolition than it's worth, build the Electron shell fresh and instead lift Cline's own `webview-ui` React components (task list rendering, diff viewer, approve/reject buttons) — since you're already depending on Cline's engine, its UI code is Apache-2.0-licensed and designed for exactly this data shape.

---

## 3. Document Tools — Docling instead of 4 separate libraries

**What it is:** [github.com/docling-project/docling](https://github.com/docling-project/docling) — MIT, IBM Research, hosted by the Linux Foundation's LF AI & Data Foundation, 37K+ stars. Parses PDF, DOCX, PPTX, XLSX, HTML, and more into one unified structured document model, with meaningfully better table-structure recognition than general-purpose converters. There's also `docling-mcp`, which exposes Docling as MCP tools directly — worth using if your agent layer speaks MCP.

**Why this beats the original plan:** wiring python-docx, PyMuPDF, python-pptx, and openpyxl separately means four different extraction code paths with four different quirks and failure modes — a classic source of "works on my test file, breaks on the user's real one" bugs. Docling gives `read_document`, `summarize_document`, and the read side of `convert_document` one consistent implementation across every format your guide lists.

**What stays custom:** `edit_document`'s actual editing logic and `organize_files` are workflow logic specific to LocalMind — Docling parses and represents documents, it doesn't decide what to do to them.

---

## 4. Web Research — browser-use instead of a hand-rolled scraper

**What it is:** [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use) — MIT, 100K+ stars, actively maintained, Python. Lets an LLM-driven agent control a real browser (via Playwright) using natural language rather than brittle selectors, and self-heals when page layouts change. Ships an MCP server option too.

**Why:** the `web_research` intent class in your guide needs real browsing (JS-rendered pages, forms, pagination), not just an HTTP GET + HTML parse. Building that robustly — and keeping it robust as sites change — is a maintenance burden this project already carries for you.

---

## 5. File Organization — reference, don't depend

**What it is:** [github.com/iyaja/llama-fs](https://github.com/iyaja/llama-fs) — MIT, ~5.8K stars, a Llama-3-powered self-organizing file manager with a batch mode (propose a full reorganized tree, then apply) and a watch mode (learn your renaming habits live).

**Why reference-only:** it's a hackathon-era project — genuinely useful as a design reference for how to structure the "propose the new file tree, show it, then move on approval" flow your `organize_files` tool needs, but it hasn't seen much recent activity and pulls in dependencies (Groq, AgentOps) you don't need. Read the code for the pattern; don't add it as a package dependency.

---

## 6. ML Backend — the part of your original plan with the most hidden risk

Your guide specifies three trained models: a DistilBERT intent classifier, a distilroberta NLI completion verifier, and a DistilBERT safety classifier — all "trained on a labeled dataset" that doesn't exist publicly. This is the one area where "find an open-source project to fork" doesn't have a clean answer, because nobody has open-sourced a labeled dataset of "user instruction → correct intent class" or "action description → correct risk level" for a general desktop assistant. Training these from scratch on day one means either hand-labeling a dataset yourself before writing a line of product code, or shipping undertrained models.

**Recommended approach — keep your FastAPI contract exactly as specified, change what's inside each endpoint:**

- **`/intent/classify` (v1):** call your LLM with a structured-output prompt ("classify this instruction into one of these 6 categories, return JSON with confidence"). Zero training data required, and this is really just a more capable version of the "stub" your own Development Order step 1 already calls for.
- **`/safety/classify` (v1):** use a **deterministic rule table** — tool name → risk level — as the primary mechanism, not a trained classifier. This is what Cline and the Claude Agent SDK both actually do in production for this exact problem (allow/deny lists and permission tiers, not an ML model), because a safety gate benefits far more from being auditable and predictable than from being "learned." Layer the LLM's judgment on top for edge cases the table doesn't cover, with the rule table's answer as the floor.
- **`/completion/verify` (v1):** either an LLM structured-output judgment ("did this action satisfy the instruction? yes/no + what's missing"), or an **off-the-shelf pretrained NLI cross-encoder** from `sentence-transformers` (e.g. `cross-encoder/nli-distilroberta-base`) — this is a real, already-trained entailment model you can call today with no fine-tuning.
- **Graceful degradation logic from your original spec stays exactly as written** — if a model file is missing, endpoints already fall back to sensible defaults.

**The payoff:** your SQLite `sessions` / `actions` / `task_steps` tables (already in your spec) log every instruction, every action taken, every risk level, and every completion outcome from day one. Once LocalMind has real usage, *that* is your labeled training set — for free, and matched to your actual users' phrasing rather than a generic public dataset. Training real DistilBERT/NLI classifiers becomes a step 10 optimization once you know the LLM-prompted versions are too slow or too expensive at your scale, not a step 1 prerequisite. Many teams find they never need to make the swap.

---

## 7. Revised development order

Supersedes the "Development Order" section of the original guide — same end state, different sequencing to front-load the parts that de-risk everything after them.

1. Stand up Cline's engine headless (no UI yet) against a test workspace folder. Confirm the tool-calling loop, plan mode, and approval flow work before touching Electron.
2. Python ML backend — but implement the LLM-prompted v1 logic from Section 6 directly, not mock JSON. Barely more work than a stub, and gives you a genuinely working intent/safety/completion loop immediately.
3. Wire Docling into `read_document` / `convert_document` / `summarize_document`. Test against real .docx/.pdf/.pptx/.xlsx files, not synthetic ones.
4. Stand up the Electron + React shell (AnythingLLM fork, or fresh + Cline's `webview-ui` components). Wire the `localmind:*` IPC events from your original spec.
5. Task Plan Panel + Permission Modal — thin adapters over Cline's existing plan/approval events.
6. Document Preview, using Docling's structured output.
7. Revert Timeline. **Pick one system of record for undo** — either Cline's shadow-git checkpoints or your own SQLite `actions` log, not both silently duplicating each other. This is a real trap: if both systems think they own "what can be undone," you'll get divergent state the first time a user hits undo.
8. Wire browser-use as the `web_research` tool.
9. Quick Actions bar, workspace picker, drag-and-drop, style polish.
10. Only now — with real session logs already sitting in SQLite from steps 1–9 — decide whether the LLM-prompted classifiers need replacing with trained models for latency or cost reasons.

---

## 8. What still has to be built by hand

To be direct about it: no open-source project does LocalMind's actual product surface. The plain-English rewrapping of every tool call, the specific FastAPI endpoint contracts, the Electron IPC wiring, and the system prompt that keeps the agent from ever showing a non-technical user JSON or a tool name — that's the real work, and it's exactly Components 2–5 of your original guide. The projects above remove the undifferentiated heavy lifting underneath it (agent loop, checkpoints, document parsing, browsing) so your team's time goes into that layer instead of reinventing plumbing.
