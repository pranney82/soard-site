/**
 * Did the email arrive? (functions/api/_email-log.js, resend-webhook.js,
 * _messages-activity.js; Site → Emails & invites → What went out)
 *
 * Every email the site sends is logged with Resend's id and its message;
 * Resend's signed reports move each one along (never backwards) and keep
 * why; the site registers its own webhook (the secret stays in a runtime
 * table, never site_config) or says plainly that its key can only send;
 * missed reports are caught up from Resend's list; a lost reveal-reminder
 * address is unsubscribed and a lost family or staff email tells staff once
 * a week; and the timeline, what's coming up and "Will it land?" read right.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import * as log from '../functions/api/_email-log.js';
import { sendEmails, sendEmailItems } from '../functions/api/_broadcast-notify.js';
import { onRequestPost as webhook } from '../functions/api/resend-webhook.js';
import { activity, comingUp, deliverability, deliveryFacts, emailDetail, invitesOut } from '../functions/api/_messages-activity.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { gatherFacts, onRequestGet } from '../functions/api/messages-admin.js';
import { ensureCommsSchema } from '../functions/api/_applicant-comms.js';
import { ensureNotifySchema } from '../functions/api/_applicant-notify.js';
import { ensureFormSchema } from '../functions/api/_application-forms.js';
import { ensureSchema as ensureInviteSchema } from '../functions/api/_reveal-invites.js';
import { ensureSchema as ensureApplicationSchema } from '../functions/api/_applications.js';
import { ensureWaitlistSchema } from '../functions/api/_application-waitlist.js';
import { ensureRequests } from '../functions/api/_profile-requests.js';
import { ENTRIES, keyOf, entryOf } from '../public/admin/messages.js';

const NOW = Date.parse('2026-10-22T15:00:00Z');
const MIN = 60e3;
const DAY = 864e5;
const iso = (t) => new Date(t).toISOString();
const SECRET = `whsec_${Buffer.from('a test signing secret, 32 bytes!').toString('base64')}`;

async function makeDb() {
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
    'CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)',
    'CREATE TABLE kid_status_state (key TEXT PRIMARY KEY, value TEXT)',
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, data TEXT)',
    'CREATE TABLE broadcasts (id TEXT PRIMARY KEY, kid_slug TEXT, kid_name TEXT, scheduled_at TEXT, phase TEXT)',
    'CREATE TABLE broadcast_sends (id INTEGER PRIMARY KEY AUTOINCREMENT, broadcast_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL, recipients INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, error TEXT, created_at TEXT)',
    'CREATE TABLE broadcast_reminders (id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, subscription TEXT, kid_slug TEXT, token TEXT NOT NULL, source TEXT, created_at TEXT, unsubscribed_at TEXT, last_sent_at TEXT)',
    'CREATE TABLE applicants (account_id TEXT PRIMARY KEY, name TEXT NOT NULL, contact_name TEXT, contact_email TEXT, job_id TEXT)',
    'CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER, reset_at INTEGER)',
  ] });
  for (const fn of [ensureCommsSchema, ensureNotifySchema, ensureFormSchema, ensureInviteSchema, ensureApplicationSchema, ensureWaitlistSchema, ensureRequests]) await fn(DB);
  return DB;
}
const run = (DB, sql, ...b) => DB.prepare(sql).bind(...b).run();

// Outside services are never reached unless a test says so
function offline(t, handler = null) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : null });
    if (handler) return handler(String(url), init);
    throw new Error(`offline: ${url}`);
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}
const signed = async (body, { secret = SECRET, at = Date.now(), id = 'msg_1' } = {}) => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(at / 1000));
  const sig = await log.svixSignature(secret, id, ts, raw);
  return new Request('https://sunshineonaranneyday.com/api/resend-webhook', { method: 'POST', body: raw, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}`, 'CF-Connecting-IP': '203.0.113.9' } });
};
const rowOf = (DB, id) => DB.prepare('SELECT * FROM email_log WHERE id = ?').bind(id).first();

test('every email the site sends is logged with Resend’s id, its message and the one address, and sending still answers the same', async (t) => {
  const DB = await makeDb();
  let n = 0;
  offline(t, async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails/batch');
    const items = JSON.parse(init.body);
    return Response.json({ data: items.map(() => ({ id: `em_${++n}` })) });
  });
  const env = { DB, RESEND_API_KEY: 're_x' };
  const out = await sendEmails(env, { to: ['Jordan@Example.com', 'not an email', 'staff@example.com'], subject: 'Your SOARD application: pick up where you left off', html: '<p>hi</p>', tags: [{ name: 'type', value: 'application-resume' }] });
  assert.deepEqual(out, { sent: 2, failed: 0, errors: [] }, 'the answer other code reads is unchanged');
  const rows = (await DB.prepare('SELECT * FROM email_log ORDER BY id').all()).results;
  assert.deepEqual(rows.map((r) => [r.id, r.to_addr, r.type, r.status]), [['em_1', 'jordan@example.com', 'application-resume', 'sent'], ['em_2', 'staff@example.com', 'application-resume', 'sent']]);
  assert.equal(log.entryFor(rows[0].type, rows[0].subject), 'app-resume');

  const items = await sendEmailItems(env, [{ to: 'fan@example.com', subject: 'Tomorrow: Avery’s room reveal, live', html: 'x' }], { tags: [{ name: 'category', value: 'reveal-day' }] });
  assert.deepEqual(items, { sent: 1, failed: 0, errors: [] });
  assert.equal((await rowOf(DB, 'em_3')).type, 'reveal-day', 'a category tag counts as the type too');

  // A reply goes somewhere real when the sender asks (the sending address is no one's inbox)
  const bodies = [];
  globalThis.fetch = async (url, init) => { const items = JSON.parse(init.body); bodies.push(items); return Response.json({ data: items.map(() => ({ id: `em_${++n}` })) }); };
  await sendEmails(env, { to: ['a@example.com'], subject: 's', html: 'h', replyTo: 'info@example.org' });
  await sendEmails(env, { to: ['a@example.com'], subject: 's', html: 'h', replyTo: ['one@example.org', 'not an address', 'two@example.org'] });
  await sendEmails(env, { to: ['a@example.com'], subject: 's', html: 'h' });
  await sendEmailItems(env, [{ to: 'b@example.com', subject: 's', html: 'h' }], { replyTo: 'info@example.org' });
  assert.deepEqual(bodies.map((b) => b[0].reply_to), ['info@example.org', ['one@example.org', 'two@example.org'], undefined, 'info@example.org'], 'replyTo becomes reply_to, valid addresses only, and nothing when it isn’t given');

  // A broken log never costs a send
  const out2 = await sendEmails({ RESEND_API_KEY: 're_x', DB: { prepare() { throw new Error('D1 down'); }, batch() { throw new Error('D1 down'); } } }, { to: ['a@example.com'], subject: 's', html: 'h' });
  assert.equal(out2.sent, 1);
});

test('which message an email is, even where two share a tag', () => {
  const cases = [
    ['application-waitlist', 'You’re on the list', 'waitlist-confirm'],
    ['application-waitlist-staff', 'Applications are open: the waitlist email goes out at 3:10 PM', 'staff-waitlist'],
    ['application-waitlist', 'The applications-open email was sent to 14 families', 'staff-waitlist'],
    ['reveal-invite-alert', '[SOARD] Avery’s reveal invite is still out', 'staff-invite-held'],
    ['reveal-invite-alert', '[SOARD] Reveal invite problem: Avery', 'staff-invite-problem'],
    ['live-alert', '[SOARD Live] Countdown is up: Avery Stone’s reveal', 'staff-countdown'],
    ['live-alert', '[SOARD Live] Live now: Avery’s room reveal', 'staff-good-news'],
    ['live-alert', '[SOARD Live] Live now: which kid is this?', 'staff-live-alert'],
    ['live-alert', '[SOARD Live] Reveal audio is silent', 'staff-live-alert'],
    ['live-alert', '[SOARD Live] A staff text didn’t arrive: (678) 555-0123', 'staff-text-missed'],
    ['live-alert', '[SOARD Live] Kit "we\'re live" email did not send', 'staff-kit-live'],
    ['live-alert', '[SOARD Live] Instagram Reel posted: x', 'staff-replay'],
    ['live-alert', '[SOARD Live] Test alert', 'preview'],
    ['application-limit', '[TEST] 98 of 120 applications are in for 2027', 'preview'],
    ['application-resume', '[Test run] Your SOARD application: pick up where you left off', 'preview'],
    [null, 'Application for Avery Stone is stuck', 'staff-stuck'],
    ['reveal-day-test', 'TEST · Tomorrow: Avery', 'preview'],
    ['kind-we-never-made', 'Something else', null],
  ];
  for (const [type, subject, want] of cases) assert.equal(log.entryFor(type, subject), want, `${type} · ${subject}`);
  // Every message the log can name is an entry on the map
  const named = new Set([...cases.map((c) => c[2]), 'app-resume', 'app-reminder', 'staff-new-app', 'staff-summary', 'staff-pause-ended', 'waitlist-open', 'staff-app-limit', 'staff-alert-hello', 'staff-kid-hidden', 'staff-gift-problem', 'rem-confirm', 'rem-scheduled', 'rem-moved', 'rem-day', 'rem-hour', 'rem-live', 'rem-replay', 'direct', 'advisory-thanks', 'advisory-staff',
    'app-welcome', 'app-in-review', 'app-approved', 'app-denied', 'staff-medical', 'app-note', 'app-correction', 'invite-tentative', 'invite-confirmed', 'invite-update', 'invite-cancel', 'kit-live', 'newsletter', 'staff-reveal-texts', 'staff-problem-texts', 'staff-email-lost'].filter(Boolean));
  named.delete('preview');
  for (const k of named) assert.ok(entryOf(k), `${k} is on the map`);
  const keys = ENTRIES.map(keyOf).filter(Boolean);
  assert.equal(new Set(keys).size, keys.length, 'no two entries share a key');
});

test('Resend’s signature: the right secret within 5 minutes, nothing else', async () => {
  const raw = '{"type":"email.delivered"}';
  const ts = String(Math.floor(NOW / 1000));
  const sig = await log.svixSignature(SECRET, 'msg_9', ts, raw);
  const h = (o) => new Headers({ 'svix-id': 'msg_9', 'svix-timestamp': ts, ...o });
  assert.equal(await log.verifySvix(SECRET, h({ 'svix-signature': `v1,${sig}` }), raw, { now: NOW }), true);
  assert.equal(await log.verifySvix(SECRET, h({ 'svix-signature': `v1,AAAA v1,${sig}` }), raw, { now: NOW }), true, 'any of several signatures (a rotated secret)');
  assert.equal(await log.verifySvix(SECRET, h({ 'svix-signature': `v1,${sig}` }), `${raw} `, { now: NOW }), false, 'a changed body');
  assert.equal(await log.verifySvix(`whsec_${Buffer.from('another secret entirely, 32 byte').toString('base64')}`, h({ 'svix-signature': `v1,${sig}` }), raw, { now: NOW }), false, 'another secret');
  assert.equal(await log.verifySvix(SECRET, h({ 'svix-signature': `v1,${sig}` }), raw, { now: NOW + 6 * MIN }), false, 'too old');
  assert.equal(await log.verifySvix(SECRET, new Headers({ 'webhook-id': 'msg_9', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }), raw, { now: NOW }), true, 'the standard-webhooks header names too');
});

test('reports move an email along, never backwards, and keep why', async () => {
  const DB = await makeDb();
  await log.logSent({ DB }, [{ id: 'e1', to: 'jordan@example.com', subject: 'Your SOARD application: pick up where you left off' }], { tags: [{ name: 'type', value: 'application-resume' }], now: NOW });
  const ev = (type, data = {}, at = NOW + MIN) => log.recordEvent(DB, { type, created_at: iso(at), data: { email_id: 'e1', ...data } }, { now: at });
  assert.equal((await ev('email.delivery_delayed')).status, 'delayed');
  assert.equal((await ev('email.delivered', {}, NOW + 2 * MIN)).status, 'delivered');
  assert.equal((await ev('email.delivery_delayed', {}, NOW + 3 * MIN)).changed, false, 'a late "delayed" doesn’t undo delivered');
  const o = await ev('email.opened', {}, NOW + 4 * MIN);
  assert.equal(o.row.opened_at, iso(NOW + 4 * MIN));
  const b = await ev('email.bounced', { bounce: { type: 'Permanent', subType: 'General', message: '550 5.1.1 no such user' } }, NOW + 5 * MIN);
  assert.equal(b.status, 'bounced');
  assert.match(b.row.detail, /doesn’t exist/);
  assert.equal(b.row.bounce_type, 'Permanent');
  assert.equal(b.entry, 'app-resume');
  const events = (await DB.prepare('SELECT type FROM email_events WHERE email_id = ? ORDER BY at').bind('e1').all()).results.map((r) => r.type);
  assert.deepEqual(events, ['delivery_delayed', 'delivered', 'opened', 'bounced'], 'each report kept for the timeline (a repeat is one row)');

  // A report about an email the log never saw (sent before tracking began): it's added from the report
  const x = await log.recordEvent(DB, { type: 'email.delivered', created_at: iso(NOW), data: { email_id: 'old1', to: ['Staff@Example.com'], subject: 'New makeover application: Riley', created_at: iso(NOW - MIN), tags: { type: 'application' } } }, { now: NOW });
  assert.equal(x.status, 'delivered');
  assert.equal(x.to, 'staff@example.com');
  assert.equal(x.entry, 'staff-new-app');
  assert.equal(await log.recordEvent(DB, { type: 'contact.created', data: { id: 'c1' } }), null, 'not an email report');
});

test('the webhook: refused until there’s a secret, refused when unsigned, then it records and follows up', async (t) => {
  const DB = await makeDb();
  const calls = offline(t, async (url) => {
    if (url.startsWith('https://api.resend.com/emails/batch')) return Response.json({ data: [{ id: 'alert_1' }] });
    if (url.startsWith('https://slack.com/') || url.startsWith('https://hooks.slack')) return Response.json({ ok: true, ts: '1.1', channel: 'C1' });
    throw new Error(`offline: ${url}`);
  });
  const env = { DB, RESEND_API_KEY: 're_x', ALERT_EMAILS: 'alerts@example.com' };
  const ctx = (request) => ({ env, request, waitUntil: null });
  const body = { type: 'email.bounced', created_at: iso(Date.now()), data: { email_id: 'fam1', to: ['jordan@exmaple.com'], subject: 'You’re on the list', tags: { type: 'application-waitlist' }, bounce: { type: 'Permanent', subType: 'General', message: 'no such user' } } };

  assert.equal((await webhook(ctx(await signed(body)))).status, 503, 'no secret yet');
  await DB.prepare('INSERT INTO email_tracking (key, value, updated_at) VALUES (?, ?, ?)').bind('webhook', JSON.stringify({ id: 'wh_1', secret: SECRET, endpoint: 'https://sunshineonaranneyday.com/api/resend-webhook' }), iso(NOW)).run();
  assert.equal((await webhook(ctx(await signed(body, { secret: `whsec_${Buffer.from('wrong wrong wrong wrong wrong!!!').toString('base64')}` })))).status, 401, 'a forged report');
  assert.equal((await webhook(ctx(await signed(body)))).status, 204);
  const row = await rowOf(DB, 'fam1');
  assert.equal(row.status, 'bounced');
  const alertMail = calls.filter((c) => c.url === 'https://api.resend.com/emails/batch');
  assert.equal(alertMail.length, 1, 'staff are told, once');
  assert.match(alertMail[0].body[0].subject, /An email didn’t reach jordan@exmaple\.com/);
  assert.match(alertMail[0].body[0].text || alertMail[0].body[0].html, /hear when applications open/, 'with what to do');
  // The same address again this week: no second alert
  await webhook(ctx(await signed({ ...body, data: { ...body.data, email_id: 'fam2' } }, { id: 'msg_2' })));
  assert.equal(calls.filter((c) => c.url === 'https://api.resend.com/emails/batch').length, 1);

  // A reveal-reminder address that reports spam is unsubscribed, and nobody is emailed
  await run(DB, "INSERT INTO broadcast_reminders (id, channel, address, token, created_at) VALUES ('r1', 'email', 'fan@example.com', 't', ?)", iso(NOW));
  await webhook(ctx(await signed({ type: 'email.complained', created_at: iso(Date.now()), data: { email_id: 'w1', to: ['Fan@Example.com'], subject: 'Tomorrow: Avery’s room reveal, live', tags: { category: 'reveal-day' } } }, { id: 'msg_3' })));
  assert.ok((await DB.prepare("SELECT unsubscribed_at FROM broadcast_reminders WHERE id = 'r1'").first('unsubscribed_at')), 'unsubscribed');
  assert.equal(calls.filter((c) => c.url === 'https://api.resend.com/emails/batch').length, 1, 'no email about a reveal watcher');

  // The secret lives in the runtime table only
  assert.equal(await DB.prepare("SELECT count(*) AS n FROM site_config WHERE data LIKE '%whsec_%'").first('n'), 0);
});

test('the site registers its own webhook, adopts one already there, and says when its key can only send', async (t) => {
  const DB = await makeDb();
  const env = { DB, RESEND_API_KEY: 're_x' };
  const ENDPOINT = 'https://sunshineonaranneyday.com/api/resend-webhook';

  // A key with "Sending access"
  offline(t, async () => Response.json({ statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }, { status: 401 }));
  assert.deepEqual(await log.ensureWebhook(env, { now: NOW }), { state: 'send-only' });
  const r1 = await log.maybeTrackEmails(env, { now: NOW });
  assert.equal(r1.state, 'send-only');
  assert.equal(await log.maybeTrackEmails(env, { now: NOW + 2 * 3600e3 }), null, 'a send-only key is checked again a day later, not every half hour');
  assert.equal((await log.trackingState(env)).state, 'send-only');

  // A full key, no webhook yet: it makes one with every email event, and keeps the secret out of site_config
  const calls = offline(t, async (url, init) => {
    if (url === 'https://api.resend.com/webhooks' && (init.method || 'GET') === 'GET') return Response.json({ object: 'list', data: [{ id: 'wh_other', endpoint: 'https://elsewhere.example.com/hook' }] });
    if (url === 'https://api.resend.com/webhooks' && init.method === 'POST') return Response.json({ object: 'webhook', id: 'wh_new', signing_secret: SECRET });
    if (url.startsWith('https://api.resend.com/emails?limit=100')) return Response.json({ object: 'list', has_more: false, data: [] });
    throw new Error(`offline: ${url}`);
  });
  const r2 = await log.maybeTrackEmails(env, { now: NOW + 2 * DAY });
  assert.equal(r2.state, 'on');
  const made = calls.find((c) => c.init.method === 'POST');
  assert.equal(made.body.endpoint, ENDPOINT);
  assert.ok(['email.delivered', 'email.bounced', 'email.complained', 'email.failed'].every((e) => made.body.events.includes(e)));
  assert.equal(await log.webhookSecret(env), SECRET);
  assert.equal(await DB.prepare("SELECT count(*) AS n FROM site_config WHERE data LIKE '%whsec_%'").first('n'), 0, 'never in site_config (written into builds)');
  assert.equal(await log.maybeTrackEmails(env, { now: NOW + 2 * DAY + 10 * MIN }), null, 'every 30 minutes, not every heartbeat');

  // Deleted in Resend's dashboard: made again. One already pointed here (made by hand): adopted with its secret
  const DB2 = await makeDb();
  const env2 = { DB: DB2, RESEND_API_KEY: 're_x' };
  offline(t, async (url, init) => {
    if (url === 'https://api.resend.com/webhooks') return Response.json({ object: 'list', data: [{ id: 'wh_hand', endpoint: ENDPOINT }] });
    if (url === 'https://api.resend.com/webhooks/wh_hand') return Response.json({ object: 'webhook', id: 'wh_hand', status: 'enabled', endpoint: ENDPOINT, signing_secret: SECRET });
    throw new Error(`offline: ${url} ${init.method || ''}`);
  });
  assert.deepEqual(await log.ensureWebhook(env2, { now: NOW }), { state: 'on', id: 'wh_hand', adopted: true });

  // Disabled (Resend gave up after failures): turned back on
  const patched = [];
  offline(t, async (url, init) => {
    if (url === 'https://api.resend.com/webhooks/wh_hand' && (init.method || 'GET') === 'GET') return Response.json({ object: 'webhook', id: 'wh_hand', status: 'disabled', endpoint: ENDPOINT, signing_secret: SECRET });
    if (url === 'https://api.resend.com/webhooks/wh_hand' && init.method === 'PATCH') { patched.push(JSON.parse(init.body)); return Response.json({ object: 'webhook', id: 'wh_hand' }); }
    throw new Error(`offline: ${url}`);
  });
  assert.deepEqual(await log.ensureWebhook(env2, { now: NOW }), { state: 'on', id: 'wh_hand', reenabled: true });
  assert.deepEqual(patched, [{ status: 'enabled' }]);

  // RESEND_WEBHOOK_SECRET in Cloudflare: that one, and nothing is registered
  assert.deepEqual(await log.ensureWebhook({ ...env2, RESEND_WEBHOOK_SECRET: SECRET }, { now: NOW }), { state: 'env' });
});

test('missed reports are caught up from Resend’s list, and old rows are deleted', async (t) => {
  const DB = await makeDb();
  const env = { DB, RESEND_API_KEY: 're_x' };
  await log.logSent(env, [{ id: 'a', to: 'one@example.com', subject: 'You’re on the list' }, { id: 'b', to: 'two@example.com', subject: 'You’re on the list' }], { tags: [{ name: 'type', value: 'application-waitlist' }], now: NOW - 2 * 3600e3 });
  await log.logSent(env, [{ id: 'ancient', to: 'old@example.com', subject: 'x' }], { now: NOW - 200 * DAY });
  await DB.prepare('INSERT INTO email_tracking (key, value, updated_at) VALUES (?, ?, ?)').bind('webhook', JSON.stringify({ id: 'wh', secret: SECRET, endpoint: 'https://sunshineonaranneyday.com/api/resend-webhook' }), iso(NOW)).run();
  offline(t, async (url) => {
    if (url === 'https://api.resend.com/webhooks/wh') return Response.json({ object: 'webhook', id: 'wh', status: 'enabled' });
    if (url.startsWith('https://api.resend.com/emails?limit=100')) {
      return Response.json({ object: 'list', has_more: false, data: [
        { id: 'a', to: ['one@example.com'], subject: 'You’re on the list', created_at: '2026-10-22 13:00:00.000+00', last_event: 'delivered' },
        { id: 'b', to: ['two@example.com'], subject: 'You’re on the list', created_at: '2026-10-22 13:00:00.000+00', last_event: 'sent' },
        { id: 'z', to: ['three@example.com'], subject: 'Confirm your reminders for Avery’s reveal', created_at: '2026-10-22 12:00:00.000+00', last_event: 'bounced' },
      ] });
    }
    throw new Error(`offline: ${url}`);
  });
  const r = await log.maybeTrackEmails(env, { now: NOW });
  assert.deepEqual([r.state, r.seen, r.updated, r.added], ['on', 3, 1, 1]);
  assert.equal((await rowOf(DB, 'a')).status, 'delivered');
  assert.equal((await rowOf(DB, 'b')).status, 'sent');
  assert.equal((await rowOf(DB, 'z')).status, 'bounced', 'one sent before tracking began is added with Resend’s word for it');
  assert.equal(await rowOf(DB, 'ancient'), null, 'kept 180 days');
});

test('What went out: every kind of message in one timeline, with names, search, and previews kept apart', async () => {
  const DB = await makeDb();
  const env = { DB, RESEND_API_KEY: 're_x', KIT_API_KEY: 'k' };
  await run(DB, "INSERT INTO applications (id, child_name, parent_name, parent_email, status, submitted_at, updated_at) VALUES ('app1', 'Avery Stone', 'Jordan Stone', 'jordan@example.com', 'done', ?, ?)", iso(NOW - DAY), iso(NOW - DAY));
  await run(DB, "INSERT INTO applicants (account_id, name, contact_name, contact_email, job_id) VALUES ('acc1', 'Avery Stone', 'Jordan Stone', 'jordan@example.com', 'job1')");
  await log.logSent(env, [{ id: 'r1', to: 'jordan@example.com', subject: 'Your SOARD application: pick up where you left off' }], { tags: [{ name: 'type', value: 'application-resume' }], now: NOW - 3 * 3600e3 });
  await log.recordEvent(DB, { type: 'email.delivered', created_at: iso(NOW - 3 * 3600e3 + MIN), data: { email_id: 'r1' } });
  await log.logSent(env, [{ id: 'p1', to: 'me@example.com', subject: '[Preview] New makeover application: Avery' }], { tags: [{ name: 'type', value: 'admin-preview' }], now: NOW - 3600e3 });
  await run(DB, "INSERT INTO applicant_comms (account_id, kind, state, created_at, updated_at) VALUES ('acc1', 'approved', 'sent', ?, ?), ('acc1', 'medical', 'sent', ?, ?)", iso(NOW - 2 * 3600e3), iso(NOW - 2 * 3600e3), iso(NOW - 5 * 3600e3), iso(NOW - 5 * 3600e3));
  await run(DB, "INSERT INTO reveal_invite_log (job_id, action, state, guests, created_at) VALUES ('job1', 'created', 'tentative', 9, ?)", iso(NOW - 4 * 3600e3));
  await run(DB, "INSERT INTO broadcasts (id, kid_slug, kid_name) VALUES ('bc1', 'avery', 'Avery')");
  await run(DB, "INSERT INTO broadcast_sends (broadcast_id, kind, channel, recipients, sent, failed, created_at) VALUES ('bc1', 'day', 'push', 12, 12, 0, ?), ('bc1', 'live', 'kit', 0, 1, 0, ?)", iso(NOW - 6 * 3600e3), iso(NOW - 6 * 3600e3));

  const { items } = await activity(env, { now: NOW });
  const by = Object.fromEntries(items.map((r) => [r.entry, r]));
  assert.deepEqual(items.map((r) => r.entry), ['preview', 'app-approved', 'app-resume', 'invite-tentative', 'staff-medical', 'rem-day', 'kit-live'], 'newest first, from every record');
  assert.equal(by['app-resume'].who, 'Jordan Stone (Avery’s family)', 'a family’s address shows their name');
  assert.equal(by['app-resume'].status, 'delivered');
  assert.equal(by['app-approved'].status, 'posted');
  assert.equal(by['app-approved'].link, '#applications/applicants/acc1');
  assert.match(by['staff-medical'].who, /^Staff, on Avery Stone’s JobTread page/);
  assert.equal(by['invite-tentative'].count, 9);
  assert.match(by['rem-day'].who, /^12 people watching for Avery’s reveal/);
  assert.equal(by.preview.to, 'me@example.com');
  assert.ok(!JSON.stringify(items).includes(SECRET.slice(6, 20)));

  const found = await activity(env, { now: NOW, q: 'JORDAN@' });
  assert.deepEqual(found.items.map((r) => r.entry), ['app-approved', 'app-resume'], 'find a person by address');
});

test('Coming up: family emails waiting, application reminders, the next reveal’s reminders, the applications-open email', async () => {
  const DB = await makeDb();
  const env = { DB, RESEND_API_KEY: 're_x', KIT_API_KEY: 'k' };
  await run(DB, "INSERT INTO applicant_notify (account_id, name, status, kind, due_at, updated_at) VALUES ('acc1', 'Avery Stone', 'Approved', 'approved', ?, ?), ('acc2', 'Riley Park', 'Denied', 'denied', ?, ?)", NOW + 20 * MIN, iso(NOW), NOW + 40 * MIN, iso(NOW));
  await run(DB, "UPDATE applicant_notify SET hold = 'pause' WHERE account_id = 'acc2'");
  await run(DB, "INSERT INTO site_config (key, data, updated_at) VALUES ('broadcast', ?, ?), ('broadcast-config', ?, ?)",
    JSON.stringify({ phase: 'scheduled', broadcastId: 'bc2', kidSlug: 'avery', kidName: 'Avery', scheduledAt: iso(NOW + 2 * DAY) }), iso(NOW),
    JSON.stringify({ reminders: { enabled: false, hoursBefore: [24, 1] }, kitLive: { enabled: true } }), iso(NOW));
  await run(DB, "INSERT INTO broadcast_reminders (id, channel, address, kid_slug, token, created_at) VALUES ('r1', 'email', 'a@example.com', 'avery', 't', ?), ('r2', 'push', '{}', NULL, 't', ?)", iso(NOW), iso(NOW));

  const list = await comingUp(env, { now: NOW });
  const at = (entry) => list.find((x) => x.entry === entry);
  assert.equal(at('app-approved').who, 'Avery Stone’s family');
  assert.equal(at('app-denied').held, true, 'a paused one says it’s held');
  assert.equal(at('rem-day').count, 2, 'everyone signed up for this kid or for every reveal');
  assert.equal(at('rem-day').off, true, 'reminders switched off: it says it won’t go');
  assert.match(at('rem-day').note, /switched off/);
  assert.equal(at('rem-day').at, iso(NOW + DAY));
  assert.equal(at('rem-hour').at, iso(NOW + 2 * DAY - 3600e3));
  assert.equal(at('kit-live').at, iso(NOW + 2 * DAY + 3 * MIN), 'Kit’s we’re live, three minutes in');
  assert.ok(list.every((x, i) => i === 0 || list[i - 1].at <= x.at), 'soonest first');
});

test('the map’s delivery numbers are counts only, per message, previews apart', async (t) => {
  offline(t);
  const DB = await makeDb();
  const env = { DB, RESEND_API_KEY: 're_x' };
  await log.logSent(env, [{ id: 'a', to: 'secret.family@example.com', subject: 'You’re on the list' }, { id: 'b', to: 'other.family@example.com', subject: 'You’re on the list' }], { tags: [{ name: 'type', value: 'application-waitlist' }], now: NOW - DAY });
  await log.logSent(env, [{ id: 'c', to: 'me@example.com', subject: '[Preview] You’re on the list' }], { tags: [{ name: 'type', value: 'admin-preview' }], now: NOW - DAY });
  await log.recordEvent(DB, { type: 'email.delivered', data: { email_id: 'a' } });
  await log.recordEvent(DB, { type: 'email.bounced', data: { email_id: 'b', bounce: { type: 'Permanent', subType: 'General' } } });
  const d = await deliveryFacts(env, { now: NOW });
  assert.deepEqual([d.byEntry['waitlist-confirm'].sent, d.byEntry['waitlist-confirm'].delivered, d.byEntry['waitlist-confirm'].bounced], [2, 1, 1]);
  assert.equal(d.all.sent, 2, 'a preview to yourself doesn’t count');
  await log.logSent(env, [{ id: 'w', to: 'third.family@example.com', subject: 'You’re on the list' }], { tags: [{ name: 'type', value: 'application-waitlist' }], now: NOW - 3600e3 });
  const d2 = await deliveryFacts(env, { now: NOW });
  assert.deepEqual([d2.byEntry['waitlist-confirm'].sent, d2.byEntry['waitlist-confirm'].waiting], [3, 1], 'one with no report yet is counted once, as waiting');
  const facts = await gatherFacts(env, { now: NOW });
  assert.ok(facts.delivery?.byEntry, 'the map gets them');
  assert.ok(!JSON.stringify(facts).includes('family@example.com'), 'never an address');
});

test('Will it land? SPF, DKIM and DMARC from public DNS, and the rates', async (t) => {
  const DB = await makeDb();
  const DNS = {
    'send.comms.sunshineonaranneyday.com:TXT': ['"v=spf1 include:amazonses.com ~all"'],
    'send.comms.sunshineonaranneyday.com:MX': ['10 feedback-smtp.us-east-1.amazonses.com.'],
    'resend._domainkey.comms.sunshineonaranneyday.com:TXT': [`"p=${'A'.repeat(200)}"`],
    '_dmarc.comms.sunshineonaranneyday.com:TXT': ['"v=DMARC1; p=none; rua=mailto:owner@example.com"'],
    '_dmarc.sunshineonaranneyday.com:TXT': ['"v=DMARC1; p=none; rua=mailto:x@dmarc-reports.cloudflare.net"'],
    'soardcharity.com:TXT': ['"v=spf1 include:_spf.google.com ~all"'],
    'google._domainkey.soardcharity.com:TXT': [`"v=DKIM1; k=rsa; p=${'B'.repeat(200)}"`],
    'cka._domainkey.soardcharity.com:CNAME': ['dkim.dm-1.sg6.convertkit.com.'],
  'ckespa.soardcharity.com:CNAME': ['spf.dm-1.sg6.convertkit.com.'],
    '_dmarc.soardcharity.com:TXT': ['"v=DMARC1; p=quarantine; rua=mailto:y@dmarc-reports.cloudflare.net"'],
  };
  offline(t, async (url) => {
    const u = new URL(url);
    assert.equal(u.host, 'cloudflare-dns.com');
    const ans = DNS[`${u.searchParams.get('name')}:${u.searchParams.get('type')}`] || [];
    return Response.json({ Status: 0, Answer: ans.map((data) => ({ data })) });
  });
  const h = await deliverability({ DB }, { now: NOW, rates: { sent: 50, waiting: 1, delivered: 47, bounced: 2, complained: 0, failed: 0, suppressed: 0, scheduled: 0, canceled: 0, delayed: 0, opened: 0 } });
  const [resend, google] = h.domains;
  assert.ok(resend.checks.every((c) => c.ok === true), resend.checks.map((c) => `${c.label} ${c.ok}`).join(', '));
  const dmarc = resend.checks.find((c) => c.label === 'DMARC');
  assert.equal(dmarc.ownRecord, true);
  assert.equal(dmarc.reportsToCloudflare, false);
  assert.match(dmarc.note, /not to Cloudflare’s DMARC dashboard/, 'the subdomain’s own record sends its reports elsewhere');
  assert.match(google.checks.find((c) => c.label === 'DMARC').note, /sent to spam/);
  assert.deepEqual([h.rates.deliveredPct, h.rates.bouncePct, h.rates.bounceOk, h.rates.waiting], [95.9, 4.1, false, 1], 'out of the 49 Resend reported on (one still waiting counts neither way); 4.1% bounced is past Resend’s line');
});

test('one email exactly as it went, or why it can’t be shown', async (t) => {
  const DB = await makeDb();
  const env = { DB, RESEND_API_KEY: 're_x' };
  await log.logSent(env, [{ id: 'e1', to: 'jordan@example.com', subject: 'You’re on the list' }], { tags: [{ name: 'type', value: 'application-waitlist' }], now: NOW });
  await log.recordEvent(DB, { type: 'email.delivered', created_at: iso(NOW + MIN), data: { email_id: 'e1' } });
  let answer = Response.json({ object: 'email', id: 'e1', html: '<p>You’re on the list</p>', last_event: 'delivered' });
  offline(t, async () => answer.clone());
  const d = await emailDetail(env, 'e1');
  assert.equal(d.html, '<p>You’re on the list</p>');
  assert.deepEqual(d.events.map((e) => e.type), ['sent', 'delivered']);
  answer = Response.json({ name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }, { status: 401 });
  assert.match((await emailDetail(env, 'e1')).why, /can only send/);
  answer = Response.json({ name: 'not_found' }, { status: 404 });
  assert.match((await emailDetail(env, 'e1')).why, /no longer keeps/);
  assert.equal(await emailDetail(env, 'nope'), null);

  const res = await onRequestGet({ env, request: new Request('https://x/api/messages-admin?email=e1'), data: {} });
  assert.equal(res.status, 200);
});

test('invites out now: how guests answered, counts only, and Kit’s numbers on its “we’re live” email', async (t) => {
  const DB = await makeDb();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const KEY = { client_email: 'reveals@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const env = { DB, GOOGLE_CALENDAR_KEY: JSON.stringify(KEY), KIT_API_KEY: 'kit' };
  clearTokenCache();
  await run(DB, "INSERT INTO site_config (key, data, updated_at) VALUES ('reveal-invites', ?, ?)", JSON.stringify({ enabled: true, organizer: 'organizer@example.com' }), iso(NOW));
  await run(DB, "INSERT INTO kids (slug, data) VALUES ('avery', ?)", JSON.stringify({ name: 'Avery', jobtreadJobId: 'job1' }));
  await run(DB, "INSERT INTO reveal_invites (job_id, event_id, state, reveal_date, guests, updated_at) VALUES ('job1', 'ev1', 'confirmed', '2026-10-29', ?, ?), ('job2', 'ev2', 'tentative', '2026-11-12', ?, ?), ('job0', 'ev0', 'confirmed', '2026-10-01', '[]', ?)",
    JSON.stringify(['a', 'b', 'c', 'd']), iso(NOW), JSON.stringify(['a', 'b']), iso(NOW), iso(NOW));
  await run(DB, "INSERT INTO broadcasts (id, kid_slug, kid_name) VALUES ('bc1', 'avery', 'Avery')");
  await run(DB, 'UPDATE broadcasts SET phase = ? WHERE id = ?', 'replay', 'bc1').catch(() => {});
  await DB.prepare('ALTER TABLE broadcasts ADD COLUMN data TEXT').run();
  await run(DB, "UPDATE broadcasts SET data = ? WHERE id = 'bc1'", JSON.stringify({ kit: { live: { id: 555 } } }));
  await run(DB, "INSERT INTO broadcast_sends (broadcast_id, kind, channel, recipients, sent, failed, created_at) VALUES ('bc1', 'live', 'kit', 0, 1, 0, ?)", iso(NOW - 3600e3));
  offline(t, async (url) => {
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    if (u.pathname.endsWith('/events/ev1')) return Response.json({ id: 'ev1', attendees: [
      { email: 'organizer@example.com', organizer: true, responseStatus: 'accepted' },
      { email: 'a@example.com', responseStatus: 'accepted' }, { email: 'b@example.com', responseStatus: 'accepted' },
      { email: 'c@example.com', responseStatus: 'declined' }, { email: 'd@example.com', responseStatus: 'needsAction' },
    ] });
    if (u.pathname.endsWith('/events/ev2')) return Response.json({ id: 'ev2', attendees: [{ email: 'a@example.com', responseStatus: 'needsAction' }, { email: 'b@example.com', responseStatus: 'needsAction' }] });
    if (u.hostname === 'api.kit.com') return Response.json({ broadcast: { stats: { status: 'completed', recipients: 1240, emails_opened: 471, open_rate: 38 } } });
    throw new Error(`offline: ${url}`);
  });
  const out = await invitesOut(env, { now: NOW });
  assert.deepEqual(out.map((v) => [v.kid, v.state, v.guests, v.answers]), [
    ['Avery', 'confirmed', 4, { yes: 2, no: 1, maybe: 0, waiting: 1 }],
    [null, 'tentative', 2, { yes: 0, no: 0, maybe: 0, waiting: 2 }],
  ], 'upcoming only, the organizer left out, soonest first');
  assert.ok(!JSON.stringify(out).includes('@example.com'), 'never who');

  const { items } = await activity(env, { now: NOW });
  const kit = items.find((r) => r.entry === 'kit-live');
  assert.deepEqual(kit.kit, { recipients: 1240, opened: 471, openRate: 38 }, 'Kit’s own numbers');
});

test('the one-time proof: Resend’s test addresses, and both reports back through the webhook', async (t) => {
  const DB = await makeDb();
  const env = { DB, RESEND_API_KEY: 're_x' };
  const ENDPOINT = 'https://sunshineonaranneyday.com/api/resend-webhook';
  await DB.prepare('CREATE TABLE IF NOT EXISTS email_tracking (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)').run();
  await DB.prepare('INSERT INTO email_tracking (key, value, updated_at) VALUES (?, ?, ?)').bind('webhook', JSON.stringify({ id: 'wh', secret: SECRET, endpoint: ENDPOINT }), iso(NOW)).run();
  const sent = [];
  offline(t, async (url, init) => {
    if (url === 'https://api.resend.com/webhooks/wh') return Response.json({ object: 'webhook', id: 'wh', status: 'enabled' });
    if (url.startsWith('https://api.resend.com/emails?limit=100')) return Response.json({ object: 'list', has_more: false, data: [] });
    if (url === 'https://api.resend.com/emails/batch') { const b = JSON.parse(init.body); sent.push(...b); return Response.json({ data: b.map((_, i) => ({ id: `st_${i}` })) }); }
    throw new Error(`offline: ${url}`);
  });
  const t0 = Date.now();
  await log.maybeTrackEmails(env, { now: t0 });
  assert.deepEqual(sent.map((m) => m.to[0]), ['delivered@resend.dev', 'bounced@resend.dev'], 'only Resend’s test addresses');
  assert.equal((await log.trackingState(env)).selfTest.result, 'waiting');
  assert.equal(log.entryFor('email-self-test', '[Test] Delivery reports check'), 'preview', 'shown with previews and tests, never alerting anyone');

  // Resend reports both, through the webhook
  const ctx = (request) => ({ env, request, waitUntil: null });
  await webhook(ctx(await signed({ type: 'email.delivered', created_at: iso(Date.now()), data: { email_id: 'st_0' } }, { id: 'm1' })));
  await webhook(ctx(await signed({ type: 'email.bounced', created_at: iso(Date.now()), data: { email_id: 'st_1', bounce: { type: 'Permanent', subType: 'General' } } }, { id: 'm2' })));
  const r = await log.maybeTrackEmails(env, { now: t0 + 31 * MIN });
  assert.equal(r.state, 'on');
  const st = await log.trackingState(env);
  assert.equal(st.selfTest.result, 'passed');
  assert.ok(st.lastWebhookAt);
  await log.maybeTrackEmails(env, { now: t0 + 62 * MIN });
  assert.equal(sent.length, 2, 'once, ever');

  // A webhook Resend never reaches: after two hours it says so
  const DB2 = await makeDb();
  const env2 = { DB: DB2, RESEND_API_KEY: 're_x' };
  await DB2.prepare('CREATE TABLE IF NOT EXISTS email_tracking (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)').run();
  await DB2.prepare('INSERT INTO email_tracking (key, value, updated_at) VALUES (?, ?, ?)').bind('webhook', JSON.stringify({ id: 'wh', secret: SECRET, endpoint: ENDPOINT }), iso(NOW)).run();
  await log.maybeTrackEmails(env2, { now: t0 });
  const bad = await log.maybeTrackEmails(env2, { now: t0 + 2 * 3600e3 + MIN });
  assert.equal(bad.state, 'error');
  assert.match(bad.error, /never reached \/api\/resend-webhook/);
  assert.equal((await log.trackingState(env2)).selfTest.result, 'failed');
  // Then Resend gets through (say the endpoint was fixed): the next check clears it
  await webhook({ env: env2, request: await signed({ type: 'email.delivered', created_at: iso(Date.now()), data: { email_id: 'st_0' } }, { id: 'm9', at: Date.now() }), waitUntil: null });
  await DB2.prepare("UPDATE email_tracking SET value = json_set(value, '$.at', ?) WHERE key = 'webhook-seen'").bind(iso(t0 + 3 * 3600e3)).run();
  const fixed = await log.maybeTrackEmails(env2, { now: t0 + 3 * 3600e3 + 2 * MIN });
  assert.equal(fixed.state, 'on', 'a report through the webhook since proves it works');
});
