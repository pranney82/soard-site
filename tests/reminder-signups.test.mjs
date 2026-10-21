/**
 * Reveal reminders: confirmed sign-ups, text codes, push hosts, unsubscribe,
 * limits, and the batched send that never holds up go-live
 * Run: node --test tests/reminder-signups.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };

// ─── Fake network: Resend, Twilio, Turnstile, Slack ─────────────────
const emails = [];   // every message Resend was asked to send
const texts = [];    // { to, body }
const slackPosts = [];
const sim = { twilioStop: new Set(), turnstileOk: 'good-token' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.resend.com/emails/batch')) { emails.push(...JSON.parse(init.body)); return Response.json({ data: [] }); }
  if (url.startsWith('https://api.twilio.com/')) {
    const to = init.body.get('To');
    if (sim.twilioStop.has(to)) return Response.json({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }, { status: 400 });
    texts.push({ to, body: init.body.get('Body') });
    return Response.json({ sid: 'SM1' }, { status: 201 });
  }
  if (url.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) return Response.json({ success: init.body.get('response') === sim.turnstileOk });
  if (url.startsWith('https://hooks.slack.test/')) { slackPosts.push(JSON.parse(init.body)); return new Response('ok'); }
  if (/^https:\/\/(fcm\.googleapis\.com|web\.push\.apple\.com)\//.test(url)) return new Response(null, { status: 201 });
  return Response.json({ success: true, result: [] });
};

let env, b, notify, endpoint, DB;
const pending = [];
const ctx = (request) => ({ env, request, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) });
const flush = () => Promise.all(pending.splice(0));
let ipSeq = 1;
const freshIp = () => `198.51.100.${ipSeq++}`;
const SITE = 'https://sunshineonaranneyday.com';
const post = (body, { ip = freshIp(), origin = SITE, url = `${SITE}/api/reminders` } = {}) => endpoint.onRequestPost(ctx(new Request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify(body),
})));
const get = (path) => endpoint.onRequestGet(ctx(new Request(`${SITE}${path}`)));
const rows = async (where = '1=1', ...args) => (await DB.prepare(`SELECT * FROM broadcast_reminders WHERE ${where}`).bind(...args).all()).results;
const confirmLink = (to) => {
  const m = [...emails].reverse().find(e => e.to[0] === to);
  return m && m.text.match(/https:\/\/sunshineonaranneyday\.com\/api\/reminders\?confirm=[\w-]+/)[0];
};
const codeFor = (to) => [...texts].reverse().find(t => t.to === to)?.body.match(/(\d{6}) is your code/)?.[1];

before(async () => {
  DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare(`INSERT INTO kids (slug, data, name, year, status) VALUES (?, ?, ?, ?, ?)`).bind('remi', JSON.stringify({ name: 'Remi', slug: 'remi' }), 'Remi', 2026, 'in-progress').run();
  await DB.prepare(`INSERT INTO kids (slug, data, name, year, status) VALUES (?, ?, ?, ?, ?)`).bind('max', JSON.stringify({ name: 'Max', slug: 'max' }), 'Max', 2026, 'in-progress').run();
  env = {
    DB, RESEND_API_KEY: 're_test',
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+18885550100',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.test/alerts',
  };
  b = await import('../functions/api/_broadcast.js');
  notify = await import('../functions/api/_broadcast-notify.js');
  endpoint = await import('../functions/api/reminders.js');
  await b.ensureSchema(DB);
});

after(() => { Date.now = realNow; globalThis.fetch = realFetch; });

// ─── Helpers ────────────────────────────────────────────────────────

test('phone numbers: US and Canada only', () => {
  for (const [input, want] of [
    ['(404) 555-0123', '+14045550123'], ['404.555.0123', '+14045550123'], ['1 404 555 0123', '+14045550123'],
    ['+1 (416) 555-0199', '+14165550199'], ['+14045550123', '+14045550123'],
  ]) assert.equal(notify.normalizePhone(input), want, input);
  for (const input of [
    '+44 20 7946 0958', '+447700900123', '0044 7700 900123', '011 44 7700 900123', // abroad
    '+1 876 555 0123', '809-555-0123', '+1 441 555 0123', // +1 but not the US or Canada
    '800-555-0123', '(888) 555-0100', '900-555-0123', // toll-free, premium
    '411-555-0123', '104-555-0123', '404-155-0123', '555-0123', '', null, 'call me',
  ]) assert.equal(notify.normalizePhone(input), null, String(input));
  assert.equal(notify.formatPhone('+18885550100'), '(888) 555-0100');
});

test('push endpoints: only browser push services', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QK1', 'https://api.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=1',
  ]) assert.equal(notify.pushEndpointOk(ok), true, ok);
  for (const bad of [
    'https://example.com/push', 'http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com.example.com/x',
    'https://push.apple.com.evil.example/x', 'https://notify.windows.com/x', 'https://fcm.googleapis.com:8443/x',
    'https://user:pw@fcm.googleapis.com/x', 'https://evilnotify.windows.com/x', 'not a url',
  ]) assert.equal(notify.pushEndpointOk(bad), false, bad);
});

test('calendar text: a bare \\r cannot start a new property', () => {
  const ics = notify.buildIcs({ uid: 'u1', title: 'Reveal\rATTENDEE:mailto:x@example.com', description: 'a\r\nb\nc\rd', start: '2026-11-01T18:00:00Z', url: 'https://x' });
  assert.ok(!/\r(?!\n)/.test(ics), 'no bare CR');
  assert.ok(!/^ATTENDEE/m.test(ics), 'no injected line');
  assert.match(ics, /SUMMARY:Reveal\\nATTENDEE:mailto:x@example\.com/);
  assert.match(ics, /DESCRIPTION:a\\nb\\nc\\nd/);
});

// ─── Email: held until the link is confirmed ────────────────────────

test('an email sign-up waits for its link; opening the link only asks; the button confirms', async () => {
  const res = await post({ channel: 'email', email: 'Ana@Example.com', kidSlug: 'remi' });
  assert.deepEqual(await res.json(), { ok: true, channel: 'email', pending: true });
  assert.equal((await rows()).length, 0, 'not on the list yet');
  const mail = emails.at(-1);
  assert.equal(mail.to[0], 'ana@example.com');
  assert.match(mail.subject, /Confirm your reminders for Remi's reveal/);
  const link = confirmLink('ana@example.com');
  const tokenInLink = link.split('confirm=')[1];
  const stored = await DB.prepare('SELECT * FROM broadcast_reminder_pending').all();
  assert.equal(stored.results.length, 1);
  assert.notEqual(stored.results[0].secret_hash, tokenInLink, 'the token is stored hashed');
  assert.equal(stored.results[0].secret_hash, await notify.sha256Hex(tokenInLink));

  // A mail scanner opening the link changes nothing
  const page = await get(link.replace(SITE, ''));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Yes, remind me/);
  assert.match(html, /<form method="post" action="\/api\/reminders\?confirm=/);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('Referrer-Policy'), 'strict-origin');
  assert.equal((await rows()).length, 0);

  // The button: a same-site POST with no body
  const done = await endpoint.onRequestPost(ctx(new Request(link, { method: 'POST', headers: { Origin: SITE } })));
  assert.equal(done.status, 200);
  assert.match(await done.text(), /on the list/);
  await flush();
  const [row] = await rows();
  assert.equal(row.address, 'ana@example.com');
  assert.equal(row.kid_slug, 'remi');
  assert.equal(row.unsubscribed_at, null);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM broadcast_reminder_pending').first()).n, 0, 'the link is used up');
  const again = await endpoint.onRequestPost(ctx(new Request(link, { method: 'POST' })));
  assert.equal(again.status, 410);
  const ev = await DB.prepare(`SELECT COUNT(*) AS n FROM broadcast_events WHERE type = 'reminder_signup'`).first();
  assert.equal(ev.n, 1, 'counted once it is confirmed');
});

test('confirm links expire after 3 days', async () => {
  await post({ channel: 'email', email: 'late@example.com' });
  const link = confirmLink('late@example.com');
  travel(3 * 24 * 3600e3 + 60e3);
  assert.equal((await get(link.replace(SITE, ''))).status, 410);
  assert.equal((await endpoint.onRequestPost(ctx(new Request(link, { method: 'POST' })))).status, 410);
  assert.equal((await rows('address = ?', 'late@example.com')).length, 0);
});

test('signing up again never undoes an unsubscribe or changes which reveal, until confirmed', async () => {
  // Ana is on the list for Remi. A stranger asks for every reveal at her address: nothing changes.
  await post({ channel: 'email', email: 'ana@example.com', kidSlug: 'nobody-real' });
  let [row] = await rows('address = ?', 'ana@example.com');
  assert.equal(row.kid_slug, 'remi', 'an unconfirmed sign-up cannot mute her');
  const strangerLink = confirmLink('ana@example.com');

  // She unsubscribes; a new sign-up doesn't put her back
  await endpoint.onRequestPost(ctx(new Request(`${SITE}/api/reminders?unsubscribe=${row.token}`, { method: 'POST' })));
  await post({ channel: 'email', email: 'ana@example.com', kidSlug: 'max' });
  [row] = await rows('address = ?', 'ana@example.com');
  assert.ok(row.unsubscribed_at, 'still unsubscribed');
  assert.equal(row.kid_slug, 'remi');

  // Only her own confirmation does, for the reveal that link named; a bogus kid means every reveal
  await endpoint.onRequestPost(ctx(new Request(confirmLink('ana@example.com'), { method: 'POST' })));
  [row] = await rows('address = ?', 'ana@example.com');
  assert.equal(row.unsubscribed_at, null);
  assert.equal(row.kid_slug, 'max');
  assert.equal((await endpoint.onRequestPost(ctx(new Request(strangerLink, { method: 'POST' })))).status, 410, 'confirming one link clears the others');
});

test('unsubscribe: the link only asks; the button and one-click List-Unsubscribe stop it', async () => {
  const [row] = await rows('address = ?', 'ana@example.com');
  const page = await get(`/api/reminders?unsubscribe=${row.token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Stop reminders<\/button>/);
  assert.equal((await rows('address = ?', 'ana@example.com'))[0].unsubscribed_at, null, 'a GET changes nothing');

  // RFC 8058: the mail app's server POSTs List-Unsubscribe=One-Click, no Origin, no cookies
  const oneClick = await endpoint.onRequestPost(ctx(new Request(`${SITE}/api/reminders?unsubscribe=${row.token}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  })));
  assert.equal(oneClick.status, 200);
  assert.ok((await rows('address = ?', 'ana@example.com'))[0].unsubscribed_at);
  assert.match(await (await get(`/api/reminders?unsubscribe=${row.token}`)).text(), /off the list/);
  assert.equal((await get('/api/reminders?unsubscribe=nope')).status, 404);
});

// ─── Who may sign up ────────────────────────────────────────────────

test('sign-ups only from our own pages', async () => {
  const n = emails.length;
  for (const origin of ['https://evil.example', 'null', 'http://localhost:4321']) {
    const res = await post({ channel: 'email', email: 'victim@example.com' }, { origin });
    assert.equal(res.status, 403, origin);
  }
  const fetchSite = await endpoint.onRequestPost(ctx(new Request(`${SITE}/api/reminders`, { method: 'POST', headers: { 'content-type': 'application/json', 'Sec-Fetch-Site': 'cross-site', 'CF-Connecting-IP': freshIp() }, body: JSON.stringify({ channel: 'email', email: 'victim@example.com' }) })));
  assert.equal(fetchSite.status, 403);
  assert.equal(emails.length, n, 'nothing sent');
  // A preview deployment's own origin, and localhost talking to localhost, are fine
  assert.equal((await post({ channel: 'email', email: 'p1@example.com' }, { origin: 'https://abc123.soard-site.pages.dev', url: 'https://abc123.soard-site.pages.dev/api/reminders' })).status, 200);
  assert.equal((await post({ channel: 'email', email: 'p2@example.com' }, { origin: 'http://localhost:4321', url: 'http://localhost:8788/api/reminders' })).status, 200);
});

test('limits: three links a day per address, ten sign-ups an hour per caller', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await post({ channel: 'email', email: 'busy@example.com' })).status, 200);
  const fourth = await post({ channel: 'email', email: 'busy@example.com' });
  assert.equal(fourth.status, 429);
  assert.match((await fourth.json()).error, /already sent this address/);
  assert.ok(Number(fourth.headers.get('Retry-After')) > 0);
  const limits = (await DB.prepare(`SELECT key FROM rate_limits WHERE key LIKE 'reminders:to:%'`).all()).results;
  assert.ok(limits.every(r => !r.key.includes('@')), 'the limits table never holds an address');

  const ip = '203.0.113.50';
  for (let i = 0; i < 10; i++) assert.equal((await post({ channel: 'email', email: `fan${i}@example.com` }, { ip })).status, 200);
  assert.equal((await post({ channel: 'email', email: 'fan10@example.com' }, { ip })).status, 429);
});

test('Turnstile: required whenever its keys are set', async () => {
  const off = await (await get('/api/reminders?config=1')).json();
  assert.equal(off.turnstile, null);
  assert.equal((await get('/api/reminders?check=1')).status, 204);

  env.TURNSTILE_SECRET_KEY = 'secret';
  try {
    const on = await (await get('/api/reminders?config=1')).json();
    assert.equal(on.turnstile, '0x4AAAAAACpMJDcIPz2DI536');
    const frame = await get('/api/reminders?check=1');
    const csp = frame.headers.get('Content-Security-Policy');
    const nonce = csp.match(/'nonce-([\w-]+)'/)[1];
    assert.match(csp, /script-src 'nonce-[\w-]+' https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /frame-ancestors 'self'/);
    const html = await frame.text();
    assert.equal((html.match(new RegExp(`nonce="${nonce}"`, 'g')) || []).length, 2, 'both scripts carry the nonce');
    assert.match(html, /postMessage\(.*location\.origin\)/);

    const missing = await post({ channel: 'email', email: 'robot@example.com' });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).code, 'turnstile');
    assert.equal((await post({ channel: 'email', email: 'robot@example.com', turnstileToken: 'forged' })).status, 403);
    assert.equal((await post({ channel: 'email', email: 'human@example.com', turnstileToken: 'good-token' })).status, 200);
  } finally {
    delete env.TURNSTILE_SECRET_KEY;
  }
});

test('the honeypot looks like success and stores nothing', async () => {
  const before = (await DB.prepare('SELECT COUNT(*) AS n FROM broadcast_reminder_pending').first()).n;
  const res = await post({ channel: 'email', email: 'bot@example.com', hp: 'filled' });
  assert.deepEqual(await res.json(), { ok: true, channel: 'email', pending: true });
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM broadcast_reminder_pending').first()).n, before);
});

// ─── Text: a code typed back ────────────────────────────────────────

test('texts: international numbers are refused before anything is sent', async () => {
  const n = texts.length;
  for (const phone of ['+44 7700 900123', '+1 876 555 0123', '800-555-0123']) {
    const res = await post({ channel: 'sms', phone });
    assert.equal(res.status, 400, phone);
  }
  assert.equal(texts.length, n);
});

test('texts: a 6-digit code, five tries, then the number is on the list with a welcome text', async () => {
  const phone = '(404) 555-0142';
  const res = await post({ channel: 'sms', phone, kidSlug: 'remi' });
  assert.deepEqual(await res.json(), { ok: true, channel: 'sms', pending: true, codeSent: true, expiresIn: 600 });
  const code = codeFor('+14045550142');
  assert.match(code, /^\d{6}$/);
  assert.equal((await rows(`channel = 'sms'`)).length, 0, 'not on the list yet');
  const p = await DB.prepare(`SELECT secret_hash FROM broadcast_reminder_pending WHERE channel = 'sms'`).first();
  assert.ok(!p.secret_hash.includes(code), 'the code is stored hashed');

  const wrong = code === '000000' ? '111111' : '000000';
  const r1 = await post({ channel: 'sms', phone, code: wrong });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error, /4 tries left/);
  const ok = await post({ channel: 'sms', phone, code });
  assert.deepEqual(await ok.json(), { ok: true, channel: 'sms', confirmed: true });
  await flush();
  const [row] = await rows(`channel = 'sms'`);
  assert.equal(row.address, '+14045550142');
  assert.equal(row.kid_slug, 'remi');
  assert.match(texts.at(-1).body, /signed up for reveal reminder texts.*STOP to opt out/);
  assert.equal((await post({ channel: 'sms', phone, code })).status, 410, 'a used code is gone');
});

test('texts: five wrong tries end a code; codes expire in 10 minutes', async () => {
  const phone = '404-555-0177';
  await post({ channel: 'sms', phone });
  const code = codeFor('+14045550177');
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal((await post({ channel: 'sms', phone, code: wrong })).status, 400);
  const last = await post({ channel: 'sms', phone, code: wrong });
  assert.equal(last.status, 410);
  assert.match((await last.json()).error, /last try/);
  assert.equal((await post({ channel: 'sms', phone, code })).status, 410, 'even the right code is dead now');

  await post({ channel: 'sms', phone });
  const fresh = codeFor('+14045550177');
  travel(10 * 60e3 + 1000);
  assert.equal((await post({ channel: 'sms', phone, code: fresh })).status, 410);
  assert.equal((await rows('address = ?', '+14045550177')).length, 0);
});

test('texts: three codes a day per number, five per caller, and a site-wide daily cap that tells staff once', async () => {
  travel(24 * 3600e3 + 1000); // a new day for every limit
  const phone = '404-555-0188';
  for (let i = 0; i < 3; i++) assert.equal((await post({ channel: 'sms', phone })).status, 200);
  assert.equal((await post({ channel: 'sms', phone })).status, 429);

  const ip = '203.0.113.77';
  for (let i = 0; i < 5; i++) assert.equal((await post({ channel: 'sms', phone: `404-555-02${10 + i}` }, { ip })).status, 200);
  const sixth = await post({ channel: 'sms', phone: '404-555-0299' }, { ip });
  assert.equal(sixth.status, 429);

  const cap = endpoint.LIMITS.smsPerDay;
  const used = (await DB.prepare(`SELECT count FROM rate_limits WHERE key LIKE 'reminders:sms-day:%' ORDER BY reset_at DESC LIMIT 1`).first()).count;
  endpoint.LIMITS.smsPerDay = used + 1;
  try {
    assert.equal((await post({ channel: 'sms', phone: '404-555-0301' })).status, 200);
    const sent = texts.length;
    const paused = await post({ channel: 'sms', phone: '404-555-0302' });
    assert.equal(paused.status, 503);
    assert.equal((await paused.json()).code, 'sms-paused');
    assert.equal((await post({ channel: 'sms', phone: '404-555-0303' })).status, 503);
    await flush();
    assert.equal(texts.length, sent, 'no codes past the cap');
    const alerts = slackPosts.filter(p => /Text sign-ups paused/.test(JSON.stringify(p)));
    assert.equal(alerts.length, 1, 'staff hear about it once');
  } finally {
    endpoint.LIMITS.smsPerDay = cap;
  }
});

test('texts: a number that replied STOP is told how to start again', async () => {
  travel(24 * 3600e3 + 1000);
  sim.twilioStop.add('+14045550444');
  const res = await post({ channel: 'sms', phone: '404-555-0444' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Text START to \(888\) 555-0100/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM broadcast_reminder_pending WHERE address = '+14045550444'`).first()).n, 0);
});

// ─── Push ───────────────────────────────────────────────────────────

test('push: only browser push services, and only when push is on', async () => {
  const cfg = await b.readConfig(DB);
  await b.writeConfig(DB, { ...cfg, vapid: await notify.generateVapidKeys() });
  const keys = { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) };
  const bad = await post({ channel: 'push', subscription: { endpoint: 'https://attacker.example/collect', keys } });
  assert.equal(bad.status, 400);
  const okRes = await post({ channel: 'push', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }, kidSlug: 'remi' });
  assert.deepEqual(await okRes.json(), { ok: true, channel: 'push' });
  assert.equal((await rows(`channel = 'push'`)).length, 1);
});

// ─── The send: batches, one-click unsubscribe, never twice ──────────

async function confirmEmails(list) {
  for (const email of list) {
    const row = { channel: 'email', address: email, kid_slug: null, source: 'test' };
    await endpoint.activate(DB, row);
  }
}

test('reminder emails carry one-click List-Unsubscribe headers', async () => {
  await confirmEmails(['one@example.com']);
  const cfg = await b.readConfig(DB);
  const state = { ...(await b.readState(DB)), broadcastId: 'bc-headers', phase: 'scheduled', kidSlug: 'remi', kidName: 'Remi', scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString() };
  emails.length = 0;
  await b.sendReminders(env, { ...cfg, reminders: { ...cfg.reminders, sms: false, push: false } }, state, 'day', []);
  const mail = emails.find(e => e.to[0] === 'one@example.com');
  const [row] = await rows('address = ?', 'one@example.com');
  const url = `${SITE}/api/reminders?unsubscribe=${encodeURIComponent(row.token)}`;
  assert.equal(mail.headers['List-Unsubscribe'], `<${url}>`);
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(mail.html.includes(url.replace(/&/g, '&amp;')));
});

test('a long list goes out in batches across ticks, each person once, without holding up the tick', async () => {
  const list = Array.from({ length: 330 }, (_, i) => `bulk${String(i).padStart(3, '0')}@example.com`);
  await confirmEmails(list);
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, sms: false, push: false } };
  const at = new Date(Date.now() + 20 * 3600e3).toISOString();
  await b.writeConfig(DB, config);
  await b.writeState(DB, { ...(await b.readState(DB)), broadcastId: 'bc-bulk', phase: 'scheduled', kidSlug: null, kidName: null, scheduledAt: at, test: false, source: null });
  const state = await b.readState(DB);
  emails.length = 0;

  // The first call has no time to spare: one batch, and the run stays open
  const work = [];
  const first = await b.sendReminders(env, config, state, 'day', work, { budgetMs: 0 });
  assert.equal(first.email.recipients, 100);
  assert.ok(work.includes('email:day:continues'), work.join(','));
  const run = await DB.prepare(`SELECT * FROM broadcast_reminder_runs WHERE broadcast_id = 'bc-bulk' AND kind = 'day' AND channel = 'email'`).first();
  assert.equal(run.finished_at, null);

  // Two ticks at once split what's left between them
  await Promise.all([
    b.sendReminders(env, config, state, 'day', [], { budgetMs: 0 }),
    b.sendReminders(env, config, state, 'day', [], { budgetMs: 0 }),
  ]);
  // The scheduler's next tick carries on by itself
  travel(5000);
  const tick = await b.runTick(env, { source: 'test', force: true });
  assert.ok(tick.work.some(w => w.startsWith('email:day:')), tick.work.join(','));

  const to = emails.map(e => e.to[0]);
  const everyone = (await rows(`channel = 'email' AND unsubscribed_at IS NULL`)).map(r => r.address);
  assert.equal(new Set(to).size, to.length, 'nobody got it twice');
  assert.deepEqual([...new Set(to)].sort(), everyone.sort(), 'everyone got it');
  const sends = await DB.prepare(`SELECT * FROM broadcast_sends WHERE broadcast_id = 'bc-bulk' AND kind = 'day' AND channel = 'email'`).first();
  assert.equal(sends.recipients, everyone.length);
  assert.equal(sends.sent, everyone.length);
  assert.ok((await DB.prepare(`SELECT finished_at FROM broadcast_reminder_runs WHERE broadcast_id = 'bc-bulk' AND kind = 'day'`).first()).finished_at);

  const again = await b.runTick(env, { source: 'test', force: true });
  assert.ok(!again.work.some(w => w.startsWith('email:day')), 'done is done');
});

test('a date moved in the middle of a send waits for its new window', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, sms: false, push: false } };
  await b.writeState(DB, { ...(await b.readState(DB)), broadcastId: 'bc-midmove', phase: 'scheduled', kidSlug: null, scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString(), test: false });
  const state = await b.readState(DB);
  emails.length = 0;
  await b.sendReminders(env, config, state, 'day', [], { budgetMs: 0 });
  const sentBefore = emails.length;
  assert.equal(sentBefore, 100, 'one batch went out, the rest wait');
  // What the admin's "moved to another day" does: un-claim day and hour, then the new date
  await DB.prepare(`DELETE FROM broadcast_sends WHERE broadcast_id = 'bc-midmove' AND kind IN ('moved', 'day', 'hour')`).run();
  await b.writeState(DB, { ...state, scheduledAt: new Date(Date.now() + 5 * 24 * 3600e3).toISOString() });
  travel(5000);
  await b.runTick(env, { source: 'test', force: true });
  assert.equal(emails.length, sentBefore, 'no "tomorrow" email for a reveal next week');
});

test('a batch left over once its news is old is dropped, not sent late', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, sms: false, push: false } };
  const live = { ...(await b.readState(DB)), broadcastId: 'bc-old-news', phase: 'live', kidSlug: null };
  await b.sendReminders(env, config, live, 'live', [], { budgetMs: 0 });
  emails.length = 0;
  const work = [];
  await b.sendReminders(env, config, { ...live, phase: 'replay' }, 'live', work, { budgetMs: 0 });
  assert.equal(emails.length, 0, "no \"we're live\" after it ended");
  assert.ok((await DB.prepare(`SELECT finished_at FROM broadcast_reminder_runs WHERE broadcast_id = 'bc-old-news' AND kind = 'live'`).first()).finished_at);
});

test('a moved date sends the day-before reminder again', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, sms: false, push: false } };
  const state = { ...(await b.readState(DB)), broadcastId: 'bc-moved', phase: 'scheduled', kidSlug: null };
  await b.sendReminders(env, config, state, 'day', []);
  const firstCount = (await DB.prepare(`SELECT sent FROM broadcast_sends WHERE broadcast_id = 'bc-moved' AND kind = 'day'`).first()).sent;
  assert.ok(firstCount > 200);
  // What the admin's "moved to another day" does
  await DB.prepare(`DELETE FROM broadcast_sends WHERE broadcast_id = 'bc-moved' AND kind IN ('moved', 'day', 'hour')`).run();
  emails.length = 0;
  await b.sendReminders(env, config, state, 'day', []);
  assert.equal(emails.length, firstCount, 'everyone hears the new date');
});

test('push sends skip and drop a stored endpoint that is not a push service', async () => {
  await DB.prepare(`INSERT INTO broadcast_reminders (id, channel, address, subscription, kid_slug, token, source, created_at, fails) VALUES ('old-push', 'push', 'https://attacker.example/x', ?, NULL, 'tok-old', 'push', ?, 0)`)
    .bind(JSON.stringify({ endpoint: 'https://attacker.example/x', keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } }), new Date().toISOString()).run();
  const cfg = await b.readConfig(DB);
  const calls = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => { calls.push(typeof input === 'string' ? input : input.url); return inner(input, init); };
  try {
    const state = { ...(await b.readState(DB)), broadcastId: 'bc-push', phase: 'live', kidSlug: null };
    await b.sendReminders(env, { ...cfg, reminders: { ...cfg.reminders, enabled: true, sms: false, push: true } }, state, 'live', []);
  } finally {
    globalThis.fetch = inner;
  }
  assert.ok(!calls.some(u => u.startsWith('https://attacker.example')), 'never POSTs to it');
  assert.ok((await rows(`id = 'old-push'`))[0].unsubscribed_at, 'and drops it');
});
