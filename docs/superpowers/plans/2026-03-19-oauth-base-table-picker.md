# OAuth Base & Table Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After OAuth sign-in, show a dropdown of the user's Airtable bases and a table picker (existing or new) instead of requiring manual text entry.

**Architecture:** Two new fetch functions in the Airtable module call the Airtable metadata API. Two IPC handlers expose them to the renderer. Settings.tsx fetches and renders the pickers immediately after OAuth tokens arrive, falling back to plain text inputs on error.

**Tech Stack:** TypeScript, Electron IPC (ipcMain/ipcRenderer), React, native `fetch`, Airtable REST metadata API (`/v0/meta/bases`, `/v0/meta/bases/{id}/tables`)

---

## File Map

| File | Change |
|---|---|
| `electron/airtable.ts` | Add `fetchBases()` and `fetchTables()` standalone exported functions |
| `electron/main.ts` | Add `airtable:listBases` and `airtable:listTables` IPC handlers |
| `electron/preload.ts` | Expose `listBases` and `listTables` via contextBridge |
| `src/types.ts` | Add `listBases` and `listTables` to `ElectronAPI` interface |
| `src/components/Settings.tsx` | Replace Base ID / Table Name inputs with pickers in OAuth success section |

---

## Task 1: Add fetchBases and fetchTables to airtable.ts

**Files:**
- Modify: `electron/airtable.ts`

The existing `fetchBaseName` function (near the top of the file) shows the exact pattern to follow: Bearer auth header, `AbortSignal.timeout`, throw on non-ok. Add two new exported functions immediately after `fetchBaseName`.

- [ ] **Step 1: Add `fetchBases` after `fetchBaseName`**

Open `electron/airtable.ts`. After the closing brace of `fetchBaseName`, add:

```typescript
export async function fetchBases(token: string): Promise<{ id: string; name: string }[]> {
  const resp = await fetch('https://api.airtable.com/v0/meta/bases', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`listBases failed: ${resp.status}`);
  const data = await resp.json() as { bases: { id: string; name: string }[] };
  return data.bases;
}
```

- [ ] **Step 2: Add `fetchTables` immediately after `fetchBases`**

```typescript
export async function fetchTables(token: string, baseId: string): Promise<{ name: string }[]> {
  const resp = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`listTables failed: ${resp.status}`);
  const data = await resp.json() as { tables: { name: string }[] };
  return data.tables.map(t => ({ name: t.name }));
}
```

- [ ] **Step 3: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add electron/airtable.ts
git commit -m "feat: add fetchBases and fetchTables to airtable module"
```

---

## Task 2: Wire IPC handlers in main.ts

**Files:**
- Modify: `electron/main.ts`

The existing `airtable:createTable` handler (around line 249) shows the exact pattern: import the function at the top, add an `ipcMain.handle` block. Add the two new handlers right after the `airtable:createTable` handler.

- [ ] **Step 1: Import the new functions at the top of main.ts**

Find the existing import from `'./airtable'` (it currently imports only `fetchBaseName`). Replace it with:

```typescript
import { fetchBaseName, fetchBases, fetchTables } from './airtable';
```

- [ ] **Step 2: Add IPC handlers after `airtable:createTable`**

Locate the `ipcMain.handle('airtable:createTable', ...)` block. Immediately after its closing `});`, add:

```typescript
ipcMain.handle('airtable:listBases', async (_event, { token }: { token: string }) => {
  return fetchBases(token);
});

ipcMain.handle('airtable:listTables', async (_event, { token, baseId }: { token: string; baseId: string }) => {
  return fetchTables(token, baseId);
});
```

- [ ] **Step 3: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat: add airtable:listBases and airtable:listTables IPC handlers"
```

---

## Task 3: Expose via preload and types

**Files:**
- Modify: `electron/preload.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Add to preload.ts contextBridge**

Open `electron/preload.ts`. Find the `contextBridge.exposeInMainWorld('electronAPI', { ... })` block. Locate `startOAuth` and `cancelOAuth`. Add the two new methods nearby (e.g. after `cancelOAuth`):

```typescript
listBases: (token: string) =>
  ipcRenderer.invoke('airtable:listBases', { token }),
listTables: (token: string, baseId: string) =>
  ipcRenderer.invoke('airtable:listTables', { token, baseId }),
```

- [ ] **Step 2: Add to ElectronAPI interface in types.ts**

Open `src/types.ts`. Find the `ElectronAPI` interface. Add after the `cancelOAuth` line:

```typescript
listBases(token: string): Promise<{ id: string; name: string }[]>;
listTables(token: string, baseId: string): Promise<{ name: string }[]>;
```

- [ ] **Step 3: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add electron/preload.ts src/types.ts
git commit -m "feat: expose listBases and listTables via contextBridge"
```

---

## Task 4: Add base/table picker state and fetch logic to Settings.tsx

**Files:**
- Modify: `src/components/Settings.tsx`

This task adds the new state variables and updates `handleStartOAuth` to fetch bases/tables immediately after OAuth succeeds. The UI is unchanged in this task — that is Task 5.

- [ ] **Step 1: Add new state variables**

Open `src/components/Settings.tsx`. After the `oauthLambdaUrl` state line (line 31), add:

```typescript
const [bases, setBases] = useState<{ id: string; name: string }[]>([]);
const [basesLoading, setBasesLoading] = useState(false);
const [basesError, setBasesError] = useState('');
const [tables, setTables] = useState<{ name: string }[]>([]);
const [tablesLoading, setTablesLoading] = useState(false);
const [tablesError, setTablesError] = useState('');
const [tableMode, setTableMode] = useState<'existing' | 'new'>('new');
```

- [ ] **Step 2: Reset new state in `startAdd`**

Replace the entire `startAdd` function body with:

```typescript
const startAdd = () => {
  setFormName('');
  setFormToken('');
  setFormBaseId('');
  setFormTableName('Tasks');
  setEditMode('add');
  setStatusMsg(null);
  setAddAuthTab('pat');
  setOauthPending(false);
  setOauthTokens(null);
  setBases([]);
  setBasesLoading(false);
  setBasesError('');
  setTables([]);
  setTablesLoading(false);
  setTablesError('');
  setTableMode('new');
};
```

- [ ] **Step 3: Add `fetchTablesForBase` helper**

Insert this helper between `cancelEdit` and `handleStartOAuth` (it must appear before `handleStartOAuth` since `const` arrow functions are not hoisted):

```typescript
const fetchTablesForBase = async (token: string, baseId: string) => {
  setTables([]);
  setTablesLoading(true);
  setTablesError('');
  try {
    const result = await window.electronAPI.listTables(token, baseId);
    setTables(result);
    setTableMode('existing');
    setFormTableName(result[0]?.name ?? 'Tasks');
  } catch {
    setTablesError('Could not load tables — enter name manually');
    setTableMode('new');
    setFormTableName('Tasks');
  } finally {
    setTablesLoading(false);
  }
};
```

- [ ] **Step 4: Update `handleStartOAuth` to fetch bases after sign-in**

Replace the existing `handleStartOAuth` body — specifically, change the `try` block so that after `setOauthTokens(tokens)` it immediately fetches bases. Use `tokens.accessToken` directly (not from state):

```typescript
const handleStartOAuth = async () => {
  setOauthPending(true);
  setStatusMsg(null);
  try {
    const tokens = await window.electronAPI.startOAuth();
    setOauthTokens(tokens);
    // Fetch bases immediately using the token from the resolved promise
    setBasesLoading(true);
    setBasesError('');
    try {
      const result = await window.electronAPI.listBases(tokens.accessToken);
      setBases(result);
      if (result.length > 0) {
        setFormBaseId(result[0].id);
        await fetchTablesForBase(tokens.accessToken, result[0].id);
      }
    } catch {
      setBasesError('Could not load bases — enter ID manually');
    } finally {
      setBasesLoading(false);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const friendly: Record<string, string> = {
      'Authorization was denied in the browser': 'Authorization was denied. Please try again.',
      'Session expired — please try again': 'Session expired. Please try again.',
      'Timed out waiting for Airtable authorization': 'Timed out. Please try again.',
      'Cancelled': '',
      'An OAuth flow is already in progress': 'Sign-in already in progress.',
      'OAuth Lambda URL is not configured in App Settings': 'Set the OAuth Lambda URL in App Settings first.',
    };
    const display = friendly[msg] ?? msg;
    if (display) setStatusMsg({ text: display, isError: true });
  } finally {
    setOauthPending(false);
  }
};
```

- [ ] **Step 5: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/Settings.tsx
git commit -m "feat: add base/table picker state and fetch logic to Settings"
```

---

## Task 5: Render base and table pickers in Settings.tsx

**Files:**
- Modify: `src/components/Settings.tsx`

This task replaces the Base ID / Table Name inputs in the OAuth success section with the picker UI, and updates the submit button and help text.

- [ ] **Step 1a: Replace the OAuth success paragraph**

Note: the success paragraph and the Base ID/Table Name block are **not** contiguous in the file — the re-authenticate section sits between them. Replace each separately; do not touch the re-authenticate block.

Find (the success paragraph immediately after the OAuth sign-in area):

```tsx
{oauthTokens && editMode === 'add' && (
  <p style={{ fontSize: 13, color: 'green', margin: '4px 0' }}>
    ✓ Signed in — enter base details below
  </p>
)}
```

Replace with the full OAuth picker section:

```tsx
{/* OAuth success: base picker (or fallback text input) */}
{oauthTokens && editMode === 'add' && (
  <>
    <p style={{ fontSize: 13, color: 'green', margin: '4px 0' }}>✓ Signed in</p>
    <div className="form-group">
      <label>Base</label>
      {basesError ? (
        <>
          <input
            type="text"
            value={formBaseId}
            onChange={(e) => setFormBaseId(e.target.value)}
            placeholder="appXXXXXXXXXXXXXX"
            required
          />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{basesError}</span>
        </>
      ) : (
        <select
          value={formBaseId}
          onChange={(e) => {
            setFormBaseId(e.target.value);
            fetchTablesForBase(oauthTokens.accessToken, e.target.value);
          }}
          disabled={basesLoading}
          required
        >
          {basesLoading
            ? <option value="">Loading bases…</option>
            : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)
          }
        </select>
      )}
    </div>

    <div className="form-group">
      <label>Table</label>
      <select
        value={tableMode}
        onChange={(e) => {
          const mode = e.target.value as 'existing' | 'new';
          setTableMode(mode);
          if (mode === 'new') {
            setFormTableName('Tasks');
          } else {
            setFormTableName(tables[0]?.name ?? 'Tasks');
          }
        }}
        disabled={tablesLoading}
      >
        <option value="existing">Use existing table</option>
        <option value="new">Create new table</option>
      </select>

      {!tablesLoading && tableMode === 'existing' && tables.length > 0 && (
        <select
          value={formTableName}
          onChange={(e) => setFormTableName(e.target.value)}
          style={{ marginTop: 6 }}
        >
          {tables.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
      )}

      {!tablesLoading && tableMode === 'new' && (
        <input
          type="text"
          value={formTableName}
          onChange={(e) => setFormTableName(e.target.value)}
          placeholder="Tasks"
          style={{ marginTop: 6 }}
        />
      )}

      {tablesError && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
          {tablesError}
        </span>
      )}
    </div>
  </>
)}
```

- [ ] **Step 1b: Replace the Base ID / Table Name plain-input block**

Further down in the file (after the re-authenticate section), find the block with the JSX comment `{/* Base ID and Table Name — shown for PAT tab, or after OAuth sign-in, or when editing */}`:

```tsx
{/* Base ID and Table Name — shown for PAT tab, or after OAuth sign-in, or when editing */}
{(addAuthTab === 'pat' || oauthTokens || editMode !== 'add') && (
  <>
    <div className="form-group">
      <label>Base ID</label>
      <input
        type="text"
        value={formBaseId}
        onChange={(e) => setFormBaseId(e.target.value)}
        placeholder="appXXXXXXXXXXXXXX"
        required
      />
    </div>
    <div className="form-group">
      <label>Table Name</label>
      <input
        type="text"
        value={formTableName}
        onChange={(e) => setFormTableName(e.target.value)}
        placeholder="Tasks"
      />
    </div>
  </>
)}
```

Replace with (PAT tab and edit mode only — OAuth add mode is handled by the picker above):

```tsx
{/* PAT tab or editing: plain text inputs unchanged */}
{(addAuthTab === 'pat' || editMode !== 'add') && (
  <>
    <div className="form-group">
      <label>Base ID</label>
      <input
        type="text"
        value={formBaseId}
        onChange={(e) => setFormBaseId(e.target.value)}
        placeholder="appXXXXXXXXXXXXXX"
        required
      />
    </div>
    <div className="form-group">
      <label>Table Name</label>
      <input
        type="text"
        value={formTableName}
        onChange={(e) => setFormTableName(e.target.value)}
        placeholder="Tasks"
      />
    </div>
  </>
)}
```

```tsx
{/* OAuth success: base picker (or fallback text input) */}
{oauthTokens && editMode === 'add' && (
  <>
    <p style={{ fontSize: 13, color: 'green', margin: '4px 0' }}>✓ Signed in</p>
    <div className="form-group">
      <label>Base</label>
      {basesError ? (
        <>
          <input
            type="text"
            value={formBaseId}
            onChange={(e) => setFormBaseId(e.target.value)}
            placeholder="appXXXXXXXXXXXXXX"
            required
          />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{basesError}</span>
        </>
      ) : (
        <select
          value={formBaseId}
          onChange={(e) => {
            setFormBaseId(e.target.value);
            fetchTablesForBase(oauthTokens.accessToken, e.target.value);
          }}
          disabled={basesLoading}
          required
        >
          {basesLoading
            ? <option value="">Loading bases…</option>
            : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)
          }
        </select>
      )}
    </div>

    <div className="form-group">
      <label>Table</label>
      <select
        value={tableMode}
        onChange={(e) => {
          const mode = e.target.value as 'existing' | 'new';
          setTableMode(mode);
          if (mode === 'new') {
            setFormTableName('Tasks');
          } else {
            setFormTableName(tables[0]?.name ?? 'Tasks');
          }
        }}
        disabled={tablesLoading}
      >
        <option value="existing">Use existing table</option>
        <option value="new">Create new table</option>
      </select>

      {!tablesLoading && tableMode === 'existing' && tables.length > 0 && (
        <select
          value={formTableName}
          onChange={(e) => setFormTableName(e.target.value)}
          style={{ marginTop: 6 }}
        >
          {tables.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
      )}

      {!tablesLoading && tableMode === 'new' && (
        <input
          type="text"
          value={formTableName}
          onChange={(e) => setFormTableName(e.target.value)}
          placeholder="Tasks"
          style={{ marginTop: 6 }}
        />
      )}

      {tablesError && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
          {tablesError}
        </span>
      )}
    </div>
  </>
)}

{/* PAT tab or editing: plain text inputs unchanged */}
{(addAuthTab === 'pat' || editMode !== 'add') && (
  <>
    <div className="form-group">
      <label>Base ID</label>
      <input
        type="text"
        value={formBaseId}
        onChange={(e) => setFormBaseId(e.target.value)}
        placeholder="appXXXXXXXXXXXXXX"
        required
      />
    </div>
    <div className="form-group">
      <label>Table Name</label>
      <input
        type="text"
        value={formTableName}
        onChange={(e) => setFormTableName(e.target.value)}
        placeholder="Tasks"
      />
    </div>
  </>
)}
```

- [ ] **Step 2: Disable the submit button during loading**

Find:
```tsx
<button type="submit" className="btn btn-primary" disabled={saving || oauthPending}>
```

Replace with:
```tsx
<button type="submit" className="btn btn-primary" disabled={saving || oauthPending || basesLoading || tablesLoading}>
```

- [ ] **Step 3: Conditionally hide the "Where to find these values" help block**

Find the help block starting with `<div style={{ marginTop: 24, fontSize: 12, color: 'var(--text-muted)' }}>` near the bottom of the component. Wrap it to hide it when the OAuth base picker is shown (i.e. signed in and in add mode):

```tsx
{!(addAuthTab === 'oauth' && oauthTokens && editMode === 'add') && (
  <div style={{ marginTop: 24, fontSize: 12, color: 'var(--text-muted)' }}>
    <strong>Where to find these values:</strong>
    <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.8 }}>
      <li>
        <strong>Personal Access Token</strong>: airtable.com → Account → Developer hub → Create a token.
        Required scopes: <code>data.records:read</code>, <code>data.records:write</code>,{' '}
        <code>schema.bases:read</code>, <code>schema.bases:write</code> (needed to auto-create the table).
      </li>
      <li>
        <strong>Base ID</strong>: Open your base, look at the URL:{' '}
        <code>airtable.com/appXXXXXX/…</code>
      </li>
      <li>
        <strong>Table Name</strong>: The exact name of your table tab (default: Tasks)
      </li>
    </ul>
  </div>
)}
```

- [ ] **Step 4: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Manual smoke test**

```
npm run dev
```

1. Open Settings → Add Account → OAuth tab
2. Click "Sign in with Airtable" and complete OAuth
3. Verify: base dropdown appears and is populated with your Airtable bases
4. Select a different base → table dropdown updates
5. Switch table mode to "Create new table" → text input appears pre-filled with "Tasks"
6. Switch back to "Use existing table" → dropdown reappears
7. Click "Add Account" → account is saved with correct baseId and tableName
8. Repeat with PAT tab → plain text inputs still appear (unchanged)

- [ ] **Step 6: Commit**

```bash
git add src/components/Settings.tsx
git commit -m "feat: replace base/table text inputs with pickers in OAuth sign-in flow"
```
