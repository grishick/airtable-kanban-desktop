# OAuth Authentication Support — Design Spec

**Date:** 2026-03-18
**Status:** Approved

---

## Overview

Add OAuth 2.0 + PKCE as an alternative authentication method alongside the existing Personal Access Token (PAT) flow. Authentication state is managed by a small AWS Lambda middleman so the `client_secret` never touches the user's machine.

---

## Architecture

### Components

```
Electron app
  └─ electron/oauth.ts       new: OAuth flow orchestration
  └─ electron/accounts.ts    updated: token refresh, account helpers
  └─ electron/sync.ts        updated: refresh-before-sync
  └─ electron/main.ts        updated: accounts:startOAuth IPC handler
  └─ electron/preload.ts     updated: expose startOAuth
  └─ src/types.ts            updated: Account, ElectronAPI
  └─ src/components/Settings.tsx  updated: PAT/OAuth tabs, Lambda URL field

AWS Lambda (airtable-kanban-oauth)
  └─ lambda/index.mjs        three-endpoint handler
  └─ lambda/package.json     @aws-sdk/client-dynamodb only
  └─ lambda/infra.sh         one-time resource creation
  └─ lambda/deploy.sh        zip + update-function-code

DynamoDB table (airtable-kanban-oauth)
  └─ PK: state (string, 64 hex chars)
  └─ ttl: epoch seconds, TTL-enabled (120s)
  └─ code_verifier: string (written at /start)
  └─ access_token, refresh_token, expires_at: string (written at /callback)
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
```

---

## Lambda

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/start` | Generate state + PKCE, store in DynamoDB, return authUrl |
| GET | `/callback` | Receive code from Airtable, exchange for tokens, store, return HTML |
| GET | `/token` | Return tokens to Electron (single-use, deletes record) |

### `/start`

1. Generate `state`: 32 random bytes → 64-char hex string
2. Generate `code_verifier`: 32 random bytes → base64url string
3. Generate `code_challenge`: SHA-256(`code_verifier`) → base64url string
4. Write `{ state, code_verifier, ttl }` to DynamoDB (ttl = now + 120s)
5. Build `authUrl`:
   ```
   https://airtable.com/oauth2/v1/authorize
     ?response_type=code
     &client_id=<AIRTABLE_CLIENT_ID>
     &redirect_uri=<LAMBDA_URL>/callback
     &state=<state>
     &code_challenge=<code_challenge>
     &code_challenge_method=S256
     &scope=data.records:read data.records:write schema.bases:read schema.bases:write
   ```
6. Return `{ authUrl, state }`

### `/callback`

1. Validate `state` is exactly 64 hex chars; return error HTML otherwise
2. Look up record by `state` in DynamoDB; return error HTML if not found
3. POST to `https://airtable.com/oauth2/v1/token`:
   ```
   grant_type=authorization_code
   code=<code>
   redirect_uri=<LAMBDA_URL>/callback
   client_id=<AIRTABLE_CLIENT_ID>
   client_secret=<AIRTABLE_CLIENT_SECRET>
   code_verifier=<code_verifier from DynamoDB>
   ```
4. Update DynamoDB record with `{ access_token, refresh_token, expires_at, ttl }` (ttl = now + 120s)
5. Return HTML: "Authentication successful — you can close this tab."

### `/token`

1. Validate `state` param is present and 64 hex chars
2. Look up record by `state`
3. If record has no `access_token` yet → return HTTP 404 (Electron retries)
4. If record has `access_token` → delete record, return `{ accessToken, refreshToken, expiresAt }`
5. If record not found → return HTTP 410 (state expired or already consumed)

### Security

- `state` validated as 64 hex chars on every endpoint before DynamoDB access
- Error responses in `/callback` return generic HTML, never raw error details
- `/token` is single-use: record deleted on first successful read
- DynamoDB TTL = 120s ensures self-cleanup if Electron never polls
- Function URL auth: `NONE` (public); CORS: `*`

### Infrastructure (`lambda/infra.sh`)

One-time setup via AWS CLI:
1. Create DynamoDB table with `state` PK and TTL on `ttl`
2. Create IAM role with `AWSLambdaBasicExecutionRole` + inline DynamoDB policy scoped to the one table
3. Create Lambda (Node 20, 128 MB, 30s timeout) with env vars:
   - `AIRTABLE_CLIENT_ID`
   - `AIRTABLE_CLIENT_SECRET`
   - `DYNAMODB_TABLE=airtable-kanban-oauth`
   - `LAMBDA_BASE_URL` (Function URL, set after creation)
4. Enable Function URL
5. Print the Function URL for the user to copy into App Settings

### Deployment (`lambda/deploy.sh`)

```bash
zip -j lambda.zip lambda/index.mjs
aws lambda update-function-code \
  --function-name airtable-kanban-oauth \
  --zip-file fileb://lambda.zip
```

---

## Electron Changes

### Data model (`src/types.ts`, `electron/accounts.ts`)

```typescript
export interface Account {
  id: string;
  name: string;
  authType: 'pat' | 'oauth';     // 'pat' if absent (backwards compat)
  token?: string;                 // PAT only
  oauthAccessToken?: string;      // OAuth only
  oauthRefreshToken?: string;     // OAuth only
  oauthTokenExpiresAt?: string;   // ISO string, OAuth only
  baseId: string;
  tableName: string;
}
```

Existing `accounts.json` files without `authType` are treated as `'pat'` — no migration needed.

Helper added to `electron/accounts.ts`:
```typescript
export function getActiveToken(account: Account): string {
  return account.authType === 'oauth'
    ? (account.oauthAccessToken ?? '')
    : (account.token ?? '');
}
```

### Token refresh (`electron/accounts.ts`)

```typescript
export async function refreshOAuthTokenIfNeeded(account: Account): Promise<Account>
```

- Only acts on `authType === 'oauth'`
- Skips if `oauthTokenExpiresAt` is more than 5 minutes away
- POSTs `grant_type=refresh_token` to `https://airtable.com/oauth2/v1/token`
- On success: updates `accounts.json`, returns updated account
- On failure (e.g. refresh token expired): clears `oauthAccessToken`, `oauthRefreshToken`, `oauthTokenExpiresAt` from account, saves, throws — `sync.ts` catches this and sets state to `'unconfigured'`

### `electron/oauth.ts` (new file)

```typescript
export async function startOAuthFlow(lambdaBaseUrl: string): Promise<OAuthTokens>
```

1. POST `${lambdaBaseUrl}/start` → `{ authUrl, state }`
2. `shell.openExternal(authUrl)`
3. Poll `GET ${lambdaBaseUrl}/token?state=<state>` every 1500ms
   - 404 → keep polling
   - 200 → return tokens
   - 410 → throw "Session expired"
   - After 90s → throw "Timed out waiting for authentication"

### `electron/sync.ts`

Before each `sync()` call:
```typescript
const account = getActiveAccount();
if (account?.authType === 'oauth') {
  const refreshed = await refreshOAuthTokenIfNeeded(account);
  this.client = new AirtableClient(getActiveToken(refreshed), ...);
}
```

`reinit()` uses `getActiveToken(account)` instead of `account.token`.

### IPC (`electron/main.ts`, `electron/preload.ts`)

New channel: `accounts:startOAuth`
Handler: reads `oauth_lambda_url` from settings, calls `startOAuthFlow(url)`, returns `OAuthTokens`.
Renderer calls `window.electronAPI.startOAuth()`.

### Settings UI (`src/components/Settings.tsx`)

**Add Account form** — auth type toggle at the top:

- **PAT tab**: unchanged
- **OAuth tab**: "Sign in with Airtable" button
  - On click: calls `startOAuth()`, button shows "Waiting for browser… (cancel)"
  - On success: button replaced by baseId + tableName fields + "Add Account" button
  - On error/cancel: resets to button

**Edit Account form** — if `authType === 'oauth'`:
- No token field; shows "Re-authenticate" button (re-runs OAuth flow, replaces tokens)
- baseId and tableName remain editable

**App Settings section** — new "OAuth Lambda URL" field, stored as `oauth_lambda_url` in the settings table. Always visible (needed before any OAuth account is added).

---

## Error handling

| Scenario | Behaviour |
|----------|-----------|
| Lambda unreachable when starting OAuth | Error shown in Settings form |
| User closes browser without approving | 90s timeout → error shown in form |
| Access token refresh fails | Sync state → `unconfigured`; banner prompts re-auth |
| Refresh token expired | Same as above |
| DynamoDB record TTL expires before Electron polls | `/token` returns 410 → timeout error in form |

---

## Out of scope

- Fetching and displaying list of bases after OAuth (user still enters `baseId` manually)
- Per-account Lambda URL (one global URL in App Settings)
- Token encryption at rest in `accounts.json`
