/**
 * Cloudflare Access JWT Validation Middleware
 * ============================================
 * Security layers (evaluated in order):
 *   1. CORS — restricts Access-Control-Allow-Origin to same origin (not *)
 *   2. CSRF — Origin header must match request host on state-changing methods
 *   3. JWT  — validates CF-Access-JWT-Assertion header OR CF_Authorization cookie
 *             against Cloudflare's JWKS public keys (issuer, audience, signature, expiry)
 *
 * Required environment variables (set in CF Pages → Settings → Environment Variables):
 *   CF_ACCESS_TEAM_DOMAIN  — e.g. "soard" (the <team>.cloudflareaccess.com subdomain)
 *   CF_ACCESS_AUD          — the Application Audience (AUD) tag from the Access policy
 */

// Cache JWKS keys in module scope (persists across requests within same isolate)
let _cachedKeys = null;
let _cachedKeysExpiry = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Public API routes that don't require authentication
const PUBLIC_ROUTES = ['/api/shopify', '/api/newsletter'];

// Methods that change state — require CSRF origin check when auth is cookie-based
const STATE_CHANGING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

function getCorsHeaders(request) {
  // Reflect the request origin only if it matches our own host,
  // otherwise return no ACAO header (browser blocks the response)
  const origin = request.headers.get('Origin');
  const host = new URL(request.url).origin;
  return {
    'Access-Control-Allow-Origin': origin === host ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export async function onRequest(context) {
  const { request } = context;
  const corsHeaders = getCorsHeaders(request);

  // Always allow preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Skip auth for public API routes (e.g. Shopify storefront proxy, newsletter)
  const url = new URL(request.url);
  if (PUBLIC_ROUTES.some(route => url.pathname === route)) {
    return context.next();
  }

  const { CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD } = context.env;

  // If Access env vars aren't set yet, let requests through
  // (avoids breaking the site during initial setup)
  if (!CF_ACCESS_TEAM_DOMAIN || !CF_ACCESS_AUD) {
    console.warn('[middleware] CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD not set — skipping JWT validation');
    return context.next();
  }

  // ── CSRF Protection ──────────────────────────────────────────────
  // When auth comes from a cookie (not a header), state-changing requests
  // must prove they originate from our own site via the Origin header.
  const jwtFromHeader = request.headers.get('CF-Access-JWT-Assertion');
  const jwtFromCookie = getCookie(request, 'CF_Authorization');
  const jwt = jwtFromHeader || jwtFromCookie;

  if (!jwt) {
    return Response.json(
      { success: false, error: 'Unauthorized — missing access token' },
      { status: 403, headers: corsHeaders }
    );
  }

  // If auth is cookie-based and method is state-changing, enforce origin check
  if (!jwtFromHeader && STATE_CHANGING_METHODS.includes(request.method)) {
    const origin = request.headers.get('Origin');
    const expected = url.origin;
    if (!origin || origin !== expected) {
      return Response.json(
        { success: false, error: 'Forbidden — origin mismatch' },
        { status: 403, headers: corsHeaders }
      );
    }
  }

  // ── JWT Validation ───────────────────────────────────────────────
  try {
    await verifyJwt(jwt, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD);
  } catch (err) {
    return Response.json(
      { success: false, error: `Unauthorized — ${err.message}` },
      { status: 403, headers: corsHeaders }
    );
  }

  return context.next();
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

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
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
