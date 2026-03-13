# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (builds main process, starts Vite dev server + Electron)
npm run dev

# Production build
npm run build          # compiles main (tsc) + renderer (vite)
npm run build:main     # main process only
npm run build:renderer # renderer only

# Run from pre-built dist/
npm start

# Type checking (both tsconfigs)
npm run typecheck

# Rebuild native module (better-sqlite3) for current Electron version
npm run rebuild

# Package app
npm run pack   # builds into unpacked dir
npm run dist   # builds distributable (dmg on macOS)
```

There are no tests. TypeScript (`npm run typecheck`) is the primary correctness check.

## Architecture

This is an **Electron app** with two separate TypeScript compilation targets:

- **Main process** (`electron/`) — compiled by `tsconfig.main.json` → `dist/main/`
- **Renderer process** (`src/`) — compiled by Vite → `dist/renderer/`

### Data flow

```
Renderer (React)
  └─ window.electronAPI  (contextBridge, defined in electron/preload.ts)
       └─ ipcRenderer.invoke / ipcRenderer.on
            └─ ipcMain.handle / win.webContents.send  (electron/main.ts)
                 ├─ electron/db.ts      (better-sqlite3, synchronous)
                 └─ electron/sync.ts   (SyncEngine → electron/airtable.ts)
```

### IPC channels

| Direction | Channel | Purpose |
|-----------|---------|---------|
| invoke | `tasks:get/create/update/delete` | CRUD on local SQLite |
| invoke | `settings:get/save` | Read/write key-value settings table |
| invoke | `sync:trigger`, `sync:status` | Manual sync / poll status |
| invoke | `airtable:createTable` | Create the Airtable table via API |
| invoke | `shell:openExternal`, `shell:openLink` | Open URLs |
| invoke | `tags:getOptions` | Fetch tag options cached from Airtable |
| invoke | `error:show` | Show native error dialog |
| push | `sync:status` | Main → renderer on every sync state change |
| push | `tasks:updated` | Main → renderer after every sync cycle |

### SQLite schema (electron/db.ts)

Four tables: `tasks`, `pending_ops`, `settings` (key/value), `tag_options`.

- `tasks.position` is a `REAL` — gaps of 1000 allow drag-and-drop reordering without renumbering.
- `tasks.is_deleted` is a soft-delete flag (0/1). Hard delete only happens after a successful `delete` push to Airtable.

### Sync engine (electron/sync.ts)

`SyncEngine` runs **push then pull** each cycle:

1. **Push**: iterates `pending_ops` in insertion order, calling Airtable REST for each. Ops are coalesced in `main.ts` (if a `create` is pending, an `update` refreshes the create payload rather than adding a new op).
2. **Pull**: fetches all Airtable records. Skips tasks that have any pending op (local wins). Upserts the rest by `airtable_id`.
3. **Tag options**: fetches the `Tags` field schema from Airtable metadata API to keep the tag autocomplete current.

Failed ops increment `retry_count`; after 5 retries the op is dropped. Network errors abort remaining pushes for that cycle.

### Airtable field mapping (electron/sync.ts)

| SQLite column | Airtable field |
|--------------|----------------|
| `title` | `Task Name` |
| `status` | `Status` |
| `description` | `Description` |
| `priority` | `Priority` |
| `due_date` | `Due Date` |
| `tags` | `Tags` (stored as comma-separated string locally, array in Airtable) |

### Renderer state (src/App.tsx)

`App` owns all state (`tasks`, `syncStatus`, `tagOptions`, `pageSize`) and passes handlers down. There is no state management library. The renderer subscribes to `onTasksUpdated` and `onSyncStatus` push events from the main process and merges them into local state. All mutations go through `window.electronAPI` (never direct IPC).

### Styling

All CSS is in `src/index.css` — no UI library. Drag-and-drop uses HTML5 native events.
