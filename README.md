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

## OAuth Lambda Deployment

The OAuth flow requires a small AWS Lambda function that acts as the OAuth server-side broker — it holds your `client_secret`, exchanges authorization codes for tokens, and hands them back to the desktop app via a short-lived DynamoDB session.

### Prerequisites

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured (`aws configure`) with a profile that has permissions to create Lambda, IAM, and DynamoDB resources
- An **Airtable OAuth integration** — create one at <https://airtable.com/create/oauth> (you'll set the redirect URI after deployment)

### First-time deployment

```bash
cd lambda
bash infra.sh
```

The script does everything automatically:

1. Creates a DynamoDB table `airtable-kanban-oauth` (on-demand billing, 90-second TTL)
2. Creates an IAM role with the minimum permissions needed (DynamoDB CRUD + Lambda execution)
3. Packages and deploys the function (`nodejs20.x`, 128 MB, 30 s timeout)
4. Enables a **Lambda Function URL** with public access and CORS (`GET`, `POST`)
5. Wires `LAMBDA_BASE_URL` back into the function environment

At the end of the run it prints:

```
Function URL: https://<id>.lambda-url.<region>.on.aws/
```

This URL is your public HTTPS endpoint (Lambda Function URL).

## Optional: API Gateway + Route53 custom domain

If you want `https://your-domain.com` (instead of the Lambda Function URL hostname), put an **API Gateway REST API** in front of the same Lambda and attach a **custom domain** to it (Route53 DNS points to the API Gateway custom domain).

The Lambda handler expects these routes (keep the paths exactly the same):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/start` | Initiates OAuth: generates PKCE + state, returns `authUrl` |
| `GET` | `/callback` | Airtable redirect target; exchanges code for tokens, stores in DynamoDB |
| `GET` | `/token?state=…` | Polled by the desktop app; returns tokens once, then deletes the record |
| `POST` | `/refresh` | Exchanges a refresh token for a new access token |

High-level setup:

1. Create a **REST API** in API Gateway.
2. Add resources `/start`, `/callback`, `/token`, `/refresh`.
3. For each method, configure an **AWS Lambda proxy integration** to the `airtable-kanban-oauth` Lambda.
4. Deploy the API to a stage (for example `prod`).
5. Create an API Gateway **custom domain** for your certificate and set **Base path mapping** to the deployed stage using base path `(none)` (so requests are like `https://your-domain.com/callback`).

Troubleshooting note: if you see `403 Forbidden` on the custom domain endpoint, ensure the API Gateway custom domain **security policy** allows clients (set it to `TLS_1_2` instead of `TLS_1_3`).

After you set up the custom domain, use:
- OAuth redirect URI: `https://your-domain.com/callback`
- App OAuth Lambda URL: `https://your-domain.com` (no trailing slash)

> **Region**: defaults to `us-east-1`. Override with `AWS_DEFAULT_REGION=us-west-2 bash infra.sh`.

### Post-deployment steps

**1. Finish registering your Airtable OAuth integration**

In <https://airtable.com/create/oauth>, set the **Redirect URI** to:

```
https://<id>.lambda-url.<region>.on.aws/callback
```

If you are using an API Gateway custom domain, use:

```
https://your-domain.com/callback
```

Then copy the **Client ID** and **Client Secret** from the integration page.

**2. Set real credentials on the Lambda**

```bash
aws lambda update-function-configuration \
  --function-name airtable-kanban-oauth \
  --environment 'Variables={
    AIRTABLE_CLIENT_ID=<your-client-id>,
    AIRTABLE_CLIENT_SECRET=<your-client-secret>,
    DYNAMODB_TABLE=airtable-kanban-oauth,
    LAMBDA_BASE_URL=https://<id>.lambda-url.<region>.on.aws
  }'
```

> The `LAMBDA_BASE_URL` must not have a trailing slash and must match the redirect URI you registered with Airtable exactly.

**3. Configure the desktop app**

Open the app → Settings → **App Settings** → paste the endpoint base URL into **OAuth Lambda URL**:
- Lambda Function URL base: `https://<id>.lambda-url.<region>.on.aws` (no trailing slash)
- Or API Gateway custom domain base: `https://your-domain.com` (no trailing slash)

### Updating the function code

After editing `lambda/index.mjs`:

```bash
cd lambda
bash deploy.sh
```

This repackages `index.mjs` + `node_modules` and calls `aws lambda update-function-code`.

### How the HTTP endpoint works

Whether you use the Lambda Function URL or an API Gateway custom domain, the same four routes are handled:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/start` | Initiates OAuth: generates PKCE + state, returns `authUrl` |
| `GET` | `/callback` | Airtable redirect target; exchanges code for tokens, stores in DynamoDB |
| `GET` | `/token?state=…` | Polled by the desktop app; returns tokens once, then deletes the record |
| `POST` | `/refresh` | Exchanges a refresh token for a new access token (client_secret stays server-side) |

The endpoint is public (`auth-type NONE` on Lambda; API Gateway typically has no authorizer) — security comes from the 64-hex-char `state` parameter that ties each session together.

---

## Caveats / Known limitations

- **Native module rebuild**: `better-sqlite3` must be compiled against Electron's Node headers. Run `npm run rebuild` if the app won't start.
- **No packaging**: no `electron-builder` config; use `npm start` to run from compiled source.
- **Single instance**: no IPC locking; launching two instances of the app against the same DB is unsupported.
- **Tags** must be a *Multiple select* field in Airtable; the app sends them as an array on sync.
- **Rate limits**: Airtable's free tier allows 5 req/s per base. Bulk operations on many pending ops may hit limits; retry logic (max 5 attempts with error recording) handles transient failures.
