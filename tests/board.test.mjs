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
import { maybeRefreshInvites, maybeCheckInvites, inviteCheck } from '../functions/api/_board-invite.js';
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
    if (url.startsWith('https://api.resend.com/')) { const b = JSON.parse(init.body); return Response.json(Array.isArray(b) ? { data: b.map((_, i) => ({ id: `em_${i}` })) } : { id: `em_${outside.length}` }); }
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
  assert.match(mail.html, /A board-only item \(on the board page\)/);
  assert.match(mail.html, new RegExp(`/admin/board/#/meetings/${meeting.id}`));

  // With files, one email each (a batch send can't carry them), the board's files attached and never a staff-only one
  const sends = () => outside.filter((c) => c.url === 'https://api.resend.com/emails');
  const test = await adminApi(FOUNDER, { action: 'send-packet', id: meeting.id, test: true });
  assert.equal(test.status, 200);
  assert.equal(test.body.sent, 1);
  assert.deepEqual(sends().map((c) => c.body.to[0]), [FOUNDER]);
  assert.deepEqual(sends()[0].body.attachments.map((a) => a.filename), ['Balance sheet.pdf']);
  assert.match(sends()[0].body.html, /Balance sheet/);
  assert.equal(test.body.meeting.packetSentAt, '', 'a preview isn’t the packet going out');

  outside = [];
  const real = await adminApi(FOUNDER, { action: 'send-packet', id: meeting.id });
  assert.equal(real.body.sent, 2);
  assert.deepEqual(sends().map((c) => c.body.to[0]).sort(), [MEMBER, OTHER_MEMBER]);
  assert.ok(sends().every((c) => c.body.attachments.length === 1 && !JSON.stringify(c.body).includes('Draft numbers')));
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
  const where = (ev) => { const { said, callFrom, ...p } = eventPlace(ev); return p; };
  assert.deepEqual(where({ location: 'Example Design Group, 100 Example St, Roswell, GA 30075' }), { location: 'Example Design Group', address: '100 Example St, Roswell, GA 30075', video: '' });
  assert.deepEqual(where({ location: '100 Example St, Roswell, GA' }), { location: '', address: '100 Example St, Roswell, GA', video: '' });
  assert.deepEqual(where({ location: 'TBD', description: '<p>Please join us at</p><p>Example Hall</p><p>4001 Example Dr. Marietta, GA 30068</p><p>Microsoft Teams</p>' }), { location: 'Example Hall', address: '4001 Example Dr. Marietta, GA 30068', video: '' }, 'TBD: the address in the invite’s notes');
  assert.equal(eventPlace({ location: 'TBD' }).said, 'TBD', 'what the invite says is kept for the admins');
  assert.equal(eventPlace({ location: 'https://zoom.us/j/123' }).video, 'https://zoom.us/j/123');
  assert.equal(eventPlace({ hangoutLink: 'https://meet.google.com/abc-defg-hij' }).video, 'https://meet.google.com/abc-defg-hij');
  assert.equal(eventPlace({ description: 'Join: https://teams.microsoft.com/l/meetup-join/xyz.' }).video, 'https://teams.microsoft.com/l/meetup-join/xyz');
  assert.equal(eventPlace({ description: 'Agenda: https://example.com/doc' }).video, '', 'a link that isn’t a call stays out');
  // Where the call is, so Board knows what switching to Google Meet changes
  assert.deepEqual([
    { hangoutLink: 'https://meet.google.com/abc-defg-hij' },
    { conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://teams.microsoft.com/l/meetup-join/xyz' }] } },
    { location: 'https://zoom.us/j/123' },
    { description: 'Join: https://teams.microsoft.com/meet/123?p=abc' },
    { location: 'Example Hall' },
  ].map((e) => eventPlace(e).callFrom), ['meet', 'conference', 'place', 'notes', '']);
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

test('the same meeting on two admins’ calendars is one meeting: the organizer’s name and times, a video link or place from either; old duplicates merge', async () => {
  const day = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  await adminApi(FOUNDER, { action: 'save-settings', settings: { admins: [FOUNDER, STAFF] } });
  // What production had on Oct 27 2026: each admin's own copy, made into two meetings by the first version
  for (const [from, uid, title] of [[FOUNDER, 'a1', 'SOARD Board Meeting'], [STAFF, 'b2', 'SOARD Board Q3 meeting']]) {
    const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: day })).body.meeting;
    await saveMeeting(env.DB, { ...m, title, calendar: { uid: `${uid}@google.com`, title, from } }, { by: 'the calendar' });
  }
  assert.equal((await listMeetings(env.DB)).length, 2);
  fakeGoogle({
    [FOUNDER]: [ev('a1', 'SOARD Board Meeting', `${day}T13:00:00Z`, `${day}T15:00:00Z`, { location: 'TBD', organizer: { email: FOUNDER, self: true } })],
    [STAFF]: [ev('b2', 'SOARD Board Q3 meeting', `${day}T13:00:00Z`, `${day}T14:55:00Z`, { location: 'TBD', description: 'Join: https://teams.microsoft.com/meet/123?p=abc', organizer: { email: 'someone@example.com' } })],
  });
  const r = await syncBoardCalendar(env);
  assert.deepEqual([r.found, r.merged, r.added], [1, 1, 0]);
  const all = await listMeetings(env.DB);
  assert.equal(all.length, 1, 'one meeting');
  const [m] = all;
  assert.deepEqual([m.title, m.start, m.end, m.location, m.video], ['SOARD Board Meeting', '08:00', '10:00', '', 'https://teams.microsoft.com/meet/123?p=abc'], 'the organizer’s name and times; TBD is no place; the Teams link from the other copy');
  assert.deepEqual([m.calendar.uid, m.calendar.others], ['a1@google.com', ['b2@google.com']]);
  // Next look: still one, nothing to change, and neither copy is "gone"
  const again = await syncBoardCalendar(env);
  assert.deepEqual([again.merged, again.added, again.gone], [0, 0, 0]);
  assert.equal((await listMeetings(env.DB)).length, 1);
  // A copy someone worked on is never deleted
  const day2 = new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10);
  const worked = (await adminApi(FOUNDER, { action: 'new-meeting', date: day2 })).body.meeting;
  await saveMeeting(env.DB, { ...worked, calendar: { uid: 'c3@google.com', title: 'Board Meeting', from: FOUNDER } }, { by: FOUNDER });
  const untouched = (await adminApi(FOUNDER, { action: 'new-meeting', date: day2 })).body.meeting;
  await saveMeeting(env.DB, { ...untouched, calendar: { uid: 'd4@google.com', title: 'Board Meeting', from: STAFF } }, { by: 'the calendar' });
  fakeGoogle({ [FOUNDER]: [ev('c3', 'Board Meeting', `${day2}T13:00:00Z`, `${day2}T15:00:00Z`)], [STAFF]: [ev('d4', 'Board Meeting', `${day2}T13:00:00Z`, `${day2}T15:00:00Z`)] });
  await syncBoardCalendar(env);
  const left = (await listMeetings(env.DB)).filter((x) => x.date === day2).map((x) => x.id);
  assert.deepEqual(left, [worked.id], 'the one a person worked on stays; the untouched copy goes');
});

test('a look made by the first version is redone right away', async () => {
  fakeGoogle({ [FOUNDER]: [] });
  const { maybeSyncBoardCalendar } = await import('../functions/api/_board-calendar.js');
  await env.DB.exec('CREATE TABLE IF NOT EXISTS board_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.prepare("INSERT OR REPLACE INTO board_state (key, data) VALUES ('calendar', ?)").bind(JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), found: 2 })).run();
  assert.ok(await maybeSyncBoardCalendar(env), 'no version 2 in the last look: look now');
  assert.equal(await maybeSyncBoardCalendar(env), null, 'then hourly');
});

test('two looks at once add a new event once', async () => {
  const day = new Date(Date.now() + 50 * 86400000).toISOString().slice(0, 10);
  fakeGoogle({ [FOUNDER]: [ev('q2', 'Board Meeting', `${day}T13:00:00Z`, `${day}T15:00:00Z`)] });
  await Promise.all([syncBoardCalendar(env), syncBoardCalendar(env), syncBoardCalendar(env)]);
  assert.equal((await listMeetings(env.DB)).length, 1);
  assert.equal((await calendarStatus(env.DB)).added, 1);
});

// ─── The invite: from the president's calendar, with Google Meet ────

/**
 * Google Calendar and Meet that keep what Board writes (events on each calendar, by id), and refuse what Google refuses.
 * `meetScope: false` is Google Admin not allowing transcripts yet, `meetApi: false` the Meet REST API turned off,
 * `keeps: false` a Workspace plan that takes the setting and leaves transcripts off, `pending` a Meet Google is still making.
 */
function fakeGoogleWriter({ meetScope = true, meetApi = true, keeps = true, pending = false, events = {} } = {}) {
  const g = { events, calls: [], transcript: {}, meetScope, meetApi, keeps, pending };
  answer = async (url, init) => {
    const method = init.method || 'GET';
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(String(init.body)).get('assertion').split('.')[1], 'base64url').toString());
      if (/meetings\.space/.test(claims.scope) && !g.meetScope) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' }, { status: 401 });
      return Response.json({ access_token: `t-${claims.sub}`, expires_in: 3600 });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    g.calls.push({ method, url, body });
    const meet = url.match(/^https:\/\/meet\.googleapis\.com\/v2\/spaces\/([^?]+)/);
    if (meet && !g.meetApi) return Response.json({ error: { message: 'Google Meet REST API has not been used in project example-project before or it is disabled.' } }, { status: 403 });
    const config = (code) => ({ artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: g.transcript[code] || 'OFF' } } });
    if (meet && method === 'GET') return Response.json({ name: `spaces/${meet[1].replace(/-space$/, '')}-space`, meetingCode: meet[1], config: config(meet[1]) });
    if (meet && method === 'PATCH' && g.notAvailable) return Response.json({ error: { code: 403, message: 'updateAutoTranscriptionGeneration is not available to the user.', status: 'PERMISSION_DENIED' } }, { status: 403 });
    if (meet && method === 'PATCH') { if (g.keeps) g.transcript[meet[1]] = body.config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration; return Response.json({ name: `spaces/${meet[1]}`, config: config(meet[1]) }); }
    const m = url.match(/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/?]+)\/events(?:\/([^?]+))?(?:\?.*)?$/);
    if (!m) throw new Error(`unexpected Google call ${method} ${url}`);
    const list = (g.events[decodeURIComponent(m[1])] ||= []);
    const id = m[2] && decodeURIComponent(m[2]);
    const made = { hangoutLink: 'https://meet.google.com/abc-defg-hij', conferenceData: { conferenceId: 'abc-defg-hij' } };
    const withMeet = (e) => (body?.conferenceData?.createRequest && !e.hangoutLink ? { ...e, ...made } : e);
    // Google refuses an event that ends when (or before) it starts: an all-day one ends the next day
    const span = body && (body.start || body.end) ? [body.start?.date || body.start?.dateTime, body.end?.date || body.end?.dateTime] : null;
    if (span && (method === 'POST' || method === 'PATCH') && !(String(span[1]) > String(span[0]))) return Response.json({ error: { message: 'The specified time range is empty.' } }, { status: 400 });
    if (!id && method === 'GET') return Response.json({ items: list });
    if (!id && method === 'POST' && g.pending && body.conferenceData?.createRequest) {
      const e = { status: 'confirmed', organizer: { email: decodeURIComponent(m[1]), self: true }, ...body, conferenceData: { createRequest: { status: { statusCode: 'pending' } } } };
      list.push({ ...e, ...made });
      return Response.json(e);
    }
    if (!id && method === 'POST') { const e = withMeet({ status: 'confirmed', iCalUID: `${body.id}@google.com`, organizer: { email: decodeURIComponent(m[1]), self: true }, ...body }); list.push(e); return Response.json(e); }
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return Response.json({ error: { message: 'Not Found' } }, { status: 404 });
    if (method === 'GET') return Response.json(list[i]);
    if (method === 'PATCH') { list[i] = withMeet({ ...list[i], ...body }); return Response.json(list[i]); }
    if (method === 'DELETE') { list[i] = { ...list[i], status: 'cancelled' }; return new Response(null, { status: 204 }); }
    throw new Error(`unexpected Google call ${method} ${url}`);
  };
  env.GOOGLE_CALENDAR_KEY = SERVICE_ACCOUNT;
  clearTokenCache();
  return g;
}
const calWrites = (g) => g.calls.filter((c) => c.url.includes('/calendar/v3/') && c.method !== 'GET');
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('Send the invite: from the president’s calendar to every board member, with Google Meet and transcripts on; a place added later updates it', async () => {
  const g = fakeGoogleWriter();
  const day = inDays(40);
  let m = (await adminApi(FOUNDER, { action: 'new-meeting', date: day })).body.meeting;
  m = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m, start: '18:00', end: '20:00' }, base: m.updatedAt })).body.meeting;
  const r = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [post] = calWrites(g);
  assert.equal(post.method, 'POST');
  assert.ok(post.url.startsWith(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(FOUNDER)}/events?`), 'on the president’s own calendar (Settings → Invites come from)');
  assert.match(post.url, /conferenceDataVersion=1&sendUpdates=all$/, 'Google emails the invitations');
  assert.deepEqual(post.body.attendees.map((a) => a.email).sort(), [MEMBER, OTHER_MEMBER].sort(), 'every active board member with an email; the organizer hosts it');
  assert.equal(post.body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.deepEqual(post.body.start, { dateTime: `${day}T18:00:00`, timeZone: 'America/New_York' });
  assert.equal(post.body.location, undefined, 'no place yet, none on the invite');
  assert.match(post.body.description, /sunshineonaranneyday\.com\/board/);
  assert.deepEqual(g.transcript, { 'abc-defg-hij-space': 'ON' }, 'transcripts on for its Meet');
  m = r.body.meeting;
  assert.deepEqual([m.invite.organizer, m.invite.meet, m.video, m.invite.transcript, m.invite.guests], [FOUNDER, 'https://meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hij', 'on', 2]);

  // The place, typed in later (two saves, a word at a time): once it has stood two minutes the invite follows it,
  // one update for Google to email the guests; Meet and transcripts are left as they are
  g.calls = [];
  const typing = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m, location: 'Example' }, base: m.updatedAt })).body.meeting;
  const after = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...typing, location: 'Example Hall', address: '100 Example St, Roswell, GA' }, base: typing.updatedAt })).body.meeting;
  assert.deepEqual(await maybeRefreshInvites(env), [], 'not while it’s being typed');
  assert.equal(calWrites(g).length, 0);
  assert.deepEqual(await maybeRefreshInvites(env, { now: Date.now() + 2 * 60 * 1000 + 1000 }), [m.id]);
  const [patch, ...more] = calWrites(g);
  assert.equal(more.length, 0, 'one update, not one per save');
  assert.equal(patch.method, 'PATCH');
  assert.match(patch.url, /\/events\/board[0-9a-f]+\?conferenceDataVersion=1&sendUpdates=all$/);
  assert.equal(patch.body.location, 'Example Hall, 100 Example St, Roswell, GA');
  assert.equal(patch.body.conferenceData, undefined, 'its Meet stays');
  assert.ok(!g.calls.some((c) => c.url.includes('meet.googleapis.com')), 'transcripts are already on');
  const now = await getMeeting(env.DB, m.id);
  assert.equal(now.invite.place, 'Example Hall, 100 Example St, Roswell, GA');
  assert.equal(now.location, 'Example Hall', 'what was typed stays');
  // Saved again with nothing new: nothing sent
  g.calls = [];
  await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...now, title: 'Fall board meeting' }, base: now.updatedAt });
  await maybeRefreshInvites(env, { now: Date.now() + 10 * 60 * 1000 });
  assert.equal(calWrites(g).length, 0);
  assert.equal(after.location, 'Example Hall');

  // The board's replies come back from the calendar onto the meeting; it isn't brought in as a second meeting
  g.events[FOUNDER][0].attendees = g.events[FOUNDER][0].attendees.map((a) => (a.email === MEMBER ? { ...a, responseStatus: 'accepted' } : a));
  await syncBoardCalendar(env);
  const all = await listMeetings(env.DB);
  assert.equal(all.length, 1);
  assert.equal(all[0].calendar, null, 'Board’s own invite, not one from the calendar');
  assert.deepEqual(all[0].invite.replies, { 'alex-rivera': 'accepted', 'sam-ortiz': 'invited' });
  await saveMeeting(env.DB, { ...all[0], shared: true }, { by: FOUNDER });
  const mine = (await portalApi(MEMBER)).body;
  const seen = mine.meetings.find((x) => x.id === m.id);
  assert.deepEqual([seen.myInvite, seen.onCalendar, seen.video], ['accepted', true, 'https://meet.google.com/abc-defg-hij']);
  assert.deepEqual(seen.invite, { meet: 'https://meet.google.com/abc-defg-hij' }, 'the board page sees the Meet link and nothing else of the invite');
  assert.deepEqual([mine.contact?.email, mine.admins], [FOUNDER, ['Jane Doe']], 'questions go to whoever the invites come from');
});

test('a meeting from the organizer’s calendar: that invite gets the missing board members, Google Meet and a TBD place filled in, never a second invite', async () => {
  const day = inDays(50);
  const theirs = ev('hol1', 'SOARD Q4 Board Meeting', `${day}T22:00:00Z`, `${day}T23:30:00Z`, {
    location: 'TBD', description: 'Dinner provided', organizer: { email: FOUNDER, self: true }, attendees: [{ email: MEMBER, responseStatus: 'accepted' }],
  });
  const g = fakeGoogleWriter({ events: { [FOUNDER]: [theirs] } });
  await syncBoardCalendar(env);
  let [m] = await listMeetings(env.DB);
  assert.deepEqual([m.calendar.eventId, m.calendar.organizer], ['hol1', FOUNDER]);
  m = await saveMeeting(env.DB, { ...m, location: 'Example Hall', address: '100 Example St, Roswell, GA' }, { by: FOUNDER });
  g.calls = [];
  const r = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const writes = calWrites(g);
  assert.deepEqual(writes.map((c) => c.method), ['PATCH'], 'the same event');
  assert.match(writes[0].url, /\/events\/hol1\?conferenceDataVersion=1&sendUpdates=all$/);
  const body = writes[0].body;
  assert.deepEqual(body.attendees, [{ email: MEMBER, responseStatus: 'accepted' }, { email: OTHER_MEMBER }], 'who was invited stays, with their answer');
  assert.equal(body.location, 'Example Hall, 100 Example St, Roswell, GA', 'a TBD place is filled in');
  assert.ok(body.conferenceData.createRequest);
  assert.equal(body.summary, undefined); assert.equal(body.start, undefined, 'the calendar keeps its own name, day and time');
  assert.equal(body.description, undefined, 'and its own notes');
  // Looked at again: still the calendar's meeting, followed as before, never marked gone
  await syncBoardCalendar(env);
  [m] = await listMeetings(env.DB);
  assert.deepEqual([m.calendar.gone, m.invite.eventId, m.video], [false, 'hol1', 'https://meet.google.com/abc-defg-hij']);

  // An event someone else organized is theirs to change
  const other = ev('x9', 'Board Meeting', `${inDays(60)}T22:00:00Z`, `${inDays(60)}T23:00:00Z`, { organizer: { email: 'someone@example.com' }, attendees: [{ email: MEMBER }, { email: OTHER_MEMBER }] });
  g.events[FOUNDER].push(other);
  await syncBoardCalendar(env);
  const theirsOnly = (await listMeetings(env.DB)).find((x) => x.calendar?.eventId === 'x9');
  const no = await adminApi(FOUNDER, { action: 'send-invite', id: theirsOnly.id });
  assert.equal(no.status, 409);
  assert.match(no.body.error, /someone@example\.com/);
});

test('Board’s invite, then the meeting turns up on the organizer’s own calendar: one invite, theirs', async () => {
  const day = inDays(45);
  const g = fakeGoogleWriter();
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: day })).body.meeting;
  await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  const ownId = (await getMeeting(env.DB, m.id)).invite.eventId;
  g.events[FOUNDER].push(ev('hol2', 'Board Meeting', `${day}T13:00:00Z`, `${day}T15:00:00Z`, { organizer: { email: FOUNDER, self: true }, attendees: [{ email: MEMBER }, { email: OTHER_MEMBER }, { email: 'kim@example.com' }] }));
  await syncBoardCalendar(env);
  assert.equal((await listMeetings(env.DB)).length, 1, 'linked, not doubled');
  g.calls = [];
  const r = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calWrites(g).map((c) => `${c.method} ${c.url.match(/events\/(\w+)/)[1]}`), [`DELETE ${ownId}`, 'PATCH hol2']);
  assert.match(calWrites(g)[0].url, /sendUpdates=all/, 'Google tells the guests the duplicate is off');
  assert.equal(r.body.meeting.invite.eventId, 'hol2');
});

test('transcripts need Google Admin’s say-so: the invite still goes with Meet, and Board says what to allow', async () => {
  fakeGoogleWriter({ meetScope: false });
  env.GOOGLE_CALENDAR_KEY = JSON.stringify({ ...JSON.parse(SERVICE_ACCOUNT), client_id: '1234567890', project_id: 'example-project' });
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: inDays(30) })).body.meeting;
  const r = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.meeting.invite.meet, r.body.meeting.invite.transcript], ['https://meet.google.com/abc-defg-hij', 'needs-setup']);
  assert.match(r.body.meeting.invite.error, /meetings\.space\.settings/);
  const g = (await adminApi(FOUNDER)).body.google;
  assert.deepEqual([g.clientId, g.project], ['1234567890', 'example-project'], 'the setup card names the client ID and the project');
  // No calendar key: says so (as a 500 with its words: Cloudflare swaps some 5xx pages for its own), sends nothing
  delete env.GOOGLE_CALENDAR_KEY;
  const none = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  assert.deepEqual([none.status, none.body.error], [500, 'Google Calendar isn’t set up (GOOGLE_CALENDAR_KEY)']);
});

test('the check proves Calendar, Meet and transcripts without inviting anyone, then stays quiet', async () => {
  const g = fakeGoogleWriter();
  const st = await maybeCheckInvites(env);
  assert.deepEqual([st.ok, st.calendar, st.meet, st.transcript, st.error, st.leftover], [true, 'ok', 'ok', 'on', '', '']);
  const writes = calWrites(g);
  assert.deepEqual(writes.map((c) => c.method), ['POST', 'DELETE'], 'made, then deleted');
  const [post, del] = writes;
  assert.ok(post.url.startsWith(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(FOUNDER)}/events?`), 'on the organizer’s calendar');
  assert.match(post.url, /sendUpdates=none$/, 'Google emails nobody');
  assert.match(del.url, /sendUpdates=none$/);
  assert.equal(post.body.attendees, undefined, 'no guests');
  assert.deepEqual([post.body.visibility, post.body.transparency, post.body.reminders], ['private', 'transparent', { useDefault: false, overrides: [] }]);
  assert.equal(post.body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.deepEqual(g.transcript, { 'abc-defg-hij-space': 'ON' }, 'transcripts turned on for its Meet, and read back');
  assert.equal(g.events[FOUNDER].find((e) => e.id === post.body.id).status, 'cancelled', 'gone from the calendar');
  // Passed: never again, an hour later or a day later
  g.calls = [];
  await maybeCheckInvites(env, { now: Date.now() + 2 * 60 * 60 * 1000 });
  await maybeCheckInvites(env, { now: Date.now() + 26 * 60 * 60 * 1000 });
  assert.equal(g.calls.length, 0);
  // What the admin and Site → Automations see: no email address
  const shown = (await adminApi(FOUNDER)).body.google.check;
  assert.deepEqual([shown.ok, shown.transcript, shown.organizer, shown.leftover], [true, 'on', undefined, false]);
  assert.ok(!JSON.stringify(await inviteCheck(env.DB)).includes('@'));
  // An invite from now on: the board page link in its notes, its Meet's transcripts on
  const m0 = (await adminApi(FOUNDER, { action: 'new-meeting', date: inDays(20) })).body.meeting;
  const m = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m0, start: '', end: '' }, base: m0.updatedAt })).body.meeting;
  const r = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  assert.deepEqual([r.status, r.body.meeting.invite.transcript], [200, 'on']);
  const allDay = calWrites(g).find((c) => c.method === 'POST' && c.body.attendees);
  assert.deepEqual([allDay.body.start, allDay.body.end], [{ date: inDays(20) }, { date: inDays(21) }], 'an all-day meeting ends the next day, as Google needs');
});

test('Google Admin allows transcripts after invites went out: the check passes within the hour and turns them on, with no email', async () => {
  const g = fakeGoogleWriter({ meetScope: false });
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: inDays(25) })).body.meeting;
  assert.equal((await adminApi(FOUNDER, { action: 'send-invite', id: m.id })).body.meeting.invite.transcript, 'needs-setup');
  g.calls = [];
  let st = await maybeCheckInvites(env);
  assert.deepEqual([st.ok, st.calendar, st.meet, st.transcript], [false, 'ok', 'ok', 'needs-setup']);
  assert.match(st.error, /meetings\.space\.settings/);
  assert.deepEqual(calWrites(g).map((c) => c.method), ['POST', 'DELETE'], 'the check’s event is deleted even when it fails');
  const card = (await adminApi(FOUNDER)).body.google.check;
  assert.deepEqual([card.ok, card.transcript], [false, 'needs-setup'], 'so Board → Meetings shows the steps');
  // Peter allows it in Google Admin. Not looked at again within the hour; then it passes and the invite already out gets its transcript
  g.meetScope = true;
  clearTokenCache();
  g.calls = [];
  await maybeCheckInvites(env, { now: Date.now() + 30 * 60 * 1000 });
  assert.equal(g.calls.length, 0, 'at most hourly');
  st = await maybeCheckInvites(env, { now: Date.now() + 61 * 60 * 1000 });
  assert.deepEqual([st.ok, st.transcript], [true, 'on']);
  assert.equal((await getMeeting(env.DB, m.id)).invite.transcript, 'on');
  assert.ok(!g.calls.some((c) => c.url.includes('/calendar/v3/') && c.url.includes('sendUpdates=all')), 'the board gets no email for it');
  // The Meet REST API turned off: needs setup too, in Google's words
  fakeGoogleWriter({ meetApi: false });
  await env.DB.prepare('DELETE FROM board_state WHERE key = ?').bind('invite-check').run();
  st = await maybeCheckInvites(env);
  assert.deepEqual([st.ok, st.transcript], [false, 'needs-setup']);
  assert.match(st.error, /Meet REST API has not been used/);
});

test('a Workspace plan without transcripts: the check says so in plain words, and invites still go with Meet', async () => {
  const g = fakeGoogleWriter({ keeps: false });
  const st = await maybeCheckInvites(env);
  assert.deepEqual([st.ok, st.meet, st.transcript], [false, 'ok', 'error']);
  assert.match(st.error, /left transcripts off.*plan may not include them/);
  // What production answered (Oct 28 2026): the account can't have them, in words Peter can act on
  g.notAvailable = true;
  // No setting fixes that: looked at again a day later, not every hour
  g.calls = [];
  await maybeCheckInvites(env, { now: Date.now() + 3 * 60 * 60 * 1000 });
  assert.equal(g.calls.length, 0, 'not hourly');
  let later = await maybeCheckInvites(env, { now: Date.now() + 25 * 60 * 60 * 1000 });
  assert.deepEqual([later.ok, later.transcript], [false, 'error']);
  assert.match(later.error, /transcripts aren’t available on the organizer’s account.*Business Standard.*Meet video settings/);
  // Opening Board tries again sooner (at most every ten minutes), so a change in Google shows on the next open
  g.notAvailable = false;
  g.keeps = true;
  g.calls = [];
  assert.equal((await maybeCheckInvites(env, { now: Date.now() + 25 * 60 * 60 * 1000 + 5 * 60 * 1000, retryMs: 10 * 60 * 1000 })).ok, false, 'not within ten minutes');
  assert.equal(g.calls.length, 0);
  later = await maybeCheckInvites(env, { now: Date.now() + 25 * 60 * 60 * 1000 + 11 * 60 * 1000, retryMs: 10 * 60 * 1000 });
  assert.equal(later.ok, true, 'a new plan shows when Board is opened');
  g.keeps = false;
  g.transcript = {}; // the fake gives every event the same Meet
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: inDays(22) })).body.meeting;
  const r = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  assert.deepEqual([r.body.meeting.invite.meet, r.body.meeting.invite.transcript], ['https://meet.google.com/abc-defg-hij', 'error']);
});

test('a Meet Google is still making: Board asks again for its link before turning transcripts on', async () => {
  const g = fakeGoogleWriter({ pending: true });
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: inDays(23) })).body.meeting;
  const r = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  assert.deepEqual([r.body.meeting.invite.meet, r.body.meeting.invite.transcript], ['https://meet.google.com/abc-defg-hij', 'on']);
  assert.ok(g.calls.some((c) => c.method === 'GET' && /\/events\/board[0-9a-f]+$/.test(c.url)), 'asked again');
});

test('Holly’s invite with a Teams link as its place: Google Meet becomes the call, and the place is the place', async () => {
  const day = inDays(55);
  const theirs = ev('hol3', 'Board Meeting', `${day}T22:00:00Z`, `${day}T23:30:00Z`, {
    location: 'https://teams.microsoft.com/l/meetup-join/xyz', organizer: { email: FOUNDER, self: true }, attendees: [{ email: MEMBER }],
  });
  const g = fakeGoogleWriter({ events: { [FOUNDER]: [theirs] } });
  await syncBoardCalendar(env);
  let [m] = await listMeetings(env.DB);
  assert.deepEqual([m.video, m.calendar.callFrom], ['https://teams.microsoft.com/l/meetup-join/xyz', 'place']);
  g.calls = [];
  let r = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  let [patch] = calWrites(g);
  assert.equal(patch.body.location, '', 'no place yet: the Teams link comes off the place');
  assert.ok(patch.body.conferenceData.createRequest);
  assert.equal(r.body.meeting.video, 'https://meet.google.com/abc-defg-hij');
  // With a place typed in, on an event that still has Teams as its place (sent before this fix): the place goes on
  g.events[FOUNDER][0] = { ...g.events[FOUNDER][0], location: 'https://zoom.us/j/1', hangoutLink: undefined, conferenceData: undefined };
  m = await saveMeeting(env.DB, { ...r.body.meeting, location: 'Example Hall' }, { by: FOUNDER });
  g.calls = [];
  r = await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  [patch] = calWrites(g);
  assert.equal(patch.body.location, 'Example Hall');
  // A map link as the place is a place, not a call: it stays
  g.events[FOUNDER][0] = { ...g.events[FOUNDER][0], location: 'https://maps.app.goo.gl/example', hangoutLink: undefined, conferenceData: undefined };
  g.calls = [];
  await adminApi(FOUNDER, { action: 'send-invite', id: m.id });
  [patch] = calWrites(g);
  assert.equal(patch.body.location, undefined);
});

// ─── Board mail: past agendas, minutes and QuickBooks reports ───────

const { unzip, docxText, dateIn, fileKind, attachmentsOf, readBoardMail, mailLog, MAIL_QUERIES } = await import('../functions/api/_board-mail.js');
const { deflateRawSync } = await import('node:zlib');

/** A real ZIP (a .docx is one) of { name: text } */
function zip(files) {
  const enc = new TextEncoder();
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name); const raw = enc.encode(text); const data = deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
const wp = (text, numId = null, ilvl = 0) => `<w:p>${numId ? `<w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (t) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
/** An agenda the way Holly's Word file holds it: Word numbers the lists itself, so no "1." is in the text */
function agendaDocx(date = '04/30/2026') {
  const lvls = ['decimal', 'decimal', 'lowerLetter', 'lowerRoman', 'decimal'].map((f, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${f}"/></w:lvl>`).join('');
  const numbering = `<w:numbering><w:abstractNum w:abstractNumId="0">${lvls}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const body = [
    `<w:tbl><w:tr>${cell('MEETING')}${cell('Example Board – Agenda')}${cell('DATE')}${cell(date)}</w:tr><w:tr>${cell('LOCATION')}${cell('Example Hall')}${cell('TIME')}${cell('8:00a - 10:00a')}</w:tr></w:tbl>`,
    `<w:tbl><w:tr>${cell('x')}${cell('Alex Rivera')}${cell('Rivera Builders')}</w:tr><w:tr>${cell('')}${cell('Kim Park')}${cell('Park Media')}</w:tr></w:tbl>`,
    wp('CALL TO ORDER', 1, 0), wp('Roll Call', 1, 1), wp('Welcome (Jane)', 1, 1), wp('Video for new members', 1, 2),
    wp('COMMITTEE REPORTS', 1, 0), wp('Financial (Sam/Alex)', 1, 1), wp('2026 Financials', 1, 2), wp('Cash is healthy', 1, 3), wp('Expenses are down', 1, 4), wp('Budget approved', 1, 3),
    wp('OPEN FORUM', 1, 0),
  ].join('');
  return zip({ 'word/document.xml': `<w:document><w:body>${body}</w:body></w:document>`, 'word/numbering.xml': numbering, '[Content_Types].xml': '<Types/>' });
}

test('a Word agenda reads the way it prints: its list numbers back, table rows as lines, then the agenda rules', async () => {
  const text = await docxText(agendaDocx());
  assert.deepEqual(text.split('\n'), [
    'MEETING Example Board – Agenda DATE 04/30/2026', 'LOCATION Example Hall TIME 8:00a - 10:00a', 'x Alex Rivera Rivera Builders', 'Kim Park Park Media',
    '1. CALL TO ORDER', '1. Roll Call', '2. Welcome (Jane)', 'a. Video for new members',
    '2. COMMITTEE REPORTS', '1. Financial (Sam/Alex)', 'a. 2026 Financials', 'i. Cash is healthy', '1. Expenses are down', 'ii. Budget approved', '3. OPEN FORUM',
  ]);
  const people = [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' }, { slug: 'kim-park', name: 'Kim Park', kind: 'board' }, { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board' }, { slug: 'jane-doe', name: 'Jane Doe', kind: 'staff' }];
  const parsed = parseAgendaText(text, people);
  assert.deepEqual([parsed.date, parsed.start, parsed.location], ['2026-04-30', '08:00', 'Example Hall']);
  assert.deepEqual(parsed.attendance.map((a) => `${a.slug}:${a.status}`), ['alex-rivera:present', 'kim-park:absent']);
  assert.equal(parsed.sections[1].items[0].notes, '- 2026 Financials\n  - Cash is healthy\n    - Expenses are down\n  - Budget approved');
  assert.deepEqual(Object.keys(await unzip(agendaDocx(), ['word/numbering.xml'])), ['word/numbering.xml']);
});

test('dates in subjects and file names, and what each attachment is', () => {
  for (const [t, want] of [['Board Agenda 4.30.26.docx', '2026-04-30'], ['SOARD Board – 04/30/2026', '2026-04-30'], ['Minutes April 30, 2026', '2026-04-30'], ['Agenda Nov 5', '2026-11-05'], ['2026-08-06 minutes.pdf', '2026-08-06'], ['Q4 financials v2.3.pdf', '']]) {
    assert.equal(dateIn(t, 2026), want, t);
  }
  assert.equal(fileKind('Board Agenda 4.30.26.docx'), 'agenda');
  assert.equal(fileKind('Q3 Minutes.pdf'), 'agenda');
  assert.equal(fileKind('Profit and Loss.pdf'), 'financials');
  assert.equal(fileKind('Balance Sheet Sept.xlsx'), 'financials');
  assert.equal(fileKind('Gala deck.pptx'), 'other');
  assert.equal(fileKind('notes.pdf', 'Board agenda for Thursday'), 'agenda', 'the subject names a lone document');
  const parts = { parts: [
    { filename: 'image001.png', mimeType: 'image/png', body: { attachmentId: 'i1', size: 900 }, headers: [{ name: 'Content-Disposition', value: 'inline' }] },
    { filename: 'Agenda.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: { attachmentId: 'a1', size: 9000 } },
    { mimeType: 'multipart/alternative', parts: [{ filename: 'Logo.pdf', mimeType: 'application/pdf', body: { attachmentId: 'l1', size: 5 }, headers: [{ name: 'Content-Disposition', value: 'inline; filename=Logo.pdf' }] }] },
  ] };
  assert.deepEqual(attachmentsOf(parts).map((a) => a.name), ['Agenda.docx'], 'pictures and inline files in a signature stay out');
});

/** Gmail holding messages per inbox: { [admin]: [{ id, msgid, subject, from, date, files: [{ name, type, bytes }] }] } */
function fakeGmail(inboxes, { scope = true, pdfText = '' } = {}) {
  const calls = { lists: [], gets: 0, writes: 0 };
  const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
  const byToken = {};
  answer = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const assertion = new URLSearchParams(String(init.body)).get('assertion');
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
      if (claims.scope.includes('gmail') && !scope) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' }, { status: 401 });
      const token = `tok-${claims.sub}-${claims.scope.includes('gmail') ? 'mail' : 'cal'}`;
      byToken[token] = claims.sub;
      return Response.json({ access_token: token, expires_in: 3600 });
    }
    const who = byToken[String(init.headers?.Authorization || '').replace('Bearer ', '')];
    const box = inboxes[who] || [];
    const u = new URL(url);
    if ((init.method || 'GET') !== 'GET') { calls.writes += 1; throw new Error(`unexpected ${init.method} ${url}`); }
    if (u.pathname === '/gmail/v1/users/me/messages') { calls.lists.push({ who, q: u.searchParams.get('q') }); return Response.json({ messages: box.filter((m) => (m.quickbooks ? /quickbooks/.test(u.searchParams.get('q')) : /board/.test(u.searchParams.get('q')))).map((m) => ({ id: m.id })) }); }
    const att = u.pathname.match(/\/messages\/([^/]+)\/attachments\/(.+)$/);
    if (att) { const m = box.find((x) => x.id === att[1]); return Response.json({ data: b64url(m.files[Number(att[2])].bytes) }); }
    const get = u.pathname.match(/\/messages\/([^/]+)$/);
    if (get) {
      calls.gets += 1;
      const m = box.find((x) => x.id === get[1]);
      return Response.json({ id: m.id, internalDate: String(Date.parse(m.date)), payload: { headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }, { name: 'Message-ID', value: m.msgid }],
        parts: m.files.map((f, i) => ({ filename: f.name, mimeType: f.type, body: { attachmentId: String(i), size: f.bytes.length } })) } });
    }
    if (url.startsWith('https://www.googleapis.com/calendar/')) return Response.json({ items: [] });
    throw new Error(`unexpected Google call ${url}`);
  };
  env.GOOGLE_CALENDAR_KEY = JSON.stringify({ ...JSON.parse(SERVICE_ACCOUNT), client_id: '1234567890' });
  env.AI = { toMarkdown: async (doc) => ({ name: doc.name, format: 'text', data: pdfText }) };
  clearTokenCache();
  return calls;
}
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('board mail, before Google Admin allows it: Board names the client ID and the scope to add', async () => {
  fakeGmail({}, { scope: false });
  const r = await readBoardMail(env);
  assert.deepEqual([r.ok, r.needsScope, r.clientId], [false, true, '1234567890']);
  assert.match((await adminApi(FOUNDER)).body.mail.clientId, /^1234567890$/);
});

test('board mail: a past agenda becomes its meeting; an upcoming one fills the agenda nobody has written; never twice, never over notes', async () => {
  const soon = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const upcoming = (await adminApi(FOUNDER, { action: 'new-meeting', date: soon })).body.meeting;
  const [m, d, y] = [soon.slice(5, 7), soon.slice(8, 10), soon.slice(0, 4)];
  const inboxes = {
    [FOUNDER]: [
      { id: 'g1', msgid: '<a1@mail>', subject: 'SOARD Board agenda and minutes', from: 'Holly <holly@example.org>', date: '2026-05-01T12:00:00Z', files: [{ name: 'Board Agenda 4.30.26.docx', type: DOCX, bytes: agendaDocx() }] },
      { id: 'g2', msgid: '<a2@mail>', subject: `Board agenda for ${m}/${d}/${y}`, from: 'Holly <holly@example.org>', date: new Date().toISOString(), files: [{ name: 'Agenda.pdf', type: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 fake') }, { name: 'Balance Sheet.pdf', type: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 numbers') }] },
    ],
  };
  const calls = fakeGmail(inboxes, { pdfText: OLD_AGENDA.replace('DATE 02/12/2026', `DATE ${m}/${d}/${y}`) });
  const r = await readBoardMail(env);
  assert.equal(r.ok, true);
  assert.deepEqual(MAIL_QUERIES.map((q) => calls.lists.some((l) => l.q === q)), [true, true], 'both searches run');
  const all = await listMeetings(env.DB);
  const past = all.find((x) => x.date === '2026-04-30');
  assert.ok(past, 'the April agenda became its meeting');
  assert.equal(past.minutes, 'approved');
  assert.deepEqual(past.files.map((f) => [f.name, f.kind]), [['Board Agenda 4.30.26.docx', 'agenda']]);
  const next = all.find((x) => x.id === upcoming.id);
  assert.deepEqual(next.sections.map((s) => s.title), ['Call to order', 'Committee reports', 'Open forum'], 'the template agenda is replaced by the real one');
  assert.deepEqual(next.files.map((f) => f.kind).sort(), ['agenda', 'financials']);
  assert.equal(calls.writes, 0, 'never sends, deletes or labels');
  // Nothing new: nothing read again
  const gets = calls.gets;
  await readBoardMail(env);
  assert.equal(calls.gets, gets);
  // The same email in Holly's inbox: read once
  await adminApi(FOUNDER, { action: 'save-settings', settings: { admins: [FOUNDER, STAFF] } });
  inboxes[STAFF] = [{ ...inboxes[FOUNDER][1], id: 'h9' }];
  await readBoardMail(env);
  assert.equal((await listMeetings(env.DB)).find((x) => x.id === upcoming.id).files.length, 2, 'no copies');
  // A newer agenda for a meeting someone has written in: kept as a file, the notes left alone
  const written = await saveMeeting(env.DB, { ...next, sections: next.sections.map((s, i) => (i ? s : { ...s, items: s.items.map((it, j) => (j ? it : { ...it, notes: '- typed in the meeting' })) })) }, { by: FOUNDER });
  inboxes[FOUNDER].push({ id: 'g3', msgid: '<a3@mail>', subject: `Board agenda v2 ${m}/${d}/${y}`, from: 'Holly', date: new Date().toISOString(), files: [{ name: 'Agenda v2.pdf', type: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 v2') }] });
  await readBoardMail(env);
  const after = (await listMeetings(env.DB)).find((x) => x.id === upcoming.id);
  assert.equal(after.sections[0].items[0].notes, '- typed in the meeting');
  assert.ok(after.files.some((f) => f.name === 'Agenda v2.pdf'));
  assert.ok((await mailLog(env.DB)).some((r2) => /already written/.test(r2.result)));
  assert.ok(written);
});

test('board mail: a QuickBooks report waits for its meeting, then is filed on it as financials', async () => {
  const inboxes = { [FOUNDER]: [{ id: 'q1', msgid: '<qb@intuit>', quickbooks: true, subject: 'Report: Profit and Loss', from: 'QuickBooks <quickbooks@notification.intuit.com>', date: new Date().toISOString(), files: [{ name: 'Profit and Loss.pdf', type: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 p&l') }] }] };
  fakeGmail(inboxes);
  await readBoardMail(env);
  assert.match((await mailLog(env.DB))[0].result, /^waiting for a meeting/);
  const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: soon })).body.meeting;
  await readBoardMail(env, { now: Date.now() + 25 * 3600 * 1000 });
  assert.deepEqual((await getMeeting(env.DB, m.id)).files.map((f) => [f.name, f.kind]), [['Profit and Loss.pdf', 'financials']]);
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
  assert.deepEqual(emailOutline(m), [{ title: 'Committee reports', items: ['A board-only item (on the board page)', 'Golf'] }]);
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
