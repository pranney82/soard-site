/**
 * Reveal calendar invites (functions/api/_reveal-invites.js, _google-calendar.js)
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { guestGroups, fetchBoard, boardRoster, setBoardEmail, planInvite, reconcileJob, reconcileAll, sendTestInvite, writeConfig, readConfig, renderTemplate, listUpcoming, maybeSweep, maybeCheckGuests, realJobFor, BY_HAND, DEFAULT_TEMPLATE, REVEAL_TASK_TYPE, FIELD_STATUS, FIELD_MAKEOVER_TYPE, FIELD_INVITE_DETAILS, FIELD_CONTACT_EMAIL, admitWake, runOwedWakes, allowedOrganizers, DEFAULT_ORGANIZER } from '../functions/api/_reveal-invites.js';
import * as wakeRoute from '../functions/api/reveal-invites.js';
import * as inviteAdmin from '../functions/api/reveal-invites-admin.js';
import { serviceAccountJwt, eventIdFor, clearTokenCache, parseServiceAccount } from '../functions/api/_google-calendar.js';
import { FIELD_REVEAL_CONFIRMED } from '../functions/api/_reveals.js';

const NOW = Date.parse('2026-10-16T14:00:00Z');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'reveals@soard-cal.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

const STAFF = [{ name: 'Christian Nielsen', email: 'cnielsen@soardcharity.com' }, { name: 'Clareece Cunningham', email: 'ccunningham@soardcharity.com' }];
const KIDS = [{ slug: 'max', name: 'Max', year: 2026 }];

function job({ date = '2026-10-27', time = null, confirmed = false, status = 'Build', closed = null, details = '', demo = true, construction = 0, type = 'Bathroom' } = {}) {
  return {
    id: '22PTestJob001', name: 'Max Sample (2026)', closedOn: closed, organization: { id: '22NJw42j5GLg' },
    location: { address: '100 Example Way, Atlanta, GA 30301, USA', account: { contacts: { nodes: [
      { name: 'Pat Sample', customFieldValues: { nodes: [{ value: 'pat.sample@example.com', customField: { id: FIELD_CONTACT_EMAIL } }] } },
      { name: 'No Email', customFieldValues: { nodes: [] } },
    ] } } },
    customFieldValues: { nodes: [
      { value: status, customField: { id: FIELD_STATUS } },
      ...(type ? [{ value: type, customField: { id: FIELD_MAKEOVER_TYPE } }] : []),
      ...(confirmed ? [{ value: 'Yes 👍', customField: { id: FIELD_REVEAL_CONFIRMED } }] : []),
      ...(details ? [{ value: details, customField: { id: FIELD_INVITE_DETAILS } }] : []),
    ] },
    tasks: { nodes: [
      { id: 't1', name: 'Reveal', startDate: date, startTime: time, endDate: date, endTime: null, progress: null, taskType: { id: REVEAL_TASK_TYPE } },
    ] },
    // JobTread's counts of finished tasks: Demo, and tasks under the Construction group
    demoDone: { count: demo ? 1 : 0 },
    constructionDone: { count: construction },
  };
}

test('tentative invite once construction starts', () => {
  const p = planInvite(job(), STAFF, { kids: KIDS, now: NOW });
  assert.equal(p.action, 'upsert');
  assert.equal(p.event.summary, "Max's Reveal Day (tentative)", 'the name first, so a month view shows whose reveal it is');
  assert.equal(p.event.status, 'tentative');
  assert.deepEqual(p.event.start, { date: '2026-10-27' });
  assert.deepEqual(p.event.end, { date: '2026-10-28' });
  assert.equal(p.event.location, '100 Example Way, Atlanta, GA 30301, USA', 'the full address from the first invite');
  assert.equal(p.event.transparency, 'transparent', 'a date that may move blocks no one');
  assert.equal(p.event.id, eventIdFor('soardreveal', '22PTestJob001'));
  assert.match(p.event.id, /^[a-v0-9]+$/, 'Google event ids allow a-v and 0-9 only');
  // Family first, staff after, organizer (Clareece) never a guest, emails lowercased
  assert.deepEqual(p.guests, ['pat.sample@example.com', 'cnielsen@soardcharity.com']);
  assert.equal(p.event.guestsCanSeeOtherGuests, false);
  assert.match(p.event.description, /^Save the date: Max's bathroom reveal is penciled in for Tuesday, October 27\./, 'the date first, for a phone');
  assert.match(p.event.description, /^Meet Max: https:\/\/sunshineonaranneyday\.com\/kids\/max\/$/m, 'a labeled link to the kid');
  assert.match(p.event.description, /^Watch live from anywhere: https:\/\/sunshineonaranneyday\.com\/live\/max\/$/m, 'the link to watch it live, for every guest, family included');
  assert.match(p.event.description, /^Questions\? Email Clareece Cunningham at ccunningham@soardcharity\.com\.\nSunshine on a Ranney Day$/m, 'who to ask, by name, and who it is from');
  assert.doesNotMatch(p.event.description, /^https:/m, 'no bare links');
  assert.doesNotMatch(p.event.description, /—/, 'no em dashes in site copy');
});

test('a tentative invite is a save-the-date: no time, even when the Reveal task has one', () => {
  const p = planInvite(job({ time: '16:00:00.000' }), STAFF, { kids: KIDS, now: NOW });
  assert.deepEqual(p.event.start, { date: '2026-10-27' });
  assert.equal(p.event.transparency, 'transparent');
  assert.match(p.event.description, /The time comes once the date is confirmed/);
});

test('confirmed with a time becomes a timed, confirmed event in Eastern time', () => {
  const p = planInvite(job({ time: '16:00:00.000', confirmed: true, details: 'Park on the street.' }), STAFF, { kids: KIDS, now: NOW });
  assert.equal(p.event.summary, "Max's Reveal Day");
  assert.equal(p.event.status, 'confirmed');
  assert.deepEqual(p.event.start, { dateTime: '2026-10-27T16:00:00', timeZone: 'America/New_York' });
  assert.deepEqual(p.event.end, { dateTime: '2026-10-27T17:00:00', timeZone: 'America/New_York' });
  assert.equal(p.event.location, '100 Example Way, Atlanta, GA 30301, USA');
  assert.equal(p.event.transparency, 'opaque', 'a confirmed time is busy');
  assert.match(p.event.description, /^Max's bathroom reveal is confirmed for Tuesday, October 27 at 4:00 PM\./);
  assert.match(p.event.description, /Park on the street\./);
  assert.match(p.event.description, /Watch live from anywhere: https:\/\/sunshineonaranneyday\.com\/live\/max\//, 'still there once confirmed');
  const unpublished = planInvite(job(), STAFF, { kids: [], now: NOW });
  assert.match(unpublished.event.description, /^Watch live from anywhere: https:\/\/sunshineonaranneyday\.com\/live\/$/m, 'kid not on the site yet: /live/ follows the current reveal');
  assert.doesNotMatch(unpublished.event.description, /^Meet /m, 'and no kid page to link');
  const allDay = planInvite(job({ confirmed: true }), STAFF, { kids: KIDS, now: NOW });
  assert.equal(allDay.event.transparency, 'transparent', 'confirmed without a time yet: still free');
  assert.equal(allDay.event.location, '100 Example Way, Atlanta, GA 30301, USA');
});

test('only a job that says it is SOARD\'s gets an invite (another org, or no org at all, never)', () => {
  assert.equal(planInvite(job(), STAFF, { now: NOW }).action, 'upsert');
  for (const organization of [{ id: 'other' }, null, undefined, {}]) {
    const p = planInvite({ ...job(), organization }, STAFF, { now: NOW });
    assert.deepEqual([p.action, p.reason], ['skip', 'not a SOARD job'], JSON.stringify(organization));
  }
});

test('when there should be no invite', () => {
  const plan = (o) => planInvite(job(o), STAFF, { kids: KIDS, now: NOW });
  assert.equal(plan({ demo: false }).action, 'skip', 'construction not started yet: nothing to send');
  assert.equal(plan({ demo: false, confirmed: true }).action, 'upsert', 'confirmed counts even before construction starts');
  // The site never cancels: these hold an invite that's out as it is
  assert.equal(plan({ status: 'Awaiting Funding' }).action, 'hold');
  assert.equal(plan({ closed: '2026-10-20' }).action, 'hold');
  assert.equal(plan({ date: null }).action, 'hold');
  assert.equal(plan({ date: '2026-10-07' }).action, 'skip', 'past reveals are left alone');
  assert.equal(planInvite({ ...job(), organization: { id: 'other' } }, STAFF, { now: NOW }).action, 'skip');
});

test('construction starting is what sends the tentative invite; Build Schedule no longer does', () => {
  const plan = (o) => planInvite(job({ demo: false, ...o }), STAFF, { kids: KIDS, now: NOW });
  assert.equal(plan({ demo: true }).action, 'upsert', 'Demo done');
  assert.equal(plan({ demo: true }).event.status, 'tentative');
  assert.equal(plan({ construction: 2 }).action, 'upsert', 'two tasks under Construction done');
  assert.equal(plan({ construction: 1 }).action, 'skip', 'one Construction task (Start) is not enough');
  assert.equal(plan({ demo: true, status: 'Awaiting Funding' }).action, 'hold', 'the usual stops still apply');
  assert.equal(plan({ demo: false, construction: 0 }).action, 'skip');
  assert.equal(planInvite(job({ demo: false }), STAFF, { kids: KIDS, now: NOW, sent: true }).action, 'upsert', 'once the invite is out, a task un-checked by mistake never takes it back');
  const scheduleOnly = job({ demo: false });
  scheduleOnly.tasks.nodes.push({ id: 't2', name: 'Build Schedule', progress: 1, taskType: null });
  assert.equal(planInvite(scheduleOnly, STAFF, { kids: KIDS, now: NOW }).action, 'skip', 'Build Schedule checked off alone sends nothing');
});

test('the job read asks JobTread for finished construction tasks as counts', async () => {
  let asked = null;
  const spy = async (url, init) => {
    if (new URL(url).hostname === 'api.jobtread.com' && JSON.parse(init.body).query.job) asked = JSON.parse(init.body).query.job;
    return fakeFetch(url, init);
  };
  jt = job({ demo: true });
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: spy, now: NOW })).action, 'would-create');
  assert.deepEqual(asked.constructionDone.$.where.and[0], [['parentTask', 'name'], '=', 'Construction']);
  assert.equal(asked.constructionDone._, 'tasks');
  assert.equal(asked.demoDone._, 'tasks');
});

test('a reveal that has happened is never cancelled or changed, even when the job closes the same day', () => {
  // NOW is 10:00 AM Eastern on October 16
  const plan = (o, tweak = (j) => j) => planInvite(tweak(job({ confirmed: true, ...o })), STAFF, { kids: KIDS, now: NOW });
  assert.equal(plan({ date: '2026-10-16', time: '09:00:00.000', closed: '2026-10-16' }).action, 'skip', 'this morning\'s reveal, job closed after: no cancellation email');
  assert.equal(plan({ date: '2026-10-16', time: '16:00:00.000', closed: '2026-10-16' }).action, 'hold', 'closed before this afternoon\'s reveal: held, staff told, cancelling is by hand');
  assert.equal(plan({ date: '2026-10-16', time: null, closed: '2026-10-16' }).action, 'skip', 'an all-day reveal today counts as under way');
  const done = (j) => ({ ...j, tasks: { nodes: j.tasks.nodes.map((t) => (t.name === 'Reveal' ? { ...t, progress: 1 } : t)) } });
  assert.equal(plan({ date: '2026-10-27', closed: '2026-10-16' }, done).action, 'skip', 'Reveal task marked complete: it happened, whatever the date says');
  assert.equal(plan({ date: '2026-10-27', closed: '2026-10-16' }).action, 'hold', 'a future reveal on a closed job is held, not cancelled');
});

// Two stages: tentative → staff, family and the board; confirmed → plus the people given access to the job
const access = (role, name, emailAddress, isInternal = false) => ({ membership: { isInternal, role: { name: role }, user: { name, emailAddress } } });
function islaLike(o) {
  const j = job(o);
  j.location.account.contacts.nodes.push({ name: 'Morgan Lee', customFieldValues: { nodes: [{ value: 'wish.coordinator@example.com', customField: { id: FIELD_CONTACT_EMAIL } }] } });
  j.aces = { nodes: [
    access('Makeover Family', 'Erin Example', 'erin.example@example.com'),
    access('Sponsor', 'Morgan Lee', 'wish.coordinator@example.com'),
    access('Vendor', 'Alex Rivera', 'gym.vendor@example.com'),
    access('Vendor', 'Niki Murphy', 'niki.photo@example.com'),
    access('Board Member', 'Holly Board', 'holly.board@example.com'),
    access('Application Reviewer', 'A Reviewer', 'reviewer@example.com'),
    access('Admin', 'Qualification Committee', 'selection@soardcharity.com', true),
  ] };
  return j;
}
const BOARD = [{ name: 'Scott Wierson', email: 'scott@example.com', from: 'website' }];

test('tentative invite: staff, the family and the board; a sponsor who is also a family contact waits for confirmation', () => {
  const p = planInvite(islaLike(), STAFF, { kids: KIDS, board: BOARD, now: NOW });
  assert.equal(p.event.status, 'tentative');
  assert.deepEqual(p.guests, ['pat.sample@example.com', 'erin.example@example.com', 'cnielsen@soardcharity.com', 'scott@example.com', 'holly.board@example.com']);
  assert.deepEqual(p.addsOnConfirm.map((x) => [x.email, x.kind]), [
    ['wish.coordinator@example.com', 'sponsor'],
    ['gym.vendor@example.com', 'vendor'],
    ['niki.photo@example.com', 'vendor'],
  ], 'the preview says who confirming adds');
  assert.equal(p.people['erin.example@example.com'].kind, 'family');
  assert.equal(p.people['scott@example.com'].kind, 'board', 'website board');
  assert.equal(p.people['holly.board@example.com'].kind, 'board', 'a Board Member given access to the job');
});

test('confirmed invite: the same event adds the job\'s vendors and sponsors; reviewers and committee logins never', () => {
  const p = planInvite(islaLike({ confirmed: true, time: '16:00:00.000' }), STAFF, { kids: KIDS, board: BOARD, now: NOW });
  assert.equal(p.event.status, 'confirmed');
  assert.deepEqual(p.guests, [
    'pat.sample@example.com', 'erin.example@example.com', 'cnielsen@soardcharity.com', 'scott@example.com', 'holly.board@example.com',
    'wish.coordinator@example.com', 'gym.vendor@example.com', 'niki.photo@example.com',
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

test('board status field: alumni and memorials are never invited; a draft is still on the board', async () => {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS team (slug TEXT PRIMARY KEY, data TEXT NOT NULL)').run();
  const put = (slug, data) => env.DB.prepare('INSERT OR REPLACE INTO team (slug, data) VALUES (?, ?)').bind(slug, JSON.stringify(data)).run();
  await put('brent-aronson', { name: 'In memoriam, Brent Aronson', title: 'Board Member 2024-2025', group: 'board' });
  await put('tpl-alumni', { name: 'Ann Alumni', title: 'Board Member', group: 'board', status: 'alumni' });
  await put('tpl-memorial', { name: 'Mo Memorial', title: 'Board Member', group: 'board', status: 'memorial' });
  await put('tpl-draft', { name: 'Dee Draft', title: 'Board Member', group: 'board', status: 'active', publishStatus: 'draft' });
  for (const s of ['tpl-alumni', 'tpl-memorial', 'tpl-draft']) await setBoardEmail(env.DB, s, `${s}@example.com`);
  try {
    const roster = await boardRoster(env.DB);
    const row = (slug) => roster.find((m) => m.slug === slug);
    assert.deepEqual([row('tpl-alumni').active, row('tpl-memorial').memorial, row('tpl-draft').active], [false, true, true]);
    assert.equal(row('brent-aronson').name, 'Brent Aronson', 'an older record\'s "In memoriam, " prefix is not part of the name');
    boardMembers = [];
    const emails = (await fetchBoard(env, fakeFetch)).map((x) => x.email);
    assert.ok(emails.includes('tpl-draft@example.com'), 'a draft hides them from the website only');
    assert.ok(!emails.includes('tpl-alumni@example.com') && !emails.includes('tpl-memorial@example.com'));
  } finally {
    for (const s of ['tpl-alumni', 'tpl-memorial', 'tpl-draft', 'brent-aronson']) {
      await setBoardEmail(env.DB, s, '');
      await env.DB.prepare('DELETE FROM team WHERE slug = ?').bind(s).run();
    }
  }
});

test('confirming adds the stage-two guests and emails everyone; un-confirming takes them back off', async () => {
  await writeConfig(env.DB, { enabled: true });
  boardMembers = [{ user: { name: 'Board Person', emailAddress: 'board@example.com' } }];
  jt = islaLike();
  await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  const id = eventIdFor('soardreveal', jt.id);
  const tentative = ['pat.sample@example.com', 'erin.example@example.com', 'cnielsen@soardcharity.com', 'board@example.com', 'holly.board@example.com'];
  assert.deepEqual(events.get(id).attendees.map((a) => a.email), tentative, 'tentative: staff, family and the board');
  jt = islaLike({ confirmed: true, time: '16:00:00.000' });
  const r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'updated');
  assert.ok(calls.some((c) => c.includes('sendUpdates=all')), 'new guests get the invite, everyone gets the update');
  assert.deepEqual(events.get(id).attendees.map((a) => a.email).slice(-3), ['wish.coordinator@example.com', 'gym.vendor@example.com', 'niki.photo@example.com']);
  jt = islaLike();
  await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.deepEqual(events.get(id).attendees.map((a) => a.email), tentative, 'back to staff, family and the board');
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
let env, calls, events, jt, members, boardMembers, jtEvents;
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
  jtEvents = new Map();
  jt = job();
});

async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  calls.push(`${init.method || 'GET'} ${u.hostname}${u.pathname}${u.search}`);
  if (u.hostname === 'api.jobtread.com') {
    const q = JSON.parse(init.body).query;
    if (q.event) return Response.json({ event: jtEvents.get(q.event.$.id) || null });
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

  // Put on hold in JobTread: the invite stays, staff are told once
  jt = job({ date: '2026-10-29', time: '15:30', confirmed: true, status: 'Awaiting Funding' });
  calls.length = 0;
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'held');
  assert.equal(events.get(id).status, 'confirmed', 'never cancelled by the site');
  assert.ok(!calls.some((c) => /^(PUT|POST|DELETE|PATCH) www\.googleapis\.com/.test(c)), 'the calendar is not touched');
  const logged = async () => (await env.DB.prepare('SELECT action FROM reveal_invite_log WHERE job_id = ? ORDER BY id').bind(jt.id).all()).results.map((l) => l.action);
  assert.equal((await logged()).at(-1), 'kept: status is Awaiting Funding');
  await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal((await logged()).filter((a) => a.startsWith('kept')).length, 1, 'staff hear it once, not on every wake-up');
  // Back on in JobTread: the note clears, nothing is sent
  jt = job({ date: '2026-10-29', time: '15:30', confirmed: true });
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'unchanged');
  assert.equal((await env.DB.prepare('SELECT last_action FROM reveal_invites WHERE job_id = ?').bind(jt.id).first()).last_action, 'back on in JobTread');
});

test('calling a reveal off is done by hand in Google Calendar, and the site never brings it back', async () => {
  await writeConfig(env.DB, { enabled: true });
  const id = eventIdFor('soardreveal', jt.id);
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'created');

  // Un-checking Demo by mistake: the invite stays, and still follows the reveal
  jt = job({ demo: false, date: '2026-10-28' });
  let r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'updated');
  assert.deepEqual(events.get(id).start, { date: '2026-10-28' });

  // Clareece deletes the event in Google Calendar (Google keeps it as cancelled)
  events.get(id).status = 'cancelled';
  // The 6-hour sweep notices it with nothing changed in JobTread
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW, verify: true });
  assert.deepEqual([r.action, r.reason], ['skip', BY_HAND]);
  const row = await env.DB.prepare('SELECT state, last_action FROM reveal_invites WHERE job_id = ?').bind(jt.id).first();
  assert.deepEqual([row.state, row.last_action], ['cancelled', BY_HAND]);

  // Later JobTread changes (date moved, confirmed, construction checked) never send it again
  calls.length = 0;
  jt = job({ date: '2026-10-30', time: '16:00', confirmed: true });
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.deepEqual([r.action, r.reason], ['skip', BY_HAND]);
  assert.equal(events.get(id).status, 'cancelled');
  assert.ok(!calls.some((c) => c.includes('googleapis')), 'Google not even read');

  // An admin's Retry is the one way to send it again
  r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW, force: true });
  assert.equal(r.action, 'updated');
  assert.equal(events.get(id).status, 'confirmed');
});

test('an invite deleted by hand is caught before any update writes over it', async () => {
  await writeConfig(env.DB, { enabled: true });
  const id = eventIdFor('soardreveal', jt.id);
  await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  events.delete(id); // deleted long enough ago that Google no longer has it
  calls.length = 0;
  jt = job({ date: '2026-10-29' });
  const r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.deepEqual([r.action, r.reason], ['skip', BY_HAND]);
  assert.ok(!events.has(id), 'not put back');
  assert.ok(!calls.some((c) => /^(PUT|POST) www\.googleapis\.com/.test(c)));
});

test('a TEST job clears its own invite when it is closed (only the test guests have it)', async () => {
  jt = { ...job(), id: 'testJob0001', name: 'TEST Max Sample (2026)' };
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'created');
  jt = { ...job({ closed: '2026-10-16' }), id: 'testJob0001', name: 'TEST Max Sample (2026)' };
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'cancelled');
  assert.ok(!events.has(eventIdFor('soardreveal', 'testJob0001')));
});

test('the office sandbox sends even while sending is off, only to the test guests, marked TEST', async () => {
  jt = { ...job(), id: '22P3HTX9cXn4', name: 'Sunshine Office 2025' };
  const r = await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.action, 'created');
  assert.equal(r.guests, 1);
  const ev = events.get(eventIdFor('soardreveal', jt.id));
  assert.deepEqual(ev.attendees, [{ email: 'peter@soardcharity.com' }], 'no family, no staff');
  assert.equal(ev.summary, "TEST · Sunshine's Reveal Day (tentative)");
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

test("a rehearsal invite shows the address on the kid's real job, not the office account it sits on", async () => {
  const OFFICE = '250 Hembree Park Dr, Roswell, GA 30076, USA';
  const MAX_HOME = '100 Example Way, Atlanta, GA 30301, USA';
  jt = { ...job({ confirmed: true, time: '16:00:00.000' }), id: 'jobTst0002', name: 'TEST Max Sample (2026)' };
  jt.location = { ...jt.location, address: OFFICE };
  const open = [
    { id: 'jobTst0002', name: 'TEST Max Sample (2026)', location: { address: OFFICE } },
    { id: '22P3HTX9cXn4', name: 'Sunshine Office 2025', location: { address: OFFICE } },
    { id: '22PTestJob001', name: 'Max Sample (2026)', location: { address: MAX_HOME } },
    { id: 'maxOld0001', name: 'Max Sample (2025)', location: { address: '1 Last Year St' } },
  ];
  const withOpenJobs = async (url, init = {}) => {
    const q = new URL(url).hostname === 'api.jobtread.com' ? JSON.parse(init.body).query : null;
    if (q?.organization?.jobs) return Response.json({ organization: { jobs: { nodes: open } } });
    return fakeFetch(url, init);
  };
  await reconcileJob(env, jt.id, { fetchImpl: withOpenJobs, now: NOW });
  assert.equal(events.get(eventIdFor('soardreveal', jt.id)).location, MAX_HOME);
  const t = await sendTestInvite(env, jt.id, 'peter@soardcharity.com', { fetchImpl: withOpenJobs, now: NOW });
  assert.equal(t.event.location, MAX_HOME, 'the admin test invite too');

  // Matching: same year, every word after TEST, exactly one job
  assert.equal(realJobFor({ id: 'x', name: 'TEST Max (2026)' }, open)?.id, '22PTestJob001', 'a shorter name still finds the kid');
  assert.equal(realJobFor({ id: 'x', name: 'TEST Max (2026)' }, [...open, { id: 'y', name: 'Max Power (2026)' }]), null, 'two kids could be meant: keep its own address');
  assert.equal(realJobFor({ id: 'x', name: 'TEST Max Sample' }, open), null, 'no year, no guess');
  assert.equal(realJobFor({ id: 'x', name: 'TEST Isla Example (2026)' }, open), null);
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

test('new wording never emails guests on its own; facts do, and an admin can push the wording', async () => {
  await writeConfig(env.DB, { enabled: true });
  const id = eventIdFor('soardreveal', jt.id);
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'created');
  const googleWrites = () => calls.filter((c) => /^(POST|PUT|PATCH) www\.googleapis\.com/.test(c));

  // Clareece fixes a sentence: the guest check and the sweep leave every invite alone
  await writeConfig(env.DB, { template: { ...DEFAULT_TEMPLATE, tentativeMessage: 'Hold the date for {name}: {date}.' } });
  calls.length = 0;
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'unchanged');
  assert.deepEqual(googleWrites(), [], 'no one is emailed about wording');

  // ...until a fact changes: then the update carries the new wording
  jt = job({ details: 'Park on the street.' });
  calls.length = 0;
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'updated', 'JobTread notes are a fact guests act on');
  assert.ok(googleWrites().every((c) => c.endsWith('sendUpdates=all')));
  assert.match(events.get(id).description, /^Hold the date for Max: Tuesday, October 27\./);

  // Wording pushed from admin ("Also update invites already sent"): everyone gets it
  const withJobs = async (url, init = {}) => {
    const q = new URL(url).hostname === 'api.jobtread.com' ? JSON.parse(init.body).query : null;
    if (q?.organization?.jobs) return Response.json({ organization: { jobs: { nodes: [{ id: jt.id }] } } });
    return fakeFetch(url, init);
  };
  await writeConfig(env.DB, { template: { ...DEFAULT_TEMPLATE, tentativeMessage: 'Pencil in {date} for {name}.' } });
  calls.length = 0;
  const results = await reconcileAll(env, { fetchImpl: withJobs, now: NOW, rewrite: true });
  assert.equal(results.find((r) => r.jobId === jt.id)?.action, 'updated');
  assert.ok(googleWrites().length === 1 && googleWrites()[0].endsWith('sendUpdates=all'));
  assert.match(events.get(id).description, /^Pencil in Tuesday, October 27 for Max\./);
  calls.length = 0;
  assert.equal((await reconcileAll(env, { fetchImpl: withJobs, now: NOW, rewrite: true })).find((r) => r.jobId === jt.id)?.action, 'unchanged', 'pushing the same wording twice sends nothing');
});

test('an invite sent before invites kept their facts is checked against the calendar, not sent again', async () => {
  await writeConfig(env.DB, { enabled: true });
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS reveal_invites (job_id TEXT PRIMARY KEY, event_id TEXT, state TEXT, hash TEXT, reveal_date TEXT, guests TEXT, last_action TEXT, error TEXT, updated_at TEXT)').run();
  const id = eventIdFor('soardreveal', jt.id);
  const legacy = 'a'.repeat(32);
  const ADDRESS = '100 Example Way, Atlanta, GA 30301, USA';
  const guests = ['pat.sample@example.com', 'cnielsen@soardcharity.com'];
  // What the old invite looked like on Clareece's calendar, and the row it left
  const sent = (state, start, end, extra = {}) => events.set(id, { id, status: state, summary: "Tentative: Max's Reveal Day", location: ADDRESS, start, end, description: 'This is a tentative date…', ...extra });
  const row = (state, date, g = guests) => env.DB.prepare('INSERT OR REPLACE INTO reveal_invites (job_id, event_id, state, hash, reveal_date, guests, last_action) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(jt.id, id, state, legacy, date, JSON.stringify(g), 'created').run();
  const writes = () => calls.filter((c) => /^(POST|PUT|PATCH|DELETE) www\.googleapis\.com/.test(c));

  // The calendar already has today's date and address: nothing goes out, and the row now keeps its facts
  sent('tentative', { date: '2026-10-27' }, { date: '2026-10-28' });
  await row('tentative', '2026-10-27');
  calls.length = 0;
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'unchanged');
  assert.deepEqual(writes(), [], 'the family is not emailed');
  const saved = await env.DB.prepare('SELECT hash FROM reveal_invites WHERE job_id = ?').bind(jt.id).first();
  assert.match(saved.hash, /^[0-9a-f]{32}:a{32}$/);
  calls.length = 0;
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'unchanged');
  assert.ok(!calls.some((c) => c.includes('googleapis')), 'checked once, then the row knows');

  // Only staff changed since: a quiet update, which brings the new wording along
  sent('tentative', { date: '2026-10-27' }, { date: '2026-10-28' });
  await row('tentative', '2026-10-27', ['pat.sample@example.com']);
  calls.length = 0;
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'updated quietly');
  assert.equal(events.get(id).summary, "Max's Reveal Day (tentative)");
  assert.equal(events.get(id).location, ADDRESS);

  // The calendar has an older date: everyone hears about the move
  sent('tentative', { date: '2026-10-20' }, { date: '2026-10-21' });
  await row('tentative', '2026-10-20');
  calls.length = 0;
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'updated');
  assert.ok(writes().every((c) => c.endsWith('sendUpdates=all')));

  // An old tentative invite with a time: the time comes off, and guests see that
  sent('tentative', { dateTime: '2026-10-27T16:00:00-04:00', timeZone: 'America/New_York' }, { dateTime: '2026-10-27T17:00:00-04:00', timeZone: 'America/New_York' });
  await row('tentative', '2026-10-27');
  calls.length = 0;
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'updated');

  // Confirmed under the old wording before this shipped, same time on the calendar: left alone
  jt = job({ confirmed: true, time: '16:00:00.000' });
  sent('confirmed', { dateTime: '2026-10-27T16:00:00-04:00', timeZone: 'America/New_York' }, { dateTime: '2026-10-27T17:00:00-04:00', timeZone: 'America/New_York' });
  await row('confirmed', '2026-10-27');
  calls.length = 0;
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW })).action, 'unchanged');
  assert.deepEqual(writes(), []);
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
  let ev = events.get(eventIdFor('soardrevealtest', jt.id));
  assert.deepEqual(ev.attendees, [{ email: 'peter@soardcharity.com' }]);
  assert.equal(ev.summary, "TEST · Max's Reveal Day (tentative)");
  assert.deepEqual(ev.start, { date: '2026-10-30' }, 'tentative: date only');

  // The confirmed version of a reveal that isn't confirmed yet, to see both stages first
  await sendTestInvite(env, jt.id, 'peter@soardcharity.com', { fetchImpl: fakeFetch, now: NOW, date: '2026-10-30', time: '16:00', stage: 'confirmed' });
  ev = events.get(eventIdFor('soardrevealtest', jt.id));
  assert.equal(ev.summary, "TEST · Max's Reveal Day");
  assert.deepEqual(ev.start, { dateTime: '2026-10-30T16:00:00', timeZone: 'America/New_York' });
  assert.equal(ev.location, '100 Example Way, Atlanta, GA 30301, USA');
  assert.match(ev.description, /pat\.sample@example\.com, cnielsen@soardcharity\.com/);
  assert.ok(!events.has(eventIdFor('soardreveal', jt.id)), 'the real event is untouched');

  const c = await sendTestInvite(env, jt.id, 'peter@soardcharity.com', { fetchImpl: fakeFetch, now: NOW, cancel: true });
  assert.equal(c.action, 'cancelled');
  assert.equal(events.size, 0);
});

test('the default wording, exactly', () => {
  const p = planInvite(job(), STAFF, { kids: KIDS, now: NOW });
  assert.equal(p.event.summary, "Max's Reveal Day (tentative)");
  assert.equal(p.event.description, [
    "Save the date: Max's bathroom reveal is penciled in for Tuesday, October 27.",
    '',
    "It's the moment Max sees the new bathroom for the first time.",
    '',
    "If the build schedule shifts, this invite moves with it. The time comes once the date is confirmed, so there's no need to reply until then.",
    '',
    'Meet Max: https://sunshineonaranneyday.com/kids/max/',
    'Watch live from anywhere: https://sunshineonaranneyday.com/live/max/',
    '',
    'Questions? Email Clareece Cunningham at ccunningham@soardcharity.com.',
    'Sunshine on a Ranney Day',
  ].join('\n'));
  const unnamed = planInvite(job(), STAFF, { kids: KIDS, now: NOW, organizer: 'events@soardcharity.com' });
  assert.match(unnamed.event.description, /^Questions\? Email events@soardcharity\.com\.$/m, 'an organizer not on the staff list: just the address');
  const c = planInvite(job({ confirmed: true, time: '16:00' }), STAFF, { kids: KIDS, now: NOW });
  assert.equal(c.event.summary, "Max's Reveal Day");
  assert.match(c.event.description, /^Max's bathroom reveal is confirmed for Tuesday, October 27 at 4:00 PM\.\n\nIt's the moment Max sees the new bathroom for the first time\. Please accept or decline so we know who to expect\.\n\nMeet Max:/);
});

test("the invite names what was built, from the job's Makeover Type", () => {
  const first = (type) => planInvite(job({ type }), STAFF, { kids: KIDS, now: NOW }).event.description.split('\n\n')[1];
  assert.equal(first('Bedroom'), "It's the moment Max sees the new bedroom for the first time.");
  assert.equal(first('Therapy Room'), "It's the moment Max sees the new therapy room for the first time.");
  assert.equal(first('Ramp'), "It's the moment Max sees the new ramp for the first time.");
  assert.equal(first(null), "It's the moment Max sees the new room for the first time.", 'blank: room');
  assert.equal(renderTemplate('{space}', { name: 'Max', space: '  ', date: '2026-10-27' }), 'room');
});

test('wording saved word for word as an old default follows the new default; wording someone chose stays', async () => {
  const DB = env.DB;
  await DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('reveal-invites', JSON.stringify({ enabled: true, template: {
    tentativeTitle: "Tentative: {name}'s Reveal Day",
    tentativeMessage: "This is a tentative date for {name}'s reveal while the build wraps up.\nThis invite updates automatically if the date moves, and the time is added once the reveal is confirmed.",
    confirmedTitle: "{name}'s Reveal Day",
    confirmedMessage: 'See you {when}!',
  } }), 'x').run();
  const { template, enabled } = await readConfig(DB);
  assert.equal(enabled, true);
  assert.equal(template.tentativeTitle, DEFAULT_TEMPLATE.tentativeTitle);
  assert.equal(template.tentativeMessage, DEFAULT_TEMPLATE.tentativeMessage);
  assert.equal(template.confirmedMessage, 'See you {when}!', 'chosen wording is kept');
  // The October 2026 wording that still promised the address with the confirmation
  await writeConfig(DB, { template: { ...template, tentativeMessage: "Save the date: {name}'s {space} reveal is penciled in for {date}.\n\nIt's the moment {name} sees the new {space} for the first time.\n\nIf the build schedule shifts, this invite moves with it. The time and address come once the date is confirmed, so there's no need to reply until then." } });
  assert.equal((await readConfig(DB)).template.tentativeMessage, DEFAULT_TEMPLATE.tentativeMessage);
  await writeConfig(DB, { template: { ...template, confirmedMessage: "{name}'s {space} reveal is confirmed for {when}.\n\nIt's the moment {name} sees the new {space} for the first time. Please reply so we know who to expect." } });
  assert.equal((await readConfig(DB)).template.confirmedMessage, DEFAULT_TEMPLATE.confirmedMessage, 'the October 2026 "Please reply" wording follows the new default');
});

test('wording from admin fills in name, date and time', () => {
  assert.equal(renderTemplate('{name} on {date} at {time}, {when}. {other}', { name: 'Max', date: '2026-10-27', time: '16:00' }),
    'Max on Tuesday, October 27 at 4:00 PM, Tuesday, October 27 at 4:00 PM. {other}');
  assert.equal(renderTemplate('{when}', { name: 'Max', date: '2026-10-27', time: null }), 'Tuesday, October 27 (time to come)');
  const template = { ...DEFAULT_TEMPLATE, confirmedTitle: 'Reveal Day: {name}!', confirmedMessage: 'See you {when}.' };
  const p = planInvite(job({ confirmed: true, time: '09:30', details: 'Gate code 1234' }), STAFF, { kids: KIDS, now: NOW, template });
  assert.equal(p.event.summary, 'Reveal Day: Max!');
  assert.equal(p.event.description, "See you Tuesday, October 27 at 9:30 AM.\n\nGate code 1234\n\nMeet Max: https://sunshineonaranneyday.com/kids/max/\nWatch live from anywhere: https://sunshineonaranneyday.com/live/max/\n\nQuestions? Email Clareece Cunningham at ccunningham@soardcharity.com.\nSunshine on a Ranney Day");
});

test('admin list: upcoming reveals with the exact invite each would send, guests named', async () => {
  await writeConfig(env.DB, { enabled: true });
  await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  const jobs = [
    jt,
    { ...job({ date: '2026-10-07' }), id: 'pastJob0001', name: 'Peter Raish (2026)' },
    { ...job(), id: '22P3HTX9cXn4', name: 'Sunshine Office 2025' },
    { ...job({ date: '2026-11-11', demo: false }), id: 'colinJob001', name: 'Colin Lindsay (2026)' },
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
        const j = jobs.find(x => x.id === q.job.$.id);
        return Response.json({ job: { location: { account: j.location.account }, ...(q.job.demoDone ? { demoDone: j.demoDone, constructionDone: j.constructionDone } : {}) } });
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
  assert.equal(max.space, 'Bathroom', "the Makeover Type, for the wording preview's {space}");
  assert.equal(max.preview.title, "Max's Reveal Day (tentative)");
  assert.equal(max.preview.location, '100 Example Way, Atlanta, GA 30301, USA');
  assert.deepEqual(max.preview.guests, [
    { email: 'pat.sample@example.com', name: 'Pat Sample', kind: 'family' },
    { email: 'cnielsen@soardcharity.com', name: 'Christian Nielsen', kind: 'staff' },
  ]);
  assert.ok(reveals[1].preview, 'a reveal before construction still previews how its invite will look');
  assert.equal(max.constructionStarted, true, 'Demo done: the tracker knows the invite is due');
  assert.equal(reveals[1].constructionStarted, false);
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

test('guest check: a vendor given access after the confirmed invite went out gets it within minutes', async () => {
  const id = eventIdFor('soardreveal', jt.id);
  jt = islaLike({ confirmed: true, time: '16:00:00.000' });
  assert.equal(await maybeCheckGuests(env, { fetchImpl: fakeFetch, now: NOW }), null, 'off while sending is paused');
  await writeConfig(env.DB, { enabled: true });
  await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  const before = events.get(id).attendees.length;

  // Nothing new in JobTread: the invite is read, not rewritten
  calls.length = 0;
  const quiet = await maybeCheckGuests(env, { fetchImpl: fakeFetch, now: NOW });
  assert.deepEqual(quiet.map((r) => r.action), ['unchanged']);
  assert.ok(!calls.some((c) => c.includes('googleapis')), 'Google not called');

  // A vendor is given access to the job (JobTread sends no webhook for that)
  jt.aces.nodes.push(access('Vendor', 'Bin There', 'Orders@BinThere.com'));
  assert.equal(await maybeCheckGuests(env, { fetchImpl: fakeFetch, now: NOW + 60_000 }), null, 'not again within 5 minutes');
  const r = await maybeCheckGuests(env, { fetchImpl: fakeFetch, now: NOW + 5 * 60_000 });
  assert.deepEqual(r.map((x) => x.action), ['updated']);
  assert.equal(events.get(id).attendees.length, before + 1);
  assert.equal(events.get(id).attendees.at(-1).email, 'orders@binthere.com', 'the new vendor has the invite');

  // A reveal that has passed, or whose invite was cancelled, isn't checked
  await env.DB.prepare("UPDATE reveal_invites SET reveal_date = '2026-10-01'").run();
  assert.deepEqual(await maybeCheckGuests(env, { fetchImpl: fakeFetch, now: NOW + 10 * 60_000 }), []);
});

test('one update per invite at a time: two at the same moment never email everyone twice', async () => {
  await writeConfig(env.DB, { enabled: true });
  jt = islaLike({ confirmed: true, time: '16:00:00.000' });
  const googleWrites = () => calls.filter((c) => /^(POST|PUT|PATCH) www\.googleapis\.com/.test(c)).length;
  // The guest check and the sweep skip a job that's being updated
  const [a, b] = await Promise.all([
    reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW, wait: false }),
    reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW, wait: false }),
  ]);
  assert.deepEqual([a.action, b.action].sort(), ['busy', 'created']);
  assert.equal(googleWrites(), 1, 'one invite, not two');
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW, wait: false })).action, 'unchanged', 'the lock is let go afterwards');

  // A JobTread wake-up waits its turn, then reads JobTread fresh (it may carry the newer change)
  await env.DB.prepare('INSERT INTO reveal_invite_locks (job_id, until) VALUES (?, ?)').bind(jt.id, Date.now() + 60_000).run();
  jt.aces.nodes.push(access('Photographer', 'New Photographer', 'photos@example.com'));
  const waiting = reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW });
  setTimeout(() => env.DB.prepare('DELETE FROM reveal_invite_locks').run(), 100);
  assert.equal((await waiting).action, 'updated');
  assert.ok(events.get(eventIdFor('soardreveal', jt.id)).attendees.some((x) => x.email === 'photos@example.com'));

  // A crashed update's lock expires
  await env.DB.prepare('INSERT INTO reveal_invite_locks (job_id, until) VALUES (?, ?)').bind(jt.id, Date.now() - 1).run();
  assert.equal((await reconcileJob(env, jt.id, { fetchImpl: fakeFetch, now: NOW, wait: false })).action, 'unchanged', 'a stale lock is taken over');
});

// ─── JobTread wake-ups (POST /api/reveal-invites) ──────────────────────

const jobReads = () => calls.filter((c) => c.startsWith('POST api.jobtread.com')).length;

test('wake-ups: a few a minute per job; past that the job is owed one look, which the next heartbeat gives it', async () => {
  await writeConfig(env.DB, { enabled: true });
  const turns = [];
  for (let i = 0; i < 5; i++) turns.push(await admitWake(env.DB, jt.id, { now: NOW }));
  assert.deepEqual(turns, ['run', 'run', 'run', 'later', 'later']);
  const owed = await env.DB.prepare('SELECT job_id, due FROM reveal_invite_owed').all();
  assert.deepEqual(owed.results, [{ job_id: jt.id, due: NOW + 60_000 }], 'one note, from the first turned away');

  // Not yet due: nothing read
  assert.deepEqual(await runOwedWakes(env, { fetchImpl: fakeFetch, now: NOW + 30_000 }), []);
  assert.equal(jobReads(), 0);
  // Due: the job gets its look (the invite goes out), once, and the note is gone
  const [r] = await runOwedWakes(env, { fetchImpl: fakeFetch, now: NOW + 61_000 });
  assert.equal(r.action, 'created');
  assert.deepEqual(await runOwedWakes(env, { fetchImpl: fakeFetch, now: NOW + 62_000 }), []);
  // The next minute, the job takes wake-ups again
  assert.equal(await admitWake(env.DB, jt.id, { now: NOW + 61_000 }), 'run');
});

test('an owed look that finds the invite busy stays owed', async () => {
  await writeConfig(env.DB, { enabled: true });
  for (let i = 0; i < 4; i++) await admitWake(env.DB, jt.id, { now: NOW });
  await env.DB.prepare('INSERT INTO reveal_invite_locks (job_id, until) VALUES (?, ?)').bind(jt.id, Date.now() + 60_000).run();
  const [r] = await runOwedWakes(env, { fetchImpl: fakeFetch, now: NOW + 61_000 });
  assert.equal(r.action, 'busy');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM reveal_invite_owed').first()).n, 1, 'still owed');
  await env.DB.prepare('DELETE FROM reveal_invite_locks').run();
  assert.deepEqual((await runOwedWakes(env, { fetchImpl: fakeFetch, now: NOW + 125_000 })).map((x) => x.action), ['created']);
});

test('past the site-wide limit too, the job is owed a look, never just dropped', async () => {
  const out = [];
  for (let i = 0; i < 125; i++) out.push(await admitWake(env.DB, `22PFlood${String(i).padStart(4, '0')}`, { now: NOW }));
  assert.equal(out.filter((x) => x === 'run').length, 120);
  assert.deepEqual(out.slice(120), ['later', 'later', 'later', 'later', 'later']);
  const owed = (await env.DB.prepare('SELECT job_id FROM reveal_invite_owed ORDER BY job_id').all()).results.map((r) => r.job_id);
  assert.deepEqual(owed, ['22PFlood0120', '22PFlood0121', '22PFlood0122', '22PFlood0123', '22PFlood0124'], 'each gets its look on the next heartbeat');
});

let evSeq = 0;
/** JobTread logs a change on a job (the event a workflow wake-up names) */
function logJobEvent({ jobId = jt.id, at = Date.now(), org = '22NJw42j5GLg' } = {}) {
  const id = `evtJob${String(++evSeq).padStart(6, '0')}`;
  jtEvents.set(id, { id, createdAt: new Date(at).toISOString(), organization: { id: org }, job: { id: jobId } });
  return id;
}

async function wake(body, { url = 'https://x/api/reveal-invites', headers = {}, envOver = {}, ip = '198.51.100.7' } = {}) {
  const waits = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const res = await wakeRoute.onRequestPost({ request: new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers }, body: JSON.stringify(body) }), env: { ...env, ...envOver }, waitUntil: (p) => waits.push(p) });
    await Promise.allSettled(waits);
    return { status: res.status, body: await res.json() };
  } finally {
    globalThis.fetch = real;
  }
}
const limitCount = async (key) => (await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first())?.count || 0;

test('the wake-up route: the shared secret when one is set, and { ok } is all it says', async () => {
  await writeConfig(env.DB, { enabled: true });
  const secret = { JOBTREAD_WEBHOOK_SECRET: 'wake-secret-example' };
  assert.equal((await wake({ jobId: jt.id, eventId: logJobEvent() }, { envOver: secret })).status, 401);
  assert.equal((await wake({ jobId: jt.id, eventId: logJobEvent() }, { envOver: secret, headers: { 'X-Webhook-Secret': 'wrong' } })).status, 401);
  assert.equal(jobReads(), 0, 'refused before JobTread is read');
  assert.equal((await wake({ jobId: 'nope!' })).status, 400);

  const r = await wake({ jobId: jt.id, eventId: logJobEvent() }, { envOver: secret, url: 'https://x/api/reveal-invites?key=wake-secret-example' });
  assert.deepEqual([r.status, r.body], [200, { ok: true }], 'no action, reason, guests or event details');
  assert.ok(events.has(eventIdFor('soardreveal', jt.id)), 'and the invite went out');

  // A closed job holds its invite: still just { ok: true }, nothing about the job
  jt = job({ closed: '2026-10-15' });
  const held = await wake({ jobId: jt.id, eventId: logJobEvent() }, { envOver: secret, headers: { 'X-Webhook-Secret': 'wake-secret-example' } });
  assert.deepEqual(held.body, { ok: true });
});

test('the wake-up route: only a change JobTread logged on the job counts', async () => {
  await writeConfig(env.DB, { enabled: true });
  const junk = [
    {},                                                                  // no event at all
    { eventId: 'evtNoSuchThing' },                                       // never logged
    { eventId: logJobEvent({ jobId: '22POtherJob01' }) },                // another job's
    { eventId: logJobEvent({ org: 'someOtherOrg' }) },                   // another org's
    { eventId: logJobEvent({ at: Date.now() - 16 * 60_000 }) },          // a replay
  ];
  for (const extra of junk) assert.deepEqual((await wake({ jobId: jt.id, ...extra })).body, { ok: true }, JSON.stringify(extra));
  assert.ok(!events.has(eventIdFor('soardreveal', jt.id)), 'no invite');
  assert.equal(await limitCount(`reveal-invites:job:${jt.id}`), 0, 'and none of it counted against the job');
  assert.equal(await limitCount('reveal-invites:all'), 0);
  assert.equal((await wake({ jobId: jt.id, eventId: logJobEvent() })).status, 200);
  assert.ok(events.has(eventIdFor('soardreveal', jt.id)), 'the real one goes through');
});

test('junk from one address is cut off at 30 a minute, never counted, and a real wake-up still runs', async () => {
  await writeConfig(env.DB, { enabled: true });
  // About two junk calls a second for a minute, naming the real job, from one address
  const answers = [];
  for (let i = 0; i < 120; i++) answers.push((await wake({ jobId: jt.id, eventId: `junk${String(i).padStart(6, '0')}` }, { ip: '203.0.113.9' })).status);
  assert.equal(answers.filter((x) => x === 200).length, 30);
  assert.equal(answers.filter((x) => x === 429).length, 90, 'the rest refused before JobTread is asked');
  assert.equal(jobReads(), 30, 'one event lookup per call it let through');
  // Junk spread over many addresses: still never counted against the job or the site
  for (let i = 0; i < 150; i++) await wake({ jobId: jt.id, eventId: `junkB${String(i).padStart(6, '0')}` }, { ip: `203.0.113.${10 + (i % 6)}` });
  assert.equal(await limitCount(`reveal-invites:job:${jt.id}`), 0);
  assert.equal(await limitCount('reveal-invites:all'), 0);
  // JobTread's real wake-up (its own address) runs at once
  assert.deepEqual((await wake({ jobId: jt.id, eventId: logJobEvent() })).body, { ok: true });
  assert.ok(events.has(eventIdFor('soardreveal', jt.id)), 'the invite went out');
});

test('with the secret set, JobTread itself is never held to the per-address limit', async () => {
  const secret = { JOBTREAD_WEBHOOK_SECRET: 'wake-secret-example' };
  const statuses = [];
  for (let i = 0; i < 40; i++) {
    jt = job();
    jt.id = `22PJob${String(i).padStart(6, '0')}`;
    statuses.push((await wake({ jobId: jt.id, eventId: logJobEvent() }, { envOver: secret, headers: { 'X-Webhook-Secret': 'wake-secret-example' } })).status);
  }
  assert.ok(statuses.every((x) => x === 200), 'a burst of task check-offs across jobs, all from JobTread');
});

test('the wake-up route: hammering one job never holds its invite; the real change still lands', async () => {
  await writeConfig(env.DB, { enabled: true });
  for (let i = 0; i < 3; i++) assert.deepEqual((await wake({ jobId: jt.id, eventId: logJobEvent() })).body, { ok: true });
  const reads = jobReads();
  // Past three a minute: answered after the event lookup, nothing else read, the job owed a look
  assert.deepEqual((await wake({ jobId: jt.id, eventId: logJobEvent() })).body, { ok: true });
  assert.equal(jobReads(), reads + 1, 'only the event lookup for a turned-away wake-up');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM reveal_invite_locks').first()).n, 0, 'no lock held');
  // The change that wake-up was about (confirmed) reaches the invite on the next heartbeat
  jt = job({ confirmed: true, time: '16:00:00.000' });
  await maybeCheckGuests(env, { fetchImpl: fakeFetch, now: Date.now() + 61_000 });
  assert.equal(events.get(eventIdFor('soardreveal', jt.id)).status, 'confirmed');
});

test('the invite organizer is one of the mailboxes set aside for it, never any soardcharity.com address', async () => {
  assert.deepEqual(allowedOrganizers({}), [DEFAULT_ORGANIZER]);
  assert.deepEqual(allowedOrganizers({ REVEAL_INVITE_ORGANIZERS: ' Reveals@SOARDcharity.com, someone@example.com, x@soardcharity.com.example.com' }), [DEFAULT_ORGANIZER, 'reveals@soardcharity.com'], 'other domains never count');
  const post = (body, extra = {}) => inviteAdmin.onRequestPost({ env: { ...env, ...extra }, data: { userEmail: 'staff@soardcharity.com' }, request: new Request('https://x/api/reveal-invites-admin', { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} });
  const refused = await post({ organizer: 'ceo@soardcharity.com' });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /^Invites can only come from ccunningham@soardcharity\.com\.$/);
  assert.equal((await readConfig(env.DB)).organizer, DEFAULT_ORGANIZER, 'unchanged');
  // The configured organizer keeps working, and an added mailbox can be chosen
  assert.equal((await post({ organizer: 'CCunningham@soardcharity.com' })).status, 200);
  assert.equal((await post({ organizer: 'reveals@soardcharity.com' }, { REVEAL_INVITE_ORGANIZERS: 'reveals@soardcharity.com' })).status, 200);
  assert.equal((await readConfig(env.DB)).organizer, 'reveals@soardcharity.com');
});
