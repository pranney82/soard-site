/**
 * The application limit (Admin → Applications → Settings → Application limit):
 * counting, the team's heads-up near it, closing by itself at it, refusing to
 * open a full season, and what families see. functions/api/_application-cap.js,
 * its hooks in _applications.js, apply.js (submit) and applications-admin.js.
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld } from './lib/fake-applicant-world.mjs';
import { renderSlack, slackButtons } from './lib/slack-render.mjs';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import {
  ensureSchema, pickApplication, cleanApplicationSettings, saveApplicationSettings, runApplicationSchedule,
  enforceApplicationCap, maybeSweepApplications, applicationSettingsHistory,
} from '../functions/api/_applications.js';
import {
  capOf, capFacts, countReceived, countFilling, seasonFull, fullMessageOf, defaultFullMessage, capCard, capEmail,
  paceWords, fillsInWords, claimWarning,
} from '../functions/api/_application-cap.js';
import * as adminApi from '../functions/api/applications-admin.js';
import { t } from '../src/components/apply/application-render.js';

const NOW = Date.parse('2026-10-21T15:00:00Z');
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const YEAR = '2027';
const NEWS = 'C0NEWS';
const ATTN = 'C0ATTN';

let w;
let env;
let DB;
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

beforeEach(async () => {
  w = fakeApplicantWorld();
  DB = await createD1();
  env = { ...w.env, DB, SLACK_BOT_TOKEN: 'xoxb-test' };
  delete env.SLACK_WEBHOOK_URL;
  globalThis.fetch = w.fetchImpl;
  await DB.exec('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await DB.exec('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  await ensureSchema(DB);
  await writeSlackConfig(DB, { channel: { id: NEWS, name: 'team-everyone' }, attention: { id: ATTN, name: 'website-alerts' } });
  await setApplication({ open: true, year: YEAR, maxApplications: 10, openChangedAt: new Date(NOW - 3 * DAY).toISOString(), openChangedBy: 'peter@soardcharity.com' });
});

async function setApplication(application) {
  await DB.prepare("INSERT OR REPLACE INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ social: { x: 1 }, application })).run();
}
const stored = async () => JSON.parse((await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first()).data).application;

let seq = 0;
/** n applications in for a season (real unless told otherwise), each an hour apart going back from `at` */
async function addApps(n, { year = YEAR, test = false, deleted = false, at = NOW - HOUR } = {}) {
  for (let i = 0; i < n; i++) {
    const t0 = new Date(at - i * HOUR).toISOString();
    seq += 1;
    await DB.prepare(`INSERT INTO applications (id, year, is_test, status, submitted_at, updated_at, deleted_at) VALUES (?, ?, ?, 'done', ?, ?, ?)`)
      .bind(`app-test${String(seq).padStart(4, '0')}-abcdef`, year, test ? 1 : 0, t0, t0, deleted ? t0 : null).run();
  }
}
async function addDrafts(n, { year = YEAR, updated = NOW - HOUR, stop = null, ip = 'iphash' } = {}) {
  for (let i = 0; i < n; i++) {
    seq += 1;
    const at = new Date(updated).toISOString();
    await DB.prepare('INSERT INTO application_drafts (id, year, answers, files, ip_hash, stop_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`${String(seq).padStart(32, '0')}`, year, '{}', '{}', ip, stop, at, at).run();
  }
}
const posts = () => w.world.slack.map(b => ({ channel: b.channel, text: renderSlack(b), body: b }));
const emails = () => w.world.emails;

// ── The numbers ─────────────────────────────────────────────────────

test('the limit and the heads-up point: 80% unless set, never at or past the limit', () => {
  assert.deepEqual(capOf({ maxApplications: 100 }), { max: 100, warnAt: 80, custom: false });
  assert.deepEqual(capOf({ maxApplications: 100, warnAt: 90 }), { max: 100, warnAt: 90, custom: true });
  assert.deepEqual(capOf({ maxApplications: 100, warnAt: 100 }), { max: 100, warnAt: 80, custom: false }, 'a heads-up at the limit is no heads-up');
  assert.deepEqual(capOf({ maxApplications: 0, warnAt: 5 }), { max: 0, warnAt: 0, custom: false }, 'no limit, no heads-up');
  assert.equal(capOf({ maxApplications: '1,000' }).max, 1000, 'a comma is fine');
  assert.equal(capOf({ maxApplications: 1 }).warnAt, 1, 'a limit of one: the close is the only notice');
});

test('settings: the limit is stored as numbers, blank means no limit, and nonsense is refused', () => {
  const picked = pickApplication({ open: true, year: YEAR, maxApplications: '120', warnAt: '100', fullMessage: '  Full!  ' }, NOW);
  assert.equal(picked.maxApplications, 120);
  assert.equal(picked.warnAt, 100);
  assert.equal(picked.fullMessage, 'Full!');
  assert.equal(pickApplication({ warnAt: 5 }, NOW).warnAt, 0, 'a heads-up without a limit means nothing');
  assert.equal(cleanApplicationSettings({ maxApplications: '' }, { now: NOW }).errors.length, 0);
  assert.equal(cleanApplicationSettings({ maxApplications: 'lots' }, { now: NOW }).errors[0].field, 'maxApplications');
  assert.equal(cleanApplicationSettings({ maxApplications: 2.5 }, { now: NOW }).errors[0].field, 'maxApplications');
  const over = cleanApplicationSettings({ maxApplications: 50, warnAt: 60 }, { now: NOW });
  assert.equal(over.errors[0].field, 'warnAt');
  assert.match(over.errors[0].error, /under the limit of 50/);
  assert.equal(cleanApplicationSettings({ maxApplications: 50, warnAt: '' }, { now: NOW }).settings.warnAt, 0, 'blank heads-up: the built-in 80%');
});

test('counting: real applications for the season only; partway families are the 14-day "still working on it"', async () => {
  await addApps(4);
  await addApps(2, { test: true });
  await addApps(1, { deleted: true });
  await addApps(3, { year: '2026' });
  assert.equal(await countReceived(DB, YEAR), 4, 'tests, deleted and other seasons left out');
  await addDrafts(3);
  await addDrafts(1, { stop: 'rental' });
  await addDrafts(1, { updated: NOW - 20 * DAY });
  await addDrafts(1, { ip: 'admin' });
  assert.equal(await countFilling(DB, YEAR, NOW), 3, 'stopped, gone quiet and staff drafts left out');
  const f = await capFacts(DB, pickApplication(await stored(), NOW), { now: NOW, openedAt: (await stored()).openChangedAt });
  assert.equal(f.received, 4);
  assert.equal(f.left, 6);
  assert.equal(f.filling, 3);
  assert.equal(f.percent, 40);
  assert.equal(f.full, false);
  // 4 in the 3 days since it opened
  assert.equal(f.perDay, 1.3);
  assert.equal(paceWords(f), 'about 1 a day this week');
  assert.equal(fillsInWords(f), 'in about 5 days');
});

test('the pace waits for three applications and reads per week when slow', () => {
  assert.equal(paceWords({ perDay: null }), null);
  assert.equal(paceWords({ perDay: 0.4 }), 'about 3 a week');
  assert.equal(paceWords({ perDay: 6.2 }), 'about 6 a day this week');
  assert.equal(fillsInWords({ fillsInDays: 0.4 }), 'within a day');
  assert.equal(fillsInWords({ fillsInDays: 200 }), null, 'months away is no forecast');
  assert.equal(fillsInWords({ fillsInDays: 3, full: true }), null);
});

// ── The heads-up ────────────────────────────────────────────────────

test('the team hears once when it nears the limit, in Good news and by email to the staff list', async () => {
  await addApps(7);
  assert.equal(await enforceApplicationCap(env, { now: NOW }), null, '7 of 10: not yet');
  assert.equal(w.world.slack.length, 0);
  await addApps(1, { at: NOW - 60e3 });
  await addDrafts(2);
  assert.deepEqual(await enforceApplicationCap(env, { now: NOW }), { warned: true });
  const [p] = posts();
  assert.equal(p.channel, NEWS, 'good news, for everyone');
  assert.match(p.text, /8 of 10 applications are in for 2027/);
  assert.match(p.text, /2 more until the limit\. When the 10th one comes in, applications close by themselves\./);
  assert.match(p.text, /2 families are partway through the form right now/);
  assert.match(p.text, /Still filling it out: 2 families/);
  assert.match(p.text, /To take more, raise the limit in Applications → Settings\./);
  assert.deepEqual(slackButtons(p.body).map(b => b.url), ['https://sunshineonaranneyday.com/admin/#applications/settings', 'https://sunshineonaranneyday.com/admin/#applications']);
  assert.equal(emails().length, 1);
  assert.deepEqual(emails()[0].to, ['selection@soardcharity.com'], 'the staff list in Settings');
  assert.equal(emails()[0].subject, '8 of 10 applications are in for 2027');
  await addApps(1, { at: NOW - 30e3 });
  assert.equal(await enforceApplicationCap(env, { now: NOW }), null, '9 of 10: already told');
  assert.equal(w.world.slack.length, 1);
  assert.equal(emails().length, 1);
  const note = JSON.parse((await DB.prepare("SELECT value FROM application_runtime WHERE key = 'cap-notice'").first()).value);
  assert.deepEqual({ kind: note.kind, received: note.received, max: note.max }, { kind: 'warn', received: 8, max: 10 });
});

test('a higher limit brings a new heads-up at its own point', async () => {
  await addApps(8);
  await enforceApplicationCap(env, { now: NOW });
  assert.equal(w.world.slack.length, 1);
  await saveApplicationSettings(env, { maxApplications: 20 }, { user: 'peter@soardcharity.com', now: NOW });
  assert.equal(await enforceApplicationCap(env, { now: NOW }), null, '8 of 20');
  await addApps(8, { at: NOW - 60e3 });
  assert.deepEqual(await enforceApplicationCap(env, { now: NOW }), { warned: true }, '16 of 20');
  assert.match(posts()[1].text, /16 of 20 applications are in/);
});

test('the heads-up point is claimed once, even by two checks at the same moment', async () => {
  const both = await Promise.all([claimWarning(DB, YEAR, 8, NOW), claimWarning(DB, YEAR, 8, NOW)]);
  assert.deepEqual(both.sort(), [false, true]);
  assert.equal(await claimWarning(DB, YEAR, 8, NOW), false);
  assert.equal(await claimWarning(DB, YEAR, 16, NOW), true, 'a higher point claims again');
  assert.equal(await claimWarning(DB, '2028', 8, NOW), true, 'each season has its own');
});

// ── At the limit ────────────────────────────────────────────────────

test('at the limit applications close by themselves, logged as the limit, and the team hears', async () => {
  await addApps(10);
  await addDrafts(3);
  assert.deepEqual(await enforceApplicationCap(env, { now: NOW }), { closed: true });
  const s = await stored();
  assert.equal(s.open, false);
  assert.equal(s.openChangedBy, 'limit');
  assert.equal(s.openChangedAt, new Date(NOW).toISOString());
  assert.equal(s.maxApplications, 10, 'the limit stays');
  const log = await DB.prepare('SELECT user_email, entity_name FROM audit_log ORDER BY id DESC').first();
  assert.deepEqual({ ...log }, { user_email: 'limit', entity_name: 'Applications closed' });
  const history = await applicationSettingsHistory(DB);
  assert.equal(history[0].by, 'limit');
  const [p] = posts();
  assert.equal(p.channel, NEWS);
  assert.match(p.text, /Applications are closed for 2027: the limit of 10 is reached/);
  assert.match(p.text, /The 10th application came in, so applications closed by themselves at 11:00 AM\./);
  assert.match(p.text, /New families now see: “We’ve received all the applications we can take for 2027\.”/);
  assert.match(p.text, /Still filling it out: 3 families can still finish and send theirs/);
  assert.match(p.text, /raise the limit in Applications → Settings and open applications again/);
  assert.equal(emails()[0].subject, 'Applications are closed for 2027: the limit of 10 is reached');
  assert.equal(await enforceApplicationCap(env, { now: NOW + 60e3 }), null, 'closed now: nothing more');
  assert.equal(w.world.slack.length, 1);
});

test('two submits landing at the limit together close it once and send one notice', async () => {
  await addApps(10);
  const out = await Promise.all([enforceApplicationCap(env, { now: NOW }), enforceApplicationCap(env, { now: NOW })]);
  assert.equal(out.filter(o => o?.closed).length, 1);
  assert.equal(w.world.slack.length, 1);
  assert.equal(emails().length, 1);
});

test('the families\' message comes from Settings when staff wrote one', async () => {
  await setApplication({ ...(await stored()), fullMessage: 'Thank you! Our 2027 list is full.' });
  await addApps(10);
  await enforceApplicationCap(env, { now: NOW });
  assert.match(posts()[0].text, /New families now see: “Thank you! Our 2027 list is full\.”/);
  assert.equal(fullMessageOf({ year: YEAR }), defaultFullMessage(YEAR));
});

test('no limit, or closed: nothing is checked or sent', async () => {
  await setApplication({ open: true, year: YEAR });
  await addApps(50);
  assert.equal(await enforceApplicationCap(env, { now: NOW }), null);
  await setApplication({ open: false, year: YEAR, maxApplications: 10 });
  assert.equal(await enforceApplicationCap(env, { now: NOW }), null);
  assert.equal(w.world.slack.length, 0);
  assert.equal(await enforceApplicationCap({}, { now: NOW }), null, 'no database: no throw');
});

test('the sweep is the backup when a submit\'s own check never ran', async () => {
  await addApps(10);
  const out = await maybeSweepApplications(env, { now: NOW, force: true, fetchImpl: w.fetchImpl });
  assert.deepEqual(out.capped, { closed: true });
  assert.equal((await stored()).open, false);
});

// ── Opening a full season ───────────────────────────────────────────

test('a full season can\'t be opened (now or on a schedule) until the limit goes up', async () => {
  await addApps(10);
  await enforceApplicationCap(env, { now: NOW });
  const refused = await saveApplicationSettings(env, { open: true }, { user: 'peter@soardcharity.com', now: NOW + HOUR });
  assert.equal(refused.errors[0].field, 'maxApplications');
  assert.match(refused.errors[0].error, /10 of 10 applications are already in for 2027\. Raise the limit to open again\./);
  const later = await saveApplicationSettings(env, { opensAt: new Date(NOW + DAY).toISOString() }, { now: NOW + HOUR });
  assert.equal(later.errors[0].field, 'maxApplications', 'a time to open is refused too');
  const other = await saveApplicationSettings(env, { closedMessage: 'Back next year' }, { now: NOW + HOUR });
  assert.equal(other.errors, undefined, 'other edits still save');
  const raised = await saveApplicationSettings(env, { open: true, maxApplications: 15 }, { user: 'peter@soardcharity.com', now: NOW + HOUR });
  assert.deepEqual(raised.changes.map(c => c.field).sort(), ['application.maxApplications', 'application.open']);
  assert.equal((await stored()).open, true);
  const cleared = await saveApplicationSettings(env, { open: false }, { now: NOW + 2 * HOUR });
  assert.ok(cleared.changes.length);
  assert.equal((await saveApplicationSettings(env, { open: true, maxApplications: '' }, { now: NOW + 2 * HOUR })).errors, undefined, 'taking the limit off opens too');
});

test('a scheduled opening that finds the season full stays closed and tells Needs attention', async () => {
  await addApps(10);
  await setApplication({ open: false, year: YEAR, maxApplications: 10, opensAt: new Date(NOW + HOUR).toISOString() });
  assert.equal(await runApplicationSchedule(env, { now: NOW + HOUR + 1000 }), null);
  const s = await stored();
  assert.equal(s.open, false, 'stays closed');
  assert.equal(s.opensAt, '', 'the time comes off, so it isn’t tried every minute');
  const [p] = posts();
  assert.equal(p.channel, ATTN, 'it needs a hand');
  assert.match(p.text, /Applications didn’t open on schedule/);
  assert.match(p.text, /They were set to open Wed, Oct 21, 12:00 PM, but the 2027 limit of 10 is already reached \(10 in\), so they stayed closed\./);
  assert.equal(await runApplicationSchedule(env, { now: NOW + HOUR + 61e3 }), null);
  assert.equal(w.world.slack.length, 1, 'once');
});

// ── The admin ───────────────────────────────────────────────────────

async function call(method, query = '', body) {
  const request = new Request(`https://admin.test/api/applications-admin${query}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
  const waits = [];
  const ctx = { env, request, data: { userEmail: 'peter@soardcharity.com' }, waitUntil: (p) => waits.push(p) };
  const res = method === 'POST' ? await adminApi.onRequestPost(ctx) : await adminApi.onRequestGet(ctx);
  await Promise.allSettled(waits);
  return { status: res.status, json: await res.json() };
}

test('Settings shows where the season stands, and a limit at or under it closes at once', async () => {
  await addApps(6);
  await addDrafts(2);
  const got = await call('GET', '?settings=1');
  assert.equal(got.json.settings.maxApplications, 10);
  assert.deepEqual(
    { received: got.json.cap.received, left: got.json.cap.left, filling: got.json.cap.filling, warnAt: got.json.cap.warnAt, full: got.json.cap.full },
    { received: 6, left: 4, filling: 2, warnAt: 8, full: false },
  );
  const saved = await call('POST', '', { settings: { maxApplications: 6 }, base: got.json.settings });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.capClosed, true);
  assert.equal(saved.json.settings.open, false);
  assert.equal(saved.json.since.by, 'limit');
  assert.equal(saved.json.cap.full, true);
  assert.match(posts()[0].text, /6 applications are in and the limit is 6|The 6th application came in/);
  const reopen = await call('POST', '', { settings: { open: true }, base: saved.json.settings });
  assert.equal(reopen.status, 422);
  assert.equal(reopen.json.errors[0].field, 'maxApplications');
  const none = await call('GET', '?settings=1');
  assert.equal(none.json.cap.max, 6);
  await setApplication({ open: false, year: YEAR });
  const noLimit = (await call('GET', '?settings=1')).json.cap;
  assert.equal(noLimit.max, 0, 'no limit');
  assert.equal(noLimit.received, 6, 'the count is there for choosing one');
});

test('a lower limit under what\'s in says so in the notice', async () => {
  await addApps(12);
  await setApplication({ ...(await stored()), maxApplications: 20 });
  await saveApplicationSettings(env, { maxApplications: 10 }, { now: NOW });
  await enforceApplicationCap(env, { now: NOW });
  assert.match(posts()[0].text, /12 applications are in and the limit is 10, so applications closed by themselves at 11:00 AM\./);
});

// ── Families ────────────────────────────────────────────────────────

test('families see "full" only while closed with the season at its limit', async () => {
  await addApps(10);
  assert.equal(await seasonFull(DB, await stored(), YEAR), false, 'still open');
  await enforceApplicationCap(env, { now: NOW });
  assert.equal(await seasonFull(DB, await stored(), YEAR), true);
  await setApplication({ ...(await stored()), maxApplications: 20 });
  assert.equal(await seasonFull(DB, await stored(), YEAR), false, 'room again: back to the closed message');
  assert.equal(await seasonFull(DB, { open: false, year: '2028', maxApplications: 10 }, '2028'), false, 'a new season starts at 0');
});

test('the form\'s built-in words match the server\'s, in English and Spanish', () => {
  assert.equal(t('en', 'fullTitle', { year: YEAR }), defaultFullMessage(YEAR));
  assert.match(t('es', 'fullTitle', { year: YEAR }), /^Ya recibimos todas las solicitudes que podemos aceptar para 2027\.$/);
});

// ── The words ───────────────────────────────────────────────────────

test('every notice reads plainly: no em dashes, no @here, the numbers in the phone preview', async () => {
  const f = { year: YEAR, max: 100, warnAt: 80, received: 84, left: 16, filling: 12, perDay: 6, fillsInDays: 2.7, full: false, percent: 84 };
  for (const [kind, facts, extra] of [['warn', f, {}], ['full', { ...f, received: 100, left: 0, full: true, percent: 100 }, { at: NOW }], ['blocked', { ...f, received: 103, left: 0, full: true, percent: 100 }, { opensAt: new Date(NOW).toISOString() }]]) {
    const card = capCard(kind, facts, extra);
    const mail = capEmail(kind, facts, extra);
    for (const s of [card.text, card.plain, JSON.stringify(card.blocks), mail.subject, mail.text, mail.html]) {
      assert.equal(/—/.test(s), false, `${kind}: no em dash`);
      assert.equal(/@here|@channel/.test(s), false, `${kind}: no mention`);
    }
    assert.match(card.text, /\d/, `${kind}: the phone notification has the count`);
    assert.equal(/https?:\/\//.test(card.text), false, `${kind}: never a link in the notification`);
  }
  const warn = renderSlack(capCard('warn', f));
  assert.match(warn, /Pace: about 6 a day this week, so it fills in about 3 days/);
  assert.match(capEmail('warn', f).html, /width="84%"/, 'the email shows how full it is');
});

// ── Proof in production ─────────────────────────────────────────────

test('the self-test sends both notices once, marked as tests, to Needs attention and Peter only', async () => {
  const { maybeCapSelfTest, CAP_SELF_TEST } = await import('../functions/api/_application-cap.js');
  const settingsBefore = JSON.stringify(await stored());
  const out = await maybeCapSelfTest(env, { now: NOW });
  assert.equal(out.id, CAP_SELF_TEST);
  assert.equal(out.posts.length, 2);
  assert.ok(out.posts.every(p => p.ok && p.channel === ATTN && p.ts), 'both posted, with the ts to read them back');
  const [warn, full] = posts();
  assert.equal(warn.channel, ATTN, 'a test is staff business, not good news for the whole team');
  assert.match(warn.text, /🧪 \*Test · a sample season; applications weren’t touched\*/);
  assert.match(warn.text, /96 of 120 applications are in for 2027/);
  assert.match(full.text, /🧪 \*Test · a sample season/);
  assert.match(full.text, /Applications are closed for 2027: the limit of 120 is reached/);
  assert.deepEqual(emails().map(e => e.to), [['peter@soardcharity.com'], ['peter@soardcharity.com']], 'never the staff list');
  assert.ok(emails().every(e => /^\[TEST\] /.test(e.subject)));
  assert.deepEqual(out.emails, [{ sent: 1, error: null }, { sent: 1, error: null }]);
  assert.equal(JSON.stringify(await stored()), settingsBefore, 'applications and settings untouched');
  assert.equal(await DB.prepare("SELECT value FROM application_runtime WHERE key = 'cap-notice'").first(), null, 'not recorded as a real notice');
  const kept = JSON.parse((await DB.prepare('SELECT value FROM application_runtime WHERE key = ?').bind(`cap-self-test:${CAP_SELF_TEST}`).first()).value);
  assert.deepEqual(kept.posts.map(p => p.ok), [true, true], 'what Slack said is kept for checking');
  assert.equal(await maybeCapSelfTest(env, { now: NOW + 60e3 }), null, 'once per id');
  assert.equal(w.world.slack.length, 2);
  const quiet = { ...env, SLACK_BOT_TOKEN: '', DB: await createD1() };
  assert.equal(await maybeCapSelfTest(quiet, { now: NOW }), null, 'nothing without Slack');
});

test('Settings says how many families on the board were added in JobTread (they don\'t count)', async () => {
  const { ensureApplicantSchema } = await import('../functions/api/_applicants.js');
  await ensureApplicantSchema(DB);
  await addApps(2);
  await DB.prepare("UPDATE applications SET jt_account_id = 'acct-form' WHERE id = (SELECT id FROM applications LIMIT 1)").run();
  const row = (id, year, archived = null) => DB.prepare("INSERT INTO applicants (account_id, name, year, archived_at, synced_at) VALUES (?, 'A family', ?, ?, ?)").bind(id, year, archived, new Date(NOW).toISOString()).run();
  await row('acct-form', YEAR);          // came through the form: counted once, as an application
  await row('acct-jt1', YEAR);           // added in JobTread
  await row('acct-jt2', YEAR);
  await row('acct-old', '2026');         // another season
  await row('acct-gone', YEAR, new Date(NOW).toISOString()); // archived
  const got = await call('GET', '?settings=1');
  assert.equal(got.json.cap.received, 2);
  assert.equal(got.json.cap.addedInJobTread, 2);
  const enforced = await capFacts(DB, pickApplication(await stored(), NOW), { now: NOW });
  assert.equal(enforced.addedInJobTread, undefined, 'the enforcing check skips that count');
});
