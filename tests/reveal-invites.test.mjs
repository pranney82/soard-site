/**
 * Reveal calendar invites (functions/api/_reveal-invites.js, _google-calendar.js)
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { guestGroups, fetchBoard, boardRoster, setBoardEmail, planInvite, reconcileJob, sendTestInvite, writeConfig, readConfig, renderTemplate, listUpcoming, maybeSweep, DEFAULT_TEMPLATE, REVEAL_TASK_TYPE, FIELD_STATUS, FIELD_INVITE_DETAILS, FIELD_CONTACT_EMAIL } from '../functions/api/_reveal-invites.js';
import { serviceAccountJwt, eventIdFor, clearTokenCache, parseServiceAccount } from '../functions/api/_google-calendar.js';
import { FIELD_REVEAL_CONFIRMED } from '../functions/api/_reveals.js';

const NOW = Date.parse('2026-10-16T14:00:00Z');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'reveals@soard-cal.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

const STAFF = [{ name: 'Christian Nielsen', email: 'cnielsen@soardcharity.com' }, { name: 'Clareece Cunningham', email: 'ccunningham@soardcharity.com' }];
const KIDS = [{ slug: 'max', name: 'Max', year: 2026 }];

function job({ date = '2026-10-27', time = null, confirmed = false, built = true, status = 'Build', closed = null, details = '' } = {}) {
  return {
    id: '22PTestJob001', name: 'Max Sample (2026)', closedOn: closed, organization: { id: '22NJw42j5GLg' },
    location: { address: '100 Example Way, Atlanta, GA 30301, USA', account: { contacts: { nodes: [
      { name: 'Pat Sample', customFieldValues: { nodes: [{ value: 'pat.sample@example.com', customField: { id: FIELD_CONTACT_EMAIL } }] } },
      { name: 'No Email', customFieldValues: { nodes: [] } },
    ] } } },
    customFieldValues: { nodes: [
      { value: status, customField: { id: FIELD_STATUS } },
      ...(confirmed ? [{ value: 'Yes 👍', customField: { id: FIELD_REVEAL_CONFIRMED } }] : []),
      ...(details ? [{ value: details, customField: { id: FIELD_INVITE_DETAILS } }] : []),
    ] },
    tasks: { nodes: [
      { id: 't1', name: 'Reveal', startDate: date, startTime: time, endDate: date, endTime: null, progress: null, taskType: { id: REVEAL_TASK_TYPE } },
      { id: 't2', name: 'Build Schedule', progress: built ? 1 : null, taskType: null },
    ] },
  };
}

test('tentative invite once the schedule is built', () => {
  const p = planInvite(job(), STAFF, { kids: KIDS, now: NOW });
  assert.equal(p.action, 'upsert');
  assert.equal(p.event.summary, "Tentative: Max's Reveal Day");
  assert.equal(p.event.status, 'tentative');
  assert.deepEqual(p.event.start, { date: '2026-10-27' });
  assert.deepEqual(p.event.end, { date: '2026-10-28' });
  assert.equal(p.event.location, '100 Example Way, Atlanta, GA 30301, USA');
  assert.equal(p.event.id, eventIdFor('soardreveal', '22PTestJob001'));
  assert.match(p.event.id, /^[a-v0-9]+$/, 'Google event ids allow a-v and 0-9 only');
  // Family first, staff after, organizer (Clareece) never a guest, emails lowercased
  assert.deepEqual(p.guests, ['pat.sample@example.com', 'cnielsen@soardcharity.com']);
  assert.equal(p.event.guestsCanSeeOtherGuests, false);
  assert.match(p.event.description, /tentative date for Max's reveal/);
  assert.match(p.event.description, /\/kids\/max\//);
});

test('confirmed with a time becomes a timed, confirmed event in Eastern time', () => {
  const p = planInvite(job({ time: '16:00:00.000', confirmed: true, details: 'Park on the street.' }), STAFF, { kids: KIDS, now: NOW });
  assert.equal(p.event.summary, "Max's Reveal Day");
  assert.equal(p.event.status, 'confirmed');
  assert.deepEqual(p.event.start, { dateTime: '2026-10-27T16:00:00', timeZone: 'America/New_York' });
  assert.deepEqual(p.event.end, { dateTime: '2026-10-27T17:00:00', timeZone: 'America/New_York' });
  assert.match(p.event.description, /Park on the street\./);
});

test('when there should be no invite', () => {
  const plan = (o) => planInvite(job(o), STAFF, { kids: KIDS, now: NOW });
  assert.equal(plan({ built: false }).action, 'cancel', 'schedule not built yet');
  assert.equal(plan({ built: false, confirmed: true }).action, 'upsert', 'confirmed counts even without Build Schedule');
  assert.equal(plan({ status: 'Awaiting Funding' }).action, 'cancel');
  assert.equal(plan({ closed: '2026-10-20' }).action, 'cancel');
  assert.equal(plan({ date: null }).action, 'cancel');
  assert.equal(plan({ date: '2026-10-07' }).action, 'skip', 'past reveals are left alone');
  assert.equal(planInvite({ ...job(), organization: { id: 'other' } }, STAFF, { now: NOW }).action, 'skip');
});

test('a reveal that has happened is never cancelled or changed, even when the job closes the same day', () => {
  // NOW is 10:00 AM Eastern on October 16
  const plan = (o, tweak = (j) => j) => planInvite(tweak(job({ confirmed: true, ...o })), STAFF, { kids: KIDS, now: NOW });
  assert.equal(plan({ date: '2026-10-16', time: '09:00:00.000', closed: '2026-10-16' }).action, 'skip', 'this morning\'s reveal, job closed after: no cancellation email');
  assert.equal(plan({ date: '2026-10-16', time: '16:00:00.000', closed: '2026-10-16' }).action, 'cancel', 'closed before this afternoon\'s reveal: it is called off');
  assert.equal(plan({ date: '2026-10-16', time: null, closed: '2026-10-16' }).action, 'skip', 'an all-day reveal today counts as under way');
  const done = (j) => ({ ...j, tasks: { nodes: j.tasks.nodes.map((t) => (t.name === 'Reveal' ? { ...t, progress: 1 } : t)) } });
  assert.equal(plan({ date: '2026-10-27', closed: '2026-10-16' }, done).action, 'skip', 'Reveal task marked complete: it happened, whatever the date says');
  assert.equal(plan({ date: '2026-10-27', closed: '2026-10-16' }).action, 'cancel', 'a future reveal on a closed job is still cancelled');
});

// Two stages: tentative → staff and family; confirmed → plus the people given access to the job and the board
const access = (role, name, emailAddress, isInternal = false) => ({ membership: { isInternal, role: { name: role }, user: { name, emailAddress } } });
function islaLike(o) {
  const j = job(o);
  j.location.account.contacts.nodes.push({ name: 'Morgan Lee', customFieldValues: { nodes: [{ value: 'wish.coordinator@example.com', customField: { id: FIELD_CONTACT_EMAIL } }] } });
  j.aces = { nodes: [
    access('Makeover Family', 'Erin Example', 'erin.example@example.com'),
    access('Sponsor', 'Morgan Lee', 'wish.coordinator@example.com'),
    access('Vendor', 'Mike Kamber', 'gym.vendor@example.com'),
    access('Vendor', 'Niki Murphy', 'niki.photo@example.com'),
    access('Application Reviewer', 'A Reviewer', 'reviewer@example.com'),
    access('Admin', 'Qualification Committee', 'selection@soardcharity.com', true),
  ] };
  return j;
}
const BOARD = [{ name: 'Scott Wierson', email: 'scott@example.com', from: 'website' }];

test('tentative invite: staff and the family only; a sponsor who is also a family contact waits for confirmation', () => {
  const p = planInvite(islaLike(), STAFF, { kids: KIDS, board: BOARD, now: NOW });
  assert.equal(p.event.status, 'tentative');
  assert.deepEqual(p.guests, ['pat.sample@example.com', 'erin.example@example.com', 'cnielsen@soardcharity.com']);
  assert.deepEqual(p.addsOnConfirm.map((x) => [x.email, x.kind]), [
    ['wish.coordinator@example.com', 'sponsor'],
    ['gym.vendor@example.com', 'vendor'],
    ['niki.photo@example.com', 'vendor'],
    ['scott@example.com', 'board'],
  ], 'the preview says who confirming adds');
  assert.equal(p.people['erin.example@example.com'].kind, 'family');
});

test('confirmed invite: the same event adds the job\'s vendors, sponsors and the board; reviewers and committee logins never', () => {
  const p = planInvite(islaLike({ confirmed: true, time: '16:00:00.000' }), STAFF, { kids: KIDS, board: BOARD, now: NOW });
  assert.equal(p.event.status, 'confirmed');
  assert.deepEqual(p.guests, [
    'pat.sample@example.com', 'erin.example@example.com', 'cnielsen@soardcharity.com',
    'wish.coordinator@example.com', 'gym.vendor@example.com', 'niki.photo@example.com', 'scott@example.com',
  ]);
  assert.ok(!p.guests.includes('reviewer@example.com') && !p.guests.includes('selection@soardcharity.com'));
  assert.equal(p.people['wish.coordinator@example.com'].kind, 'sponsor');
  assert.equal(p.event.guestsCanSeeOtherGuests, false, 'board and vendors never see the family\'s emails');
  assert.deepEqual(p.addsOnConfirm, []);
});

test('the board comes from the website (with a private email) and the JobTread Board Member role; memorials never', async () => {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS team (slug TEXT PRIMARY KEY, data TEXT NOT NULL)').run();
  const put = (slug, data) => env.DB.prepare('INSERT OR REPLACE INTO team (slug, data) VALUES (?, ?)').bind(slug, JSON.stringify(data)).run();
  await put('scott-wierson', { name: 'Scott Wierson', title: 'Board Chair', group: 'board' });
  await put('mary-atchley', { name: 'Mary Atchley', title: 'Board Member', group: 'board' });
  await put('brent-aronson', { name: 'In memoriam, Brent Aronson', title: 'Board Member 2024-2025', group: 'board' });
  await put('holly-ranney', { name: 'Holly Ranney', title: 'Director', group: 'team' });
  await setBoardEmail(env.DB, 'scott-wierson', ' Scott@Example.com ');
  await setBoardEmail(env.DB, 'brent-aronson', 'brent@example.com');
  await setBoardEmail(env.DB, 'holly-ranney', 'holly@example.com');
  await assert.rejects(() => setBoardEmail(env.DB, 'mary-atchley', 'not an email'));
  const roster = await boardRoster(env.DB);
  assert.deepEqual(roster.map((m) => [m.slug, m.email, m.memorial]), [['brent-aronson', 'brent@example.com', true], ['mary-atchley', null, false], ['scott-wierson', 'scott@example.com', false]], 'the website board, with who has an email');
  boardMembers = [{ user: { name: 'New Member', emailAddress: 'new@example.com' } }];
  const board = await fetchBoard(env, fakeFetch);
  assert.deepEqual(board.map((x) => [x.email, x.from]), [['scott@example.com', 'website'], ['new@example.com', 'jobtread']],
    'Mary has no email yet, Brent is a memorial, Holly is staff not board');
});

test('confirming adds the stage-two guests and emails everyone; un-confirming takes them back off', async () => {
  await writeConfig(env.DB, { enabled: true });
  boardMembers = [{ user: { name: 'Board Person', emailAddress: 'board@example.com' } }];
  jt = islaLike();
  await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  const id = eventIdFor('soardreveal', jt.id);
  assert.ok(!events.get(id).attendees.some((a) => a.email === 'board@example.com'), 'tentative: no board yet');
  jt = islaLike({ confirmed: true, time: '16:00:00.000' });
  const r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'updated');
  assert.ok(calls.some((c) => c.includes('sendUpdates=all')), 'new guests get the invite, everyone gets the update');
  assert.deepEqual(events.get(id).attendees.map((a) => a.email).slice(-4), ['wish.coordinator@example.com', 'gym.vendor@example.com', 'niki.photo@example.com', 'board@example.com']);
  jt = islaLike();
  await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.deepEqual(events.get(id).attendees.map((a) => a.email), ['pat.sample@example.com', 'erin.example@example.com', 'cnielsen@soardcharity.com'], 'back to staff and family');
});

test('the Google sign-in JWT is signed by the service account and impersonates the organizer', async () => {
  const jwt = await serviceAccountJwt(KEY, 'ccunningham@soardcharity.com', NOW);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.sub, 'ccunningham@soardcharity.com');
  assert.equal(claims.iss, KEY.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/calendar.events');
  assert.equal(claims.exp - claims.iat, 3600);
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
  assert.ok(ok, 'signature verifies with the public key');
});

test('the key is read however it was pasted, and errors never echo it', () => {
  const json = JSON.stringify(KEY, null, 2);
  const ok = (raw) => assert.equal(parseServiceAccount(raw).client_email, KEY.client_email);
  ok(json);                                                    // the downloaded file
  ok(`  ${json}\n`);                                           // stray whitespace
  ok(JSON.stringify(json));                                    // wrapped in quotes
  ok(json.replace(/"/g, (_, i) => (i % 2 ? '“' : '”')));   // smart quotes
  ok(json.replace(/\\n/g, '\n'));                              // real line breaks inside the private key
  ok(Buffer.from(json).toString('base64'));                    // base64 of the file
  assert.throws(() => parseServiceAccount(KEY.private_key), (e) => /only the private key/.test(e.message) && !e.message.includes('MII'));
  assert.throws(() => parseServiceAccount(json.slice(0, 500)), (e) => /cut off/.test(e.message) && !e.message.includes(KEY.client_email));
  assert.throws(() => parseServiceAccount(JSON.stringify({ client_id: '1' })), /missing client_email and private_key/);
  assert.throws(() => parseServiceAccount(''), /it is empty/);
});

// ── End to end against fake JobTread + Google ──
const BASE_MEMBERS = [
  { isInternal: true, role: { name: 'Admin' }, user: { name: 'Christian Nielsen', emailAddress: 'cnielsen@soardcharity.com' } },
  { isInternal: true, role: { name: 'Admin' }, user: { name: 'Qualification Committee', emailAddress: 'selection@soardcharity.com' } },
  { isInternal: true, role: { name: 'Admin' }, user: { name: 'DATAx', emailAddress: 'hello@contractorcto.com' } },
  { isInternal: false, role: { name: 'Makeover Family' }, user: { name: 'Someone Else', emailAddress: 'other@family.com' } },
  { isInternal: false, role: { name: 'Vendor' }, user: { name: 'Real Floors', emailAddress: 'vendor@floors.com' } },
];
let env, calls, events, jt, members, boardMembers;
beforeEach(async () => {
  members = [...BASE_MEMBERS];
  boardMembers = [];
  clearTokenCache();
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER, status TEXT, data TEXT NOT NULL)',
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
  ] });
  await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind('max', 'Max', 2026, 'in-progress', '{"name":"Max","slug":"max"}').run();
  env = { DB, JOBTREAD_GRANT_KEY: 'grant_test', GOOGLE_CALENDAR_KEY: JSON.stringify(KEY) };
  calls = [];
  events = new Map();
  jt = job();
});

async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  calls.push(`${init.method || 'GET'} ${u.hostname}${u.pathname}${u.search}`);
  if (u.hostname === 'api.jobtread.com') {
    const q = JSON.parse(init.body).query;
    if (q.job) return Response.json({ job: jt });
    // Board Member users (none here); otherwise the staff read
    if (JSON.stringify(q.organization?.memberships?.$?.where || '').includes('role')) return Response.json({ organization: { memberships: { nodes: boardMembers } } });
    return Response.json({ organization: { memberships: { nodes: members } } });
  }
  if (u.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
  if (u.hostname === 'www.googleapis.com') {
    const id = u.pathname.split('/events/')[1];
    if (init.method === 'GET' || !init.method) return events.has(id) ? Response.json(events.get(id)) : Response.json({ error: { message: 'Not Found' } }, { status: 404 });
    if (init.method === 'DELETE') { events.delete(id); return new Response(null, { status: 204 }); }
    const ev = JSON.parse(init.body);
    events.set(ev.id || id, ev);
    return Response.json(ev);
  }
  throw new Error(`unexpected fetch ${url}`);
}

test('nothing is sent until sending is turned on', async () => {
  const r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'would-create');
  assert.ok(!calls.some(c => c.includes('googleapis')), 'Google not called');
});

test('create, move, confirm, cancel: one event, updated in place', async () => {
  await writeConfig(env.DB, { enabled: true });
  const id = eventIdFor('soardreveal', jt.id);

  let r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'created');
  assert.equal(r.guests, 2, 'family + Christian; not the committee login, vendors or other families');
  assert.ok(calls.some(c => c.startsWith('POST www.googleapis.com/calendar/v3/calendars/ccunningham%40soardcharity.com/events?sendUpdates=all')));

  // Same JobTread state again: no second email
  calls.length = 0;
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'unchanged');
  assert.ok(!calls.some(c => c.includes('googleapis')));

  // Task moved: the same event is updated
  jt = job({ date: '2026-10-29' });
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'updated');
  assert.deepEqual(events.get(id).start, { date: '2026-10-29' });
  assert.ok(calls.some(c => c.startsWith(`PUT www.googleapis.com/calendar/v3/calendars/ccunningham%40soardcharity.com/events/${id}?sendUpdates=all`)));

  // Confirmed with a time
  jt = job({ date: '2026-10-29', time: '15:30', confirmed: true });
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'updated');
  assert.equal(events.get(id).summary, "Max's Reveal Day");
  assert.equal(events.get(id).status, 'confirmed');

  // Put on hold: cancelled
  jt = job({ date: '2026-10-29', status: 'Awaiting Funding' });
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'cancelled');
  assert.ok(!events.has(id));
});

test('the office sandbox sends even while sending is off, only to the test guests, marked TEST', async () => {
  jt = { ...job(), id: '22P3HTX9cXn4', name: 'Sunshine Office 2025' };
  const r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'created');
  assert.equal(r.guests, 1);
  const ev = events.get(eventIdFor('soardreveal', jt.id));
  assert.deepEqual(ev.attendees, [{ email: 'peter@soardcharity.com' }], 'no family, no staff');
  assert.equal(ev.summary, "TEST · Tentative: Sunshine's Reveal Day");
  // ...while a real job in the same state still only reports what it would do
  jt = job();
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'would-create');
});

test('a JobTread "TEST …" job is a sandbox too: invites reach only the test guests, marked TEST, named after the kid', async () => {
  jt = { ...job({ confirmed: true, time: '16:00:00.000' }), id: 'jobTst0001', name: 'TEST Max Sample (2026)' };
  const r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'created', 'sends even while sending is off');
  const ev = events.get(eventIdFor('soardreveal', jt.id));
  assert.deepEqual(ev.attendees, [{ email: 'peter@soardcharity.com' }], 'no family, no staff');
  assert.equal(ev.summary, "TEST · Max's Reveal Day");
  // A job merely containing the word is not a test job
  jt = { ...job(), id: 'jobOth0001', name: 'Max Testa (2026)' };
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'would-create');
});

test('staff come from a staff-only read, so new staff are never cut off by families and vendors', async () => {
  let staffQuery = null;
  const spy = async (url, init = {}) => {
    const q = new URL(url).hostname === 'api.jobtread.com' ? JSON.parse(init.body).query : null;
    const where = q?.organization?.memberships?.$?.where;
    if (where && where[0] === 'isInternal') staffQuery = q.organization.memberships.$;
    return fakeFetch(url, init);
  };
  await writeConfig(env.DB, { enabled: true });
  await reconcileJob(env, jt.id, { fetchImpl: spy, now: NOW });
  assert.deepEqual(staffQuery.where, ['isInternal', '=', true]);
  const ev = events.get(eventIdFor('soardreveal', jt.id));
  assert.ok(!ev.attendees.some((a) => a.email === 'hello@contractorcto.com'), 'the DATAx integration login is not a guest');
});

test('staff guest list changes update quietly; family changes email everyone', async () => {
  await writeConfig(env.DB, { enabled: true });
  members = [...BASE_MEMBERS, { isInternal: true, role: { name: 'Admin' }, user: { name: 'Peter Ranney', emailAddress: 'peter@ranneyblair.com' } }];
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'created');
  const id = eventIdFor('soardreveal', jt.id);
  assert.ok(events.get(id).attendees.some(a => a.email === 'peter@soardcharity.com'), 'JobTread login mapped to the soardcharity address');
  assert.ok(!events.get(id).attendees.some(a => a.email === 'peter@ranneyblair.com'));

  // A staff member is added in JobTread: no emails to anyone
  members = [...members, { isInternal: true, role: { name: 'Designer' }, user: { name: 'Linzi Berkowitz', emailAddress: 'lberkowitz@soardcharity.com' } }];
  calls.length = 0;
  let r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'updated quietly');
  assert.ok(calls.some(c => c.startsWith('PUT') && c.endsWith('sendUpdates=none')));
  assert.ok(events.get(id).attendees.some(a => a.email === 'lberkowitz@soardcharity.com'));

  // The family adds a contact: everyone gets the update so the new person is invited
  const j = job();
  j.location.account.contacts.nodes.push({ name: 'Grandma', customFieldValues: { nodes: [{ value: 'grandma@example.com', customField: { id: FIELD_CONTACT_EMAIL } }] } });
  jt = j;
  calls.length = 0;
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'updated');
  assert.ok(calls.some(c => c.startsWith('PUT') && c.endsWith('sendUpdates=all')));

  // A date change with a staff change still emails everyone
  members = BASE_MEMBERS;
  jt = { ...j, tasks: job({ date: '2026-10-30' }).tasks };
  calls.length = 0;
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'updated');
  assert.ok(calls.some(c => c.startsWith('PUT') && c.endsWith('sendUpdates=all')));
});

test('Google errors are recorded, not thrown', async () => {
  await writeConfig(env.DB, { enabled: true });
  const failing = async (url, init) => (new URL(url).hostname === 'oauth2.googleapis.com'
    ? Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens' }, { status: 401 })
    : fakeFetch(url, init));
  const r = await reconcileJob(env, jt.id, { fetchImpl: failing, now: NOW });
  assert.equal(r.action, 'error');
  assert.match(r.error, /unauthorized_client/);
  const row = await env.DB.prepare('SELECT error FROM reveal_invites WHERE job_id = ?').bind(jt.id).first();
  assert.match(row.error, /unauthorized_client/);
});

test('test invite goes only to the tester, as a separate event', async () => {
  const r = await sendTestInvite(env, jt.id, 'peter@soardcharity.com', { fetchImpl: fakeFetch, now: NOW, date: '2026-10-30', time: '16:00' });
  assert.equal(r.action, 'created');
  const ev = events.get(eventIdFor('soardrevealtest', jt.id));
  assert.deepEqual(ev.attendees, [{ email: 'peter@soardcharity.com' }]);
  assert.equal(ev.summary, "TEST · Tentative: Max's Reveal Day");
  assert.deepEqual(ev.start, { dateTime: '2026-10-30T16:00:00', timeZone: 'America/New_York' });
  assert.match(ev.description, /pat\.sample@example\.com, cnielsen@soardcharity\.com/);
  assert.ok(!events.has(eventIdFor('soardreveal', jt.id)), 'the real event is untouched');

  const c = await sendTestInvite(env, jt.id, 'peter@soardcharity.com', { fetchImpl: fakeFetch, now: NOW, cancel: true });
  assert.equal(c.action, 'cancelled');
  assert.equal(events.size, 0);
});

test('the default wording is exactly what invites already went out with', () => {
  const p = planInvite(job(), STAFF, { kids: KIDS, now: NOW });
  assert.equal(p.event.summary, "Tentative: Max's Reveal Day");
  assert.equal(p.event.description, "This is a tentative date for Max's reveal while the build wraps up.\nThis invite updates automatically if the date moves, and the time is added once the reveal is confirmed.\n\nhttps://sunshineonaranneyday.com/kids/max/");
});

test('wording from admin fills in name, date and time', () => {
  assert.equal(renderTemplate('{name} on {date} at {time}, {when}. {other}', { name: 'Max', date: '2026-10-27', time: '16:00' }),
    'Max on Tuesday, October 27 at 4:00 PM, Tuesday, October 27 at 4:00 PM. {other}');
  assert.equal(renderTemplate('{when}', { name: 'Max', date: '2026-10-27', time: null }), 'Tuesday, October 27 (time to come)');
  const template = { ...DEFAULT_TEMPLATE, confirmedTitle: 'Reveal Day: {name}!', confirmedMessage: 'See you {when}.' };
  const p = planInvite(job({ confirmed: true, time: '09:30', details: 'Gate code 1234' }), STAFF, { kids: KIDS, now: NOW, template });
  assert.equal(p.event.summary, 'Reveal Day: Max!');
  assert.equal(p.event.description, 'See you Tuesday, October 27 at 9:30 AM.\n\nGate code 1234\n\nhttps://sunshineonaranneyday.com/kids/max/');
});

test('admin list: upcoming reveals with the exact invite each would send, guests named', async () => {
  await writeConfig(env.DB, { enabled: true });
  await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  const jobs = [
    jt,
    { ...job({ date: '2026-10-07' }), id: 'pastJob0001', name: 'Peter Raish (2026)' },
    { ...job(), id: '22P3HTX9cXn4', name: 'Sunshine Office 2025' },
    { ...job({ built: false, date: '2026-11-11' }), id: 'colinJob001', name: 'Colin Lindsay (2026)' },
  ];
  const contactReads = [];
  const listFetch = async (url, init) => {
    if (new URL(url).hostname === 'api.jobtread.com') {
      const q = JSON.parse(init.body).query;
      if (q.organization?.jobs) {
        // JobTread answers 413 when a jobs list is too big in the worst case
        const { $: args, nodes } = q.organization.jobs;
        if (nodes.location?.account || args.size > 25) return new Response('Request Entity Too Large', { status: 413 });
        const pageJobs = args.page === 'p2' ? jobs.slice(2) : jobs.slice(0, 2);
        return Response.json({ organization: { jobs: {
          nextPage: args.page === 'p2' ? null : 'p2',
          nodes: pageJobs.map(j => ({ ...j, location: { address: j.location.address } })),
        } } });
      }
      if (q.job?.location?.account) {
        contactReads.push(q.job.$.id);
        return Response.json({ job: { location: { account: jobs.find(j => j.id === q.job.$.id).location.account } } });
      }
    }
    return fakeFetch(url, init);
  };
  const { reveals, organizerName } = await listUpcoming(env, { fetchImpl: listFetch, now: NOW });
  assert.deepEqual(reveals.map(r => r.jobId), [jt.id, 'colinJob001'], 'past reveals and the sandbox are left out, soonest first');
  assert.deepEqual(contactReads.sort(), [jt.id, 'colinJob001'].sort(), 'family contacts are read only for upcoming reveals');
  const max = reveals[0];
  assert.equal(max.name, 'Max');
  assert.equal(max.kidUrl, '/kids/max/');
  assert.equal(max.jobUrl, `https://app.jobtread.com/jobs/${jt.id}`);
  assert.equal(max.invite.state, 'tentative');
  assert.deepEqual(max.invite.log.map(l => [l.action, l.state, l.guests]), [['created', 'tentative', 2]], 'invite history for the tracker on Reveals → Now');
  assert.equal(max.slug, 'max');
  assert.equal(max.preview.title, "Tentative: Max's Reveal Day");
  assert.equal(max.preview.location, '100 Example Way, Atlanta, GA 30301, USA');
  assert.deepEqual(max.preview.guests, [
    { email: 'pat.sample@example.com', name: 'Pat Sample', kind: 'family' },
    { email: 'cnielsen@soardcharity.com', name: 'Christian Nielsen', kind: 'staff' },
  ]);
  assert.ok(reveals[1].preview, 'a reveal not scheduled yet still previews how its invite will look');
  assert.equal(reveals[1].invite, null);
  assert.equal(organizerName, null, 'organizer name comes from JobTread staff when she is on the list');
});

test('a new problem emails the team once; the same problem again does not', async () => {
  await writeConfig(env.DB, { enabled: true });
  env.RESEND_API_KEY = 're_test';
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('resend.com')) { sent.push(JSON.parse(init.body)); return Response.json({ data: [] }); }
    return realFetch(url, init);
  };
  const broken = async (url, init) => (new URL(url).hostname === 'www.googleapis.com' && init?.method === 'POST'
    ? Response.json({ error: { message: 'Calendar usage limits exceeded.' } }, { status: 403 })
    : fakeFetch(url, init));
  try {
    assert.equal((await reconcileJob(env, jt.id, { fetchImpl: broken, now: NOW })).action, 'error');
    assert.equal(sent.length, 1);
    const recipients = sent[0].map(m => m.to[0]).sort();
    assert.deepEqual(recipients, ['ccunningham@soardcharity.com', 'peter@soardcharity.com']);
    assert.match(sent[0][0].subject, /Reveal invite problem: Max/);
    assert.match(sent[0][0].text, /usage limits exceeded/);
    assert.equal((await reconcileJob(env, jt.id, { fetchImpl: broken, now: NOW })).action, 'error');
    assert.equal(sent.length, 1, 'same problem, no second email');
    assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'created', 'recovers on the next try');
  } finally {
    globalThis.fetch = realFetch;
    delete env.RESEND_API_KEY;
  }
});

test('two changes at once: the second insert updates instead of failing', async () => {
  await writeConfig(env.DB, { enabled: true });
  const id = eventIdFor('soardreveal', jt.id);
  const racing = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'www.googleapis.com' && (!init?.method || init.method === 'GET')) return Response.json({ error: { message: 'Not Found' } }, { status: 404 });
    if (u.hostname === 'www.googleapis.com' && init.method === 'POST') return Response.json({ error: { message: 'The requested identifier already exists.' } }, { status: 409 });
    return fakeFetch(url, init);
  };
  const r = await reconcileJob(env, jt.id, { fetchImpl: racing, now: NOW });
  assert.equal(r.action, 'updated');
  assert.ok(events.has(id));
});

test('safety sweep: only when sending is on, at most every 6 hours', async () => {
  const sweepFetch = async (url, init) => {
    if (new URL(url).hostname === 'api.jobtread.com' && JSON.parse(init.body).query.organization?.jobs) {
      return Response.json({ organization: { jobs: { nodes: [{ id: jt.id }, { id: '22P3HTX9cXn4' }] } } });
    }
    return fakeFetch(url, init);
  };
  assert.equal(await maybeSweep(env, { fetchImpl: sweepFetch, now: NOW }), null, 'off while sending is paused');
  await writeConfig(env.DB, { enabled: true });
  const first = await maybeSweep(env, { fetchImpl: sweepFetch, now: NOW });
  assert.deepEqual({ checked: first.checked, changed: first.changed, errors: first.errors }, { checked: 1, changed: 1, errors: 0 }, 'creates the missed invite; skips the sandbox');
  assert.equal(await maybeSweep(env, { fetchImpl: sweepFetch, now: NOW + 60 * 60 * 1000 }), null, 'not again within 6 hours');
  const later = await maybeSweep(env, { fetchImpl: sweepFetch, now: NOW + 7 * 60 * 60 * 1000 });
  assert.equal(later.changed, 0, 'nothing changed, nothing sent');
  assert.equal((await readConfig(env.DB)).lastSweep.checked, 1);
});
