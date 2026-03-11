/**
 * Cloudflare Access JWT Validation Middleware
 * ============================================
 * Security layers (evaluated in order):
 *   1. CORS — same-origin only; overrides any ACAO header set by downstream handlers
 *   2. CSRF — Origin header must match request host on state-changing methods (cookie auth)
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

/**
 * Build CORS headers. Same-origin only for authenticated endpoints.
 * Never return ACAO 'null' (sandboxed iframes send Origin: null and would match).
 */
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const host = new URL(request.url).origin;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  // Only reflect origin if it matches our host — otherwise omit ACAO entirely
  if (origin && origin === host) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/**
 * Stamp CORS headers onto any Response, overriding handler-set ACAO: * headers.
 */
function applyCors(response, corsHeaders) {
  const wrapped = new Response(response.body, response);
  // Remove any ACAO set by downstream handlers
  wrapped.headers.delete('Access-Control-Allow-Origin');
  wrapped.headers.delete('Access-Control-Allow-Methods');
  wrapped.headers.delete('Access-Control-Allow-Headers');
  wrapped.headers.delete('Access-Control-Max-Age');
  for (const [key, value] of Object.entries(corsHeaders)) {
    wrapped.headers.set(key, value);
  }
  return wrapped;
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
    const response = await context.next();
    return applyCors(response, corsHeaders);
  }

  const { CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD } = context.env;

  // Fail closed: if Access env vars aren't configured, reject all authenticated requests.
  // Never silently skip auth — one missing env var should not expose the entire admin API.
  if (!CF_ACCESS_TEAM_DOMAIN || !CF_ACCESS_AUD) {
    console.error('[middleware] CRITICAL: CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD not set — blocking request');
    return Response.json(
      { success: false, error: 'Authentication not configured' },
      { status: 503, headers: corsHeaders }
    );
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

  // ── Authorized — run handler and stamp CORS ──────────────────────
  const response = await context.next();
  return applyCors(response, corsHeaders);
}

// ─── JWT Verification ──────────────────────────────────────────────

async function verifyJwt(token, teamDomain, expectedAud) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const header = JSON.parse(b64UrlDecode(parts[0]));
  const payload = JSON.parse(b64UrlDecode(parts[1]));

  const now = Math.floor(Date.now() / 1000);

  // Check expiration
  if (payload.exp && payload.exp < now) {
    throw new Error('token expired');
  }

  // Check not-before
  if (payload.nbf && payload.nbf > now + 30) { // 30s clock skew tolerance
    throw new Error('token not yet valid');
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
  if (!kid) throw new Error('missing key ID');
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
