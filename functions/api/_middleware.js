/**
 * Cloudflare Access JWT Validation Middleware
 * ============================================
 * Validates the CF-Access-JWT-Assertion header on every /api/ request.
 * Defense-in-depth: even if the Access policy is misconfigured, requests
 * without a valid JWT are rejected before reaching any API handler.
 *
 * Every /api/ response, public or not, also leaves with the security headers
 * public/_headers gives static files (that file never reaches Functions):
 * nosniff, HSTS, a referrer policy, a frame policy and a CSP (see
 * withSecurityHeaders below).
 *
 * Required environment variables (set in CF Pages → Settings → Environment Variables):
 *   CF_ACCESS_TEAM_DOMAIN  — e.g. "soard" (the <team>.cloudflareaccess.com subdomain)
 *   CF_ACCESS_AUD          — the Application Audience (AUD) tag from the Access policy
 */

import { crossSiteChange, isLocalHost } from './_origin-guard.js';
import { limit } from './_rate-limit.js';
import { clientIp } from './_secure.js';
import { isStaffEmail, boardMemberFor, BOARD_ROUTES, BOARD_PAGE } from './_board-roles.js';
import { staffStanding, refusedText } from './_staff-access.js';

// Cache JWKS keys in module scope (persists across requests within same isolate)
let _cachedKeys = null;
let _cachedKeysFor = '';
let _cachedKeysExpiry = 0;
let _keysFetchedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
// A token signed with a key we haven't seen means Access rotated its keys:
// the certs are fetched again, but at most this often (junk tokens can't hammer it)
const KEYS_REFETCH_MIN_MS = 30 * 1000;
// Clock difference allowed between Access and this isolate for exp, nbf and iat
const CLOCK_SKEW_S = 60;

// CORS: public endpoints allow any origin, authenticated endpoints restrict to our domain.
const ALLOWED_ORIGIN = 'https://sunshineonaranneyday.com';
const publicCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
/**
 * The team's own Cloudflare Access origin (e.g. https://soard.cloudflareaccess.com),
 * derived from CF_ACCESS_ISS (issuer URL). Falls back to CF_ACCESS_TEAM_DOMAIN
 * so a single configured var still works. Returns '' if neither is set.
 */
function accessOrigin(env) {
  const iss = (env && env.CF_ACCESS_ISS)
    || (env && env.CF_ACCESS_TEAM_DOMAIN ? `https://${env.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com` : '');
  try {
    return iss ? new URL(iss).origin : '';
  } catch {
    return '';
  }
}

export function isAllowedOrigin(origin, teamOrigin, selfUrl = ALLOWED_ORIGIN) {
  if (!origin) return false;
  if (origin === ALLOWED_ORIGIN) return true;
  // Only the team's own Access domain — not any *.cloudflareaccess.com tenant.
  if (teamOrigin && origin === teamOrigin) return true;
  // A local page (astro dev on another port) only for a server that is itself
  // local (wrangler pages dev): never in production. Exact hostnames only, not
  // localhost.evil.com
  try {
    if (isLocalHost(new URL(selfUrl).hostname) && isLocalHost(new URL(origin).hostname)) return true;
  } catch {}
  return false;
}

function authedCors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const teamOrigin = accessOrigin(env);
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin, teamOrigin, request.url) ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

// Public API routes that don't require authentication
const PUBLIC_ROUTES = ['/api/newsletter', '/api/kids.json', '/api/download-logo', '/api/download-branding-photos', '/api/calendar.ics', '/api/live-click',
  // Live broadcast system (see functions/api/_broadcast.js). stream-webhook and
  // broadcast-hooks authenticate inside the handler (Stream lifecycle is the
  // authority; hub ticks carry one-time nonces verified over the DO binding).
  '/api/stream-webhook', '/api/broadcast-hooks', '/api/live-ws', '/api/reminders', '/api/broadcast-event',
  // Messages for the family: screened and rate limited per visitor inside the handler
  // (not in the per-IP list below, since a whole family on the house wifi shares one address)
  '/api/live-messages',
  // Reveal calendar invites: a JobTread workflow wake-up ({ jobId }); the handler
  // re-reads everything from JobTread, so the body can't change what gets sent
  '/api/reveal-invites',
  // Reveal Date ↔ Reveal task sync: same wake-up pattern, re-reads JobTread
  '/api/reveal-sync',
  // The makeover application form: drafts are keyed by an unguessable token
  // checked inside the handler (rate limited below with its own, roomier limit)
  '/api/apply',
  // Applicant messages: a JobTread workflow wake-up ({ accountId }); re-reads JobTread
  '/api/applicant-sync',
  // Zeffy's payment.completed webhook: its Zeffy-Signature is checked inside the
  // handler against ZEFFY_WEBHOOK_SECRET before anything is posted
  '/api/zeffy-webhook'];

// Routes public for reads only — GET/HEAD skip auth, mutations still require Access.
// fb-live-videos returns only the page's public video permalinks (never the token),
// so it's safe to read anonymously; responses are cached in the function.
// reveals.ics is the reveal calendar people subscribe to (confirmed reveals only, never an address).
const PUBLIC_GET_ROUTES = ['/api/live-status', '/api/fb-live-videos', '/api/broadcast', '/api/reveals', '/api/reveals.ics'];

// A board or team member sending their own bio (/profile-update/): keyed by an
// unguessable link token checked inside the handler, rate limited below, and
// nothing goes live until someone in the admin uses it
PUBLIC_ROUTES.push('/api/profile-request');

// A vendor sending their insurance certificate or W-9 (/vendor-documents/):
// the same kind of link token, checked inside (_vendors.js), rate limited below;
// files go straight onto the vendor's account in JobTread, never kept here
PUBLIC_ROUTES.push('/api/vendor-docs');

// The buttons in a family-status summary email (Move back / Don't email /
// Send now): each carries a one-time 128-bit token for one status change,
// checked inside the handler; GET only shows a confirmation page
PUBLIC_ROUTES.push('/api/applicant-email-action');

// Slack's button clicks on the site's alert cards: answered with an empty 200
// and nothing else (the buttons only open links); signed when
// SLACK_SIGNING_SECRET is set
PUBLIC_ROUTES.push('/api/slack-actions');

// Browsers' Content-Security-Policy violation reports (no credentials): size
// capped, rate limited and deduped inside the handler, always answered 204
PUBLIC_ROUTES.push('/api/csp-report');

// CompanyCam's webhook (home-visit photos for families in review): signed with
// a token worked out from COMPANYCAM_TOKEN and checked inside the handler,
// which refuses everything when the key isn't set; rate limited there too
PUBLIC_ROUTES.push('/api/companycam-webhook');

// Twilio's delivery reports for staff alert texts: signed with
// TWILIO_AUTH_TOKEN and checked inside the handler, which refuses everything
// when the token isn't set; it only records delivered or why not
PUBLIC_ROUTES.push('/api/twilio-status');

// Resend's delivery reports for the site's emails: Svix-signed with the webhook
// secret and checked inside the handler, which refuses everything until there
// is one; it only records delivered, bounced and the like (see _email-log.js)
PUBLIC_ROUTES.push('/api/resend-webhook');

// Mercury's transaction events (job costs, see _spend.js): Mercury-Signature is
// checked inside the handler against the secret Mercury gave the site when it
// registered the webhook; nothing is done until there is one
PUBLIC_ROUTES.push('/api/mercury-webhook');

// What the DataX agents read and send (vendor rules, which job a charge was
// placed on, Ramp-bill splits, bills waiting for approval and the approver's
// answer): each checks the agent key inside (_spend-agent.js) and is rate
// limited there. A decision only counts from a listed approver (_bill-pay.js)
PUBLIC_ROUTES.push('/api/spend-rules', '/api/spend-hint', '/api/spend-recode', '/api/bill-approvals');

// The Advisory Board application (/advisory-board/apply/): GET says whether
// Turnstile is on; POST stores an application. Checked inside the handler
// (honeypot, too-fast, Turnstile, a per-day limit in D1) and rate limited below
PUBLIC_ROUTES.push('/api/advisory-apply');

// A board member's "Will you be there?" answer from a board email: each link
// carries that member's own 128-bit token for one meeting, checked inside
// (_board-rsvp.js); GET only shows the answer to confirm, rate limited below
PUBLIC_ROUTES.push('/api/board-rsvp');

// Where Intuit sends a Board admin back after "Connect QuickBooks" in Board →
// Settings: the one-time state Settings made is checked inside (_quickbooks.js),
// and the code is useless without SOARD's keys; rate limited below
PUBLIC_GET_ROUTES.push('/api/books-callback');

// ─── Rate Limiting ──────────────────────────────────────────────────
// Each limited route allows 5 calls per address (clientIp: IPv6 by its /64)
// per 60 seconds. The in-memory count is a cheap first filter that only sees
// one isolate; the D1 count (_rate-limit.js) holds across every isolate and
// data center, so spreading requests out doesn't get around it.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;
// Abuse-prone POST routes (newsletter signup, live-banner click beacon).
const RATE_LIMITED_POST_ROUTES = new Set(['/api/newsletter', '/api/live-click', '/api/reminders', '/api/broadcast-event', '/api/profile-request', '/api/advisory-apply', '/api/vendor-docs', '/api/board-rsvp']);
// Public GET routes that fan out to paid upstreams / build large responses.
const RATE_LIMITED_GET_ROUTES = new Set(['/api/download-branding-photos', '/api/books-callback']);
// The application form autosaves every step and uploads photos one by one, so
// a family filling it in makes far more than 5 calls a minute; it gets its own bucket.
// Per minute per address. A watch party or a gala table shares one Wi-Fi, so the
// beacons and the signup forms get room for a crowd; the handlers add their own
// per-person limits behind these.
const ROUTE_LIMITS = { '/api/broadcast-event': 120, '/api/live-click': 120, '/api/newsletter': 20, '/api/reminders': 20, '/api/profile-request': 10, '/api/vendor-docs': 10, '/api/board-rsvp': 10 };
const APPLY_ROUTE = '/api/apply';
const APPLY_RATE_LIMIT_MAX = 60;
const _rateLimitMap = new Map(); // "<route>:<ip>" → { count, resetAt }
let _lastPrune = 0;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // prune stale entries every 5 min

function isRateLimited(key, max = RATE_LIMIT_MAX) {
  const now = Date.now();

  // Periodically prune expired entries so the Map doesn't grow unbounded
  if (now - _lastPrune > PRUNE_INTERVAL_MS) {
    _lastPrune = now;
    for (const [k, val] of _rateLimitMap) {
      if (now > val.resetAt) _rateLimitMap.delete(k);
    }
  }

  const entry = _rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    _rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

/**
 * Count one call against a route's limit for this address: this isolate's
 * count first (no D1 trip once it's over), then D1's. Returns the seconds to
 * wait when over, else 0.
 */
async function overLimit(context, key, max) {
  if (isRateLimited(key, max)) return Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
  const r = await limit(context.env?.DB, `mw:${key}`, max, RATE_LIMIT_WINDOW_MS / 1000);
  return r.ok ? 0 : r.retryAfter;
}

/** Every /api/ response leaves with the security headers (see withSecurityHeaders) */
export async function onRequest(context) {
  return withSecurityHeaders(await handle(context));
}

async function handle(context) {
  const url = new URL(context.request.url);
  const isPublic = PUBLIC_ROUTES.some(route => url.pathname === route)
    || (PUBLIC_GET_ROUTES.some(route => url.pathname === route)
        && (context.request.method === 'GET' || context.request.method === 'HEAD'));

  // Preflight: return CORS headers immediately — downstream handlers don't implement OPTIONS
  if (context.request.method === 'OPTIONS') {
    const headers = isPublic ? publicCors : authedCors(context.request, context.env);
    return new Response(null, { status: 204, headers });
  }

  // Rate limit abuse-prone public endpoints (POST forms/beacons + GET fan-outs)
  const method = context.request.method;
  // A reminder link's own token is the proof: mail apps send one-click
  // unsubscribes (RFC 8058) in bursts from a few shared addresses
  const tokenLink = url.pathname === '/api/reminders' && (url.searchParams.has('unsubscribe') || url.searchParams.has('confirm'));
  const rateLimitThisRoute =
    (method === 'POST' && RATE_LIMITED_POST_ROUTES.has(url.pathname) && !tokenLink) ||
    (method === 'GET' && RATE_LIMITED_GET_ROUTES.has(url.pathname));
  if (rateLimitThisRoute) {
    const wait = await overLimit(context, `${url.pathname}:${clientIp(context.request)}`, ROUTE_LIMITS[url.pathname] || RATE_LIMIT_MAX);
    if (wait) {
      // No-JS newsletter form posts get a friendly redirect back with an error
      // param instead of raw JSON. Everything else gets a plain 429.
      if (url.pathname === '/api/newsletter') {
        const contentType = context.request.headers.get('Content-Type') || '';
        if (!contentType.includes('application/json')) {
          const back = new URL('/', url.origin);
          try {
            const ref = new URL(context.request.headers.get('Referer') || '');
            // Back to the page the form was on, never to an API route (the no-JS confirm page lives at /api/newsletter)
            if (ref.origin === url.origin && !ref.pathname.startsWith('/api/')) back.pathname = ref.pathname;
          } catch { /* invalid Referer, redirect to home */ }
          back.searchParams.set('newsletter_error', 'rate_limited');
          back.hash = 'newsletter-form';
          return Response.redirect(back.toString(), 302);
        }
      }
      return Response.json(
        { ok: false, error: 'Too many attempts — please wait a minute and try again.' },
        { status: 429, headers: { ...publicCors, 'Retry-After': String(wait) } }
      );
    }
  }

  if (method === 'POST' && url.pathname === APPLY_ROUTE) {
    const wait = await overLimit(context, `apply:${clientIp(context.request)}`, APPLY_RATE_LIMIT_MAX);
    if (wait) {
      return Response.json(
        { ok: false, error: 'Lots of saves in a short time. Please wait a minute and try again; your answers are safe.' },
        { status: 429, headers: { ...publicCors, 'Retry-After': String(wait) } }
      );
    }
  }

  // Skip auth for public API routes
  if (isPublic) {
    return context.next();
  }

  const { CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD } = context.env;
  const cors = authedCors(context.request, context.env);

  // A change to admin data must come from the admin itself, never from another
  // website riding a signed-in admin's Access cookie (see _origin-guard.js)
  const crossSite = crossSiteChange(context.request, [ALLOWED_ORIGIN, accessOrigin(context.env)].filter(Boolean));
  if (crossSite) {
    return Response.json(
      { success: false, error: 'Refused: changes to the admin must come from the admin itself' },
      { status: 403, headers: cors }
    );
  }

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
    // Why stays in the logs: the caller only learns that it didn't pass
    console.warn(`[middleware] Access token refused on ${url.pathname}: ${err.message}`);
    return Response.json(
      { success: false, error: 'Your admin sign-in expired or isn’t valid. Reload the page to sign in again.' },
      { status: 403, headers: cors }
    );
  }

  // Pass authenticated user email to downstream handlers
  context.data = context.data || {};
  context.data.userEmail = payload.email || payload.sub || 'unknown';

  // The same emailed code lets in staff and board members. Staff (a
  // soardcharity.com sign-in) reach the admin's APIs; a board member (People →
  // Board, by their private email) reaches only the board page's own routes;
  // anyone else Access somehow let in reaches nothing (see _board-roles.js)
  if (!isStaffEmail(context.data.userEmail)) {
    const member = await boardMemberFor(context.env.DB, context.data.userEmail).catch(() => null);
    if (!member || !BOARD_ROUTES.includes(url.pathname)) {
      return Response.json(
        member
          ? { success: false, error: 'This sign-in opens the board page only.', board: BOARD_PAGE }
          : { success: false, error: 'This sign-in isn’t on SOARD’s team or board list.' },
        { status: 403, headers: cors }
      );
    }
    context.data.boardMember = member;
  } else {
    // A soardcharity.com sign-in opens the admin only while its Google account is active (_staff-access.js)
    const standing = await staffStanding(context.env, context.data.userEmail);
    if (!standing.staff) {
      return Response.json({ success: false, error: refusedText(standing) }, { status: 403, headers: cors });
    }
  }

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

// ─── Security headers ──────────────────────────────────────────────
// public/_headers only reaches static files, so Function responses get the
// same basics here. A header a handler set itself is kept as it is.
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
});
// JSON, files, calendars, images: nothing in them may run, load anything or be framed
export const DATA_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
/**
 * The few pages /api/ answers with (an email button's confirmation,
 * "Reminders stopped"): their own inline styles, the site's fonts, forms that
 * post back to the page itself, and only the inline scripts they were sent
 * with (allowed by hash, so nothing injected into them runs).
 */
export function pageCsp(scriptHashes = []) {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    ...(scriptHashes.length ? [`script-src ${scriptHashes.join(' ')}`] : []),
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** CSP hashes ('sha256-…') of a page's inline scripts */
export async function inlineScriptHashes(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]) || !m[2]) continue;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[2])));
    let bin = '';
    for (const b of digest) bin += String.fromCharCode(b);
    out.add(`'sha256-${btoa(bin)}'`);
  }
  return [...out];
}

const isHtmlType = (type) => /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type || '');

/** A copy of a response with the security headers it lacks (a WebSocket upgrade passes as it is) */
export async function withSecurityHeaders(response) {
  if (!response || response.status === 101 || response.webSocket) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  let body = response.body;
  if (!headers.has('Content-Security-Policy')) {
    if (isHtmlType(headers.get('Content-Type'))) {
      let hashes = [];
      if (body) {
        body = await response.text();
        headers.delete('Content-Length');
        hashes = await inlineScriptHashes(body);
      }
      headers.set('Content-Security-Policy', pageCsp(hashes));
    } else if (!/^\s*application\/pdf\b/i.test(headers.get('Content-Type') || '')) {
      // (a PDF is left without one: it opens in the browser's own viewer, and Safari and Firefox won't render it sandboxed)
      headers.set('Content-Security-Policy', DATA_CSP);
    }
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// ─── JWT Verification ──────────────────────────────────────────────

export async function verifyJwt(token, teamDomain, expectedAud) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  let header;
  let payload;
  try {
    header = JSON.parse(utf8.decode(b64UrlToUint8(parts[0])));
    payload = JSON.parse(utf8.decode(b64UrlToUint8(parts[1])));
  } catch {
    throw new Error('malformed token');
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') throw new Error('malformed token');

  // Access signs with RS256 only: anything else (none, HS256 with the public key) is refused
  if (header.alg !== 'RS256') throw new Error(`unexpected algorithm ${String(header.alg).slice(0, 20)}`);

  // Times, with a minute's leeway for clock drift. A token with no expiry would never expire
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw new Error('token has no expiry');
  if (payload.exp + CLOCK_SKEW_S < now) throw new Error('token expired');
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - CLOCK_SKEW_S > now)) throw new Error('token not valid yet');
  if (payload.iat !== undefined && (typeof payload.iat !== 'number' || payload.iat - CLOCK_SKEW_S > now)) throw new Error('token issued in the future');

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
  const key = await signingKey(teamDomain, header.kid);

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

/**
 * Reusable auth check for public handlers that expose an admin-only branch
 * (e.g. live-status ?sweep=1). Returns true only when the request carries a
 * valid Cloudflare Access JWT for a staff sign-in (never a board member's).
 * Never throws; fails closed when the Access env vars are unset or the token
 * is missing/invalid.
 */
export async function isAuthenticated(request, env) {
  const { CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD } = env || {};
  if (!CF_ACCESS_TEAM_DOMAIN || !CF_ACCESS_AUD) return false;
  const jwt = request.headers.get('CF-Access-JWT-Assertion') || getCookieValue(request, 'CF_Authorization');
  if (!jwt) return false;
  try {
    // A board member's sign-in passes Access too; only staff count here, with an active Google account
    const payload = await verifyJwt(jwt, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD);
    return isStaffEmail(payload?.email) && (await staffStanding(env, payload.email)).staff;
  } catch {
    return false;
  }
}

async function getPublicKeys(teamDomain, { refresh = false } = {}) {
  if (!refresh && _cachedKeys && _cachedKeysFor === teamDomain && Date.now() < _cachedKeysExpiry) {
    return _cachedKeys;
  }
  // Noted before the fetch, so requests arriving meanwhile don't each refetch.
  // (Each request awaits its own fetch: Workers can't share one across requests.)
  _keysFetchedAt = Date.now();
  const certsUrl = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const res = await fetch(certsUrl);
  if (!res.ok) throw new Error('failed to fetch access certs');
  const data = await res.json();
  if (!Array.isArray(data?.keys)) throw new Error('access certs had no keys');
  _cachedKeys = data.keys;
  _cachedKeysFor = teamDomain;
  _cachedKeysExpiry = Date.now() + CACHE_TTL_MS;
  return _cachedKeys;
}

/**
 * The public key a token names. An unknown kid usually means Access rotated
 * its keys within the cache hour: the certs are fetched again (at most every
 * KEYS_REFETCH_MIN_MS) instead of locking admins out until the cache expires.
 */
async function signingKey(teamDomain, kid) {
  if (typeof kid !== 'string' || !kid) throw new Error('token names no signing key');
  const find = (keys) => keys.find((k) => k && k.kid === kid);
  let key = find(await getPublicKeys(teamDomain));
  if (!key && Date.now() - _keysFetchedAt >= KEYS_REFETCH_MIN_MS) {
    key = find(await getPublicKeys(teamDomain, { refresh: true }));
  }
  if (!key) throw new Error('signing key not found');
  return key;
}

/** Tests: forget the cached keys */
export function _resetKeyCacheForTests() {
  _cachedKeys = null;
  _cachedKeysFor = '';
  _cachedKeysExpiry = 0;
  _keysFetchedAt = 0;
}

// ─── Cookie Helper ────────────────────────────────────────────────

function getCookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

// ─── Base64URL Helpers ─────────────────────────────────────────────

const utf8 = new TextDecoder('utf-8', { fatal: true });

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
