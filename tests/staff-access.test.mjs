/**
 * Staff sign-in follows SOARD's Google Workspace (functions/api/_staff-access.js)
 * Run: node --test tests/staff-access.test.mjs
 *
 * A soardcharity.com sign-in opens the admin only while its Google account is
 * active; a suspended, archived or deleted one is refused and signed out of
 * Cloudflare Access; nothing ever locks staff out by failing.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequest, isAuthenticated, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import { syncStaffDirectory, maybeSyncStaff, staffStanding, staffStatus, clearStaffCache, DIRECTORY_SCOPE } from '../functions/api/_staff-access.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';

const TEAM = 'soard';
const AUD = 'aud-tag';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
async function signIn(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: ISS, aud: [AUD], email, iat: now, nbf: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1234567890', project_id: 'soard-site', private_key: SA_PEM });

const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['hal-hart', { name: 'Hal Hart', group: 'team', title: 'Co-Founder' }],
  ['pat-lee', { name: 'Pat Lee', group: 'team', title: 'Program Director' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair' }],
];
const user = (email, extra = {}) => ({ primaryEmail: email, name: { fullName: email.split('@')[0] }, suspended: false, archived: false, lastLoginTime: '2026-10-27T15:00:00.000Z', ...extra });

let env;
let google; // what Google's directory holds: [user]
let admins; // who Google lets read it
let googleDown; // every Directory call fails
let scopeGranted;
let calls; // outside calls: { kind, url, body, subject }
const realFetch = globalThis.fetch;

beforeEach(async () => {
  env = { DB: await createD1(), CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT, CF_ACCESS_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acct1' };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('alex-rivera', 'alex@example.com').run();
  google = [user('jane@soardcharity.com'), user('hal@soardcharity.com', { aliases: ['hal.hart@soardcharity.com'] }), user('pat@soardcharity.com'), user('sam@soardcharity.com'), user('old@soardcharity.com', { suspended: true })];
  admins = new Set(['jane@soardcharity.com']);
  googleDown = false;
  scopeGranted = true;
  calls = [];
  _resetKeyCacheForTests();
  clearTokenCache();
  clearStaffCache();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === `${ISS}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      if (claims.scope !== DIRECTORY_SCOPE) throw new Error(`unexpected scope ${claims.scope}`);
      calls.push({ kind: 'token', subject: claims.sub });
      if (!scopeGranted) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.' }, { status: 401 });
      return Response.json({ access_token: `tok:${claims.sub}`, expires_in: 3600 });
    }
    if (url.startsWith('https://admin.googleapis.com/admin/directory/v1/users')) {
      const subject = String(init.headers?.Authorization || '').replace('Bearer tok:', '');
      calls.push({ kind: 'directory', url, subject });
      if (googleDown) return Response.json({ error: { code: 503, message: 'Backend Error' } }, { status: 503 });
      if (!admins.has(subject)) return Response.json({ error: { code: 403, message: 'Not Authorized to access this resource/api', errors: [{ reason: 'forbidden' }] } }, { status: 403 });
      const key = decodeURIComponent(new URL(url).pathname.split('/users/')[1] || '');
      if (!key) return Response.json({ users: google });
      const u = google.find((x) => x.primaryEmail === key || (x.aliases || []).includes(key));
      return u ? Response.json(u) : Response.json({ error: { code: 404, message: 'Resource Not Found: userKey' } }, { status: 404 });
    }
    if (url === 'https://api.cloudflare.com/client/v4/accounts/acct1/access/organizations/revoke_user') {
      calls.push({ kind: 'revoke', body: JSON.parse(init.body) });
      return Response.json({ success: true, result: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

/** A request to an admin API through the middleware, signed in as `email` */
async function call(email, path = '/api/kids-admin') {
  const request = new Request(`https://sunshineonaranneyday.com${path}`, { headers: { 'CF-Access-JWT-Assertion': await signIn(email), Origin: 'https://sunshineonaranneyday.com' } });
  const ctx = { request, env, data: {}, waitUntil: () => {}, next: async () => Response.json({ ok: true, user: ctx.data.userEmail }) };
  const res = await onRequest(ctx);
  return { status: res.status, body: await res.json() };
}
const revoked = () => calls.filter((c) => c.kind === 'revoke').map((c) => c.body.email).sort();
const later = (min) => Date.now() + min * 60_000;

test('before Google has been read, a soardcharity.com sign-in opens the admin the way it always has', async () => {
  assert.equal((await call('anyone@soardcharity.com')).status, 200);
  assert.equal((await call('stranger@example.com')).status, 403, 'and anyone else still doesn’t');
  assert.equal(calls.filter((c) => c.kind === 'directory').length, 0, 'without asking Google');
});

test('once read, an active account opens the admin and a suspended one is refused with why', async () => {
  const s = await syncStaffDirectory(env);
  assert.equal(s.ok, true);
  assert.equal(s.subject, 'jane@soardcharity.com', 'read as a founder who is a Workspace admin');
  clearStaffCache();
  assert.equal((await call('pat@soardcharity.com')).status, 200);
  assert.equal((await call('hal.hart@soardcharity.com')).status, 200, 'an alias of an active account counts');
  const off = await call('old@soardcharity.com');
  assert.equal(off.status, 403);
  assert.match(off.body.error, /suspended in Google, so it can’t open the admin/);
  assert.equal((await call('alex@example.com', '/api/board-portal')).status, 200, 'a board member’s sign-in is untouched');
  assert.equal(revoked().length, 0, 'someone already suspended at the first read isn’t a change: nothing to sign out');
});

test('suspended or deleted in Google: refused within the next read and signed out of Cloudflare everywhere', async () => {
  await syncStaffDirectory(env);
  google = google.map((u) => (u.primaryEmail === 'hal@soardcharity.com' ? { ...u, suspended: true } : u)).filter((u) => u.primaryEmail !== 'sam@soardcharity.com');
  const s = await syncStaffDirectory(env, { now: later(5) });
  assert.deepEqual(revoked(), ['hal.hart@soardcharity.com', 'hal@soardcharity.com', 'sam@soardcharity.com'], 'every soardcharity.com address of each, so no open sign-in survives');
  assert.deepEqual(s.out.map((o) => [o.email, o.why, o.signedOut]), [['sam@soardcharity.com', 'gone', true], ['hal@soardcharity.com', 'suspended', true]]);
  assert.equal((await call('hal@soardcharity.com')).status, 403);
  assert.equal((await call('hal.hart@soardcharity.com')).status, 403);
  const gone = await call('sam@soardcharity.com');
  assert.equal(gone.status, 403);
  assert.match(gone.body.error, /was deleted in Google/);
  const lookups = calls.filter((c) => c.kind === 'directory' && /users\/sam/.test(c.url));
  assert.equal(lookups.length, 0, 'a deleted account is refused from the read, without asking Google again');

  // Put back in Google: the next read lets them in again, and nobody is signed out twice
  google = google.map((u) => (u.primaryEmail === 'hal@soardcharity.com' ? { ...u, suspended: false } : u));
  await syncStaffDirectory(env, { now: later(10) });
  assert.equal((await call('hal@soardcharity.com')).status, 200);
  assert.equal(revoked().length, 3);
});

test('a new hire Google has but the last read didn’t is asked about then and there; a group’s address isn’t an account', async () => {
  await syncStaffDirectory(env);
  google.push(user('newbie@soardcharity.com'));
  clearStaffCache();
  assert.equal((await call('newbie@soardcharity.com')).status, 200, 'no wait for the next read');
  const group = await call('info@soardcharity.com');
  assert.equal(group.status, 403);
  assert.match(group.body.error, /isn’t a SOARD Google account/);
});

test('Google not answering never locks anyone out, and the last read keeps standing', async () => {
  await syncStaffDirectory(env);
  googleDown = true;
  const s = await syncStaffDirectory(env, { now: later(5) });
  assert.equal(s.ok, false);
  assert.match(s.error, /Backend Error/);
  clearStaffCache();
  assert.equal((await call('pat@soardcharity.com')).status, 200, 'the last read still counts');
  assert.equal((await call('old@soardcharity.com')).status, 403, 'and so does a suspension it saw');
  assert.equal((await call('newbie@soardcharity.com')).status, 200, 'an address Google can’t be asked about goes by the old rule');
  assert.equal(revoked().length, 0);
});

test('the Google setting each failure needs is named: the scope, the Admin SDK API, an admin to read as', async () => {
  scopeGranted = false;
  let s = await syncStaffDirectory(env);
  assert.equal(s.needs, 'scope');
  assert.equal((await staffStatus(env)).clientId, '1234567890');
  assert.equal((await call('anyone@soardcharity.com')).status, 200, 'never read: the old rule');

  scopeGranted = true;
  clearTokenCache();
  admins = new Set();
  s = await syncStaffDirectory(env);
  assert.equal(s.needs, 'admin', 'no founder is a Workspace admin');
  assert.deepEqual(calls.filter((c) => c.kind === 'directory').map((c) => c.subject), ['jane@soardcharity.com', 'hal@soardcharity.com'], 'each founder was tried');

  admins = new Set(['hal@soardcharity.com']);
  s = await syncStaffDirectory(env);
  assert.equal(s.ok, true);
  assert.equal(s.subject, 'hal@soardcharity.com', 'the founder who is an admin is remembered');
});

test('a read that suddenly loses a third of the active accounts isn’t believed', async () => {
  await syncStaffDirectory(env);
  google = google.filter((u) => u.primaryEmail === 'jane@soardcharity.com');
  const s = await syncStaffDirectory(env, { now: later(5) });
  assert.equal(s.ok, false);
  assert.match(s.error, /suddenly left out 3 of 4 active accounts, so nobody was signed out/);
  assert.equal(revoked().length, 0);
  clearStaffCache();
  assert.equal((await call('pat@soardcharity.com')).status, 200);
});

test('the other staff checks follow it too: isAuthenticated', async () => {
  await syncStaffDirectory(env);
  const req = async (email) => new Request('https://sunshineonaranneyday.com/api/live-status', { headers: { 'CF-Access-JWT-Assertion': await signIn(email) } });
  assert.equal(await isAuthenticated(await req('pat@soardcharity.com'), env), true);
  assert.equal(await isAuthenticated(await req('old@soardcharity.com'), env), false);
});

test('the heartbeat reads every 5 minutes at most, and only once the Google key is there', async () => {
  const t0 = Date.now();
  assert.equal((await maybeSyncStaff(env, { now: t0 }))?.ok, true);
  assert.equal(await maybeSyncStaff(env, { now: t0 + 60_000 }), null);
  assert.equal((await maybeSyncStaff(env, { now: t0 + 5 * 60_000 }))?.ok, true);
  delete env.GOOGLE_CALENDAR_KEY;
  assert.equal(await maybeSyncStaff(env, { now: t0 + 20 * 60_000 }), null);
});

test('no Cloudflare key: still refused by the site, and the page says the open sign-in wasn’t ended', async () => {
  await syncStaffDirectory(env);
  delete env.CF_ACCESS_API_TOKEN;
  google = google.map((u) => (u.primaryEmail === 'pat@soardcharity.com' ? { ...u, suspended: true } : u));
  await syncStaffDirectory(env, { now: later(5) });
  assert.equal((await call('pat@soardcharity.com')).status, 403);
  const st = await staffStatus(env);
  assert.deepEqual([st.active, st.off, st.out[0].signedOut], [3, 2, false]);
  assert.match(st.out[0].error, /No CF_ACCESS_API_TOKEN/);
});

test('a broken database never locks staff out', async () => {
  const broken = { prepare() { throw new Error('D1 is down'); } };
  assert.equal((await staffStanding({ DB: broken }, 'pat@soardcharity.com')).staff, true);
});
