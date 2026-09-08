# 08 — Roadmap: The Phased Build Plan

**Relationship to [PROGRESS.md](../PROGRESS.md):** this document is the *plan* — what each phase is, what it delivers, why it sits in this order, and how to parallelize the work across agents. PROGRESS.md is the *tracker* — the checkbox lists, the current-phase marker, and the Devlog. An agent assigned a phase reads both: this page for intent, PROGRESS.md for the exact tasks and acceptance criteria. When this plan and PROGRESS.md disagree, PROGRESS.md wins (it is updated live) — and the disagreement gets a Devlog line.

## 1. Constraints that shaped the plan

- **One developer + many AI coding agents on free tiers.** Work must come in short, well-specified units; every phase ends in something demoable so agents are never mid-air refactoring.
- **Free-tier models are less capable.** Each phase touches a small, documented surface; contracts come from the docs, not from agent memory.
- **Windows-first** development and packaging.
- **Thesis-critical and never cut:** M3 (trust loop) and the eval harness (M4 + M6). Everything else has a cut order (§6).
- **Token thrift:** OSS first everywhere (STACK.md); the plan never schedules "build X from scratch" where an OSS piece exists.

## 2. The phases at a glance

| Phase | Theme | Ships | Effort (calendar) | Depends on |
|---|---|---|---|---|
| M0 | Skeleton | Everything boots and talks | week 1 | — |
| M1 | Chat on real models | Streaming chat, sessions, persistence | week 2 | M0 |
| M2 | The agent touches files | Tools, sandbox, snapshots, undo | weeks 3–4 | M1 |
| M3 | The trust loop *(thesis)* | Plan panel, approvals, verification | weeks 5–6 | M2 |
| M4 | Intelligence sidecar *(thesis)* | Python trust layer + Docling + degraded mode | weeks 7–8 | contracts only — parallel from M2 on |
| M5 | Documents, web & batch | The general-agent payload | weeks 9–10 | M3 + M4 |
| M6 | Polish, packaging & numbers | NSIS build, onboarding, eval dataset | remaining time | M5 |

The order is de-risking, not convention: **M1 proves the hardest integration** (AI SDK UI-message-stream over IPC — if that wire doesn't work, nothing matters); **M2 builds the safety foundation before any autonomy exists**; **M3 makes the thesis visible** as early as possible; **M4 is contract-parallel** so the Python side never blocks the JS side.

## 3. Phase details

Each milestone decomposes into **sub-phases** — 51 in total (`M0.1` through `M6.8`, plus M1.6/M1.7 added 2026-09-05) — the actual work units, sized ≈ half a day each and executed in order within their milestone. The tables below state intent; the verbatim acceptance criteria and per-phase "Done when" gates live in the matching PROGRESS.md sections — on any mismatch, PROGRESS.md wins.

### M0 — Skeleton (week 1)
**Goal:** the three moving parts exist and talk to each other; you never again debug "does it even start."
**Why here:** locks in the toolchain (npm + electron-vite + uv) and the sidecar lifecycle pattern used by every later phase.
**Docs:** 02 (connection map §2.1, §2.4).

| Phase | Delivers | Exit gate |
|---|---|---|
| M0.1 | Electron scaffold via electron-vite | `npm run dev` opens a window on Windows |
| M0.2 | one assistant-ui `Thread` renders + the `ai` / `@assistant-ui/react` / `@assistant-ui/react-ai-sdk` trio pinned together | hello-world Thread renders; versions Devlogged |
| M0.3 | the real custom IPC transport, fed a canned multi-part echo stream (no model key) | stream parts cross verbatim |
| M0.4 | Python sidecar boots, token auth enforced from day one | `GET /health` → `{"status":"ok"}` on `127.0.0.1:7891` with token; tokenless → 403 |
| M0.5 | sidecar lifecycle in main (spawn + per-launch token) | app start spawns the sidecar; status dot in the renderer; calls carry `X-Agento-Token` |
| M0.6 | better-sqlite3 DB gate | one-query smoke test (`select 1`, WAL) under Electron; Devlog records prebuild vs rebuild |
| M0.7 | typecheck/lint/test + pytest pipelines | all green |

**Milestone exit gate:** PROGRESS.md M0.* boxes all ticked.

### M1 — Chat on real models (week 2)
**Goal:** a real conversation with a real provider, persisted and resumable.
**Why here:** the chat pipeline is the riskiest integration in the app and everything later rides on it. Prove it with one provider before adding agents, tools, or more providers.
**Docs:** 02 §2.1, 03 §2/§4/§8, 04 §7/§8.

| Phase | Delivers | Exit gate |
|---|---|---|
| M1.1 | settings screen: safeStorage key entry + model pick | entered key persists, readable only in main |
| M1.2 | the custom IPC chat transport (renderer `useChat` ↔ main `streamText` → `toUIMessageStream` over IPC) | first real streaming response renders |
| M1.3 | sessions in SQLite + sidebar | conversation survives an app restart and reopens |
| M1.4 | stop button (`AbortController` end-to-end) | mid-stream stop leaves a clean, resumable session |
| M1.5 | token usage | recorded and shown per session |
| M1.6 | design-system foundation: Tailwind v4 + shadcn tokens (light/dark-ready, dark default), self-hosted Inter, styled scrollbars, existing chrome restyled onto tokens (docs/04 §8.1–8.2) | app matches §7/§8 tokens with styled scrollbars in every scroll region |
| M1.7 | transcript polish: streaming markdown via `@assistant-ui/react-markdown` + GFM, thinking indicator + scroll-to-bottom (prompt-kit under the docs/04 §4 ladder; assistant-ui primitives first), message motion (docs/04 §8.3–8.4) | a markdown-rich reply renders fully styled during a live stream |

**Milestone exit gate:** PROGRESS.md M1.* boxes all ticked.

*Note (added 2026-09-05):* M1.6/M1.7 are **foundation, not polish** — they land before M2 so the action cards (M2.4+) and M3 panels are built on the design system from day one rather than restyled at the end. M6 stays the polish milestone; M6.3's Appearance section completes what M1.6 makes ready (the user-facing theme switcher).

### M2 — The agent touches files (weeks 3–4)
**Goal:** the thin backend becomes an agent with *safe* file powers — the safety machinery lands before autonomy does.
**Why here:** snapshots/undo must exist before the agent can do anything mutating — after M2, "undo everything" is always true, which makes every later phase fearless to build and demo. Sub-phase order note: the workspace picker (M2.2) deliberately lands before any file tool — the sandbox and every tool demo need a real workspace root from day one.
**Docs:** 03 §5–§8, 06 §4.

| Phase | Delivers | Exit gate |
|---|---|---|
| M2.1 | tool registry + wrapper (validate → sandbox → risk → approval-hook → snapshot → execute), unit-tested on a first tool | wrapper tests green |
| M2.2 | workspace picker (native dialog), recents, workspace context on sessions | picked workspace sticks and attaches |
| M2.3 | sandbox guard + adversarial fixture tests | fixture suite green (release-blocking) |
| M2.4 | read-only tools `list_dir` / `read_file` / `search_files` + `ask_user`, each with a plain-language card | read-only demo through cards |
| M2.5 | `create_dir` + `write_file` with cards — first mutating run | snapshot proven end-to-end |
| M2.6 | `edit_file` with before/after excerpts in the card | excerpts render; no diff component anywhere |
| M2.7 | `move_path` / `copy_path` / `delete_path` with cards | all three run through cards with snapshots |
| M2.8 | Changes panel: checkpoints, per-item undo, Undo all | undo-matrix tests green |

**Milestone exit gate:** PROGRESS.md M2.* boxes all ticked.

### M3 — The trust loop (weeks 5–6) *(thesis-critical, never cut)*
**Goal:** plan-first execution with approvals and verification — the visible thesis.
**Why here:** this is the demo's spine. Building it now — against the TS rule table only — means the Python sidecar (M4) is a drop-in upgrade, never a blocker.
**Docs:** 03 §2/§5–6, 04 §3, 06 §2–3.

| Phase | Delivers | Exit gate |
|---|---|---|
| M3.1 | plan mode → PlanPanel; execution only on go-ahead | no mutating tool runs before the user's go |
| M3.2 | rule-table risk classification (TS mirror) wired into the wrapper | risk ≥ 2 blocks on the ApprovalDialog promise |
| M3.3 | approval coalescing | 42 same-shape calls = 1 approval showing the count |
| M3.4 | deny/skip/cancel semantics | deny skips the step cleanly; cancel stops after the current step |
| M3.5 | verification loop: per-mutating-step verify, ✓ badge, retry-once-on-missed-segments | honest "not verified" when the service is absent |
| M3.6 | PlanPanel live statuses | badges update live; failed steps show missed requirements |
| M3.7 | degraded-mode dress rehearsal (file-organization variant) + scripted fake-provider e2e | variant end-to-end with no Python; scripted e2e green |

**Milestone exit gate:** PROGRESS.md M3.* boxes all ticked, including the degraded-mode run.

### M4 — Intelligence sidecar (weeks 7–8) *(thesis-critical, never cut)*
**Goal:** the Python trust layer and document engine come alive; degradation becomes a tested feature.
**Why here:** contracts were frozen in docs/05 from day one, so the Python portions are buildable in parallel with M2/M3 by a second agent (§4 has the Python/JS split); M5 is the merge point.
**Docs:** 05 all, 02 §2.2/§2.4.

| Phase | Delivers | Exit gate |
|---|---|---|
| M4.1 | `/intent/classify` (LLM-prompted v1, structured output) — endpoint + loop wiring | endpoint per contract; loop consumes structured output |
| M4.2 | `/safety/classify` (rule table primary + LLM fallback, floor semantics) | TS/Python rule tables pass the same fixture tests |
| M4.3 | `/completion/verify` (LLM judge) | backs M3's loop when present |
| M4.4 | token enforcement proven on every endpoint (auth ships in M0.4/M0.5) | tokenless request → 403 everywhere |
| M4.5 | kill-mid-session degradation | banner shows, file tools keep working, restart reconnects |
| M4.6 | eval harness skeleton | `uv run eval` prints a first metrics table from seed data |
| M4.7 | Docling document endpoints (`parse` / `edit` / `convert`) + parse-fixture tests | fixtures assert expected markdown structure (docs/05 §6) |

**Milestone exit gate:** PROGRESS.md M4.* boxes all ticked.

### M5 — Documents, web & batch automation (weeks 9–10)
**Goal:** the general-agent payload — where Agento stops being a demo and becomes the product.
**Why here:** needs M3 (trust loop gates everything it does) and M4 (Docling). Waiting until now also means the eval harness already logs real document-tool usage.
**Docs:** 02 §2.6, 05 §2, 03 §5.

| Phase | Delivers | Exit gate |
|---|---|---|
| M5.1 | `read_document` wired to the M4.7 parse endpoint | real `.pdf/.docx/.pptx/.xlsx` parse through a card |
| M5.2 | `summarize_document` | summary saved as `.md` |
| M5.3 | `edit_document` (`.md/.txt` direct; `.docx` via `POST /documents/edit` round-trip) | before/after excerpts on a real `.docx` |
| M5.4 | conversions: md→docx, `.docx`→md, md/html→pdf via `printToPDF`, xlsx→csv | outputs open; unsupported formats fail honestly |
| M5.5 | document preview right panel *(P1 — cuttable)* | pdf.js / DOCX→HTML / markdown / text all render |
| M5.6 | `web_fetch` (+ optional `web_search`) with untrusted-content framing | fetched content enters framed as untrusted |
| M5.7 | batch flows | "organize downloads by type, then summarize every PDF" end-to-end |

**Milestone exit gate:** PROGRESS.md M5.* boxes all ticked.

### M6 — Polish, packaging & numbers (remaining time)
**Goal:** production shape and defensible results.
**Why last:** polish compounds — everything before it defines what needs polishing; numbers come last because the logs that feed them are produced by M2–M5.
**Docs:** 04 §3.7–3.8, 05 §5, 07 §2.

| Phase | Delivers | Exit gate |
|---|---|---|
| M6.1 | onboarding (welcome → workspace → key) + empty states | first launch walks a non-developer through setup |
| M6.2 | QuickActions chips *(P1 — cuttable)* | one click starts a common flow |
| M6.3 | settings completion: permission tiers (risk 3 locked to always-ask), theme, Data section (eval export) | tier defaults enforced; Data actions work |
| M6.4 | MCP client + server config *(P1 — cuttable)* | user-added servers' tools flow through the registry (risk floor 1) |
| M6.5 | local models via Ollama *(P1 — cuttable)* | a local model chats and calls tools |
| M6.6 | electron-builder NSIS install | verified on a clean Windows machine |
| M6.7 | eval dataset at target sizes | final tables regenerate from one command |
| M6.8 | full manual checklist | docs/07 §2 green |

**Milestone exit gate:** PROGRESS.md M6.* boxes all ticked.

## 4. Parallelism map (for running several agents)

```
M0 ── M1 ── M2 ── M3 ──────┐
        └──(contracts frozen)├── M5 ── M6
            M4 (Python) ─────┘
```

- **After M0, the Python side of M4 is a separate workstream.** A second agent can build the service itself — every endpoint, token enforcement, Docling, and the eval harness (M4.1–M4.4, M4.6, M4.7) — from docs/05 + the shared rule-table fixtures, without touching `app/`. The JS-side halves of M4 (the loop wiring in M4.1, the TS parity half of M4.2, the degraded banner + reconnect in M4.5) belong to the JS track; with a single agent, M4 runs sequentially and covers both. Never run two agents on the same directory at the same time; `docs/05` contracts and the fixture file are the only shared artifacts, and they are read-mostly.
- **Merge point is M5.** Reconciliation tasks there: rule-table parity green, degraded-mode banner, document tool wiring.
- Single-writer rule per **sub-phase** (one agent owns one `M*.n` at a time); all deviations go in the PROGRESS.md Devlog so the next agent inherits context, not surprises.

## 5. Suggested calendar (14-week semester, adjustable)

| Weeks | Track A (JS) | Track B (Python) |
|---|---|---|
| 1 | M0 | sidecar scaffold (early start allowed) |
| 2 | M1 | — |
| 3–4 | M2 | M4 endpoints |
| 5–6 | M3 | M4 Docling + eval skeleton |
| 7–8 | slack / M3 hardening | M4 done + parity tests |
| 9–10 | M5 | eval dataset growth |
| 11–13 | M6 polish + packaging | final eval runs + report tables |
| 14 | buffer + rehearsal of the demo (docs/07 §4) | — |

## 6. Cut line & contingency

If time compresses, cut in this order: **MCP client → Ollama → document preview → QuickActions.** Never cut: M3, the eval harness, snapshots/undo. If you are behind at week 8, freeze scope to exactly the demo-scenario path (docs/07 §4) and make that path flawless — a smaller, deeply working product beats a broader fragile one, and it's the same story in the defense either way.

## 7. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Docling's deps are heavy / first-run model download is slow | high | lazy imports, CPU-only extras, pinned versions; the one-time download is documented; degraded mode is a first-class feature |
| Docling cold start on the demo machine (install weight, first-parse model download, CPU parse speed on the 40-page demo PDF) | medium | week-1/2 Python-track spike: install the sidecar env and parse the demo PDF, recording install/first-parse/cached-parse timings + RAM in the Devlog; pre-warm the model cache before every rehearsal (docs/07 §4) |
| assistant-ui / `ai` / `@assistant-ui/react-ai-sdk` version misalignment | medium | pin the trio together in M0 and log the resolved versions in the Devlog; if they clash, the bridge package dictates — downgrade `ai` first; the canned-echo M0 test proves the wire in week 1 |
| Free-tier models are weak at tool calling | medium | capability gate in the model picker; personally test every default suggestion; deterministic e2e scripts don't depend on model quality |
| Models occasionally ignore plan-first prompting | medium | plan mode is enforced structurally (first phase allows no mutating tools), not just prompted |
| Windows path/symlink edge cases | medium | the sandbox fixture suite is release-blocking; any escape found is a P0 bug |
| Python sidecar won't package cleanly | medium | PyInstaller is a stretch goal, not a promise; run-from-source is documented; degraded mode means the app never *requires* Python |
| Scope creep toward a coding agent | medium | non-goals in docs/01 §7; check every idea against the persona |
| LLM cost of classification annoys users | low | cheapest-model routing, caching, and a settings toggle |
| `better-sqlite3` native module must match Electron's ABI on Windows | high | **M0 DB gate:** install normally and run a one-query smoke test (`select 1` with WAL mode) under Electron — better-sqlite3's prebuilds usually match. Only if the `NODE_MODULE_VERSION` error appears: `npm i -D @electron/rebuild` + `"postinstall": "electron-rebuild -f -w better-sqlite3"`, reinstall, re-test. Pin Electron to an exact version (no `^`) and re-run the smoke test after any Electron bump. Devlog which world you're in (prebuild vs rebuild) — M6's NSIS build depends on it |
| Approval coalescing/bookkeeping (buffered batch calls, projected counts) is fiddlier than it looks | medium | mechanism is specified (docs/03 §5); covered by the registry-wrapper tests (docs/07 §2) |
