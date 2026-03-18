# OAuth Authentication Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OAuth 2.0 + PKCE authentication as an alternative to PAT, backed by an AWS Lambda middleman that holds the `client_secret` server-side.

**Architecture:** A new `lambda/` directory contains a four-endpoint Node.js Lambda (Function URL, no API Gateway) backed by a single DynamoDB table. Electron gains `electron/oauth.ts` for flow orchestration, token refresh in `electron/accounts.ts`, and a PAT/OAuth tab toggle in the Settings UI.

**Tech Stack:** Node.js 20 (Lambda, ESM), AWS CLI, `@aws-sdk/client-dynamodb`, TypeScript (Electron + renderer), React (Settings UI).

**Verification:** This project has no test suite. Use `npm run typecheck` as the correctness check after each Electron task.

---

## File Map

| File | Status | Purpose |
|------|--------|---------|
| `lambda/index.mjs` | Create | Four-endpoint Lambda handler |
| `lambda/package.json` | Create | Lambda deps (`@aws-sdk/client-dynamodb` only) |
| `lambda/infra.sh` | Create | One-time AWS resource provisioning |
| `lambda/deploy.sh` | Create | Zip + update-function-code |
| `electron/oauth.ts` | Create | `startOAuthFlow(lambdaBaseUrl, signal)` |
| `electron/accounts.ts` | Modify | Add `getActiveToken`, `refreshOAuthTokenIfNeeded`; update `Account` interface |
| `electron/sync.ts` | Modify | Use `getActiveToken` in `reinit()`; add pre-sync refresh in `sync()` |
| `electron/main.ts` | Modify | Update `accounts:add`, `accounts:update`, `settings:get`, `settings:save`; add `accounts:startOAuth`, `accounts:cancelOAuth` |
| `electron/preload.ts` | Modify | Expose `startOAuth`, `cancelOAuth` |
| `src/types.ts` | Modify | Update `Account`, `Settings`, `ElectronAPI` |
| `src/components/Settings.tsx` | Modify | PAT/OAuth tab toggle; OAuth Lambda URL field |

---

## Task 1: Lambda handler (`lambda/index.mjs`)

**Files:**
- Create: `lambda/index.mjs`
- Create: `lambda/package.json`

- [ ] **Step 1: Create `lambda/package.json`**

```json
{
  "name": "airtable-kanban-oauth-lambda",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `lambda/index.mjs` — boilerplate + router**

```javascript
import { createHash, randomBytes } from 'crypto';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';

const dynamo = new DynamoDBClient({});
const TABLE = process.env.DYNAMODB_TABLE;
const CLIENT_ID = process.env.AIRTABLE_CLIENT_ID;
const CLIENT_SECRET = process.env.AIRTABLE_CLIENT_SECRET;
const LAMBDA_BASE_URL = process.env.LAMBDA_BASE_URL;
const STATE_RE = /^[0-9a-f]{64}$/;
const TTL_SECONDS = 90;

function ttlNow() {
  return Math.floor(Date.now() / 1000) + TTL_SECONDS;
}

function htmlResponse(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem"><p>${body}</p></body></html>`,
  };
}

function jsonResponse(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const path = event.requestContext?.http?.path ?? event.path ?? '/';
  const qs = event.queryStringParameters ?? {};
  const body = event.body ? JSON.parse(event.body) : {};

  if (method === 'POST' && path === '/start') return handleStart();
  if (method === 'GET'  && path === '/callback') return handleCallback(qs);
  if (method === 'GET'  && path === '/token') return handleToken(qs);
  if (method === 'POST' && path === '/refresh') return handleRefresh(body);
  return jsonResponse({ error: 'not_found' }, 404);
}
```

- [ ] **Step 3: Add `/start` handler to `lambda/index.mjs`**

```javascript
async function handleStart() {
  const state = randomBytes(32).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      state: { S: state },
      code_verifier: { S: codeVerifier },
      ttl: { N: String(ttlNow()) },
    },
  }));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: `${LAMBDA_BASE_URL}/callback`,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: 'data.records:read data.records:write schema.bases:read schema.bases:write',
  });

  return jsonResponse({ authUrl: `https://airtable.com/oauth2/v1/authorize?${params}`, state });
}
```

- [ ] **Step 4: Add `/callback` handler to `lambda/index.mjs`**

```javascript
async function handleCallback(qs) {
  // 1. Validate state format first — before any DynamoDB access
  if (!STATE_RE.test(qs.state ?? '')) {
    return htmlResponse('Invalid request — you can close this tab.', 400);
  }

  // 2. Handle user denial
  if (qs.error) {
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        state: { S: qs.state },
        error: { S: qs.error },
        ttl: { N: String(ttlNow()) },
      },
    }));
    return htmlResponse('Authorization denied — you can close this tab.');
  }

  // 3. Look up PKCE record
  const { Item } = await dynamo.send(new GetItemCommand({
    TableName: TABLE,
    Key: { state: { S: qs.state } },
  }));
  if (!Item) return htmlResponse('Session not found or expired — you can close this tab.', 404);

  const codeVerifier = Item.code_verifier.S;

  // 4. Exchange code for tokens
  let tokenData;
  try {
    const resp = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: qs.code,
        redirect_uri: `${LAMBDA_BASE_URL}/callback`,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: codeVerifier,
      }),
    });
    if (!resp.ok) {
      console.error('Airtable token exchange failed:', resp.status, await resp.text());
      return htmlResponse('Authentication failed — you can close this tab.');
    }
    tokenData = await resp.json();
  } catch (err) {
    console.error('Token exchange error:', err);
    return htmlResponse('Authentication failed — you can close this tab.');
  }

  // 5. Store tokens
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { state: { S: qs.state } },
    UpdateExpression: 'SET access_token = :at, refresh_token = :rt, expires_at = :ea, #ttl = :ttl',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':at': { S: tokenData.access_token },
      ':rt': { S: tokenData.refresh_token },
      ':ea': { S: expiresAt },
      ':ttl': { N: String(ttlNow()) },
    },
  }));

  return htmlResponse('Authentication successful — you can close this tab.');
}
```

- [ ] **Step 5: Add `/token` handler to `lambda/index.mjs`**

```javascript
async function handleToken(qs) {
  if (!STATE_RE.test(qs.state ?? '')) return jsonResponse({ error: 'invalid_state' }, 400);

  const { Item } = await dynamo.send(new GetItemCommand({
    TableName: TABLE,
    Key: { state: { S: qs.state } },
  }));

  if (!Item) return jsonResponse({ error: 'not_found' }, 410);

  if (Item.error) {
    await dynamo.send(new DeleteItemCommand({ TableName: TABLE, Key: { state: { S: qs.state } } }));
    return jsonResponse({ error: 'access_denied' }, 403);
  }

  if (!Item.access_token) return jsonResponse({ error: 'not_ready' }, 404);

  await dynamo.send(new DeleteItemCommand({ TableName: TABLE, Key: { state: { S: qs.state } } }));
  return jsonResponse({
    accessToken: Item.access_token.S,
    refreshToken: Item.refresh_token.S,
    expiresAt: Item.expires_at.S,
  });
}
```

- [ ] **Step 6: Add `/refresh` handler to `lambda/index.mjs`**

```javascript
async function handleRefresh(body) {
  if (!body.refreshToken) return jsonResponse({ error: 'missing_refresh_token' }, 400);

  const resp = await fetch('https://airtable.com/oauth2/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: body.refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error('Airtable refresh failed:', resp.status, text);
    let errorCode = 'refresh_failed';
    try { errorCode = JSON.parse(text).error ?? errorCode; } catch {}
    return jsonResponse({ error: errorCode }, 401);
  }

  const data = await resp.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return jsonResponse({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt });
}
```

- [ ] **Step 7: Commit**

```bash
git add lambda/index.mjs lambda/package.json
git commit -m "Add OAuth Lambda handler (four endpoints)"
```

---

## Task 2: Lambda infra + deploy scripts

**Files:**
- Create: `lambda/infra.sh`
- Create: `lambda/deploy.sh`

- [ ] **Step 1: Create `lambda/infra.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

FUNCTION_NAME="airtable-kanban-oauth"
TABLE_NAME="airtable-kanban-oauth"
ROLE_NAME="airtable-kanban-oauth-role"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "=== Creating DynamoDB table ==="
aws dynamodb create-table \
  --table-name "$TABLE_NAME" \
  --attribute-definitions AttributeName=state,AttributeType=S \
  --key-schema AttributeName=state,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "$REGION"

aws dynamodb update-time-to-live \
  --table-name "$TABLE_NAME" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  --region "$REGION"

echo "=== Creating IAM role ==="
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
ROLE_ARN=$(aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST" \
  --query 'Role.Arn' --output text)

aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

TABLE_ARN=$(aws dynamodb describe-table \
  --table-name "$TABLE_NAME" \
  --query 'Table.TableArn' --output text --region "$REGION")

INLINE_POLICY=$(cat <<EOF
{
  "Version":"2012-10-17",
  "Statement":[{
    "Effect":"Allow",
    "Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem"],
    "Resource":"$TABLE_ARN"
  }]
}
EOF
)
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "DynamoDBAccess" \
  --policy-document "$INLINE_POLICY"

echo "Waiting for IAM role to propagate..."
sleep 15

echo "=== Creating Lambda function ==="
# Build initial zip
cd "$(dirname "$0")"
npm install --prefix . --omit=dev
zip -r lambda.zip index.mjs node_modules

aws lambda create-function \
  --function-name "$FUNCTION_NAME" \
  --runtime nodejs20.x \
  --role "$ROLE_ARN" \
  --handler index.handler \
  --zip-file fileb://lambda.zip \
  --timeout 30 \
  --memory-size 128 \
  --environment "Variables={AIRTABLE_CLIENT_ID=PLACEHOLDER,AIRTABLE_CLIENT_SECRET=PLACEHOLDER,DYNAMODB_TABLE=$TABLE_NAME,LAMBDA_BASE_URL=PLACEHOLDER}" \
  --region "$REGION"

echo "=== Enabling Function URL ==="
FUNCTION_URL=$(aws lambda create-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --auth-type NONE \
  --cors '{"AllowOrigins":["*"],"AllowMethods":["GET","POST"],"AllowHeaders":["content-type"]}' \
  --query 'FunctionUrl' --output text \
  --region "$REGION")

# Allow public invocations
aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE \
  --region "$REGION"

# Update LAMBDA_BASE_URL env var (strip trailing slash)
BASE_URL="${FUNCTION_URL%/}"
aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --environment "Variables={AIRTABLE_CLIENT_ID=PLACEHOLDER,AIRTABLE_CLIENT_SECRET=PLACEHOLDER,DYNAMODB_TABLE=$TABLE_NAME,LAMBDA_BASE_URL=$BASE_URL}" \
  --region "$REGION"

rm -f lambda.zip

echo ""
echo "=== Done ==="
echo ""
echo "Function URL: $FUNCTION_URL"
echo ""
echo "Next steps:"
echo "  1. Register your OAuth integration at https://airtable.com/create/oauth"
echo "     Redirect URI: ${BASE_URL}/callback"
echo "  2. Set real credentials:"
echo "     aws lambda update-function-configuration \\"
echo "       --function-name $FUNCTION_NAME \\"
echo "       --environment 'Variables={AIRTABLE_CLIENT_ID=<id>,AIRTABLE_CLIENT_SECRET=<secret>,DYNAMODB_TABLE=$TABLE_NAME,LAMBDA_BASE_URL=$BASE_URL}'"
echo "  3. Copy the Function URL into App Settings → OAuth Lambda URL"
```

- [ ] **Step 2: Create `lambda/deploy.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

FUNCTION_NAME="airtable-kanban-oauth"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
DIR="$(dirname "$0")"

echo "Building zip..."
cd "$DIR"
npm install --prefix . --omit=dev
zip -r lambda.zip index.mjs node_modules

echo "Deploying to Lambda..."
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file fileb://lambda.zip \
  --region "$REGION"

rm -f lambda.zip
echo "Done."
```

- [ ] **Step 3: Make scripts executable and commit**

```bash
chmod +x lambda/infra.sh lambda/deploy.sh
git add lambda/infra.sh lambda/deploy.sh
git commit -m "Add Lambda infra and deploy scripts"
```

---

## Task 3: Update `Account` interface and `Settings` type

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Update `Account` interface in `src/types.ts`**

Replace the existing `Account` interface:
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

- [ ] **Step 2: Add `oauth_lambda_url` to `Settings` interface in `src/types.ts`**

Replace the existing `Settings` interface:
```typescript
export interface Settings {
  link_open_target?: 'browser' | 'app';
  page_size?: number;
  oauth_lambda_url?: string;
}
```

- [ ] **Step 3: Update `ElectronAPI` in `src/types.ts`**

Update the `addAccount` signature:
```typescript
addAccount(data: {
  name?: string;
  authType: 'pat' | 'oauth';
  token?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: string;
  baseId: string;
  tableName: string;
}): Promise<AccountsState>;
```

Update the `updateAccount` signature:
```typescript
updateAccount(id: string, updates: {
  name?: string;
  token?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: string;
  baseId?: string;
  tableName?: string;
}): Promise<AccountsState>;
```

Add new methods after `switchAccount`:
```typescript
startOAuth(): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
cancelOAuth(): Promise<void>;
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: errors in `electron/accounts.ts`, `electron/main.ts`, and `electron/preload.ts` about `token` being required or OAuth fields missing — these will be fixed in upcoming tasks. No new errors in `src/` (renderer typecheck uses `ElectronAPI` from `src/types.ts` which is already updated).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "Update Account, Settings, ElectronAPI types for OAuth"
```

---

## Task 4: Update `Account` interface and helpers in `electron/accounts.ts`

**Files:**
- Modify: `electron/accounts.ts`

- [ ] **Step 1: Update `Account` interface in `electron/accounts.ts`**

Replace the existing `Account` interface:
```typescript
export interface Account {
  id: string;
  name: string;
  authType: 'pat' | 'oauth';
  token?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: string;
  baseId: string;
  tableName: string;
}
```

- [ ] **Step 2: Add `getActiveToken` helper after the `Account` interface**

```typescript
export function getActiveToken(account: Account): string {
  return (account.authType ?? 'pat') === 'oauth'
    ? (account.oauthAccessToken || '')   // || treats '' as absent (cleared tokens)
    : (account.token ?? '');
}
```

- [ ] **Step 3: Add `refreshOAuthTokenIfNeeded` at the bottom of `electron/accounts.ts`**

```typescript
export async function refreshOAuthTokenIfNeeded(
  account: Account,
  lambdaBaseUrl: string,
): Promise<Account> {
  if ((account.authType ?? 'pat') !== 'oauth') return account;

  const expiry = account.oauthTokenExpiresAt
    ? new Date(account.oauthTokenExpiresAt).getTime()
    : NaN;
  const needsRefresh = isNaN(expiry) || expiry - Date.now() < 5 * 60 * 1000;
  if (!needsRefresh) return account;

  const resp = await fetch(`${lambdaBaseUrl}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: account.oauthRefreshToken }),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({})) as { error?: string };
    // Clear tokens so the account becomes unconfigured.
    // Use '' (empty string) not undefined — JSON.stringify silently drops undefined,
    // so undefined values would leave the stale tokens in accounts.json.
    // getActiveToken treats '' as absent (returns '').
    updateAccount(account.id, {
      oauthAccessToken: '',
      oauthRefreshToken: '',
      oauthTokenExpiresAt: '',
    });
    throw new Error(data.error ?? 'refresh_failed');
  }

  const tokens = await resp.json() as {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
  };

  // Write back to accounts.json before returning (load-bearing for reinit())
  const result = updateAccount(account.id, {
    oauthAccessToken: tokens.accessToken,
    oauthRefreshToken: tokens.refreshToken,
    oauthTokenExpiresAt: tokens.expiresAt,
  });
  if (!result) throw new Error('Account not found after refresh');
  return result.account;
}
```

Note: `updateAccount` in this file accepts `Partial<Omit<Account, 'id'>>`. The `undefined` values above clear the fields because `updateAccount` uses a spread merge — passing `undefined` for a key will overwrite the existing value with `undefined`.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no new errors. Existing errors in `electron/main.ts` about `token` being required are still acceptable at this stage.

- [ ] **Step 5: Commit**

```bash
git add electron/accounts.ts
git commit -m "Add getActiveToken + refreshOAuthTokenIfNeeded to accounts.ts"
```

---

## Task 5: Create `electron/oauth.ts`

**Files:**
- Create: `electron/oauth.ts`

- [ ] **Step 1: Create `electron/oauth.ts`**

```typescript
import { shell } from 'electron';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO 8601
}

/**
 * Runs the full OAuth authorization flow:
 * 1. Calls Lambda /start to get authUrl + state
 * 2. Opens authUrl in the system browser
 * 3. Polls Lambda /token until tokens arrive (or signal is aborted / timeout)
 *
 * The AbortSignal is used by the cancelOAuth IPC handler to interrupt the poll.
 * DynamoDB TTL is 90s; polling stops at 85s to leave a cleanup buffer.
 */
export async function startOAuthFlow(
  lambdaBaseUrl: string,
  signal: AbortSignal,
): Promise<OAuthTokens> {
  // Step 1: Start session on Lambda
  const startResp = await fetch(`${lambdaBaseUrl}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!startResp.ok) {
    throw new Error(`Lambda /start failed: ${startResp.status}`);
  }
  const { authUrl, state } = await startResp.json() as { authUrl: string; state: string };

  // Step 2: Open browser
  await shell.openExternal(authUrl);

  // Step 3: Poll /token
  const deadline = Date.now() + 85_000;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Cancelled');

    await sleep(1500);

    if (signal.aborted) throw new Error('Cancelled');

    let resp: Response;
    try {
      resp = await fetch(`${lambdaBaseUrl}/token?state=${state}`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Network hiccup — keep trying until deadline
      continue;
    }

    if (resp.status === 200) {
      return await resp.json() as OAuthTokens;
    }
    if (resp.status === 403) {
      throw new Error('Authorization was denied in the browser');
    }
    if (resp.status === 410) {
      throw new Error('Session expired — please try again');
    }
    // 404 = not ready yet, keep polling
  }

  throw new Error('Timed out waiting for Airtable authorization');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors in `electron/oauth.ts`.

- [ ] **Step 3: Commit**

```bash
git add electron/oauth.ts
git commit -m "Add electron/oauth.ts: startOAuthFlow with polling and AbortSignal"
```

---

## Task 6: Update `electron/sync.ts`

**Files:**
- Modify: `electron/sync.ts`

- [ ] **Step 1: Add import for `getActiveToken` and `refreshOAuthTokenIfNeeded` at the top of `electron/sync.ts`**

Change:
```typescript
import { getActiveAccount } from './accounts';
```
To:
```typescript
import { getActiveAccount, getActiveToken, refreshOAuthTokenIfNeeded } from './accounts';
```

- [ ] **Step 2: Update `reinit()` to use `getActiveToken`**

Replace the body of `reinit()`:
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

- [ ] **Step 3: Add pre-sync OAuth refresh at the top of `sync()`**

Insert the following block at the very start of `sync()`, before `if (!this.client)`:
```typescript
// Refresh OAuth token if needed before attempting sync
const activeAccount = getActiveAccount();
if (activeAccount?.authType === 'oauth') {
  try {
    const lambdaUrl = db.getSettings()['oauth_lambda_url'] ?? '';
    await refreshOAuthTokenIfNeeded(activeAccount, lambdaUrl);
    this.reinit(); // re-reads accounts.json which now has the fresh token
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    this.lastError = `Re-authentication required: ${msg}`;
    this.state = 'unconfigured';
    this.broadcastStatus();
    return;
  }
}
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors in `electron/sync.ts`.

- [ ] **Step 5: Commit**

```bash
git add electron/sync.ts
git commit -m "Update sync.ts: use getActiveToken in reinit, refresh OAuth token before sync"
```

---

## Task 7: Update `electron/main.ts`

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Add imports at the top of `electron/main.ts`**

Add `startOAuthFlow` to the imports:
```typescript
import { startOAuthFlow } from './oauth';
```

- [ ] **Step 2: Add `oauthAbortController` module-level variable**

After the existing `let syncEngine: SyncEngine | null = null;` line, add:
```typescript
let oauthAbortController: AbortController | null = null;
```

- [ ] **Step 3: Update the `accounts:add` IPC handler signature and token logic**

Replace the existing `ipcMain.handle('accounts:add', ...)` handler with:
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
  const isFirstAccount = getActiveAccount() === null;

  const tokenForName = data.authType === 'oauth'
    ? (data.oauthAccessToken ?? '')
    : (data.token ?? '');

  let name = data.name?.trim();
  if (!name && tokenForName) {
    const baseName = await fetchBaseName(tokenForName, data.baseId);
    name = baseName ?? 'New Account';
  }
  name = name || 'New Account';
  // If tokenForName is empty, auto-derivation is silently skipped — intentional.

  const { file } = addAccount({
    name,
    authType: data.authType ?? 'pat',
    token: data.token,
    oauthAccessToken: data.oauthAccessToken,
    oauthRefreshToken: data.oauthRefreshToken,
    oauthTokenExpiresAt: data.oauthTokenExpiresAt,
    baseId: data.baseId,
    tableName: data.tableName || 'Tasks',
  });

  if (isFirstAccount) {
    const newActive = getActiveAccount()!;
    db.switchDB(dbPathForAccount(newActive.id));
    syncEngine?.reinit();
    if (!win.isDestroyed()) win.webContents.send('tasks:updated', db.getAllTasks());
    if (syncEngine) void syncEngine.sync();
  }

  broadcastAccounts(win, file);
  return { accounts: file.accounts, activeId: file.activeId };
});
```

- [ ] **Step 4: Update the `accounts:update` reinit condition**

In the `accounts:update` handler, change the reinit guard from:
```typescript
if (id === activeId && (updates.token || updates.baseId || updates.tableName)) {
```
To:
```typescript
if (id === activeId && (updates.token || updates.oauthAccessToken || updates.baseId || updates.tableName)) {
```

Also update the handler's parameter type to match the new `updateAccount` signature (add OAuth fields):
```typescript
ipcMain.handle('accounts:update', (_event, id: string, updates: {
  name?: string;
  token?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: string;
  baseId?: string;
  tableName?: string;
}) => {
```

- [ ] **Step 5: Update `settings:get` to include `oauth_lambda_url`**

Replace the `settings:get` handler:
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

- [ ] **Step 6: Update `settings:save` to persist `oauth_lambda_url`**

In the `settings:save` handler, add after the `page_size` block:
```typescript
if (settings.oauth_lambda_url !== undefined) {
  db.setSetting('oauth_lambda_url', String(settings.oauth_lambda_url));
}
```

- [ ] **Step 7: Add `accounts:startOAuth` and `accounts:cancelOAuth` handlers inside `setupIPC`**

Add at the end of `setupIPC`, before the closing `}`:
```typescript
// ── OAuth ──────────────────────────────────────────────────────────────────
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

- [ ] **Step 8: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add electron/main.ts
git commit -m "Update main.ts: OAuth IPC handlers, settings, accounts:add/update"
```

---

## Task 8: Update `electron/preload.ts`

**Files:**
- Modify: `electron/preload.ts`

- [ ] **Step 1: Add `startOAuth` and `cancelOAuth` to the contextBridge in `electron/preload.ts`**

After the `onAccountsUpdated` listener, add:
```typescript
// OAuth
startOAuth: (): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> =>
  ipcRenderer.invoke('accounts:startOAuth'),
cancelOAuth: (): Promise<void> =>
  ipcRenderer.invoke('accounts:cancelOAuth'),
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add electron/preload.ts
git commit -m "Expose startOAuth and cancelOAuth via preload contextBridge"
```

---

## Task 9: Update `src/components/Settings.tsx`

**Files:**
- Modify: `src/components/Settings.tsx`

- [ ] **Step 1: Add OAuth state variables and helpers at the top of `SettingsPage`**

After the existing state declarations, add:
```typescript
type AuthTab = 'pat' | 'oauth';
const [addAuthTab, setAddAuthTab] = useState<AuthTab>('pat');
const [oauthPending, setOauthPending] = useState(false);
const [oauthTokens, setOauthTokens] = useState<{
  accessToken: string; refreshToken: string; expiresAt: string;
} | null>(null);
const [oauthLambdaUrl, setOauthLambdaUrl] = useState('');
```

Also update the `useEffect` that loads settings to populate `oauthLambdaUrl`:
```typescript
setOauthLambdaUrl((settings as Settings).oauth_lambda_url ?? '');
```

- [ ] **Step 2: Add `startEdit` reset for OAuth state**

In `startAdd()`, add:
```typescript
setAddAuthTab('pat');
setOauthPending(false);
setOauthTokens(null);
```

In `cancelEdit()`, add:
```typescript
setOauthPending(false);
setOauthTokens(null);
if (oauthPending) {
  window.electronAPI.cancelOAuth().catch(() => {});
}
```

- [ ] **Step 3: Add `handleStartOAuth` function**

```typescript
const handleStartOAuth = async () => {
  setOauthPending(true);
  setStatusMsg(null);
  try {
    const tokens = await window.electronAPI.startOAuth();
    setOauthTokens(tokens);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Map known error strings to friendly messages
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

- [ ] **Step 4: Update `handleAccountFormSubmit` to handle OAuth accounts**

In the `editMode === 'add'` branch, replace the `addAccount` call with:
```typescript
if (addAuthTab === 'oauth') {
  if (!oauthTokens) {
    setStatusMsg({ text: 'Complete sign-in with Airtable first.', isError: true });
    return;
  }
  const result = await window.electronAPI.addAccount({
    authType: 'oauth',
    name: formName.trim() || undefined,
    oauthAccessToken: oauthTokens.accessToken,
    oauthRefreshToken: oauthTokens.refreshToken,
    oauthTokenExpiresAt: oauthTokens.expiresAt,
    baseId: formBaseId.trim(),
    tableName: formTableName.trim() || 'Tasks',
  });
  applyAccountsState(result);
  setStatusMsg({ text: 'Account added.', isError: false });
} else {
  const result = await window.electronAPI.addAccount({
    authType: 'pat',
    name: formName.trim() || undefined,
    token: formToken.trim(),
    baseId: formBaseId.trim(),
    tableName: formTableName.trim() || 'Tasks',
  });
  applyAccountsState(result);
  setStatusMsg({ text: 'Account added.', isError: false });
}
```

- [ ] **Step 5: Add `handleReauthenticate` for editing OAuth accounts**

```typescript
const handleReauthenticate = async () => {
  setOauthPending(true);
  setStatusMsg(null);
  try {
    const tokens = await window.electronAPI.startOAuth();
    if (editMode !== 'none' && editMode !== 'add') {
      const result = await window.electronAPI.updateAccount(editMode, {
        oauthAccessToken: tokens.accessToken,
        oauthRefreshToken: tokens.refreshToken,
        oauthTokenExpiresAt: tokens.expiresAt,
      });
      applyAccountsState(result);
      setStatusMsg({ text: 'Re-authenticated successfully.', isError: false });
      setEditMode('none');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== 'Cancelled') setStatusMsg({ text: msg, isError: true });
  } finally {
    setOauthPending(false);
  }
};
```

- [ ] **Step 6: Update the Add Account form JSX**

Replace the Add Account form's content with auth tab toggle + conditional PAT/OAuth fields:

```tsx
{editMode !== 'none' && (
  <form className="settings-form" style={{ marginTop: 16 }} onSubmit={handleAccountFormSubmit}>
    <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
      {editMode === 'add' ? 'Add Account' : 'Edit Account'}
    </h3>

    {/* Auth type toggle — only shown when adding */}
    {editMode === 'add' && (
      <div className="auth-tab-toggle">
        <button
          type="button"
          className={`auth-tab-btn${addAuthTab === 'pat' ? ' active' : ''}`}
          onClick={() => { setAddAuthTab('pat'); setOauthTokens(null); }}
        >
          Personal Access Token
        </button>
        <button
          type="button"
          className={`auth-tab-btn${addAuthTab === 'oauth' ? ' active' : ''}`}
          onClick={() => { setAddAuthTab('oauth'); setOauthTokens(null); }}
        >
          Sign in with Airtable
        </button>
      </div>
    )}

    <div className="form-group">
      <label>Account Name</label>
      <input
        type="text"
        value={formName}
        onChange={(e) => setFormName(e.target.value)}
        placeholder="Auto-derived from base name if left empty"
      />
    </div>

    {/* PAT field — shown for PAT tab (add) or PAT accounts (edit) */}
    {(addAuthTab === 'pat' && editMode === 'add') ||
     (editMode !== 'add' && accounts.find(a => a.id === editMode)?.authType !== 'oauth') ? (
      <div className="form-group">
        <label>Personal Access Token</label>
        <input
          type="password"
          value={formToken}
          onChange={(e) => setFormToken(e.target.value)}
          placeholder="patXXXXXXXXXXXXXX"
          autoComplete="off"
          required={addAuthTab === 'pat' || editMode !== 'add'}
        />
      </div>
    ) : null}

    {/* OAuth sign-in area */}
    {addAuthTab === 'oauth' && editMode === 'add' && !oauthTokens && (
      <div className="form-group">
        {!oauthPending ? (
          <button type="button" className="btn btn-primary" onClick={handleStartOAuth}>
            Sign in with Airtable
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>Waiting for browser…</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { window.electronAPI.cancelOAuth().catch(() => {}); }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    )}

    {oauthTokens && editMode === 'add' && (
      <p style={{ fontSize: 13, color: 'green', margin: '4px 0' }}>
        ✓ Signed in — enter base details below
      </p>
    )}

    {/* Re-authenticate button for editing OAuth accounts */}
    {editMode !== 'add' && accounts.find(a => a.id === editMode)?.authType === 'oauth' && (
      <div className="form-group">
        {!oauthPending ? (
          <button type="button" className="btn btn-secondary" onClick={handleReauthenticate}>
            Re-authenticate
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>Waiting for browser…</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { window.electronAPI.cancelOAuth().catch(() => {}); }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    )}

    {/* Base ID and Table Name — shown when PAT tab, or OAuth tab after sign-in, or editing */}
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

    <div className="settings-actions">
      <button type="submit" className="btn btn-primary" disabled={saving || oauthPending}>
        {saving ? 'Saving…' : (editMode === 'add' ? 'Add Account' : 'Save Account')}
      </button>
      <button type="button" className="btn btn-secondary" onClick={cancelEdit}>
        Cancel
      </button>
    </div>
  </form>
)}
```

- [ ] **Step 7: Add `oauthLambdaUrl` field to the App Settings form**

In the App Settings form, add before the link-target field:
```tsx
<div className="form-group">
  <label htmlFor="oauth-lambda-url">OAuth Lambda URL</label>
  <input
    id="oauth-lambda-url"
    type="url"
    value={oauthLambdaUrl}
    onChange={(e) => setOauthLambdaUrl(e.target.value)}
    placeholder="https://xxxxxxxx.lambda-url.us-east-1.on.aws"
  />
</div>
```

And update the save handler to include it:
```typescript
await window.electronAPI.saveSettings({
  link_open_target: linkTarget,
  page_size: pageSize,
  oauth_lambda_url: oauthLambdaUrl,
});
```

- [ ] **Step 8: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/Settings.tsx
git commit -m "Add OAuth tab to Settings: sign-in flow, re-authenticate, Lambda URL field"
```

---

## Task 10: Add CSS for auth tab toggle

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Add auth tab toggle styles to `src/index.css`**

Append at the end of `src/index.css`:
```css
/* ── Auth tab toggle (PAT vs OAuth in Add Account form) ──────────────────── */
.auth-tab-toggle {
  display: flex;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 12px;
}

.auth-tab-btn {
  flex: 1;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 500;
  background: var(--column-bg);
  color: var(--text-muted);
  border: none;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.auth-tab-btn:first-child {
  border-right: 1px solid var(--border);
}

.auth-tab-btn.active {
  background: var(--accent);
  color: white;
}

.auth-tab-btn:hover:not(.active) {
  background: var(--hover-bg);
  color: var(--text);
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "Add auth tab toggle CSS for Settings OAuth UI"
```

---

## Task 11: Bump version, build, and distribute

- [ ] **Step 1: Bump version to 1.0.4 in `package.json`**

Change `"version": "1.0.3"` to `"version": "1.0.4"`.

- [ ] **Step 2: Run full typecheck one more time**

```bash
npm run typecheck
```

Expected: no errors across both tsconfigs.

- [ ] **Step 3: Commit version bump**

```bash
git add package.json
git commit -m "Bump version to 1.0.4 (OAuth support)"
```

- [ ] **Step 4: Build distributable**

```bash
npm run dist
```

Expected: `dist/Airtable Kanban-1.0.4-arm64.dmg` created.

- [ ] **Step 5: Copy to Downloads**

```bash
cp "dist/Airtable Kanban-1.0.4-arm64.dmg" ~/Downloads/
```

---

## Task 12: Deploy Lambda

> Run this after registering your Airtable OAuth integration and having your `client_id` + `client_secret` ready.

- [ ] **Step 1: Run `infra.sh` (one-time, sets up all AWS resources)**

```bash
AWS_DEFAULT_REGION=us-east-1 bash lambda/infra.sh
```

Expected output ends with the Function URL and next-step instructions.

- [ ] **Step 2: Update Lambda env vars with real credentials**

```bash
aws lambda update-function-configuration \
  --function-name airtable-kanban-oauth \
  --environment 'Variables={
    AIRTABLE_CLIENT_ID=<your_client_id>,
    AIRTABLE_CLIENT_SECRET=<your_client_secret>,
    DYNAMODB_TABLE=airtable-kanban-oauth,
    LAMBDA_BASE_URL=<function_url_without_trailing_slash>
  }'
```

- [ ] **Step 3: Verify Lambda is live**

```bash
curl -s -X POST <FUNCTION_URL>/start | jq .
```

Expected: `{ "authUrl": "https://airtable.com/oauth2/v1/authorize?...", "state": "<64 hex chars>" }`

- [ ] **Step 4: Enter Lambda URL in App Settings**

Open the app → Settings → App Settings → OAuth Lambda URL → paste the Function URL → Save Settings.

- [ ] **Step 5: Test end-to-end OAuth flow**

Open Settings → Add Account → "Sign in with Airtable" tab → click "Sign in with Airtable" → complete authorization in browser → enter Base ID + Table Name → Add Account.

Verify the account appears in the list with the correct name.
