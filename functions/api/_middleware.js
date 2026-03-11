/**
 * Cloudflare Access JWT Validation Middleware
 * ============================================
 * Validates the CF-Access-JWT-Assertion header OR the CF_Authorization cookie
 * on every /api/ request. The Access app covers /admin* which sets the browser
 * cookie; /api/* fetch requests carry that cookie automatically (same origin).
 *
 * Required environment variables (set in CF Pages → Settings → Environment Variables):
 *   CF_ACCESS_TEAM_DOMAIN  — e.g. "soard" (the <team>.cloudflareaccess.com subdomain)
 *   CF_ACCESS_AUD          — the Application Audience (AUD) tag from the Access policy
 */

// Cache JWKS keys in module scope (persists across requests within same isolate)
let _cachedKeys = null;
let _cachedKeysExpiry = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Public API routes that don't require authentication
const PUBLIC_ROUTES = ['/api/shopify', '/api/newsletter'];

export async function onRequest(context) {
  // Always allow preflight
  if (context.request.method === 'OPTIONS') {
    return context.next();
  }

  // Skip auth for public API routes (e.g. Shopify storefront proxy)
  const url = new URL(context.request.url);
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

  // Check header first (set by Access reverse proxy), then cookie (set on browser after login).
  // The /admin* Access app sets CF_Authorization cookie; /api/* isn't in the Access app scope
  // so browser fetch requests carry the cookie but not the header.
  const jwt = context.request.headers.get('CF-Access-JWT-Assertion')
    || getCookie(context.request, 'CF_Authorization');
  if (!jwt) {
    return Response.json(
      { success: false, error: 'Unauthorized — missing access token' },
      { status: 403, headers: cors }
    );
  }

  try {
    await verifyJwt(jwt, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD);
  } catch (err) {
    return Response.json(
      { success: false, error: `Unauthorized — ${err.message}` },
      { status: 403, headers: cors }
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
