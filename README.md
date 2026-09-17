# Agento

![Platform](https://img.shields.io/badge/platform-Windows_10%20%7C%2011-blue)
![Desktop](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-24_LTS-339933?logo=nodedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![Status](https://img.shields.io/badge/status-under_active_development-orange)

Desktop app that does file chores from plain-English instructions. Runs on your machine using your own API key. Windows only.

Tell Agento what you want — "sort these invoices into folders", "summarize this contract" — and it makes a plan, asks before doing anything risky, and lets you undo what it touched. No accounts, no telemetry. Your files stay on your machine.

> Under active development. Chat, file plans, approvals, snapshots, and undo work. Document understanding is still in progress.

## What it does

- File work behind a plan → approve → execute flow, with snapshot undo for every change
- Streaming chat on your own API keys — Google AI Studio and Groq, switchable in Settings
- Sessions with full history, persisted across restarts (SQLite)
- Stop button that aborts a run end-to-end and keeps the partial reply
- Per-session token usage, recorded locally
- API keys encrypted with OS-level protection (Windows DPAPI), decrypted only when needed
- Failures show up as plain sentences instead of silent errors

## Roadmap

- Document understanding — read, edit, convert, and summarize `.docx .pdf .pptx .xlsx .csv .md .txt` via Docling
- Web research — fetch and summarize pages
- Fully offline models via Ollama
- Theming with dark mode

## Quick start

**Prerequisites:** [Node.js 24 LTS](https://nodejs.org/) · npm (bundled) · Python 3.12 + [uv](https://docs.astral.sh/uv/) *(optional — powers the intelligence sidecar; chat works without it)*

```powershell
git clone https://github.com/M0H-0/Agento.git agento
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

## Built with

| Part | Choice |
|---|---|
| UI | **assistant-ui** in an Electron shell — React 19, Tailwind |
| Agent loop | **Vercel AI SDK v5** (`ai`) — streaming, tool calling |
| Documents | Python **FastAPI** sidecar with **Docling** parsing (`127.0.0.1:7891`, never leaves the machine) |
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
    └── intelligence/           # Python sidecar: FastAPI + Docling
```

## Privacy

- No accounts, no telemetry, no update phone-home. Network traffic goes to: your model provider, an optional search API, a one-time document-model download, and localhost.
- API keys are sealed with OS-level encryption (DPAPI on Windows), decrypted only in the main process, on demand.
- Every file change passes through validation → sandboxing → risk check → approval → snapshot → execute. There is no shell tool.

## License

MIT — see [LICENSE](LICENSE). All third-party dependencies are permissively licensed (MIT / Apache-2.0 / BSD / ISC).
