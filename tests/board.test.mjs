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
import { packetEmail, meetingIcs, cashNow, getMeeting, listMeetings, maybeRunBoard, cashHistory, provideBoardFinance, liveNumbers, saveMeeting, patchMeeting } from '../functions/api/_board.js';
import { isBoardMeetingEvent, eventWhen, eventPlace, syncBoardCalendar, calendarStatus } from '../functions/api/_board-calendar.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { maybeRefreshInvites, maybeCheckInvites, inviteCheck, withNotes } from '../functions/api/_board-invite.js';
import * as rsvpPage from '../functions/api/board-rsvp.js';
import { answerLink } from '../functions/api/_board-rsvp.js';
import { generateKeyPairSync } from 'node:crypto';
import { parseAgendaText, cleanMeeting, forBoard, newMeeting, openActions, quarterOf, meetingName, noteBlocks, emailOutline, timeRange, liveLines, shortDate, agendaIsDraft, docHtmlText, readAgain, AGENDA_READER, deckOf, stopIndex, liveOfStop, guessItem, presentersOf, draftAgenda, itemFiles, looseFiles, liveOfTitle, sectionPlan, sectionOf, sectionClock, clockText } from '../public/admin/board-shared.js';

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

test('the documents email is the link: the documents by name, nothing attached, no notes or board-only titles; Send it to me goes only to you', async () => {
  const { meeting } = await sharedMeetingWithFiles();
  const mail = packetEmail(await getMeeting(env.DB, meeting.id), { files: ['Balance sheet.pdf'] });
  assert.doesNotMatch(mail.html, /Insurance is looking|Ask counsel|Legal update/);
  assert.match(mail.html, new RegExp(`/admin/board/#/meetings/${meeting.id}`));
  assert.match(mail.html, /Open the agenda and documents/);

  // One batch, each member's own email; the board's documents named, never a staff-only one, and nothing attached
  const sends = () => outside.filter((c) => c.url === 'https://api.resend.com/emails/batch').flatMap((c) => c.body);
  const test = await adminApi(FOUNDER, { action: 'send-packet', id: meeting.id, test: true });
  assert.equal(test.status, 200);
  assert.equal(test.body.sent, 1);
  assert.deepEqual(sends().map((c) => c.to[0]), [FOUNDER]);
  assert.equal(sends()[0].attachments, undefined, 'nothing attached: it all stays on the board page');
  assert.match(sends()[0].html, /Balance sheet/);
  assert.doesNotMatch(sends()[0].html, /Draft numbers/);
  assert.equal(test.body.meeting.packetSentAt, '', 'a preview isn’t the packet going out');

  outside = [];
  const real = await adminApi(FOUNDER, { action: 'send-packet', id: meeting.id });
  assert.equal(real.body.sent, 2);
  assert.deepEqual(sends().map((c) => c.to[0]).sort(), [MEMBER, OTHER_MEMBER]);
  assert.ok(sends().every((c) => !c.attachments && !JSON.stringify(c).includes('Draft numbers')));
  assert.ok(real.body.meeting.packetSentAt);
  assert.equal(real.body.meeting.packetSentTo, 2);
});

test('documents go with agenda items: the board sees only theirs, on the page and on the screen; a draft agenda doesn’t carry them', async () => {
  const { meeting, shown, hidden } = await sharedMeetingWithFiles();
  const m = await getMeeting(env.DB, meeting.id);
  const fin = m.sections.flatMap((s) => s.items).find((it) => it.live === 'cash');
  const sections = m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === fin.id ? { ...it, docs: [shown.id, hidden.id, 'f_gone1'], who: ['sam-ortiz', 'sam-ortiz', 'Not A Slug!'] } : it)) }));
  const saved = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m, sections }, base: m.updatedAt })).body.meeting;
  const item = saved.sections.flatMap((s) => s.items).find((it) => it.id === fin.id);
  assert.deepEqual(item.docs, [shown.id, hidden.id, 'f_gone1'], 'kept as written (a file deleted later just drops off)');
  assert.deepEqual(item.who, ['sam-ortiz'], 'People slugs, each once');
  assert.deepEqual(itemFiles(saved, item).map((f) => f.id), [shown.id, hidden.id], 'only files the meeting has');

  // The board page: the item's documents are the board's only
  const page = (await portalApi(MEMBER)).body.meetings.find((x) => x.id === meeting.id);
  assert.deepEqual(page.sections.flatMap((s) => s.items).find((it) => it.id === fin.id).docs, [shown.id]);
  // The screen (the live view): the same, with the board's files and never a staff-only one
  const live = await call(MEMBER, `/api/board-portal?live=${meeting.id}`, { handler: portal.onRequestGet });
  assert.equal(live.status, 200);
  assert.deepEqual(live.body.sections.flatMap((s) => s.items).find((it) => it.id === fin.id).docs, [shown.id]);
  assert.deepEqual(live.body.files.map((f) => f.id), [shown.id]);
  assert.doesNotMatch(JSON.stringify(live.body), /Draft numbers|Ask counsel/);
  assert.deepEqual(live.body.live, { startedAt: '', endedAt: '', itemId: '', fileId: '', page: 0, part: 0, screen: '', sectionId: '', sectionAt: '', floor: '' });

  // The next agenda drafted from this one keeps who presents, never this meeting's files
  const draft = draftAgenda(saved).flatMap((s) => s.items).find((it) => it.title === fin.title);
  assert.deepEqual(draft.who, ['sam-ortiz']);
  assert.deepEqual(draft.docs, []);
});

test('the screen’s stops: the cover, since we last met, each part’s card, each item then every page of its documents, the files on no item, the close', () => {
  const m = cleanMeeting({
    id: 'm_deck0001', date: '2026-11-05',
    sections: [
      { id: 's_one1', title: 'Approve meeting minutes', items: [{ id: 'i_min1', title: 'Minutes of the last meeting', live: 'minutes', about: 'm_prev0001' }] },
      { id: 's_two2', title: 'Committee reports', items: [{ id: 'i_fin1', title: 'Financial', live: 'cash', docs: ['f_sfp1', 'f_bud1'] }, { id: 'i_gov1', title: 'Governance' }] },
      { id: 's_thr3', title: 'Open forum', items: [] },
    ],
    files: [
      { id: 'f_sfp1', name: 'Statement of Financial Position.xlsx', kind: 'financials' }, { id: 'f_bud1', name: 'Budget vs Actual.pdf', kind: 'financials' },
      { id: 'f_rep1', name: 'Executive report.pdf', kind: 'packet' }, { id: 'f_sig1', name: 'Signed.pdf', kind: 'signed' },
    ],
  });
  const prev = { id: 'm_prev0001', files: [{ id: 'f_old1', name: 'Q3 minutes.docx', kind: 'minutes' }, { id: 'f_old2', name: 'Q3 minutes.pdf', type: 'application/pdf', kind: 'minutes' }] };
  const deck = deckOf(m, { pages: { f_bud1: 3 }, meetings: [prev] });
  assert.deepEqual(deck.map((s) => s.key), [
    'cover', 'since', 'i_min1', 'i_min1:f_old2:0', 'section:s_two2', 'i_fin1', 'i_fin1:f_sfp1:0', 'i_fin1:f_bud1:0', 'i_fin1:f_bud1:1', 'i_fin1:f_bud1:2', 'i_gov1', 'section:s_thr3', 'i_more', 'i_more:f_rep1:0', 'end',
  ], 'a part of one item goes straight to it, one with none still has its card; the last meeting’s minutes as the PDF; the signed copy never');
  assert.ok(!deckOf({ ...m, sections: m.sections.slice(1) }).some((s) => s.kind === 'since'), 'since we last met only when the agenda approves the last minutes');
  assert.deepEqual(looseFiles(m).map((f) => f.id), ['f_rep1']);
  // Where the chair is, from the live state, and back
  assert.equal(stopIndex(deck, {}), 0);
  assert.equal(stopIndex(deck, { itemId: 'i_fin1', fileId: 'f_bud1', page: 2 }), 9);
  assert.equal(stopIndex(deck, { itemId: 'i_fin1', fileId: 'f_sfp1', page: 4 }), 6, 'a page past what’s known: that document’s last known page');
  assert.equal(stopIndex(deck, { screen: 'end' }), deck.length - 1);
  assert.equal(stopIndex(deck, { screen: 'since' }), 1);
  assert.equal(stopIndex(deck, cleanLive({ screen: 'section', sectionId: 's_thr3' })), 11);
  assert.deepEqual(liveOfStop(deck[8]), { itemId: 'i_fin1', fileId: 'f_bud1', page: 1, part: 0, screen: '', sectionId: '' });
  assert.deepEqual(liveOfStop(deck[4]), { itemId: '', fileId: '', page: 0, part: 0, screen: 'section', sectionId: 's_two2' });
  assert.deepEqual(cleanMeeting({ live: { itemId: 'i_fin1', fileId: 'f_bud1', page: 1.7, screen: 'end' } }).live, { startedAt: '', endedAt: '', itemId: 'i_fin1', fileId: 'f_bud1', page: 1, part: 0, screen: 'end', sectionId: '', vote: null, sectionAt: '', floor: '' });
  // A tall page in two halves (./board/docs.js partsOf): its top, then its bottom, each a stop the live state names
  const halves = deckOf(m, { pages: { f_bud1: 3 }, parts: { f_bud1: [1, 2, 1] }, meetings: [prev] });
  assert.deepEqual(halves.filter((x) => x.fileId === 'f_bud1').map((x) => `${x.page}${x.part ? ' bottom' : ''}`), ['0', '1', '1 bottom', '2']);
  const bottom = halves.findIndex((x) => x.fileId === 'f_bud1' && x.part === 1);
  assert.equal(stopIndex(halves, liveOfStop(halves[bottom])), bottom);
  assert.equal(stopIndex(halves, liveOfStop(halves[bottom - 1])), bottom - 1, 'the top half is the page’s first stop');
  assert.equal(stopIndex(deck, { itemId: 'i_fin1', fileId: 'f_bud1', page: 1, part: 1 }), 8, 'a bottom half this deck hasn’t split yet: that page');
  assert.equal(cleanLive({ itemId: 'i_fin1', fileId: 'f_bud1', page: 1, part: 1 }).part, 1);
  assert.equal(cleanLive({ itemId: 'i_fin1', part: 1 }).part, 0, 'a half only of a document');
  assert.deepEqual(cleanMeeting({ live: { fileId: 'f_bud1', page: 3 } }).live.fileId, '', 'a document is on the screen only with its item');

  // A new file's item: the money item for statements, "approve the minutes" for minutes before the meeting, else a shared word
  assert.equal(guessItem(m, { name: 'Q3 Balance Sheet.xlsx' }, '2026-10-01'), 'i_fin1');
  assert.equal(guessItem(m, { name: 'Q3 minutes.pdf' }, '2026-10-01'), 'i_min1');
  assert.equal(guessItem(m, { name: 'Governance memo.pdf' }, '2026-10-01'), 'i_gov1');
  assert.equal(guessItem(m, { name: 'Photos.png' }, '2026-10-01'), '');

  // Who presents: the people picked, else the names as written matched where only one person fits
  const people = [{ slug: 'tom-a', name: 'Thomas Able' }, { slug: 'holly-r', name: 'Holly Ranney' }, { slug: 'holly-b', name: 'Holly Baker' }];
  assert.deepEqual(presentersOf({ presenter: 'Thomas & Holly' }, people), [people[0], { name: 'Holly' }]);
  assert.deepEqual(presentersOf({ presenter: 'old text', who: ['holly-b'] }, people), [people[2]]);
});

test('one-tap answers: each board member who hasn’t answered gets their own links; opening one only asks, pressing it answers', async () => {
  const { meeting } = await sharedMeetingWithFiles();
  // Sam already said on the board page; Alex hasn't
  assert.equal((await portalApi(OTHER_MEMBER, { action: 'rsvp', meetingId: meeting.id, answer: 'no' })).status, 200);
  const sends = () => outside.filter((c) => c.url === 'https://api.resend.com/emails/batch').flatMap((c) => c.body);
  const r = await adminApi(FOUNDER, { action: 'send-packet', id: meeting.id });
  assert.equal(r.body.sent, 2);
  const to = (addr) => sends().find((c) => c.to[0] === addr);
  const alex = to(MEMBER);
  assert.match(alex.html, /Alex, the agenda and 1 document for the .+ are on the board page/);
  const links = [...alex.html.matchAll(/\/api\/board-rsvp\?t=([0-9a-f]{32})&amp;a=(yes|remote|no)/g)];
  assert.deepEqual(links.map((x) => x[2]), ['yes', 'remote', 'no']);
  assert.equal(new Set(links.map((x) => x[1])).size, 1, 'one token, Alex’s own');
  assert.match(alex.text, /I’ll be there: https:\/\/sunshineonaranneyday\.com\/api\/board-rsvp\?t=/);
  assert.doesNotMatch(to(OTHER_MEMBER).html, /board-rsvp|Will you be there/, 'Sam already answered: not asked again');
  assert.match(to(OTHER_MEMBER).html, /Sam, the agenda/);
  const tok = links[0][1];
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM board_rsvp_links WHERE hash = ?').bind(tok).first()).n, 0, 'D1 keeps only the hash');

  // Opening the link (a mail scanner does) changes nothing
  const opened = await rsvpPage.onRequestGet({ request: new Request(`https://sunshineonaranneyday.com/api/board-rsvp?t=${tok}&a=remote`), env });
  const page = await opened.text();
  assert.equal(opened.status, 200);
  assert.match(page, /Alex, will you be at the /);
  assert.match(page, /<button type="submit" name="a" value="remote" class="primary">I’ll join by video<\/button>/, 'the one tapped is the yellow one');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM board_rsvps WHERE slug = ?').bind('alex-rivera').first()).n, 0);
  // Pressing it answers, the same as on the board page
  const press = (t, a) => rsvpPage.onRequestPost({ request: new Request('https://sunshineonaranneyday.com/api/board-rsvp', { method: 'POST', body: new URLSearchParams({ t, a }) }), env });
  const done = await press(tok, 'remote');
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Thanks, Alex.*joining the .* by video/s);
  assert.equal((await getMeeting(env.DB, meeting.id)).attendance.find((p) => p.slug === 'alex-rivera').rsvp, 'remote');
  // Changed their mind from the same link
  await press(tok, 'yes');
  assert.equal((await getMeeting(env.DB, meeting.id)).attendance.find((p) => p.slug === 'alex-rivera').rsvp, 'yes');
  assert.match(await (await rsvpPage.onRequestGet({ request: new Request(`https://x/api/board-rsvp?t=${tok}`), env })).text(), /You said: Coming\./);

  // A made-up token, a bad answer, or a meeting off the board page: nothing recorded
  assert.equal((await press('0'.repeat(32), 'yes')).status, 404);
  assert.equal((await press(tok, 'maybe')).status, 404);
  await saveMeeting(env.DB, { ...(await getMeeting(env.DB, meeting.id)), shared: false }, { by: FOUNDER });
  assert.equal((await press(tok, 'no')).status, 404);
  assert.equal((await getMeeting(env.DB, meeting.id)).attendance.find((p) => p.slug === 'alex-rivera').rsvp, 'yes');
  // Two days after the meeting, the link has run out
  await saveMeeting(env.DB, { ...(await getMeeting(env.DB, meeting.id)), shared: true }, { by: FOUNDER });
  assert.equal((await answerLink(env, tok)).member.slug, 'alex-rivera');
  assert.deepEqual(await answerLink(env, tok, { now: Date.parse('2026-11-21T17:00:00Z') }), { expired: true });

  // The reminder: only who hasn't answered, each by name with their own links; a preview's buttons open the board page
  outside = [];
  await env.DB.prepare('DELETE FROM board_rsvps').run();
  const remind = await adminApi(FOUNDER, { action: 'remind-rsvp', id: meeting.id });
  assert.equal(remind.body.sent, 2);
  const batch = outside.find((c) => c.url === 'https://api.resend.com/emails/batch').body;
  assert.deepEqual(batch.map((e) => e.to[0]).sort(), [MEMBER, OTHER_MEMBER].sort());
  const toAlex = batch.find((e) => e.to[0] === MEMBER);
  assert.match(toAlex.subject, /^Will you be at the .*\? Nov 19, 2026$/);
  assert.match(toAlex.html, /Alex, will you be at the/);
  assert.equal([...toAlex.html.matchAll(/board-rsvp\?t=/g)].length, 3);
  outside = [];
  await adminApi(FOUNDER, { action: 'remind-rsvp', id: meeting.id, test: true });
  const preview = outside.find((c) => c.url.startsWith('https://api.resend.com/')).body;
  const one = Array.isArray(preview) ? preview[0] : preview;
  assert.equal(one.to[0], FOUNDER);
  assert.doesNotMatch(one.html, /board-rsvp/, 'a preview has no one’s answer links');
  assert.match(one.html, new RegExp(`/admin/board/#/meetings/${meeting.id}`));
});

test('the minutes notice says which meeting and when the board votes on them', async () => {
  const { meeting } = await sharedMeetingWithFiles();
  await adminApi(FOUNDER, { action: 'new-meeting', date: '2027-01-14' });
  outside = [];
  const r = await adminApi(FOUNDER, { action: 'send-minutes', id: meeting.id });
  assert.equal(r.body.sent, 2);
  const mail = outside.find((c) => c.url.startsWith('https://api.resend.com/')).body[0];
  assert.match(mail.subject, /^Draft minutes: .*, Nov 19, 2026$/);
  assert.match(mail.html, /The board votes on them at the next meeting\./);
  assert.match(mail.html, /Next meeting<\/td>\s*<td[^>]*>Thursday, January 14, 2027/);
  assert.doesNotMatch(mail.html, /Insurance is looking|Call the venue/, 'the minutes themselves stay on the board page');
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

test('every meeting is named by its quarter: the one its invite says, else its date; a name typed in Board wins', () => {
  const named = (date, invite, title = invite) => meetingName(cleanMeeting({ date, title, calendar: invite ? { uid: 'x@google.com', title: invite } : null }));
  assert.equal(named('2026-02-12', 'SOARD Staff end of Board Meeting'), 'Q1 2026 Board Meeting');
  assert.equal(named('2023-07-20', 'Board Meeting'), 'Q3 2023 Board Meeting');
  assert.equal(named('2026-11-05', 'SOARD Board Meeting'), 'Q4 2026 Board Meeting');
  assert.equal(named('2026-04-30', 'Q2 SOARD Board Meeting'), 'Q2 2026 Board Meeting');
  assert.equal(named('2026-08-06', ''), 'Q3 2026 Board Meeting', 'no invite: its date');
  assert.equal(named('2022-11-03', 'Q3 SOARD Board Meeting (Reschedule)'), 'Q3 2022 Board Meeting', 'held late: the quarter it was for');
  assert.equal(named('2025-01-09', 'Q4 SOARD Board Meeting'), 'Q4 2024 Board Meeting', 'a Q4 meeting in January is the year before’s');
  assert.equal(named('2025-12-11', 'Q1 SOARD Board Meeting'), 'Q1 2026 Board Meeting', 'an early Q1 in December is next year’s');
  assert.equal(named('2026-11-05', 'SOARD Board Meeting', 'Annual Meeting'), 'Annual Meeting', 'typed in Board');
  assert.equal(named('2026-11-05', '', 'Annual Meeting'), 'Annual Meeting');
  // The board page gets the name, not the invite
  const shown = forBoard(cleanMeeting({ date: '2022-11-03', shared: true, title: 'Q3 SOARD Board Meeting (Reschedule)', calendar: { uid: 'x@google.com', title: 'Q3 SOARD Board Meeting (Reschedule)' } }));
  assert.deepEqual([shown.title, shown.calendar, meetingName(shown)], ['Q3 2022 Board Meeting', undefined, 'Q3 2022 Board Meeting']);
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
  assert.deepEqual([first.ok, first.found, first.past, first.added], [true, 1, 1, 2]);
  assert.deepEqual(google.reads, [{ cal: FOUNDER, q: 'board' }], 'reads the Board area’s admins’ calendars, searching for "board"');
  let [m, before] = await listMeetings(env.DB);
  // A past meeting is a record of when it was: no agenda, attendance list or invite until its email brings them
  assert.deepEqual([before.date, before.start, before.title, before.sections.length, before.attendance.length, before.actions.length, before.shared], ['2026-01-08', '08:00', '', 0, 0, 0, false]);
  assert.equal(meetingName(before), 'Q3 2025 Board Meeting', 'the quarter the event says, held late');
  assert.deepEqual([m.date, m.start, m.end, m.location, m.address, m.video, m.shared], [day, '08:00', '10:00', 'Example Design Group', '100 Example St, Roswell, GA', 'https://meet.google.com/abc-defg-hij', false]);
  assert.equal(m.calendar.title, 'SOARD Q4 Board Meeting');
  assert.equal(m.title, '', 'the event’s own words aren’t its name');
  assert.ok(m.sections.length > 3, 'starts from the agenda template');
  // The board page never learns whose calendar it came from
  const shared = await saveMeeting(env.DB, { ...m, shared: true }, { by: FOUNDER });
  assert.equal((await portalApi(MEMBER)).body.meetings.find((x) => x.id === m.id).calendar, undefined);

  // Moved on the calendar: the meeting follows, its agenda and sharing kept; a renamed event doesn't rename it
  q4.start.dateTime = `${day}T14:00:00Z`; q4.end.dateTime = `${day}T16:00:00Z`;
  q4.summary = 'SOARD Q4 Board Meeting (moved)';
  const second = await syncBoardCalendar(env);
  assert.equal(second.moved, 1);
  m = (await listMeetings(env.DB))[0];
  assert.deepEqual([m.start, m.end, m.shared, m.sections.length, m.title, m.calendar.title], ['09:00', '11:00', true, shared.sections.length, '', 'SOARD Q4 Board Meeting (moved)']);
  // A name typed in Board wins over the calendar's from then on
  m = await saveMeeting(env.DB, { ...m, title: 'Fall board meeting' }, { by: FOUNDER });
  q4.summary = 'SOARD Q4 Board Meeting';
  await syncBoardCalendar(env);
  m = (await listMeetings(env.DB))[0];
  assert.equal(m.title, 'Fall board meeting');
  assert.equal((await listMeetings(env.DB)).length, 2, 'never doubled');
  // Nothing changed: nothing saved
  const was = (await listMeetings(env.DB)).map((x) => x.updatedAt);
  await syncBoardCalendar(env);
  assert.deepEqual((await listMeetings(env.DB)).map((x) => x.updatedAt), was);

  // Gone from the calendar: kept, marked gone (a past meeting never is)
  cal[FOUNDER] = [];
  assert.equal((await syncBoardCalendar(env)).gone, 1);
  assert.deepEqual((await listMeetings(env.DB)).map((x) => x.calendar.gone), [true, false]);
  assert.equal(google.writes, 0, 'never writes to a calendar');
});

test('coffees, reminders and other organizations’ boards aren’t board meetings', () => {
  const board = ['a@example.com', 'b@example.com', 'c@example.com'];
  for (const t of ['SOARD Board Meeting', 'Q2 SOARD Board Meeting', 'Q4 SOARD Board Meeting', 'SOARD Staff end of Board Meeting', 'Q3 SOARD Board Meeting (Reschedule)', 'Annual Board Meeting', 'Sunshine on a Ranney Day Board Meeting']) {
    assert.equal(isBoardMeetingEvent({ summary: t }), true, t);
  }
  for (const t of ['Pat Sample- Coffee (Potential SOARD Board)', 'Coffee- SOARD with Kim Example (Example Windows) TBD on board members', 'get Sam all docs for board meeting', 'Send board packet',
    'Example Rotary Full Board Meeting', 'Example, Inc. - Board Meeting', 'Example School Board meeting', 'Board Wine Night', 'Q1 SOARD Board Meeting Prep']) {
    assert.equal(isBoardMeetingEvent({ summary: t }), false, t);
  }
  const invited = { attendees: board.map((email) => ({ email: email.toUpperCase() })) };
  assert.equal(isBoardMeetingEvent({ summary: 'Example Rotary Board Meeting', ...invited }, board), true, 'another name, but SOARD’s board is invited');
  assert.equal(isBoardMeetingEvent({ summary: 'Board coffee', ...invited }, board), false, 'a coffee stays a coffee');
});

test('meetings older rules brought in from coffees and reminders come off the board page, their files onto the meeting they were near; sharing one again keeps it', async () => {
  const { putFile } = await import('../functions/api/_board.js');
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const pdf = new TextEncoder().encode('%PDF-1.4\n%fake\n');
  // What older rules brought in: a coffee three days from the Q4 meeting (shared: its email went to the board), and a reminder far from any
  const coffee = await saveMeeting(env.DB, cleanMeeting({ date: day(63), title: 'Pat Sample- Coffee (Potential SOARD Board)', shared: true, calendar: { uid: 'coffee@google.com', title: 'Pat Sample- Coffee (Potential SOARD Board)', from: FOUNDER } }), { by: 'the calendar' });
  await putFile(env, { ownerType: 'meeting', ownerId: coffee.id, file: new File([pdf], '2026 Operational Budget.pdf', { type: 'application/pdf' }), kind: 'financials', by: 'board email' });
  const todo = await saveMeeting(env.DB, cleanMeeting({ date: day(120), shared: true, calendar: { uid: 'todo@google.com', title: 'get Sam all docs for board meeting', from: FOUNDER } }), { by: 'the calendar' });
  const cal = { [FOUNDER]: [
    ev('q4', 'Q4 SOARD Board Meeting', `${day(60)}T13:00:00Z`, `${day(60)}T15:00:00Z`),
    ev('coffee', 'Pat Sample- Coffee (Potential SOARD Board)', `${day(63)}T13:00:00Z`, `${day(63)}T14:00:00Z`),
    ev('todo', 'get Sam all docs for board meeting', `${day(120)}T13:00:00Z`, `${day(120)}T13:30:00Z`),
    ev('other', 'Example Rotary Full Board Meeting', `${day(30)}T22:00:00Z`, `${day(30)}T23:00:00Z`),
  ] };
  const google = fakeGoogle(cal);
  const r = await syncBoardCalendar(env);
  assert.deepEqual([r.ok, r.notBoard, r.added], [true, 2, 1], 'only the Q4 meeting is added; the two older ones are marked');
  const all = await listMeetings(env.DB);
  const q4 = all.find((m) => m.calendar?.uid === 'q4@google.com');
  const was = all.find((m) => m.id === coffee.id);
  assert.deepEqual([was.notBoard, was.shared, was.files.length], [true, false, 0], 'kept, marked and unshared, never deleted');
  assert.deepEqual(q4.files.map((f) => f.name), ['2026 Operational Budget.pdf'], 'its file moved to the board meeting three days away');
  assert.deepEqual([all.find((m) => m.id === todo.id).notBoard, all.find((m) => m.id === todo.id).shared], [true, false]);
  assert.equal(all.some((m) => /Rotary/.test(m.calendar?.title || '')), false, 'another organization’s board never comes in');
  assert.equal((await portalApi(MEMBER)).body.meetings.some((m) => m.id === coffee.id || m.id === todo.id), false);
  // Someone shares it again: theirs to keep, never marked again
  await saveMeeting(env.DB, { ...all.find((m) => m.id === todo.id), shared: true }, { by: FOUNDER });
  const again = await syncBoardCalendar(env);
  assert.equal(again.notBoard, 0);
  assert.equal((await listMeetings(env.DB)).find((m) => m.id === todo.id).shared, true);
  assert.equal(google.writes, 0);
});

test('files on meetings that aren’t board meetings go to the board meeting within 60 days (the next one for packet papers); else their email waits; once, and again when a meeting is added', async () => {
  const { putFile } = await import('../functions/api/_board.js');
  const { rehomeStranded, homeFor } = await import('../functions/api/_board-calendar.js');
  const { boardOnly, mailLog } = await import('../functions/api/_board-mail.js');
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const pdf = new TextEncoder().encode('%PDF-1.4\n%fake\n');
  const put = (m, name, kind, staffOnly = false) => putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([pdf], name, { type: 'application/pdf' }), kind, staffOnly, by: 'board email' });
  const meet = (date, extra = {}) => saveMeeting(env.DB, cleanMeeting({ date, ...extra }), { by: 'the calendar' });
  const earlier = await meet(day(80), { title: 'Q2 SOARD Board Meeting' });
  const later = await meet(day(40), { title: 'Q3 SOARD Board Meeting' });
  await put(earlier, 'Minutes.pdf', 'minutes');
  // Another organization's board, ten days after one board meeting and thirty before the next
  const redt = await meet(day(70), { title: 'Example Rotary Full Board Meeting', notBoard: true });
  await put(redt, 'SOARD 2025 Budget.pdf', 'financials', true);
  await put(redt, 'Gala Attendees.pdf', 'other');
  // A coffee whose file is a copy of one the board meeting already has
  const coffee = await meet(day(82), { title: 'Pat Sample- Coffee (Potential SOARD Board)', notBoard: true });
  await put(coffee, 'Minutes (1).pdf', 'minutes');
  // Far from any board meeting: its email waits again
  const far = await meet(day(300), { title: 'Example, Inc. - Board Meeting', notBoard: true });
  await put(far, 'Committee Agenda.pdf', 'agenda');
  await mailLog(env.DB); // (board mail's table)
  await env.DB.prepare("INSERT INTO board_mail (id, admin, subject, meeting_id, result, outcome, at, sent_at) VALUES ('a:m1', 'a', 'Committee agenda', ?, 'filed on it', 'filed', ?, ?)").bind(far.id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z').run();

  const r = await rehomeStranded(env);
  assert.deepEqual([r.moved, r.waiting, r.same], [2, 1, 1]);
  const by = async (id) => (await listMeetings(env.DB)).find((m) => m.id === id);
  assert.deepEqual((await by(later.id)).files.map((f) => [f.name, f.staffOnly]), [['SOARD 2025 Budget.pdf', true]], 'the budget goes with the next meeting, staff-only as it was');
  assert.deepEqual((await by(earlier.id)).files.map((f) => f.name).sort(), ['Gala Attendees.pdf', 'Minutes.pdf'], 'anything else, the nearest meeting');
  assert.deepEqual((await by(coffee.id)).files.map((f) => f.name), ['Minutes (1).pdf'], 'a copy of a file it has already stays put, never deleted');
  assert.deepEqual((await by(far.id)).files.map((f) => f.name), ['Committee Agenda.pdf'], 'nothing that near: the file stays');
  const waited = (await mailLog(env.DB, 5, { outcome: 'waiting' }))[0];
  assert.match(waited?.result || '', /waiting for a board meeting near it: Committee Agenda\.pdf .*isn’t a SOARD board meeting/, 'and its email waits for a meeting again');

  // Once: nothing moves twice, the email isn't touched again
  const at = (await env.DB.prepare("SELECT at FROM board_mail WHERE id = 'a:m1'").first()).at;
  assert.deepEqual(await rehomeStranded(env), { moved: 0, waiting: 1, same: 0 });
  assert.equal((await env.DB.prepare("SELECT at FROM board_mail WHERE id = 'a:m1'").first()).at, at);
  // A board meeting added near it since: then it goes there
  await new Promise((res) => setTimeout(res, 5));
  const added = await meet(day(290), { title: 'Q1 SOARD Board Meeting' });
  assert.equal((await rehomeStranded(env)).moved, 1);
  assert.deepEqual((await by(added.id)).files.map((f) => f.name), ['Committee Agenda.pdf']);

  // Board mail never files onto one (nor onto a practice meeting)
  assert.deepEqual(boardOnly([{ id: 'a' }, { id: 'b', notBoard: true }, { id: 'c', practice: true }]).map((m) => m.id), ['a']);
  // The rule on its own: 60 days at most; packet papers to the next; a tie to the later one
  const real = [{ id: 'x', date: '2026-01-10', files: [] }, { id: 'y', date: '2026-02-09', files: [] }];
  assert.equal(homeFor(real, '2026-01-25', { name: 'notes.pdf', kind: 'other' })?.id, 'y', 'a tie: the one after');
  assert.equal(homeFor(real, '2026-01-12', { name: 'Budget.pdf', kind: 'other' })?.id, 'y', 'a budget: the next meeting, though one is nearer');
  assert.equal(homeFor(real, '2026-01-12', { name: 'notes.pdf', kind: 'other' })?.id, 'x');
  assert.equal(homeFor(real, '2026-06-01', { name: 'notes.pdf', kind: 'other' }), null, 'over 60 days: none');
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
  assert.deepEqual([m.calendar.title, m.start, m.end, m.location, m.video], ['SOARD Board Meeting', '08:00', '10:00', '', 'https://teams.microsoft.com/meet/123?p=abc'], 'the organizer’s event and times; TBD is no place; the Teams link from the other copy');
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
 * `keeps: false` a Workspace plan that takes the setting and leaves transcripts off, `pending` a Meet Google is still making,
 * `readScope: false` Google Admin not allowing attendance yet; `records` the conference records of each space, with their participants.
 */
function fakeGoogleWriter({ meetScope = true, meetApi = true, keeps = true, pending = false, readScope = true, events = {}, records = {} } = {}) {
  const g = { events, calls: [], transcript: {}, meetScope, meetApi, keeps, pending, readScope, records };
  answer = async (url, init) => {
    const method = init.method || 'GET';
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(String(init.body)).get('assertion').split('.')[1], 'base64url').toString());
      if (/meetings\.space\.readonly/.test(claims.scope) && !g.readScope) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' }, { status: 401 });
      if (/meetings\.space\.settings/.test(claims.scope) && !g.meetScope) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' }, { status: 401 });
      return Response.json({ access_token: `t-${claims.sub}`, expires_in: 3600 });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    g.calls.push({ method, url, body });
    const recs = url.match(/^https:\/\/meet\.googleapis\.com\/v2\/conferenceRecords\?filter=([^&]+)/);
    if (recs) {
      const space = decodeURIComponent(recs[1]).match(/space\.name="([^"]+)"/)[1];
      return Response.json({ conferenceRecords: (g.records[space] || []).map(({ participants, ...r }) => r) });
    }
    const parts = url.match(/^https:\/\/meet\.googleapis\.com\/v2\/(conferenceRecords\/[^/]+)\/participants/);
    if (parts) return Response.json({ participants: Object.values(g.records).flat().find((r) => r.name === parts[1])?.participants || [] });
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
  assert.ok(post.body.description.startsWith(`The agenda and documents: https://sunshineonaranneyday.com/admin/board/#/meetings/${m.id}\n`), 'the way to this meeting’s page');
  assert.doesNotMatch(post.body.description, /AGENDA|Roll call/, 'the link, not the agenda: the board page has it');
  assert.doesNotMatch(post.body.description, /<[a-z]/i, 'plain text: Apple Calendar and Outlook would show HTML as tags');
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
  assert.ok(body.description.startsWith(`Dinner provided\n\nThe agenda and documents: https://sunshineonaranneyday.com/admin/board/#/meetings/${m.id}\n`), 'its own notes stay, Board’s follow them');
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

test('the invite’s notes are the link to the board page: the agenda changing never touches the invite; a new place still emails; the organizer’s own notes stay', async () => {
  const g = fakeGoogleWriter();
  let m = (await adminApi(FOUNDER, { action: 'new-meeting', date: inDays(35) })).body.meeting;
  m = (await adminApi(FOUNDER, { action: 'send-invite', id: m.id })).body.meeting;
  const sections = [...m.sections, { title: 'Strategic plan', items: [{ title: 'Draft goals', presenter: 'Alex Rivera' }, { title: 'Legal', confidential: true }] }];
  g.calls = [];
  m = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m, sections }, base: m.updatedAt })).body.meeting;
  assert.deepEqual(await maybeRefreshInvites(env, { now: Date.now() + 3 * 60 * 1000 }), [], 'the agenda isn’t in the invite: nothing to update');
  assert.equal(calWrites(g).length, 0);
  // A new place: Google emails the update, and the notes are still only the way to the page
  const now = await getMeeting(env.DB, m.id);
  await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...now, location: 'Example Hall' }, base: now.updatedAt });
  await maybeRefreshInvites(env, { now: Date.now() + 3 * 60 * 1000 });
  assert.match(calWrites(g)[0].url, /sendUpdates=all$/);
  assert.doesNotMatch(JSON.stringify(calWrites(g)[0].body), /Strategic plan|Legal/);
  // A calendar file for a member who isn't on the invite says the same
  const ics = meetingIcs(await getMeeting(env.DB, m.id));
  assert.match(ics, /DESCRIPTION:The agenda and documents: https:\/\/sunshineonaranneyday\.com\/admin\/board\/#\/meetings\//);
  assert.doesNotMatch(ics, /AGENDA|Strategic plan/);

  // The organizer's own words stay in front; Board's part is replaced, never doubled (its older wording too), in HTML when Google keeps it so
  assert.equal(withNotes('Dinner provided\n\nThe agenda and the packet are on the board page: old\nAGENDA', 'The agenda and documents: new'), 'Dinner provided\n\nThe agenda and documents: new');
  assert.equal(withNotes('Dinner provided\n\nThe agenda and documents: old', 'The agenda and documents: new'), 'Dinner provided\n\nThe agenda and documents: new');
  assert.equal(withNotes('', 'N'), 'N');
  assert.equal(withNotes('<b>Dinner</b> provided<br><br>The agenda and documents: old<br>x', 'The agenda and documents: new\nA & B'),
    '<b>Dinner</b> provided<br><br>The agenda and documents: new<br>A &amp; B');
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

// ─── Attendance from Google Meet ────────────────────────────────────

/** A meeting yesterday, 8 to 10, on Google Meet from the founder's calendar */
async function meetMeetingYesterday() {
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: inDays(-1) })).body.meeting;
  return patchMeeting(env.DB, m.id, (cur) => ({ ...cur, start: '08:00', end: '10:00', video: 'https://meet.google.com/abc-defg-hij', invite: { eventId: 'board1', organizer: FOUNDER, meet: 'https://meet.google.com/abc-defg-hij', guests: 3 } }));
}
const joinedAt = (day, from, to) => ({ earliestStartTime: `${day}T${from}:00Z`, latestEndTime: `${day}T${to}:00Z` });

test('after a Google Meet meeting, who joined is matched to the board and marked By video; a mark someone made stays', async () => {
  const day = inDays(-1);
  const g = fakeGoogleWriter({ records: { 'spaces/abc-defg-hij-space': [
    { name: 'conferenceRecords/r1', startTime: `${day}T13:00:00Z`, endTime: `${day}T15:00:00Z`, participants: [
      { signedinUser: { user: 'users/1', displayName: 'Alex Rivera' }, ...joinedAt(day, '13:02', '14:58') },
      { anonymousUser: { displayName: 'Sam' }, ...joinedAt(day, '13:05', '14:50') },
      { signedinUser: { user: 'users/3', displayName: 'Kim Park' }, ...joinedAt(day, '13:10', '13:10') },
      { phoneUser: { displayName: 'Caller (404) ***-**12' }, ...joinedAt(day, '13:00', '14:00') },
    ] },
  ] } });
  let m = await meetMeetingYesterday();
  // Someone marked Sam before Google answered: their mark stays
  m = await saveMeeting(env.DB, { ...m, attendance: m.attendance.map((p) => (p.slug === 'sam-ortiz' ? { ...p, status: 'excused' } : p)) }, { by: FOUNDER });
  const { maybeFillAttendance, matchName } = await import('../functions/api/_board-attendance.js');
  assert.deepEqual(await maybeFillAttendance(env), [m.id]);
  m = await getMeeting(env.DB, m.id);
  const status = Object.fromEntries(m.attendance.map((p) => [p.slug || p.key, p.status]));
  assert.deepEqual([status['alex-rivera'], status['sam-ortiz'], status['kim-park']], ['remote', 'excused', ''], 'Alex joined; Sam’s mark stays; a moment in the call isn’t attending');
  assert.equal(m.fromMeet.status, 'ok');
  assert.deepEqual(m.fromMeet.joined.map((j) => [j.name, j.slug, j.minutes]).sort(), [['Alex Rivera', 'alex-rivera', 116], ['Caller (404) ***-**12', '', 60], ['Kim Park', 'kim-park', 0], ['Sam', 'sam-ortiz', 105]].sort());
  // Looked at again within the hour: Google isn't asked; after two days, never again
  g.calls = [];
  await maybeFillAttendance(env, { now: Date.now() + 11 * 60 * 1000 });
  assert.equal(g.calls.length, 0);
  await maybeFillAttendance(env, { now: Date.now() + 4 * 24 * 60 * 60 * 1000 });
  assert.equal(g.calls.length, 0);
  // The board page never sees the names Meet had
  assert.equal(forBoard({ ...m, shared: true }).fromMeet, undefined);
  // Names: a nickname with the last name, a first name only one person has; never a guess between two
  const people = [{ key: 'a', name: 'Jennifer Example' }, { key: 'b', name: 'Travis Sample' }, { key: 'c', name: 'Travis Other' }];
  assert.deepEqual(['Jen Example', 'jennifer example (she/her)', 'Travis', 'Travis Sample', 'iPhone'].map((n) => matchName(n, people)?.key || null), ['a', 'a', null, 'b', null]);
});

test('attendance waits until half an hour after the meeting ends, and says so when Google Admin hasn’t allowed it', async () => {
  fakeGoogleWriter({ readScope: false });
  const m = await meetMeetingYesterday();
  const { maybeFillAttendance } = await import('../functions/api/_board-attendance.js');
  // During the meeting: nothing yet
  const during = Date.parse(`${m.date}T14:00:00Z`);
  assert.deepEqual(await maybeFillAttendance(env, { now: during }), []);
  assert.deepEqual(await maybeFillAttendance(env), [m.id]);
  const after = await getMeeting(env.DB, m.id);
  assert.deepEqual([after.fromMeet.status, after.attendance.filter((p) => p.status).length], ['needs-setup', 0]);
  assert.match(after.fromMeet.error, /meetings\.space\.readonly/);
  // The invite check finds it too, before any meeting needs it, so Board → Meetings asks for it
  await env.DB.prepare('DELETE FROM board_state WHERE key = ?').bind('invite-check').run();
  const st = await maybeCheckInvites(env);
  assert.deepEqual([st.calendar, st.meet, st.transcript, st.attendance, st.ok], ['ok', 'ok', 'on', 'needs-setup', false]);
});

// ─── The next agenda, drafted from the last one ─────────────────────

test('an agenda nobody wrote follows the last one someone wrote or emailed, and stops once someone changes it', async () => {
  const { maybeDraftAgendas } = await import('../functions/api/_board.js');
  const past = (await adminApi(FOUNDER, { action: 'import-meeting', meeting: {
    date: inDays(-60), sections: [
      { title: 'Call to order', items: [{ title: 'Roll call', presenter: 'Alex' }] },
      { title: 'Approval of minutes', items: [{ title: 'Minutes of the last meeting' }] },
      { title: 'Committee reports', items: [{ title: 'Financial', presenter: 'Sam', notes: '- Reserves grew' }, { title: 'Events and Marketing' }] },
      { title: 'New business', items: [{ title: 'Buy a trailer' }] },
    ],
  } })).body.meeting;
  let next = (await adminApi(FOUNDER, { action: 'new-meeting', date: inDays(20) })).body.meeting;
  assert.equal(next.agendaFrom.kind, 'template', 'a new meeting starts from the usual outline');
  assert.deepEqual(await maybeDraftAgendas(env), [next.id]);
  next = await getMeeting(env.DB, next.id);
  assert.deepEqual(next.sections.map((s) => [s.title, s.items.map((it) => [it.title, it.presenter, it.live, it.notes])]), [
    ['Call to order', [['Roll call', 'Alex', '', '']]],
    ['Approval of minutes', [[`Minutes of the ${meetingName(past)} (${shortDate(past.date)})`, '', 'minutes', '']]],
    ['Committee reports', [['Financial', 'Sam', 'cash', ''], ['Events and Marketing', '', '', '']]],
    ['New business', []],
  ], 'its sections and items, who presents, the live numbers; new business and notes start empty');
  assert.equal(next.sections[1].items[0].about, past.id, 'the last minutes are up for approval');
  assert.deepEqual([next.agendaFrom.kind, next.agendaFrom.name], ['last-meeting', `${meetingName(past)} (${shortDate(past.date)})`]);
  // Not again from the same meeting
  assert.deepEqual(await maybeDraftAgendas(env, { now: Date.now() + 11 * 60 * 1000 }), []);
  // Someone changes it: theirs from now on, even when a newer agenda comes in
  const edited = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...next, sections: [...next.sections, { title: 'Closing', items: [{ title: 'Adjourn' }] }] }, base: next.updatedAt })).body.meeting;
  assert.equal(edited.agendaFrom.kind, 'typed');
  await adminApi(FOUNDER, { action: 'import-meeting', meeting: { date: inDays(-5), sections: [{ title: 'Opening', items: [{ title: 'Welcome' }] }] } });
  assert.deepEqual(await maybeDraftAgendas(env, { now: Date.now() + 22 * 60 * 1000 }), []);
  assert.equal((await getMeeting(env.DB, next.id)).sections.at(-1).title, 'Closing');
  // A meeting from before agendaFrom with the untouched outline is a draft too: it follows the closest agenda
  // someone wrote before it (here the one just changed), with that meeting's minutes up for approval
  let later = (await adminApi(FOUNDER, { action: 'new-meeting', date: inDays(40) })).body.meeting;
  later = await saveMeeting(env.DB, { ...later, agendaFrom: null }, { by: 'the calendar' });
  assert.ok(agendaIsDraft(later));
  await maybeDraftAgendas(env, { now: Date.now() + 33 * 60 * 1000 });
  later = await getMeeting(env.DB, later.id);
  assert.deepEqual(later.sections.map((s) => s.title), ['Call to order', 'Approval of minutes', 'Committee reports', 'New business', 'Closing']);
  assert.equal(later.sections[1].items[0].about, next.id);
});

// ─── Board mail: past agendas, minutes and financials (more in board-mail.test.mjs) ───

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
    '1. CALL TO ORDER', '   1. Roll Call', '   2. Welcome (Jane)', '      a. Video for new members',
    '2. COMMITTEE REPORTS', '   1. Financial (Sam/Alex)', '      a. 2026 Financials', '         i. Cash is healthy', '            1. Expenses are down', '         ii. Budget approved', '3. OPEN FORUM',
  ], 'each list level three spaces further in');
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
  assert.equal(dateIn('Example Q3 Board Meeting Minutes 2025.07.24.pdf', 2026), '2025-07-24');
  assert.equal(fileKind('Board Agenda 4.30.26.docx'), 'agenda');
  assert.equal(fileKind('Q3 Minutes.pdf'), 'minutes');
  assert.equal(fileKind('Profit and Loss.pdf'), 'financials');
  assert.equal(fileKind('Balance Sheet Sept.xlsx'), 'financials');
  assert.equal(fileKind('Gala deck.pptx'), 'other');
  assert.equal(fileKind('notes.pdf', 'Board agenda for Thursday'), 'agenda', 'the subject names a lone document');
  assert.equal(fileKind('notes.pdf', 'Minutes of the board meeting'), 'minutes');
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

test('board mail: a dated agenda brings its past meeting in; an upcoming one is only kept as a file (its agenda is written in Board); never twice', async () => {
  const soon = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  let upcoming = (await adminApi(FOUNDER, { action: 'new-meeting', date: soon })).body.meeting;
  upcoming = await saveMeeting(env.DB, { ...upcoming, agendaFrom: { kind: 'template', name: '', at: '' } }, { by: 'the calendar' });
  const [m, d, y] = [soon.slice(5, 7), soon.slice(8, 10), soon.slice(0, 4)];
  const inboxes = {
    [FOUNDER]: [
      { id: 'g1', msgid: '<a1@mail>', subject: 'Example Board agenda and minutes', from: 'Jane <jane@example.org>', date: '2026-05-01T12:00:00Z', files: [{ name: 'Board Agenda 4.30.26.docx', type: DOCX, bytes: agendaDocx() }] },
      { id: 'g2', msgid: '<a2@mail>', subject: `Board agenda for ${m}/${d}/${y}`, from: 'Jane <jane@example.org>', date: new Date().toISOString(), files: [{ name: 'Agenda.pdf', type: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 fake') }, { name: 'Balance Sheet.pdf', type: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 numbers') }] },
    ],
  };
  const calls = fakeGmail(inboxes, { pdfText: OLD_AGENDA.replace('DATE 02/12/2026', `DATE ${m}/${d}/${y}`) });
  const r = await readBoardMail(env);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(MAIL_QUERIES.map((q) => calls.lists.some((l) => l.q === q)), [true], 'one search, QuickBooks left out');
  assert.match(MAIL_QUERIES[0], /-from:quickbooks/);
  const all = await listMeetings(env.DB);
  const past = all.find((x) => x.date === '2026-04-30');
  assert.ok(past, 'the April agenda brought its meeting in');
  assert.deepEqual(past.sections.map((x) => x.title), ['Call to order', 'Committee reports', 'Open forum']);
  assert.deepEqual([past.agendaFrom?.kind, past.agendaFrom?.name, past.updatedBy], ['email', 'Board Agenda 4.30.26.docx', 'board email']);
  assert.deepEqual(past.files.map((f) => [f.name, f.kind, f.staffOnly]), [['Board Agenda 4.30.26.docx', 'agenda', true]], 'sent to one person, not the board: for Peter and Holly only');
  assert.equal(past.shared, false);
  const next = all.find((x) => x.id === upcoming.id);
  assert.deepEqual([next.sections.map((x) => x.title), next.agendaFrom.kind], [upcoming.sections.map((x) => x.title), 'template'], 'an agenda ahead is written in Board: the emailed one doesn’t replace it');
  assert.deepEqual(next.files.map((f) => f.kind).sort(), ['agenda', 'financials']);
  assert.equal(next.shared, false, 'an upcoming meeting is shared by a person, never by email');
  assert.equal(calls.writes, 0, 'never sends, deletes or labels');
  // Nothing new: nothing read again
  const gets = calls.gets;
  await readBoardMail(env);
  assert.equal(calls.gets, gets);
  // The same email in another admin's inbox: read once
  await adminApi(FOUNDER, { action: 'save-settings', settings: { admins: [FOUNDER, STAFF] } });
  inboxes[STAFF] = [{ ...inboxes[FOUNDER][1], id: 'h9' }];
  await readBoardMail(env);
  assert.equal((await listMeetings(env.DB)).find((x) => x.id === upcoming.id).files.length, 2, 'no copies');
  assert.ok((await mailLog(env.DB, 12, { outcome: 'filed' })).every((x) => x.outcome === 'filed'));
  // A newer agenda for a meeting whose agenda isn't a draft any more: kept as a file, the agenda and notes left alone
  const typed = await saveMeeting(env.DB, { ...next, sections: next.sections.map((x, i) => (i ? x : { ...x, items: x.items.map((it, j) => (j ? it : { ...it, notes: '- typed in the meeting' })) })) }, { by: FOUNDER });
  inboxes[FOUNDER].push({ id: 'g3', msgid: '<a3@mail>', subject: `Board agenda v2 ${m}/${d}/${y}`, from: 'Jane', date: new Date().toISOString(), files: [{ name: 'Agenda v2.pdf', type: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 v2') }] });
  await readBoardMail(env);
  const after = (await listMeetings(env.DB)).find((x) => x.id === upcoming.id);
  assert.equal(after.sections[0].items[0].notes, '- typed in the meeting');
  assert.ok(after.files.some((f) => f.name === 'Agenda v2.pdf'));
  assert.match((await mailLog(env.DB))[0].result, /^filed on .*: the agenda$/);
  assert.ok(typed);
});

test('board mail: QuickBooks’ automatic reports and weekly reports are never filed, even with a meeting near them', async () => {
  const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const m = (await adminApi(FOUNDER, { action: 'new-meeting', date: soon })).body.meeting;
  const pdf = (t) => new TextEncoder().encode(`%PDF-1.4 ${t}`);
  fakeGmail({ [FOUNDER]: [
    { id: 'q1', msgid: '<qb@intuit>', quickbooks: true, subject: 'Board report: Profit and Loss', from: 'Example Org <quickbooks@notification.intuit.com>', date: new Date().toISOString(), files: [{ name: 'Profit and Loss.pdf', type: 'application/pdf', bytes: pdf('p&l') }] },
    { id: 'q2', msgid: '<wk@mail>', subject: 'P&L by Program - Weekly Report (board)', from: 'Jane <jane@example.org>', date: new Date().toISOString(), files: [{ name: 'Profit_and_Loss_by_Program.pdf', type: 'application/pdf', bytes: pdf('weekly') }] },
  ] });
  await readBoardMail(env);
  assert.deepEqual((await getMeeting(env.DB, m.id)).files, []);
  const log = await mailLog(env.DB);
  assert.deepEqual(log.map((x) => x.outcome), ['not-board', 'not-board']);
  assert.ok(log.some((x) => /automatic QuickBooks report/.test(x.result)) && log.some((x) => /weekly report/.test(x.result)));
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

// ─── Minutes kept as a Google Doc ───────────────────────────────────

/** A Google Doc's HTML the way Drive exports minutes: a header table, an attendee table, each section a one-row shaded table, its items lists with levels */
function minutesDocHtml() {
  const cell = (t) => `<td class="c9" colspan="1" rowspan="1"><p class="c1"><span class="c3">${t}</span></p></td>`;
  const bar = (t, n) => `<table class="c20"><tr class="c10">${`<td class="c9"><ol class="c7 lst-kix_list_1-0${n === 1 ? ' start" start="1' : ''}"><li class="c4 li-bullet-0"><span class="c8">${t}</span></li></ol></td>`}</tr></table>`;
  const list = (id, level, items, start = false) => `<ol class="c5 lst-kix_${id}-${level}${start ? ' start' : ''}"${start ? ' start="1"' : ''}>${items.map((t) => `<li class="c2 li-bullet-0"><span class="c0">${t}</span></li>`).join('')}</ol>`;
  return `<html><head><style type="text/css">.lst-kix_list_34-1>li:before{content:"" counter(lst-ctn-kix_list_34-1,lower-latin) ". "}</style></head><body class="c11 doc-content">
    <div><p class="c6"><span class="c3">| Page</span></p></div>
    <table class="c13"><tr class="c10">${cell('MEETING')}${cell('Example Q3 Board Meeting')}${cell('DATE')}${cell('8/6/2026')}</tr>
      <tr class="c10">${cell('LOCATION')}${cell('Example Hall')}${cell('TIME')}${cell('8:00a - 10:00a')}</tr></table>
    <table class="c13"><tr>${cell('')}${cell('ATTENDEE')}${cell('COMPANY')}${cell('')}${cell('ATTENDEE')}${cell('COMPANY')}</tr>
      <tr>${cell('x')}${cell('Alex Rivera')}${cell('Rivera Builders')}${cell('x')}${cell('Jane Doe')}${cell('SOARD')}</tr>
      <tr>${cell('')}${cell('Kim Park')}${cell('Park Media')}${cell('')}${cell('')}${cell('')}</tr></table>
    ${bar('CALL TO ORDER', 1)}${list('list_32', 0, ['Roll Call', 'Personal Best/Business Best (What happened since we met)'], true)}
    ${bar('APPROVE MEETING MINUTES', 2)}${list('list_33', 0, ['Q2 Board Meeting'], true)}${list('list_33', 1, ['Minutes approved'], true)}
    ${bar('COMMITTEE REPORTS', 3)}${list('list_34', 0, ['Governance (Sam)'], true)}${list('list_34', 1, ['Legal'], true)}${list('list_34', 2, ['Everyone has signed&nbsp;Docusign', 'All legal docs updated'], true)}
    ${list('list_34', 0, ['Financial (Alex)'])}${list('list_34', 1, ['Money market fund recommended', 'Store income &amp; golf on track<sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup>'], true)}${list('list_34', 2, ['Grants are dollars only'], true)}${list('list_34', 1, ['Need to replace the van'])}
    ${bar('OPEN FORUM/ANNOUNCEMENTS', 4)}
    <p class="c6"><span class="c3"></span></p>
    <div class="c15"><p class="c4"><a href="#cmnt_ref1" id="cmnt1">[a]</a><span class="c3">Check this number</span></p></div>
  </body></html>`;
}

test('minutes kept as a Google Doc read with their outline: items, points under them, presenters, who was there', () => {
  const text = docHtmlText(minutesDocHtml());
  assert.deepEqual(text.split('\n'), [
    '| Page', 'MEETING Example Q3 Board Meeting DATE 8/6/2026', 'LOCATION Example Hall TIME 8:00a - 10:00a',
    'ATTENDEE COMPANY ATTENDEE COMPANY', 'x Alex Rivera Rivera Builders x Jane Doe SOARD', 'Kim Park Park Media',
    '1. CALL TO ORDER', '1. Roll Call', '2. Personal Best/Business Best (What happened since we met)',
    '2. APPROVE MEETING MINUTES', '1. Q2 Board Meeting', '   1. Minutes approved',
    '3. COMMITTEE REPORTS', '1. Governance (Sam)', '   1. Legal', '      1. Everyone has signed Docusign', '      2. All legal docs updated',
    '2. Financial (Alex)', '   1. Money market fund recommended', '   2. Store income & golf on track', '      1. Grants are dollars only', '   3. Need to replace the van',
    '4. OPEN FORUM/ANNOUNCEMENTS',
  ], 'the levels as indents; comments and their markers left out');
  const people = [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' }, { slug: 'kim-park', name: 'Kim Park', kind: 'board' }, { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board' }, { slug: 'jane-doe', name: 'Jane Doe', kind: 'staff' }];
  const r = parseAgendaText(text, people);
  assert.deepEqual([r.date, r.start, r.end, r.location], ['2026-08-06', '08:00', '10:00', 'Example Hall']);
  assert.deepEqual(r.attendance.map((a) => `${a.slug}:${a.status}`), ['alex-rivera:present', 'jane-doe:present', 'kim-park:absent']);
  assert.deepEqual(r.sections.map((s) => [s.title, s.items.map((i) => i.title)]), [
    ['Call to order', ['Roll Call', 'Personal Best/Business Best (What happened since we met)']],
    ['Approve meeting minutes', ['Q2 Board Meeting']],
    ['Committee reports', ['Governance', 'Financial']],
    ['Open forum/announcements', []],
  ], 'four items under three sections, not one item a line');
  const [gov, fin] = r.sections[2].items;
  assert.deepEqual([gov.presenter, fin.presenter], ['Sam', 'Alex']);
  assert.equal(gov.notes, '- Legal\n  - Everyone has signed Docusign\n  - All legal docs updated');
  assert.equal(fin.notes, '- Money market fund recommended\n- Store income & golf on track\n  - Grants are dollars only\n- Need to replace the van');
  assert.equal(r.sections[1].items[0].notes, '- Minutes approved');
});

test('the same minutes as indented plain text ("1." at every level), and bullets', () => {
  const plain = ['1. CALL TO ORDER', '1. Roll Call', '3. COMMITTEE REPORTS', '1. Governance', '   1. Legal', '      1. Everyone has signed', '      2. All legal docs updated', '2. Financial', '   1. Money market fund', '4. OPEN FORUM/ANNOUNCEMENTS | Page'].join('\n');
  const r = parseAgendaText(plain);
  assert.deepEqual(r.sections.map((s) => [s.title, s.items.map((i) => i.title)]), [['Call to order', ['Roll Call']], ['Committee reports', ['Governance', 'Financial']], ['Open forum/announcements', []]], 'a footer run into a title comes off');
  assert.equal(r.sections[1].items[0].notes, '- Legal\n  - Everyone has signed\n  - All legal docs updated');
  // Items one level in under their section's number, bullets under them
  const bullets = parseAgendaText(['1. NEW BUSINESS', '\ta. Advisory committee', '\t\t• First meeting in the fall', '\t\t• Families at the first meeting', '\t\t\to Child too', '\tb. Golf beneficiary', '\t\t- Raised so far'].join('\n'));
  assert.deepEqual(bullets.sections[0].items.map((i) => [i.title, i.notes]), [
    ['Advisory committee', '- First meeting in the fall\n- Families at the first meeting\n  - Child too'],
    ['Golf beneficiary', '- Raised so far'],
  ]);
  // No indents anywhere: a bullet is a point under the item it follows
  const flat = parseAgendaText(['1. REPORTS', '1. Finance', '- Cash is fine', '2. Events'].join('\n'));
  assert.deepEqual(flat.sections[0].items.map((i) => [i.title, i.notes]), [['Finance', '- Cash is fine'], ['Events', '']]);
});

test('an agenda read by an older reader is read again once, only from Drive or email', () => {
  assert.equal(AGENDA_READER, 2);
  assert.equal(readAgain({ agendaFrom: { kind: 'drive', name: 'Minutes.pdf', at: '2026-10-28T00:00:00Z' } }), true);
  assert.equal(readAgain({ agendaFrom: { kind: 'email', name: 'Agenda.docx', at: '' } }), true);
  assert.equal(readAgain({ agendaFrom: { kind: 'drive', name: 'Minutes.pdf', at: '', v: AGENDA_READER } }), false);
  for (const kind of ['typed', 'template', 'last-meeting']) assert.equal(readAgain({ agendaFrom: { kind, name: '', at: '' } }), false, kind);
  assert.equal(readAgain({}), false);
  assert.deepEqual(cleanMeeting({ date: '2026-08-06', agendaFrom: { kind: 'drive', name: 'M.pdf', at: 'x', v: 2 } }).agendaFrom, { kind: 'drive', name: 'M.pdf', at: 'x', v: 2 });
  assert.deepEqual(cleanMeeting({ date: '2026-08-06', agendaFrom: { kind: 'drive', name: 'M.pdf', at: 'x' } }).agendaFrom, { kind: 'drive', name: 'M.pdf', at: 'x' }, 'no v added to older records');
  assert.equal(cleanMeeting({ date: '2026-08-06', notBoard: true }).notBoard, true);
});

// ─── The next meeting before it's shared, and photos ────────────────

test('the next meeting the board already has on its calendars shows its day, time and place before it’s shared; members can answer', async () => {
  const { boardIcs } = await import('../functions/api/_board.js');
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const invited = (slugs) => ({ uid: 'next@google.com', title: 'SOARD Board Meeting', from: FOUNDER, replies: Object.fromEntries(slugs.map(([s, a]) => [s, a])) });
  let m = await saveMeeting(env.DB, cleanMeeting({ date: day(20), start: '08:00', end: '10:00', location: 'Example Hall', address: '100 Example St', title: 'SOARD Board Meeting',
    sections: [{ title: 'Secret draft heading', items: [{ title: 'Draft item', notes: 'draft notes' }] }],
    calendar: invited([['alex-rivera', 'accepted'], ['sam-ortiz', 'invited']]) }), { by: 'the calendar' });
  let page = (await portalApi(MEMBER)).body;
  assert.equal(page.nextPending, null, 'two of the board invited: not theirs yet');
  assert.equal((await portalApi(MEMBER, { action: 'rsvp', meetingId: m.id, answer: 'yes' })).status, 404);
  assert.equal(await boardIcs(env.DB, m.id), null);

  m = await saveMeeting(env.DB, { ...m, calendar: invited([['alex-rivera', 'accepted'], ['sam-ortiz', 'invited'], ['kim-park', 'declined']]) }, { by: 'the calendar' });
  page = (await portalApi(MEMBER)).body;
  assert.deepEqual(page.nextPending, {
    id: m.id, date: day(20), start: '08:00', end: '10:00', title: '', name: meetingName({ date: day(20) }), location: 'Example Hall', address: '100 Example St', video: '',
    onCalendar: true, myInvite: 'accepted', myRsvp: '',
  });
  assert.equal(page.next, null);
  assert.equal(page.meetings.some((x) => x.id === m.id), false, 'not a shared meeting: no agenda, notes or files');
  assert.doesNotMatch(JSON.stringify(page), /Secret draft heading|draft notes/);
  assert.equal((await portalApi(MEMBER, { action: 'rsvp', meetingId: m.id, answer: 'yes' })).status, 200, 'they’re invited, so they can answer here');
  assert.equal((await portalApi(MEMBER)).body.nextPending.myRsvp, 'yes');
  const ics = await boardIcs(env.DB, m.id);
  assert.match(ics, /DTSTART:/);
  assert.doesNotMatch(ics, /Secret draft heading/, 'its calendar file carries no agenda');

  // Board's own invite went out: theirs too, whoever the calendar invited
  m = await saveMeeting(env.DB, { ...m, calendar: invited([]) }, { by: 'the calendar' });
  await patchMeeting(env.DB, m.id, (cur) => ({ ...cur, invite: { eventId: 'board-invite', organizer: FOUNDER, sentAt: new Date().toISOString(), meet: 'https://meet.google.com/abc-defg-hij' } }));
  page = (await portalApi(MEMBER)).body;
  assert.deepEqual([page.nextPending?.id, page.nextPending?.video, page.nextPending?.onCalendar], [m.id, 'https://meet.google.com/abc-defg-hij', false]);

  // A shared meeting comes first: that's the next one
  const earlier = await saveMeeting(env.DB, cleanMeeting({ date: day(10), shared: true }), { by: FOUNDER });
  page = (await portalApi(MEMBER)).body;
  assert.deepEqual([page.next, page.nextPending], [earlier.id, null]);
  // Not a board meeting, or off the calendar: never
  await saveMeeting(env.DB, { ...earlier, shared: false }, { by: FOUNDER });
  await patchMeeting(env.DB, m.id, (cur) => ({ ...cur, notBoard: true }));
  assert.equal((await portalApi(MEMBER)).body.nextPending, null);
});

test('the board page’s makeovers and reveals carry their published page’s photo; an unnamed one never does (a draft project is named, never pictured)', async () => {
  const { projectsNow } = await import('../functions/api/_board.js');
  await env.DB.exec('CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)');
  await env.DB.exec('CREATE TABLE community (slug TEXT PRIMARY KEY, name TEXT, data TEXT)');
  const img = (s) => `https://imagedelivery.net/abc123/kids/${s}/photo-1/public`;
  for (const [slug, d] of [
    ['max', { name: 'Max', jobtreadJobId: 'j1', heroImage: img('max') }],
    ['quinn', { name: 'Quinn', jobtreadJobId: 'j2', heroImage: img('quinn'), publishStatus: 'draft' }],
    ['odd', { name: 'Odd', jobtreadJobId: 'j4', heroImage: 'https://elsewhere.example/odd.jpg' }],
  ]) await env.DB.prepare('INSERT INTO kids (slug, name, data) VALUES (?, ?, ?)').bind(slug, d.name, JSON.stringify(d)).run();
  await env.DB.prepare('INSERT INTO community (slug, name, data) VALUES (?, ?, ?)').bind('example-house', 'Example House', JSON.stringify({ name: 'Example House', jobtreadJobId: 'j3', heroImage: img('house'), publishStatus: 'draft' })).run();
  env.JOBTREAD_GRANT_KEY = 'grant';
  const job = (id, name, status) => ({ id, name, customFieldValues: { nodes: [{ value: status, customField: { id: '22P52qfFub9b' } }] } });
  const fetchImpl = async () => Response.json({ organization: { jobs: { nodes: [job('j1', 'Max Example', 'Build'), job('j2', 'Quinn Example', 'Design'), job('j3', 'Example House', 'Approval'), job('j4', 'Odd Example', 'Build')], nextPage: null } } });
  const p = await projectsNow(env, { fetchImpl, fresh: true });
  assert.deepEqual(p.building.map((b) => [b.name, b.photo ?? null]), [['Max', img('max')], [null, null], ['Example House', null], ['Odd', null]], 'a draft kid page has neither; a draft project goes by its name for the board, with no picture; a picture from anywhere but Cloudflare Images stays out');
  const ahead = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await env.DB.prepare('INSERT INTO site_config (key, data) VALUES (?, ?)').bind('reveals', JSON.stringify({ reveals: [], upcoming: [{ slug: 'max', name: 'Max', confirmed: true, date: ahead }, { slug: 'zoe', name: 'Zoe', confirmed: true, date: ahead, image: 'https://imagedelivery.net/abc123/kids/zoe/photo-2/w=400' }], past: [] })).run();
  const n = await liveNumbers(env);
  assert.deepEqual(n.reveals.map((r) => [r.name, r.photo]), [['Max', img('max')], ['Zoe', 'https://imagedelivery.net/abc123/kids/zoe/photo-2/w=400']]);
});

test('minutes an older reader flattened are read again once from Drive, from the Doc’s HTML; the file isn’t brought in twice; a person’s agenda is never touched', async () => {
  const { readBoardDrive, DEFAULT_DRIVE_FOLDER } = await import('../functions/api/_board-drive.js');
  const { writeState } = await import('../functions/api/_board-roles.js');
  const ROOT = DEFAULT_DRIVE_FOLDER;
  const FOLDER = 'application/vnd.google-apps.folder';
  const DOC = 'application/vnd.google-apps.document';
  const d = new Date(Date.now() - 80 * 86400000);
  const date = d.toISOString().slice(0, 10);
  const files = {
    [ROOT]: { id: ROOT, name: 'Board', mimeType: FOLDER, parent: '' },
    year1234567890: { id: 'year1234567890', name: `${d.getUTCFullYear()} Board`, mimeType: FOLDER, parent: ROOT },
    meet1234567890: { id: 'meet1234567890', name: `${d.getUTCMonth() + 1}.${d.getUTCDate()}.${String(d.getUTCFullYear()).slice(2)} Board Meeting`, mimeType: FOLDER, parent: 'year1234567890' },
    mins1234567890: { id: 'mins1234567890', name: 'Example Q3 Board Meeting Minutes', mimeType: DOC, parent: 'meet1234567890', modifiedTime: '2026-08-07T00:00:00Z' },
  };
  const exports = [];
  answer = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'g-token', expires_in: 3600 });
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files') {
      const parent = (u.searchParams.get('q') || '').match(/'([^']+)' in parents/)?.[1];
      return Response.json({ files: Object.values(files).filter((f) => parent && f.parent === parent).map(({ parent: p, ...f }) => f) });
    }
    const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    const f = m && files[decodeURIComponent(m[1])];
    if (!f) return Response.json({ error: { code: 404, message: 'File not found' } }, { status: 404 });
    if (m[2]) {
      const type = u.searchParams.get('mimeType');
      exports.push(type);
      if (type === 'text/html') return new Response(minutesDocHtml());
      if (type === 'text/plain') return new Response('1. COMMITTEE REPORTS\n1. Governance\n1. Legal');
      return new Response(new TextEncoder().encode('%PDF-1.4 minutes'));
    }
    return Response.json({ id: f.id, name: f.name, driveId: 'shared-1' });
  };
  env.GOOGLE_CALENDAR_KEY = SERVICE_ACCOUNT;
  clearTokenCache();
  // As the first reader left it: every line an item, from this Doc, its folder read
  const flat = ['Governance', 'Legal', 'Everyone has signed Docusign', 'All legal docs updated', 'Financial'].map((title) => ({ title }));
  const m = await saveMeeting(env.DB, cleanMeeting({ date, shared: true, sections: [{ title: 'Call to order', items: [{ title: 'Roll Call' }] }, { title: 'Committee reports', items: flat }], agendaFrom: { kind: 'drive', name: 'Example Q3 Board Meeting Minutes.pdf', at: '2026-10-28T19:12:04Z' } }), { by: 'Google Drive' });
  const typed = await saveMeeting(env.DB, cleanMeeting({ date: '2020-01-01', sections: [{ title: 'Mine', items: [{ title: 'Kept' }] }], agendaFrom: { kind: 'typed', name: '', at: '' } }), { by: FOUNDER });
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS board_drive (drive_id TEXT PRIMARY KEY, meeting_id TEXT, board_file_id TEXT, modified TEXT, name TEXT, folder_id TEXT, at TEXT)').run();
  await env.DB.prepare('INSERT INTO board_drive (drive_id, meeting_id, board_file_id, modified, name, folder_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('mins1234567890', m.id, 'f_kept', '2026-08-07T00:00:00Z', 'Example Q3 Board Meeting Minutes.pdf', 'meet1234567890', new Date().toISOString()).run();
  await writeState(env.DB, 'drive-done', { version: 2, root: ROOT, walkedAt: '2026-01-01T00:00:00Z', folders: [], seen: { meet1234567890: new Date().toISOString() } });
  assert.equal(readAgain(await getMeeting(env.DB, m.id)), true);

  const st = await readBoardDrive(env, { budgetMs: 60000 });
  assert.equal(st.ok, true, JSON.stringify(st.errors));
  const after = await getMeeting(env.DB, m.id);
  assert.deepEqual(after.sections.map((s) => [s.title, s.items.map((i) => i.title)]), [
    ['Call to order', ['Roll Call', 'Personal Best/Business Best (What happened since we met)']],
    ['Approve meeting minutes', ['Q2 Board Meeting']],
    ['Committee reports', ['Governance', 'Financial']],
    ['Open forum/announcements', []],
  ]);
  assert.equal(after.sections[2].items[0].notes, '- Legal\n  - Everyone has signed Docusign\n  - All legal docs updated');
  assert.deepEqual([after.agendaFrom.kind, after.agendaFrom.v, after.shared], ['drive', AGENDA_READER, true]);
  assert.ok(exports.includes('text/html') && !exports.includes('text/plain'), 'read from its HTML');
  assert.equal(env.FILES.map.size, 0, 'its copy stays as it is: nothing stored again');
  assert.equal(st.stale, 0);
  assert.deepEqual((await getMeeting(env.DB, typed.id)).sections.map((s) => s.title), ['Mine']);
  // Once: the next look reads nothing again
  exports.length = 0;
  await readBoardDrive(env, { budgetMs: 60000 });
  assert.equal(exports.length, 0);
});

test('an emailed agenda an older reader filled is read again once from the copy Board keeps, and the next meeting’s draft follows it', async () => {
  const { putFile, maybeRereadEmailAgendas, maybeDraftAgendas } = await import('../functions/api/_board.js');
  const { draftName } = await import('../public/admin/board-shared.js');
  const past = await saveMeeting(env.DB, cleanMeeting({ date: '2026-04-30', sections: [{ title: 'Call to order', items: ['Roll Call', 'Welcome', 'Video for new members'].map((title) => ({ title })) }], agendaFrom: { kind: 'email', name: 'Board Agenda.docx', at: '2026-05-01T00:00:00Z' } }), { by: 'board email' });
  await putFile(env, { ownerType: 'meeting', ownerId: past.id, file: new File([agendaDocx()], 'Board Agenda.docx'), kind: 'agenda', by: 'board email' });
  const ahead = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const draft = await saveMeeting(env.DB, cleanMeeting({ date: ahead, sections: [{ title: 'Call to order', items: [{ title: 'Video for new members' }] }], agendaFrom: { kind: 'last-meeting', name: draftName(past), at: '2026-05-02T00:00:00Z' } }), { by: 'the calendar' });
  assert.deepEqual(await maybeRereadEmailAgendas(env), [past.id]);
  const read = await getMeeting(env.DB, past.id);
  assert.deepEqual(read.sections.map((s) => [s.title, s.items.map((i) => i.title)]), [['Call to order', ['Roll Call', 'Welcome']], ['Committee reports', ['Financial']], ['Open forum', []]]);
  assert.equal(read.sections[0].items[1].presenter, 'Jane');
  assert.equal(read.agendaFrom.v, AGENDA_READER);
  assert.deepEqual(await maybeRereadEmailAgendas(env), [], 'once');
  assert.deepEqual(await maybeDraftAgendas(env), [draft.id], 'the draft follows the agenda read again');
  assert.deepEqual((await getMeeting(env.DB, draft.id)).sections.map((s) => s.title), ['Call to order', 'Committee reports', 'Open forum']);
  assert.deepEqual(await maybeDraftAgendas(env, { now: Date.now() + 11 * 60 * 1000 }), [], 'and only once');
});

// ─── A meeting as it's held, and the admins' practice meeting ───────

const { createPractice, getPractice, todayPractice, simulatedCheckins, simulatedVotes, liveView } = await import('../functions/api/_board.js');
const { isLive, tallyText, mergeMeeting, todayEastern: todayET, cleanLive } = await import('../public/admin/board-shared.js');
const liveGet = (email, id, who = 'portal') => call(email, `/api/board-${who === 'portal' ? 'portal' : 'admin'}?live=${id}`, { handler: who === 'portal' ? portal.onRequestGet : admin.onRequestGet });

/** A meeting today, shared, with an agenda (one private note), a motion and the board on its list */
async function heldToday({ shared = true } = {}) {
  const made = (await adminApi(FOUNDER, { action: 'new-meeting', date: todayET() })).body.meeting;
  const m = { ...made, shared, title: 'Fall board meeting',
    sections: [{ id: 's_one', title: 'Reports', items: [{ id: 'i_fin', title: 'Finance', notes: '- On budget', staffNote: 'PRIVATE: ask counsel' }, { id: 'i_prog', title: 'Programs' }] }],
    motions: [{ id: 'v_budget', text: 'Approve the 2027 budget', by: 'Alex Rivera', second: 'Sam Ortiz', result: 'passed' }] };
  return (await adminApi(FOUNDER, { action: 'save-meeting', meeting: m, base: made.updatedAt })).body.meeting;
}
const chairSets = async (m, live, more = {}) => (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...m, ...more, live: { ...cleanLive(m.live), ...live } }, base: m.updatedAt })).body.meeting;

test('a meeting is held live: the chair starts it and moves item by item; members follow, check in, and vote while a vote is open', async () => {
  let m = await heldToday();
  assert.deepEqual(m.live, { startedAt: '', endedAt: '', itemId: '', fileId: '', page: 0, part: 0, screen: '', sectionId: '', vote: null, sectionAt: '', floor: '' }, 'every meeting has an empty live until the chair starts it');
  let v = (await liveGet(MEMBER, m.id)).body;
  assert.equal(v.ok, true);
  assert.equal(v.live.startedAt, '', 'not started');
  assert.equal(v.me.canAct, true);
  assert.ok(!JSON.stringify(v).includes('ask counsel'), 'never a private note');
  assert.deepEqual(v.sections[0].items.map((it) => it.id), ['i_fin', 'i_prog']);

  const started = new Date().toISOString();
  m = await chairSets(m, { startedAt: started, itemId: 'i_fin' });
  assert.equal(isLive(m), true);
  v = (await liveGet(MEMBER, m.id)).body;
  assert.equal(v.live.itemId, 'i_fin', 'the item being discussed');
  assert.deepEqual({ board: v.here.board, of: v.here.of }, { board: 0, of: 3 });

  // Voting needs an open vote, and being here
  assert.equal((await portalApi(MEMBER, { action: 'vote', meetingId: m.id, motionId: 'v_budget', vote: 'for' })).status, 409, 'no vote is open');
  m = await chairSets(m, { vote: { motionId: 'v_budget', openedAt: new Date().toISOString() } });
  const notHere = await portalApi(MEMBER, { action: 'vote', meetingId: m.id, motionId: 'v_budget', vote: 'for' });
  assert.equal(notHere.status, 409);
  assert.match(notHere.body.error, /Check in first/);
  assert.equal((await portalApi(MEMBER, { action: 'checkin', meetingId: m.id, how: 'nowhere' })).status, 400);
  v = (await portalApi(MEMBER, { action: 'checkin', meetingId: m.id, how: 'remote' })).body;
  assert.deepEqual([v.me.how, v.here.board, v.here.remote], ['remote', 1, 1]);
  v = (await portalApi(MEMBER, { action: 'vote', meetingId: m.id, motionId: 'v_budget', vote: 'for' })).body;
  assert.deepEqual([v.vote.counts.for, v.vote.counts.voted, v.vote.counts.of, v.vote.mine], [1, 1, 1, 'for']);
  v = (await portalApi(MEMBER, { action: 'vote', meetingId: m.id, motionId: 'v_budget', vote: 'against' })).body;
  assert.deepEqual([v.vote.counts.for, v.vote.counts.against, v.vote.mine], [0, 1, 'against'], 'a change of mind replaces the vote');
  assert.equal((await portalApi(MEMBER, { action: 'vote', meetingId: m.id, motionId: 'v_budget', vote: 'maybe' })).status, 400);
  // Someone the chair marked here votes without checking in
  m = await chairSets(m, {}, { attendance: m.attendance.map((p) => (p.slug === 'sam-ortiz' ? { ...p, status: 'present' } : p)) });
  v = (await portalApi(OTHER_MEMBER, { action: 'vote', meetingId: m.id, motionId: 'v_budget', vote: 'for' })).body;
  assert.deepEqual([v.here.board, v.vote.counts.voted, v.me.how], [2, 2, 'present']);

  // The chair's screen sees every check-in and vote
  const chair = (await liveGet(FOUNDER, m.id, 'admin')).body;
  assert.deepEqual(chair.checkins.map((c) => [c.slug, c.how]), [['alex-rivera', 'remote']]);
  assert.deepEqual(chair.votes.v_budget.map((x) => [x.slug, x.vote]).sort(), [['alex-rivera', 'against'], ['sam-ortiz', 'for']]);

  // Closed with a tally, then taken again: only votes since it reopened count
  m = await chairSets(m, { vote: null }, { motions: m.motions.map((x) => ({ ...x, result: 'failed', tally: { for: 1, against: 1, abstain: 0, of: 2, at: new Date().toISOString() } })) });
  assert.equal(tallyText(m.motions[0]), 'Did not pass 1–1');
  assert.equal((await portalApi(MEMBER, { action: 'vote', meetingId: m.id, motionId: 'v_budget', vote: 'for' })).status, 409, 'closed');
  await new Promise((r) => setTimeout(r, 5));
  m = await chairSets(m, { vote: { motionId: 'v_budget', openedAt: new Date().toISOString() } });
  v = (await liveGet(MEMBER, m.id)).body;
  assert.equal(v.vote.counts.voted, 0, 'a vote taken again starts over');
  assert.equal(v.motions[0].tally.for, 1, 'the last tally stays until the chair closes this one');

  // An admin looking can't act for anyone; nobody follows a meeting that isn't shared
  const looking = (await liveGet(FOUNDER, m.id)).body;
  assert.equal(looking.me.canAct, false);
  assert.equal((await portalApi(FOUNDER, { action: 'checkin', meetingId: m.id, how: 'present' })).status, 403);
  const hidden = await heldToday({ shared: false });
  assert.equal((await liveGet(MEMBER, hidden.id)).status, 404);
  // The chair previews one not shared yet on the screen: as the board will see it, acting in nothing
  const preview = await liveGet(FOUNDER, hidden.id);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.me.canAct, false);
  assert.ok(!JSON.stringify(preview.body).includes('PRIVATE'), 'never the private note');
  assert.equal((await portalApi(FOUNDER, { action: 'checkin', meetingId: hidden.id, how: 'present' })).status, 403);
  // Ended: no more votes
  m = await chairSets(m, { endedAt: new Date().toISOString() });
  assert.equal(isLive(m), false);
  assert.equal((await portalApi(MEMBER, { action: 'vote', meetingId: m.id, motionId: 'v_budget', vote: 'for' })).status, 409);
});

test('checking in opens on the meeting’s day (or while it’s held); the chair’s live state merges without a question', async () => {
  const made = (await adminApi(FOUNDER, { action: 'new-meeting', date: '2099-01-01' })).body.meeting;
  const m = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...made, shared: true }, base: made.updatedAt })).body.meeting;
  assert.equal((await portalApi(MEMBER, { action: 'checkin', meetingId: m.id, how: 'present' })).status, 409);
  const base = cleanMeeting(m);
  const mine = { ...base, live: { ...base.live, startedAt: '2099-01-01T13:00:00.000Z', itemId: 'i_x' } };
  const theirs = { ...base, title: 'Renamed' };
  const { merged, clashes } = mergeMeeting(base, mine, theirs);
  assert.deepEqual(clashes, []);
  assert.equal(merged.live.itemId, 'i_x');
  assert.equal(merged.title, 'Renamed');
});

test('a practice meeting is the admins’ alone: its own table, never the board page, the lists, invites, emails or answers', async () => {
  const p = (await adminApi(FOUNDER, { action: 'practice' })).body.meeting;
  assert.equal(p.practice, true);
  assert.equal(p.shared, false);
  assert.equal(p.title, 'Practice meeting');
  assert.equal(p.date, todayET());
  assert.deepEqual(p.attendance.filter((x) => x.kind === 'board').map((x) => x.slug).sort(), ['alex-rivera', 'kim-park', 'sam-ortiz']);
  assert.ok(p.motions.length >= 1, 'a motion to vote on');
  assert.equal((await adminApi(FOUNDER, { action: 'practice' })).body.meeting.id, p.id, 'the same one all day');
  assert.equal((await todayPractice(env.DB)).id, p.id);

  // Nothing that reads the board's meetings finds it
  assert.equal(await getMeeting(env.DB, p.id), null);
  assert.ok(!(await listMeetings(env.DB)).some((x) => x.id === p.id));
  assert.ok((await listMeetings(env.DB, { practice: true })).some((x) => x.id === p.id), 'only when asked');
  assert.ok(!(await adminApi(FOUNDER)).body.meetings.some((x) => x.id === p.id), 'not in the Board area’s list');
  const page = (await portalApi(MEMBER)).body;
  assert.ok(!page.meetings.some((x) => x.id === p.id));
  assert.equal('practice' in page, false, 'members never hear of it');
  assert.equal((await portalApi(FOUNDER)).body.practice.id, p.id, 'an admin on the board page sees today’s practice');
  assert.equal((await liveGet(MEMBER, p.id)).status, 404);
  assert.equal((await portalApi(MEMBER, { action: 'checkin', meetingId: p.id, how: 'present' })).status, 404);
  assert.equal((await portalApi(MEMBER, { action: 'rsvp', meetingId: p.id, answer: 'yes' })).status, 404);
  for (const action of ['send-invite', 'send-packet', 'snapshot', 'remind-rsvp', 'send-minutes', 'keep-agenda']) {
    assert.notEqual((await adminApi(FOUNDER, { action, id: p.id, test: true })).body.ok, true, `${action} can’t reach a practice meeting`);
  }
  assert.ok(!outside.some((o) => /resend|googleapis/.test(o.url)), 'no email, no calendar');

  // Saving keeps it practice and unshared; a board meeting can't be made one
  const saved = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...p, shared: true, practice: false, title: 'Still practice' }, base: p.updatedAt })).body.meeting;
  assert.deepEqual([saved.practice, saved.shared, saved.title], [true, false, 'Still practice']);
  const real = (await adminApi(FOUNDER, { action: 'new-meeting', date: '2099-02-02' })).body.meeting;
  const sneaky = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...real, practice: true }, base: real.updatedAt })).body.meeting;
  assert.equal(sneaky.practice, false);
  assert.ok(!JSON.stringify(saved.sections).includes('"about":"m_'), 'its minutes item approves nothing real');
});

test('a practice meeting’s simulated members check in and vote by the clock, the same on every read; the admin acts as one more member', async () => {
  let p = (await adminApi(FOUNDER, { action: 'practice' })).body.meeting;
  assert.deepEqual(simulatedCheckins(p, Date.now()), [], 'nobody before it starts');
  const t0 = Date.now();
  p = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...p, live: { ...p.live, startedAt: new Date(t0).toISOString() } }, base: p.updatedAt })).body.meeting;
  p = await getPractice(env.DB, p.id);
  assert.deepEqual(simulatedCheckins(p, t0 + 2000), [], 'the first arrives after 3 seconds');
  const late = simulatedCheckins(p, t0 + 60_000);
  assert.deepEqual(late, simulatedCheckins(p, t0 + 60_000), 'the same on every read');
  for (const c of late) {
    const at = Date.parse(c.at) - t0;
    assert.ok(at >= 3000 && at <= 40_000, `${c.slug} arrives within 40 seconds`);
    assert.ok(['present', 'remote'].includes(c.how));
  }
  const vote = { motionId: p.motions[0].id, openedAt: new Date(t0 + 60_000).toISOString() };
  const votes = simulatedVotes(p, vote, late, t0 + 120_000);
  assert.equal(votes.length, late.length, 'each one here votes');
  for (const x of votes) {
    const after = Date.parse(x.at) - (t0 + 60_000);
    assert.ok(after >= 2000 && after <= 14_000);
    assert.ok(['for', 'against', 'abstain'].includes(x.vote));
  }
  assert.deepEqual(simulatedVotes(p, vote, late, t0 + 61_000), [], 'nobody votes in the first two seconds');

  // The admin, practising: checks in and votes as themselves
  const view = await liveView(env, p.id, { admin: true, adminEmail: FOUNDER, now: t0 + 60_000 });
  assert.deepEqual([view.practice, view.me.canAct, view.me.name, view.here.of], [true, true, 'Jane Doe', 4]);
  assert.equal(view.here.board, late.length);
  p = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...p, live: { ...p.live, vote: { motionId: p.motions[0].id, openedAt: new Date().toISOString() } } }, base: p.updatedAt })).body.meeting;
  assert.equal((await portalApi(FOUNDER, { action: 'checkin', meetingId: p.id, how: 'present' })).body.me.how, 'present');
  const voted = (await portalApi(FOUNDER, { action: 'vote', meetingId: p.id, motionId: p.motions[0].id, vote: 'abstain' })).body;
  assert.equal(voted.vote.mine, 'abstain');
  const chair = (await liveGet(FOUNDER, p.id, 'admin')).body;
  assert.ok(chair.checkins.some((c) => c.slug === 'admin:jane' && c.name === 'Jane Doe'));
  assert.ok(chair.votes[p.motions[0].id].some((x) => x.slug === 'admin:jane' && x.vote === 'abstain'));

  // Start over: a new one, nothing carried
  const again = (await adminApi(FOUNDER, { action: 'practice-reset', id: p.id })).body.meeting;
  assert.notEqual(again.id, p.id);
  const stale = await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...p, title: 'Saved late' }, base: p.updatedAt });
  assert.equal(stale.status, 404, 'an editor left open on the old one can’t save it as a board meeting');
  assert.ok(!(await listMeetings(env.DB)).some((x) => x.title === 'Saved late'));
  assert.equal(again.live.startedAt, '');
  assert.equal(await getPractice(env.DB, p.id), null);
  assert.deepEqual((await liveGet(FOUNDER, again.id, 'admin')).body.checkins, []);
});

test('a practice meeting shows the next meeting’s documents on the same items, borrowed: never a staff-only one, never copied or deleted', async () => {
  const { putFile, itemFiles } = { ...(await import('../functions/api/_board.js')), ...(await import('../public/admin/board-shared.js')) };
  const pdf = new TextEncoder().encode('%PDF-1.4\n%fake\n');
  const put = (m, name, kind, staffOnly = false) => putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([pdf], name, { type: 'application/pdf' }), kind, staffOnly, by: FOUNDER });
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const made = async (date, fn = (m) => m) => {
    const m = (await adminApi(FOUNDER, { action: 'new-meeting', date })).body.meeting;
    return (await adminApi(FOUNDER, { action: 'save-meeting', meeting: fn({ ...m, shared: true }), base: m.updatedAt })).body.meeting;
  };
  const last = await made(day(-60));
  const minutes = await put(last, 'August minutes.pdf', 'minutes');
  let next = await made(day(10));
  const fin = await put(next, 'September financial statements.pdf', 'financials');
  const secret = await put(next, 'Salary review.pdf', 'other', true);
  const loose = await put(next, 'Gala sponsor list.pdf', 'other');
  const withDocs = { ...next, sections: next.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.live === 'cash' ? { ...it, docs: [fin.id, secret.id] } : it.live === 'minutes' ? { ...it, about: last.id } : it)) })) };
  next = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: withDocs, base: next.updatedAt })).body.meeting;

  const p = (await adminApi(FOUNDER, { action: 'practice' })).body.meeting;
  assert.deepEqual(p.files.map((f) => f.id).sort(), [fin.id, loose.id, minutes.id].sort(), 'the board’s documents, never the staff-only one');
  const items = p.sections.flatMap((s) => s.items);
  assert.deepEqual(itemFiles(p, items.find((it) => it.live === 'cash')).map((f) => f.name), ['September financial statements.pdf'], 'on the same item');
  const mins = items.find((it) => it.live === 'minutes');
  assert.deepEqual([mins.about, itemFiles(p, mins).map((f) => f.id)], ['', [minutes.id]], 'the minutes it would approve, approving nothing');
  assert.equal(p.docsFrom, '');
  // The screen (the board page's live view) has them, and the admin opens them
  assert.deepEqual((await liveView(env, p.id, { admin: true, adminEmail: FOUNDER })).files.map((f) => f.id).sort(), [fin.id, loose.id, minutes.id].sort());
  assert.equal((await call(FOUNDER, `/api/board-file?id=${fin.id}`, { handler: fileRoute.onRequestGet })).status, 200);
  // Borrowed as they are now: saving keeps them, and one made staff-only since drops out
  const saved = (await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...p, live: { ...p.live, itemId: mins.id } }, base: p.updatedAt })).body.meeting;
  assert.equal(saved.files.length, 3);
  await adminApi(FOUNDER, { action: 'update-file', id: loose.id, staffOnly: true });
  assert.deepEqual((await getPractice(env.DB, p.id)).files.map((f) => f.id).sort(), [fin.id, minutes.id].sort());
  const row = JSON.parse((await env.DB.prepare('SELECT data FROM board_practice WHERE id = ?').bind(p.id).first()).data);
  assert.equal('files' in row, false, 'never copied into the practice');
  // Starting over (and a week's clearing) leaves the real meeting's files where they are
  const again = (await adminApi(FOUNDER, { action: 'practice-reset', id: p.id })).body.meeting;
  assert.deepEqual(again.files.map((f) => f.id).sort(), [fin.id, minutes.id].sort());
  assert.equal((await getMeeting(env.DB, next.id)).files.length, 3);
  assert.equal((await getMeeting(env.DB, last.id)).files.length, 1);
});

test('with nothing on the next meeting, a practice meeting borrows the last meeting’s documents, each with the item it fits; one made before documents is made again', async () => {
  const { putFile, itemFiles } = { ...(await import('../functions/api/_board.js')), ...(await import('../public/admin/board-shared.js')) };
  const pdf = new TextEncoder().encode('%PDF-1.4\n%fake\n');
  const put = (m, name, kind, staffOnly = false) => putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([pdf], name, { type: 'application/pdf' }), kind, staffOnly, by: FOUNDER });
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const last = (await adminApi(FOUNDER, { action: 'new-meeting', date: day(-30) })).body.meeting;
  await adminApi(FOUNDER, { action: 'save-meeting', meeting: { ...last, shared: true }, base: last.updatedAt });
  const fin = await put(last, 'Q3 financial statements.pdf', 'financials');
  const minutes = await put(last, 'Minutes.pdf', 'minutes');
  await put(last, 'Board Agenda.pdf', 'agenda');
  await put(last, 'Counsel memo.pdf', 'other', true);
  const gala = await put(last, 'Gala plan.pdf', 'other');
  await adminApi(FOUNDER, { action: 'new-meeting', date: day(10) }); // the next meeting: its agenda, no documents yet

  // One made earlier today, before practice meetings had documents
  const old = (await adminApi(FOUNDER, { action: 'practice' })).body.meeting;
  const data = JSON.parse((await env.DB.prepare('SELECT data FROM board_practice WHERE id = ?').bind(old.id).first()).data);
  delete data.borrowed; delete data.docsFrom;
  await env.DB.prepare('UPDATE board_practice SET data = ? WHERE id = ?').bind(JSON.stringify(data), old.id).run();
  assert.equal((await getPractice(env.DB, old.id)).borrowed, null);

  const p = (await adminApi(FOUNDER, { action: 'practice' })).body.meeting;
  assert.notEqual(p.id, old.id, 'made again, with documents');
  assert.equal(await getPractice(env.DB, old.id), null);
  assert.equal(p.docsFrom, last.date, 'it says whose documents they are');
  assert.deepEqual(p.files.map((f) => f.name).sort(), ['Gala plan.pdf', 'Minutes.pdf', 'Q3 financial statements.pdf'], 'never the old agenda or a staff-only file');
  const items = p.sections.flatMap((s) => s.items);
  assert.deepEqual(itemFiles(p, items.find((it) => it.live === 'cash')).map((f) => f.id), [fin.id], 'the statements with the money');
  assert.deepEqual(itemFiles(p, items.find((it) => it.live === 'minutes')).map((f) => f.id), [minutes.id]);
  assert.ok(!items.some((it) => it.docs.includes(gala.id)), 'one that fits no item is shown after the agenda');
  assert.equal((await adminApi(FOUNDER, { action: 'practice' })).body.meeting.id, p.id, 'and kept all day');
});

test('the roll call on the screen: the board on the meeting’s list, each in the room, on video or not yet; the items about the people are found by name', async () => {
  const { facesOf } = await import('../public/admin/board-shared.js');
  assert.equal(facesOf({ title: 'Roll call' }), 'roll');
  assert.equal(facesOf({ title: 'Attendance and quorum' }), 'roll');
  assert.equal(facesOf({ title: 'Welcome and introductions' }), 'room');
  assert.equal(facesOf({ title: 'Personal Best, Business Best, Sunshine Bragging Rights' }), 'room');
  assert.equal(facesOf({ title: 'Financial' }), '');
  assert.equal(facesOf({ title: 'Roll call', live: 'cash' }), '', 'live numbers someone chose for it win');
  let m = await heldToday();
  m = await chairSets(m, { startedAt: new Date().toISOString() });
  await portalApi(MEMBER, { action: 'checkin', meetingId: m.id, how: 'present' });
  await portalApi(OTHER_MEMBER, { action: 'checkin', meetingId: m.id, how: 'remote' });
  const v = (await liveGet(MEMBER, m.id)).body;
  assert.deepEqual(v.roll.map((p) => [p.slug, p.how]).sort(), [['alex-rivera', 'present'], ['kim-park', ''], ['sam-ortiz', 'remote']]);
  assert.ok(v.roll.every((p) => p.name), 'each by name');
});

test('the quorum is a majority of the board on the meeting’s list, unless Settings names a number', async () => {
  const { majority, quorumFor } = await import('../public/admin/board-shared.js');
  assert.equal(majority(13), 7);
  assert.equal(majority(12), 7);
  assert.equal(majority(1), 1);
  assert.equal(majority(0), 0);
  const list = (n, extra = []) => ({ attendance: [...Array.from({ length: n }, (_, i) => ({ key: `b${i}`, slug: `b${i}`, name: `B${i}`, kind: 'board', status: '' })), ...extra] });
  assert.equal(quorumFor(list(13)), 7, 'a majority of 13');
  assert.equal(quorumFor(list(12, [{ key: 's', slug: 's', name: 'S', kind: 'staff', status: 'present' }])), 7, 'staff never count toward the board');
  assert.equal(quorumFor(list(13), 5), 5, 'a number in Settings wins');
  assert.equal(quorumFor(list(0)), 0, 'no board on the list, no quorum to meet');
});


test('a draft puts the last minutes up for approval whatever their item was called, and finds the makeovers and the money by name', () => {
  const prev = cleanMeeting({ id: 'm_prev1', date: '2026-08-06', title: 'Q3 2026 Board Meeting', sections: [
    { title: 'Call to order', items: [{ title: 'Roll Call' }] },
    { title: 'Approve meeting minutes', items: [{ title: 'Q2 Board Meeting', notes: 'Minutes approved' }] },
    { title: 'Committee reports', items: [{ title: 'Financial', presenter: 'Sam' }, { title: 'Projects updates and upcoming reveals', presenter: 'Pat' }, { title: 'Store update' }] },
    { title: 'New business / issues', items: [{ title: 'A thing decided last time' }] },
    { title: 'Upcoming events', items: [{ title: 'Events' }, { title: '2026 Board Meetings' }] },
  ] });
  const draft = draftAgenda(prev);
  const items = draft.flatMap((s) => s.items);
  const minutes = items.filter((it) => it.live === 'minutes');
  assert.equal(minutes.length, 1);
  assert.equal(minutes[0].title, 'Minutes of the Q3 2026 Board Meeting (Aug 6, 2026)');
  assert.equal(minutes[0].about, 'm_prev1');
  assert.equal(items.find((it) => /^Projects/.test(it.title)).live, 'projects');
  assert.equal(items.find((it) => it.title === 'Financial').live, 'cash');
  assert.equal(items.find((it) => it.title === '2026 Board Meetings').live, 'meetings');
  assert.equal(items.find((it) => it.title === 'Store update').live, '');
  assert.equal(draft.find((s) => /new business/i.test(s.title)).items.length, 0, 'new business starts empty');
  assert.ok(!items.some((it) => it.notes), 'nothing written last time comes along');
  assert.equal(liveOfTitle('Events and Marketing Committee', 'Committee reports'), '', 'a committee named for events is not the events list');
  assert.equal(liveOfTitle('Treasurer’s report'), 'cash');
});

test('the meeting’s time is shared out among its parts, a part given its own minutes keeping them', () => {
  const m = cleanMeeting({ id: 'm_plan1', date: '2026-11-05', start: '08:00', end: '10:00', sections: [
    { id: 's_one1', title: 'Call to order', items: [{ title: 'Roll call' }, { title: 'Welcome' }] },
    { id: 's_two1', title: 'Committee reports', items: [{ title: 'Financial', live: 'cash' }, { title: 'Projects', live: 'projects' }, { title: 'Store' }] },
    { id: 's_thr1', title: 'Open forum', items: [] },
  ] });
  const plan = sectionPlan(m);
  const sum = [...plan.values()].reduce((n, p) => n + p.minutes, 0);
  assert.equal(sum, 120, 'the parts add up to the meeting');
  assert.ok(plan.get('s_two1').minutes > plan.get('s_one1').minutes && plan.get('s_thr1').minutes >= 5, 'the busier part gets more; an empty one still gets some');
  assert.equal(plan.get('s_one1').start, '08:00');
  assert.equal(plan.get('s_two1').start, plan.get('s_one1').end, 'each starts when the one before it ends');
  const fixed = sectionPlan({ ...m, sections: m.sections.map((s) => (s.id === 's_one1' ? { ...s, minutes: 10 } : s)) });
  assert.equal(fixed.get('s_one1').minutes, 10);
  assert.equal(fixed.get('s_one1').auto, false);
  assert.equal([...fixed.values()].reduce((n, p) => n + p.minutes, 0), 120, 'the rest share what’s left');
  assert.equal(cleanMeeting({ ...m, sections: [{ title: 'x', minutes: 9999, items: [] }] }).sections[0].minutes, 600);
  assert.equal(sectionOf(m, m.sections[1].items[0].id), 's_two1');
  // The part's timer, and whose floor it is
  const at = new Date(Date.now() - 125 * 1000).toISOString();
  const t = sectionClock(plan, 's_one1', at);
  assert.ok(t.left > 0 && !t.over && t.of === plan.get('s_one1').minutes * 60);
  const over = sectionClock(plan, 's_thr1', new Date(Date.now() - 3600 * 1000).toISOString());
  assert.ok(over.over && over.left < 0);
  assert.equal(clockText(-95), '1:35');
  assert.equal(sectionClock(plan, 's_one1', ''), null, 'no timer before the part has begun');
  const live = cleanLive({ startedAt: new Date().toISOString(), itemId: 'i_abc1', sectionAt: at, floor: 'sam-ortiz' });
  assert.equal(live.sectionAt, at);
  assert.equal(live.floor, 'sam-ortiz');
  assert.deepEqual([cleanLive({ sectionAt: at, floor: 'sam-ortiz' }).sectionAt, cleanLive({ itemId: 'i_abc1', floor: '../x' }).floor], ['', ''], 'only with an item on, and only a person’s slug');
});
