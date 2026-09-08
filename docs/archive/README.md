# Archive — pre-Agento documents (written as "LocalMind")

These two documents are the original planning material for this project, written before it was renamed **Agento** and before several direction changes. They are kept for historical context and because several of their contracts (risk-tier model, SQLite schema ideas, the LLM-prompted-v1 intelligence strategy) carried into the current spec.

**They are superseded by the suite in `docs/` and should not be used as build instructions.** Superseded twice: once by the first Agento doc suite (2026-09-01), then by the agent-first rewrite (AGENTS.md / STACK.md / PROGRESS.md + docs 01–07) after the strategy review settled on: assistant-ui UI layer, thin AI SDK backend, no code view (before/after excerpts), batch-first automation, and the read-and-rebuild fallback rule for CodexDesktop-Rebuild.

What changed since they were written:

1. **Name:** LocalMind → **Agento**.
2. **Agent layer:** the OSS plan recommended embedding Cline's engine. The project now builds a lightweight, API-key-based agent loop on the **Vercel AI SDK** instead — no existing agent CLI or engine is embedded (see `docs/02-architecture.md` and `docs/03-agent-core.md`).
3. **Codebase:** both docs repeatedly say "extend the existing UI / whatever framework the codebase uses." There is no pre-existing codebase — the project is greenfield.
4. **UI direction:** the old guide hides all technical detail behind plain language. Agento keeps plain language as the default voice but follows a **Codex/ZCode-style interface**: visible, collapsible tool cards, inline diffs, a plan panel (see `docs/04-ui-spec.md`).

What carried over (and where it lives now):

| Old idea | Current home |
|---|---|
| Risk levels 0–3 + approval gate | `docs/06-security-and-permissions.md` |
| Task plan panel, permission modal, revert timeline | `docs/04-ui-spec.md` (PlanPanel, ApprovalDialog, ChangesPanel) |
| Intelligence service (intent / safety / completion) | `docs/05-intelligence-service.md` |
| LLM-prompted v1, rule-table safety, trained classifiers later | `docs/05-intelligence-service.md` (kept, refined) |
| SQLite session/action store | `docs/03-agent-core.md` §8 (merged there) |
| Docling for document parsing | `docs/05-intelligence-service.md` |
| Development order / verification checklist | `PROGRESS.md` (milestones) + `docs/07-testing-and-demo.md` (checklist, demo) |
