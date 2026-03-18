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
