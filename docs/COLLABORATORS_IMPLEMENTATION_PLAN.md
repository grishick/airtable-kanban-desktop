# Collaborators & Task Assignment — Implementation Plan

## Overview

Add the ability to assign tasks to Airtable base users, sync a collaborators list to a dedicated Airtable table, and invite new collaborators from within the app.

## Features

1. **Task Assignment** — Assign a task to a collaborator via an "Assignee" dropdown in the task modal. Show assignee on task cards.
2. **Collaborator Sync** — Persist discovered collaborators in a configurable Airtable table (default "Collaborators") so the list survives across devices.
3. **Collaborator Harvesting** — Discover collaborators from "Created By" and "Assignee" fields on task records (works on all Airtable plans, no Enterprise dependency).
4. **Invite Collaborators** — Invite new users to the Airtable base by email with a chosen permission level, via `POST /v0/meta/bases/{baseId}/collaborators`.

## Airtable API Details

### Assignee Field (on Tasks table)

- **Type**: `singleCollaborator`
- **Read response**: `{"id": "usrXXX", "email": "...", "name": "..."}`
- **Write format**: `{"id": "usrXXX"}` (only `id` accepted)

### Created By Field (on Tasks table)

- **Type**: `createdBy` (computed, read-only, available on all plans)
- **Response**: `{"id": "usrXXX", "email": "...", "name": "..."}`
- Auto-populated for every record. Used to discover collaborators.

### Collaborators Table (separate Airtable table)

| Field     | Type             | Purpose                     |
|-----------|------------------|-----------------------------|
| User ID   | singleLineText   | The `usrXXX` identifier     |
| Email     | singleLineText   | Collaborator email           |
| Name      | singleLineText   | Display name                 |

### Invite Endpoint

- `POST /v0/meta/bases/{baseId}/collaborators`
- Body: `{"collaborators": [{"user": {"email": "..."}, "permissionLevel": "editor"}]}`
- Permission levels: `owner`, `creator`, `editor`, `commenter`, `read`

## Layer-by-Layer Changes

### 1. `electron/db.ts`

- Add `collaborators` table in `migrate()`:
  ```sql
  CREATE TABLE IF NOT EXISTS collaborators (
    user_id     TEXT PRIMARY KEY,
    email       TEXT,
    name        TEXT,
    airtable_id TEXT UNIQUE
  );
  ```
- Add `Collaborator` interface
- Add CRUD: `getCollaborators()`, `upsertCollaborator()`, `replaceCollaborators()`

### 2. `electron/airtable.ts`

- Add `AirtableCollaborator` interface: `{id, email?, name?}`
- Add `Assignee` and `Created By` to `AirtableFields`
- New methods on `AirtableClient`:
  - `ensureAssigneeField()` — like `ensurePositionField()`
  - `ensureCreatedByField()` — like `ensurePositionField()`
  - `fetchCollaboratorsTable(tableName)` — fetch records from the Collaborators table
  - `pushCollaborators(tableName, collaborators)` — create records in the Collaborators table
  - `createCollaboratorsTable(tableName)` — create the table if it doesn't exist
  - `inviteCollaborator(email, permissionLevel)` — POST to base collaborators endpoint

### 3. `electron/accounts.ts`

- Add `collaboratorsTableName` to `Account` interface (default: `"Collaborators"`)

### 4. `electron/sync.ts`

- Update `taskToFields()`: parse `assigned_to` JSON → `Assignee: {id}`
- Update `airtableToTaskFields()`: `Assignee` obj → `JSON.stringify` → `assigned_to`
- Add `ensureCreatedByField()` and `ensureAssigneeField()` calls in schema migration
- Harvest collaborators from `Created By` and `Assignee` fields during `pullFromAirtable()`
- New method `syncCollaborators()`: pull from Airtable table, merge with harvested, push new ones back
- Call `syncCollaborators()` at the end of each sync cycle

### 5. `electron/main.ts`

- New IPC handlers:
  - `collaborators:get` — return `db.getCollaborators()`
  - `collaborators:invite` — call `client.inviteCollaborator(email, level)`
- Pass `collaboratorsTableName` through account add/update flows

### 6. `electron/preload.ts`

- Expose `getCollaborators()`, `inviteCollaborator(email, level)`
- Add `collaboratorsTableName` to Account interface
- Add `onCollaboratorsUpdated` push event listener

### 7. `src/types.ts`

- Add `Collaborator` interface: `{user_id, email, name}`
- Add `collaboratorsTableName` to `Account`
- Add `getCollaborators`, `inviteCollaborator`, `onCollaboratorsUpdated` to `ElectronAPI`

### 8. `src/App.tsx`

- Add `collaborators` state, load on mount, subscribe to push updates
- Pass collaborators down to `KanbanBoard` → `KanbanColumn` → `TaskModal`
- Re-fetch collaborators after sync (alongside tag options)

### 9. `src/components/TaskModal.tsx`

- Add "Assignee" dropdown populated from collaborators list
- Parse/serialize `assigned_to` JSON on load/save

### 10. `src/components/TaskCard.tsx`

- Show assignee name as a small badge in the meta row (initials circle + name)

### 11. `src/components/Settings.tsx`

- Add "Collaborators Table Name" text input to account add/edit forms
- Add "Invite Collaborator" section: email input + permission level dropdown + invite button

### 12. `src/index.css`

- Styles for assignee badge on cards
- Styles for assignee dropdown in modal
- Styles for invite form in settings

## Data Flow

```
Renderer (React)
 └─ window.electronAPI.getCollaborators()
 └─ window.electronAPI.inviteCollaborator(email, level)
 └─ onCollaboratorsUpdated push event
 └─ Task.assigned_to (JSON string)
     │
     │ IPC
     ▼
Main Process
 └─ collaborators:get → db.getCollaborators()
 └─ collaborators:invite → airtable.inviteCollaborator()
 └─ tasks:create/update → assigned_to passed through
     │
     ▼
SyncEngine
 └─ push: JSON.parse(assigned_to) → Assignee: {id}
 └─ pull: Assignee obj → JSON.stringify → assigned_to
 └─ pull: harvest from Created By + Assignee fields
 └─ syncCollaborators(): pull/push Collaborators table
     │
     ▼
SQLite                           Airtable
 ├─ tasks.assigned_to (JSON)  ←→  Tasks.Assignee (singleCollaborator)
 ├─ collaborators table       ←→  Collaborators table (custom)
 └─ (read-only)               ←   Tasks."Created By" (createdBy)
```

## Compatibility

- Works on Free, Pro, Team, and Enterprise plans
- No dependency on the Enterprise-only `GET /v0/meta/bases/{baseId}/collaborators` endpoint
- Collaborator discovery via record fields works on all plans
- Invite endpoint (`POST .../collaborators`) works on all plans with sufficient permissions
