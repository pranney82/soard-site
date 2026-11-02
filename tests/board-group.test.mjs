/**
 * board@soardcharity.com follows People → Board (functions/api/_board-group.js)
 * Run: node --test tests/board-group.test.mjs
 *
 * The group holds the people the meeting invite goes to (the active board at
 * their private emails, and the Board area's admins). The site adds and
 * removes only plain members; owners, managers and nested groups stay, and
 * nothing changes while People → Board has nobody with an email.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { syncBoardGroup, maybeSyncBoardGroup, groupStatus, groupWanted, GROUP_EMAIL, GROUP_SCOPE } from '../functions/api/_board-group.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';

const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1234567890', project_id: 'soard-site', private_key: SA_PEM });
const MEMBERS = `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(GROUP_EMAIL)}/members`;

const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['hal-hart', { name: 'Hal Hart', group: 'team', title: 'Co-Founder' }],
  ['pat-lee', { name: 'Pat Lee', group: 'team', title: 'Program Director' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair' }],
  ['bo-kim', { name: 'Bo Kim', group: 'board', title: 'Treasurer' }],
  ['cy-no-email', { name: 'Cy Noemail', group: 'board' }],
  ['ex-member', { name: 'Ex Member', group: 'board', status: 'alumni' }],
  ['ada-advisor', { name: 'Ada Advisor', group: 'advisory' }],
];
const EMAILS = { 'alex-rivera': 'alex@example.com', 'bo-kim': 'Bo.Kim@Example.org', 'ex-member': 'ex@example.com', 'ada-advisor': 'ada@example.com' };

let env, group, admins, scopeGranted, refuseOutside, calls;
const realFetch = globalThis.fetch;
const m = (email, role = 'MEMBER', type = 'USER') => ({ email, role, type, status: 'ACTIVE' });

async function setPerson(slug, d) {
  await env.DB.prepare('INSERT OR REPLACE INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
}

beforeEach(async () => {
  env = { DB: await createD1(), GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await setPerson(slug, d);
  for (const [slug, email] of Object.entries(EMAILS)) await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  // board@ today: Holly-style owner, a manager, a nested group, a board member already in, a former one, and a stranger added by hand
  group = [m('jane@soardcharity.com', 'OWNER'), m('helper@soardcharity.com', 'MANAGER'), m('officers@soardcharity.com', 'MEMBER', 'GROUP'), m('alex@example.com'), m('ex@example.com'), m('someone@gmail.com'), { id: 'C123', role: 'MEMBER', type: 'CUSTOMER' }];
  admins = new Set(['jane@soardcharity.com']);
  scopeGranted = true;
  refuseOutside = false;
  calls = [];
  clearTokenCache();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      assert.equal(claims.scope, GROUP_SCOPE, 'asks Google for the group-members permission only');
      calls.push({ kind: 'token', subject: claims.sub });
      if (!scopeGranted) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.' }, { status: 401 });
      return Response.json({ access_token: `tok:${claims.sub}`, expires_in: 3600 });
    }
    if (url.startsWith(MEMBERS)) {
      const subject = String(init.headers?.Authorization || '').replace('Bearer tok:', '');
      const method = init.method || 'GET';
      const key = decodeURIComponent(new URL(url).pathname.split('/members/')[1] || '');
      calls.push({ kind: method, key: key || (init.body ? JSON.parse(init.body).email : ''), subject });
      if (!admins.has(subject)) return Response.json({ error: { code: 403, message: 'Not Authorized to access this resource/api' } }, { status: 403 });
      if (method === 'GET') return Response.json({ members: group });
      if (method === 'POST') {
        const b = JSON.parse(init.body);
        if (group.some((x) => x.email === b.email)) return Response.json({ error: { code: 409, message: 'Member already exists.' } }, { status: 409 });
        // An alias of someone already in it
        if (b.email === 'hal.hart@soardcharity.com' && group.some((x) => x.email === 'hal@soardcharity.com')) return Response.json({ error: { code: 409, message: 'Member already exists.' } }, { status: 409 });
        if (refuseOutside && !b.email.endsWith('@soardcharity.com')) return Response.json({ error: { code: 412, message: 'Condition not met.' } }, { status: 412 });
        group.push(m(b.email, b.role));
        return Response.json(m(b.email, b.role));
      }
      if (method === 'DELETE') {
        if (!group.some((x) => x.email === key)) return Response.json({ error: { code: 404, message: 'Resource Not Found: memberKey' } }, { status: 404 });
        group = group.filter((x) => x.email !== key);
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const emails = () => group.map((x) => x.email).filter(Boolean).sort();
const changes = (kind) => calls.filter((c) => c.kind === kind).map((c) => c.key).sort();
const later = (min) => Date.now() + min * 60_000;

test('the group should hold the active board at their private emails and the founders, nobody else', async () => {
  const w = await groupWanted(env.DB);
  assert.deepEqual(w.members.map((x) => x.email), ['alex@example.com', 'bo.kim@example.org', 'hal@soardcharity.com', 'jane@soardcharity.com']);
  assert.deepEqual(w.members.map((x) => x.name), ['Alex Rivera', 'Bo Kim', 'Hal Hart', 'Jane Doe']);
  assert.equal(w.board, 2);
  assert.deepEqual(w.missing.map((x) => x.name), ['Cy Noemail'], 'a board member with no email is named, not guessed');
});

test('the first look brings board@ up to the board: missing people in, former and stray members out, owners and groups untouched', async () => {
  const s = await syncBoardGroup(env);
  assert.equal(s.ok, true, s.error);
  assert.deepEqual(changes('POST'), ['bo.kim@example.org', 'hal@soardcharity.com'], 'Jane is already in as the owner; Alex is already in');
  assert.deepEqual(changes('DELETE'), ['ex@example.com', 'someone@gmail.com']);
  assert.deepEqual(emails(), ['alex@example.com', 'bo.kim@example.org', 'hal@soardcharity.com', 'helper@soardcharity.com', 'jane@soardcharity.com', 'officers@soardcharity.com']);
  assert.equal(group.find((x) => x.email === 'jane@soardcharity.com').role, 'OWNER', 'the owner keeps their role');
  assert.ok(group.some((x) => x.type === 'CUSTOMER'), 'the whole-domain member stays');
  assert.equal(s.subject, 'jane@soardcharity.com');

  const st = await groupStatus(env);
  assert.equal(st.current, true);
  assert.equal(st.wanted, 4);
  assert.deepEqual(st.changes[0].added.sort(), ['Bo Kim', 'Hal Hart']);
  assert.deepEqual(st.changes[0].removed.sort(), ['Ex Member', 'someone@gmail.com'], 'a former board member by name; a stranger by address');
  assert.ok(!JSON.stringify(st).includes('tok:'), 'no token reaches the admin');
});

test('a change on People → Board reaches the group at the next look, and nothing is asked of Google in between', async () => {
  const t0 = Date.now();
  assert.equal((await maybeSyncBoardGroup(env, { now: t0 }))?.ok, true);
  calls = [];
  assert.equal(await maybeSyncBoardGroup(env, { now: t0 + 60_000 }), null, 'looks at most every 5 minutes');
  assert.equal(await maybeSyncBoardGroup(env, { now: t0 + 5 * 60_000 }), null, 'nothing changed: Google isn’t asked');
  assert.equal(calls.length, 0);

  await setPerson('bo-kim', { name: 'Bo Kim', group: 'board', title: 'Treasurer', status: 'alumni' });
  await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('cy-no-email', 'cy@example.net').run();
  assert.equal((await groupStatus(env)).current, false, 'the admin sees a change waiting');
  const s = await maybeSyncBoardGroup(env, { now: t0 + 10 * 60_000 });
  assert.equal(s.ok, true);
  assert.deepEqual(changes('POST'), ['cy@example.net']);
  assert.deepEqual(changes('DELETE'), ['bo.kim@example.org']);
  assert.equal((await groupStatus(env)).current, true);

  // Someone takes a board member out by hand in Google: put back at the six-hour look
  group = group.filter((x) => x.email !== 'alex@example.com');
  calls = [];
  assert.equal(await maybeSyncBoardGroup(env, { now: t0 + 60 * 60_000 }), null);
  await maybeSyncBoardGroup(env, { now: t0 + 6 * 60 * 60_000 + 11 * 60_000 });
  assert.deepEqual(changes('POST'), ['alex@example.com']);
});

test('without the Google permission: nothing changes, the admin is told the one setting, and Google is asked again half-hourly', async () => {
  scopeGranted = false;
  const t0 = Date.now();
  const s = await maybeSyncBoardGroup(env, { now: t0 });
  assert.equal(s.ok, false);
  assert.equal(s.needs, 'scope');
  assert.equal(calls.filter((c) => c.kind !== 'token').length, 0);
  const st = await groupStatus(env);
  assert.equal(st.needs, 'scope');
  calls = [];
  assert.equal(await maybeSyncBoardGroup(env, { now: t0 + 10 * 60_000 }), null, 'not every 5 minutes');
  scopeGranted = true;
  assert.equal((await maybeSyncBoardGroup(env, { now: t0 + 31 * 60_000 }))?.ok, true, 'once allowed, the next half-hourly look does it');
  assert.equal((await groupStatus(env)).needs, null);
});

test('People → Board with nobody on it (or a read that came back empty) never empties the group', async () => {
  await env.DB.exec('DELETE FROM reveal_board_emails');
  const before = emails();
  const s = await syncBoardGroup(env);
  assert.equal(s.ok, false);
  assert.match(s.error, /nobody with an email/);
  assert.deepEqual(emails(), before);
  assert.equal(calls.length, 0, 'Google isn’t even asked');
});

test('a founder who isn’t a Workspace admin: the next founder is asked', async () => {
  admins = new Set(['hal@soardcharity.com']);
  const s = await syncBoardGroup(env);
  assert.equal(s.ok, true);
  assert.equal(s.subject, 'hal@soardcharity.com');
  admins = new Set();
  const none = await syncBoardGroup(env, { now: later(10) });
  assert.equal(none.needs, 'admin');
});

test('an admin address that is someone’s alias is matched to them, never taken out and put back', async () => {
  await env.DB.exec("CREATE TABLE board_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)");
  await env.DB.prepare("INSERT INTO board_state (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ admins: ['jane@soardcharity.com', 'hal.hart@soardcharity.com'] })).run();
  group.push(m('hal@soardcharity.com'));
  // Before staff sign-in has read Google: Google's "already a member" keeps everyone at that domain in this time
  let s = await syncBoardGroup(env);
  assert.equal(s.ok, true);
  assert.ok(group.some((x) => x.email === 'hal@soardcharity.com'), 'Hal stays');
  // Once staff sign-in has read Google, the alias is Hal's main address and nothing is asked
  await env.DB.exec('CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ subject: 'jane@soardcharity.com', accounts: [{ email: 'hal@soardcharity.com', aliases: ['hal.hart@soardcharity.com'], active: true }] })).run();
  calls = [];
  s = await syncBoardGroup(env, { now: later(10) });
  assert.equal(s.ok, true);
  assert.deepEqual(changes('POST'), []);
  assert.deepEqual(changes('DELETE'), []);
});

test('a group that won’t take outside addresses: the soardcharity.com ones go in, and the admin is told the setting', async () => {
  refuseOutside = true;
  const s = await syncBoardGroup(env);
  assert.equal(s.ok, false);
  assert.equal(s.needs, 'outside');
  assert.ok(group.some((x) => x.email === 'hal@soardcharity.com'));
  assert.match(s.error, /Bo Kim \(Condition not met\.\)/);
  const st = await groupStatus(env);
  assert.deepEqual(st.failing.map((f) => f.name), ['Bo Kim']);
  assert.equal(st.current, false, 'tried again until it goes in');
});

test('no such group in Google says so', async () => {
  globalThis.fetch = ((inner) => async (input, init) => (String(input).startsWith(MEMBERS) ? Response.json({ error: { code: 404, message: 'Resource Not Found: groupKey' } }, { status: 404 }) : inner(input, init)))(globalThis.fetch);
  const s = await syncBoardGroup(env);
  assert.equal(s.needs, 'group');
});

test('an old group with many strays is cleaned up over a few looks, not in one long run', async () => {
  for (let i = 0; i < 40; i++) group.push(m(`old${i}@example.com`));
  const t0 = Date.now();
  await maybeSyncBoardGroup(env, { now: t0 });
  assert.equal(calls.filter((c) => c.kind === 'POST' || c.kind === 'DELETE').length, 25);
  assert.equal((await groupStatus(env)).current, false);
  await maybeSyncBoardGroup(env, { now: t0 + 5 * 60_000 });
  await maybeSyncBoardGroup(env, { now: t0 + 10 * 60_000 });
  assert.ok(!group.some((x) => /^old\d+@/.test(x.email || '')), 'every stray gone');
  assert.equal((await groupStatus(env)).current, true);
});

test('without GOOGLE_CALENDAR_KEY nothing runs', async () => {
  delete env.GOOGLE_CALENDAR_KEY;
  assert.equal(await maybeSyncBoardGroup(env), null);
  assert.equal((await groupStatus(env)).configured, false);
  assert.equal(calls.length, 0);
});
