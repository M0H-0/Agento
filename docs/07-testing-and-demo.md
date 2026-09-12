# 07 — Testing & Demo

Milestones and their acceptance criteria live in [PROGRESS.md](../PROGRESS.md). This document owns *how we prove things work* and the defense demo script.

## 1. Philosophy

Two kinds of claims matter in this project: **"it cannot hurt your files"** (a safety claim — proven by tests) and **"the trust layer works"** (a thesis claim — proven by the eval harness). Both get infrastructure from day one; neither is allowed to rest on manual vibes.

## 2. Test strategy

| Layer | Tooling | What must be covered |
|---|---|---|
| Sandbox guard | vitest + fixture tree | every adversarial case in doc 06 §4 (`..` chains, symlink/junction escapes, Unicode, long paths) — **release-blocking** |
| Rule table (TS + Python) | shared fixture file; both engines assert identical outputs | parity is the degradation guarantee (doc 05 §2) |
| Registry wrapper | vitest | schema rejection, risk gating, approval blocking, **snapshot-before-mutate**, result truncation, approval coalescing |
| Snapshot/undo engine | vitest + temp dirs | the full undo matrix (doc 03 §8): create/edit/move/delete/dir, sha-mismatch refusal, undo-of-undo |
| Storage | integration tests on temp DB | migrations, resume replay, retention |
| Agent loop | scripted e2e — fake provider emitting a deterministic tool-call script against a fixture workspace | plan→approve→execute→verify→undo; cancel mid-run; MAX_STEPS; degraded mode (sidecar down) |
| Intelligence service | pytest + respx | contract shapes, fallback paths, structured-output validation, token auth |
| Eval harness | `uv run eval` | the thesis numbers (doc 05 §5) |
| App e2e + screenshots | Playwright (`npm run e2e` in `app/`, HTML report) | launch, first paint, per-step screenshots attached to the report |
| Manual | checklist below, before every demo | the "stranger test" |

**Manual checklist (run before every demo):**

- [ ] Plan appears before any execution
- [ ] Approval modal on overwrite/move/delete; batch of 40+ files costs **one** modal showing the count
- [ ] Deny → clean skip, run continues; Cancel → stops after current step
- [ ] Undo restores byte-identical content (verify via file properties); Undo all works
- [ ] Verification badges appear only when verified; "not verified" is visibly distinct
- [ ] Edits show before/after excerpts — **no diff view, no code view anywhere in the app**
- [ ] No JSON, tool names, or stack traces in any reply
- [ ] Stop mid-run leaves a consistent, resumable session
- [ ] Kill Python mid-session → banner appears, file tools still work, no crash
- [ ] No API key → onboarding, not errors
- [ ] >10 MB file → honest explanation, not a hang
- [ ] Windows path torture: Unicode filenames, deep paths, spaces, oneDrive-redirected folders

## 3. The eval harness (thesis numbers)

Owned by `services/intelligence/eval/` with metric definitions and dataset targets in doc 05 §5. Short version: intent (accuracy/macro-F1/confusion matrix), safety (per-level precision/recall vs rule-table gold, with **over-permissiveness** called out), verification (agreement with human labels + missed-segment quality). Every table regenerates from one command with committed data and pinned models — that reproducibility *is* the methodology.

## 4. Defense demo script (~6 minutes)

Scenario exercises every headline claim on a prepared messy folder (42 files: PDFs, images, documents, duplicates):

1. **Setup (30s):** point Agento at the messy folder. "It works on any folder — no project, no git, no config." *Before the session: pre-warm the Docling model cache by parsing any PDF once (see docs/05 §6), so the audience never watches a model download.*
2. **Instruction:** *"Organize my downloads by file type, and make me a one-page summary of every PDF."*
3. **Plan-first (60s):** plan appears before anything runs. "A coding-agent interaction model — for someone's grandmother."
4. **Approval (60s):** the move step asks once for all 42 files; **deny it once** to show the graceful skip, then approve. "'No' is a normal answer."
5. **Visible execution (90s):** action cards stream by; expand one before/after excerpt; show a verified ✓ badge; show a failed/not-verified step retrying once.
6. **Undo (60s):** open Changes, undo one item live, then Undo all and rerun. "Nothing it does is permanent."
7. **Privacy + architecture (60s):** the egress table (doc 06 §8) — four destinations, that's all; then the architecture slide: three processes, trust layer as a swappable, *evaluated* service.
8. **Numbers (30s):** eval table — intent macro-F1, safety over-permissiveness, verification agreement. "Measured, reproducible, and the logs that produced them are the app's own."

### 4.1 Video variant (~12–15 minutes)

Same scenario, stretched for a recorded walkthrough and shot order. Beats 1–9 use shipped features; nothing here requires the eval harness (beat 10 replaces the defense script's "Numbers" with architecture narration until M4.6/M6.7 land).

1. **Cold open — onboarding (60–90s):** full-screen welcome, pick the messy demo folder, paste the API key. "One folder, one key — that's the whole setup."
2. **Home + QuickActions (30s):** the centered composer-first home; folder chip, one example-prompt chip click fills the composer (never auto-sends) — then type the real ask instead: *"Organize this folder by file type, and make me a one-page summary of every PDF."*
3. **Plan-first (90s):** Plan mode → plan panel with live steps. "A coding-agent interaction model — for someone's grandmother."
4. **Approval (60–90s):** ONE modal for the whole move batch ("I'm about to touch N items in one batch"); deny once to show the graceful skip, then approve. "'No' is a normal answer."
5. **Execution (90s):** action cards stream by; expand one before/after excerpt; show a verified ✓ badge; narrate that every mutation was snapshotted BEFORE it ran.
6. **The reversal (90s):** Changes panel → undo one item → **Ctrl+Z** (newest change, live) → Undo all → folder is byte-identical again. "Nothing it does is permanent — one shortcut undoes the agent."
7. **Semantic search (60–90s):** *"Where did I write about pricing?"* — narrate the on-device MiniLM embedding model: "that's a neural network running on your machine; nothing left this folder."
8. **Documents (60s):** summarize one PDF; show the extracted-text card and the answer.
9. **Model & settings tour (90s):** switch provider/model from the composer chip live; Settings tabs — appearance dark/light flip, permission defaults (risk 3 always-ask), data actions.
10. **Close — the invisible safety net (60s):** narrate over a plan run: sandbox path checks, risk classification, snapshot-or-refuse, sidecar audit trail, and the four-destination egress table (docs/06 §8).

**Recording prep:** build the fixture folder with `demo/make_fixture.py` (see below), pre-warm the semantic index and sidecar model cache (parse any PDF once), then run the §2 manual checklist before recording.

## 5. Keeping the docs alive

A change to any contract (IPC events, endpoint schemas, rule table, SQL schema) updates the doc **in the same commit** (AGENTS.md rule 6); new dependencies update STACK.md; deviations get a Devlog line in PROGRESS.md and, where architectural, an ADR row in doc 02 §6. Outdated-but-authoritative docs are worse than no docs — `docs/archive/` exists so superseded material is labeled, not lurking.
