# 05 — Intelligence Service (`services/intelligence`)

The Python sidecar — and the dissertation's core contribution. Confirmed as a core component in the strategy review (2026-09): it stays, with these exact contracts. It has three jobs:

1. **Trust layer** — intent classification, safety classification, completion verification.
2. **Document engine** — Docling-backed parsing, `.docx` editing, format conversion.
3. **Evaluation** — scripts + labeled data that turn the trust layer into measurable, defensible numbers.

Design stance (inherited from the archived OSS plan, kept because it is correct): **v1 ships LLM-prompted classifiers and a deterministic rule table, not trained models.** No public labeled dataset of "desktop instruction → intent" or "action → risk" exists; training on day one means hand-labeling before any product exists. Instead, the SQLite logs (doc 03 §8) accumulate exactly the right data from day one, and training real classifiers becomes a *results chapter*, not a prerequisite. The HTTP contracts never change when that swap happens — only the implementation inside each endpoint does.

## 1. Shape

- Python 3.12, `uv`-managed, FastAPI + Pydantic v2 + uvicorn
- Binds `127.0.0.1:7891` only; every request must carry `X-Agento-Token` (per-launch token from the main process) → 403 otherwise
- Spawns fast; heavy imports (Docling) are lazy so `/health` answers immediately
- Stateless — all persistence lives in the app's SQLite (doc 03 §8); evaluation data flows *out* through exports (§5)

## 2. Endpoint contracts

Pydantic models are the source of truth here; `src/main/ipc/` mirrors them in Zod. Any change updates code + both docs in the same commit (AGENTS.md rule 6).

### `GET /health`
```json
{ "status": "ok", "version": "0.1.0",
  "capabilities": { "docling": true, "llm_classifiers": true, "trained_models": false } }
```
Capability values are runtime facts — they reflect what the running build actually has wired (e.g. `docling` stays `false` until the M4.7 lazy imports land), not the v1 end-state shown above.

### `POST /intent/classify`
```json
// req
{ "instruction": "organize my downloads by file type and summarize the PDFs" }
// res
{ "intent": "organize",            // file_operation | document_read | document_edit
  "confidence": 0.92,              // web_research | organize | code_task | multi_step
  "requires_clarification": false, // true when confidence < 0.7
  "reasoning_tokens": [{"token": "organize", "score": 0.87}] }
```
Called once per instruction; `requires_clarification` biases the model toward `ask_user`. Informational — the loop never blocks on it (a chatty "hello" must not become a workflow).

### `POST /safety/classify`
```json
// req
{ "tool": "write_file",
  "input": { "path": "summary.md" },
  "workspace": "C:/Users/sarah/Downloads" }
// res
{ "risk_level": 2, "risk_label": "overwrites",
  "explanation": "summary.md already exists and will be replaced. You can undo this.",
  "requires_approval": true,       // risk_level >= 2
  "source": "rule_table" }         // rule_table | llm_fallback | ts_fallback
```
**The rule table is the floor; the classifier may raise, never lower.** Deterministic, auditable, testable — this is how production agents gate risk (tiers and allow-lists, not a learned guess), and the eval (§5) quantifies where the LLM layer adds value.

Rule table (v1, `rule_table.py` — mirrored 1:1 in TS for degraded mode; both engines must pass the same fixture tests):

| Condition | Risk |
|---|---|
| read / list / search / fetch / summarize | 0 |
| create file or directory that doesn't exist | 1 |
| overwrite existing file (`write_file` on existing target, `edit_file`, `edit_document`) | 2 |
| move/rename/copy-onto-existing (either endpoint inside workspace) | 2 |
| delete any path | 3 |
| any single approval group touching > 25 paths (bulk) | 3 + explicit count in copy |
| any path outside the workspace | rejected by the sandbox before classification (doc 06 §4) |

LLM fallback handles only `input` shapes the table can't resolve; its output may raise the level, never lower it.

### `POST /completion/verify`
```json
// req
{ "instruction": "move all PDFs into a folder called Reports",
  "step": { "description": "Move 12 PDF files into Reports/",
            "actions": [ { "tool": "move_path", "input": {}, "result": "moved 12 files" } ],
            "before_after": [ { "path": "invoice_2026-01.pdf",
                                "before": "<absent>", "after": "Reports/invoice_2026-01.pdf" } ] } }
// res
{ "completion_score": 0.93, "is_complete": true,      // threshold 0.85
  "missed_segments": [] }
```
`missed_segments` are short plain-language strings ("2 PDFs in the root were not moved") — they feed the one retry (doc 03 §6) and the UI's failed-step text.

### Documents

| Endpoint | In → Out | Implementation |
|---|---|---|
| `POST /documents/parse` | `{path}` → `{ format, markdown, structure: {sections/tables[], n_pages, meta} }` | **Docling** (`.pdf .docx .pptx .xlsx .csv .html .md .txt`) |
| `POST /documents/edit` | `{path, edits[]}` (replace ranges by anchor text) → `{ok, new_path?}` | `.docx` via `python-docx` round-trip (run-level text replacement, styles preserved); `.md/.txt` are handled in TS, not here |
| `POST /documents/convert` | `{path, target: "docx"\|"csv"\|"md"}` → `{out_path}` | Docling exports; `.pdf` targets are produced in Electron via `printToPDF` instead (docs/02 §2.6) |

Editing `.docx` is deliberately conservative: text-level replacements whose anchors were read from the same file. Free-form regeneration of styled documents would produce worse artifacts than honest limitations.

### MVP cut (2026-09-10) — the endpoints live TODAY, in cut-down shapes

Per `MVP_PLAN.md` ("supersedes implementation_plan.md for today only"), these MVP variants shipped one day; **the frozen contracts above remain the M4+ full-build target**, and today's code degrades honestly everywhere (docs/05 §6). One commit carries code + this section (AGENTS.md rule 6).

| Endpoint | MVP shape (live) | Notes |
|---|---|---|
| `POST /document/extract` | `{path}` → `{text, truncated}` | **pypdf + python-docx instead of Docling** (MVP_PLAN's call; Devlog deviation, STACK.md rows updated). `.pdf .docx .txt .md` only; 200k-char honest cap; 404 missing / 422 unsupported. Docling's structured `/documents/parse` (M4.7) supersedes this. |
| `POST /embed/embed` | `{texts: [str]}` → `{vectors: [[f32]]}` | NOT in any prior contract — added for the MVP standout feature: on-device `all-MiniLM-L6-v2` via **fastembed** (Apache-2.0, STACK.md row). Batch caps 256 texts / 400k chars; 503 when the model can't load; lazy import + lazy build per §1. |
| `POST /intent/classify` | `{message}` → `{intent, confidence: "heuristic"}` | Heuristic keyword/regex scorer (§3's LLM design deferred — a same-day model on a classifier is a liability per MVP_PLAN). `confidence` is a provenance literal today, NOT the numeric §2 confidence; `requires_clarification`/`reasoning_tokens` arrive with M4.1. Wired **audit-only** in `chat.ts` (logged, never blocks). |
| `POST /safety/classify` | `{tool, args}` → `{risk: 0-3, reason}` | Deny-list (traversal, system dirs, credential paths, bulk >25) + rule-table mirror. Field names differ from §2's frozen shape (`risk` vs `risk_level`/`risk_label`, no `requires_approval`/`source`); the TS rule table stays the approval floor — this endpoint is an **audit cross-check only** in the MVP. |
| `POST /completion/verify` | `{instruction, step_description, actions, before_after}` → `{completion_score, is_complete, missed_segments}` | Same response shape as §2, but the REQUEST is the **flattened** variant the shipped TS client (`app/src/main/agent/verify.ts`, M3.5) actually sends — §2's nested `step` example above is stale and this row is the corrected contract. Heuristic postconditions (targets exist/gone), no LLM judge (M4.3). |

**`/document/summarize` does not exist** — MVP_PLAN listed it, but summarization is an LLM task and the sidecar has no provider access (keys never leave Electron main, per the MVP LLM-placement decision). `summarize_document` extracts via `/document/extract` and completes over the user's configured provider TS-side.

### `GET /metrics` and `/eval/*`
Read-only endpoints for the evaluation harness (§5); also runnable offline as `uv run eval` scripts writing `eval/reports/*.md`.

## 3. v1 classifier implementations

- **Intent:** one LLM call on the cheapest capable configured model, few-shot prompt (~12 examples across the 7 classes), temperature 0, structured output (Pydantic schema). Conservative confidence; <1.5 s budget; identical instructions cached.
- **Safety:** rule table primary; LLM fallback only for untabled shapes; must demand the higher of (table, judgment).
- **Completion verify:** one LLM call over instruction + step actions + before/after digests (not raw dumps) → `{score, is_complete, missed_segments}` structured output.

Classification calls reuse the user's configured provider/key (settings toggle, default on) with a hard fallback to the rule table on failure — classification must never hard-block a run.

## 4. v2 — trained classifiers (the dissertation's experimental chapter)

Pre-registered plan, executed only after real logs exist:

| Model | Task | Data source | Baseline to beat |
|---|---|---|---|
| DistilBERT + 7-class head | intent | labeled instruction log (§5) | LLM-prompted v1 accuracy/cost/latency |
| `cross-encoder/nli-distilroberta-base` (off-the-shelf, zero training) | completion verify (instruction ⊨ action-report) | labeled verify set | LLM judge agreement |
| DistilBERT + 4-class head | safety (exploratory — expected: rule table wins; negative results are reportable) | labeled action set | rule-table gold |

Serving shape when swapped in: `trained_models/` loaded at startup behind the same endpoints; `capabilities.trained_models` flips in `/health`; per-endpoint `source` records which engine answered so evals can compare engines on identical traffic.

## 5. Evaluation harness (thesis metrics)

`services/intelligence/eval/`:

```
eval/
├── data/
│   ├── intent_labeled.jsonl       # instruction, expected_intent        (target: ≥300)
│   ├── safety_labeled.jsonl       # tool, input, expected_risk          (target: ≥200, incl. edge cases)
│   └── verify_labeled.jsonl       # instruction, step, expected_complete, missed (target: ≥150)
├── scripts/  (build_dataset.py, run_eval.py, report.py)
└── reports/  (generated .md tables — these go in the dissertation)
```

**Dataset construction:** seed from real Agento logs (export via Settings → Data → eval export, doc 03 §8), then hand-label; document the procedure, and report inter-annotator agreement if a second annotator is available (a labmate for one hour upgrades the methodology section substantially). Add edge cases deliberately: ambiguous instructions, adversarial paths (`..`, symlinks), partial completions.

**Metric definitions (fix now; they discipline everything):**
- Intent: accuracy + macro-F1 + per-class F1 + confusion matrix.
- Safety: precision/recall per risk level vs rule-table gold; specifically **over-permissiveness** (predicting lower risk than gold — the dangerous direction).
- Verification: agreement with human `is_complete` labels; score/label correlation; 3-point quality audit of `missed_segments`.

**Reproducibility:** `uv run eval --all` regenerates every table from committed data + pinned model versions; seeds fixed; every number traceable to a script.

## 6. Failure behavior (from the agent's perspective)

| Condition | Behavior |
|---|---|
| Service unreachable | TS fallback: rule table (mirrored), verification skipped → "not verified" |
| Service unreachable — document tools | `read_document` / `summarize_document` / `edit_document` / `convert_document` stay registered but fail with a plain-language "document tools are offline" error — never a silent fallback to a weaker path; the degraded banner (docs/04 §6) says the same |
| Docling model not yet downloaded | parse returns 503 + reason; per-request notice; model downloads once in background, then cached |
| Parse fails or times out (scanned/password-protected/corrupt document) | honest plain-language error from the tool (docs/04 §5); **no** silent fallback to a weaker parser |
| LLM classifier call fails | rule-table answer (safety) or low-confidence result (intent); verify → skip with notice |
| Malformed request | 422 via Pydantic; agent logs and continues with fallback |

**Parser substitution is a human decision, never an agent's mid-phase improvisation.** If Docling ever proves unviable on the target machine, the candidate replacement (e.g. `pymupdf4llm` / MarkItDown) requires a STACK.md update, a Devlog entry, and a revision of §2 — decided by a human, in one commit. Parse-fixture tests (a small PDF with a known table and known headings) assert the markdown structure, so "Docling works" stays a checked claim, not a vibe.
