/**
 * Reveal reminders: one-press sign-ups (a link only after a Stop) that go into Kit with their tags, text
 * codes, push hosts, unsubscribe (off in Kit too), limits, and every reminder email one Kit email
 * Run: node --test tests/reminder-signups.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeKitTags } from './lib/fake-kit-tags.mjs';

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };

// ─── Fake network: Resend, Twilio, Turnstile, Slack ─────────────────
const emails = [];   // every message Resend was asked to send
const texts = [];    // { to, body }
const slackPosts = [];
const sim = { twilioStop: new Set(), turnstileOk: 'good-token', kitDown: false };
// A pretend Kit: subscribers by address, their tags, broadcasts made, and Kit's own confirm emails
const kit = { subs: new Map(), posts: [], confirms: [], nextId: 1000 };
// SOARD's Kit has always had the applications waitlist's tags
const kitTags = fakeKitTags({ idOf: (email) => kit.subs.get(email)?.id, tags: [{ id: 24835326, name: 'Application Waitlist only (no newsletter)' }, { id: 23000001, name: 'Application Waitlist' }] });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.kit.com/v4/')) {
    if (sim.kitDown) return Response.json({ errors: ['Kit is down'] }, { status: 503 });
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body && typeof init.body === 'string' && init.body !== '{}' ? JSON.parse(init.body) : null;
    const path = url.replace('https://api.kit.com/v4', '');
    const tagged = await kitTags.answer(url, method, body);
    if (tagged) return tagged;
    if (path === '/subscribers' && method === 'POST') {
      const had = kit.subs.get(body.email_address);
      if (had) return Response.json({ subscriber: had }, { status: 200 });
      const sub = { id: kit.nextId++, email_address: body.email_address, state: 'active' };
      kit.subs.set(body.email_address, sub);
      return Response.json({ subscriber: sub }, { status: 201 });
    }
    if (path.startsWith('/subscribers?') && method === 'GET') {
      const want = new URL(url).searchParams.get('email_address').split(',');
      return Response.json({ subscribers: want.map((e) => kit.subs.get(e)).filter(Boolean) });
    }
    let m = path.match(/^\/subscribers\/(\d+)\/unsubscribe$/);
    if (m) { for (const sub of kit.subs.values()) if (sub.id === Number(m[1])) sub.state = 'cancelled'; return Response.json({}); }
    m = path.match(/^\/forms\/\w+\/subscribers$/);
    if (m) { kit.confirms.push(body.email_address); return Response.json({ subscriber: kit.subs.get(body.email_address) || {} }, { status: 201 }); }
    if (path === '/broadcasts' && method === 'POST') { kit.posts.push(body); return Response.json({ broadcast: { id: 9000 + kit.posts.length } }, { status: 201 }); }
    // Every broadcast, any state, by description (how a send whose answer was lost is found)
    if (path.startsWith('/broadcasts?') && method === 'GET') return Response.json({ broadcasts: kit.posts.map((p, i) => ({ id: 9001 + i, description: p.description, send_at: p.send_at })) });
    return Response.json({ errors: [`unexpected ${method} ${path}`] }, { status: 500 });
  }
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
  const m = [...emails].reverse().find(e => e.to[0] === to && /\?confirm=/.test(e.text));
  return m && m.text.match(/https:\/\/sunshineonaranneyday\.com\/api\/reminders\?confirm=[\w-]+/)[0];
};
/** The names of the tags Kit has on an address */
const kitTagsOf = (email) => {
  const id = kit.subs.get(email)?.id;
  return kitTags.list.filter((t) => kitTags.members.get(Number(t.id))?.has(id)).map((t) => t.name).sort();
};
/** Press Stop on an address's row (the stop page's button) */
const stop = async (address) => {
  const [row] = await rows('address = ?', address);
  await endpoint.onRequestPost(ctx(new Request(`${SITE}/api/reminders?unsubscribe=${row.token}`, { method: 'POST' })));
};

before(async () => {
  DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare(`INSERT INTO kids (slug, data, name, year, status) VALUES (?, ?, ?, ?, ?)`).bind('remi', JSON.stringify({ name: 'Remi', slug: 'remi' }), 'Remi', 2026, 'in-progress').run();
  await DB.prepare(`INSERT INTO kids (slug, data, name, year, status) VALUES (?, ?, ?, ?, ?)`).bind('max', JSON.stringify({ name: 'Max', slug: 'max' }), 'Max', 2026, 'in-progress').run();
  env = {
    DB, RESEND_API_KEY: 're_test', KIT_API_KEY: 'kit_test',
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

// ─── Email: one press and you're on the list ────────────────────────

test('one press puts a new address on the list, and it gets a "You’re on the list" email with a one-tap Stop', async () => {
  const res = await post({ channel: 'email', email: 'Ana@Example.com', kidSlug: 'remi' });
  assert.deepEqual(await res.json(), { ok: true, channel: 'email' });
  await flush();
  const [row] = await rows();
  assert.equal(row.address, 'ana@example.com');
  assert.equal(row.kid_slug, 'remi');
  assert.equal(row.unsubscribed_at, null);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM broadcast_reminder_pending').first()).n, 0, 'nothing waits on a link');
  const mail = emails.at(-1);
  assert.equal(mail.to[0], 'ana@example.com');
  assert.match(mail.subject, /You’re on the list for Remi’s reveal/);
  assert.doesNotMatch(mail.text, /\?confirm=/, 'nothing to confirm');
  assert.ok(mail.text.includes(`/api/reminders?unsubscribe=${row.token}`), 'its Stop link is her own');
  assert.equal(mail.headers['List-Unsubscribe'], `<${SITE}/api/reminders?unsubscribe=${row.token}>`);
  assert.match(mail.text, /\/live\/remi\//, 'it links to Remi’s live page');
  const ev = await DB.prepare(`SELECT COUNT(*) AS n FROM broadcast_events WHERE type = 'reminder_signup'`).first();
  assert.equal(ev.n, 1, 'counted once');
  // In Kit at once: new to Kit and here for Remi's reveal, so reveal emails only, and Remi's only
  assert.equal(kit.subs.get('ana@example.com')?.state, 'active');
  assert.deepEqual(kitTagsOf('ana@example.com'), ['Reveal sign-ups for one reveal only', 'Reveal sign-ups only (no newsletter)', 'Reveal sign-ups: remi']);
  assert.equal(kit.confirms.length, 0, 'Kit isn’t asked to confirm anyone new');

  // Pressing again: still on, no second email, not counted again
  const n = emails.length;
  assert.deepEqual(await (await post({ channel: 'email', email: 'ana@example.com', kidSlug: 'remi' })).json(), { ok: true, channel: 'email' });
  await flush();
  assert.equal(emails.length, n);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM broadcast_events WHERE type = 'reminder_signup'`).first()).n, 1);
});

test('a sign-up form never undoes a Stop: only the address’s own tap on the emailed link does, and opening the link only asks', async () => {
  // Ana is on for Remi. Someone asks for another reveal at her address: she hears about every reveal, never fewer
  await post({ channel: 'email', email: 'ana@example.com', kidSlug: 'nobody-real' });
  let [row] = await rows('address = ?', 'ana@example.com');
  assert.equal(row.kid_slug, null, 'widened to every reveal, not narrowed');
  await flush();
  assert.deepEqual(kitTagsOf('ana@example.com'), ['Reveal sign-ups', 'Reveal sign-ups only (no newsletter)'], 'in Kit: every reveal now, and still no newsletter');

  // She presses Stop: off in Kit too, and since she was only there for reveal emails, unsubscribed there
  await stop('ana@example.com');
  assert.deepEqual(kitTagsOf('ana@example.com'), ['Reveal sign-ups only (no newsletter)']);
  assert.equal(kit.subs.get('ana@example.com').state, 'cancelled');
  // A new sign-up doesn't put her back, it emails her the link
  const res = await post({ channel: 'email', email: 'ana@example.com', kidSlug: 'max' });
  assert.deepEqual(await res.json(), { ok: true, channel: 'email', pending: true });
  [row] = await rows('address = ?', 'ana@example.com');
  assert.ok(row.unsubscribed_at, 'still stopped');
  const link = confirmLink('ana@example.com');
  assert.match(emails.at(-1).subject, /Confirm your reminders for Max’s reveal/);
  const tokenInLink = link.split('confirm=')[1];
  const stored = (await DB.prepare('SELECT * FROM broadcast_reminder_pending WHERE address = ?').bind('ana@example.com').all()).results;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].secret_hash, await notify.sha256Hex(tokenInLink), 'the token is stored hashed');

  // A mail scanner opening the link changes nothing
  const page = await get(link.replace(SITE, ''));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Yes, remind me/);
  assert.match(html, /<strong><!--email_off-->ana@example\.com<!--\/email_off--><\/strong>/, 'Cloudflare leaves it alone: this page has no script to restore a hidden address');
  assert.match(html, /<form method="post" action="\/api\/reminders\?confirm=/);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('Referrer-Policy'), 'strict-origin');
  assert.ok((await rows('address = ?', 'ana@example.com'))[0].unsubscribed_at);

  // Her button: back on, for the reveal the link named. Kit has her as unsubscribed (her Stop did that), so the page
  // says Kit's own email is the last tap, not "you're on the list"
  const done = await endpoint.onRequestPost(ctx(new Request(link, { method: 'POST', headers: { Origin: SITE } })));
  assert.equal(done.status, 200);
  assert.match(await done.text(), /One more tap[\s\S]*Tap Confirm in it/);
  await flush();
  [row] = await rows('address = ?', 'ana@example.com');
  assert.equal(row.unsubscribed_at, null);
  assert.equal(row.kid_slug, 'max');
  // Kit has her as unsubscribed: the site never puts her back itself; Kit emails her its own confirmation
  assert.deepEqual(kit.confirms, ['ana@example.com']);
  assert.ok(kitTagsOf('ana@example.com').includes('Reveal sign-ups: max'));
  kit.subs.get('ana@example.com').state = 'active'; // she taps Kit's button
  assert.equal((await endpoint.onRequestPost(ctx(new Request(link, { method: 'POST' })))).status, 410, 'a link already used is spent');
});

test('confirm links expire after 3 days', async () => {
  await post({ channel: 'email', email: 'late@example.com' });
  await stop('late@example.com');
  await post({ channel: 'email', email: 'late@example.com' });
  const link = confirmLink('late@example.com');
  travel(3 * 24 * 3600e3 + 60e3);
  assert.equal((await get(link.replace(SITE, ''))).status, 410);
  assert.equal((await endpoint.onRequestPost(ctx(new Request(link, { method: 'POST' })))).status, 410);
  assert.ok((await rows('address = ?', 'late@example.com'))[0].unsubscribed_at, 'still stopped');
});

test('signing up for a second reveal keeps the first: the address goes on for every reveal', async () => {
  const signUp = async (email, kidSlug) => {
    await post({ channel: 'email', email, kidSlug });
    return (await rows('address = ?', email))[0];
  };
  let row = await signUp('two@example.com', 'remi');
  assert.equal(row.kid_slug, 'remi');
  row = await signUp('two@example.com', 'remi');
  assert.equal(row.kid_slug, 'remi', 'the same reveal again changes nothing');
  row = await signUp('two@example.com', 'max');
  assert.equal(row.kid_slug, null, 'a different reveal must not cancel the first one\'s reminders');
  row = await signUp('two@example.com', 'remi');
  assert.equal(row.kid_slug, null, 'every reveal stays every reveal');
});

test('after a Stop, two sign-ups before either is tapped: tapping both links covers both reveals', async () => {
  await post({ channel: 'email', email: 'both@example.com', kidSlug: 'remi' });
  await stop('both@example.com');
  await post({ channel: 'email', email: 'both@example.com', kidSlug: 'remi' });
  const first = confirmLink('both@example.com');
  await post({ channel: 'email', email: 'both@example.com', kidSlug: 'max' });
  const second = confirmLink('both@example.com');
  assert.notEqual(first, second);
  assert.equal((await endpoint.onRequestPost(ctx(new Request(first, { method: 'POST' })))).status, 200);
  assert.equal((await rows('address = ?', 'both@example.com'))[0].kid_slug, 'remi');
  assert.equal((await endpoint.onRequestPost(ctx(new Request(second, { method: 'POST' })))).status, 200, 'the second link still works');
  assert.equal((await rows('address = ?', 'both@example.com'))[0].kid_slug, null, 'both reveals, so every reveal');
  assert.equal((await endpoint.onRequestPost(ctx(new Request(second, { method: 'POST' })))).status, 410, 'a second tap says it was used');
});

test('the confirm pages say what the person really ends up on', async () => {
  const text = async (res) => (await res.text()).replace(/<[^>]+>/g, ' ');
  // Stopped, then asks for Max: just Max, before and after the tap
  await post({ channel: 'email', email: 'one@example.com', kidSlug: 'max' });
  await stop('one@example.com');
  await post({ channel: 'email', email: 'one@example.com', kidSlug: 'max' });
  const link = confirmLink('one@example.com');
  assert.match(await text(await endpoint.onRequestGet(ctx(new Request(link)))), /about Max.+room reveal/);
  assert.match(await text(await endpoint.onRequestPost(ctx(new Request(link, { method: 'POST' })))), /about Max.+room reveal/);
  // Back on for Max, a link for Remi (sent while stopped) widens it: the page says every reveal
  await stop('one@example.com');
  await post({ channel: 'email', email: 'one@example.com', kidSlug: 'remi' });
  const remi = confirmLink('one@example.com');
  await DB.prepare("UPDATE broadcast_reminders SET unsubscribed_at = NULL WHERE address = 'one@example.com'").run();
  assert.match(await text(await endpoint.onRequestGet(ctx(new Request(remi)))), /about every reveal/);
  assert.match(await text(await endpoint.onRequestPost(ctx(new Request(remi, { method: 'POST' })))), /about every reveal/);
  await DB.prepare("DELETE FROM broadcast_reminders WHERE address = 'one@example.com'").run();
});

test('the confirm page\'s promise follows Settings, and reminders switched off stop a link already sent', async () => {
  const text = async (res) => (await res.text()).replace(/<[^>]+>/g, ' ');
  const config = await b.readConfig(DB);
  await post({ channel: 'email', email: 'notes@example.com', kidSlug: 'max' });
  await stop('notes@example.com');
  await post({ channel: 'email', email: 'notes@example.com', kidSlug: 'max' });
  const link = confirmLink('notes@example.com');
  await b.writeConfig(DB, { ...config, reminders: { ...config.reminders, hoursBefore: [] } });
  try {
    const shown = await text(await endpoint.onRequestGet(ctx(new Request(link))));
    assert.doesNotMatch(shown, /day before|hour before/);
    await b.writeConfig(DB, { ...config, reminders: { ...config.reminders, enabled: false } });
    const asked = await endpoint.onRequestGet(ctx(new Request(link)));
    assert.equal(asked.status, 503);
    assert.equal((await endpoint.onRequestPost(ctx(new Request(link, { method: 'POST' })))).status, 503);
    assert.ok((await rows('address = ?', 'notes@example.com'))[0].unsubscribed_at, 'nobody goes back on a list that sends nothing');
  } finally {
    await b.writeConfig(DB, config);
  }
  assert.equal((await endpoint.onRequestPost(ctx(new Request(link, { method: 'POST' })))).status, 200, 'the link works again once reminders are back');
  await DB.prepare("DELETE FROM broadcast_reminders WHERE address = 'notes@example.com'").run();
});

test('reminders switched off: nobody can sign up for emails that would never come', async () => {
  const config = await b.readConfig(DB);
  const before = (await rows()).length;
  await b.writeConfig(DB, { ...config, reminders: { ...config.reminders, enabled: false, hoursBefore: [] } });
  try {
    const res = await post({ channel: 'email', email: 'off@example.com', kidSlug: 'max' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).ok, false);
    assert.equal((await rows()).length, before);
    await flush();
    assert.equal(emails.filter((e) => e.to[0] === 'off@example.com').length, 0, 'no email either');
  } finally {
    await b.writeConfig(DB, config);
  }
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
  assert.ok(!kitTagsOf('ana@example.com').some((t) => /^Reveal sign-ups(:| for)/.test(t) || t === 'Reveal sign-ups'), 'her reveal tags are off in Kit');
  assert.equal(kit.subs.get('ana@example.com').state, 'cancelled', 'and Kit stops her too');
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

test('limits: three sign-up emails a day per address, ten sign-ups an hour per caller', async () => {
  // An address already on the list gets no email, so pressing again never runs into the limit
  for (let i = 0; i < 5; i++) assert.equal((await post({ channel: 'email', email: 'busy@example.com' })).status, 200);
  // The welcome was one email; after a Stop, two links make three, and a fourth is too many
  await stop('busy@example.com');
  for (let i = 0; i < 2; i++) assert.equal((await post({ channel: 'email', email: 'busy@example.com' })).status, 200);
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
    assert.equal((html.match(/<script/g) || []).length, (html.match(new RegExp(`<script nonce="${nonce}"`, 'g')) || []).length, 'every script carries the nonce');
    assert.match(html, /blocked: true/, 'a check that can\'t load says so');
    assert.match(html, /postMessage\(.*location\.origin\)/);
    // A light widget unless the form sits on a dark band; compact when the frame is narrower than the flexible one's 300px;
    // and the frame is told the widget's height, so neither size is cut off
    assert.match(html, /theme: 'light'/);
    assert.match(await (await get('/api/reminders?check=1&theme=dark')).text(), /theme: 'dark'/);
    assert.match(await (await get('/api/reminders?check=1&theme=%3Cscript%3E')).text(), /theme: 'light'/, 'anything else is light, never echoed');
    assert.match(html, /size: innerWidth < 300 \? 'compact' : 'flexible'/);
    assert.match(html, /up\(\{ h: box\.offsetHeight \}\)/);
    assert.ok(html.indexOf('up({ ready: true })') > -1 && html.indexOf('up({ ready: true })') < html.indexOf('challenges.cloudflare.com/turnstile'), 'the frame says it loaded before Cloudflare\'s script can fail');

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
  assert.deepEqual(await res.json(), { ok: true, channel: 'email' }, 'looks just like a real sign-up');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM broadcast_reminder_pending').first()).n, before);
  assert.equal((await rows('address = ?', 'bot@example.com')).length, 0);
});

// ─── Texts: never the public ────────────────────────────────────────

test('the public can never sign up for texts, whatever the settings say', async () => {
  const cfg = await b.readConfig(DB);
  await b.writeConfig(DB, { ...cfg, reminders: { ...cfg.reminders, sms: true } });
  try {
    const n = texts.length;
    for (const body of [{ channel: 'sms', phone: '(404) 555-0142' }, { channel: 'sms', phone: '(404) 555-0142', code: '123456' }]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    await flush();
    assert.equal(texts.length, n, 'nothing texted');
    assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM broadcast_reminder_pending WHERE channel = 'sms'`).first()).n, 0);
  } finally {
    await b.writeConfig(DB, cfg);
  }
});

test('reminders never text, even a phone row left in the table', async () => {
  await DB.prepare(`INSERT INTO broadcast_reminders (id, channel, address, token, created_at, fails) VALUES ('old-sms', 'sms', '+14045550142', 'tok-sms', ?, 0)`).bind(new Date().toISOString()).run();
  const cfg = await b.readConfig(DB);
  const state = { ...(await b.readState(DB)), broadcastId: 'bc-no-texts', phase: 'scheduled', kidSlug: 'remi', kidName: 'Remi', scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString() };
  const n = texts.length;
  const summary = await b.sendReminders(env, { ...cfg, reminders: { ...cfg.reminders, enabled: true, sms: true, push: false } }, state, 'day', []);
  assert.equal(texts.length, n, 'nothing texted');
  assert.ok(!('sms' in summary), JSON.stringify(summary));
  await DB.prepare(`DELETE FROM broadcast_reminders WHERE id = 'old-sms'`).run();
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

// ─── The send: one Kit email to everyone who signed up ─────────────

async function confirmEmails(list) {
  for (const email of list) {
    const row = { channel: 'email', address: email, kid_slug: null, source: 'test' };
    await endpoint.activate(DB, row);
  }
}

test('a reminder is one Kit email to the sign-ups, however many: never one each from Resend, and never twice', async () => {
  const list = Array.from({ length: 330 }, (_, i) => `bulk${String(i).padStart(3, '0')}@example.com`);
  await confirmEmails(list);
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, push: false } };
  await b.writeConfig(DB, config);
  await b.writeState(DB, { ...(await b.readState(DB)), broadcastId: 'bc-bulk', phase: 'scheduled', kidSlug: 'remi', kidName: 'Remi', scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString(), test: false, source: null });
  const state = await b.readState(DB);
  emails.length = 0;
  const posts = kit.posts.length;
  const work = [];
  await b.sendReminders(env, config, state, 'day', work);
  const made = kit.posts.slice(posts);
  assert.equal(made.length, 1, 'one email in Kit');
  const k = made[0];
  assert.match(k.subject, /Tomorrow: Remi’s room reveal, live/);
  assert.ok(Date.parse(k.send_at) > Date.now(), 'sent by Kit a moment from now');
  assert.deepEqual(k.subscriber_filter, [{ all: null, any: [{ type: 'tag', ids: [kitTags.byName('Reveal sign-ups').id, kitTags.byName('Reveal sign-ups: remi').id] }], none: null }], 'every-reveal sign-ups and Remi’s own');
  assert.match(k.content, /\{\{ unsubscribe_url \}\}/, 'Kit’s own unsubscribe link');
  assert.match(k.content, /You asked us to email you about live room reveals/);
  assert.equal(emails.length, 0, 'nothing from Resend');
  assert.ok(work.includes('kit-signups:day'), work.join(','));
  const sends = await DB.prepare(`SELECT * FROM broadcast_sends WHERE broadcast_id = 'bc-bulk' AND kind = 'day' AND channel = 'kit-signups'`).first();
  assert.equal(sends.sent, 1);
  // Again, or on the next ticks: done is done
  await b.sendReminders(env, config, state, 'day', []);
  travel(5000);
  await b.runTick(env, { source: 'test', force: true });
  assert.equal(kit.posts.slice(posts).filter((p) => /day · reveal sign-ups · /.test(p.description)).length, 1, 'never twice');
});

test('what each sign-up gets from Kit: the date only to one-reveal-only people (the whole-list invite covers the rest), and the day before, hour before, "we\'re live" and replay to everyone signed up for the kid', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, push: false } };
  const base = { ...(await b.readState(DB)), kidSlug: 'max', kidName: 'Max', scheduledAt: new Date(Date.now() + 3 * 24 * 3600e3).toISOString(), test: false };
  let seq = 0;
  const made = async (kind, phase, extra = {}) => {
    const n = kit.posts.length;
    await b.sendReminders(env, config, { ...base, broadcastId: `bc-aim-${kind}-${++seq}`, phase, ...extra }, kind, []);
    return kit.posts.slice(n);
  };
  const ids = (p) => p.subscriber_filter[0].any[0].ids.slice().sort();
  // Nobody has signed up for this kid alone: the date goes only through the whole-list invite
  assert.equal((await made('scheduled', 'scheduled', { kidSlug: 'nobody-alone', kidName: 'Lee' })).length, 0);
  const lee = await made('live', 'live', { kidSlug: 'nobody-alone', kidName: 'Lee', source: 'stream', liveAt: new Date().toISOString() });
  assert.deepEqual(ids(lee[0]), [kitTags.byName('Reveal sign-ups').id], '"we\'re live" still reaches every-reveal sign-ups at once');
  // Someone new signs up for Max alone
  await post({ channel: 'email', email: 'maxfan@example.com', kidSlug: 'max' });
  await flush();
  const one = [{ all: [{ type: 'tag', ids: [kitTags.byName('Reveal sign-ups: max').id] }, { type: 'tag', ids: [kitTags.byName('Reveal sign-ups for one reveal only').id] }], any: null, none: null }];
  const date = await made('scheduled', 'scheduled');
  assert.equal(date.length, 1);
  assert.deepEqual(date[0].subscriber_filter, one, 'the date: just Max’s one-reveal-only sign-ups');
  assert.match(date[0].content, /We’ll email you again the day before and an hour before/, 'it says what comes next, never "sign up"');
  const everyone = [kitTags.byName('Reveal sign-ups').id, kitTags.byName('Reveal sign-ups: max').id].sort();
  for (const [kind, phase, extra] of [['day', 'scheduled', {}], ['live', 'live', { source: 'stream', liveAt: new Date().toISOString() }], ['live', 'live', { source: 'stream', liveAt: new Date().toISOString(), kitLiveEmail: false }], ['replay', 'replay', {}]]) {
    const got = await made(kind, phase, extra);
    assert.deepEqual(ids(got[0]), everyone, `${kind}${extra.kitLiveEmail === false ? ' (list email off)' : ''}: everyone signed up for Max`);
  }
});

test('a date moved in the middle waits for its new window, and a moved date sends the day-before again', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, push: false } };
  await b.writeState(DB, { ...(await b.readState(DB)), broadcastId: 'bc-midmove', phase: 'scheduled', kidSlug: null, kidName: null, scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString(), test: false });
  const state = await b.readState(DB);
  const n = kit.posts.length;
  await b.sendReminders(env, config, state, 'day', []);
  assert.equal(kit.posts.length, n + 1);
  // What "moved to another day" does: un-claim day and hour, then the new date
  await DB.prepare(`DELETE FROM broadcast_sends WHERE broadcast_id = 'bc-midmove' AND kind IN ('moved', 'day', 'hour')`).run();
  await b.writeState(DB, { ...state, scheduledAt: new Date(Date.now() + 5 * 24 * 3600e3).toISOString() });
  travel(5000);
  await b.runTick(env, { source: 'test', force: true });
  assert.equal(kit.posts.filter((p) => /day · reveal sign-ups · /.test(p.description)).length, kit.posts.slice(0, n + 1).filter((p) => /day · reveal sign-ups · /.test(p.description)).length, 'no "tomorrow" email for a reveal next week');
  // Moved to tomorrow instead: the day-before goes again
  await b.writeState(DB, { ...state, scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString() });
  await b.sendReminders(env, config, await b.readState(DB), 'day', []);
  assert.equal(kit.posts.slice(n + 1).filter((p) => /day · reveal sign-ups · /.test(p.description)).length, 1, 'everyone hears the new date');
});

test('old news is never sent late, and a Kit that won\'t take it is tried again, with staff told once', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, push: false } };
  const live = { ...(await b.readState(DB)), broadcastId: 'bc-old-news', phase: 'replay', kidSlug: null, test: false };
  const n = kit.posts.length;
  await b.sendReminders(env, config, live, 'live', []);
  assert.equal(kit.posts.length, n, "no \"we're live\" after it ended");

  const due = { ...live, broadcastId: 'bc-kit-down', phase: 'scheduled', scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString() };
  sim.kitDown = true;
  const slack = slackPosts.length;
  const work = [];
  try {
    await b.sendReminders(env, config, due, 'day', work);
    await b.sendReminders(env, config, due, 'day', []);
  } finally { sim.kitDown = false; }
  assert.ok(work.includes('kit-signups:day:error'), work.join(','));
  const kept = await DB.prepare(`SELECT * FROM broadcast_sends WHERE broadcast_id = 'bc-kit-down' AND kind = 'day' AND channel = 'kit-signups'`).first();
  assert.ok(kept.error && kept.sent === 0, 'kept with its error, so the next tick takes it back');
  assert.equal(slackPosts.length - slack <= 1, true, 'staff are told once');
  await b.sendReminders(env, config, due, 'day', []);
  assert.equal(kit.posts.slice(n).filter((p) => /day · reveal sign-ups · /.test(p.description)).length, 1, 'and it goes once Kit is back');
});

// ─── Found in review (Nov 10 2026) ──────────────────────────────────

test('a failed Kit send to the sign-ups is tried again on the next tick even with browser alerts on, and for the replay too', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, vapid: cfg.vapid || await notify.generateVapidKeys(), reminders: { ...cfg.reminders, enabled: true, push: true } };
  await b.writeConfig(DB, config);
  await b.writeState(DB, { ...(await b.readState(DB)), broadcastId: 'bc-push-retry', phase: 'scheduled', kidSlug: 'remi', kidName: 'Remi', scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString(), test: false, source: null });
  const n = kit.posts.length;
  sim.kitDown = true;
  try { travel(5000); await b.runTick(env, { source: 'test', force: true }); } finally { sim.kitDown = false; }
  assert.equal(kit.posts.length, n, 'Kit took nothing');
  assert.ok(await DB.prepare(`SELECT 1 FROM broadcast_sends WHERE broadcast_id = 'bc-push-retry' AND kind = 'day' AND channel = 'push'`).first(), 'browser alerts went');
  travel(5000);
  const t = await b.runTick(env, { source: 'test', force: true });
  assert.ok(t.work.includes('kit-signups:day'), t.work.join(','));
  assert.equal(kit.posts.slice(n).filter((p) => /Remi day · reveal sign-ups · /.test(p.description)).length, 1, 'the sign-ups get it once Kit is back');
  // The replay is sent once, from the replay tick: a failure there is taken back the same way
  const replay = { ...(await b.readState(DB)), broadcastId: 'bc-replay-retry', phase: 'replay', kidSlug: 'remi', kidName: 'Remi' };
  sim.kitDown = true;
  try { await b.sendReminders(env, config, replay, 'replay', []); } finally { sim.kitDown = false; }
  await b.writeState(DB, replay);
  travel(5000);
  await b.runTick(env, { source: 'test', force: true });
  assert.equal(kit.posts.slice(n).filter((p) => /Remi replay · reveal sign-ups · /.test(p.description)).length, 1);
  await b.writeConfig(DB, { ...config, reminders: { ...config.reminders, push: false } });
});

test('Kit took it but its answer was lost: the next try finds it in Kit and sends nothing more', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, push: false } };
  const state = { ...(await b.readState(DB)), broadcastId: 'bc-lost-answer', phase: 'scheduled', kidSlug: 'remi', kidName: 'Remi', scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString(), test: false };
  const n = kit.posts.length;
  const inner = globalThis.fetch;
  // Kit makes the broadcast, then the answer is lost on its way back
  globalThis.fetch = async (input, init = {}) => {
    if (String(input) === 'https://api.kit.com/v4/broadcasts' && (init.method || 'GET') === 'POST') { await inner(input, init); return new Response('gateway', { status: 502 }); }
    return inner(input, init);
  };
  try { await b.sendReminders(env, config, state, 'day', []); } finally { globalThis.fetch = inner; }
  assert.equal(kit.posts.length, n + 1, 'Kit has it');
  const work = [];
  await b.sendReminders(env, config, state, 'day', work);
  assert.ok(work.includes('kit-signups:day:found'), work.join(','));
  assert.equal(kit.posts.length, n + 1, 'never made twice');
  const row = await DB.prepare(`SELECT * FROM broadcast_sends WHERE broadcast_id = 'bc-lost-answer' AND kind = 'day' AND channel = 'kit-signups'`).first();
  assert.equal(row.sent, 1);
  assert.equal(row.error, null);
});

test('a try that died on its way to Kit is taken back once it\'s clearly gone, never while another tick may still be sending it', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, push: false } };
  const state = { ...(await b.readState(DB)), broadcastId: 'bc-died', phase: 'scheduled', kidSlug: 'remi', kidName: 'Remi', scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString(), test: false };
  // A tick claimed it and died before it finished
  await DB.prepare(`INSERT INTO broadcast_sends (broadcast_id, kind, channel, created_at, error) VALUES ('bc-died', 'day', 'kit-signups', ?, 'sending')`).bind(new Date(Date.now()).toISOString()).run();
  const n = kit.posts.length;
  await b.sendReminders(env, config, state, 'day', []);
  assert.equal(kit.posts.length, n, 'just now: another tick may still be sending it');
  travel(4 * 60e3);
  await b.sendReminders(env, config, { ...state, scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString() }, 'day', []);
  assert.equal(kit.posts.slice(n).filter((p) => /Remi day · reveal sign-ups · bc-died$/.test(p.description)).length, 1, 'taken back and sent once');
});

test('a failed "tomorrow" isn\'t sent once it would arrive late', async () => {
  const cfg = await b.readConfig(DB);
  const config = { ...cfg, reminders: { ...cfg.reminders, enabled: true, push: false } };
  await b.writeConfig(DB, config);
  const at = new Date(Date.now() + 3 * 3600e3).toISOString();
  await b.writeState(DB, { ...(await b.readState(DB)), broadcastId: 'bc-late', phase: 'scheduled', kidSlug: 'remi', kidName: 'Remi', scheduledAt: at, test: false, source: null });
  await DB.prepare(`INSERT INTO broadcast_sends (broadcast_id, kind, channel, created_at, error, sent) VALUES ('bc-late', 'day', 'kit-signups', ?, 'Kit HTTP 503', 0)`).bind(new Date(Date.now()).toISOString()).run();
  travel(90 * 60e3); // now 1.5 hours before: inside the last 2 hours, "tomorrow" is out of date
  const n = kit.posts.length;
  await b.runTick(env, { source: 'test', force: true });
  assert.equal(kit.posts.slice(n).filter((p) => /day · reveal sign-ups · bc-late$/.test(p.description)).length, 0);
});

test('a new person whose first trip to Kit fails halfway is still kept off the newsletter', async () => {
  const { syncSignup } = await import('../functions/api/_reveal-signups.js');
  await endpoint.activate(DB, { channel: 'email', address: 'half@example.com', kid_slug: null, source: 'test' });
  const [row] = await rows('address = ?', 'half@example.com');
  // Kit makes the subscriber, then refuses the tag
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => (/\/tags\/\d+\/subscribers\/\d+$/.test(String(input)) && init.method === 'POST' ? new Response('busy', { status: 429 }) : inner(input, init));
  let first;
  try { first = await syncSignup(env, row); } finally { globalThis.fetch = inner; }
  assert.equal(first.ok, false);
  assert.equal(kit.subs.get('half@example.com').state, 'active', 'Kit has made them');
  const again = await syncSignup(env, row);
  assert.equal(again.ok, true);
  assert.deepEqual(kitTagsOf('half@example.com'), ['Reveal sign-ups', 'Reveal sign-ups only (no newsletter)'], 'Kit answered 200 the second time, and they are still reveal emails only');
});

test('Stop after a first trip to Kit that failed halfway still takes everything off', async () => {
  const { syncSignup } = await import('../functions/api/_reveal-signups.js');
  await endpoint.activate(DB, { channel: 'email', address: 'halfstop@example.com', kid_slug: 'remi', source: 'test' });
  const [row] = await rows('address = ?', 'halfstop@example.com');
  // The kid's tag lands, then Kit refuses the rest
  let tagged = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => (/\/tags\/\d+\/subscribers\/\d+$/.test(String(input)) && init.method === 'POST' && ++tagged > 1 ? new Response('busy', { status: 429 }) : inner(input, init));
  try { assert.equal((await syncSignup(env, row)).ok, false); } finally { globalThis.fetch = inner; }
  assert.deepEqual(kitTagsOf('halfstop@example.com'), ['Reveal sign-ups: remi']);
  await stop('halfstop@example.com');
  assert.deepEqual(kitTagsOf('halfstop@example.com'), [], 'the kid’s tag comes off too');
  assert.equal(kit.subs.get('halfstop@example.com').state, 'cancelled', 'new to Kit, so unsubscribed there: no newsletter either');
});

test('a rehearsal\'s day-before goes to the test address even with Kit not connected', async () => {
  const cfg = await b.readConfig(DB);
  await b.writeConfig(DB, { ...cfg, reminders: { ...cfg.reminders, enabled: true, push: false } });
  await b.writeState(DB, { ...(await b.readState(DB)), broadcastId: 'bc-rehearsal', phase: 'scheduled', kidSlug: 'remi', kidName: 'Remi', scheduledAt: new Date(Date.now() + 20 * 3600e3).toISOString(), test: true, source: null });
  travel(5000);
  await b.runTick({ ...env, KIT_API_KEY: undefined }, { source: 'test', force: true });
  assert.ok(await DB.prepare(`SELECT 1 FROM broadcast_sends WHERE broadcast_id = 'bc-rehearsal' AND kind = 'day' AND channel = 'email'`).first(), 'the rehearsal’s TEST copy was claimed');
  await b.writeState(DB, { ...(await b.readState(DB)), test: false });
});

test('a sign-up Kit has as having complained is left alone, and never crowds out the Stops behind it', async () => {
  const { syncSignups } = await import('../functions/api/_reveal-signups.js');
  for (let i = 0; i < 10; i++) {
    const email = `spam${i}@example.com`;
    kit.subs.set(email, { id: kit.nextId++, email_address: email, state: 'complained' });
    await endpoint.activate(DB, { channel: 'email', address: email, kid_slug: null, source: 'test' });
  }
  travel(120e3);
  await syncSignups(env, { limit: 1000 });
  const again = await syncSignups(env, { limit: 1000 });
  assert.ok(!again.some((r) => /spam/.test(r.id)) && again.every((r) => r.ok), 'complained rows aren\'t picked up again');
  const left = await DB.prepare(`SELECT COUNT(*) AS n FROM reveal_signup_kit k JOIN broadcast_reminders r ON r.id = k.reminder_id WHERE r.address LIKE 'spam%' AND k.scope = 'all'`).first();
  assert.equal(left.n, 10);
});

test('Stop keeps what isn\'t reveals: someone who joined the newsletter keeps it, and a family waiting for applications keeps that email', async () => {
  const { kitSubscribe } = await import('../functions/api/_kit.js');
  // New for reveals, then joins the newsletter from the footer (that takes the "only" tags off in Kit)
  await post({ channel: 'email', email: 'both-lists@example.com' });
  await flush();
  await kitSubscribe(env, 'both-lists@example.com', { source: 'newsletter' });
  assert.deepEqual(kitTagsOf('both-lists@example.com'), ['Newsletter', 'Reveal sign-ups']);
  // Asking about one kid widens nothing here; a fresh trip to Kit must not put "no newsletter" back
  await post({ channel: 'email', email: 'both-lists@example.com', kidSlug: 'remi' });
  await flush();
  assert.ok(!kitTagsOf('both-lists@example.com').includes('Reveal sign-ups only (no newsletter)'), 'the newsletter they joined keeps reaching them');
  await stop('both-lists@example.com');
  assert.equal(kit.subs.get('both-lists@example.com').state, 'active', 'Stop ends reveal emails only');
  assert.ok(!kitTagsOf('both-lists@example.com').includes('Reveal sign-ups'));

  // A family on the applications waitlist (waitlist only) signs up for reveals, then presses Stop
  const fam = { id: kit.nextId++, email_address: 'family@example.com', state: 'active' };
  kit.subs.set('family@example.com', fam);
  for (const name of ['Application Waitlist', 'Application Waitlist only (no newsletter)']) {
    const t = kitTags.byName(name);
    if (!kitTags.members.has(Number(t.id))) kitTags.members.set(Number(t.id), new Set());
    kitTags.members.get(Number(t.id)).add(fam.id);
  }
  await post({ channel: 'email', email: 'family@example.com' });
  await flush();
  assert.deepEqual(kitTagsOf('family@example.com'), ['Application Waitlist', 'Reveal sign-ups', 'Reveal sign-ups only (no newsletter)'], 'reveal emails reach them now; still no newsletter');
  await stop('family@example.com');
  assert.equal(kit.subs.get('family@example.com').state, 'active', 'still in Kit for the applications email');
  assert.deepEqual(kitTagsOf('family@example.com'), ['Application Waitlist', 'Application Waitlist only (no newsletter)']);
});

test('nobody can use the form to make Kit email someone over and over', async () => {
  await post({ channel: 'email', email: 'left@example.com' });
  await flush();
  kit.subs.get('left@example.com').state = 'cancelled'; // they used Kit's unsubscribe link; the site's row stays on
  const before = kit.confirms.filter((e) => e === 'left@example.com').length;
  const answers = [];
  for (let i = 0; i < 6; i++) answers.push(await (await post({ channel: 'email', email: 'left@example.com' })).json());
  await flush();
  const asked = kit.confirms.filter((e) => e === 'left@example.com').length - before;
  assert.ok(asked >= 1 && asked <= 3, `Kit asked them ${asked} times`);
  assert.ok(answers.every((a) => a.ok), 'the form still answers plainly');
});

test('a Kit that doesn\'t answer about its tags never widens who a reveal email goes to', async () => {
  const signups = await import('../functions/api/_reveal-signups.js');
  const kitMod = await import('../functions/api/_kit.js?fresh=strict'); // its own memory of tag ids: none
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => (/\/v4\/tags\?/.test(String(input)) ? new Response('busy', { status: 503 }) : inner(input, init));
  try {
    const fresh = { ...env, DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }) }; // no remembered tag ids
    // A kid's tag Kit couldn't be asked about: no audience at all, rather than one without it
    assert.equal(await signups.signupsFilter(fresh, 'never-asked'), null);
    assert.equal(await signups.oneRevealFilter(fresh, 'never-asked'), null);
    assert.equal(await signups.signupTagIds(fresh, 'never-asked'), null);
    assert.deepEqual(await kitMod.kitFindTagId(fresh, 'Application Waitlist only (no newsletter)'), { ok: false });
    const r = await kitMod.kitCreateBroadcast(fresh, { subject: 'A newsletter', description: 'x', html: '<p>x</p>' });
    assert.equal(r.ok, false, 'a newsletter waits rather than going to the reveal-only people');
  } finally {
    globalThis.fetch = inner;
  }
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
    await b.sendReminders(env, { ...cfg, reminders: { ...cfg.reminders, enabled: true, push: true } }, state, 'live', []);
  } finally {
    globalThis.fetch = inner;
  }
  assert.ok(!calls.some(u => u.startsWith('https://attacker.example')), 'never POSTs to it');
  assert.ok((await rows(`id = 'old-push'`))[0].unsubscribed_at, 'and drops it');
});
