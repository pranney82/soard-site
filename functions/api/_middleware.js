/**
 * Cloudflare Access JWT Validation Middleware
 * ============================================
 * Validates the CF-Access-JWT-Assertion header on every /api/ request.
 * Defense-in-depth: even if the Access policy is misconfigured, requests
 * without a valid JWT are rejected before reaching any API handler.
 *
 * Required environment variables (set in CF Pages → Settings → Environment Variables):
 *   CF_ACCESS_TEAM_DOMAIN  — e.g. "soard" (the <team>.cloudflareaccess.com subdomain)
 *   CF_ACCESS_AUD          — the Application Audience (AUD) tag from the Access policy
 */

// Cache JWKS keys in module scope (persists across requests within same isolate)
let _cachedKeys = null;
let _cachedKeysExpiry = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// CORS: public endpoints allow any origin, authenticated endpoints restrict to our domain.
const ALLOWED_ORIGIN = 'https://sunshineonaranneyday.com';
const publicCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === ALLOWED_ORIGIN) return true;
  if (origin.endsWith('.cloudflareaccess.com')) return true;
  // Strict localhost check — only exact hostname, not localhost.evil.com
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  } catch {}
  return false;
}

function authedCors(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

// Public API routes that don't require authentication
const PUBLIC_ROUTES = ['/api/newsletter', '/api/kids.json', '/api/download-logo', '/api/download-branding-photos', '/api/calendar.ics'];

// ─── Rate Limiting (in-memory, per-isolate) ─────────────────────────
// Limits POST /api/newsletter to 5 requests per IP per 60 seconds.
// Resets when the Workers isolate recycles — good enough for spam prevention.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;
const RATE_LIMITED_ROUTES = new Set(['/api/newsletter']);
const _rateLimitMap = new Map(); // ip → { count, resetAt }
let _lastPrune = 0;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // prune stale entries every 5 min

function isRateLimited(ip) {
  const now = Date.now();

  // Periodically prune expired entries so the Map doesn't grow unbounded
  if (now - _lastPrune > PRUNE_INTERVAL_MS) {
    _lastPrune = now;
    for (const [key, val] of _rateLimitMap) {
      if (now > val.resetAt) _rateLimitMap.delete(key);
    }
  }

  const entry = _rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const isPublic = PUBLIC_ROUTES.some(route => url.pathname === route);

  // Preflight: return CORS headers immediately — downstream handlers don't implement OPTIONS
  if (context.request.method === 'OPTIONS') {
    const headers = isPublic ? publicCors : authedCors(context.request);
    return new Response(null, { status: 204, headers });
  }

  // Rate limit abuse-prone public endpoints
  if (RATE_LIMITED_ROUTES.has(url.pathname) && context.request.method === 'POST') {
    const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(ip)) {
      return Response.json(
        { ok: false, error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { ...publicCors, 'Retry-After': '60' } }
      );
    }
  }

  // Skip auth for public API routes
  if (isPublic) {
    return context.next();
  }

  const { CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD } = context.env;
  const cors = authedCors(context.request);

  // Fail closed: if Access env vars aren't configured, reject all authenticated requests.
  // This prevents accidental public exposure of admin APIs in production.
  if (!CF_ACCESS_TEAM_DOMAIN || !CF_ACCESS_AUD) {
    console.error('[middleware] BLOCKED: CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD not set — refusing to serve authenticated endpoint without auth config');
    return Response.json(
      { success: false, error: 'Server misconfiguration — authentication not configured. Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD environment variables.' },
      { status: 503, headers: cors }
    );
  }

  const jwt = context.request.headers.get('CF-Access-JWT-Assertion') || getCookieValue(context.request, 'CF_Authorization');

  if (!jwt) {
    return Response.json(
      { success: false, error: 'Unauthorized — missing access token' },
      { status: 403, headers: cors }
    );
  }

  let payload;
  try {
    payload = await verifyJwt(jwt, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD);
  } catch (err) {
    return Response.json(
      { success: false, error: `Unauthorized — ${err.message}` },
      { status: 403, headers: cors }
    );
  }

  // Pass authenticated user email to downstream handlers
  context.data = context.data || {};
  context.data.userEmail = payload.email || payload.sub || 'unknown';

  // Call downstream handler, then inject CORS headers into its response.
  // Handlers don't set CORS themselves — middleware owns it centrally.
  const response = await context.next();
  return injectCors(response, cors);
}

/** Inject CORS headers into an existing Response (immutable — must clone). */
function injectCors(response, corsHeaders) {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// ─── JWT Verification ──────────────────────────────────────────────

async function verifyJwt(token, teamDomain, expectedAud) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const header = JSON.parse(b64UrlDecode(parts[0]));
  const payload = JSON.parse(b64UrlDecode(parts[1]));

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('token expired');
  }

  // Check issuer
  const expectedIss = `https://${teamDomain}.cloudflareaccess.com`;
  if (payload.iss !== expectedIss) {
    throw new Error('invalid issuer');
  }

  // Check audience
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(expectedAud)) {
    throw new Error('invalid audience');
  }

  // Fetch public keys and verify signature
  const keys = await getPublicKeys(teamDomain);
  const kid = header.kid;
  const key = keys.find(k => k.kid === kid);
  if (!key) throw new Error('signing key not found');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signatureBytes = b64UrlToUint8(parts[2]);
  const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signatureBytes,
    dataBytes
  );

  if (!valid) throw new Error('invalid signature');

  return payload;
}

async function getPublicKeys(teamDomain) {
  if (_cachedKeys && Date.now() < _cachedKeysExpiry) {
    return _cachedKeys;
  }

  const certsUrl = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const res = await fetch(certsUrl);
  if (!res.ok) throw new Error('failed to fetch access certs');

  const data = await res.json();
  _cachedKeys = data.keys;
  _cachedKeysExpiry = Date.now() + CACHE_TTL_MS;

  return _cachedKeys;
}

// ─── Cookie Helper ────────────────────────────────────────────────

function getCookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

// ─── Base64URL Helpers ─────────────────────────────────────────────

function b64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded);
}

function b64UrlToUint8(str) {
  const binary = b64UrlDecode(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
