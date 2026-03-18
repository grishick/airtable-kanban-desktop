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

async function handleCallback(qs) {
  // 1. Validate state format first — before any DynamoDB access
  if (!STATE_RE.test(qs.state ?? '')) {
    return htmlResponse('Invalid request — you can close this tab.', 400);
  }

  // 2. Handle user denial
  if (qs.error) {
    try {
      await dynamo.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { state: { S: qs.state } },
        UpdateExpression: 'SET #err = :err, #ttl = :ttl',
        ConditionExpression: 'attribute_exists(#state) AND attribute_not_exists(access_token)',
        ExpressionAttributeNames: {
          '#err': 'error',
          '#ttl': 'ttl',
          '#state': 'state',
        },
        ExpressionAttributeValues: {
          ':err': { S: qs.error },
          ':ttl': { N: String(ttlNow()) },
        },
      }));
    } catch {
      // Item doesn't exist or already has tokens — ignore, just show denial page
    }
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
    return jsonResponse({ error: 'refresh_failed' }, 401);
  }

  const data = await resp.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return jsonResponse({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt });
}
