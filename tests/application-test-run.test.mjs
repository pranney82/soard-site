/**
 * Staff test runs of the makeover application (/apply/form/?test=1, Admin → Applications →
 * Form, "Go through it as a family"): only signed-in staff start one, it works while
 * applications are closed, every email goes to the staff member whatever is typed, it gets no
 * reminders and stays out of the funnel, it submits as a TEST application that archives itself,
 * and its thank-you can follow the intake step by step. (The page itself, ?test=1 and its bar,
 * is driven in a browser by scripts/test-application-form.mjs: HTMLRewriter is Workers-only.)
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld } from './lib/fake-applicant-world.mjs';
import { testAnswers, photoKey, TEST_JPEG, setDraftFile, getDraft, getApplication, processApplication, sendReminders, JT_FIELDS } from '../functions/api/_applications.js';
import { _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import * as applyApi from '../functions/api/apply.js';

const YEAR = '2027';
const STAFF = 'peter@soardcharity.com';
const PHOTOS = ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2'];

// ── A real RS256 key, served as Access's certs, and sign-ins signed with it (as tests/admin-security does)
const TEAM = 'soard';
const AUD = 'aud-tag';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
async function signIn(email = STAFF) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: ISS, aud: [AUD], email, iat: now, nbf: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}

let w;
let env;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  w = fakeApplicantWorld();
  env = { ...w.env, DB: await createD1(), CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
  _resetKeyCacheForTests();
  globalThis.fetch = async (input, init) => (String(input) === `${ISS}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : w.fetchImpl(input, init));
  await env.DB.exec('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await setOpen(false); // the point: staff can test while families can't apply
});
afterEach(() => { globalThis.fetch = realFetch; });

const setOpen = (open) => env.DB.prepare("INSERT OR REPLACE INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ application: { open, year: YEAR } })).run();

/** POST /api/apply, signed in (the admin's cookie) or not */
async function call(body, { cookie = null } = {}) {
  const waits = [];
  const headers = { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', origin: 'https://sunshineonaranneyday.com', ...(cookie ? { Cookie: `theme=dark; CF_Authorization=${cookie}` } : {}) };
  const c = { env, request: new Request('https://sunshineonaranneyday.com/api/apply', { method: 'POST', headers, body: JSON.stringify(body) }), waitUntil: (p) => waits.push(p), data: {} };
  const res = await applyApi.onRequestPost(c);
  await Promise.all(waits);
  return { status: res.status, body: await res.json() };
}

/** The whole application answered, with emails that aren't the staff member's */
const answers = () => ({
  ...testAnswers('someone-else@example.com', YEAR),
  childName: { first: 'Maya', last: 'Rivera' },
  parent2Name: { first: 'Sam', last: 'Rivera' }, parent2Email: 'dad@example.com', parent2Relation: 'Father',
});
async function readyToSubmit(token) {
  assert.equal((await call({ action: 'save', token, answers: answers(), page: 'finish' })).status, 200);
  for (const f of PHOTOS) {
    await env.FILES.put(photoKey(token, f), TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await setDraftFile(env.DB, token, f, { key: photoKey(token, f), type: 'image/jpeg', size: TEST_JPEG.byteLength, name: `${f}.jpg` });
  }
  w.world.videos.vid1 = { uid: 'vid1', readyToStream: false, status: { state: 'inprogress' }, duration: -1 };
  await setDraftFile(env.DB, token, 'video', { uid: 'vid1', uploaded: true, size: 1000, name: 'clip.mov' });
}

test('only signed-in staff start a test run; a family can’t ask for one', async () => {
  const refused = await call({ action: 'start', year: YEAR, test: true });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'staff-only');
  assert.equal((await call({ action: 'start', year: YEAR, test: true }, { cookie: 'not.a.token' })).body.code, 'staff-only', 'a made-up sign-in is no sign-in');
  assert.equal((await call({ action: 'start', year: YEAR })).body.code, 'closed', 'and families still meet the closed form');
});

test('a test run starts while applications are closed, kept out of the funnel and the per-connection limit', async () => {
  const r = await call({ action: 'start', year: YEAR, test: true }, { cookie: await signIn() });
  assert.equal(r.status, 200);
  assert.match(r.body.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(r.body.test, { by: STAFF });
  const draft = await getDraft(env.DB, r.body.token);
  assert.equal(draft.test_by, STAFF);
  assert.equal(draft.ip_hash, 'admin', 'Insights leaves admin drafts out of the funnel');
  assert.equal(draft.email, STAFF);
  // The address check works on it like any draft
  assert.equal((await call({ action: 'resume', token: r.body.token })).body.test.by, STAFF, 'a resumed test run knows it is one');
});

test('every email goes to the staff member: the "finish later" link, the family welcome, the staff heads-up', async () => {
  const { body: { token } } = await call({ action: 'start', year: YEAR, test: true }, { cookie: await signIn() });
  await readyToSubmit(token);
  assert.equal((await getDraft(env.DB, token)).email, STAFF, 'a typed parent email never takes over the draft');

  const link = await call({ action: 'email-link', token, email: 'stranger@example.com' });
  assert.equal(link.status, 200);
  assert.equal(link.body.to, STAFF);
  const sent = w.world.emails.at(-1);
  assert.deepEqual(sent.to, [STAFF]);
  assert.match(sent.subject, /^\[Test run\] /);

  const sub = await call({ action: 'submit', token });
  assert.equal(sub.status, 200);
  const app = await getApplication(env.DB, sub.body.id);
  assert.equal(app.is_test, 1, 'a TEST application, whatever the child is called');
  assert.equal(app.parent_email, STAFF);
  assert.equal(app.answers.parentEmail, STAFF);
  assert.equal(app.answers.parent2Email, STAFF);
  // JobTread: a TEST account whose contacts (whom JobTread emails) all have the staff member's email
  const account = Object.values(w.world.accounts)[0];
  assert.match(account.name, /^TEST Maya Rivera/);
  const emails = account.contacts.map(c => c.fields[JT_FIELDS.email] ?? Object.values(c.fields).find(v => /@/.test(String(v))));
  assert.ok(emails.length >= 2 && emails.every(e => e === STAFF), `contacts: ${emails.join(', ')}`);
  for (const e of w.world.emails) assert.deepEqual(e.to, [STAFF], `"${e.subject}" went to ${e.to}`);
  // The team's Slack channel stays quiet (Slack is connected here: a family's application does post, below)
  assert.equal(w.world.slack.length, 0, 'no Slack post for a test run');
  assert.equal(app.jt_state.staffSlack, 'off');
  await setOpen(true);
  const real = (await call({ action: 'start', year: YEAR })).body.token;
  await readyToSubmit(real);
  await call({ action: 'submit', token: real });
  assert.equal(w.world.slack.length, 1, 'while a family’s application posts as usual');
});

test('the thank-you follows the intake: steps as they finish, the links, and the archive at the end', async () => {
  const { body: { token } } = await call({ action: 'start', year: YEAR, test: true }, { cookie: await signIn() });
  const before = await call({ action: 'test-status', token });
  assert.equal(before.body.submitted, false);
  assert.equal(before.body.to, STAFF);
  await readyToSubmit(token);
  const { body: { id } } = await call({ action: 'submit', token });
  let st = (await call({ action: 'test-status', token })).body;
  assert.equal(st.submitted, true);
  assert.equal(st.id, id);
  assert.match(st.name, /^TEST /);
  assert.match(st.adminUrl, new RegExp(`/admin/#applications/submissions/${id}$`), 'its Submissions row, which opens even once the account is archived');
  assert.match(st.jobtreadUrl, /^https:\/\/app\.jobtread\.com\/customers\//);
  assert.equal(st.steps.account, true);
  assert.equal(st.steps.familyMessage, true);
  assert.equal(st.steps.staffEmail, true);
  assert.equal(st.steps.video, 'waiting', 'Stream is still working on the video');
  assert.equal(st.steps.archived, false, 'it waits for the video before archiving');
  // Stream finishes; the next run attaches the video and archives the account
  w.advanceVideo('vid1', 'ready');
  w.advanceVideo('vid1', 'mp4');
  await processApplication(env, id, { fetchImpl: w.fetchImpl, now: Date.now() + 10 * 60 * 1000 });
  st = (await call({ action: 'test-status', token })).body;
  assert.equal(st.steps.video, true);
  assert.equal(st.steps.archived, true);
  assert.equal(st.status, 'done');
});

test('a real family’s draft has no test status, and a test run never gets reminder emails', async () => {
  await setOpen(true);
  const real = await call({ action: 'start', year: YEAR });
  assert.equal((await call({ action: 'test-status', token: real.body.token })).body.code, 'not-test');
  assert.equal((await call({ action: 'resume', token: real.body.token })).body.test, null);

  const { body: { token } } = await call({ action: 'start', year: YEAR, test: true }, { cookie: await signIn() });
  await call({ action: 'save', token, answers: { childName: { first: 'Maya', last: 'Rivera' } }, page: 'basic' });
  // Make both drafts quiet for weeks, then run the reminders
  await env.DB.prepare("UPDATE application_drafts SET updated_at = '2026-01-01T00:00:00.000Z', verified = 1, email = COALESCE(email, 'mom@example.com')").run();
  env.RESEND_API_KEY = env.RESEND_API_KEY || 're_test';
  const before = w.world.emails.length;
  await sendReminders(env, { now: Date.now() });
  const to = w.world.emails.slice(before).flatMap(e => e.to);
  assert.ok(to.includes('mom@example.com'), `the family's draft got its reminder (sent to: ${to.join(', ') || 'nobody'})`);
  assert.equal(to.includes(STAFF), false, 'the test run got none');
});
