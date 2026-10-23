/**
 * The list is Kit's: newsletter signups land there (staff write and send
 * newsletters in Kit itself). Nothing list-related may touch Resend.
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as newsletterPost, onRequestGet as newsletterGet, issueTicket, MIN_FILL_MS } from '../functions/api/newsletter.js';
import { createD1 } from './lib/d1-shim.mjs';

const realFetch = globalThis.fetch;
let calls;
let kit;     // { subscribeStatus, tags }
let resend;  // { status }

beforeEach(() => {
  calls = [];
  kit = { subscribeStatus: 201, tags: [{ id: 7, name: 'Newsletter' }, { id: 8, name: 'Application Waitlist' }] };
  resend = { status: 200 };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? null;
    calls.push({ url, method: init.method || 'GET', body, headers: init.headers });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return json({ success: body.get('response') === 'good-token' });
    if (url === 'https://api.kit.com/v4/subscribers') return json({ subscriber: { id: 1 } }, kit.subscribeStatus);
    if (url.startsWith('https://api.kit.com/v4/tags')) return json({ tags: kit.tags, tag: { id: 99 } });
    if (url === 'https://api.resend.com/emails/batch') return json(resend.status < 300 ? { data: body.map((_, i) => ({ id: `em${i}` })) } : { message: 'down' }, resend.status);
    throw new Error(`no fake for ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = (path, body, env = {}, { form = false } = {}) => ({
  env,
  data: {},
  request: new Request(`https://sunshineonaranneyday.com${path}`, form
    ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://sunshineonaranneyday.com/about/' }, body: new URLSearchParams(body) }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
const KIT = { KIT_API_KEY: 'kit-key' };
const RESEND = { RESEND_API_KEY: 're_test' };
const noResend = () => assert.equal(calls.filter(c => c.url.includes('resend.com')).length, 0, 'never touches Resend');

// ─── Newsletter signup ───────────────────────────────────────────────

test('a signup lands in Kit only, tagged by its source', async () => {
  const res = await newsletterPost(ctx('/api/newsletter', { email: ' Fan@Example.com ', source: 'newsletter' }, { ...KIT, ...RESEND }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const sub = calls.find(c => c.url === 'https://api.kit.com/v4/subscribers');
  assert.deepEqual(sub.body, { email_address: 'fan@example.com', state: 'active' });
  assert.ok(calls.some(c => c.url.includes('/v4/tags')), 'tagged');
  noResend();
});

test('Kit rejecting a signup is a 503 (never 502), and so is a missing Kit key', async () => {
  kit.subscribeStatus = 422;
  const rejected = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com' }, KIT));
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).ok, false);

  const unset = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com' }, RESEND));
  assert.equal(unset.status, 503);
  assert.match((await unset.json()).error, /not configured/);
  noResend();
});

/** The hidden fields of the confirm page a plain form post gets */
async function confirmFields(res) {
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const html = await res.text();
  return { html, fields: Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1], m[2].replace(/&#39;/g, "'").replace(/&amp;/g, '&')])) };
}

test('a plain form post (no JavaScript) gets a one-tap confirm page, then redirects back once it has been open a moment', async () => {
  const first = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com', source: 'newsletter' }, KIT, { form: true }));
  const { html, fields } = await confirmFields(first);
  assert.match(html, /Tap the button to get the Sunshine newsletter at <strong>fan@example\.com<\/strong>\./);
  assert.equal(fields.back, '/about/', 'it goes back to the page they were on');
  assert.match(fields.ft, /^\d{13}\.[0-9a-f]{40}$/);
  assert.equal(calls.length, 0, 'nobody is signed up by the first post');

  // Tapped at once (a script, not a person): asked to wait
  const tooSoon = await newsletterPost(ctx('/api/newsletter', fields, KIT, { form: true }));
  assert.match((await confirmFields(tooSoon)).html, /One moment, then tap the button again/);
  assert.equal(calls.length, 0);

  // A ticket from a few seconds ago: signed up, and back to the page
  const ft = await issueTicket(KIT, 'fan@example.com', 'newsletter', Date.now() - MIN_FILL_MS - 500);
  const ok = await newsletterPost(ctx('/api/newsletter', { ...fields, ft }, KIT, { form: true }));
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('Location'), 'https://sunshineonaranneyday.com/about/?subscribed=1#newsletter-form');
  assert.ok(calls.some(c => c.url === 'https://api.kit.com/v4/subscribers'));

  // A ticket is for one address and source, and can't be made up
  for (const bad of [{ ...fields, ft, email: 'other@example.com' }, { ...fields, ft, source: 'application-waitlist' }, { ...fields, ft: `${Date.now() - 9000}.${'0'.repeat(40)}` }, { ...fields, ft: await issueTicket(KIT, 'fan@example.com', 'newsletter', Date.now() - 2 * 3600e3) }]) {
    calls = [];
    await confirmFields(await newsletterPost(ctx('/api/newsletter', bad, KIT, { form: true })));
    assert.equal(calls.length, 0);
  }
  // Only a path on this site to go back to
  const away = await newsletterPost(ctx('/api/newsletter', { ...fields, ft, back: '//evil.example/x' }, KIT, { form: true }));
  assert.equal(new URL(away.headers.get('Location')).origin, 'https://sunshineonaranneyday.com');
});

test('form posts: the honeypot answers OK without calling anyone; no Kit key says so', async () => {
  const unset = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com' }, {}, { form: true }));
  assert.match(unset.headers.get('Location'), /newsletter_error=not_configured/, 'with no secret to sign a ticket, no confirm page');

  calls = [];
  const bot = await newsletterPost(ctx('/api/newsletter', { email: 'bot@example.com', website: 'spam' }, KIT, { form: true }));
  assert.match(bot.headers.get('Location'), /subscribed=1/);
  assert.equal(calls.length, 0);
});

// ─── Who can sign up, to what ────────────────────────────────────────

test('a source picks only one of the site’s own tags; anything else is the newsletter', async () => {
  for (const source of ['newsletter', 'vip-donors', 'Board-Only', '', 'application-waitlist']) {
    calls = [];
    const res = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com', source }, KIT));
    assert.equal(res.status, 200);
    const tagged = calls.find(c => /\/v4\/tags\/\d+\/subscribers$/.test(c.url));
    assert.equal(tagged.url, `https://api.kit.com/v4/tags/${source === 'application-waitlist' ? 8 : 7}/subscribers`, `${source || '(none)'} → its tag`);
    assert.ok(!calls.some(c => c.url === 'https://api.kit.com/v4/tags' && c.method === 'POST'), 'nothing made while the tags exist');
  }
});

test('a missing allowlisted tag is made (only those names); a request can never name a tag', async () => {
  // A fresh isolate, and a Kit with no tags yet
  const k = await import('../functions/api/_kit.js?isolate=no-tags');
  kit.tags = [];
  for (const source of ['brand-new-audience', 'Investors', 'newsletter', 'application-waitlist']) await k.kitSubscribe(KIT, 'new@example.com', { source: k.cleanSource(source) });
  const made = calls.filter(c => c.method === 'POST' && c.url === 'https://api.kit.com/v4/tags').map(c => c.body.name);
  assert.ok(made.length > 0, 'the newsletter tag was made');
  assert.deepEqual([...new Set(made)].sort(), ['Application Waitlist', 'Newsletter']);
  // Other lookups that only ask (the waitlist-only tag) never make one
  assert.ok(!made.includes(k.WAITLIST_ONLY_TAG));
});

test('tag ids are kept in D1, so a fresh isolate doesn’t page through Kit’s tags again', async () => {
  const DB = await createD1();
  const env = { ...KIT, DB };
  const fresh1 = await import('../functions/api/_kit.js?isolate=1');
  const fresh2 = await import('../functions/api/_kit.js?isolate=2');
  await fresh1.kitSubscribe(env, 'fan@example.com', { source: 'newsletter' });
  // Newsletter (found) and the waitlist-only tag (not in this Kit, and that's remembered too)
  assert.equal(calls.filter(c => c.url.startsWith('https://api.kit.com/v4/tags?')).length, 2, 'each looked up once');
  calls = [];
  await fresh2.kitSubscribe(env, 'fan2@example.com', { source: 'newsletter' });
  assert.equal(calls.filter(c => c.url.startsWith('https://api.kit.com/v4/tags?')).length, 0, 'the next isolate reads D1');
  assert.ok(calls.some(c => c.url === 'https://api.kit.com/v4/tags/7/subscribers'));
});

test('only the site’s own pages can sign people up', async () => {
  const from = (origin, extra = {}, url = 'https://sunshineonaranneyday.com/api/newsletter') => ({
    env: KIT, data: {},
    request: new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...extra }, body: JSON.stringify({ email: 'fan@example.com' }) }),
  });
  for (const [label, c] of [
    ['another site', from('https://evil.example')],
    ['an opaque origin', from('null')],
    ['localhost against the live site', from('http://localhost:4321')],
    ['a cross-site fetch with no Origin', from(null, { 'Sec-Fetch-Site': 'cross-site' })],
  ]) {
    calls = [];
    const res = await newsletterPost(c);
    assert.equal(res.status, 403, label);
    assert.equal(calls.length, 0, label);
  }
  for (const [label, c] of [
    ['the live site', from('https://sunshineonaranneyday.com')],
    ['a preview deployment, its own origin', from('https://abc123.soard-site.pages.dev', {}, 'https://abc123.soard-site.pages.dev/api/newsletter')],
    ['localhost on localhost', from('http://localhost:4321', {}, 'http://localhost:8788/api/newsletter')],
  ]) {
    assert.equal((await newsletterPost(c)).status, 200, label);
  }
  // A form on another site posting here
  const form = { env: KIT, data: {}, request: new Request('https://sunshineonaranneyday.com/api/newsletter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }, body: new URLSearchParams({ email: 'fan@example.com' }) }) };
  assert.equal((await newsletterPost(form)).status, 403);
});

test('with Turnstile on, a JSON signup needs a good token; a form post with one skips the confirm page', async () => {
  const env = { ...KIT, TURNSTILE_SECRET_KEY: 'ts_secret' };
  const none = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com' }, env));
  assert.equal(none.status, 403);
  assert.equal((await none.json()).code, 'turnstile');
  const bad = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com', turnstileToken: 'forged' }, env));
  assert.equal(bad.status, 403);
  assert.ok(!calls.some(c => c.url.includes('api.kit.com')), 'Kit untouched');

  const good = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com', turnstileToken: 'good-token' }, env));
  assert.equal(good.status, 200);
  assert.ok(calls.some(c => c.url === 'https://api.kit.com/v4/subscribers'));

  // The widget adds cf-turnstile-response to the form itself
  const formOk = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com', 'cf-turnstile-response': 'good-token' }, env, { form: true }));
  assert.equal(formOk.status, 302);
  await confirmFields(await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com', 'cf-turnstile-response': 'forged' }, env, { form: true })));

  // What the forms' script reads
  assert.deepEqual(await (await newsletterGet({ env })).json(), { ok: true, turnstileSiteKey: '0x4AAAAAACpMJDcIPz2DI536' });
  assert.deepEqual(await (await newsletterGet({ env: KIT })).json(), { ok: true, turnstileSiteKey: null });
});

test('limits in D1: per connection, per email address, and tighter for plain form posts', async () => {
  const env = { ...KIT, DB: await createD1() };
  const post = (email, ip, body = {}, opts) => newsletterPost({ ...ctx('/api/newsletter', { email, ...body }, env, opts), request: new Request('https://sunshineonaranneyday.com/api/newsletter', opts?.form
    ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip, Referer: 'https://sunshineonaranneyday.com/' }, body: new URLSearchParams({ email, ...body }) }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ email, ...body }) }) });

  // A gala table on the venue's Wi-Fi is one connection: thirty an hour are fine
  for (let i = 0; i < 30; i++) assert.equal((await post(`p${i}@example.com`, '203.0.113.5')).status, 200, `signup ${i + 1}`);
  const over = await post('p31@example.com', '203.0.113.5');
  assert.equal(over.status, 429, 'thirty an hour from one connection');
  assert.ok(Number(over.headers.get('Retry-After')) > 0);

  // One address, from anywhere: three a day
  for (let i = 0; i < 3; i++) assert.equal((await post('same@example.com', `198.51.100.${i}`)).status, 200);
  assert.equal((await post('same@example.com', '198.51.100.9')).status, 429);

  // Plain form posts (no Turnstile): two an hour from one connection
  for (let i = 0; i < 2; i++) {
    const email = `form${i}@example.com`;
    const ft = await issueTicket(env, email, 'newsletter', Date.now() - 5000);
    assert.match((await post(email, '192.0.2.7', { ft }, { form: true })).headers.get('Location'), /subscribed=1/);
  }
  const ft = await issueTicket(env, 'form3@example.com', 'newsletter', Date.now() - 5000);
  assert.match((await post('form3@example.com', '192.0.2.7', { ft }, { form: true })).headers.get('Location'), /newsletter_error=rate_limited/);
});
