// The board's next four meetings stay on everyone's calendar, forever (functions/api/_board-schedule.js)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, patchMeeting, getMeeting, listMeetings, deleteMeeting, ensureSchema } from '../functions/api/_board.js';
import { maybeScheduleAhead, scheduleStatus, daysAhead, sendsOn, FIRST_DAY } from '../functions/api/_board-schedule.js';
import { writeState } from '../functions/api/_board-roles.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { cleanMeeting, boardDays, secondThursday, meetingName, quarterOf } from '../public/admin/board-shared.js';

const { privateKey: PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const KEY = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', private_key: PEM, token_uri: 'https://oauth2.googleapis.com/token' });
const HOLLY = 'holly@soardcharity.com';
const at = (day, hour = 10) => Date.parse(`${day}T${String(hour + 4).padStart(2, '0')}:00:00Z`);
const HOUR = 60 * 60 * 1000;
const next = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

let env;
let created; // the events Google made
let failing; // dates Google refuses
let told; // alert emails
const realFetch = globalThis.fetch;
const fetchImpl = async (input, init = {}) => {
  const url = String(input.url || input);
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'g', expires_in: 3600 });
  const method = init.method || 'GET';
  if (method === 'GET') return Response.json({ error: { message: 'Not Found' } }, { status: 404 });
  const body = JSON.parse(init.body);
  if (failing.some((d) => JSON.stringify(body.start || {}).includes(d))) return Response.json({ error: { message: 'Backend Error' } }, { status: 503 });
  created.push(body);
  return Response.json({ ...body, id: body.id, hangoutLink: 'https://meet.google.com/abc-defg-hij' });
};
const run = (when) => maybeScheduleAhead(env, { fetchImpl, now: when });
const ahead = async () => (await listMeetings(env.DB)).filter((m) => m.date >= FIRST_DAY).sort((a, b) => a.date.localeCompare(b.date));

afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(async () => {
  clearTokenCache();
  created = [];
  failing = [];
  told = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input.url || input).startsWith('https://api.resend.com/')) { const b = JSON.parse(init.body); for (const e of [].concat(b)) told.push(e.subject); return Response.json(Array.isArray(b) ? { data: b.map((_, i) => ({ id: `e${i}` })) } : { id: 'e' }); }
    throw new Error(`unexpected fetch ${input}`);
  };
  env = { DB: await createD1(), GOOGLE_CALENDAR_KEY: KEY, RESEND_API_KEY: 're_test', ALERT_EMAILS: 'alerts@example.com' };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await ensureSchema(env.DB);
  await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind('alex', 'Alex', 'board', JSON.stringify({ name: 'Alex', group: 'board', status: 'active', title: 'Board Member' })).run();
  await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('alex', 'alex@example.com').run();
  await writeState(env.DB, 'settings', { admins: [HOLLY], invitesFrom: HOLLY });
});

test('the second Thursday of each quarter’s first month, whichever day a month starts on', () => {
  assert.deepEqual(boardDays(2027), ['2027-01-14', '2027-04-08', '2027-07-08', '2027-10-14']);
  assert.deepEqual(boardDays(2028), ['2028-01-13', '2028-04-13', '2028-07-13', '2028-10-12']);
  assert.deepEqual(boardDays(2029), ['2029-01-11', '2029-04-12', '2029-07-12', '2029-10-11']);
  for (let y = 2027; y < 2127; y++) {
    for (const d of boardDays(y)) {
      const day = new Date(`${d}T12:00:00Z`);
      assert.equal(day.getUTCDay(), 4, `${d} is a Thursday`);
      assert.ok(day.getUTCDate() >= 8 && day.getUTCDate() <= 14, `${d} is the second one`);
    }
  }
  assert.equal(secondThursday(2027, 4), '2027-04-08', 'a month that starts on a Thursday');
});

test('each meeting goes out the day after the same quarter the year before', () => {
  assert.deepEqual(boardDays(2028).map(sendsOn), ['2027-01-15', '2027-04-09', '2027-07-09', '2027-10-15']);
  assert.equal(sendsOn('2029-01-11'), '2028-01-14');
  assert.deepEqual(daysAhead('2026-11-05'), ['2027-01-14', '2027-04-08', '2027-07-08', '2027-10-14']);
  assert.deepEqual(daysAhead('2027-01-14'), ['2027-01-14', '2027-04-08', '2027-07-08', '2027-10-14'], 'the day of a meeting isn’t after it');
  assert.deepEqual(daysAhead('2027-01-15'), ['2027-04-08', '2027-07-08', '2027-10-14', '2028-01-13']);
  assert.deepEqual(daysAhead('2027-11-30'), ['2028-01-13', '2028-04-13', '2028-07-13', '2028-10-12']);
});

test('shipping it sends nothing: not before the day after Jan 14 2027, whatever the hour', async () => {
  for (const when of [Date.now(), at('2026-11-06'), at('2027-01-13'), at('2027-01-14'), at('2027-01-14', 23)]) assert.equal(await run(when), null);
  assert.deepEqual(await listMeetings(env.DB), []);
  assert.deepEqual(created, []);
});

test('the day after a meeting, one goes out: usual time, no place, on the template, invited, in working hours', async () => {
  await saveMeeting(env.DB, cleanMeeting({ date: '2027-01-14', start: '09:30', end: '11:00', location: 'STAG Partners', address: '140 Colony Center Dr' }), { by: 'test' });
  assert.equal(await run(at('2027-01-15', 3)), null, 'not in the middle of the night');
  assert.deepEqual(await run(at('2027-01-15', 10)), { added: 1, invited: 1, error: '' });
  const [m] = await ahead();
  assert.equal(m.date, '2028-01-13');
  assert.deepEqual([m.start, m.end, m.location, m.address, m.shared, m.agendaFrom.kind, meetingName(m)], ['08:00', '10:00', '', '', false, 'template', 'Q1 2028 Board Meeting']);
  assert.equal(m.invite.organizer, HOLLY);
  assert.ok(m.invite.emails.includes('alex@example.com'));
  assert.equal(await run(at('2027-01-15', 12)), null, 'once');
  assert.equal(await run(at('2027-03-01')), null);
  assert.equal(created.length, 1);
});

test('it goes on forever: one each quarter, the next four always out, nothing doubled', async () => {
  let want = 0;
  for (let y = 2027; y <= 2060; y++) {
    for (const d of boardDays(y)) {
      const did = await run(at(next(d), 10));
      want += 1;
      assert.deepEqual(did, { added: 1, invited: 1, error: '' }, d);
      assert.equal(created.length, want);
      const out = new Set((await ahead()).map((m) => m.date));
      for (const a of daysAhead(next(d))) if (a >= FIRST_DAY) assert.ok(out.has(a), `${a} is out the day after ${d}`);
    }
  }
});

test('a hub that was down catches up, and a date chosen by hand keeps its quarter', async () => {
  const chosen = await saveMeeting(env.DB, cleanMeeting({ date: '2028-01-20', start: '09:00', end: '10:00' }), { by: 'test' });
  const did = await run(at('2027-07-20', 10));
  assert.deepEqual([did.added, did.invited], [2, 3], 'Q1 kept, Q2 and Q3 added, all three invited');
  assert.deepEqual((await ahead()).map((m) => m.date), ['2028-01-20', '2028-04-13', '2028-07-13']);
  assert.ok((await getMeeting(env.DB, chosen.id)).invite?.eventId);
});

test('a meeting cancelled or moved stays that way: nothing puts it back, then or ever', async () => {
  await run(at('2027-01-15'));
  await run(at('2027-04-09'));
  const [jan, apr] = await ahead();
  await deleteMeeting(env, jan.id).catch(() => {});
  await patchMeeting(env.DB, apr.id, (cur) => ({ ...cur, date: '2028-04-20' }));
  created = [];
  for (const when of [at('2027-04-10'), at('2027-05-01'), at('2027-06-30'), at('2027-12-01')]) await run(when);
  await run(at('2028-01-05'));
  const left = (await ahead()).map((m) => m.date);
  assert.ok(!left.includes('2028-01-13'), 'the cancelled one stays gone');
  assert.ok(!left.includes('2028-04-13') && left.includes('2028-04-20'), 'the moved one stays moved');
  assert.deepEqual(created.map((e) => e.start.dateTime.slice(0, 10)), ['2028-07-13', '2028-10-12'], 'only the ones that were due');
});

test('an invite someone deleted stays deleted, and one already out isn’t sent again', async () => {
  const gone = await saveMeeting(env.DB, cleanMeeting({ date: '2028-01-13' }), { by: 'test' });
  await patchMeeting(env.DB, gone.id, (cur) => ({ ...cur, inviteGone: '2027-01-01T00:00:00Z' }));
  assert.deepEqual(await run(at('2027-01-15')), { added: 0, invited: 0, error: '' });
  assert.equal((await getMeeting(env.DB, gone.id)).invite, null);
  assert.deepEqual(created, []);
});

test('a job that runs forever tells a person: Google refusing retries hourly, a day on the staff hear once, and it clears', async () => {
  failing = ['2028-01-13'];
  const start = at('2027-01-15');
  const first = await run(start);
  assert.equal(first.added, 1);
  assert.match(first.error, /Backend Error/);
  assert.equal(await run(start + HOUR / 2), null, 'not again within the hour');
  assert.equal((await run(start + HOUR + 1000)).added, 0, 'never a second meeting');
  assert.deepEqual(told, [], 'an hour of trouble can pass');
  const status = await scheduleStatus(env.DB, { now: start + HOUR });
  assert.match(status.error, /Q1 2028: /);
  await run(start + 24 * HOUR + 1000);
  assert.equal(told.length, 1);
  assert.match(told[0], /Q1 2028 board meeting invite hasn’t gone out/);
  await run(start + 26 * HOUR);
  assert.equal(told.length, 1, 'once');
  failing = [];
  const fixed = await run(start + 28 * HOUR);
  assert.deepEqual(fixed, { added: 0, invited: 1, error: '' });
  assert.equal((await ahead()).length, 1);
  assert.equal(created.length, 1);
  const done = await scheduleStatus(env.DB, { now: start + 28 * HOUR });
  assert.deepEqual([done.last, done.next, done.on, done.error], ['2028-01-13', '2028-04-13', '2027-04-09', null]);
});

test('what Automations says before anything has run, and nothing without a calendar', async () => {
  const s = await scheduleStatus(env.DB, { now: at('2026-11-06') });
  assert.deepEqual([s.next, s.on, s.last, s.error], ['2028-01-13', '2027-01-15', null, null]);
  assert.equal(quarterOf('2028-01-13'), 'Q1 2028');
  delete env.GOOGLE_CALENDAR_KEY;
  assert.equal(await run(at('2027-01-15')), null);
  assert.deepEqual(await ahead(), []);
});
