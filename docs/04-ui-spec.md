# 04 — UI Specification (assistant-ui based)

The interaction model of Codex/ZCode — streaming transcript, collapsible action cards, a live plan panel — applied to everyday files, in plain language, with **no code view anywhere** (no diffs, no editors, no terminal aesthetics). The UI is built on **assistant-ui** (MIT) — the OSS React library purpose-built for exactly this shape of app — inside a thin Electron shell.

## 1. Design principles

1. **Progress is always visible.** "What is it doing right now?" is answerable at a glance.
2. **Plain language by default, detail on demand.** Every action gets a one-line human summary; technical detail is one click away — never hidden, never forced.
3. **Danger is loud, safety is quiet.** Risky steps get color and friction; safe steps get none.
4. **Nothing blocks except approvals.**
5. **Degrade visibly.** Missing capability shows a quiet banner, not a broken feature.

## 2. Layout

Fixed three-column shell; collapsible sidebars; min window 960×640.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Workspace: Downloads ▾         session: "Tidy my downloads"    12.4k tok │
├──────────────┬──────────────────────────────────────────┬────────────────┤
│ ＋ New task  │  ┌ user ────────────────────────────────┐│ TASK PLAN      │
│ ──────────── │  │ organize my downloads by file type,  ││ ✓ 1. Look what │
│ Today        │  │ and make me a summary of the PDFs    ││    is here     │
│  Tidy my…    │  └──────────────────────────────────────┘│ ↻ 2. Group     │
│  Report…     │  I found 3 documents and 42 files. Here's │    files by…   │
│ ──────────── │  my plan: …                              │ ○ 3. Move into │
│ Earlier      │                                          │ ○ 4. Summarize │
│  Invoice…    │  ┌ ◸ Read the report.pdf   [✓ verified] ┐│    the PDFs    │
│              │  └ 3 pages · expand                      ││ ────────────── │
│ WORKSPACE    │  ┌ ◸ Group 42 files by type             ││ [ Start ▶ ]    │
│ 📁 47 files  │  └ 4 folders planned                    ││                │
│  ▸ Finance/  │  ┌ ◸ Move files           ⚠ approval    ││ CHANGES (2) ↩  │
│  ▸ Images/   │  └ 42 files, one approval · undo ↩      ││ · report.pdf   │
│  ▸ Reports/  │  ┌ ◸ Edit summary.md      [✓ verified]  ││   saved 10:02 ↩│
│              │  └ changed 2 paragraphs · view changes   ││ · invoices/    │
│              │  Done — 42 files organized into 4 …     ││   created      │
├──────────────┴──────────────────────────────────────────┴────────────────┤
│ [Summarize a folder] [Organize by type] [Convert to PDF] [Find dupes]   │
│ ┌──────────────────────────────────────────────────────────┐ [plan ▾] ⏎ │
│ │ Ask Agento to do something…                              │       ⏹   │
│ └──────────────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left — Sessions sidebar:** workspace chip (the folder **new chats** will use — each existing chat keeps and shows the folder it was created in), new task, a Recency | Folder sort toggle (default Recency, remembered in localStorage; Recency groups under date headers — Today / Yesterday / Earlier this week — Monday-start / Older, most recent first, each row title + compact folder-name tag with the full bound path in the tooltip + relative timestamp; Folder groups each folder's chats together with the current folder first and the path once in the section header — colliding leaf names gain a parent-segment suffix — rows show title + relative time only; token totals stay in the DB, not the rail), small-caps "Conversations" label; **Settings** + sidecar status dot pinned in a hairline-bordered footer (image-2-style app chrome; was floating top-right).
- **Center — Thread / Workspace Overview:** the assistant-ui transcript in its own flex column (`.chat-main`), centered at ~760px — messages can never render under a panel. The same column can instead show the **Workspace Overview** (opened from the sidebar; idle navigation only): workspace header (title + truncated path), a "What's here" snapshot strip (file/folder/type counts from one capped `workspace:list-files`), recent work in this folder (one resume card for the newest bound session — settled run reads "pick up where you left off" with mode + tokens, otherwise "unfinished draft"; click reopens, with a → open affordance), and the contextual task starters (empty-aware: onboarding questions when the folder is empty) — chips fill the composer only, never auto-send. A folder-scoped "Activity in this folder" stat strip states what the sidebar never aggregates (Chats / Last active / Tokens used boxes, conditional on nonzero — same box pattern as "What's here"). Type is tiered (1.5rem title → 0.78rem muted path meta → 0.95rem semibold section headings with hairline dividers between sections) so the page scans instead of reading as one gray block. The right rail hides while the overview is up.
- **Right — Right rail:** one in-flow column (`.right-rail`) holding the **Plan** panel above the **Changes** panel (with undo). Plan caps at half the rail height and scrolls internally; Changes fills the rest and scrolls. Plan renders only while a plan is live, Changes only once a session exists (until then the rail shows whichever is available); the rail collapses entirely when unused.
- **Bottom — Composer:** assistant-ui composer, autosize, Plan/Act mode tabs (§3.5), model chip (provider · model label; the upward popover lists providers only, each row expanding its models in a separate fixed-position panel aside (never nested in the menu's scroll box, bottom-aligned with the row, flips side when off-screen) — **click-only expand** (no auto-open on menu open, no hover preview), Esc closes the flyout first; custom profiles show a single-model flyout; RTL mirrors the flyout side), send/stop.

## 3. Components

### 3.1 Action cards (assistant-ui tool UIs)

One card per tool call, rendered from the chat stream's tool parts; per-tool component registered via the runtime tools API (`setToolUI` on `useAssistantApi().tools()`, M2.4) with a defensive shim that degrades unknown part shapes to the generic card.

- **Header (always):** chevron, group icon, **plain-language title** (registry `describe()`), status glyph (spinner → check/cross), risk accent ≥ 2.
- **Meta line:** quantitative summary ("3 pages", "42 files", "2.1s").
- **Body (collapsed by default):** arguments + paths + raw output, truncated, scrollable. For edits: the **BeforeAfterCard** — the changed passage shown as plain "Before" and "After" text blocks (stored on the checkpoint row, doc 03 §8), with a `view changes` affordance. **No diff renderer exists in this app.**
- **Footer actions:** `undo ↩` (mutations), `retry` (failures), `preview` (documents).

Title examples: `read_file` → "Read report.pdf" · `search_files` → "Searched for invoices" · `move_path` ×42 (coalesced) → "Moved 42 files · 1 approval" · `web_fetch` → "Read a web page" · `web_search` → "Search the web for …" · `edit_document` → "Edit document …".

### 3.2 ApprovalDialog

Blocking modal; only an explicit decision closes it (no overlay-click, no Escape-to-skip).

- Plain-language headline ("I'm about to move 42 files" / "Delete temp_drafts?").
- Concrete detail: affected paths (first few + count), snapshot assurance ("you can undo this afterwards").
- Buttons: **Approve** · **Skip this step** · **Cancel the rest**. Risk 3 uses a red verb ("Delete permanently").
- Batch coalescing (doc 03 §5): one dialog per `(step, tool, shape)` group; count shown; one decision covers the group.

### 3.3 PlanPanel

Step rows: status glyph (○ / spinner / ✓ / ✗ / ⚠ awaiting approval), plain description, risk accent ≥ 2; verification badge when done ("verified ✓" / "not verified"); failed → missed requirements in one sentence + retry. Header: `Start ▶` pre-execution (legacy plan-first path only), "updated" chip on plan revisions, "read-only" chip on plans from a Plan-mode run. Footer: "3 of 5 steps done" — or, for read-only plans, "Read-only plan — nothing was changed. Switch to Act and say “go ahead” to carry it out."; per-step `undo ↩`.

### 3.4 ChangesPanel

Session checkpoints: file, friendly action ("created/edited/moved/deleted"), time, per-item `undo ↩`, **Undo all**. Undo confirms first ("restore summary.md to how it was before I edited it?"). Reverted rows go dim + "restored ✓". Undo appends a new checkpoint (it is itself undoable).

### 3.5 Composer & QuickActions

assistant-ui composer: Enter sends, Shift+Enter newlines, stop replaces send mid-run, disabled-with-reason when no key/workspace. A **Plan / Act tablist** sits above the input (session-owned, `session:set-mode`; new chats start in Act; tabs disable mid-run): Plan is read-only ("Read-only — nothing will change."), Act carries out work. **File references:** a paperclip button plus `@`-mention autocomplete share one workspace-scoped picker (`workspace:list-files`, relative paths only); picks render as removable chips above the input and ride the outgoing message as `Context files: @relpath` reference text (the model fetches content via read_file — no binary upload). The picker disables mid-run and in reply mode. QuickActions chips (P1) fill the composer; never auto-send — and are contextual, not static: one capped `workspace:list-files` plus session-title scan decides them (PDFs → summary chip, ≥3 extensions or ≥10 files → organize chip, `pric*` filename/title evidence → pricing chip; generic fallbacks otherwise). **Slash commands:** typing `/` at the start of the composer opens the command menu (`/search <text>` exact words, `/semantic <topic>` meaning-based, `/undo` last change, `/undo-all` everything, `/help` lists them). Template commands expand to prose and send through the normal path (registry/approvals/snapshots hold — no bypass); local commands run in the renderer — both undo flavors ask first with an inline confirm naming what will be restored, `/help` renders in place and creates no session row. The menu disables mid-run and in reply mode, like the file picker. **Reply mode (ask_user):** while a question pends the run, the composer input becomes the reply box — Enter or Send submits via `tool:answer`, the question's options render as quick-pick chips above the input, and Stop keeps its mid-run meaning (reject the answer + abort). The Ask card in the thread stays display-only (Awaiting your reply / Replied / Stopped before reply).

### 3.6 Document preview (P1)

Right-panel tab or overlay: PDF (pdf.js), DOCX→HTML (mammoth), markdown rendered, text. Edits: before/after split. Opened from cards via `preview`; never forced.

### 3.7 Settings

Tabbed by category (one panel visible at a time; inactive panels stay mounted but hidden so form drafts survive tab switches). Tabs (M6.3 shipped except MCP servers, still P1): **Providers** — one **"Your providers"** list showing everything we have: built-ins (Google AI Studio, Groq) as fixed rows plus user-managed custom OpenAI-compatible profiles (name + endpoint + key-optional + free-form model + test) appended as they're added; each row shows its own masked key state ("Key saved •••• last4" / "No key saved"), an in-use marker on the active provider, and Use/Test/Edit/Remove actions — custom rows delete the profile *and* its key (the active provider can't be removed), built-in rows get "Remove key" (clears the stored key; the provider stays available) instead of Remove. **Permissions** (risk 1 auto/ask, risk 2 ask/auto with a safety note, risk 3 hard-locked to always-ask), **Appearance** (dark / light / follow system; the `<html>` `.dark` class is the token switch; **Language** English / العربية — instant, no restart), **Data** (open data folder, clear conversations, purge undo snapshots — both behind inline confirms — redacted eval export into the data dir). Keys via safeStorage; never rendered back — only "•••• last4". The dialog has a visible close button and keeps the masked-key discipline for every profile. The sidebar **Settings** button carries an attention dot only while a built-in (key-mandatory) provider has no stored key — custom keyless profiles never light it; the tooltip ("No API key … Settings → Providers") explains why, and visiting Settings dismisses it per provider until the key state changes.

### 3.8 Empty & onboarding states

First run: welcome (+ privacy statement) → pick workspace → add key ("or use a local model"). Empty session: three example prompts. Empty workspace: explains drag-and-drop.

## 4. What assistant-ui covers vs. what we build

| assistant-ui gives us | We build (custom components in `renderer/src/components/`) |
|---|---|
| Thread, message primitives, composer, runtime, streaming markdown | PlanPanel, ChangesPanel, ApprovalDialog, BeforeAfterCard, SessionsSidebar, WorkspacePicker, SettingsDialog, QuickActions, FileAttach, status banner |
| Tool-UI slots (`setToolUI` via `useAssistantApi().tools()`) | The per-tool card bodies (M2.4) |
| Tailwind/shadcn compatibility | Theming tokens (§7) |

**Fallback ladder (AGENTS.md rule 4):**
1. Compose from assistant-ui primitives first.
2. If that truly doesn't cover it, adopt a component from a **licensed shadcn-style registry**: **prompt-kit (MIT) is the primary source; AI Elements (Apache-2.0, Vercel) is pattern-reference only** (it targets Next.js + Tailwind v4, so vet each component for Next-isms such as `next/image` before adopting). Both are copy-paste registries, not npm packages — any npm dependency a copied component pulls in gets its own STACK.md row in the same commit (AGENTS.md rule 1).
3. If neither covers it, read `CodexDesktop-Rebuild` as reference and write a fresh implementation from notes (never verbatim, no OpenAI branding).
4. Log the component below — custom builds *and* registry adoptions alike.

**Components log:** *(append as built or adopted — name, source + license if adopted from a registry, one line, why assistant-ui didn't cover it)*

- SettingsDialog — hand-rolled modal for the Providers section (provider dropdown, API-key entry with "•••• last4" masking, model pick; docs/04 §3.7) — assistant-ui has no settings/app-chrome surface to compose (M1.1); built fresh from spec without the fallback-ladder reference repo.
- SettingsDialog M6.3 expansion — Providers (custom OpenAI-compatible profiles: add/edit/remove/use + Test connection), Appearance (dark/light/system), Permissions (risk 1/2 defaults, risk 3 locked), Data (open folder, clear conversations, purge snapshots, redacted eval export) — same hand-rolled modal, existing token classes plus settings-custom-* additions; no registry adoption, no new deps.
- SessionsSidebar — left rail: "+ New chat" button, session list (title + relative timestamp), active highlight, click to open (docs/04 §2/§3.1; M1.3) — assistant-ui has no session/app-chrome navigation primitive; built fresh from spec (plain CSS per §3.1's no-diff/no-terminal rules; Workspace section, delete/rename arrive later).
- Sidebar content fix (2026-09-10, user-reported) — session rows show the **bound folder's path** (short paths whole, long ones keep the last two segments with an ellipsis head — same treatment as the workspace chip; full path in the tooltip; "No folder" for '' placeholder rows) and the per-item "N in · N out" token line is gone (totals stay recorded in `usage_events` and on `SessionInfo`, just not rendered); the workspace chip's tooltip says it applies to **new chats**. Thread welcome reworked after a "still generic" rejection: a small-caps **eyebrow names the folder the new chat will work in** (`Working in {tail}` via `workspaces.get` — the same state `session:create` stamps; "Pick a folder to work in" fallback) above the h1, and the lede is two sentences doing two jobs — a concrete invitation ("Ask for anything in this folder — find, read, fix, or reorganize.") plus the trust promise in the app's own vocabulary ("Bigger changes come back as a plan to approve, and every change can be undone."), `text-wrap: balance` so it never strands a word. Verification run-status copy reworked the same pass ("Verified. Finishing up..." / "The result could not be fully verified." → "Everything checks out — finishing up." / "Some results could not be confirmed — take a quick look when it finishes.") — no component adoption, no new deps.
- MarkdownText — streaming markdown for assistant replies: `MarkdownTextPrimitive` from `@assistant-ui/react-markdown` (0.11.9 — the highest version whose peer range accepts the pinned `@assistant-ui/react` 0.11.56) + `remark-gfm`, with token-styled element components and a CodeHeader ("code — JavaScript · copy") whose copy button uses `navigator.clipboard` only — assistant-ui core ships no markdown renderer (verified against the installed 0.11.56 .d.ts) (M1.7).
- ThinkingIndicator — prompt-kit **Loader** (MIT, prompt-kit.com/c/loader.json) adopted via the shadcn registry and trimmed to the "dots" variant, animated by CSS keyframes in main.css — assistant-ui 0.11.56 has no thinking/reasoning indicator primitive and `MessagePartPrimitive.InProgress` only renders inside a running *text* part, which never exists during the gpt-oss reasoning lead-in (M1.3). prompt-kit's Thinking-Bar was evaluated and rejected: it imports `lucide-react` (not installed, no STACK.md row) plus a `text-shimmer` registry dependency (M1.7).
- ScrollToBottomButton — custom composition on `ThreadPrimitive.ScrollToBottom` (Viewport auto-sticks while `isAtBottom`); visibility styled off `:disabled` since 0.11.56 primitives expose no data-state attributes — assistant-ui covered this one, so no registry adoption and `use-stick-to-bottom` stayed uninstalled (M1.7).
- WriteFileCard / CreateDirCard — per-tool card bodies on the `setToolUI` slots showing before/after excerpts (write_file) and created/existed state (create_dir), plain-language titles from the registry `describe()` — assistant-ui ships the slots but no file-tool bodies (M2.5).
- ChangesStub — session checkpoint list (relative paths, new/replaced meta, active count) refreshing on run settle — replaced by the full ChangesPanel with undo in M2.8 (M2.5).
- EditFileCard — per-tool card body on the `setToolUI` slot showing the changed region's before/after excerpts (±3 context lines) — no diff component anywhere per §3.1 (M2.6).
- MovePathCard / CopyPathCard / DeletePathCard — per-tool card bodies on the `setToolUI` slots showing source → destination (move/copy, with replaced-existing note) and the deleted name (delete, noting the checkpoint keeps the content for undo); absolute result paths reduced to file names — assistant-ui ships the slots but no file-tool bodies (M2.7).
- ChangesPanel — session checkpoint list replacing ChangesStub: rows sharing a toolCallId render as one item (a move is one "Moved A → B" row), friendly action + relative time, per-item `undo ↩` behind an inline confirm, Undo all behind a confirm, reverted rows dim + "restored ✓", eviction refusals surface as honest errors — assistant-ui has no changes/history surface (M2.8).
- ReadDocumentCard / SummarizeDocumentCard / WebFetchCard — per-tool card bodies on the `setToolUI` slots for the MVP read-only tools: extracted text preview (with truncation meta), plain-language summary, fetched page text with the page `<title>` in the meta — assistant-ui ships the slots but no document/web bodies; built fresh per §3.1 (no code aesthetics) (MVP 2026-09-10).
- SemanticSearchCard — ranked results (workspace-relative path, score %, snippet) each rendered as a button that opens the file with the OS default app via `system:open-path`; empty state points at search_files for exact-text matching — no assistant-ui or registry equivalent exists; built fresh per §3.1 (MVP 2026-09-10).
- WebSearchCard — ranked web results (title + address + snippet, display-only; the model opens a result with web_fetch) with an empty state suggesting different words — no assistant-ui equivalent; built fresh per §3.1 (demo 2026-09-12).
- WebSearchCard provider suffix + Settings Web-search key (2026-09-12, user-requested) — the card meta names the answering engine ("N web results · via Tavily" vs "· keyless results", en/ar locale keys), and the Providers tab ends with a "Web search (Tavily)" field after the custom-provider block (explicit "Key saved (•••• last4)" / "No key saved" status reusing the provider-row copy, save/remove through the existing key surface under id `tavily`, draft cleared on reopen) — no component adoption, no new deps.
- EditDocumentCard — before/after excerpts for `edit_document` (same shape as EditFileCard plus an "N edits applied" meta line) — no diff component anywhere per §3.1 (demo 2026-09-12).
- `create_document` renders the existing WriteFileCard (its result matches the write_file shape with `beforeExcerpt: null`) under a new `cards.tool.createDocument` title — no new card (demo 2026-09-12).
- UI polish pass (2026-09-10) — **no new components adopted** (AGENTS.md rule 4 ladder never needed, restructure only): the fixed-position Plan/Changes overlays became in-flow children of one `aside.right-rail` in `App.tsx` (thread wrapped in its own `main.chat-main` flex column; rail collapses when unused), and Settings + the sidecar status dot moved into the SessionsSidebar footer.
- Sidebar dedup (2026-09-11, user-reported) — session rows show a compact folder-name tag (full bound path in the tooltip) instead of repeating the full workspace path per row, and rows sit under Today / Yesterday / Earlier this week / Older date headers (local calendar days, Monday-start week) with the per-row relative timestamp kept — no component adoption, no new deps.
- Sidebar sort toggle (2026-09-11, user-requested) — Recency | Folder segmented control beside the "Conversations" label (default Recency, remembered in localStorage; view-only, no IPC/Settings changes): Folder mode groups each folder's chats together with the picker's current folder pinned first (live — the picker pushes its value up on mount and every pick/set, and the switched-to folder auto-expands), path once in the section header, colliding leaf names disambiguated with a parent segment, per-row folder tag hidden; folder sections collapse per-section behind a chevron toggle, and the Recency date buckets collapse the same way (all expanded by default, remembered in localStorage) — no component adoption, no new deps.
- Composer file references + Settings badge + contextual prompts (2026-09-11, user-reported) — **FileAttach** (paperclip + `@`-mention sharing one `workspace:list-files` picker; chips above the input, reference-text injection in `transport.ts`, disabled mid-run/reply-mode) — assistant-ui's composer has no workspace-file notion and its native `Attachment` API carries binary `File`s, so a custom reference-only build was required; **Settings attention dot** (built-in provider without a key only, tooltip + per-provider visit-dismiss in localStorage; no update check — out of scope per docs/02, no phone-home per docs/06); **QuickActions** now scan (`workspace:list-files` capped at 500 + session titles, thresholds mirrored in `main/agent/workspace-listing.ts` and tested there since the renderer cannot import node:path) instead of three static chips — no registry adoption, no new deps.
- Contrast tiers (2026-09-11, user-reported) — strictly grayscale, no new hue: Tier 1 primary `var(--foreground)` (titles, message text, active labels, workspace path 600); Tier 2 secondary solid `var(--muted-foreground)` (timestamps, folder tags/paths, hints, card meta — the `70%` mixes on `.session-item-meta`/`.session-rename-hint` removed); Tier 3 placeholder/disabled `color-mix(muted-foreground 55%, transparent)` + `:disabled opacity .4`. Active conversation row (variant C): 12% foreground fill + brighter border + bold title, folder tag flattened to plain text on the active row only; Plan/Act active pill is a filled near-white pill (`--foreground` bg, `--background` text, 700) and hovering/focusing the unselected tab previews its description in the hint line. Send button untouched — no component adoption, no new deps.
- Home warmth pass (2026-09-11, user-requested) — greeting line + icon-led chips + micro-motion, still strictly grayscale: `ThreadWelcome` gains a Tier-1 `h1.thread-welcome-greeting` (one of `Ready when you are.` / `What shall we work on?`, picked at random once per App lifetime so session switches keep the line) above the unchanged Tier-2 folder eyebrow; `QuickActions` chips gain a leading hand-inline line icon (folder/document/search/list/spark by prompt substring, `currentColor` 2px round like the paperclip — no icon dep); chips lift 1px on hover/focus-visible, rows/buttons/tabs transition all state properties at the existing 150–160ms ease; greeting/composer/chips enter once via `home-in` 250ms (delays 0/50/100ms, composer gated behind `.thread:has(.thread-welcome)`) with the spent flag owned by App and latched per Thread mount so later new chats and focus events never replay; `prefers-reduced-motion: reduce` nulls all of it; act-mode placeholder `Message Agento…` → `Ask anything…` (plan placeholder untouched) — no component adoption, no new deps.
- Slash commands (2026-09-11, user-requested) — **SlashMenu** (upward popover on a leading `/`, same treatment as the file picker; Enter/click picks, arrows move, Esc/outside dismisses; template rows pre-fill `/name ` and the send paths expand to prose, local `/undo` + `/undo-all` open an inline confirm naming the target and fan out oldest-first exactly like the panel/Ctrl+Z, `/help` lists the catalog in place) + pure `chat/slash-commands.ts` (catalog, leading-slash parser, menu-query, template expansion — 11 vitest cases; vitest include widened to `src/renderer/src/chat/*.test.ts` for pure modules, still node env, no DOM scope change) — assistant-ui's composer has no slash notion (same reason FileAttach is custom); no registry/IPC/preload changes (templates ride `chat:send`, undos reuse `changes:list/undo/undo-all`), no new deps.
- Workspace Overview (2026-09-11, user-requested demo destination) — **WorkspaceOverview** (center-column swap, idle navigation only; header + snapshot strip + workspace-filtered recent work + contextual task starters that fill the composer via a one-shot `ComposerPrefill` on the thread runtime, never auto-send; right rail hidden while up) + pure `chat/workspace-summary.ts` (snapshot counts + path-tail contract, vitest-covered; no node:, no window) — assistant-ui has no workspace-home notion; no IPC/preload changes (current folder arrives as a prop pushed up from the sidebar picker through App — a switch while mounted follows it, keyed remount so no stale listing flashes; `workspace:list-files` + sessions prop), no new deps.
- Reshape (2026-09-11, user feedback: the recent list duplicated the sidebar) — single resume card + "Activity in this folder" stat boxes from new pure `chat/folder-activity.ts` (session counts, compact `~Nk` tokens — vitest-covered; minimal structural input so transport.ts → `ai` never enters the node test scope) + empty-folder onboarding copy + empty-aware starters (`EMPTY_FOLDER_PROMPTS` mirrored in main `workspace-listing.ts` by contract, tests both sides; home QuickActions inherits the fix through the shared scanner). Hierarchy pass (user feedback: wall of text) — activity sentence became conditional stat boxes reusing the "What's here" pattern, empty notes merged to one line, path truncates to one line with full-path tooltip, pill Back control, → affordance on the resume card; existing tokens only.
- Thread notice + composer alignment (2026-09-12, user-requested) — incomplete `verification/finished` no longer sets a thread-level run-status line (empty-string sentinel hides `.run-status` until settle clears; `app.notVerified` en/ar keys removed) while the per-step `not verified` badge in PlanPanel stays; paperclip button matches the Send/Stop box (16px icon, `0.65rem 0.6rem` padding so its 2.3rem height equals their 1.6em text + `0.7rem`, `0.5rem` radius, ghost treatment kept, anchor bottom-aligned) — no component adoption, no new deps.

## 5. Copy rules

Never raw in replies: JSON, tool names, stack traces, HTTP codes. Shared `friendly.ts` maps failures (used by registry `describe()` and error events):

| Raw | UI |
|---|---|
| `ENOENT` | "I couldn't find that file — it may have been moved or renamed." |
| provider 401 | "The API key for this provider isn't working. Check it in Settings → Providers." |
| provider 429 | "The model is rate-limiting us. I'll wait a moment and retry." |
| plan phase 400 (incl. `tool_use_failed`) | "I couldn't create a plan for that. Try rephrasing the request." |
| text-only plan answer to a file-changing request | "I couldn't make a plan for that request, so I didn't change anything. Try rephrasing it." (never a dead "Sure!" with no file) |
| approved plan, zero tool calls | "I prepared the plan but didn't take any actions, so nothing changed. Try saying which file to create and what to put in it." |
| parse failure | "I couldn't read this document — it may be a scan or password-protected." |
| sandbox rejection | "That's outside your workspace folder, so I won't touch it." |

Voice: present tense, first person, no exclamation marks, no emoji in system copy; numbers over vibes ("42 files moved", not "All done!").

**Arabic UI (Settings → Appearance → Language):** the whole renderer chrome is translated via the hand-rolled `chat/locale.ts` dictionary (no i18n dep — ~380 keys, `translate`/`fill`/`plural`/`relativeTime` helpers, `LocaleProvider` + `useLocale()` binding; missing keys are a type error). English-only by design: agent reply text, approval title/body (main `describe()`), slash-template prose sent to the model, and the QuickActions/example-prompt utterances. `<html lang/dir>` flips (`rtl` for Arabic); flex rows mirror automatically, physical CSS (text-align, absolute pins, rail borders, list indents, chevrons) is overridden in one `[dir='rtl']` block at the end of `main.css`; user-content names/paths render inside `<bdi>`. Arabic glyphs come from system fonts (Inter has none — no bundled font, no STACK.md change); Arabic plurals use the simplified one/two/many with dual support.

## 6. States & banners

Run states map 1:1 to the session state machine (doc 03 §3). **Degraded banner** (top, dismissible per session): "Document tools offline — .docx/.pdf reading unavailable. Everything else works." No-key and no-workspace disable the composer with a single call-to-action. Non-conversation errors toast; conversation errors render as failed cards + an honest sentence.

## 7. Keyboard & theming

| Keys | Action |
|---|---|
| ⌘/Ctrl+N | New session |
| ⌘/Ctrl+K | Command palette (P1) |
| Esc | Stop run · close preview |
| ⌘/Ctrl+Z | Undo last change (idle only) |
| / | Slash-command menu (search, semantic, undo, help) |
| Enter / Shift+Enter | Send / newline |
| ⌘/Ctrl+, | Settings |

Tailwind + shadcn tokens; light/dark/system; one accent (neutral gray — user decision 2026-09-06, was indigo) + semantic green/amber/red only for status/risk. Inter for UI; monospace only where content *is* code (markdown code blocks inside answers) — never as chrome. Spacious transcript (~760px centered), hairline borders over shadows, 150–200ms status transitions, one satisfying check-pop on verification, `prefers-reduced-motion` respected, WCAG AA in both themes, keyboard nav throughout.

## 8. Design system & visual polish

The tokens and details that make the transcript feel finished. Landed at M1.6/M1.7 — before M2 — so every later component (action cards, panels, dialogs) is built on the design system instead of restyled after it. §7's principles (one neutral accent — user decision 2026-09-06, was indigo — semantic status colors, hairline borders, 150–200ms budget) are the constraints this section implements.

### 8.1 Foundation (M1.6)

Tailwind v4 + shadcn/ui initialized (CSS-first config, `components.json`) — both already sanctioned in STACK.md. shadcn token variables (`--background`, `--foreground`, `--primary`, `--border`, …) with **light and dark sets; dark is the default**, light is ready but the user-facing switcher lands with the Appearance section (M6.3). The existing hand-written chrome (`SessionsSidebar`, `SettingsDialog`, thread, composer — currently plain M0.2/M1.1/M1.3 CSS) is restyled onto these tokens; no behavior changes. Inter is self-hosted via `@fontsource-variable/inter` (bundled by Vite → same-origin, no CSP change) so §7's font rule holds offline.

### 8.2 Scrollbars (M1.6)

Every scroll region styles its scrollbar — the native Chromium default never shows. Applies to: thread viewport, sessions list, settings body, composer textarea, and every later scrollable panel (tool-card bodies, plan/changes panels).

- `::-webkit-scrollbar*` (the renderer is Chromium-only): 8px thumb, fully rounded, themed to the border/mute token; transparent track; thumb brightens on hover; horizontal variant too.
- `scrollbar-width: thin` + `scrollbar-gutter: stable` as the non-WebKit fallback line.
- Must render correctly in both §8.1 theme sets and never introduce layout shift.

### 8.3 Markdown in messages (M1.7)

Model replies render as markdown, not preformatted text: `@assistant-ui/react-markdown` (STACK.md) with GFM (tables, task lists, strikethrough) via `remark-gfm`.

- Styled: headings, lists, tables (hairline borders per §7), blockquotes, horizontal rules; links in the accent — **neutral gray since the 2026-09-06 accent decision (was indigo)** — underline on hover.
- Inline code and fenced code blocks may use monospace — §7's exception, the content *is* code. Code blocks get a plain-language header ("code — JavaScript · copy") and a copy button; **no syntax highlighting initially** (optional later; would need a STACK.md row for shiki).
- Copy rules (§5) still apply around it: the renderer changes presentation, never what the model says.
- Streaming-safe: partial markdown renders progressively without layout jumps (assistant-ui's streaming markdown).

### 8.4 Motion (M1.7)

CSS-first within §7's 150–200ms budget; `prefers-reduced-motion: reduce` disables every item below:

- **Streaming indicator:** a small "thinking" affordance (animated dots or shimmer — the prompt-kit Loader/Thinking-Bar pattern) shown while a reply is running but no text has arrived yet; this also covers the reasoning-model lead-in.
- **Message enter:** ~150ms fade/rise on new messages; hover states on cards, rows, buttons; the one check-pop on verification arrives with M3.5's badges.
- The `motion` npm package is admitted only if a copied prompt-kit component requires it (STACK.md row in the same commit); otherwise keyframes only.
