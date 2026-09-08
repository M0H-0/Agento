# 01 — Product Specification

## 1. Vision

Modern agents (Codex, ZCode, Cursor) proved an interaction model: give the model tools, show every action in plain view, gate the risky ones, keep the human in command. Agento applies that proven model to **everyday computer work** — documents, folders, and the web — for people who will never open a terminal.

The pitch in one sentence: **"An agent-grade AI assistant for your documents and files — visible, careful, and reversible."**

Agento is explicitly **not a coding agent**. It has no terminal, no Git integration, and no code-view UI. It writes code only as file content, like any other output (see non-goals, §7).

## 2. Problem

Non-developers today have two bad options:

- **Chat assistants** (ChatGPT desktop, Claude desktop) can talk about a document but cannot reliably *do* multi-step work on the user's actual files, and offer no visibility or undo when they do act.
- **Developer agents** (Cline, Cursor, Codex) can act on files with plans and approvals, but assume a code workspace and a user comfortable with terminals and diffs.

The gap: an agent that operates on *general* files with the *trust UX* of a coding agent, in language everyone can read. Nobody has shipped that as a polished, local-first desktop product.

## 3. Target users

**Primary persona — Sarah, 34, office administrator.** Lives in Word, Excel, and a messy `Downloads` folder. Wants "organize my invoices by month," "turn this report into a PDF," "summarize these five documents into one page." Cannot debug anything; abandons software the first time it does something scary without asking.

**Secondary persona — Alex, 21, student.** Comfortable with technology but not a developer. Wants research help, note organization, converting lecture slides into study sheets. Will happily open detail views and pick models.

**Anti-persona:** professional developers doing code work in a repo — Agento deliberately does not serve them (no shell, no diffs, no Git).

## 4. Product principles

These resolve every design dispute. In order:

1. **Plan before act.** For anything multi-step, the user sees the plan before any tool runs.
2. **Nothing irreversible without asking.** Risk ≥ 2 always requires an explicit approval.
3. **Everything is undoable.** Any file the agent touched can be restored — from snapshots, not Git (within the snapshot caps of docs/03 §7; an evicted restore is refused honestly, never faked).
4. **Plain language by default, detail on demand.** Every action renders with a human one-liner; file changes show **before/after excerpts** — never diffs, never editors, no code view.
5. **Local-first.** No Agento servers, no accounts, no telemetry; only the network calls the user configured (doc 06 §8).
6. **Degrade, never break.** Any subsystem being unavailable reduces capability gracefully and says so.

## 5. Core interaction loop

```
Instruction (plain language)
   → Understand        (intent classification; ask if ambiguous)
   → Plan              (visible step list, per-step risk)
   → Approve           (blocking modal for risk ≥ 2; batched for bulk operations)
   → Execute           (streaming action cards; snapshot before each mutation)
   → Verify            (did each step actually accomplish its part?)
   → Report            (summary + what changed + undo affordances)
```

**One-shot autonomy** is the default posture: the user gives one instruction, the agent plans and executes end-to-end, interrupting only for approvals on risky steps — no chat ping-pong between steps.

## 6. Feature set

Priorities: **P0** = required for the graduation demo · **P1** = production polish · **P2** = future work (design only).

### 6.1 Conversation & workspace

| Feature | Pri | Notes |
|---|---|---|
| Sessions (rename, list, resume) | P0 | Left sidebar, Codex-style |
| Workspace folder picker + recents | P0 | Native dialog; drag-drop onto window (P1) |
| Streaming chat, markdown rendering | P0 | assistant-ui |
| Stop/cancel generation | P0 | Aborts mid-tool safely |
| Quick Actions chips | P1 | Preset prompts that fill the composer |
| Session export to Markdown | P2 | |

### 6.2 Agent capability

| Feature | Pri | Notes |
|---|---|---|
| File tools: read, list, search, create, write, edit, move, copy, delete | P0 | Edit is before/after based; delete/move gated |
| **Batch operations** (bulk rename/convert/organize across many files) | P0 | Approval coalescing: one decision for the batch |
| Document tools: read, summarize, edit, convert | P0 | Docling parse; `.docx` edit round-trip |
| Web fetch + readability extraction | P0 | |
| Web search (Tavily/Brave, optional key) | P1 | |
| Plan mode → plan panel → stepwise execution | P0 | The core loop |
| Approval gates for risk ≥ 2 | P0 | Blocking modal |
| Snapshot + undo per change; "undo all" | P0 | Doc 03 §7 |
| Completion-verification badges per step | P0 | Thesis-visible feature |
| MCP client (user-added servers) | P1 | Ecosystem tools through the same risk pipeline |
| Local models via Ollama | P1 | |
| Scheduled tasks / watch folders | **P2 (non-goal for v1)** | Future work; needs scheduler/watcher services — see §7 |

### 6.3 Trust & transparency UI

| Feature | Pri | Notes |
|---|---|---|
| Action cards (collapsible, plain-language title, detail on expand) | P0 | The core Codex look |
| **Before/after excerpt card** for every file edit | P0 | No diff view, no code view — doc 04 §3.1 |
| Task Plan panel (right) with live statuses | P0 | |
| Approval modal (plain language, blocking, batch-aware) | P0 | |
| Changes panel (what I changed + per-item undo) | P0 | |
| Verification badge + missed-requirement notes on steps | P0 | |
| Document preview (PDF, DOCX→HTML, MD, TXT) | P1 | Right-panel; before/after split for edits |
| Degraded-mode banner when the Python service is absent | P0 | Quiet, not blocking |

### 6.4 Settings

| Feature | Pri | Notes |
|---|---|---|
| Provider setup (API keys, model pick) | P0 | Keys via safeStorage; free-tier-friendly defaults documented |
| Permission defaults per risk tier | P1 | Risk 3 can never be auto-allowed |
| MCP server management | P1 | |
| Theme (light/dark/system) | P1 | |
| Data management (clear sessions, purge snapshots, eval-data export) | P1 | Eval export feeds the thesis (doc 05 §5) |

## 7. Non-goals (v1)

- **No shell/terminal execution** — code-related requests are fulfilled by writing code into files, like any other output.
- **No code view** — no diff views, no editors, no monospace-first screens. Changes are before/after excerpts in plain formatting.
- **No scheduled tasks or watch folders** — time-based automation and filesystem watchers are future work (they require a scheduler service and change the safety model).
- **No RAG / vector databases / indexing** — on-demand reads + ripgrep search.
- **No multi-user, accounts, or cloud sync.**
- **No agent marketplace UI** beyond MCP server config.
- **Not an IDE** — no project trees with git status, no linting, no run buttons.

## 8. Competitive positioning

| Product | Acts on general files? | Visible plan + approvals | Undo | Plain-language for non-devs | Setup |
|---|---|---|---|---|---|
| ChatGPT / Claude desktop apps | barely (upload-based) | ✗ | ✗ | yes | easy |
| Cline / Codex / ZCode | yes, code-centric | yes | yes (git) | no | dev setup |
| AnythingLLM | docs-focused, RAG-centric | ✗ | ✗ | partial | moderate |
| **Agento** | **yes** | **yes** | **yes (snapshots)** | **yes** | **API key only** |

The defensible claim: **Agento is the only desktop agent combining general-file agency (including batch automation) with coding-agent trust UX, zero code view, and zero-setup local-first privacy.**

## 9. Success criteria

**Product (demoable):**
1. A stranger can go from install to a completed, undoable file task with only an API key and no documentation.
2. The full loop (plan → approve → execute → verify → undo) runs live in under 2 minutes for the demo scenario (doc 07 §4) — including one batch approval covering dozens of files.
3. Zero destructive operations are possible without an explicit, informed approval.

**Thesis (measurable):** the evaluation harness (doc 05 §5) reports real numbers for intent classification, safety gating, and completion verification — stated methodology, labeled dataset, reproducible scripts.
