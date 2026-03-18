# OAuth Authentication Support — Design Spec

**Date:** 2026-03-18
**Status:** Approved

---

## Overview

Add OAuth 2.0 + PKCE as an alternative authentication method alongside the existing Personal Access Token (PAT) flow. A small AWS Lambda middleman holds the `client_secret` so it never touches the user's machine — this applies to both the initial authorization code exchange **and** all subsequent token refreshes.

---

## Architecture

### Components

```
Electron app
  └─ electron/oauth.ts       new: OAuth flow orchestration
  └─ electron/accounts.ts    updated: getActiveToken helper, refreshOAuthTokenIfNeeded
  └─ electron/sync.ts        updated: refresh-before-sync, use getActiveToken in reinit()
  └─ electron/main.ts        updated: accounts:startOAuth, accounts:cancelOAuth IPC handlers;
  |                                   update accounts:add, accounts:update, settings:get, settings:save
  └─ electron/preload.ts     updated: expose startOAuth, cancelOAuth
  └─ src/types.ts            updated: Account interface, ElectronAPI signatures
  └─ src/components/Settings.tsx  updated: PAT/OAuth tabs, Lambda URL field, cancel button

AWS Lambda (airtable-kanban-oauth)
  └─ lambda/index.mjs        four-endpoint handler
  └─ lambda/package.json     @aws-sdk/client-dynamodb only
  └─ lambda/infra.sh         one-time resource creation
  └─ lambda/deploy.sh        zip + update-function-code

DynamoDB table (airtable-kanban-oauth)
  └─ PK: state (string, 64 hex chars)
  └─ ttl: epoch seconds, TTL-enabled (90s)
  └─ code_verifier: string (written at /start)
  └─ access_token, refresh_token, expires_at: ISO 8601 string (written at /callback)
  └─ error: string (optional sentinel, written by /callback on denial)
```

### OAuth flow sequence

```
Electron                    Lambda                     Airtable
   |                           |                           |
   |-- POST /start ----------->|                           |
   |<- { authUrl, state } -----|                           |
   |                           |                           |
   |-- shell.openExternal(authUrl) --------------------->  |
   |                           |<-- GET /callback?code=&state= (browser redirect)
   |                           |-- exchange code+verifier -->|
   |                           |<-- { access_token, ... } --|
   |                           |-- write tokens to DynamoDB  |
   |                           |-- return HTML "close tab"   |
   |                           |                           |
   |-- poll GET /token?state= ->|                           |
   |<- { accessToken, ... } ---|                           |
   |   (record deleted)        |                           |
   |                           |                           |
   |   ... (later, before sync) ...                        |
   |-- POST /refresh ---------->|                           |
   |                           |-- grant_type=refresh_token->|
   |                           |<-- { access_token, ... } --|
   |<- { accessToken, ... } ---|                           |
```

---

## Lambda

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/start` | Generate state + PKCE, store in DynamoDB, return authUrl |
| GET | `/callback` | Receive code from Airtable, exchange for tokens, store, return HTML |
| GET | `/token` | Return tokens to Electron (single-use, deletes record) |
| POST | `/refresh` | Exchange refresh token for new access token (client_secret stays server-side) |

### `/start`

1. Generate `state`: 32 random bytes → 64-char hex string
2. Generate `code_verifier`: 32 random bytes → base64url string
3. Generate `code_challenge`: SHA-256(`code_verifier`) → base64url string
4. Write `{ state, code_verifier, ttl }` to DynamoDB (ttl = `Math.floor(Date.now()/1000) + 90`)
5. Build `authUrl`:
   ```
   https://airtable.com/oauth2/v1/authorize
     ?response_type=code
     &client_id=<AIRTABLE_CLIENT_ID>
     &redirect_uri=<LAMBDA_BASE_URL>/callback
     &state=<state>
     &code_challenge=<code_challenge>
     &code_challenge_method=S256
     &scope=data.records:read data.records:write schema.bases:read schema.bases:write
   ```
   Note: `schema.bases:write` is required to support the "Create Table" feature. Users connecting to an existing table also receive this scope — this is accepted product behaviour.
6. Return `{ authUrl, state }`

### `/callback`

Steps in strict order (state validation is always the first DynamoDB gate):

1. **Validate `state`**: must be exactly 64 hex chars (`/^[0-9a-f]{64}$/`). If invalid, return error HTML immediately — before any DynamoDB access, regardless of whether `error` param is present.
2. **If `error` query param is present** (user denied authorization): write `{ state, error: req.query.error, ttl }` sentinel to DynamoDB (ttl = now + 90s), return "Authorization denied — you can close this tab." HTML. Stop.
3. Look up record by `state` in DynamoDB; return generic error HTML if not found.
4. POST to `https://airtable.com/oauth2/v1/token`:
   ```
   grant_type=authorization_code
   code=<code>
   redirect_uri=<LAMBDA_BASE_URL>/callback
   client_id=<AIRTABLE_CLIENT_ID>
   client_secret=<AIRTABLE_CLIENT_SECRET>
   code_verifier=<code_verifier from DynamoDB>
   ```
5. Compute `expires_at` = `new Date(Date.now() + expires_in * 1000).toISOString()`
6. Update DynamoDB record with `{ access_token, refresh_token, expires_at, ttl }` (ttl = now + 90s)
7. Return HTML: "Authentication successful — you can close this tab."
8. Never expose raw Airtable error details in response HTML; log internally only.

### `/token`

1. Validate `state` param is present and exactly 64 hex chars
2. Look up record by `state`
3. If record not found → return HTTP 410 (state expired or already consumed)
4. If record has `error` field → delete record, return HTTP 403 `{ error: "access_denied" }`
5. If record has no `access_token` yet → return HTTP 404 (Electron retries)
6. If record has `access_token` → delete record, return `{ accessToken, refreshToken, expiresAt }` (HTTP 200)

### `/refresh`

Request body: `{ refreshToken: string }`

1. Validate `refreshToken` is present and non-empty
2. POST to `https://airtable.com/oauth2/v1/token`:
   ```
   grant_type=refresh_token
   refresh_token=<refreshToken>
   client_id=<AIRTABLE_CLIENT_ID>
   client_secret=<AIRTABLE_CLIENT_SECRET>
   ```
   Note: `redirect_uri` is intentionally omitted — it is not required for the refresh grant (RFC 6749 §6) and Airtable does not list it as a refresh parameter.
3. Compute `expires_at` = `new Date(Date.now() + expires_in * 1000).toISOString()`
4. Return `{ accessToken, refreshToken, expiresAt }` (HTTP 200)
5. On Airtable error → return HTTP 401 with `{ error: <airtable_error_code> }`

### Security

- `state` validated as exactly 64 hex chars before any DynamoDB access, on every endpoint
- Error responses in `/callback` return generic HTML, never raw error details
- `/token` is single-use: record deleted on first successful read (200 or 403)
- DynamoDB TTL = 90s aligns with the Electron polling timeout — no orphaned tokens after user gives up
- Function URL auth: `NONE` (public); CORS: `*`
- **Rate limiting:** No WAF rule is added. The 90s TTL caps cost-amplification risk per write, and the 64-byte state keyspace makes brute-force impractical. Accepted risk for personal-use tool.

### Infrastructure (`lambda/infra.sh`)

One-time setup via AWS CLI:
1. Create DynamoDB table with `state` PK and TTL on `ttl`
2. Create IAM role with `AWSLambdaBasicExecutionRole` + inline DynamoDB policy scoped to the one table (GetItem, PutItem, UpdateItem, DeleteItem)
3. Create Lambda (Node 20, 128 MB, 30s timeout) with env vars:
   - `AIRTABLE_CLIENT_ID`
   - `AIRTABLE_CLIENT_SECRET`
   - `DYNAMODB_TABLE=airtable-kanban-oauth`
   - `LAMBDA_BASE_URL` (set as placeholder; updated after Function URL is created)
4. Enable Function URL
5. Update `LAMBDA_BASE_URL` env var with the created Function URL
6. Print the Function URL for the user to copy into App Settings

### Deployment (`lambda/deploy.sh`)

```bash
zip -j lambda.zip lambda/index.mjs
aws lambda update-function-code \
  --function-name airtable-kanban-oauth \
  --zip-file fileb://lambda.zip
```

---

## Electron Changes

### Data model

**Both** `src/types.ts` and `electron/accounts.ts` define `Account` independently. Both must be updated to the same shape:

```typescript
export interface Account {
  id: string;
  name: string;
  authType: 'pat' | 'oauth';     // treated as 'pat' if absent (backwards compat)
  token?: string;                 // PAT only
  oauthAccessToken?: string;      // OAuth only
  oauthRefreshToken?: string;     // OAuth only
  oauthTokenExpiresAt?: string;   // ISO 8601 string, OAuth only
  baseId: string;
  tableName: string;
}
```

Existing `accounts.json` files without `authType` are treated as `'pat'` — no migration needed.

**`ElectronAPI` IPC signatures** (`src/types.ts`) — `token` becomes optional; OAuth fields and new methods added:

```typescript
addAccount(data: {
  name?: string;
  authType: 'pat' | 'oauth';
  token?: string;               // required when authType === 'pat'
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: string;
  baseId: string;
  tableName: string;
}): Promise<AccountsState>;

updateAccount(id: string, updates: {
  name?: string;
  token?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: string;
  baseId?: string;
  tableName?: string;
}): Promise<AccountsState>;

startOAuth(): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
cancelOAuth(): Promise<void>;
```

### `electron/preload.ts` additions

Channel-to-API mapping (consistent with existing convention):

```typescript
startOAuth: (): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> =>
  ipcRenderer.invoke('accounts:startOAuth'),
cancelOAuth: (): Promise<void> =>
  ipcRenderer.invoke('accounts:cancelOAuth'),
```

### `electron/main.ts` — all changes

**`accounts:add` handler** — update signature and `fetchBaseName` call:
```typescript
ipcMain.handle('accounts:add', async (_event, data: {
  name?: string;
  authType?: 'pat' | 'oauth';
  token?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: string;
  baseId: string;
  tableName: string;
}) => {
  // For name auto-derivation, use whichever token is available:
  const tokenForName = data.authType === 'oauth'
    ? (data.oauthAccessToken ?? '')
    : (data.token ?? '');
  let name = data.name?.trim();
  if (!name && tokenForName) {
    const baseName = await fetchBaseName(tokenForName, data.baseId);
    name = baseName ?? 'New Account';
  }
  name = name || 'New Account';
  // If tokenForName is empty (e.g. oauthAccessToken not yet available), name
  // auto-derivation is silently skipped and the account is named 'New Account'.
  // This is intentional — do not reintroduce an unconditional fetchBaseName call.
  // ... rest of handler unchanged
});
```

**`accounts:update` handler** — reinit condition must include OAuth token updates:
```typescript
if (id === activeId && (updates.token || updates.oauthAccessToken || updates.baseId || updates.tableName)) {
  syncEngine?.reinit();
  if (syncEngine) void syncEngine.sync();
}
```

**`settings:get` handler** — add `oauth_lambda_url` to returned object:
```typescript
ipcMain.handle('settings:get', () => {
  const stored = db.getSettings();
  return {
    link_open_target: stored['link_open_target'] ?? 'browser',
    page_size: stored['page_size'] ? parseInt(stored['page_size'], 10) : 10,
    oauth_lambda_url: stored['oauth_lambda_url'] ?? '',
  };
});
```

**`settings:save` handler** — persist `oauth_lambda_url`:
```typescript
if (settings.oauth_lambda_url !== undefined) {
  db.setSetting('oauth_lambda_url', String(settings.oauth_lambda_url));
}
```

**`accounts:startOAuth` and `accounts:cancelOAuth` handlers** — with in-progress guard:

`oauthAbortController` is declared at **module scope** in `main.ts`, consistent with `syncEngine`. It must not be inside `setupIPC` (would be re-declared on each call):

```typescript
let oauthAbortController: AbortController | null = null;

ipcMain.handle('accounts:startOAuth', async () => {
  if (oauthAbortController) {
    throw new Error('An OAuth flow is already in progress');
  }
  const lambdaUrl = db.getSettings()['oauth_lambda_url'] ?? '';
  if (!lambdaUrl) throw new Error('OAuth Lambda URL is not configured in App Settings');

  oauthAbortController = new AbortController();
  try {
    return await startOAuthFlow(lambdaUrl, oauthAbortController.signal);
  } finally {
    oauthAbortController = null;
  }
});

ipcMain.handle('accounts:cancelOAuth', () => {
  oauthAbortController?.abort();
  oauthAbortController = null;
});
```

### `electron/accounts.ts` helpers

```typescript
// Returns the bearer token for any account type
export function getActiveToken(account: Account): string {
  return account.authType === 'oauth'
    ? (account.oauthAccessToken ?? '')
    : (account.token ?? '');
}

// Calls Lambda /refresh if token expires within 5 minutes.
// Updates accounts.json and returns the refreshed account.
// If oauthTokenExpiresAt is missing or unparseable, forces a refresh.
// On failure: clears OAuth tokens, saves, throws.
export async function refreshOAuthTokenIfNeeded(
  account: Account,
  lambdaBaseUrl: string,
): Promise<Account>
```

**Refresh check logic:**
```typescript
const expiry = account.oauthTokenExpiresAt
  ? new Date(account.oauthTokenExpiresAt).getTime()
  : NaN;
const needsRefresh = isNaN(expiry) || (expiry - Date.now() < 5 * 60 * 1000);
if (!needsRefresh) return account;
// ... proceed with refresh
```

If `oauthTokenExpiresAt` is missing or unparseable (`NaN`), a refresh is forced. This covers the case of an account written before the field was set.

### `electron/sync.ts`

**`reinit()`** — replace `account?.token ?? ''` with `getActiveToken(account)`:

```typescript
reinit(): void {
  const account = getActiveAccount();
  const token = account ? getActiveToken(account) : '';
  const baseId = account?.baseId ?? '';
  const tableName = account?.tableName ?? 'Tasks';

  if (token && baseId) {
    this.client = new AirtableClient(token, baseId, tableName);
    if (this.state === 'unconfigured') this.state = 'idle';
  } else {
    this.client = null;
    this.state = 'unconfigured';
  }
  this.broadcastStatus();
}
```

The `if (token && baseId)` guard remains correct: `getActiveToken` returns `''` when tokens are missing.

**`sync()`** — refresh OAuth token before syncing, then call `reinit()` to pick up the new token:

```typescript
async sync(): Promise<void> {
  const account = getActiveAccount();
  if (account?.authType === 'oauth') {
    try {
      const lambdaUrl = db.getSettings()['oauth_lambda_url'] ?? '';
      await refreshOAuthTokenIfNeeded(account, lambdaUrl);
      this.reinit(); // picks up refreshed token from accounts.json
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = `Re-authentication required: ${msg}`;
      this.state = 'unconfigured';
      this.broadcastStatus();
      return;
    }
  }
  // ... rest of existing sync() logic unchanged
}
```

Calling `reinit()` after refresh keeps token-reading logic in one place and ensures `this.client` is always built the same way. This works because `refreshOAuthTokenIfNeeded` always writes the updated tokens back to `accounts.json` before returning — `reinit()` calls `getActiveAccount()` which re-reads `accounts.json` from disk, so it picks up the refreshed token. The write-before-return contract in `refreshOAuthTokenIfNeeded` is load-bearing.

### `electron/oauth.ts` (new file)

```typescript
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO 8601
}

export async function startOAuthFlow(
  lambdaBaseUrl: string,
  signal: AbortSignal,
): Promise<OAuthTokens>
```

1. POST `${lambdaBaseUrl}/start` → `{ authUrl, state }`
2. `shell.openExternal(authUrl)`
3. Poll `GET ${lambdaBaseUrl}/token?state=<state>` every 1500ms, checking `signal.aborted` before each iteration:
   - 404 → keep polling
   - 200 → return `{ accessToken, refreshToken, expiresAt }`
   - 403 `{ error: "access_denied" }` → throw `"Authorization was denied in the browser"`
   - 410 → throw `"Session expired — please try again"`
   - `signal.aborted` → throw `"Cancelled"`
   - After 85s (leaving 5s buffer before DynamoDB TTL at 90s) → throw `"Timed out waiting for Airtable authorization"`

The polling timeout is set to 85s (less than the 90s DynamoDB TTL) to ensure the record is still present if the user completes the flow at the last moment. After 85s, Electron gives up; DynamoDB TTL cleans up within the next 5s.

### Settings UI (`src/components/Settings.tsx`)

**`Settings` type** (`src/types.ts`) — add `oauth_lambda_url`:
```typescript
export interface Settings {
  link_open_target?: 'browser' | 'app';
  page_size?: number;
  oauth_lambda_url?: string;
}
```

**Add Account form** — auth type toggle at the top: **Personal Access Token** | **Sign in with Airtable (OAuth)**

- **PAT tab**: unchanged
- **OAuth tab**:
  - Initial state: "Sign in with Airtable" button
  - After click: button replaced with "Waiting for browser…" + a separate "Cancel" button
    - "Cancel" calls `window.electronAPI.cancelOAuth()` and resets to initial state
  - On success: OAuth button area replaced by baseId + tableName fields + "Add Account" button. When the user submits, call `addAccount` mapping the `startOAuth` result:
    ```typescript
    await window.electronAPI.addAccount({
      authType: 'oauth',
      name: formName.trim() || undefined,
      oauthAccessToken: tokens.accessToken,
      oauthRefreshToken: tokens.refreshToken,
      oauthTokenExpiresAt: tokens.expiresAt,  // rename: expiresAt → oauthTokenExpiresAt
      baseId: formBaseId.trim(),
      tableName: formTableName.trim() || 'Tasks',
    });
    ```
  - On error: display user-friendly message based on error string, reset to initial state:
    - `"Authorization was denied in the browser"` → "Authorization was denied. Please try again."
    - `"Session expired — please try again"` → "Session expired. Please try again."
    - `"Timed out waiting for Airtable authorization"` → "Timed out. Please try again."
    - `"Cancelled"` → silent reset (no error shown)
    - `"An OAuth flow is already in progress"` → "Sign-in already in progress."
    - `"OAuth Lambda URL is not configured in App Settings"` → "Set the OAuth Lambda URL in App Settings first."
    - Any other error → show the raw error string
  - All `startOAuth()` calls must be wrapped in try/catch

**Edit Account form** — if `authType === 'oauth'`:
- No token field
- Shows "Re-authenticate" button (calls `startOAuth`, then calls `updateAccount` with new OAuth tokens)
- baseId and tableName remain editable

**App Settings section** — new "OAuth Lambda URL" field (always visible), stored as `oauth_lambda_url`. Both `getSettings()` and `saveSettings()` now include this field.

---

## Error handling

| Scenario | Behaviour |
|----------|-----------|
| Lambda URL not set when starting OAuth | IPC throws; Settings shows "Set the OAuth Lambda URL in App Settings first." |
| Lambda unreachable during `/start` | IPC throws; Settings shows raw error |
| User denies authorization in browser | Lambda writes error sentinel; `/token` returns 403; Electron throws "Authorization was denied in the browser" |
| User closes browser without acting | 85s polling timeout → "Timed out waiting for Airtable authorization" |
| User clicks Cancel | `accounts:cancelOAuth` aborts the signal; "Cancelled" → silent UI reset |
| Second OAuth flow started while one in progress | IPC throws "An OAuth flow is already in progress" |
| DynamoDB TTL (90s) expires before Electron (85s timeout) | Cannot happen: Electron gives up at 85s, record lives to 90s |
| Access token refresh fails (network/Lambda error) | `sync()` catches, sets state to `'unconfigured'`, broadcasts |
| Refresh token expired (401 from Lambda `/refresh`) | `this.lastError` set to "Re-authentication required: …"; state → `'unconfigured'`; sync indicator shows error tooltip; user re-authenticates via Edit Account |
| `oauthTokenExpiresAt` missing or unparseable | Force refresh unconditionally |
| `accounts:update` called with new OAuth tokens | `reinit()` triggered (condition includes `updates.oauthAccessToken`) |

---

## Out of scope

- Fetching and displaying list of bases after OAuth (user still enters `baseId` manually)
- Per-account Lambda URL (one global URL in App Settings)
- Token encryption at rest in `accounts.json`
- AWS WAF rate limiting (accepted risk for personal use)
