// Next year's board meetings, by themselves, every year (functions/api/_board-schedule.js)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, patchMeeting, getMeeting, listMeetings, deleteMeeting, ensureSchema } from '../functions/api/_board.js';
import { maybeScheduleNextYear, scheduleStatus, yearToSchedule, sendsOn, FIRST_YEAR } from '../functions/api/_board-schedule.js';
import { writeState } from '../functions/api/_board-roles.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { cleanMeeting, boardDays, secondThursday, meetingName } from '../public/admin/board-shared.js';

const { privateKey: PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const KEY = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', private_key: PEM, token_uri: 'https://oauth2.googleapis.com/token' });
const HOLLY = 'holly@soardcharity.com';
const at = (day, hour = 10) => Date.parse(`${day}T${String(hour + 4).padStart(2, '0')}:00:00Z`); // Eastern, in July (EDT)

let env;
let created; // the events Google made
let failing; // dates Google refuses
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
const run = (when) => maybeScheduleNextYear(env, { fetchImpl, now: when });
const ofYear = async (y) => (await listMeetings(env.DB)).filter((m) => m.date?.startsWith(`${y}-`)).sort((a, b) => a.date.localeCompare(b.date));

beforeEach(async () => {
  clearTokenCache();
  created = [];
  failing = [];
  env = { DB: await createD1(), GOOGLE_CALENDAR_KEY: KEY };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT, ip_address TEXT, user_agent TEXT)').catch(() => {});
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

test('which year’s turn it is: July 9 2027 for 2028, and the day after the second Thursday of July every year after', () => {
  assert.equal(sendsOn(2028), '2027-07-09');
  assert.equal(sendsOn(2029), '2028-07-14');
  assert.equal(yearToSchedule('2026-11-05'), 2027);
  assert.equal(yearToSchedule('2027-07-08'), 2027);
  assert.equal(yearToSchedule('2027-07-09'), 2028);
  assert.equal(yearToSchedule('2027-12-31'), 2028);
  assert.equal(yearToSchedule('2028-07-13'), 2028);
  assert.equal(yearToSchedule('2028-07-14'), 2029);
});

test('shipping it does nothing: not before 2028’s turn, whatever the day', async () => {
  assert.equal(FIRST_YEAR, 2028);
  for (const when of [Date.now(), at('2026-11-06'), at('2027-07-08', 23), at('2027-01-14')]) assert.equal(await run(when), null);
  assert.deepEqual(await listMeetings(env.DB), []);
  assert.deepEqual(created, []);
});

test('next year’s four go out once: usual time, no place, on the template, invited', async () => {
  // The last meeting's place and a one-off time never carry over
  const last = await saveMeeting(env.DB, cleanMeeting({ date: '2027-07-08', start: '09:30', end: '11:00', location: 'STAG Partners', address: '140 Colony Center Dr' }), { by: 'test' });
  assert.equal(last.location, 'STAG Partners');
  assert.equal(await run(at('2027-07-09', 3)), null, 'not in the middle of the night');
  const did = await run(at('2027-07-09', 9));
  assert.deepEqual(did, { year: 2028, added: 4, invited: 4, error: '' });
  const made = await ofYear(2028);
  assert.deepEqual(made.map((m) => m.date), boardDays(2028));
  for (const m of made) {
    assert.deepEqual([m.start, m.end, m.location, m.address, m.shared, m.agendaFrom.kind], ['08:00', '10:00', '', '', false, 'template']);
    assert.ok(m.invite?.eventId, 'its invite is out');
    assert.equal(m.invite.organizer, HOLLY);
    assert.ok(m.invite.emails.includes('alex@example.com'));
  }
  assert.deepEqual(made.map(meetingName), ['Q1 2028 Board Meeting', 'Q2 2028 Board Meeting', 'Q3 2028 Board Meeting', 'Q4 2028 Board Meeting']);
  assert.equal(created.length, 4);
  assert.equal(await run(at('2027-07-09', 12)), null, 'once');
  assert.equal(await run(at('2027-09-01', 12)), null);
  assert.equal(created.length, 4);
});

test('it goes on forever: every July, the next year’s four, nothing doubled', async () => {
  for (let y = FIRST_YEAR; y <= 2060; y++) {
    const did = await run(at(sendsOn(y), 9));
    assert.deepEqual(did, { year: y, added: 4, invited: 4, error: '' });
    assert.deepEqual((await ofYear(y)).map((m) => m.date), boardDays(y));
  }
  assert.equal(created.length, 4 * (2060 - FIRST_YEAR + 1));
});

test('a hub that was down catches up, and a quarter with a meeting keeps it', async () => {
  const chosen = await saveMeeting(env.DB, cleanMeeting({ date: '2028-01-20', start: '09:00', end: '10:00' }), { by: 'test' });
  const did = await run(at('2027-08-15', 9));
  assert.deepEqual([did.added, did.invited], [3, 4]);
  assert.deepEqual((await ofYear(2028)).map((m) => m.date), ['2028-01-20', '2028-04-13', '2028-07-13', '2028-10-12'], 'no second Q1 meeting beside the one chosen');
  assert.ok((await getMeeting(env.DB, chosen.id)).invite?.eventId);
});

test('an invite someone deleted stays deleted, and one already out isn’t sent again', async () => {
  const gone = await saveMeeting(env.DB, cleanMeeting({ date: '2028-04-13' }), { by: 'test' });
  await patchMeeting(env.DB, gone.id, (cur) => ({ ...cur, inviteGone: '2027-06-01T00:00:00Z' }));
  const out = await saveMeeting(env.DB, cleanMeeting({ date: '2028-07-13' }), { by: 'test' });
  await patchMeeting(env.DB, out.id, (cur) => ({ ...cur, invite: { eventId: 'ev1', organizer: HOLLY, sentAt: 'x', emails: [], replies: {} } }));
  const did = await run(at('2027-07-09', 9));
  assert.deepEqual([did.added, did.invited], [2, 2]);
  assert.equal((await getMeeting(env.DB, gone.id)).invite, null);
});

test('once a year’s are out, a meeting moved or deleted stays that way', async () => {
  await run(at('2027-07-09', 9));
  const [jan, apr] = await ofYear(2028);
  await deleteMeeting(env, jan.id).catch(() => {});
  await patchMeeting(env.DB, apr.id, (cur) => ({ ...cur, date: '2028-04-20' }));
  created = [];
  assert.equal(await run(at('2027-07-20', 9)), null);
  assert.equal(await run(at('2028-01-05', 9)), null);
  assert.deepEqual(created, []);
  assert.equal((await ofYear(2028)).length, 3);
});

test('when Google fails it tries again each hour, finishes what’s left, says so meanwhile, and never doubles', async () => {
  failing = ['2028-04-13'];
  const first = await run(at('2027-07-09', 9));
  assert.deepEqual([first.added, first.invited], [4, 3]);
  assert.match(first.error, /2028-04-13/);
  const status = await scheduleStatus(env.DB, { now: at('2027-07-09', 9) });
  assert.deepEqual([status.next, status.last], [2028, null]);
  assert.match(status.error, /2028-04-13/);
  assert.equal(await run(at('2027-07-09', 9) + 30 * 60 * 1000), null, 'not again within the hour');
  failing = [];
  const again = await run(at('2027-07-09', 10) + 60 * 1000);
  assert.deepEqual(again, { year: 2028, added: 0, invited: 1, error: '' });
  assert.equal((await ofYear(2028)).length, 4);
  assert.equal(created.length, 4);
  const done = await scheduleStatus(env.DB, { now: at('2027-07-09', 12) });
  assert.deepEqual([done.last, done.next, done.on, done.error], [2028, 2029, '2028-07-14', null]);
});

test('what Automations says before anything has run, and nothing without a calendar', async () => {
  const s = await scheduleStatus(env.DB, { now: at('2026-11-06') });
  assert.deepEqual([s.next, s.on, s.last, s.error], [2028, '2027-07-09', null, null]);
  delete env.GOOGLE_CALENDAR_KEY;
  assert.equal(await run(at('2027-07-09', 9)), null);
  assert.deepEqual(await ofYear(2028), []);
});
