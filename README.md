# Airtable Kanban Desktop

A Trello-like Kanban board for your Airtable **Tasks** table, built with Electron + React + TypeScript. Works fully offline using a local SQLite cache and queues local edits for sync whenever Airtable is reachable.

---

## Architecture

```
airtable-kanban-desktop/
├── electron/
│   ├── main.ts        – Electron main process; IPC handlers
│   ├── preload.ts     – contextBridge that exposes window.electronAPI to the renderer
│   ├── db.ts          – better-sqlite3 wrapper (tasks, pending_ops, settings tables)
│   ├── airtable.ts    – Thin Airtable REST API client (native fetch)
│   └── sync.ts        – SyncEngine: push pending ops → pull remote; broadcasts events to renderer
├── src/
│   ├── App.tsx                     – Top-level layout: header, sync bar, page routing
│   ├── components/
│   │   ├── KanbanBoard.tsx         – Renders 5 status columns
│   │   ├── KanbanColumn.tsx        – Single column with HTML5 drag-and-drop drop target
│   │   ├── TaskCard.tsx            – Draggable card with priority/due/tag badges
│   │   ├── TaskModal.tsx           – Create / Edit task form
│   │   └── Settings.tsx            – Airtable token & base ID form
│   ├── types.ts                    – Shared TypeScript types (Task, SyncStatus, …)
│   └── index.css                   – All styles (no external UI library)
├── dist/main/      – Compiled Electron main process (tsc)
├── dist/renderer/  – Compiled React app (vite build)
└── kanban.db       – SQLite database stored in userData (not in project root)
```

### Data flow

1. **On launch** – renderer calls `getTasks()` → reads from SQLite cache immediately.
2. **Background sync** – 3 s after launch, then every 30 s:
   - Push all `pending_ops` to Airtable (create / update / delete).
   - Pull all records from Airtable; merge into local DB, skipping tasks that have pending ops.
3. **Local edits** – every create/update/delete writes to SQLite and inserts a `pending_op`. The UI updates instantly; sync is fire-and-forget.
4. **Offline** – if Airtable is unreachable, the sync engine marks state `offline` and queues ops accumulate. All local CRUD continues to work.

### Conflict strategy

Single-user, last-local-write-wins. If Airtable changes a task while you have a local pending op for it, the local op wins on the next push (the pull step skips tasks with pending ops).

---

## Requirements

- **Node.js 18+** (Electron 28 bundles Node 20)
- **Python 3 + Xcode Command Line Tools** (macOS) or **Visual Studio Build Tools** (Windows) — needed to compile `better-sqlite3` native module

---

## Setup

```bash
# 1. Install dependencies (also attempts to rebuild better-sqlite3 for Electron)
npm install

# If the postinstall rebuild failed, run manually:
npm run rebuild

# 2. (Optional) set env-var defaults
cp .env.example .env
# edit .env with your AIRTABLE_ACCESS_TOKEN and AIRTABLE_BASE_ID
```

---

## Running

### Development

```bash
npm run dev
```

This compiles the main process, starts the Vite dev server, waits for it to be ready, then launches Electron loading `http://localhost:5173`. DevTools open automatically.

> **Tip:** main-process changes require restarting the command; renderer changes hot-reload.

### Production build

```bash
npm run build     # compiles both main and renderer
npm start         # launches Electron from dist/
```

---

## Airtable Schema

Table name: **Tasks** (configurable in Settings)

| Field       | Type           | Notes                                              |
|-------------|----------------|----------------------------------------------------|
| Task Name   | Single line    | **Required** — mapped to `title`                   |
| Description | Long text      | Mapped to `description`                            |
| Status      | Single select  | Not Started / In Progress / Deferred / Waiting / Completed |
| Priority    | Single select  | High / Medium / Low                                |
| Due Date    | Date           |                                                    |
| Assigned To | Single line    |                                                    |
| Tags        | Multiple select| Stored locally as comma-separated string           |

---

## TypeScript check

```bash
npm run typecheck
```

---

## Caveats / Known limitations

- **Native module rebuild**: `better-sqlite3` must be compiled against Electron's Node headers. Run `npm run rebuild` if the app won't start.
- **No packaging**: no `electron-builder` config; use `npm start` to run from compiled source.
- **Single instance**: no IPC locking; launching two instances of the app against the same DB is unsupported.
- **Tags** must be a *Multiple select* field in Airtable; the app sends them as an array on sync.
- **Rate limits**: Airtable's free tier allows 5 req/s per base. Bulk operations on many pending ops may hit limits; retry logic (max 5 attempts with error recording) handles transient failures.
