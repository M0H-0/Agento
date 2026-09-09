# STACK.md — What Agento Is Built With (Pinned)

**This file is the anti-hallucination contract.** If a package is not listed here, it is not part of Agento. Adding anything: update this file in the same commit (AGENTS.md rule 1). Exact versions live in `app/package-lock.json` and `services/intelligence/uv.lock` — never guessed, always from the lockfile.

## Runtime & tooling

| Tool | Version line | Role | License |
|---|---|---|---|
| Node.js | 24 LTS | JS/TS runtime (main process + build) | — |
| Python | 3.12 | Sidecar runtime | — |
| **Electron** | latest stable | Desktop shell, window, IPC, safeStorage, printToPDF | MIT |
| **electron-vite** | latest | Dev server + build for main/preload/renderer | MIT |
| **electron-builder** | latest | Packaging — **NSIS installer, Windows primary target** | MIT |
| **uv** | latest | Python project + dependency + script runner | Apache-2.0 |
| npm | bundled with Node | Package manager (no workspaces; one JS package) | — |

## UI layer (`app/src/renderer`) — React

| Package | Role | License |
|---|---|---|
| **@assistant-ui/react** | The chat/agent UI: message list, composer, runtime, tool-UI slots | MIT |
| **@assistant-ui/react-ai-sdk** | Bridges AI SDK `useChat` state into assistant-ui runtime | MIT |
| **@assistant-ui/react-markdown** | Streaming markdown rendering in messages | MIT |
| react / react-dom | 19.x (as resolved by the electron-vite scaffold; was 18.x pre-M0.1) | MIT |
| tailwindcss + shadcn/ui components | Styling + owned component primitives (buttons, dialogs, inputs) — versions as produced by shadcn's current installer | MIT |
| @tailwindcss/vite | Tailwind v4's Vite plugin — required to build the CSS-first `main.css` entry under electron-vite's renderer (docs/04 §8.1) | MIT |
| clsx | Class-name composer behind shadcn's `cn()` utility (`src/renderer/src/lib/utils.ts`) | MIT |
| tailwind-merge | Tailwind class-conflict resolution behind shadcn's `cn()` utility | MIT |
| zustand | Renderer state store fed by IPC events | MIT |
| lucide-react | Icons | ISC |
| pdfjs-dist (pdf.js) | PDF rendering in the document preview (P1, docs/04 §3.6) | Apache-2.0 |
| mammoth | DOCX → HTML for the document preview (P1, docs/04 §3.6) | BSD-2-Clause |
| remark-gfm | GFM (tables, task lists, strikethrough) for message markdown (docs/04 §8.3) | MIT |
| @fontsource-variable/inter | Self-hosted Inter font, bundled by Vite (docs/04 §8.1) | MIT (font files: SIL OFL 1.1 — permissive, embedding permitted) |
| use-stick-to-bottom | Chat scroll anchoring + scroll-to-bottom button (docs/04 §8.4; only if assistant-ui doesn't cover it) | MIT |
| motion | Animations (docs/04 §8.4; only if a copied prompt-kit component requires it — otherwise CSS keyframes) | MIT |

**Copy-paste component sources (not npm packages):** UI components may be adopted from licensed shadcn-style registries per docs/04 §4's fallback ladder — **prompt-kit** (MIT, primary; github.com/ibelick/prompt-kit) and **AI Elements** (Apache-2.0, Vercel; elements.ai-sdk.dev — pattern-reference only, targets Next.js). Copied code is owned code: any npm dependency a component imports must get its own row above in the same commit (AGENTS.md rule 1).

## Backend (main process, `app/src/main`)

| Package | Role | License |
|---|---|---|
| **ai** | v5 — `streamText` agent loop, tool calling, UI message streams | Apache-2.0 |
| **@ai-sdk/react** | `useChat` in the renderer with a custom IPC transport | Apache-2.0 |
| **@ai-sdk/openai** · **@ai-sdk/anthropic** · **@ai-sdk/google** | First-class providers | Apache-2.0 |
| **@ai-sdk/openai-compatible** | OpenRouter, Groq, LM Studio, Ollama (local) | Apache-2.0 |
| **@modelcontextprotocol/sdk** | MCP client — community tools, wrapped into our registry | MIT |
| **zod** | All contracts (IPC + sidecar + tool schemas) | MIT |
| **better-sqlite3** | Synchronous SQLite in the main process | MIT |
| **@types/better-sqlite3** | TypeScript declarations for better-sqlite3 (devDependencies) | MIT |
| **drizzle-orm** + **drizzle-kit** | Typed schema + migrations | Apache-2.0 / MIT |
| **undici** | HTTP for web_fetch | MIT |
| **@mozilla/readability** | Article extraction for web pages | Apache-2.0 |
| **@vscode/ripgrep** | Prebuilt ripgrep binary for file search | MIT |
| typescript / vitest / eslint | Language, tests, lint (in devDependencies) | Apache-2.0 / MIT |

## Python sidecar (`services/intelligence`)

| Package | Role | License |
|---|---|---|
| **fastapi** + **uvicorn** | HTTP service on `127.0.0.1:7891` | MIT / BSD-3 |
| **pydantic** v2 | Request/response contracts | MIT |
| **docling** | PDF/DOCX/PPTX/XLSX/CSV/HTML parsing to structured markdown | MIT |
| **pypdf** | `.pdf` text extraction (MVP cut — see PROGRESS.md Devlog; Docling stays the M4.7 choice for structured parsing) | BSD-3 |
| **python-docx** | `.docx` text extraction (MVP cut) + edit round-trips (text-level) | MIT |
| pytest | Tests + eval harness | MIT |

## Model providers (user supplies keys; all optional)

| Provider | Via | Notes |
|---|---|---|
| Google AI Studio | `@ai-sdk/google` | Generous free tier — good default for the demo |
| Groq | `@ai-sdk/openai-compatible` | Free tier, very fast |
| OpenRouter | `@ai-sdk/openai-compatible` | Free model variants available; one key, many models |
| OpenAI | `@ai-sdk/openai` | |
| Anthropic | `@ai-sdk/anthropic` | |
| Ollama (local) | `@ai-sdk/openai-compatible` @ `127.0.0.1:11434/v1` | Fully local option; tool-capable models required |

Agent capability requires **tool calling** — the model picker warns on models without it.

## Do NOT substitute — decisions already made

| Instead of… | We use… | Because |
|---|---|---|
| Any other chat UI kit (LobeChat, Chatbox, Vercel template UI, custom from scratch) | **assistant-ui** | MIT, purpose-built for agent UIs, integrates with `ai` v5 |
| Cline / Claude Agent SDK / any existing agent CLI or engine | **`ai` v5 + our thin registry** | Project requirement: lightweight, API-key-based, no embedded CLI |
| Cline / Tauri | **Electron** | Node-sidecar ecosystem, Codex-adjacent stack |
| Cherry Studio fork | rejected | **AGPL-3.0** — license contamination |
| python-docx/PyMuPDF/openpyxl wired by hand | **Docling** | One parser, best table/PDF quality |
| Shadow-git checkpoints | **SQLite snapshots** | Users' folders aren't git repos; simpler restore |
| react-diff-view / any diff renderer | **none** — before/after excerpts | Product decision: no code view |
| pnpm / yarn | **npm** | Fewest failure modes for agents on Windows |
| Anything not in the tables above | — | Update this file first |

## License rule

Every dependency above is permissive (MIT / Apache-2.0 / BSD / ISC). AGPL and GPL are banned (AGENTS.md rule 9). Copy-paste code from **licensed shadcn-style registries** (prompt-kit, AI Elements — see the UI-layer note above) is owned code and allowed per the docs/04 §4 ladder. Code from **unlicensed** repositories (e.g. `CodexDesktop-Rebuild`) may be *read for reference* but never copied — AGENTS.md rule 4.
