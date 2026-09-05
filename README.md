# Agento

![Platform](https://img.shields.io/badge/platform-Windows_10%20%7C%2011-blue)
![Desktop](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-24_LTS-339933?logo=nodedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![Status](https://img.shields.io/badge/status-under_active_development-orange)

**A local-first desktop AI agent for your files — not another chat window.**

Tell Agento what you want done in plain language — "sort these invoices into folders", "summarize this contract", "find who still owes a reply" — and it plans the work, asks before anything risky, shows every step in plain words, verifies its own results, and lets you undo anything it touched. It runs entirely on your machine: no accounts, no telemetry, no cloud in the middle. Your data never passes through any server except the model provider you chose. Built for Windows first.

> **Under active development.** The chat core works today; the agent core — plans, approvals, snapshots, undo — is landing next.

## Highlights

- **A trust layer, not just a chat box.** Every action passes through intent classification, a per-step risk gate, a visible plan, explicit approval for risky operations, and post-hoc completion verification. Safety is enforced by code, not requested in a prompt.
- **Plain language everywhere.** The interaction model of a modern coding agent — streaming answers, action cards, a live task plan — applied to everyday documents and folders. No terminal, no code view, no jargon.
- **Local-first by design.** Everything runs on your machine. API keys are encrypted with OS-level protection, an optional localhost sidecar handles document intelligence, and the full network egress inventory is four lines long.

## Features

- Real streaming chat on your own API keys — **Google AI Studio** and **Groq** (free-tier friendly), switchable in Settings
- **Sessions** with a sidebar — titles, ordering, and full history persist across restarts (SQLite, WAL mode)
- **Stop button** — aborts a run end-to-end, keeps the partial reply, and leaves the session clean and resumable
- **Token usage per session** — recorded locally and shown in the session list
- Encrypted key storage (Electron `safeStorage` / Windows DPAPI) — keys never leave the machine except to the provider endpoint
- Honesty-first failure handling — provider, persistence, and setup failures render as visible sentences, never swallowed

## Roadmap

- **Agent core** — file tools behind a plan → approve → execute flow, with snapshot-based undo for every change
- **Document understanding** — read, edit, convert, and summarize `.docx .pdf .pptx .xlsx .csv .md .txt` via Docling
- **Web research** — fetch and summarize pages; optional search-API integration
- **Local models** — fully offline via Ollama
- **Design system** — token-based theming with dark mode by default, styled scrollbars, markdown rendering

## Quick start

**Prerequisites:** [Node.js 24 LTS](https://nodejs.org/) · npm (bundled) · Python 3.12 + [uv](https://docs.astral.sh/uv/) *(optional — powers the intelligence sidecar; chat works without it and the status dot reflects its health)*

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

Every change goes through the full quality gate: typecheck, lint, and sidecar tests green before anything is considered done.

## Built with

Deliberately **thin own codebase assembled from open source**, so most of the code is maintained by someone else:

| Part | Choice |
|---|---|
| UI | **assistant-ui** in an Electron shell — React 19; Tailwind + shadcn/ui tokens arrive with the design system |
| Agent loop | **Vercel AI SDK v5** (`ai`) — streaming, tool calling, multi-provider by API key |
| Documents & trust layer | Python **FastAPI** sidecar with **Docling** parsing (`127.0.0.1:7891`, never leaves the machine) |
| Storage | SQLite (`better-sqlite3` + Drizzle) — sessions, usage, snapshots, undo |
| Contracts | **Zod** — every IPC payload validated on both sides of the bridge |

## Project structure

```
agento/
├── app/                        # The Electron app (electron-vite)
│   └── src/
│       ├── main/               # Node side: chat pipeline, storage, IPC, settings
│       ├── preload/            # Typed contextBridge — the ONLY renderer bridge
│       └── renderer/           # React UI (assistant-ui)
└── services/
    └── intelligence/           # Python sidecar: FastAPI + Docling + trust layer + eval
```

## Privacy & security

- **Local-first:** no accounts, no telemetry, no update phone-home — the complete network egress inventory is four lines long: your model provider, an optional search API, a one-time document-model download, and localhost.
- **Encrypted keys:** provider API keys are sealed with OS-level encryption (DPAPI on Windows), decrypted only in the main process, on demand.
- **Safety by code, not prompts:** every file mutation goes through a registry wrapper that enforces validation → sandboxing → risk → approval → snapshot → execute. There is no shell/terminal tool, and none may be added.

## License

Not yet published under an OSS license — a permissive one (MIT or Apache-2.0) will be added with the first public release. All third-party dependencies are permissively licensed (MIT / Apache-2.0 / BSD / ISC).
