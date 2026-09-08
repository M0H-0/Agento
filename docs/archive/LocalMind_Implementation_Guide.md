# LocalMind — Implementation Guide

## What You Are Building

**LocalMind** is a clean, general-purpose desktop AI agent for everyday tasks — working with documents, files, folders, and the web. It sits on top of whatever AI agent framework or codebase you are using and adds a custom ML intelligence layer that makes the agent smarter, more reliable, and more trustworthy.

**The target user is not a developer.** This is for anyone who wants an AI assistant that handles their documents, organizes their files, researches topics, and gets things done — with no technical knowledge required.

---

## What LocalMind Is and Is NOT

### IS
- A clean desktop app anyone can use
- Works with documents (Word, PDF, PowerPoint, Excel, Markdown), files, and folders
- Handles web research and summarization
- Shows the user a visible task plan before doing anything
- Safe — always asks before doing anything risky
- Handles code tasks the same as any other task — writes result to a file, no special dev UI

### IS NOT
- A developer IDE or coding tool with special views
- A terminal emulator
- A Docker/code execution environment
- Anything that requires technical knowledge to use

---

## Architecture Overview

LocalMind has three layers that work together:

```
┌─────────────────────────────────────────────┐
│           Desktop UI (Electron + React)      │
│  Workspace | Instruction | Task Plan Panel   │
│  Document Preview | Permission Modal | Revert│
└──────────────────┬──────────────────────────┘
                   │ IPC / HTTP
┌──────────────────▼──────────────────────────┐
│           Agent Layer (existing framework)   │
│  Agent loop → Tools → LLM → Response        │
│  + LocalMind system prompt injected          │
│  + LocalMind tools exposed to agent          │
└──────────────────┬──────────────────────────┘
                   │ HTTP localhost:7891
┌──────────────────▼──────────────────────────┐
│           LocalMind ML Backend (Python)      │
│  Intent Classifier | Completion Verifier     │
│  Safety Classifier | SQLite session store    │
└─────────────────────────────────────────────┘
```

The ML backend is always a separate Python FastAPI process. The agent layer is whatever framework the codebase uses — LocalMind adds to it without rewriting it.

---

## Component 1 — Python ML Backend

A lightweight FastAPI service running on `localhost:7891`. Starts alongside the desktop app. Provides the intelligence layer that the agent tools call.

### File Structure
```
localmind-backend/
├── main.py
├── requirements.txt
├── models/
│   ├── intent/
│   │   ├── model.py       # DistilBERT intent classifier
│   │   ├── train.py       # training script (runs separately)
│   │   └── saved/         # trained model weights go here
│   ├── completion/
│   │   ├── model.py       # NLI completion verifier
│   │   ├── train.py
│   │   └── saved/
│   └── safety/
│       ├── model.py       # safety classifier
│       ├── train.py
│       └── saved/
└── database.py            # SQLite session/action store
```

### API Endpoints

**`POST /intent/classify`**
```json
Input:  {"instruction": "string"}
Output: {
  "intent": "string",
  "confidence": 0.94,
  "requires_clarification": false,
  "attention_tokens": [{"token": "organize", "score": 0.87}]
}
```
Intent classes:
- `file_operation` — copy, move, delete, rename files/folders
- `document_edit` — edit, format, rewrite content in a document
- `document_read` — read, summarize, extract info from a document
- `web_research` — search the web, find information
- `organize` — sort, categorize, clean up files or content
- `code_task` — write or edit code, saved as a file like any other task
- `multi_step` — complex tasks combining several of the above

If `confidence < 0.7` → set `requires_clarification: true` → agent must ask user before acting.

**`POST /completion/verify`**
```json
Input:  {"instruction": "string", "action_taken": "string"}
Output: {
  "completion_score": 0.91,
  "is_complete": true,
  "missed_segments": []
}
```
`is_complete` = true when `completion_score >= 0.85`. `missed_segments` lists what was not done.

**`POST /safety/classify`**
```json
Input:  {"action_description": "string", "tool": "string"}
Output: {
  "risk_level": 1,
  "risk_label": "reversible",
  "explanation": "Creates a new file. Can be undone.",
  "requires_approval": false,
  "risk_tokens": [{"token": "create", "score": 0.76}]
}
```
Risk levels:
- 0 = safe (reading files, web searches, previewing)
- 1 = reversible (creating new files, adding content)
- 2 = irreversible (overwriting existing files, moving files)
- 3 = destructive (deleting files, bulk operations)

`requires_approval` = true when `risk_level >= 2`.

**`POST /session/action`** — log action before executing (enables revert)
```json
Input: {
  "session_id": "string",
  "step_id": "string",
  "action_type": "string",
  "file_path": "string|null",
  "file_content_before": "string|null"
}
Output: {"action_id": "string"}
```

**`POST /session/revert`** — restore file from saved snapshot
```json
Input:  {"action_id": "string"}
Output: {"restored": true, "file_path": "string|null"}
```

**`GET /session/history/{session_id}`**
Returns list of all logged actions with status for the revert timeline.

### SQLite Schema
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    workspace_path TEXT,
    instruction TEXT,
    intent TEXT,
    status TEXT DEFAULT 'active'
);

CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    step_id TEXT,
    action_type TEXT,
    tool_name TEXT,
    description TEXT,
    file_path TEXT,
    file_content_before BLOB,
    result TEXT,
    reverted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE task_steps (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    step_number INTEGER,
    description TEXT,
    tool TEXT,
    status TEXT DEFAULT 'pending',
    completion_score REAL,
    risk_level INTEGER DEFAULT 0,
    requires_approval BOOLEAN DEFAULT FALSE,
    approved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### ML Models

**Intent Classifier**
- Architecture: DistilBERT base + 6-class classification head
- Trained in PyTorch on a labeled dataset of user instructions
- Produces confidence scores and attention token explanations

**Task Completion Verifier**
- Architecture: Cross-encoder NLI model (distilroberta-base) fine-tuned for binary entailment
- Input: original instruction paired with completed action
- Produces a 0–1 completion score and list of missed requirements

**Action Safety Classifier**
- Architecture: DistilBERT base + 4-class classification head
- Trained on labeled action/tool pairs
- Fail-safe: when uncertain, defaults to higher risk level

All models load on startup. If a model file is missing, the endpoint returns a sensible default (mid-confidence, medium risk) rather than crashing.

---

## Component 2 — Agent Tools

The agent needs access to LocalMind capabilities as callable tools. Implement these as tools in whatever tool/extension system the agent framework uses.

### LocalMind Intelligence Tools

These wrap the ML backend endpoints:

**`classify_intent(instruction)`**
Calls `POST /intent/classify`. Agent calls this at the start of every new user instruction before doing anything else.

**`verify_completion(instruction, action_taken)`**
Calls `POST /completion/verify`. Agent calls this after completing each step to confirm it actually worked.

**`classify_safety(action_description, tool)`**
Calls `POST /safety/classify`. Agent calls this before any file write, move, or delete.

**`log_action(session_id, step_id, action_type, file_path)`**
Calls `POST /session/action`. Agent calls this before modifying any file — saves snapshot for revert.

**`revert_action(action_id)`**
Calls `POST /session/revert`. Restores a file to its state before the logged action.

### LocalMind Task Planner Tools

These manage the visible task plan and communicate with the UI:

**`create_task_plan(session_id, steps)`**
Called after the agent has planned all steps, before executing any. Sends the plan to the UI so the user sees it first.

Each step object:
```json
{
  "id": "step_1",
  "description": "Plain English description of what will happen",
  "tool": "tool_name",
  "risk_level": 0,
  "requires_approval": false,
  "status": "pending"
}
```

**`update_step_status(session_id, step_id, status, completion_score, error)`**
Called as each step progresses. Updates the live UI checklist. Status values: `pending`, `in_progress`, `done`, `failed`, `awaiting_approval`.

**`request_approval(session_id, step_id, action_description, risk_level, explanation)`**
Called before executing any step where `risk_level >= 2`. Blocks until the user approves or denies in the UI. Returns `approved: true/false`.

**`get_session_history(session_id)`**
Returns the action history for the revert timeline.

### Document Tools

A dedicated set of document-handling tools the agent uses for productivity tasks:

**`read_document(file_path)`**
Reads any supported format and returns plain text + structure. Supported: `.docx`, `.pdf`, `.pptx`, `.xlsx`, `.csv`, `.md`, `.txt`.

**`edit_document(file_path, instruction)`**
Makes targeted edits to a document. Always saves a snapshot before modifying (calls `log_action` automatically). Supported for editing: `.docx`, `.md`, `.txt`.

**`convert_document(file_path, target_format)`**
Converts between formats. Examples: `.docx → .pdf`, `.md → .docx`, `.xlsx → .csv`.

**`summarize_document(file_path, max_length)`**
Returns a summary without the full content — useful for large files that would overflow the LLM context window.

**`list_folder(folder_path)`**
Returns folder contents with file type, size, and last-modified metadata. Human-readable output, not raw filesystem data.

**`organize_files(folder_path, instruction)`**
Moves or renames files based on a plain-English rule. Always snapshots before moving. Example: "move all PDFs to a folder called Reports".

For document parsing, the tools call the Python ML backend (`localmind-backend`) which handles the heavy lifting with python-docx, PyMuPDF, python-pptx, openpyxl, etc.

**Graceful degradation:** If the ML backend is unavailable, all LocalMind tools return a sensible default and log a warning. The agent continues working as a basic agent without the intelligence layer.

---

## Component 3 — System Prompt

Inject this into the agent's system prompt. This is what transforms a generic agent into LocalMind.

```
You are LocalMind, a friendly and capable AI assistant for everyday tasks.

You help people work with their files, documents, and the web.
Keep your language clear and non-technical at all times.
Explain what you are doing in plain English — never mention tool names, JSON, or technical details in your responses.

TOOLS AVAILABLE:
- File tools: read, write, copy, move, rename, delete files and folders
- Document tools: read_document, edit_document, convert_document, summarize_document, list_folder, organize_files
- Web tools: search the web, fetch page content
- LocalMind intelligence: classify_intent, verify_completion, classify_safety, log_action, revert_action
- LocalMind planner: create_task_plan, update_step_status, request_approval, get_session_history

Keep your approach simple and general. If someone asks for a code-related task,
handle it like any other task — write the code to a file, explain what it does
in plain English. Do not use terminal or shell execution. Do not assume the user
is a developer or use technical jargon in your responses.

MANDATORY WORKFLOW — follow this for every instruction:

STEP 1 — UNDERSTAND
Call classify_intent with the user's instruction.
If requires_clarification is true: ask the user one clear, simple question before proceeding.
Never guess what the user wants.

STEP 2 — PLAN (before doing anything)
Break the task into clear, plain-English steps.
For each step, call classify_safety and note the risk level.
Call create_task_plan with all steps including risk levels.
The user will see this plan in the UI before you execute anything.

STEP 3 — EXECUTE STEP BY STEP
For each step:
  a. If risk_level >= 2: call request_approval. Wait. Only proceed if approved.
  b. Call log_action before modifying any file.
  c. Call update_step_status with status "in_progress".
  d. Execute the action.
  e. Call verify_completion with the instruction and what you did.
  f. If is_complete is false: retry up to 3 times, noting what was missed.
  g. After 3 failed retries: mark the step failed, continue to the next step.
  h. Call update_step_status with the final status and completion_score.

STEP 4 — RULES
- Never mark a step done without calling verify_completion first.
- Never delete or overwrite a file without user approval (risk_level >= 2).
- Never use technical jargon in your responses to the user.
- Never proceed when you are not sure what the user wants.
- Step descriptions in the task plan must be plain English: "Read the sales report" not "call read_document()".
- Describe actions conversationally: "I'm reading your document" not "Executing read_document tool".
```

---

## Component 4 — Desktop UI

The UI is Electron + React. Extend the existing UI — do not rewrite it.

**Core principle:** The user should never see JSON, tool names, raw error messages, or anything technical. Everything surfaces as friendly plain English.

### Feature 1 — Workspace Picker (left sidebar, top)

```
Clean folder picker at the top of the left sidebar.
Shows: current folder name + file count.
"Change Folder" button → native Electron folder dialog (ipcMain.handle + dialog.showOpenDialog).
Recent workspaces list (last 5) stored in localStorage.
Drag and drop support: drag a folder onto the app window to open it.
When folder selected: agent receives workspace path as context for every session.
```

### Feature 2 — Task Plan Panel (right sidebar)

The most important UI feature. Appears as soon as the agent creates a plan — before any execution.

```
Ordered checklist of steps in plain English.

Each step card shows:
  [Status icon]  Step description in plain English
                 [Tool type — friendly label, never technical name]
                 [Risk badge — plain language]
                 [Status indicator]
                 [Completion score bar — shown when done]
                 [Undo button — shown when done and file was modified]
                 [Retry button — shown when failed]

Status icons:
  ○  pending
  ↻  in_progress (animated spin)
  ✓  done (green, satisfying animation)
  ✗  failed (red)
  ⚠  awaiting_approval (amber)

Risk badges (plain language, not technical):
  risk 0 → no badge (safe, no noise)
  risk 1 → subtle note "Creates new file"
  risk 2 → amber "⚠ Will overwrite existing file" + Approve/Skip buttons inline
  risk 3 → red "⚠ Will delete" + Approve/Skip buttons inline

Summary at bottom: "3 of 5 steps complete"
"Undo last change" button at bottom if any step modified a file.
```

### Feature 3 — Document Preview (center panel)

Strongly recommended — makes the app feel trustworthy and visual instead of a black box.

```
When the agent reads or edits a document, show a preview.
Supported: PDF (pdf.js), .docx → HTML (mammoth.js), Markdown (marked.js), plain text.

For document edits: split view — original on left, edited on right.
"Accept changes" and "Reject changes" buttons.
Makes it immediately clear what the agent is actually doing to the user's files.
```

### Feature 4 — Permission Modal

Triggered whenever `request_approval` fires.

```
Full-screen overlay — cannot be dismissed by clicking outside.
Must make an explicit decision.

Shows:
  Plain English description: "I'm about to overwrite your document"
  What will change: simple explanation, no technical details
  [Approve]  [Skip this step]  [Cancel everything]

No JSON. No tool names. No technical output of any kind.
```

### Feature 5 — Revert Timeline (left sidebar, below workspace)

```
Compact list of file changes made this session.
Section title: "What I changed"
Each item: friendly description + timestamp.
Hover → "Undo this ↩" button appears.
Confirmation dialog: "This will restore [filename] to how it was before. Continue?"
After undo: item shown with strikethrough + "Restored ✓".
```

### Feature 6 — Quick Actions Bar (below instruction input)

Strongly recommended — makes the app immediately useful on first open.

```
Horizontal row of preset task chips below the instruction input:
  [Summarize this folder]  [Organize by type]  [Convert to PDF]
  [Find duplicates]  [Merge documents]  [Extract key points]

Clicking a chip fills the instruction input with a complete, well-formed prompt.
Makes the app useful for people who don't know what to type.
```

### IPC Events

The backend/agent sends these events to the UI. Handle them in the Electron main process and forward to the renderer:

```
localmind:plan-created       → {session_id, steps}               → show Task Plan Panel
localmind:step-updated       → {session_id, step_id, status,
                                completion_score, error}          → update step card
localmind:approval-required  → {session_id, step_id, description,
                                risk_level, explanation}          → show Permission Modal
localmind:document-preview   → {file_path, content_before,
                                content_after}                    → show Document Preview
localmind:session-complete   → {session_id, summary}             → show summary
```

### UI Style

```
Clean and minimal — generous white space.
Light or soft-dark theme — not a terminal aesthetic.
Large readable fonts — not developer monospace.
Friendly icons: documents, folders, not code brackets.
Left sidebar: workspace files and revert timeline.
Right sidebar: task plan panel.
Center: instruction input + document preview.
Raw tool output never shown — always rephrased as friendly text.
Developer settings moved to an "Advanced" section or hidden entirely.
```

---

## Component 5 — Auto-start ML Backend

In the Electron main process (`main.ts` or `main.js`):

```typescript
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as net from 'net'

let mlBackend: ChildProcess | null = null

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.once('listening', () => { server.close(); resolve(false) })
    server.listen(port)
  })
}

async function startMLBackend() {
  if (await isPortInUse(7891)) return  // already running, skip

  const backendPath = path.join(__dirname, '../../localmind-backend')
  mlBackend = spawn('python3', [
    '-m', 'uvicorn', 'main:app',
    '--host', '127.0.0.1',
    '--port', '7891',
    '--log-level', 'error'
  ], { cwd: backendPath, stdio: 'pipe' })

  mlBackend.on('error', () => {
    // App still works without ML features — graceful degradation
    console.warn('LocalMind ML backend unavailable. Running in basic mode.')
  })
}

// Call startMLBackend() inside app.whenReady()
// Kill mlBackend inside app.on('before-quit')
```

Show a loading screen on startup that polls `GET localhost:7891/health` every 500ms. Once it responds, show the main app. If no response after 15 seconds, show the app anyway in basic mode with a subtle notice.

---

## Development Order

Build in this order to avoid blocking yourself:

1. **Python backend stubs** — all endpoints return valid mock data. Verify HTTP works before touching anything else.
2. **Agent tools** — implement all LocalMind tools pointing at the mock backend. Verify the agent can call them.
3. **System prompt** — inject and test. Give the agent a simple instruction and check the workflow in logs.
4. **Task Plan Panel** — wire IPC events, verify the checklist appears and updates live.
5. **Document Preview** — high value, do this early. Makes testing much more satisfying and visual.
6. **Permission Modal** — wire the full approval flow end to end.
7. **Quick Actions bar** — makes demos immediately impressive.
8. **Train ML models** — swap mock backend responses for real model outputs.
9. **Polish** — revert timeline, workspace picker, drag and drop, style consistency.

---

## Verification Checklist

- [ ] ML backend starts at `localhost:7891`, `/intent/classify` returns valid JSON
- [ ] Loading screen shows on startup and disappears when backend is ready
- [ ] Giving a simple instruction triggers the full LocalMind workflow (classify → plan → execute → verify)
- [ ] Task Plan Panel appears with plain-English steps before any execution starts
- [ ] Steps update live as the agent works — animations and status icons work correctly
- [ ] Document preview shows when agent reads or edits a file
- [ ] A file overwrite triggers the Permission Modal
- [ ] Denying permission skips that step cleanly without crashing
- [ ] Undoing a completed file operation restores the original file
- [ ] Quick Actions chips fill the instruction input correctly
- [ ] Code task ("write a script to rename my files") treated the same as any other task — no special dev UI, result saved as a file
- [ ] No JSON, tool names, or technical text visible anywhere in the UI to the user
- [ ] If Python backend is not running, the app still opens and works in basic mode
