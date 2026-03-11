/**
 * Constant Contact OAuth2 Token Manager
 * ======================================
 * Provides a valid access token for CC v3 API calls.
 * Caches the token in module scope (persists across requests within the same
 * Cloudflare Workers isolate). Automatically refreshes when expired.
 *
 * Required env vars:
 *   CC_CLIENT_ID      — OAuth2 Application API Key
 *   CC_CLIENT_SECRET   — OAuth2 Application Secret
 *   CC_REFRESH_TOKEN   — Long-lived refresh token (set "Long Lived" in CC dev portal)
 *
 * Usage:
 *   import { getCCAccessToken } from './_cc-auth.js';
 *   const token = await getCCAccessToken(context.env);
 */

const TOKEN_ENDPOINT = 'https://authz.constantcontact.com/oauth2/default/v1/token';

// Module-scope cache (survives across requests in the same isolate)
let _cachedToken = null;
let _tokenExpiry = 0;

// Refresh 5 minutes before actual expiry to avoid edge-case 401s
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Returns a valid CC access token, refreshing if needed.
 * Throws if env vars are missing or refresh fails.
 */
export async function getCCAccessToken(env) {
  // Return cached token if still valid
  if (_cachedToken && Date.now() < _tokenExpiry) {
    return _cachedToken;
  }

  const { CC_CLIENT_ID, CC_CLIENT_SECRET, CC_REFRESH_TOKEN } = env;

  if (!CC_CLIENT_ID || !CC_CLIENT_SECRET || !CC_REFRESH_TOKEN) {
    throw new CCAuthError(
      'Missing Constant Contact OAuth credentials. Set CC_CLIENT_ID, CC_CLIENT_SECRET, and CC_REFRESH_TOKEN in Cloudflare Pages → Settings → Environment Variables.',
      503
    );
  }

  // Base64 encode client_id:client_secret for Basic auth
  const credentials = btoa(`${CC_CLIENT_ID}:${CC_CLIENT_SECRET}`);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: CC_REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`CC token refresh failed (${res.status}): ${body}`);

    if (res.status === 401) {
      throw new CCAuthError(
        'Constant Contact refresh token is invalid or expired. Re-authorize via /api/cc-oauth-start.',
        401
      );
    }

    throw new CCAuthError(
      `Constant Contact token refresh failed (${res.status}).`,
      502
    );
  }

  const data = await res.json();

  _cachedToken = data.access_token;
  // CC v3 access tokens have a 24-hour lifetime; use expires_in if provided
  const ttlMs = (data.expires_in || 86400) * 1000;
  _tokenExpiry = Date.now() + ttlMs - EXPIRY_BUFFER_MS;

  return _cachedToken;
}

/**
 * Force-clear the cached token (useful after a 401 from the CC API).
 */
export function clearCCTokenCache() {
  _cachedToken = null;
  _tokenExpiry = 0;
}

/**
 * Custom error with HTTP status code for clean handler responses.
 */
export class CCAuthError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'CCAuthError';
    this.status = status;
  }
}
