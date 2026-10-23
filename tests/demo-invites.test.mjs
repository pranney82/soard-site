/**
 * Demo day calendar invites (functions/api/_demo-invites.js, demo-invites-admin.js)
 * Run: node --test tests/demo-invites.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import {
  planDemo, demoTasks, demoSlot, reconcileDemo, maybeCheckDemos, sendTestDemo, listDemos, listPeople, savePerson, removePerson,
  readConfig, writeConfig, demoAlert, findSentByHand, DEFAULT_TEMPLATE, FIELD_MONETARY_SPONSOR, SENT_BY_HAND,
} from '../functions/api/_demo-invites.js';
import { FIELD_STATUS, FIELD_MAKEOVER_TYPE, FIELD_CONTACT_EMAIL, BY_HAND, writeConfig as writeInviteConfig } from '../functions/api/_reveal-invites.js';
import * as wakeRoute from '../functions/api/reveal-invites.js';
import * as admin from '../functions/api/demo-invites-admin.js';
import { eventIdFor, clearTokenCache } from '../functions/api/_google-calendar.js';

// Thursday Oct 22 2026, 10:00 AM Eastern
const NOW = Date.parse('2026-10-22T14:00:00Z');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'reveals@soard-cal.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const ORGANIZER = 'ccunningham@soardcharity.com';
const STAFF = [{ name: 'Christian Nielsen', email: 'cnielsen@soardcharity.com' }, { name: 'Clareece Cunningham', email: ORGANIZER }];
const KIDS = [{ slug: 'max', name: 'Max', year: 2026 }];
const NO_PEOPLE = { always: [], sponsors: {} };

const access = (role, name, emailAddress, isInternal = false) => ({ membership: { isInternal, role: { name: role }, user: { name, emailAddress } } });

function job({ demoDate = '2026-10-26', demoTime = null, demoEnd = null, demoDone = false, startSet = true, demoTask = true, status = 'Mobilization', closed = null, sponsor = null, type = 'Therapy Room', aces = [] } = {}) {
  return {
    id: '22PTestJob001', name: 'Max Sample (2026)', closedOn: closed, organization: { id: '22NJw42j5GLg' },
    location: { address: '100 Example Way, Atlanta, GA 30301, USA', account: { contacts: { nodes: [
      { name: 'Pat Sample', customFieldValues: { nodes: [{ value: 'Pat.Sample@example.com', customField: { id: FIELD_CONTACT_EMAIL } }] } },
      { name: 'No Email', customFieldValues: { nodes: [] } },
    ] } } },
    customFieldValues: { nodes: [
      { value: status, customField: { id: FIELD_STATUS } },
      ...(type ? [{ value: type, customField: { id: FIELD_MAKEOVER_TYPE } }] : []),
      ...(sponsor ? [{ value: sponsor, customField: { id: FIELD_MONETARY_SPONSOR } }] : []),
    ] },
    tasks: { nodes: [
      ...(demoTask ? [{ id: 'tDemo', name: 'Demo', isGroup: false, startDate: demoDate, startTime: demoTime, endDate: demoDate, endTime: demoEnd, progress: demoDone ? 1 : null }] : []),
      { id: 'tSet', name: 'Set Start Date', isGroup: false, startDate: '2026-10-13', startTime: null, endDate: '2026-10-13', endTime: null, progress: startSet ? 1 : null },
    ] },
    aces: { nodes: aces },
  };
}

// ── The plan ──

test('Set Start Date checked off: the demo day invite, at 9:00 AM for an hour when the Demo task has no time', () => {
  const p = planDemo(job(), STAFF, { kids: KIDS, now: NOW });
  assert.equal(p.action, 'upsert');
  assert.equal(p.event.summary, "Max's Demo Day");
  assert.equal(p.event.id, eventIdFor('soarddemo', '22PTestJob001'));
  assert.match(p.event.id, /^[a-v0-9]+$/, 'Google event ids allow a-v and 0-9 only');
  assert.deepEqual(p.event.start, { dateTime: '2026-10-26T09:00:00', timeZone: 'America/New_York' });
  assert.deepEqual(p.event.end, { dateTime: '2026-10-26T10:00:00', timeZone: 'America/New_York' });
  assert.equal(p.event.location, '100 Example Way, Atlanta, GA 30301, USA', 'the family\'s address');
  assert.equal(p.event.transparency, 'opaque');
  assert.equal(p.event.guestsCanSeeOtherGuests, false);
  assert.equal(p.event.guestsCanInviteOthers, false);
  assert.equal(p.event.description, [
    "Max's therapy room makeover starts with demo day on Monday, October 26 at 9:00 AM.",
    '',
    "It's the first day of construction. Please accept or decline so we know who to expect.",
    '',
    'Meet Max: https://sunshineonaranneyday.com/kids/max/',
    '',
    'Questions? Email Clareece Cunningham at ccunningham@soardcharity.com.',
    'Sunshine on a Ranney Day',
  ].join('\n'));
  assert.doesNotMatch(p.event.description, /—/, 'no em dashes in site copy');
  // The family first, then staff; the organizer is never a guest; emails lowercased
  assert.deepEqual(p.guests, ['pat.sample@example.com', 'cnielsen@soardcharity.com']);
});

test('not until Set Start Date is checked off; once the invite is out, un-checking it changes nothing', () => {
  assert.deepEqual(planDemo(job({ startSet: false }), STAFF, { now: NOW }), { action: 'skip', reason: 'Set Start Date is not checked off yet' });
  assert.equal(planDemo(job({ startSet: false }), STAFF, { now: NOW, sent: true }).action, 'upsert');
});

test("the Demo task's own time and end time win over the default", () => {
  const p = planDemo(job({ demoTime: '13:30:00.000', demoEnd: '16:00:00.000' }), STAFF, { kids: KIDS, now: NOW });
  assert.deepEqual(p.event.start.dateTime, '2026-10-26T13:30:00');
  assert.deepEqual(p.event.end.dateTime, '2026-10-26T16:00:00');
  assert.match(p.event.description, /on Monday, October 26 at 1:30 PM\./);
  // An end before the start is ignored: the default length instead
  assert.deepEqual(demoSlot({ startDate: '2026-10-26', startTime: '13:30', endTime: '08:00' }), { start: '13:30', end: '14:30' });
  // The admin's default start and length
  const q = planDemo(job(), STAFF, { now: NOW, config: { startTime: '08:30', minutes: 90 } });
  assert.deepEqual([q.event.start.dateTime, q.event.end.dateTime], ['2026-10-26T08:30:00', '2026-10-26T10:00:00']);
});

test('the Demo task is found by name, never a group, and the open one with a date first', () => {
  const j = job();
  j.tasks.nodes.unshift({ id: 'g', name: 'Demo', isGroup: true, startDate: '2026-11-30', progress: null }, { id: 'old', name: 'Demo', isGroup: false, startDate: '2026-10-01', progress: 1 });
  assert.equal(demoTasks(j).demo.id, 'tDemo');
  assert.equal(demoTasks(j).startSet, true);
});

test('when there is no invite, and when one that is out is kept as it is', () => {
  const plan = (o, extra = {}) => planDemo(job(o), STAFF, { kids: KIDS, now: NOW, ...extra });
  assert.deepEqual([plan({ demoDate: '2026-10-21' }).action, plan({ demoDate: '2026-10-21' }).reason], ['skip', 'demo day has already happened']);
  assert.equal(plan({ demoDate: '2026-10-22' }).action, 'skip', 'today, and 9:00 AM has passed');
  assert.equal(plan({ demoDate: '2026-10-22', demoTime: '13:00:00.000' }).action, 'upsert', 'today, later on');
  assert.equal(plan({ demoDone: true }).action, 'skip', 'Demo checked off');
  assert.equal(plan({ closed: '2026-10-20' }).action, 'hold');
  assert.equal(plan({ status: 'Awaiting Funding' }).action, 'hold');
  assert.deepEqual(plan({ demoDate: null }), { action: 'hold', reason: 'the Demo task has no date', waiting: true });
  assert.deepEqual(plan({ demoTask: false }), { action: 'hold', reason: 'the job has no Demo task', waiting: true });
  assert.equal(plan({ demoDate: null, startSet: false }).waiting, false, 'nothing to wait for before Set Start Date');
  for (const organization of [{ id: 'other' }, null, {}]) assert.equal(planDemo({ ...job(), organization }, STAFF, { now: NOW }).reason, 'not a SOARD job');
});

test('guests: family, internal team, the monetary sponsor (Sponsor users on the job), and the every-demo-day list; nobody else on the job', () => {
  const people = {
    always: [{ email: 'mindi@example.com', name: 'Mindi', role: 'Social media' }, { email: 'CNIELSEN@soardcharity.com', name: 'dup' }],
  };
  const aces = [
    access('Sponsor', 'Sam Sponsor', 'sam@sponsor.example'),
    access('Vendor', 'Jen Designer', 'jen@design.example'),
    access('Photographer', 'Pat Photo', 'pat@photo.example'),
    access('Makeover Family', 'Grandpa Sample', 'grandpa@example.com'),
    access('Admin', 'Qualification Committee', 'selection@soardcharity.com', true),
  ];
  const p = planDemo(job({ sponsor: 'Jackson Healthcare', aces }), STAFF, { kids: KIDS, now: NOW, people });
  assert.deepEqual(p.guests, [
    'pat.sample@example.com', 'grandpa@example.com', // family: contacts and Makeover Family users
    'cnielsen@soardcharity.com', // internal team
    'sam@sponsor.example', // the monetary sponsor: Sponsor users given access to the job
    'mindi@example.com', // every demo day
  ]);
  assert.ok(!p.guests.includes('jen@design.example') && !p.guests.includes('pat@photo.example'), 'vendors, design partners and photographers on the job are not invited');
  assert.equal(p.sponsor, 'Jackson Healthcare');
  assert.deepEqual(p.people['mindi@example.com'], { name: 'Mindi', kind: 'always', role: 'Social media' });
  assert.equal(p.people['sam@sponsor.example'].kind, 'sponsor');
  assert.ok(!p.guests.includes('selection@soardcharity.com'));
  const none = planDemo(job({ sponsor: 'SOARF' }), STAFF, { kids: KIDS, now: NOW, people });
  assert.deepEqual(none.guests.filter((g) => none.people[g].kind === 'sponsor'), [], 'a sponsor named on the job with nobody from it on the job adds nobody');
});

test('the every-demo-day list: checked, and kept out of site_config; sponsors come from JobTread, not a list here', async () => {
  const DB = await freshDb();
  await savePerson(DB, { list: 'always', email: ' Mindi@Example.com ', name: 'Mindi', role: 'Social media' });
  await assert.rejects(savePerson(DB, { list: 'always', email: 'not an email' }), /doesn't look right/);
  await assert.rejects(savePerson(DB, { list: 'board', email: 'a@b.co' }), /doesn't exist/);
  await assert.rejects(savePerson(DB, { list: 'sponsor:Jackson Healthcare', email: 'a@b.co' }), /doesn't exist/);
  assert.deepEqual(await listPeople(DB), { always: [{ email: 'mindi@example.com', name: 'Mindi', role: 'Social media' }] });
  await removePerson(DB, { list: 'always', email: 'MINDI@example.com' });
  assert.deepEqual((await listPeople(DB)).always, []);
  const config = await DB.prepare("SELECT data FROM site_config WHERE key = 'demo-invites'").first();
  assert.ok(!String(config?.data || '').includes('@'), 'no emails in site_config (it is written into builds)');
});

test('what staff are told reads plainly, with no em dashes', () => {
  const w = demoAlert('waiting', { jobId: 'j1', name: 'Max', reason: 'the Demo task has no date', taskId: 't' });
  assert.equal(w.title, "Max's demo day invite is waiting");
  assert.equal(w.detail, "Set Start Date is checked off in JobTread, but the Demo task has no date, so there's no day to invite people to yet.");
  assert.match(w.text, /https:\/\/app\.jobtread\.com\/jobs\/j1\/schedule\?taskId=t/);
  for (const kind of ['waiting', 'held', 'problem']) assert.doesNotMatch(JSON.stringify(demoAlert(kind, { jobId: 'j1', name: 'Max', reason: 'job closed', error: 'x' })), /—/);
});

// ── End to end against fake JobTread + Google ──

const MEMBERS = [
  { isInternal: true, role: { name: 'Admin' }, user: { name: 'Christian Nielsen', emailAddress: 'cnielsen@soardcharity.com' } },
  { isInternal: true, role: { name: 'Admin' }, user: { name: 'Clareece Cunningham', emailAddress: ORGANIZER } },
  { isInternal: true, role: { name: 'Admin' }, user: { name: 'Qualification Committee', emailAddress: 'selection@soardcharity.com' } },
];
let env, calls, events, jt, members, handEvents, jtEvents;

async function freshDb() {
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER, status TEXT, data TEXT NOT NULL)',
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
  ] });
  await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind('max', 'Max', 2026, 'in-progress', '{"name":"Max","slug":"max"}').run();
  return DB;
}

beforeEach(async () => {
  clearTokenCache();
  env = { DB: await freshDb(), JOBTREAD_GRANT_KEY: 'grant_test', GOOGLE_CALENDAR_KEY: JSON.stringify(KEY) };
  calls = [];
  events = new Map();
  handEvents = [];
  jtEvents = new Map();
  members = [...MEMBERS];
  jt = job();
});

async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  calls.push(`${init.method || 'GET'} ${u.hostname}${u.pathname}${u.search}`);
  if (u.hostname === 'api.jobtread.com') {
    const q = JSON.parse(init.body).query;
    if (q.event) return Response.json({ event: jtEvents.get(q.event.$.id) || null });
    if (q.job) return Response.json({ job: jt });
    if (q.organization?.jobs) return Response.json({ organization: { jobs: { nodes: [{ id: jt.id, name: jt.name, tasks: jt.tasks }], nextPage: null } } });
    if (q.organization?.customFields) return Response.json({ organization: { customFields: { nodes: [{ options: ['Jackson Healthcare', 'Beazer', 'SOARF'] }] } } });
    if (JSON.stringify(q.organization?.memberships?.$?.where || '').includes('role')) return Response.json({ organization: { memberships: { nodes: [] } } });
    return Response.json({ organization: { memberships: { nodes: members } } });
  }
  if (u.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
  if (u.hostname === 'www.googleapis.com') {
    // The organizer's calendar searched for a demo day invite sent by hand
    if (u.pathname.endsWith('/events') && (init.method || 'GET') === 'GET') return Response.json({ items: [...handEvents, ...events.values()] });
    const id = u.pathname.split('/events/')[1];
    if (!init.method || init.method === 'GET') return events.has(id) ? Response.json(events.get(id)) : Response.json({ error: { message: 'Not Found' } }, { status: 404 });
    if (init.method === 'DELETE') { events.delete(id); return new Response(null, { status: 204 }); }
    const ev = JSON.parse(init.body);
    events.set(ev.id || id, ev);
    return Response.json(ev);
  }
  if (u.hostname === 'api.resend.com' || u.hostname === 'slack.com') return Response.json({ ok: true, id: 'x' });
  throw new Error(`unexpected fetch ${url}`);
}
const writesToGoogle = () => calls.filter((c) => /^(PUT|POST|DELETE|PATCH) www\.googleapis\.com/.test(c));
const run = (o = {}) => reconcileDemo(env, jt.id, { fetchImpl: fakeFetch, now: NOW, ...o });
const id = () => eventIdFor('soarddemo', jt.id);
const lastLog = async () => (await env.DB.prepare('SELECT action FROM demo_invite_log ORDER BY id DESC LIMIT 1').first())?.action;

test('nothing is sent until demo day invites are turned on', async () => {
  const r = await run();
  assert.equal(r.action, 'would-create');
  assert.deepEqual(writesToGoogle(), []);
  assert.equal((await readConfig(env.DB)).enabled, false, 'off by default');
});

test('sent once, follows the Demo task, and only facts email the guests', async () => {
  await writeConfig(env.DB, { enabled: true });
  let r = await run();
  assert.equal(r.action, 'created');
  assert.equal(r.guests, 2);
  assert.ok(calls.some((c) => c.startsWith('POST www.googleapis.com/calendar/v3/calendars/ccunningham%40soardcharity.com/events?sendUpdates=all')), 'from Clareece, emailing every guest');
  assert.ok(calls.some((c) => c.startsWith('GET www.googleapis.com/calendar/v3/calendars/ccunningham%40soardcharity.com/events?') && c.includes('q=demo')), 'her calendar checked for one sent by hand first');

  calls.length = 0;
  assert.equal((await run()).action, 'unchanged', 'the same JobTread: no second email');
  assert.deepEqual(writesToGoogle(), []);

  // The Demo task moves
  jt = job({ demoDate: '2026-10-28' });
  r = await run();
  assert.equal(r.action, 'updated');
  assert.equal(events.get(id()).start.dateTime, '2026-10-28T09:00:00');
  assert.ok(calls.some((c) => c.startsWith(`PUT www.googleapis.com/calendar/v3/calendars/ccunningham%40soardcharity.com/events/${id()}?sendUpdates=all`)));

  // A staff member joins: quietly, the family isn't emailed
  members.push({ isInternal: true, role: { name: 'Designer' }, user: { name: 'Linzi Berkowitz', emailAddress: 'linzi@soardcharity.com' } });
  calls.length = 0;
  assert.equal((await run()).action, 'updated quietly');
  assert.ok(calls.some((c) => c.includes('sendUpdates=none')));

  // Someone from the sponsor is given access to the job (Sponsor role): Google invites just them
  jt = job({ demoDate: '2026-10-28', sponsor: 'Beazer', aces: [access('Sponsor', 'Bea', 'b@beazer.example')] });
  assert.equal((await run()).action, 'updated');
  assert.ok(events.get(id()).attendees.some((a) => a.email === 'b@beazer.example'));
});

test('an invite already sent by hand from the organizer\'s calendar is left alone, unless an admin sends ours anyway', async () => {
  await writeConfig(env.DB, { enabled: true });
  handEvents = [{ id: 'clareecesown1', status: 'confirmed', summary: 'CONFIRMED: Max Demo Day', start: { dateTime: '2026-10-26T09:00:00-04:00' } }];
  const r = await run();
  assert.deepEqual([r.action, r.found], ['by-hand', 'CONFIRMED: Max Demo Day']);
  assert.deepEqual(writesToGoogle(), [], 'no second invite');
  const row = await env.DB.prepare('SELECT state, last_action FROM demo_invites WHERE job_id = ?').bind(jt.id).first();
  assert.deepEqual(row, { state: 'by-hand', last_action: `${SENT_BY_HAND}: "CONFIRMED: Max Demo Day"` });
  assert.equal((await run()).reason, SENT_BY_HAND, 'and stays left alone');
  assert.equal((await run({ force: true })).action, 'created', 'Send ours anyway');
});

test('sent by hand means "demo" and the kid\'s name in the title, near the date; another kid\'s demo day never counts', async () => {
  const find = (items, o = {}) => findSentByHand('tok', ORGANIZER, { date: '2026-10-26', name: 'Max', jobName: 'Max Sample (2026)', ...o }, {
    fetchImpl: async () => Response.json({ items }),
  });
  const ev = (summary, extra = {}) => ({ id: `e${summary.length}`, status: 'confirmed', summary, start: { dateTime: '2026-10-26T09:00:00-04:00' }, ...extra });
  assert.ok(await find([ev('Max Demo Day!!')]));
  assert.ok(await find([ev("Max's DEMO DAY!")]));
  assert.ok(await find([ev('Sample demo')]), 'the surname from the job counts');
  assert.equal(await find([ev('Dylan Demo Day')]), null, 'another kid');
  assert.equal(await find([ev('Max design consult')]), null, 'not a demo');
  assert.equal(await find([ev('Max Demo Day', { id: eventIdFor('soarddemotest', 'x') })]), null, 'our own test invite');
  const tokens = await find([ev('Gigi Demo Day')], { name: 'Junailiz', jobName: 'Junailiz “Gigi” Torres (2026)' });
  assert.ok(tokens, 'a nickname from the job name counts');
});

test('deleting the invite in Google Calendar is how a demo day is called off; the site never brings it back', async () => {
  await writeConfig(env.DB, { enabled: true });
  assert.equal((await run()).action, 'created');
  events.delete(id());
  jt = job({ demoDate: '2026-10-28' });
  calls.length = 0;
  const r = await run();
  assert.deepEqual([r.action, r.reason], ['skip', BY_HAND]);
  assert.deepEqual(writesToGoogle(), []);
  assert.equal((await run()).reason, BY_HAND);
  assert.equal((await run({ force: true })).action, 'created', 'an admin\'s Retry sends it again');
});

test('a job closed or put on hold keeps its invite, and staff hear it once', async () => {
  await writeConfig(env.DB, { enabled: true });
  await run();
  jt = job({ closed: '2026-10-23' });
  calls.length = 0;
  assert.equal((await run()).action, 'held');
  assert.deepEqual(writesToGoogle(), [], 'never cancelled by the site');
  assert.equal(await lastLog(), 'kept: job closed');
  const emails = calls.filter((c) => c.startsWith('POST api.resend.com')).length;
  await run();
  assert.equal(calls.filter((c) => c.startsWith('POST api.resend.com')).length, emails, 'once, not every check');
  jt = job();
  assert.equal((await run()).action, 'unchanged');
  assert.equal((await env.DB.prepare('SELECT last_action FROM demo_invites WHERE job_id = ?').bind(jt.id).first()).last_action, 'back on in JobTread');
});

test('Set Start Date checked off with no Demo date: nothing sent, staff told once, sent once the date is in', async () => {
  await writeConfig(env.DB, { enabled: true });
  env.RESEND_API_KEY = 're_test';
  jt = job({ demoDate: null });
  assert.equal((await run()).action, 'waiting');
  assert.equal((await run()).action, 'waiting');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM demo_invite_log').first()).n, 1, 'told once');
  assert.deepEqual(writesToGoogle(), []);
  jt = job();
  assert.equal((await run()).action, 'created');
});

test('Google errors are recorded and reported once, not thrown', async () => {
  await writeConfig(env.DB, { enabled: true });
  const broken = async (url, init) => (String(url).includes('googleapis.com/calendar') && init?.method === 'POST' ? Response.json({ error: { message: 'Backend Error' } }, { status: 500 }) : fakeFetch(url, init));
  const r = await reconcileDemo(env, jt.id, { fetchImpl: broken, now: NOW });
  assert.equal(r.action, 'error');
  assert.match(r.error, /insert failed \(500\): Backend Error/);
  assert.equal((await run()).action, 'created', 'the next look sends it');
  assert.equal((await env.DB.prepare('SELECT error FROM demo_invites WHERE job_id = ?').bind(jt.id).first()).error, null);
});

test('a TEST job sends even while off, only to the test guests, marked TEST', async () => {
  await writeInviteConfig(env.DB, { testGuests: ['tester@soardcharity.com'] });
  jt = { ...job(), name: 'TEST Max Example (2026)' };
  const r = await run();
  assert.equal(r.action, 'created');
  assert.deepEqual(events.get(id()).attendees, [{ email: 'tester@soardcharity.com' }]);
  assert.match(events.get(id()).summary, /^TEST · /);
});

test('the test invite goes only to the person who asked, as its own event', async () => {
  await savePerson(env.DB, { list: 'always', email: 'mindi@example.com', name: 'Mindi', role: 'Social media' });
  jt = job({ startSet: false });
  const r = await sendTestDemo(env, jt.id, 'peter@soardcharity.com', { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'created', 'even before Set Start Date');
  const ev = events.get(eventIdFor('soarddemotest', jt.id));
  assert.deepEqual(ev.attendees, [{ email: 'peter@soardcharity.com' }]);
  assert.match(ev.summary, /^TEST · Max's Demo Day$/);
  assert.match(ev.description, /the real one goes to: pat\.sample@example\.com, cnielsen@soardcharity\.com, mindi@example\.com/);
  assert.ok(!events.has(id()), 'the real invite is untouched');
});

test('the 5-minute check: only while on, at most every 5 minutes, and only jobs that are due', async () => {
  assert.equal(await maybeCheckDemos(env, { fetchImpl: fakeFetch, now: NOW }), null, 'off: nothing');
  await writeConfig(env.DB, { enabled: true });
  const first = await maybeCheckDemos(env, { fetchImpl: fakeFetch, now: NOW });
  assert.deepEqual(first.map((r) => r.action), ['created']);
  assert.equal(await maybeCheckDemos(env, { fetchImpl: fakeFetch, now: NOW + 60_000 }), null, 'a minute later: not due');
  jt = job({ demoDate: '2026-10-29' });
  const later = await maybeCheckDemos(env, { fetchImpl: fakeFetch, now: NOW + 5 * 60_000 });
  assert.deepEqual(later.map((r) => r.action), ['updated'], 'a moved Demo task reaches the calendar within 5 minutes');
  // Not due: Set Start Date open and nothing out
  await env.DB.prepare('DELETE FROM demo_invites').run();
  jt = job({ startSet: false });
  calls.length = 0;
  assert.deepEqual(await maybeCheckDemos(env, { fetchImpl: fakeFetch, now: NOW + 10 * 60_000 }), []);
  assert.ok(!calls.some((c) => c.includes('googleapis')));
});

test('the JobTread wake-up for a task checked off sends the demo day invite too', async () => {
  await writeConfig(env.DB, { enabled: true });
  const eventId = 'evtJob000001';
  jtEvents.set(eventId, { id: eventId, createdAt: new Date().toISOString(), organization: { id: '22NJw42j5GLg' }, job: { id: jt.id } });
  const waits = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const res = await wakeRoute.onRequestPost({
      request: new Request('https://x/api/reveal-invites', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' }, body: JSON.stringify({ jobId: jt.id, eventId, source: 'construction' }) }),
      env, waitUntil: (p) => waits.push(p),
    });
    await Promise.allSettled(waits);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(events.has(id()), 'Set Start Date checked off → the invite is out');
});

// ── The admin ──

async function adminGet(query = '', userEmail = 'peter@soardcharity.com') {
  const waits = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const res = await admin.onRequestGet({ request: new Request(`https://x/api/demo-invites-admin${query}`), env, data: { userEmail }, waitUntil: (p) => waits.push(p) });
    await Promise.allSettled(waits);
    return res.json();
  } finally { globalThis.fetch = real; }
}
async function adminPost(body) {
  const waits = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const res = await admin.onRequestPost({ request: new Request('https://x/api/demo-invites-admin', { method: 'POST', body: JSON.stringify(body) }), env, data: { userEmail: 'peter@soardcharity.com' }, waitUntil: (p) => waits.push(p) });
    await Promise.allSettled(waits);
    return { status: res.status, ...(await res.json()) };
  } finally { globalThis.fetch = real; }
}

test('admin: every demo day ahead with the exact invite and guests by group, the sponsor choices, and the lists', async () => {
  await savePerson(env.DB, { list: 'always', email: 'mindi@example.com', name: 'Mindi', role: 'Social media' });
  jt = job({ sponsor: 'Jackson Healthcare' });
  const d = await adminGet();
  assert.equal(d.ok, true);
  assert.equal(d.config.enabled, false);
  assert.deepEqual(d.people.always, [{ email: 'mindi@example.com', name: 'Mindi', role: 'Social media' }]);
  assert.equal(d.organizerName, 'Clareece Cunningham');
  assert.deepEqual(d.staff.map((s) => s.name), ['Christian Nielsen'], 'the internal team, without the organizer or the committee login');
  assert.equal(d.demos.length, 1);
  const demo = d.demos[0];
  assert.deepEqual([demo.name, demo.date, demo.time, demo.startSet, demo.sponsor, demo.sponsorOnJob], ['Max', '2026-10-26', null, true, 'Jackson Healthcare', []], 'the sponsor named, with nobody from it on the job');
  assert.equal(demo.preview.title, "Max's Demo Day");
  assert.deepEqual(demo.preview.guests.map((g) => [g.email, g.kind]), [['pat.sample@example.com', 'family'], ['cnielsen@soardcharity.com', 'staff'], ['mindi@example.com', 'always']]);
  assert.equal(demo.invite, null);
  // Someone from the sponsor given access to the job: named, and invited
  jt = job({ sponsor: 'Jackson Healthcare', aces: [access('Sponsor', 'Jo Giving', 'giving@jackson.example')] });
  const d2 = (await adminGet()).demos[0];
  assert.deepEqual(d2.sponsorOnJob, ['Jo Giving']);
  assert.ok(d2.preview.guests.some((g) => g.email === 'giving@jackson.example' && g.kind === 'sponsor'));
});

test('admin: an invite already sent by hand shows before sending is turned on, and isn\'t counted as ready', async () => {
  handEvents = [{ id: 'clareecesown1', summary: 'CONFIRMED: Max Demo Day', start: { dateTime: '2026-10-26T09:00:00-04:00' } }];
  const d = await adminGet();
  assert.deepEqual(d.demos[0].handSent, { title: 'CONFIRMED: Max Demo Day', date: '2026-10-26' });
  assert.equal(d.demos[0].invite, null, 'nothing recorded: listing only looks');
  assert.deepEqual(writesToGoogle(), []);
  handEvents = [];
  assert.equal((await adminGet()).demos[0].handSent, undefined);
});

test('admin: lists, wording and the default time are checked; a list change reaches invites already out', async () => {
  await writeConfig(env.DB, { enabled: true });
  await run();
  let r = await adminPost({ person: { list: 'always', email: 'mindi@example.com', name: 'Mindi', role: 'Social media' } });
  assert.equal(r.ok, true);
  assert.ok(events.get(id()).attendees.some((a) => a.email === 'mindi@example.com'), 'added to the invite already out');
  r = await adminPost({ removePerson: { list: 'always', email: 'mindi@example.com' } });
  assert.ok(!events.get(id()).attendees.some((a) => a.email === 'mindi@example.com'), 'and taken off');
  assert.equal((await adminPost({ person: { list: 'always', email: 'nope' } })).status, 400);
  assert.equal((await adminPost({ template: { title: '', message: 'x' } })).status, 400);
  assert.equal((await adminPost({ startTime: '9am' })).status, 400);
  assert.equal((await adminPost({ minutes: 5 })).status, 400);
  r = await adminPost({ startTime: '10:00', minutes: 120 });
  assert.equal(r.ok, true);
  assert.equal(events.get(id()).start.dateTime, '2026-10-26T10:00:00', 'a new default time moves invites out (a fact)');
  assert.equal(events.get(id()).end.dateTime, '2026-10-26T12:00:00');
  r = await adminPost({ template: { title: '{name} Demo Day', message: 'Demo day for {name} is {when}.' } });
  assert.equal(events.get(id()).summary, "Max's Demo Day", 'new wording alone never emails guests');
  r = await adminPost({ template: { title: '{name} Demo Day', message: 'Demo day for {name} is {when}.' }, updateExisting: true });
  assert.equal(events.get(id()).summary, 'Max Demo Day', 'unless asked');
});

test('admin: Retry, Send ours anyway, and the test invite', async () => {
  handEvents = [{ id: 'clareecesown1', summary: 'Max Demo Day', start: { dateTime: '2026-10-26T09:00:00-04:00' } }];
  await writeConfig(env.DB, { enabled: true });
  assert.equal((await adminGet(`?sync=${jt.id}`)).action, 'by-hand');
  assert.equal((await adminGet(`?sync=${jt.id}&force=1`)).action, 'created');
  const t = await adminGet(`?test=${jt.id}`, 'peter@soardcharity.com');
  assert.deepEqual([t.ok, t.sentTo, t.action], [true, 'peter@soardcharity.com', 'created']);
  assert.equal((await adminGet('?test=bad id')).ok, false);
});

test('the default wording, exactly', () => {
  assert.deepEqual(DEFAULT_TEMPLATE, {
    title: "{name}'s Demo Day",
    message: "{name}'s {space} makeover starts with demo day on {when}.\n\nIt's the first day of construction. Please accept or decline so we know who to expect.",
  });
});
