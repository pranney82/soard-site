/**
 * Site → Emails & invites (functions/api/messages-admin.js, public/admin/messages.js):
 * every message on the map with a preview builds it with the code that sends
 * it (in Spanish too where families get Spanish), the live facts carry times
 * and counts but never an address or a family's name, "Send it to me" goes
 * only to the person signed in, and the map's live checks read the facts right.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { gatherFacts, buildPreview, onRequestGet, onRequestPost } from '../functions/api/messages-admin.js';
import { ensureCommsSchema } from '../functions/api/_applicant-comms.js';
import { ensureNotifySchema } from '../functions/api/_applicant-notify.js';
import { ensureFormSchema } from '../functions/api/_application-forms.js';
import { ensureSchema as ensureInviteSchema } from '../functions/api/_reveal-invites.js';
import { ensureSchema as ensureApplicationSchema } from '../functions/api/_applications.js';
import { ensureWaitlistSchema } from '../functions/api/_application-waitlist.js';
import { ensureRequests } from '../functions/api/_profile-requests.js';
import { ENTRIES, applyFacts, sendersOf } from '../public/admin/messages.js';

const NOW = Date.parse('2026-10-21T15:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const DAY = 864e5;
const SECRET_NAME = 'Riley Secretfamily';

async function makeDb() {
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
    'CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)',
    'CREATE TABLE kid_status_state (key TEXT PRIMARY KEY, value TEXT)',
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, data TEXT)',
    // _broadcast.js sets its tables up once per process, so a second test DB needs them here
    'CREATE TABLE broadcast_sends (id INTEGER PRIMARY KEY AUTOINCREMENT, broadcast_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL, recipients INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, error TEXT, created_at TEXT)',
    'CREATE TABLE broadcast_reminders (id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, subscription TEXT, kid_slug TEXT, token TEXT NOT NULL, source TEXT, created_at TEXT, unsubscribed_at TEXT, last_sent_at TEXT)',
  ] });
  const ensure = [ensureCommsSchema, ensureNotifySchema, ensureFormSchema, ensureInviteSchema, ensureApplicationSchema, ensureWaitlistSchema, ensureRequests];
  for (const fn of ensure) await fn(DB);
  const run = (sql, ...b) => DB.prepare(sql).bind(...b).run();
  const put = (key, data) => run('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)', key, JSON.stringify(data), iso(0));
  await put('broadcast-config', { reminders: { enabled: false, sms: false, push: false, hoursBefore: [24, 1] }, kitLive: { enabled: true }, alerts: { emails: ['alerts@example.com'] } });
  await put('reveal-invites', { enabled: true, organizer: 'organizer@example.com', alertEmails: ['invites@example.com'] });
  await put('settings', { application: { open: false, year: '2027' } });
  await run("INSERT INTO applicant_comms (account_id, kind, state, created_at, updated_at) VALUES ('a1', 'welcome', 'sent', ?, ?)", iso(2 * DAY), iso(2 * DAY));
  await run("INSERT INTO applicant_comms (account_id, kind, state, created_at, updated_at) VALUES ('a2', 'welcome', 'sent', ?, ?)", iso(40 * DAY), iso(40 * DAY));
  await run("INSERT INTO applicant_comms (account_id, kind, state, created_at, updated_at) VALUES ('a3', 'welcome', 'failed', ?, ?)", iso(DAY), iso(DAY));
  await run("INSERT INTO applicant_comms (account_id, kind, state, created_at, updated_at) VALUES ('a1', 'inReview', 'sent', ?, ?)", iso(3600e3), iso(3600e3));
  // A family waiting for its Approved email: its name must never leave
  await run("INSERT INTO applicant_notify (account_id, name, status, kind, due_at, updated_at, by_email) VALUES ('a4', ?, 'Approved', 'approved', ?, ?, 'staff@example.com')", SECRET_NAME, NOW + 20 * 60e3, iso(0));
  await run("INSERT INTO waitlist_signups (email, lang, page, created_at, updated_at, confirmed_at) VALUES ('family@example.com', 'en', 'apply', ?, ?, ?)", iso(DAY), iso(DAY), iso(DAY));
  await run("INSERT INTO reveal_board_emails (slug, email, updated_at) VALUES ('ann', 'board@example.com', ?)", iso(0));
  await run("INSERT INTO reveal_invites (job_id, state, error, updated_at) VALUES ('j1', 'tentative', NULL, ?), ('j2', 'confirmed', 'Google returned 503', ?)", iso(0), iso(0));
  await run("INSERT INTO reveal_invite_log (job_id, action, state, guests, created_at) VALUES ('j1', 'created', 'tentative', 9, ?)", iso(5 * DAY));
  await run("INSERT INTO broadcast_reminders (id, channel, address, token, created_at) VALUES ('r1', 'email', 'fan@example.com', 't', ?)", iso(DAY));
  await run("INSERT INTO audit_log (entity_type, created_at, user_email) VALUES ('email-broadcast', '2026-10-01 12:00:00', 'staff@example.com')");
  return DB;
}

const ENV = (DB, more = {}) => ({ DB, RESEND_API_KEY: 'resend', KIT_API_KEY: 'kit', GOOGLE_CALENDAR_KEY: 'g', JOBTREAD_GRANT_KEY: 'jt', ...more });
// Outside services are never reached in these tests unless a test says so
function offline(t, handler = null) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (handler) return handler(String(url), init);
    throw new Error(`offline: ${url}`);
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

test('every message on the map with a preview builds, in Spanish too where families get it', async (t) => {
  offline(t);
  const env = ENV(await makeDb());
  const withPreview = ENTRIES.filter((n) => n.preview);
  assert.ok(withPreview.length >= 30, `the map has its previews (${withPreview.length})`);
  for (const n of withPreview) {
    for (const lang of n.spanish ? ['en', 'es'] : ['en']) {
      const p = await buildPreview(env, n.preview, { lang, me: 'me@example.com', now: NOW });
      assert.ok(p, `${n.t} has a preview`);
      assert.ok(p.from && p.to, `${n.t} says who it's from and to`);
      const sms = Array.isArray(p.sms) ? p.sms.map((x) => x.text).join('\n') : p.sms;
      const shown = p.html || p.text || sms || p.invite?.description;
      assert.ok(shown && shown.length > 30, `${n.t} (${lang}) shows the message`);
      if (p.channel !== 'text') assert.ok(p.subject, `${n.t} has a subject`);
      assert.ok(!/\{(parent|child|name|space|date|year|kid)\}/.test(`${p.subject} ${shown}`), `${n.t} (${lang}) has no unfilled placeholder`);
    }
  }
  const es = await buildPreview(env, 'app-approved', { lang: 'es', now: NOW });
  assert.equal(es.subject, 'Decisión sobre la solicitud');
  assert.match(es.text, /aprobada/);
  const invite = await buildPreview(env, 'invite-confirmed', { now: NOW });
  assert.equal(invite.invite.status, 'confirmed');
  assert.equal(invite.invite.start.dateTime, '2026-10-28T16:00:00', 'a sample reveal a week out at 4 PM Eastern');
  assert.ok(invite.invite.busy);
  const tentative = await buildPreview(env, 'invite-tentative', { now: NOW });
  assert.deepEqual(tentative.invite.start, { date: '2026-10-28' }, 'the save-the-date is all day');
  const reminder = await buildPreview(env, 'rem-day', { now: NOW });
  assert.ok(reminder.push?.title && !reminder.sms, 'a reminder shows its browser alert too, and never a text: the public is never texted');
  const alert = await buildPreview(env, 'staff-live-alert', { now: NOW });
  assert.match(alert.sms, /^⏰ SOARD ALERT: Scheduled reveal never went live\n/, 'the staff alert shows its text, as an alert');
  assert.match((await buildPreview(env, 'staff-alert-hello-text', { now: NOW })).sms, /Reply STOP to opt out/);
  assert.equal(await buildPreview(env, 'nope', { now: NOW }), null);
});

test('live facts: times and counts, never an address or a family’s name', async (t) => {
  offline(t);
  const DB = await makeDb();
  const f = await gatherFacts(ENV(DB), { now: NOW });
  const all = JSON.stringify(f);
  assert.ok(!/@example\.com/.test(all), 'no address');
  assert.ok(!all.includes(SECRET_NAME), 'no family name');
  assert.deepEqual(f.family.comms.welcome, { last: iso(2 * DAY), n30: 1, total: 2 }, 'only sent ones count, 30 days and in all');
  assert.equal(f.family.comms.inReview.n30, 1);
  assert.equal(f.family.waiting.approved.n, 1, 'an email waiting to go');
  assert.equal(f.invites.problems, 1);
  assert.equal(f.invites.boardEmails, 1);
  assert.equal(f.invites.tentative.total, 1);
  assert.equal(f.reminders.enabled, false);
  assert.equal(f.reminders.alertEmails, 1);
  assert.equal(f.waitlist.confirmations.total, 1);
  assert.equal(f.newsletter, undefined, 'newsletters are written in Kit: the map keeps no count of them');
  assert.equal(f.env.resend, true);
  assert.equal(f.env.twilio, false);
});

test('one missing table never blanks the rest', async (t) => {
  offline(t);
  const DB = await makeDb();
  await DB.prepare('DROP TABLE applicant_comms').run();
  const f = await gatherFacts(ENV(DB), { now: NOW });
  assert.equal(f.family, null, 'the family emails can’t say');
  assert.ok(f.invites && f.reminders && f.waitlist, 'everything else still answers');
});

test('the map’s live checks read the facts', async (t) => {
  offline(t);
  const DB = await makeDb();
  const f = await gatherFacts(ENV(DB), { now: NOW });
  const by = (title) => ENTRIES.find((n) => n.t === title);
  applyFacts(f);
  assert.equal(by('Save the date').es, 'off', 'reminders switched off');
  assert.match(by('Save the date').probe.why, /switched off/);
  assert.equal(by('Welcome to alert texts').es, 'off', 'no Twilio, no texts');
  assert.equal(by('Application received').es, 'live');
  assert.match(by('Application received').probe.why, /1 in the last 30 days, 2 in all/);
  assert.match(by('Approved').probe.why, /1 email is waiting to go/);
  assert.equal(by('Save-the-date invite').es, 'attn', 'an invite with a problem');
  assert.equal(by('Invite problem').es, 'attn');
  // A pause holds the family emails; no Resend key needs a hand
  applyFacts({ ...f, pause: { active: true, until: new Date(NOW + 3600e3).toISOString(), by: 'peter', held: 2 }, env: { ...f.env, resend: false } });
  assert.equal(by('In review').es, 'off');
  assert.match(by('In review').probe.why, /paused until .* 2 emails are held/);
  assert.equal(by('Pick up where you left off').es, 'attn');
  assert.equal(by('New application').es, 'attn');
  // The live check failed: the written statuses stand
  applyFacts(null);
  assert.ok(ENTRIES.every((n) => n.es === n.s));
});

test('Send it to me: only to the person signed in, marked [Preview]', async (t) => {
  const sent = [];
  offline(t, async (url, init) => {
    if (url.startsWith('https://api.resend.com/')) {
      sent.push(JSON.parse(init.body));
      return Response.json([{ id: 'x' }]);
    }
    throw new Error(`offline: ${url}`);
  });
  const DB = await makeDb();
  const post = (body, data = { userEmail: 'me@example.com' }, env = ENV(DB)) => onRequestPost({ env, data, request: new Request('https://x/api/messages-admin', { method: 'POST', body: JSON.stringify(body) }) });

  const r = await post({ send: 'staff-new-app' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { success: true, sentTo: 'me@example.com', kind: 'email' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((m) => m.to), [['me@example.com']], 'one copy, to you only');
  assert.match(sent[0][0].subject, /^\[Preview\] New makeover application: Avery$/);

  const es = await post({ send: 'waitlist-confirm', lang: 'es' });
  assert.equal(es.status, 200);
  assert.match(sent[1][0].subject, /^\[Preview\] Ya está en la lista$/);

  assert.equal((await post({ send: 'app-approved' })).status, 400, 'JobTread sends the status emails; no copy from here');
  assert.equal((await post({ send: 'staff-alert-hello-text' })).status, 503, 'a text needs Twilio');
  assert.equal((await post({ send: 'nope' })).status, 404);
  assert.equal((await post({ send: 'staff-new-app' }, {})).status, 403, 'nobody signed in, nothing sent');
  assert.equal((await post({ send: 'staff-new-app' }, undefined, ENV(DB, { RESEND_API_KEY: '' }))).status, 503);
  assert.equal((await post({ send: 'invite-tentative' }, undefined, ENV(DB, { GOOGLE_CALENDAR_KEY: '' }))).status, 503);
  assert.equal(sent.length, 2, 'nothing else went');
});

test('GET: facts, or one preview', async (t) => {
  offline(t);
  const DB = await makeDb();
  const get = (q = '') => onRequestGet({ env: ENV(DB), data: { userEmail: 'me@example.com' }, request: new Request(`https://x/api/messages-admin${q}`) });
  const facts = await (await get()).json();
  assert.equal(facts.success, true);
  assert.ok(facts.checkedAt);
  const r = await get('?preview=rem-live');
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  const p = await r.json();
  assert.equal(p.success, true);
  assert.equal(p.subject, "We're live: Avery's room reveal");
  assert.equal((await get('?preview=nope')).status, 404);
});

test('every message says who sends it: Resend, JobTread, Kit, Google Calendar, Twilio, the browser, Slack or your own email', () => {
  const KNOWN = new Set(['resend', 'jobtread', 'kit', 'google', 'twilio', 'push', 'slack', 'you']);
  for (const n of ENTRIES) {
    const s = sendersOf(n);
    assert.ok(s.length && s.every((x) => KNOWN.has(x)), `${n.t} has a known sender (${s.join(', ')})`);
  }
  const by = (title) => sendersOf(ENTRIES.find((n) => n.t === title));
  assert.deepEqual(by('Application received'), ['jobtread'], 'family status emails come from JobTread');
  assert.deepEqual(by('Approved'), ['jobtread']);
  assert.deepEqual(by('Pick up where you left off'), ['resend']);
  assert.deepEqual(by('Applications are open'), ['kit', 'resend'], 'Kit, with Resend for families Kit can’t reach');
  assert.deepEqual(by('We’re live (Kit)'), ['kit']);
  assert.deepEqual(by('Save the date'), ['resend', 'push'], 'the public is never texted');
  assert.deepEqual(by('Live reveal alerts'), ['resend', 'twilio'], 'staff alerts also text the staff numbers');
  assert.deepEqual(by('Confirmed invite'), ['google']);
  assert.deepEqual(by('New application'), ['resend']);
  assert.deepEqual(by('Bio request'), ['you']);
  assert.deepEqual(by('Child’s medical condition'), ['jobtread'], 'an internal note is still JobTread');
  assert.deepEqual(by('New gift'), ['slack'], 'a Slack-only post says so');
});

test('Text it to me: the reveal-day texts, in order, only to a number on the alert list', async (t) => {
  const texts = [];
  offline(t, async (url, init) => {
    if (url.startsWith('https://api.twilio.com/')) { texts.push({ to: init.body.get('To'), body: init.body.get('Body'), cb: init.body.get('StatusCallback') }); return Response.json({ sid: `SM${texts.length}` }, { status: 201 }); }
    throw new Error(`offline: ${url}`);
  });
  const DB = await makeDb();
  await DB.prepare("UPDATE site_config SET data = ? WHERE key = 'broadcast-config'").bind(JSON.stringify({ alerts: { emails: [], phones: ['+14045550123', '+16785550199'] } })).run();
  const env = ENV(DB, { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG1' });
  const get = async (id) => (await onRequestGet({ env, data: { userEmail: 'me@example.com' }, request: new Request(`https://x/api/messages-admin?preview=${id}`) })).json();
  const post = (body) => onRequestPost({ env, data: { userEmail: 'me@example.com' }, request: new Request('https://x/api/messages-admin', { method: 'POST', body: JSON.stringify(body) }) });

  const p = await get('staff-reveal-texts');
  assert.deepEqual(p.textTo, [{ i: 0, last4: '0123' }, { i: 1, last4: '0199' }], 'the alert numbers by their last 4 digits only');
  assert.equal(p.texting, true);
  assert.deepEqual(p.sms.map((x) => x.text.split('\n')[0]), [
    "🟢 SOARD: Go: Avery's room reveal at 4:00 PM", "📡 SOARD: Live now: Avery's room reveal", "🟢 SOARD: All green: Avery's room reveal",
    '🚨 SOARD ALERT: Reveal audio is silent', '✅ SOARD FIXED: Reveal audio is back',
  ], 'reveal day, with a hiccup, as the phone would show it: a picture first');
  const bad = await get('staff-problem-texts');
  assert.ok(bad.sms.every((x) => /^(🚨|⚠️|⏰) SOARD ALERT: /.test(x.text)), 'every problem text reads as an alert, picture first');
  assert.ok(bad.sms.every((x) => !/ERR_|\{|\}/.test(x.text)), 'plain words: no error codes, no placeholders');
  assert.ok([...p.sms, ...bad.sms].every((x) => /^\S+ [\x20-\x7E\n]+$/u.test(x.text) && x.text.length <= 306), 'a picture, then plain characters, never longer than 306');

  const r = await post({ send: 'staff-reveal-texts', to: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { success: true, sentTo: 'the number ending 0199', kind: 'text', count: 5, failed: 0, error: null });
  assert.deepEqual(texts.map((x) => x.to), Array(5).fill('+16785550199'), 'only the number picked');
  assert.ok(texts.every((x) => /^\[Preview\] \S+ SOARD/u.test(x.body)), 'each marked [Preview]');
  assert.equal(texts[3].body.split('\n')[0], '[Preview] 🚨 SOARD ALERT: Reveal audio is silent', 'in the order they arrive');
  assert.equal(texts[0].cb, 'https://sunshineonaranneyday.com/api/twilio-status', 'Twilio reports whether each arrived');

  assert.equal((await post({ send: 'staff-reveal-texts', to: 2 })).status, 400, 'no number beyond the list');
  assert.equal((await post({ send: 'staff-reveal-texts', to: 'x' })).status, 400);
  assert.equal((await post({ send: 'staff-reveal-texts', to: '+15555550100' })).status, 400, 'never a number typed in');
  assert.equal(texts.length, 5, 'nothing else went');
});
