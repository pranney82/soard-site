/**
 * The board: who a sign-in is (staff, board member, nobody) and what each
 * reaches, the Board area's meetings, files and documents, the board page,
 * Access's board list kept by the site, the packet email, and reading an old
 * agenda. Made-up people only (the repo is public).
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequest, isAuthenticated, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import { isStaffEmail, boardMemberFor, founderEmails, boardAdmins, isBoardAdmin, peopleRows } from '../functions/api/_board-roles.js';
import * as admin from '../functions/api/board-admin.js';
import * as portal from '../functions/api/board-portal.js';
import * as fileRoute from '../functions/api/board-file.js';
import { syncBoardAccess, accessStatus, maybeSyncBoardAccess, GROUP_NAME, POLICY_NAME, NOBODY } from '../functions/api/_board-access.js';
import { packetEmail, cashNow, getMeeting, listMeetings, maybeRunBoard, cashHistory, provideBoardFinance, liveNumbers, saveMeeting } from '../functions/api/_board.js';
import { isBoardMeetingEvent, eventWhen, eventPlace, syncBoardCalendar, calendarStatus } from '../functions/api/_board-calendar.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { generateKeyPairSync } from 'node:crypto';
import { parseAgendaText, cleanMeeting, forBoard, newMeeting, openActions, quarterOf, meetingName, noteBlocks, emailOutline, timeRange, liveLines } from '../public/admin/board-shared.js';

// ── A real RS256 key served as Access's certs (as tests/admin-security does)
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

const FOUNDER = 'jane@soardcharity.com';
const STAFF = 'pat@soardcharity.com';
const MEMBER = 'alex.board@example.com';
const OTHER_MEMBER = 'sam.board@example.org';
const ALUMNUS = 'old.board@example.net';

const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['pat-lee', { name: 'Pat Lee', group: 'team', title: 'Program Director' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair', organization: 'Rivera Builders' }],
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
  ['kim-park', { name: 'Kim Park', group: 'board', title: 'Board Member' }],
  ['old-timer', { name: 'Old Timer', group: 'board', title: 'Board Member', status: 'alumni' }],
  ['ada-advisor', { name: 'Ada Advisor', group: 'advisory', title: 'Advisory Board Member' }],
];

class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, bytes, opts) { this.map.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType }); }
  async get(key) { const o = this.map.get(key); return o ? { body: o.bytes, size: o.bytes.length, httpMetadata: { contentType: o.type } } : null; }
  async delete(key) { this.map.delete(key); }
}

let env;
const realFetch = globalThis.fetch;
let outside = []; // calls this test's fake fetch saw (Resend, Cloudflare, Mercury)
let answer = null; // (url, init) → Response for outside calls

beforeEach(async () => {
  env = { DB: await createD1(), FILES: new FakeR2(), CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, RESEND_API_KEY: 're_test' };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  for (const [slug, email] of [['alex-rivera', MEMBER], ['sam-ortiz', OTHER_MEMBER], ['old-timer', ALUMNUS], ['ada-advisor', 'ada@example.com']]) {
    await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  }
  _resetKeyCacheForTests();
  outside = [];
  answer = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === `${ISS}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    const json = (b) => { try { return typeof b === 'string' ? JSON.parse(b) : null; } catch { return null; } };
    outside.push({ url, method: init.method || 'GET', body: json(init.body), headers: init.headers || {} });
    if (answer) return answer(url, init);
    if (url.startsWith('https://api.resend.com/')) return Response.json({ data: JSON.parse(init.body).map((_, i) => ({ id: `em_${i}` })) });
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

/** A request through the middleware, signed in as `email`, landing on `handler` (or an echo of who it was) */
async function call(email, path, { method = 'GET', body = null, handler = null, form = null } = {}) {
  const url = `https://sunshineonaranneyday.com${path}`;
  const headers = { 'CF-Access-JWT-Assertion': await signIn(email), Origin: 'https://sunshineonaranneyday.com' };
  if (body) headers['Content-Type'] = 'application/json';
  const request = new Request(url, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const ctx = { request, env, data: {}, waitUntil: () => {} };
  ctx.next = async () => (handler ? handler(ctx) : Response.json({ ok: true, user: ctx.data.userEmail, member: ctx.data.boardMember?.slug || null }));
  const res = await onRequest(ctx);
  const type = res.headers.get('Content-Type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.arrayBuffer() };
}
const adminApi = (email, body = null, query = '') => call(email, `/api/board-admin${query}`, body ? { method: 'POST', body, handler: admin.onRequestPost } : { handler: admin.onRequestGet });
const portalApi = (email, body = null) => call(email, '/api/board-portal', body ? { method: 'POST', body, handler: portal.onRequestPost } : { handler: portal.onRequestGet });

// ─── Who a sign-in is ───────────────────────────────────────────────

test('staff are soardcharity.com sign-ins; a board member is found by their private email; alumni and advisors are not on the board', async () => {
  assert.equal(isStaffEmail('Pat@SoardCharity.com '), true);
  assert.equal(isStaffEmail('pat@soardcharity.com.evil.example'), false);
  assert.equal(isStaffEmail('pat@notsoardcharity.com'), false);
  assert.equal((await boardMemberFor(env.DB, 'ALEX.board@example.com')).slug, 'alex-rivera');
  assert.equal(await boardMemberFor(env.DB, ALUMNUS), null, 'alumni are off the board');
  assert.equal(await boardMemberFor(env.DB, 'ada@example.com'), null, 'the Advisory Board is not the board');
  assert.equal(await boardMemberFor(env.DB, 'stranger@example.com'), null);
});

test('the Board area is for the founders until Settings names its admins', async () => {
  assert.deepEqual(founderEmails(await peopleRows(env.DB)), [FOUNDER]);
  assert.deepEqual(await boardAdmins(env.DB), [FOUNDER]);
  assert.equal(await isBoardAdmin(env.DB, FOUNDER), true);
  assert.equal(await isBoardAdmin(env.DB, STAFF), false);
  assert.equal(await isBoardAdmin(env.DB, MEMBER), false, 'never a board member');
  assert.deepEqual(await boardAdmins(env.DB, { admins: ['pat@soardcharity.com', 'evil@example.com'] }), [STAFF], 'only staff addresses count');
});

test('the middleware: a board member reaches only the board page’s routes; anyone else Access let in reaches nothing', async () => {
  const staff = await call(STAFF, '/api/partners-batch');
  assert.equal(staff.status, 200);
  assert.equal(staff.body.member, null);

  const member = await call(MEMBER, '/api/board-portal');
  assert.equal(member.status, 200);
  assert.equal(member.body.member, 'alex-rivera');
  assert.equal((await call(MEMBER, '/api/board-file?id=f_x')).status, 200);
  for (const path of ['/api/partners-batch', '/api/board-admin', '/api/save-content', '/api/applicants-admin', '/api/reveals-admin', '/api/board-portal/../save-content']) {
    const r = await call(MEMBER, path, { method: path.includes('save') ? 'POST' : 'GET', body: path.includes('save') ? {} : null });
    assert.equal(r.status, 403, path);
    assert.equal(r.body.board, '/admin/board/', `${path}: pointed at the board page`);
  }
  for (const email of [ALUMNUS, 'ada@example.com', 'stranger@example.com']) {
    const r = await call(email, '/api/board-portal');
    assert.equal(r.status, 403, email);
    assert.match(r.body.error, /team or board list/);
  }
});

test('isAuthenticated (live chat staff, test applications, sweeps) is staff only', async () => {
  const req = async (email) => new Request('https://sunshineonaranneyday.com/api/live-status', { headers: { 'CF-Access-JWT-Assertion': await signIn(email) } });
  assert.equal(await isAuthenticated(await req(STAFF), env), true);
  assert.equal(await isAuthenticated(await req(MEMBER), env), false);
});

// ─── The Board area ─────────────────────────────────────────────────

test('only the Board area’s admins open it; any staff can ask whether they are one', async () => {
  assert.equal((await adminApi(STAFF)).status, 403);
  assert.equal((await adminApi(STAFF, null, '?me=1')).body.admin, false);
  assert.equal((await adminApi(FOUNDER, null, '?me=1')).body.admin, true);
  const r = await adminApi(FOUNDER);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.settings.admins, [FOUNDER]);
  assert.deepEqual(r.body.members.map((m) => [m.slug, !!m.email]), [['alex-rivera', true], ['sam-ortiz', true], ['kim-park', false]]);
  assert.equal(r.body.packetTo, 2);
  assert.equal(r.body.access.configured, false);
  assert.deepEqual(r.body.access.missing.map((m) => m.slug), ['kim-park']);
});

test('a new meeting: the template, the board on the attendance list, the last minutes up for approval, open action items carried over', async () => {
  const first = (await adminApi(FOUNDER, { action: 'new-meeting', date: '2026-02-12' })).body.meeting;
  assert.equal(meetingName(first), 'Q1 2026 Board Meeting');
  assert.deepEqual(first.attendance.map((p) => `${p.kind}:${p.slug}`), ['board:alex-rivera', 'board:sam-ortiz', 'board:kim-park', 'staff:jane-doe']);
  first.actions = [{ text: 'Send the expectations document', owner: 'alex-rivera', ownerName: 'Alex Rivera' }];
  const saved = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: first, base: first.updatedAt })).body.meeting;
  const actionId = saved.actions[0].id;

  const second = (await adminApi(FOUNDER, { action: 'new-meeting', date: '2026-04-30' })).body.meeting;
  assert.equal(quarterOf(second.date), 'Q2 2026');
  const minutes = second.sections.find((s) => /minutes/i.test(s.title)).items[0];
  assert.equal(minutes.title, 'Minutes of the Q1 2026 Board Meeting (Feb 12, 2026)');
  assert.deepEqual(second.actions.map((a) => a.id), [actionId], 'carried with its own id');

  // Done once is done everywhere it was carried
  await adminApi(FOUNDER, { action: 'action-done', actionId, done: true });
  const all = await listMeetings(env.DB);
  assert.ok(all.every((m) => m.actions.every((a) => a.done)));
  assert.deepEqual(openActions(all), []);
});

test('saving over someone else’s newer save is refused with theirs', async () => {
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: '2026-08-06' })).body.meeting;
  const a = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m, location: 'First' }, base: m.updatedAt })).body.meeting;
  const late = await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m, location: 'Second' }, base: m.updatedAt });
  assert.equal(late.status, 409);
  assert.equal(late.body.current.location, 'First');
  assert.equal((await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...a, location: 'Second' }, base: a.updatedAt })).status, 200);
});

// ─── The board page ─────────────────────────────────────────────────

async function sharedMeetingWithFiles() {
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: '2026-11-19' })).body.meeting;
  m.sections[2].items[0] = { ...m.sections[2].items[0], notes: '- Insurance is looking into it', staffNote: 'Ask counsel before the meeting', confidential: true, title: 'Legal update' };
  m.actions = [{ text: 'Call the venue', owner: 'alex-rivera', ownerName: 'Alex Rivera' }, { text: 'Draft the budget', owner: 'sam-ortiz', ownerName: 'Sam Ortiz' }];
  const saved = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m, shared: true }, base: m.updatedAt })).body.meeting;
  const upload = async (name, bytes, staffOnly) => {
    const form = new FormData();
    form.set('file', new File([bytes], name));
    form.set('ownerType', 'meeting'); form.set('ownerId', saved.id); form.set('kind', 'financials'); form.set('staffOnly', String(staffOnly));
    return call(FOUNDER, '/api/board-admin?upload=1', { method: 'POST', form, handler: admin.onRequestPost });
  };
  const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n');
  const shown = (await upload('Balance sheet.pdf', pdf, false)).body.file;
  const hidden = (await upload('Draft numbers.pdf', pdf, true)).body.file;
  return { meeting: saved, shown, hidden, upload };
}

test('the board page shows shared meetings only, without Peter and Holly’s own notes or staff-only files', async () => {
  const draft = (await adminApi(FOUNDER, { action: 'new-meeting', date: '2027-02-11' })).body.meeting;
  const { meeting, shown, hidden } = await sharedMeetingWithFiles();
  const r = await portalApi(MEMBER);
  assert.equal(r.status, 200);
  assert.equal(r.body.me.slug, 'alex-rivera');
  assert.deepEqual(r.body.meetings.map((m) => m.id), [meeting.id], 'the draft meeting stays off');
  assert.ok(!r.body.meetings.some((m) => m.id === draft.id));
  const text = JSON.stringify(r.body);
  assert.doesNotMatch(text, /Ask counsel/, 'staff notes never reach the board');
  assert.match(text, /Insurance is looking into it/);
  assert.deepEqual(r.body.meetings[0].files.map((f) => f.id), [shown.id]);
  assert.ok(!text.includes(hidden.id));
  assert.deepEqual(r.body.actions.filter((a) => a.mine).map((a) => a.text), ['Call the venue']);
  assert.deepEqual(r.body.people.board.map((p) => p.name), ['Alex Rivera', 'Sam Ortiz', 'Kim Park'], 'alumni off the directory');
  // Other staff can't open the board page; the founders can look
  assert.equal((await portalApi(STAFF)).status, 403);
  assert.equal((await portalApi(FOUNDER)).status, 200);
});

test('files: a member opens a shared meeting’s files, never a staff-only one; nothing that could run on the site is stored', async () => {
  const { meeting, shown, hidden, upload } = await sharedMeetingWithFiles();
  const get = (email, id) => call(email, `/api/board-file?id=${id}`, { handler: fileRoute.onRequestGet });
  const ok = await get(MEMBER, shown.id);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Content-Type'), 'application/pdf');
  assert.equal(ok.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await get(MEMBER, hidden.id)).status, 404);
  assert.equal((await get(FOUNDER, hidden.id)).status, 200);
  assert.equal((await get(STAFF, shown.id)).status, 404, 'other staff');
  // Unshare the meeting: its files go with it
  const m = await getMeeting(env.DB, meeting.id);
  await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m, shared: false }, base: m.updatedAt });
  assert.equal((await get(MEMBER, shown.id)).status, 404);
  const html = await upload('notes.html', new TextEncoder().encode('<script>alert(1)</script>'), false);
  assert.equal(html.status, 415);
  const fakeDocx = await upload('minutes.docx', new TextEncoder().encode('<html>'), false);
  assert.equal(fakeDocx.status, 415, 'the name alone never makes a file a Word file');
  for (const key of env.FILES.map.keys()) assert.match(key, /^board\/meeting\//, 'board files live under board/, which nothing public serves');
});

test('a member answers for themselves: whether they’ll come, their own action items, their signature', async () => {
  const { meeting } = await sharedMeetingWithFiles();
  assert.equal((await portalApi(MEMBER, { action: 'rsvp', meetingId: meeting.id, answer: 'remote' })).status, 200);
  const shown = (await adminApi(FOUNDER)).body.meetings.find((m) => m.id === meeting.id);
  assert.equal(shown.attendance.find((p) => p.slug === 'alex-rivera').rsvp, 'remote');
  const [mine, theirs] = meeting.actions;
  assert.equal((await portalApi(MEMBER, { action: 'action-done', actionId: mine.id, done: true })).status, 200);
  assert.equal((await portalApi(MEMBER, { action: 'action-done', actionId: theirs.id, done: true })).status, 403);
  assert.equal((await portalApi(FOUNDER, { action: 'rsvp', meetingId: meeting.id, answer: 'yes' })).status, 403, 'an admin looking has no seat');

  const doc = (await adminApi(FOUNDER, { action: 'save-doc', doc: { title: 'Conflict of interest policy', kind: 'policy', sign: true } })).body.doc;
  const plain = (await adminApi(FOUNDER, { action: 'save-doc', doc: { title: 'Bylaws', kind: 'governance' } })).body.doc;
  assert.equal((await portalApi(MEMBER, { action: 'sign', docId: plain.id, name: 'Alex Rivera' })).status, 404);
  assert.equal((await portalApi(MEMBER, { action: 'sign', docId: doc.id, name: 'A' })).status, 400);
  assert.equal((await portalApi(MEMBER, { action: 'sign', docId: doc.id, name: 'Alex Rivera' })).status, 200);
  const page = (await portalApi(MEMBER)).body;
  assert.equal(page.docs.find((d) => d.id === doc.id).signedByMe.name, 'Alex Rivera');
  assert.equal((await adminApi(FOUNDER)).body.docs.find((d) => d.id === doc.id).signed['alex-rivera'].name, 'Alex Rivera');
});

// ─── The packet email ───────────────────────────────────────────────

test('the packet email has the agenda’s headings only: no notes, no confidential titles; Send it to me goes only to you', async () => {
  const { meeting } = await sharedMeetingWithFiles();
  const mail = packetEmail(await getMeeting(env.DB, meeting.id));
  assert.doesNotMatch(mail.html, /Insurance is looking|Ask counsel|Legal update/);
  assert.match(mail.html, /A confidential item \(on the board page\)/);
  assert.match(mail.html, new RegExp(`/admin/board/#/meetings/${meeting.id}`));

  const test = await adminApi(FOUNDER, { action: 'send-packet', id: meeting.id, test: true });
  assert.equal(test.status, 200);
  assert.deepEqual(outside.flatMap((c) => c.body.map((e) => e.to[0])), [FOUNDER]);
  assert.equal(test.body.meeting.packetSentAt, '', 'a preview isn’t the packet going out');

  outside = [];
  const real = await adminApi(FOUNDER, { action: 'send-packet', id: meeting.id });
  assert.equal(real.body.sent, 2);
  assert.deepEqual(outside.flatMap((c) => c.body.map((e) => e.to[0])).sort(), [MEMBER, OTHER_MEMBER]);
  assert.ok(real.body.meeting.packetSentAt);
  assert.equal(real.body.meeting.packetSentTo, 2);
});

// ─── Access's board list ────────────────────────────────────────────

function fakeCloudflare({ attached = false } = {}) {
  const state = { groups: [], policies: [], apps: [{ id: 'app1', name: 'SOARD Admin', aud: AUD, policies: [{ id: 'staff-policy' }] }] };
  answer = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/client\/v4\/accounts\/acct1/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    const ok = (result) => Response.json({ success: true, result });
    if (path === '/access/groups' && init.method === 'POST') { const g = { id: `g${state.groups.length + 1}`, ...body }; state.groups.push(g); return ok(g); }
    if (path === '/access/groups') return ok(state.groups);
    const g = path.match(/^\/access\/groups\/(\w+)$/);
    if (g && init.method === 'PUT') { const i = state.groups.findIndex((x) => x.id === g[1]); state.groups[i] = { id: g[1], ...body }; return ok(state.groups[i]); }
    if (g) { const found = state.groups.find((x) => x.id === g[1]); return found ? ok(found) : Response.json({ success: false, errors: [{ message: 'not found' }] }, { status: 404 }); }
    if (path === '/access/policies' && init.method === 'POST') { const p = { id: 'board-policy', ...body }; state.policies.push(p); if (attached) state.apps[0].policies.push({ id: p.id }); return ok(p); }
    if (path === '/access/policies') return ok(state.policies);
    if (path === '/access/apps') return ok(state.apps);
    throw new Error(`unexpected Cloudflare call ${init.method} ${path}`);
  };
  Object.assign(env, { CF_ACCESS_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acct1' });
  return state;
}

test('Access’s board list: the site makes the group and the policy, keeps the group to People → Board, and never edits the admin app', async () => {
  const cf = fakeCloudflare();
  const first = await syncBoardAccess(env);
  assert.equal(first.ok, true);
  assert.equal(cf.groups[0].name, GROUP_NAME);
  assert.deepEqual(cf.groups[0].include, [{ email: { email: MEMBER } }, { email: { email: OTHER_MEMBER } }], 'active board only, A to Z');
  assert.equal(cf.policies[0].name, POLICY_NAME);
  assert.deepEqual(cf.policies[0].include, [{ group: { id: 'g1' } }]);
  assert.equal(first.attached, false, 'adding the policy to the app is the one dashboard step');
  assert.equal(first.appName, 'SOARD Admin');
  assert.ok(!outside.some((c) => c.url.includes('/access/apps/') || (c.url.includes('/access/apps') && c.method !== 'GET')), 'the admin app itself is only ever read');
  assert.equal(outside[0].headers.Authorization, 'Bearer cf-token');

  // Someone leaves the board, someone joins: the group follows
  await env.DB.prepare('UPDATE team SET data = ? WHERE slug = ?').bind(JSON.stringify({ name: 'Sam Ortiz', group: 'board', status: 'alumni' }), 'sam-ortiz').run();
  await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('kim-park', 'kim@example.com').run();
  assert.equal((await accessStatus(env)).current, false, 'the admin can see a change waiting');
  const now = Date.now();
  await maybeSyncBoardAccess(env, { now });
  assert.deepEqual(cf.groups[0].include.map((r) => r.email.email), ['alex.board@example.com', 'kim@example.com']);
  assert.equal(cf.groups.length, 1, 'the same group, updated');
  assert.equal((await accessStatus(env)).current, true);
  const calls = outside.length;
  await maybeSyncBoardAccess(env, { now: now + 60_000 });
  assert.equal(outside.length, calls, 'looks again only every 5 minutes');

  // Nobody left with an email: the group empties rather than keeping old addresses
  await env.DB.exec('DELETE FROM reveal_board_emails');
  await syncBoardAccess(env);
  assert.deepEqual(cf.groups[0].include, [{ email: { email: NOBODY } }]);
});

test('Access’s board list shows the app as using the policy once it’s added; a failure is kept for the admin', async () => {
  fakeCloudflare({ attached: true });
  assert.equal((await syncBoardAccess(env)).attached, true);
  answer = async () => Response.json({ success: false, errors: [{ message: 'Authentication error' }] }, { status: 403 });
  const failed = await syncBoardAccess(env);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Authentication error/);
  assert.equal((await accessStatus(env)).groupId, 'g1', 'what worked before is still known');
});

// ─── Cash ───────────────────────────────────────────────────────────

test('cash in the bank: Mercury’s own checking and savings, not external or closed accounts; one row a month', async () => {
  env.MERCURY_API_TOKEN = 'mercury-token';
  env.MERCURY_RELAY_KEY = 'relay-key';
  answer = async (url, init) => {
    assert.equal(url, 'https://mercury-relay.sunshineonaranneyday.com/api/v1/accounts');
    assert.equal(init.headers['X-Relay-Key'], 'relay-key');
    return Response.json({ accounts: [
      { name: 'Operating', kind: 'checking', type: 'mercury', status: 'active', currentBalance: 300000.5 },
      { nickname: 'Reserve', kind: 'savings', type: 'mercury', status: 'active', currentBalance: 75000 },
      { name: 'Old', kind: 'checking', type: 'mercury', status: 'archived', currentBalance: 9 },
      { name: 'Bank of elsewhere', kind: 'externalChecking', type: 'external', status: 'active', currentBalance: 1e6 },
    ] });
  };
  const cash = await cashNow(env);
  assert.equal(cash.total, 375000.5);
  assert.deepEqual(cash.accounts.map((a) => a.name), ['Operating', 'Reserve']);
  await maybeRunBoard(env, { now: Date.parse('2026-10-27T15:00:00Z') });
  await maybeRunBoard(env, { now: Date.parse('2026-10-27T18:00:00Z') });
  const history = await cashHistory(env.DB);
  assert.deepEqual(history.map((h) => [h.month, h.total]), [['2026-10', 375000.5]]);
  assert.equal(outside.length, 2, 'once a day: the check above and one heartbeat');
});

// ─── Finance from Job Costs ─────────────────────────────────────────

const FINANCE = {
  at: '2026-10-27T15:00:00.000Z',
  months: [{ month: '2026-09', income: 90000, makeovers: 40000, store: 15000, operating: 20000, storeSales: 30000, net: 15000 }],
  ytd: { year: 2026, through: '2026-10-27', income: 900000, makeovers: 500000, store: 150000, operating: 200000, net: 50000 },
  lastYtd: { year: 2025, through: '2025-10-27', income: 800000, makeovers: 480000, store: 140000, operating: 200000, net: -20000 },
  cash: { today: 375000, lowest: { dollars: 210000, week: '2027-01-04' }, cautiousLowest: { dollars: 180000, week: '2027-01-11' }, in13Weeks: 260000, floor: 150000, belowFloor: false },
  close: { month: '2026-09', label: 'September', state: 'ready', closedAt: null },
  perMakeover: { count: 12, average: 21000 },
};

test('finance from Job Costs: nothing until its module registers, then on the board page and in the packet; a failure never breaks the page', async (t) => {
  t.after(() => provideBoardFinance(null));
  provideBoardFinance(null);
  assert.equal((await portalApi(MEMBER)).body.numbers.finance, null, 'no finance module yet: no section');
  let calls = 0;
  provideBoardFinance(async () => { calls += 1; return FINANCE; });
  const page = (await portalApi(MEMBER)).body;
  assert.deepEqual(page.numbers.finance.ytd, FINANCE.ytd);
  await portalApi(MEMBER);
  assert.equal(calls, 1, 'a 15-minute copy, not a fresh read every page');
  const lines = liveLines('cash', page.numbers);
  assert.ok(lines.some((l) => l === '2026 so far (through October): $900,000 in, $850,000 out, net $50,000; 2025 to the same day: net −$20,000'), lines.join(' | '));
  assert.ok(lines.some((l) => /^Cash forecast: lowest \$210,000 the week of Jan 4, \$260,000 in 13 weeks$/.test(l)));
  assert.ok(lines.includes('September’s books: ready to close'));
  // Locking the packet keeps the finance lines with it
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: '2026-11-19' })).body.meeting;
  const locked = (await adminApi(FOUNDER, { action: 'snapshot', id: m.id })).body.meeting;
  assert.deepEqual(locked.snapshot.finance.ytd, FINANCE.ytd);
  // The module throwing (its tables not made yet) leaves the last good copy, or nothing
  provideBoardFinance(async () => { throw new Error('no such table: mercury_txns'); });
  await env.DB.exec("DELETE FROM board_state WHERE key = 'finance'");
  assert.equal((await liveNumbers(env)).finance, null);
  assert.equal((await portalApi(MEMBER)).status, 200);
});

// ─── Board meetings from the calendar ───────────────────────────────

const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'board-reader@example.iam.gserviceaccount.com', private_key: SA_PEM });

/** Google, holding `events` on each calendar (by owner email); read-only calls only */
function fakeGoogle(byCalendar) {
  const seen = { reads: [], writes: 0 };
  answer = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'g-token', expires_in: 3600 });
    const m = url.match(/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/]+)\/events\?(.*)$/);
    if (m && (init.method || 'GET') === 'GET') {
      const cal = decodeURIComponent(m[1]);
      seen.reads.push({ cal, q: new URLSearchParams(m[2]).get('q') });
      if (byCalendar[cal] instanceof Error) return Response.json({ error: { message: byCalendar[cal].message } }, { status: 403 });
      return Response.json({ items: byCalendar[cal] || [] });
    }
    seen.writes += 1;
    throw new Error(`unexpected Google call ${init.method} ${url}`);
  };
  env.GOOGLE_CALENDAR_KEY = SERVICE_ACCOUNT;
  clearTokenCache();
  return seen;
}
const ev = (id, summary, start, end, extra = {}) => ({ id, iCalUID: `${id}@google.com`, summary, status: 'confirmed', start: { dateTime: start }, end: { dateTime: end }, htmlLink: `https://www.google.com/calendar/event?eid=${id}`, ...extra });

test('which calendar events are board meetings, and their day, time and place in Atlanta', () => {
  const board = ['a@example.com', 'b@example.com', 'c@example.com'];
  for (const t of ['SOARD Q4 Board Meeting', 'Board Meeting', 'Board of Directors mtg', 'Q4 Board']) assert.equal(isBoardMeetingEvent({ summary: t }), true, t);
  for (const t of ['Advisory Board meeting', 'Board reveal walkthrough', 'Demo day: board tour', 'Board game night', 'Golf committee meeting']) assert.equal(isBoardMeetingEvent({ summary: t }), false, t);
  assert.equal(isBoardMeetingEvent({ summary: 'SOARD board', attendees: board.slice(0, 2).map((email) => ({ email })) }, board), false);
  assert.equal(isBoardMeetingEvent({ summary: 'SOARD board', attendees: board.map((email) => ({ email })) }, board), true, 'three board members invited');
  assert.equal(isBoardMeetingEvent({ summary: 'Board Meeting', status: 'cancelled' }), false);
  assert.deepEqual(eventWhen({ start: { dateTime: '2026-11-19T13:00:00Z' }, end: { dateTime: '2026-11-19T15:00:00Z' } }), { date: '2026-11-19', start: '08:00', end: '10:00' }, 'November is Eastern standard time');
  assert.deepEqual(eventWhen({ start: { dateTime: '2026-08-06T08:00:00-04:00' }, end: { dateTime: '2026-08-06T10:00:00-04:00' } }), { date: '2026-08-06', start: '08:00', end: '10:00' });
  assert.deepEqual(eventWhen({ start: { date: '2026-11-19' }, end: { date: '2026-11-20' } }), { date: '2026-11-19', start: '', end: '' });
  assert.deepEqual(eventPlace({ location: 'Example Design Group, 100 Example St, Roswell, GA 30075' }), { location: 'Example Design Group', address: '100 Example St, Roswell, GA 30075', video: '' });
  assert.deepEqual(eventPlace({ location: '100 Example St, Roswell, GA' }), { location: '', address: '100 Example St, Roswell, GA', video: '' });
  assert.equal(eventPlace({ location: 'https://zoom.us/j/123' }).video, 'https://zoom.us/j/123');
  assert.equal(eventPlace({ hangoutLink: 'https://meet.google.com/abc-defg-hij' }).video, 'https://meet.google.com/abc-defg-hij');
  assert.equal(eventPlace({ description: 'Join: https://teams.microsoft.com/l/meetup-join/xyz.' }).video, 'https://teams.microsoft.com/l/meetup-join/xyz');
  assert.equal(eventPlace({ description: 'Agenda: https://example.com/doc' }).video, '', 'a link that isn’t a call stays out');
});

test('the calendar makes the meetings: added, moved, linked to one added by hand, and marked when gone; never written to', async () => {
  const later = new Date(Date.now() + 30 * 86400000);
  const day = later.toISOString().slice(0, 10);
  const q4 = ev('q4', 'SOARD Q4 Board Meeting', `${day}T13:00:00Z`, `${day}T15:00:00Z`, { location: 'Example Design Group, 100 Example St, Roswell, GA', hangoutLink: 'https://meet.google.com/abc-defg-hij' });
  const past = ev('q3', 'SOARD Q3 Board Meeting', '2026-01-08T13:00:00Z', '2026-01-08T15:00:00Z');
  const advisory = ev('adv', 'Advisory Board meeting', `${day}T22:00:00Z`, `${day}T23:00:00Z`);
  const cal = { [FOUNDER]: [q4, past, advisory] };
  const google = fakeGoogle(cal);
  const first = await syncBoardCalendar(env);
  assert.deepEqual([first.ok, first.found, first.added], [true, 1, 1]);
  assert.deepEqual(google.reads, [{ cal: FOUNDER, q: 'board' }], 'reads the Board area’s admins’ calendars, searching for "board"');
  let [m] = await listMeetings(env.DB);
  assert.deepEqual([m.date, m.start, m.end, m.location, m.address, m.video, m.shared], [day, '08:00', '10:00', 'Example Design Group', '100 Example St, Roswell, GA', 'https://meet.google.com/abc-defg-hij', false]);
  assert.equal(m.calendar.title, 'SOARD Q4 Board Meeting');
  assert.equal(meetingName(m), 'SOARD Q4 Board Meeting', 'the event’s own name, not a quarter worked out from the date');
  assert.ok(m.sections.length > 3, 'starts from the agenda template');
  // The board page never learns whose calendar it came from
  const shared = await saveMeeting(env.DB, { ...m, shared: true }, { by: FOUNDER });
  assert.equal((await portalApi(MEMBER)).body.meetings.find((x) => x.id === m.id).calendar, undefined);

  // Moved on the calendar: the meeting follows, its agenda and sharing kept; a renamed event renames it
  q4.start.dateTime = `${day}T14:00:00Z`; q4.end.dateTime = `${day}T16:00:00Z`;
  q4.summary = 'SOARD Q4 Board Meeting (moved)';
  const second = await syncBoardCalendar(env);
  assert.equal(second.moved, 1);
  m = (await listMeetings(env.DB))[0];
  assert.deepEqual([m.start, m.end, m.shared, m.sections.length, m.title], ['09:00', '11:00', true, shared.sections.length, 'SOARD Q4 Board Meeting (moved)']);
  // A name typed in Board wins over the calendar's from then on
  m = await saveMeeting(env.DB, { ...m, title: 'Fall board meeting' }, { by: FOUNDER });
  q4.summary = 'SOARD Q4 Board Meeting';
  await syncBoardCalendar(env);
  m = (await listMeetings(env.DB))[0];
  assert.equal(m.title, 'Fall board meeting');
  assert.equal((await listMeetings(env.DB)).length, 1, 'never doubled');
  // Nothing changed: nothing saved
  const before = m.updatedAt;
  await syncBoardCalendar(env);
  assert.equal((await listMeetings(env.DB))[0].updatedAt, before);

  // Gone from the calendar: kept, marked gone
  cal[FOUNDER] = [];
  assert.equal((await syncBoardCalendar(env)).gone, 1);
  assert.equal((await listMeetings(env.DB))[0].calendar.gone, true);
  assert.equal(google.writes, 0, 'never writes to a calendar');
});

test('a meeting added by hand on the same day is linked, not doubled; a calendar that can’t be read is reported and nothing is marked gone', async () => {
  const day = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  const hand = (await adminApi(FOUNDER, { action: 'new-meeting', date: day })).body.meeting;
  await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...hand, location: 'Typed by hand' }, base: hand.updatedAt });
  const cal = { [FOUNDER]: [ev('q1', 'Board Meeting', `${day}T13:00:00Z`, `${day}T15:00:00Z`)] };
  fakeGoogle(cal);
  const r = await syncBoardCalendar(env);
  assert.equal(r.linked, 1);
  const all = await listMeetings(env.DB);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].id, all[0].location, all[0].calendar.place], [hand.id, 'Typed by hand', false], 'no place on the event: what was typed stays');
  // Settings names a second admin whose calendar refuses: reported, and the linked meeting isn't marked gone
  await adminApi(FOUNDER, { action: 'save-settings', settings: { admins: [FOUNDER, STAFF] } });
  cal[STAFF] = new Error('Not Found');
  cal[FOUNDER] = [];
  const bad = await syncBoardCalendar(env);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /^pat’s calendar: .*Not Found/);
  assert.equal((await listMeetings(env.DB))[0].calendar.gone, false);
  assert.match(JSON.stringify((await adminApi(FOUNDER)).body.calendar), /pat’s calendar/);
});

test('two looks at once add a new event once', async () => {
  const day = new Date(Date.now() + 50 * 86400000).toISOString().slice(0, 10);
  fakeGoogle({ [FOUNDER]: [ev('q2', 'Board Meeting', `${day}T13:00:00Z`, `${day}T15:00:00Z`)] });
  await Promise.all([syncBoardCalendar(env), syncBoardCalendar(env), syncBoardCalendar(env)]);
  assert.equal((await listMeetings(env.DB)).length, 1);
  assert.equal((await calendarStatus(env.DB)).added, 1);
});

// ─── The rules ──────────────────────────────────────────────────────

test('a meeting is cleaned to its rules; forBoard drops staff notes; the email outline masks confidential items', () => {
  const m = cleanMeeting({
    date: '2026-04-30', start: '08:00', end: '25:00', video: 'javascript:alert(1)', shared: true,
    sections: [{ title: 'Committee reports', items: [{ title: 'Legal', notes: '- a', staffNote: 'private', confidential: true }, { title: 'Golf' }] }],
    attendance: [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board', status: 'present' }, { slug: 'alex-rivera', name: 'Twice' }, { name: '' }],
    files: [{ id: 'f_abc', name: 'x.pdf', staffOnly: true }, { id: 'f_def', name: 'y.pdf' }],
  });
  assert.equal(m.end, '');
  assert.equal(m.video, '');
  assert.equal(m.attendance.length, 1);
  assert.equal(timeRange('08:00', '10:00'), '8:00 to 10:00 AM');
  assert.equal(timeRange('11:00', '13:30'), '11:00 AM to 1:30 PM');
  const b = forBoard(m);
  assert.equal(b.sections[0].items[0].staffNote, undefined);
  assert.deepEqual(b.files.map((f) => f.id), ['f_def']);
  assert.equal(forBoard({ ...m, shared: false }), null);
  assert.deepEqual(emailOutline(m), [{ title: 'Committee reports', items: ['A confidential item (on the board page)', 'Golf'] }]);
  assert.deepEqual(noteBlocks('- One\n  - One a\n- Two\nA line'), [
    { text: 'One', children: [{ text: 'One a', children: [] }] }, { text: 'Two', children: [] }, { text: 'A line', para: true, children: [] },
  ]);
  const fresh = newMeeting({ date: '2026-08-06', board: [{ slug: 'alex-rivera', name: 'Alex Rivera' }] });
  assert.equal(fresh.sections[0].title, 'Call to order');
  assert.equal(fresh.shared, false);
});

const OLD_AGENDA = `1 | P a g e
MEETING Example Board – Agenda DATE 02/12/2026
LOCATION Example Hall TIME 5:30p -
7:00p
ATTENDEE COMPANY ATTENDEE COMPANY
x Alex Rivera Rivera Builders x Jane Doe SOARD
Sam Ortiz Ortiz & Co
x Kim Park Park Media
1. CALL TO ORDER
1. Roll Call
2. Welcome (Jane)
a. Video for new members
2. COMMITTEE REPORTS
1. Financial (Sam/Alex)
a. 2026 Financials
i. Cash is healthy
1. Expenses are down
ii.Budget approved
1. Surplus planned
b. Vehicle
2. Events (Kim & Jane)
a. Golf
b. Gala
c. Auction
d. Sponsors
e. Tables
f. Food
g. Music
h. Lounge
i. Valet
3. Stores (North/South)
3. OPEN FORUM`;

test('an old agenda reads into a meeting: header, who was there, sections, items, presenters, points three deep', () => {
  const people = [
    { slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' }, { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board' },
    { slug: 'kim-park', name: 'Kim Park', kind: 'board' }, { slug: 'jane-doe', name: 'Jane Doe', kind: 'staff' },
  ];
  const r = parseAgendaText(OLD_AGENDA, people);
  assert.deepEqual([r.date, r.start, r.end, r.location], ['2026-02-12', '17:30', '19:00', 'Example Hall']);
  assert.deepEqual(r.attendance.map((a) => `${a.slug}:${a.status}`), ['alex-rivera:present', 'jane-doe:present', 'sam-ortiz:absent', 'kim-park:present']);
  assert.deepEqual(r.sections.map((s) => s.title), ['Call to order', 'Committee reports', 'Open forum']);
  const [call, reports] = r.sections;
  assert.deepEqual(call.items.map((i) => [i.title, i.presenter]), [['Roll Call', ''], ['Welcome', 'Jane']]);
  assert.deepEqual(reports.items.map((i) => [i.title, i.presenter]), [['Financial', 'Sam, Alex'], ['Events', 'Kim & Jane'], ['Stores (North/South)', '']], 'store names aren’t presenters');
  assert.equal(reports.items[0].notes, '- 2026 Financials\n  - Cash is healthy\n    - Expenses are down\n  - Budget approved\n    - Surplus planned\n- Vehicle');
  assert.match(reports.items[1].notes, /- Lounge\n- Valet$/, 'i. after h. is a letter');
  assert.equal(cleanMeeting(r).sections.length, 3);
});
