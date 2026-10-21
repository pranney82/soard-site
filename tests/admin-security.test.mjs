/**
 * The admin API's two guards: record names that can't leave their collection
 * (functions/api/_collections.js parsePath, used by save, read and delete),
 * and changes that must come from the admin itself, not another website
 * riding a signed-in admin's Access cookie (functions/api/_origin-guard.js,
 * run by _middleware.js).
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { parsePath, isSafeName } from '../functions/api/_collections.js';
import { crossSiteChange } from '../functions/api/_origin-guard.js';
import { onRequest, isAuthenticated, isAllowedOrigin, withSecurityHeaders, inlineScriptHashes, pageCsp, SECURITY_HEADERS, DATA_CSP, _resetKeyCacheForTests } from '../functions/api/_middleware.js';

test('record names stay inside their collection', () => {
  assert.deepEqual(parsePath('src/content/partners/bell.json'), { type: 'collection', table: 'partners', slug: 'bell', prefix: 'src/content/partners/' });
  assert.deepEqual(parsePath('src/content/site/partner-logo-dismissed.json'), { type: 'site', key: 'partner-logo-dismissed' });
  assert.equal(parsePath('src/content/kids/adrian-2025.json').slug, 'adrian-2025');
  assert.equal(parsePath('src/content/press/2024.11.04-wsb.json').slug, '2024.11.04-wsb', 'single dots between parts are fine');
  for (const bad of ['src/content/kids/../../functions/api/x.json', 'src/content/kids/a/b.json', 'src/content/site/../kids/x.json',
    'src/content/kids/..json', 'src/content/kids/.hidden.json', 'src/content/kids/a..b.json', 'src/content/kids/.json', 'src/content/kids/a b.json', 'src/content/kids/a%2f.json']) {
    assert.equal(parsePath(bad), null, bad);
  }
  assert.equal(parsePath(null), null);
  assert.equal(isSafeName('x'.repeat(201)), false);
});

const req = (method, headers = {}, url = 'https://sunshineonaranneyday.com/api/save-content') => new Request(url, { method, headers });

test('a change from another website is refused; the admin, scripts and reads aren’t', () => {
  const allowed = ['https://sunshineonaranneyday.com', 'https://soard.cloudflareaccess.com'];
  assert.match(crossSiteChange(req('POST', { Origin: 'https://evil.example' }), allowed), /evil/);
  assert.match(crossSiteChange(req('DELETE', { Origin: 'https://sunshineonaranneyday.com.evil.example' }), allowed), /evil/);
  assert.ok(crossSiteChange(req('POST', { Origin: 'null' }), allowed), 'a sandboxed page sends Origin: null');
  assert.ok(crossSiteChange(req('POST', { 'Sec-Fetch-Site': 'cross-site' }), allowed), 'no Origin, but the browser says cross-site');
  assert.equal(crossSiteChange(req('POST', { Origin: 'https://sunshineonaranneyday.com' }), allowed), null);
  assert.equal(crossSiteChange(req('POST', { Origin: 'https://abc123.soard-site.pages.dev' }, 'https://abc123.soard-site.pages.dev/api/save-content'), allowed), null, 'a preview deployment is its own origin');
  // A page on someone's own machine is another website in production; locally (astro dev → wrangler) it's the admin
  assert.match(crossSiteChange(req('POST', { Origin: 'http://localhost:8788' }), allowed), /localhost/);
  assert.match(crossSiteChange(req('POST', { Origin: 'http://127.0.0.1:4321' }), allowed), /127\.0\.0\.1/);
  assert.equal(crossSiteChange(req('POST', { Origin: 'http://localhost:4321' }, 'http://localhost:8788/api/save-content'), allowed), null);
  assert.equal(crossSiteChange(req('POST', { Origin: 'http://127.0.0.1:4321' }, 'http://127.0.0.1:8788/api/save-content'), allowed), null);
  assert.match(crossSiteChange(req('POST', { Origin: 'http://localhost.evil.example' }, 'http://localhost:8788/api/save-content'), allowed), /evil/);
  assert.equal(crossSiteChange(req('POST', { 'Sec-Fetch-Site': 'same-origin' }), allowed), null);
  assert.equal(crossSiteChange(req('POST'), allowed), null, 'a script with no browser headers goes on to the Access check');
  assert.equal(crossSiteChange(req('GET', { Origin: 'https://evil.example' }), allowed), null, 'reads are untouched');
});

test('the middleware refuses a cross-site change before anything else, and leaves public routes alone', async () => {
  const ctx = (path, method, headers) => ({ request: new Request(`https://sunshineonaranneyday.com${path}`, { method, headers }), env: {}, data: {}, next: async () => new Response('next') });
  const evil = await onRequest(ctx('/api/partners-batch', 'POST', { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }));
  assert.equal(evil.status, 403);
  assert.match((await evil.json()).error, /must come from the admin/);
  // Same origin passes the guard (then fails closed here, with no Access settings in this test)
  assert.equal((await onRequest(ctx('/api/partners-batch', 'POST', { Origin: 'https://sunshineonaranneyday.com' }))).status, 503);
  // The public newsletter form still takes posts from anywhere
  assert.equal(await (await onRequest(ctx('/api/newsletter', 'POST', { Origin: 'https://evil.example' }))).text(), 'next');
});

// ─── The Access token ─────────────────────────────────────────────
// A real RS256 key pair, its public half served as Access's certs (fetch is
// stubbed), and tokens signed with it as Access signs them.
const TEAM = 'soard';
const AUD = 'aud-tag';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const env = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey: pair.privateKey, jwk };
}
async function sign(key, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header }));
  const p = b64u(JSON.stringify({ iss: ISS, aud: [AUD], email: 'staff@soardcharity.com', iat: now, nbf: now, exp: now + 3600, ...claims }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const certs = { keys: [], fetches: 0 };
const realFetch = globalThis.fetch;
function serveCerts() {
  globalThis.fetch = async (url) => {
    if (String(url) === `${ISS}/cdn-cgi/access/certs`) { certs.fetches += 1; return Response.json({ keys: certs.keys }); }
    throw new Error(`unexpected fetch ${url}`);
  };
}
const adminCall = (token, { path = '/api/partners-batch', method = 'GET', headers = {}, url = 'https://sunshineonaranneyday.com', next } = {}) => {
  const ctx = { request: new Request(`${url}${path}`, { method, headers: { ...(token ? { 'CF-Access-JWT-Assertion': token } : {}), ...headers } }), env, data: {}, next: next || (async () => Response.json({ ok: true, user: ctx.data.userEmail })) };
  return onRequest(ctx);
};

test('a valid Access token passes; the times, the algorithm and the expiry are all checked', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  _resetKeyCacheForTests();
  serveCerts();
  const key = await keyPair('k1');
  certs.keys = [key.jwk];
  const now = Math.floor(Date.now() / 1000);

  const ok = await adminCall(await sign(key));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).user, 'staff@soardcharity.com');
  assert.equal((await adminCall(await sign(key, { exp: now - 30 }))).status, 200, 'a minute of clock drift is allowed');
  assert.equal((await adminCall(await sign(key, { nbf: now + 30, iat: now + 30 }))).status, 200);

  const refused = {
    'no expiry': await sign(key, { exp: undefined }),
    'expired': await sign(key, { exp: now - 120 }),
    'not valid yet': await sign(key, { nbf: now + 600 }),
    'issued in the future': await sign(key, { iat: now + 600 }),
    'a string expiry': await sign(key, { exp: String(now + 3600) }),
    'another audience': await sign(key, { aud: ['someone-else'] }),
    'another issuer': await sign(key, { iss: 'https://evil.cloudflareaccess.com' }),
    'alg none': (await sign(key, {}, { alg: 'none' })).split('.').slice(0, 2).join('.') + '.',
    'alg HS256': await sign(key, {}, { alg: 'HS256' }),
    'a bad signature': (await sign(key)).replace(/.{4}$/, 'AAAA'),
    'not a token': 'not.a.token',
  };
  for (const [why, token] of Object.entries(refused)) {
    const res = await adminCall(token);
    assert.equal(res.status, 403, why);
    const body = await res.json();
    // The caller learns only that it didn't pass, never why
    assert.doesNotMatch(body.error, /token|no expiry|signature|signing key|audience|issuer|algorithm|malformed|valid yet|future/i, `${why}: ${body.error}`);
    assert.match(body.error, /sign-in/);
  }
});

test('an unknown signing key fetches Access’s keys again (at most every 30 seconds), so a rotation doesn’t lock admins out', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  _resetKeyCacheForTests();
  serveCerts();
  const oldKey = await keyPair('old');
  const newKey = await keyPair('new');
  certs.keys = [oldKey.jwk];
  certs.fetches = 0;
  assert.equal((await adminCall(await sign(oldKey))).status, 200);
  assert.equal(certs.fetches, 1);
  // Access rotates. The keys were fetched moments ago, so a stranger's kid can't make us fetch again
  certs.keys = [newKey.jwk];
  const stranger = await keyPair('stranger');
  assert.equal((await adminCall(await sign(stranger))).status, 403);
  assert.equal(certs.fetches, 1, 'no refetch within 30 seconds of the last');
  // Half a minute on, the new key's first token fetches once and passes; the next ones use the cache
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 31_000;
  assert.equal((await adminCall(await sign(newKey))).status, 200);
  assert.equal(certs.fetches, 2);
  assert.equal((await adminCall(await sign(newKey))).status, 200);
  assert.equal(certs.fetches, 2);
  // Junk kids right after: refused without another fetch
  for (let i = 0; i < 5; i++) assert.equal((await adminCall(await sign(stranger))).status, 403);
  assert.equal(certs.fetches, 2);
});

test('isAuthenticated (a public route’s admin-only branch) uses the same checks', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  _resetKeyCacheForTests();
  serveCerts();
  const key = await keyPair('k1');
  certs.keys = [key.jwk];
  const r = (token) => new Request('https://sunshineonaranneyday.com/api/live-status?sweep=1', { headers: { 'CF-Access-JWT-Assertion': token } });
  assert.equal(await isAuthenticated(r(await sign(key)), env), true);
  assert.equal(await isAuthenticated(r(await sign(key, { exp: undefined })), env), false);
  assert.equal(await isAuthenticated(r(await sign(key, {}, { alg: 'HS256' })), env), false);
});

test('credentialed CORS: localhost only for a local server', () => {
  assert.equal(isAllowedOrigin('https://sunshineonaranneyday.com', ''), true);
  assert.equal(isAllowedOrigin('https://soard.cloudflareaccess.com', 'https://soard.cloudflareaccess.com'), true);
  assert.equal(isAllowedOrigin('https://other.cloudflareaccess.com', 'https://soard.cloudflareaccess.com'), false);
  assert.equal(isAllowedOrigin('http://localhost:4321', '', 'https://sunshineonaranneyday.com/api/x'), false, 'production never echoes a localhost origin');
  assert.equal(isAllowedOrigin('http://localhost:4321', '', 'http://localhost:8788/api/x'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:4321', '', 'http://127.0.0.1:8788/api/x'), true);
  assert.equal(isAllowedOrigin('http://localhost.evil.example', '', 'http://localhost:8788/api/x'), false);
});

test('a production preflight from localhost gets the site’s own origin back', async () => {
  const pre = (url, origin) => onRequest({ request: new Request(url, { method: 'OPTIONS', headers: { Origin: origin } }), env: {}, data: {}, next: async () => new Response('next') });
  assert.equal((await pre('https://sunshineonaranneyday.com/api/save-content', 'http://localhost:4321')).headers.get('Access-Control-Allow-Origin'), 'https://sunshineonaranneyday.com');
  assert.equal((await pre('http://localhost:8788/api/save-content', 'http://localhost:4321')).headers.get('Access-Control-Allow-Origin'), 'http://localhost:4321');
});

// ─── Security headers on every /api/ answer ───────────────────────
const publicCall = (path, next, init = {}) => onRequest({ request: new Request(`https://sunshineonaranneyday.com${path}`, init), env: {}, data: {}, next });

test('every answer gets nosniff, HSTS, a referrer policy, a frame policy and a CSP; a handler’s own are kept', async () => {
  const json = await publicCall('/api/broadcast', async () => Response.json({ ok: true }));
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(json.headers.get(name), value, name);
  assert.equal(json.headers.get('Content-Security-Policy'), DATA_CSP);
  assert.equal(DATA_CSP, "default-src 'none'; frame-ancestors 'none'; sandbox");
  assert.deepEqual(await json.json(), { ok: true }, 'the body is untouched');

  const own = await publicCall('/api/applicant-email-action', async () => new Response('<p>hi</p>', { headers: { 'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'" } }));
  assert.equal(own.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(own.headers.get('Content-Security-Policy'), "default-src 'self'");
  assert.equal(own.headers.get('X-Content-Type-Options'), 'nosniff');

  // Files, calendars and plain-text errors are data too
  const ics = await publicCall('/api/calendar.ics', async () => new Response('BEGIN:VCALENDAR', { headers: { 'Content-Type': 'text/calendar' } }));
  assert.equal(ics.headers.get('Content-Security-Policy'), DATA_CSP);
  const redirect = await publicCall('/api/newsletter', async () => Response.redirect('https://sunshineonaranneyday.com/?ok=1', 303), { method: 'POST', body: 'email=a%40b.c', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get('Location'), 'https://sunshineonaranneyday.com/?ok=1');
  assert.equal(redirect.headers.get('Strict-Transport-Security'), SECURITY_HEADERS['Strict-Transport-Security']);
  // Refusals made by the middleware itself too
  const refused = await onRequest({ request: new Request('https://sunshineonaranneyday.com/api/partners-batch', { method: 'POST', headers: { Origin: 'https://evil.example' } }), env: {}, data: {}, next: async () => new Response('next') });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  assert.equal(refused.headers.get('Content-Security-Policy'), DATA_CSP);
});

test('a page from /api/ gets a strict CSP that still lets its own styles, fonts, form and inline script work', async () => {
  const script = "document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',()=>{}));";
  const html = `<!doctype html><html><head><style>body{color:red}</style><link rel="preload" href="/fonts/x.woff2" as="font" crossorigin></head><body><form method="post"><button>Go</button></form><script>${script}</script><script src="/x.js"></script></body></html>`;
  const res = await publicCall('/api/applicant-email-action?t=x&do=send', async () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const csp = res.headers.get('Content-Security-Policy');
  const hash = createHash('sha256').update(script).digest('base64');
  assert.equal(csp, pageCsp([`'sha256-${hash}'`]));
  for (const d of ["default-src 'none'", "style-src 'unsafe-inline'", "font-src 'self'", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'", `script-src 'sha256-${hash}'`]) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-inline'[^;]*;?\s*$/.test(csp.split('script-src')[1] || ''), 'no unsafe-inline for scripts');
  assert.equal(await res.text(), html, 'the page is unchanged');
  // A page with no script allows none
  const plainPage = await publicCall('/api/reminders?unsubscribe=x', async () => new Response('<!doctype html><style>p{}</style><p>Stopped</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  assert.ok(!plainPage.headers.get('Content-Security-Policy').includes('script-src'));
  assert.equal(await inlineScriptHashes('<script src="/a.js"></script><script type="module">x()</script>').then((h) => h.length), 1);
});

test('a WebSocket upgrade passes through as it is', async () => {
  const upgrade = { status: 101, webSocket: {}, headers: new Headers() };
  assert.equal(await withSecurityHeaders(upgrade), upgrade);
});

// ─── Rate limits that hold across isolates ────────────────────────
test('the public limits count in D1, so spreading calls across isolates doesn’t get around them', async () => {
  const DB = await createD1();
  // Two copies of the middleware: two isolates, each with its own in-memory count, one D1
  const a = await import('../functions/api/_middleware.js?isolate=a');
  const b = await import('../functions/api/_middleware.js?isolate=b');
  const post = (mw, ip, { json = true, path = '/api/newsletter' } = {}) => mw.onRequest({
    request: new Request(`https://sunshineonaranneyday.com${path}`, { method: 'POST', body: json ? '{}' : 'email=x', headers: { 'CF-Connecting-IP': ip, 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', Referer: 'https://sunshineonaranneyday.com/donate/' } }),
    env: { DB }, data: {}, next: async () => Response.json({ ok: true }),
  });
  // The newsletter allows 20 a minute per address (a gala table shares one Wi-Fi)
  for (let i = 0; i < 20; i++) assert.equal((await post(i % 2 ? a : b, '203.0.113.9')).status, 200);
  const sixth = await post(b, '203.0.113.9');
  assert.equal(sixth.status, 429, 'the 21st in a minute is refused, though each isolate saw ten');
  assert.ok(Number(sixth.headers.get('Retry-After')) > 0);
  assert.equal(sixth.headers.get('X-Content-Type-Options'), 'nosniff');
  // The no-JS newsletter form still goes back to its page with a message
  const form = await post(a, '203.0.113.9', { json: false });
  assert.equal(form.status, 302);
  assert.match(form.headers.get('Location'), /^https:\/\/sunshineonaranneyday\.com\/donate\/\?newsletter_error=rate_limited#newsletter-form$/);
  // Each route counts on its own, and another address is unaffected
  assert.equal((await post(a, '203.0.113.9', { path: '/api/reminders' })).status, 200);
  assert.equal((await post(a, '198.51.100.7')).status, 200);
  // One IPv6 /64 is one household (or one attacker's block)
  for (let i = 0; i < 20; i++) assert.equal((await post(i % 2 ? a : b, i % 3 ? `2001:db8:1:2::${i + 1}` : `2001:0db8:0001:0002:0:0:0:${i + 1}`)).status, 200);
  assert.equal((await post(a, '2001:db8:1:2::ff')).status, 429, 'every spelling of the /64 shares one count');
  // The application form has its own, roomier bucket
  for (let i = 0; i < 60; i++) assert.equal((await post(i % 2 ? a : b, '192.0.2.44', { path: '/api/apply' })).status, 200, `save ${i + 1}`);
  const apply = await post(a, '192.0.2.44', { path: '/api/apply' });
  assert.equal(apply.status, 429);
  assert.match((await apply.json()).error, /your answers are safe/);
  // No D1 (local dev without the binding): the in-memory count still applies
  const c = await import('../functions/api/_middleware.js?isolate=c');
  const noDb = (ip) => c.onRequest({ request: new Request('https://sunshineonaranneyday.com/api/live-click', { method: 'POST', headers: { 'CF-Connecting-IP': ip } }), env: {}, data: {}, next: async () => new Response(null, { status: 204 }) });
  for (let i = 0; i < 120; i++) assert.equal((await noDb('192.0.2.99')).status, 204);
  assert.equal((await noDb('192.0.2.99')).status, 429);
});
