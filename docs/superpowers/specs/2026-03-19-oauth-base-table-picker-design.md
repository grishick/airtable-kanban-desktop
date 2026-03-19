# Design: OAuth Base & Table Picker

**Date:** 2026-03-19
**Status:** Approved

## Problem

After OAuth sign-in the user must manually type a Base ID (e.g. `appXXXXXXXXXXXXXX`) and a table name. The access token already grants visibility into their Airtable account, so we can fetch the available bases and tables and let the user pick from a list.

## Goal

Replace the free-text Base ID and Table Name inputs in the OAuth sign-in form with:
1. A **base dropdown** populated from the Airtable API.
2. A **table selector** that lets the user pick an existing table OR type a new table name.

The values passed downstream (`baseId`, `tableName`) are unchanged — only the input method changes.

---

## Data Fetching

Two new async functions in `electron/airtable.ts`:

```
fetchBases(token: string): Promise<{id: string, name: string}[]>
  GET https://api.airtable.com/v0/meta/bases
  Headers: Authorization: Bearer {token}
  Returns bases[].{id, name} (use raw API order).
  Must use signal: AbortSignal.timeout(5000).
  Throws on non-2xx.

fetchTables(token: string, baseId: string): Promise<{name: string}[]>
  GET https://api.airtable.com/v0/meta/bases/{baseId}/tables
  Headers: Authorization: Bearer {token}
  Returns tables[].{name} only — id is not needed and should not be returned.
  Must use signal: AbortSignal.timeout(5000).
  Throws on non-2xx.
```

Two new IPC handlers in `electron/main.ts`:

| Channel | Direction | Payload | Returns |
|---|---|---|---|
| `airtable:listBases` | invoke | `{ token: string }` | `{ id: string, name: string }[]` |
| `airtable:listTables` | invoke | `{ token: string, baseId: string }` | `{ name: string }[]` |

Two new entries in `electron/preload.ts` contextBridge and `src/types.ts` ElectronAPI interface:

```ts
listBases(token: string): Promise<{id: string, name: string}[]>
listTables(token: string, baseId: string): Promise<{name: string}[]>
```

---

## UI — Settings.tsx

The OAuth success section currently shows a Base ID text input and Table Name text input. These are replaced as follows. No new components are introduced; the same `<select>` and `<input>` patterns already used in the file are reused.

### New state

```ts
bases: { id: string; name: string }[]   // [] until loaded
basesLoading: boolean                    // true while listBases in flight
basesError: string                       // non-empty if listBases failed
tables: { name: string }[]              // [] until base selected
tablesLoading: boolean                  // true while listTables in flight
tablesError: string                     // non-empty if listTables failed
tableMode: 'existing' | 'new'           // toggle between modes
```

`baseId` and `tableName` continue to be stored in the existing form state.

### Interaction flow

**1. OAuth succeeds**

In `handleStartOAuth`, immediately after `setOauthTokens(tokens)`, call `listBases` using the `tokens.accessToken` value from the resolved promise directly — NOT from the `oauthTokens` state variable, which is not yet committed to React state at this point.

Set `basesLoading = true` before the call. On success:
- Populate `bases`.
- Set `baseId` to `bases[0].id` (first result).
- Call `listTables` with `tokens.accessToken` and `bases[0].id`.

On failure: set `basesError` with the error message.

**2. Base dropdown**

Render a controlled `<select value={baseId} onChange={...}>` populated from `bases`. On change:
- Update `baseId`.
- Clear `tables`, set `tablesLoading = true`.
- Call `listTables(oauthTokens.accessToken, newBaseId)`.
  - On success: populate `tables`, set `tableMode = 'existing'`, set `tableName` to `tables[0].name`.
  - On failure: set `tablesError`, set `tableMode = 'new'`, set `tableName = 'Tasks'`.

While `basesLoading` is true, render a disabled `<select>` with a single `"Loading bases…"` option.

**3. Table selector**

First, a mode `<select>` with two options: `"Use existing table"` / `"Create new table"`. Bound to `tableMode`.

Then, depending on `tableMode`:
- `existing`: a controlled `<select value={tableName} onChange={...}>` populated from `tables`. Selecting an option sets `tableName` to `option.name` (the table name string, not an ID).
- `new`: a text `<input value={tableName} onChange={...}>` pre-filled with `"Tasks"`.

Switching `tableMode` to `'new'` resets `tableName` to `'Tasks'`. Switching back to `'existing'` resets `tableName` to `tables[0].name` (if tables are loaded).

While `tablesLoading` is true, render a disabled `<select>` with `"Loading tables…"`.

**4. Submit button**

The submit button must be disabled when `basesLoading || tablesLoading` is true, in addition to the existing `saving || oauthPending` conditions.

**5. Account Name and Add Account button** remain unchanged.

**6. Help text**

The "Where to find these values" help block (which explains how to locate a Base ID) must be hidden when `addAuthTab === 'oauth'` and the base picker is shown, since the user no longer needs to find these values manually.

### Error handling / fallback

**Bases fetch fails:** Hide the base `<select>` and show the original Base ID text `<input>` with a small inline note: `"Could not load bases — enter ID manually"`. The `basesError` state drives this branch. The outer conditional rendering block is unchanged; this is an in-block branch replacing the base `<select>` with the text input.

**Tables fetch fails:** Set `tableMode = 'new'`, set `tableName = 'Tasks'`. Show an inline note near the table mode selector: `"Could not load tables — enter name manually"`. The `tablesError` state drives this note.

---

## Scope — what does NOT change

- `accounts:add` IPC handler — receives `baseId` and `tableName` exactly as before.
- PAT auth path — unchanged; base/table pickers only appear in the OAuth success section.
- Re-authenticate flow — unchanged; it replaces tokens only, not base/table selection.
- `Account` data structure — unchanged.

---

## Files to change

| File | Change |
|---|---|
| `electron/airtable.ts` | Add `fetchBases`, `fetchTables` |
| `electron/main.ts` | Add `airtable:listBases`, `airtable:listTables` IPC handlers |
| `electron/preload.ts` | Expose `listBases`, `listTables` via contextBridge |
| `src/types.ts` | Add `listBases`, `listTables` to `ElectronAPI` interface |
| `src/components/Settings.tsx` | Replace Base ID / Table Name inputs with pickers in OAuth success section |
