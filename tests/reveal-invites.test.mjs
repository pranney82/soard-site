/**
 * Reveal calendar invites (functions/api/_reveal-invites.js, _google-calendar.js)
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { planInvite, reconcileJob, sendTestInvite, writeConfig, REVEAL_TASK_TYPE, FIELD_STATUS, FIELD_INVITE_DETAILS, FIELD_CONTACT_EMAIL } from '../functions/api/_reveal-invites.js';
import { serviceAccountJwt, eventIdFor, clearTokenCache, parseServiceAccount } from '../functions/api/_google-calendar.js';
import { FIELD_REVEAL_CONFIRMED } from '../functions/api/_reveals.js';

const NOW = Date.parse('2026-10-16T14:00:00Z');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'reveals@soard-cal.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

const STAFF = [{ name: 'Christian Nielsen', email: 'cnielsen@soardcharity.com' }, { name: 'Clareece Cunningham', email: 'ccunningham@soardcharity.com' }];
const KIDS = [{ slug: 'max', name: 'Max', year: 2026 }];

function job({ date = '2026-10-27', time = null, confirmed = false, built = true, status = 'Build', closed = null, details = '' } = {}) {
  return {
    id: '22PRvFFPZsEA', name: 'Max Daniel (2026)', closedOn: closed, organization: { id: '22NJw42j5GLg' },
    location: { address: '2060 Grand Prix Dr, Atlanta, GA 30345, USA', account: { contacts: { nodes: [
      { name: 'Valerie Daniel', customFieldValues: { nodes: [{ value: 'Valerie.Daniel22@gmail.com', customField: { id: FIELD_CONTACT_EMAIL } }] } },
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
  assert.equal(p.event.location, '2060 Grand Prix Dr, Atlanta, GA 30345, USA');
  assert.equal(p.event.id, eventIdFor('soardreveal', '22PRvFFPZsEA'));
  assert.match(p.event.id, /^[a-v0-9]+$/, 'Google event ids allow a-v and 0-9 only');
  // Family first, staff after, organizer (Clareece) never a guest, emails lowercased
  assert.deepEqual(p.guests, ['valerie.daniel22@gmail.com', 'cnielsen@soardcharity.com']);
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
let env, calls, events, jt;
beforeEach(async () => {
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
    return Response.json({ organization: { memberships: { nodes: [
      { isInternal: true, role: { name: 'Admin' }, user: { name: 'Christian Nielsen', emailAddress: 'cnielsen@soardcharity.com' } },
      { isInternal: true, role: { name: 'Admin' }, user: { name: 'Qualification Committee', emailAddress: 'selection@soardcharity.com' } },
      { isInternal: false, role: { name: 'Makeover Family' }, user: { name: 'Someone Else', emailAddress: 'other@family.com' } },
      { isInternal: false, role: { name: 'Vendor' }, user: { name: 'Real Floors', emailAddress: 'vendor@floors.com' } },
    ] } } });
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
  assert.match(ev.description, /valerie\.daniel22@gmail\.com, cnielsen@soardcharity\.com/);
  assert.ok(!events.has(eventIdFor('soardreveal', jt.id)), 'the real event is untouched');

  const c = await sendTestInvite(env, jt.id, 'peter@soardcharity.com', { fetchImpl: fakeFetch, now: NOW, cancel: true });
  assert.equal(c.action, 'cancelled');
  assert.equal(events.size, 0);
});
