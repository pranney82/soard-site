/**
 * What board members do on the board page, for Board → Members: their sign-ins (once each, when the code was
 * typed), the pages and files they looked at with the time spent, their answers once they worked, the calendar
 * file and following a meeting live; never an admin's; what the board page's tracker may and may not report;
 * each member's summary and their own sheet. Made-up people only (the repo is public).
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequest, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import { rename } from '../functions/api/rename-content.js';
import * as admin from '../functions/api/board-admin.js';
import * as portal from '../functions/api/board-portal.js';
import * as boardFile from '../functions/api/board-file.js';
import { saveMeeting, ensureSchema, patchMeeting, saveDoc } from '../functions/api/_board.js';
import { deviceOf, accessIat, pageOk, visitsOf, activityOverview, memberActivity } from '../functions/api/_board-activity.js';
import { pageOf, startTracking } from '../public/admin/board/activity.js';
import { said, sittingsOf, span, namesFrom, merged, readOf, docsLine, cameAfter } from '../public/admin/board-activity.js';
import { newMeeting, todayEastern, NOTHING_NEW } from '../public/admin/board-shared.js';
import { writeState } from '../functions/api/_board-roles.js';

const TEAM = 'soard';
const AUD = 'aud-tag';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
async function signIn(email, iat) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: ISS, aud: [AUD], email, iat, nbf: iat, exp: now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}

const FOUNDER = 'jane@soardcharity.com';
const MEMBER = 'alex.board@example.com';
const OTHER = 'sam.board@example.org';
const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair' }],
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';

let env;
const realFetch = globalThis.fetch;
const SIGNED = Math.floor(Date.now() / 1000) - 600;
beforeEach(async () => {
  env = { DB: await createD1(), CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  for (const [slug, email] of [['alex-rivera', MEMBER], ['sam-ortiz', OTHER]]) await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  await ensureSchema(env.DB);
  _resetKeyCacheForTests();
  globalThis.fetch = async (input) => {
    if (String(input) === `${ISS}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${input}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function call(email, path, { method = 'GET', body = null, handler, ua = IPHONE, iat = SIGNED, headers: more = {} } = {}) {
  const headers = { 'CF-Access-JWT-Assertion': await signIn(email, iat), Origin: 'https://sunshineonaranneyday.com', 'User-Agent': ua, ...more };
  if (body) headers['Content-Type'] = 'application/json';
  const request = new Request(`https://sunshineonaranneyday.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ctx = { request, env, data: {} };
  ctx.next = async () => handler(ctx);
  const res = await onRequest(ctx);
  return { status: res.status, body: (res.headers.get('Content-Type') || '').includes('json') ? await res.json() : await res.text() };
}
const page = (email, opts = {}) => call(email, `/api/board-portal${opts.query || ''}`, { handler: portal.onRequestGet, ...opts });
const post = (email, body, opts = {}) => call(email, '/api/board-portal', { method: 'POST', body, handler: portal.onRequestPost, ...opts });
const rows = async (slug) => (await env.DB.prepare('SELECT kind, ref, sub, secs, device FROM board_activity WHERE slug = ? ORDER BY id').bind(slug).all()).results || [];
const lookRow = (id) => env.DB.prepare('SELECT kind, ref, secs FROM board_activity WHERE look = ?').bind(id).first();
const inDays = (n) => new Date(Date.parse(`${todayEastern()}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
async function meeting(days = 5, more = {}) {
  return saveMeeting(env.DB, { ...newMeeting({ date: inDays(days), defaults: { start: '18:00', end: '19:30' } }), shared: true, ...more }, { by: FOUNDER });
}
/** A document on a meeting, the board's to open (or a staff-only one) */
async function fileIn(m, id = 'f_abc123', { staffOnly = false } = {}) {
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, 'meeting', m.id, `board/meeting/${m.id}/${id}`, `${id}.pdf`, 'application/pdf', 10, 'financials', staffOnly ? 1 : 0, new Date().toISOString(), FOUNDER).run();
}
// D1 as it is across the network: each query a few milliseconds, so reports sent at once really overlap
function slow(DB) {
  const pause = () => new Promise((r) => setTimeout(r, 1 + Math.random() * 3));
  const wrap = (st) => ({ bind: (...p) => wrap(st.bind(...p)), first: async (c) => { await pause(); return st.first(c); }, all: async () => { await pause(); return st.all(); }, run: async () => { await pause(); return st.run(); } });
  return { ...DB, prepare: (sql) => wrap(DB.prepare(sql)), batch: (...a) => DB.batch(...a), exec: (...a) => DB.exec(...a) };
}
// Board → Members' summary of everyone (asked for when Members opens)
const overview = async () => (await call(FOUNDER, '/api/board-admin?activity=', { handler: admin.onRequestGet })).body;
// As if the member's last report was a while ago (a report adds no more time than has passed since the last)
const later = (mins = 10) => env.DB.prepare('UPDATE board_activity_reports SET at = ?').bind(new Date(Date.now() - mins * 60_000).toISOString()).run();

test('a sign-in is kept once, at the moment the code was typed, with the device; an admin’s never', async () => {
  assert.equal((await page(MEMBER)).status, 200);
  await page(MEMBER);
  await page(MEMBER, { iat: SIGNED + 120, ua: MAC });
  await page(FOUNDER);
  const s = (await env.DB.prepare('SELECT slug, iat, at, device FROM board_signins ORDER BY iat').all()).results;
  assert.deepEqual(s.map((x) => [x.slug, x.iat, x.device]), [['alex-rivera', SIGNED, 'iPhone · Safari'], ['alex-rivera', SIGNED + 120, 'Mac · Safari']]);
  assert.equal(s[0].at, new Date(SIGNED * 1000).toISOString());
});

test('the tracker’s report: each look by its id with its time so far; sent twice or out of order it changes nothing; junk and files they can’t open are dropped', async () => {
  const m = await meeting();
  await fileIn(m);
  await fileIn(m, 'f_staff01', { staffOnly: true });
  const t = Date.now() - 60_000;
  const r = await post(MEMBER, { action: 'activity', events: [
    { id: 'lookhome01', kind: 'view', ref: 'home', at: t, end: t + 12_000, secs: 12 },
    { id: 'lookmeet01', kind: 'view', ref: `meeting/${m.id}`, at: t + 13_000, end: t + 33_000, secs: 20 },
    { id: 'lookfile01', kind: 'file', ref: 'f_abc123', sub: m.id, at: t + 34_000, end: t + 34_000, secs: 0 },
    { id: 'lookfile01', kind: 'file', ref: 'f_abc123', sub: m.id, at: t + 34_000, end: t + 59_000, secs: 25 },
    { kind: 'video', ref: m.id, at: t + 59_000, secs: 0 },
    { id: 'lookbad001', kind: 'view', ref: 'admin/../../etc', at: t, secs: 5 },
    { id: 'lookbad002', kind: 'view', ref: 'meeting/<script>', at: t, secs: 5 },
    { id: 'lookbad003', kind: 'click', ref: 'home', at: t, secs: 5 },
    { kind: 'view', ref: 'home', at: t, end: t + 5000, secs: 5 },
    { id: 'lookold001', kind: 'view', ref: 'home', at: Date.now() - 3 * 86_400_000, secs: 5 },
    { id: 'lookfake01', kind: 'file', ref: 'f_madeup1', sub: m.id, at: t + 2000, end: t + 3000, secs: 1 },
    { id: 'lookstaff1', kind: 'file', ref: 'f_staff01', sub: m.id, at: t + 2000, end: t + 3000, secs: 1 },
    { id: 'lookppl001', kind: 'view', ref: 'people', at: t + 1000, end: Date.now() + 99_999_000, secs: 99_999 },
  ] });
  assert.equal(r.status, 200);
  const got = await rows('alex-rivera');
  assert.deepEqual(got.map((x) => [x.kind, x.ref, x.secs]), [
    ['view', 'home', 12], ['view', 'people', 13], ['view', `meeting/${m.id}`, 20], ['file', 'f_abc123', 25], ['video', m.id, 0],
  ], 'one row per look; no look runs past the next; no made-up or staff-only file; a look with no id is no look');
  assert.equal(got[0].device, 'iPhone · Safari');
  const total = (list) => list.reduce((n, x) => n + x.secs, 0);
  // Sent again, and an older report of the file arriving late: nothing changes
  await later();
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookhome01', kind: 'view', ref: 'home', at: t, end: t + 12_000, secs: 12 }, { id: 'lookfile01', kind: 'file', ref: 'f_abc123', sub: m.id, at: t + 34_000, end: t + 44_000, secs: 10 }] });
  assert.equal(total(await rows('alex-rivera')), total(got), 'a replay or a late report adds nothing');
  // The file still open: its total grows, never past its own span
  await later();
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookfile01', kind: 'file', ref: 'f_abc123', sub: m.id, at: t + 34_000, end: Date.now(), secs: 500 }] });
  const file = (await rows('alex-rivera')).find((x) => x.kind === 'file');
  assert.ok(file.secs >= 25 && file.secs <= 28, `about the 26 seconds since it was opened (${file.secs})`);
  // A report adds no more time than has passed since the last one (a second tab, a forged report)
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookpar001', kind: 'view', ref: 'documents', at: t + 1000, end: t + 59_000, secs: 58 }] });
  const par = (await rows('alex-rivera')).find((x) => x.ref === 'documents');
  assert.ok(!par || par.secs <= 3, `a report a moment after the last can add only a moment (${par?.secs})`);
  await post(MEMBER, { action: 'activity', events: [{ kind: 'video', ref: m.id, at: Date.now(), secs: 0 }] });
  assert.equal((await rows('alex-rivera')).filter((x) => x.kind === 'video').length, 2, 'a second video click is its own row');
  assert.equal((await post(MEMBER, { action: 'activity', events: [{ id: { toString: 1 }, kind: 'file', ref: { toString: 1 }, sub: { toString: 1 }, at: Date.now(), secs: 1 }] })).status, 200, 'odd values are dropped, never a 500');
});

test('an iPad that says Mac: the page’s touch word makes it an iPad, its sign-in too', async () => {
  await page(MEMBER, { ua: MAC });
  await post(MEMBER, { action: 'activity', touch: true, events: [{ id: 'lookipad01', kind: 'view', ref: 'home', at: Date.now() - 3000, end: Date.now(), secs: 3 }] }, { ua: MAC });
  assert.equal((await rows('alex-rivera'))[0].device, 'iPad · Safari');
  assert.equal((await env.DB.prepare('SELECT device FROM board_signins').first()).device, 'iPad · Safari');
});

test('an admin’s tracker reports are let go; their answers aren’t anyone’s', async () => {
  const m = await meeting();
  const r = await post(FOUNDER, { action: 'activity', events: [{ id: 'lookadmin1', kind: 'view', ref: 'home', at: Date.now(), secs: 9 }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.kept, 0);
  await page(FOUNDER, { query: `?ics=${m.id}` });
  await page(MEMBER);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM board_activity').first()).n, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM board_signins').first()).n, 1, 'only the member’s sign-in');
});

test('answers are kept once they worked: an action item ticked off, a vote (never which way); a refused one isn’t, and the old “will you be there” never is', async () => {
  const m = await meeting(5, { actions: [{ text: 'Call the venue', owner: 'alex-rivera', ownerName: 'Alex Rivera' }, { text: 'Draft the budget', owner: 'sam-ortiz', ownerName: 'Sam Ortiz' }] });
  const [mine, theirs] = m.actions;
  assert.equal((await post(MEMBER, { action: 'action-done', actionId: mine.id, done: true })).status, 200);
  assert.equal((await post(MEMBER, { action: 'action-done', actionId: theirs.id, done: true })).status, 403);
  assert.equal((await post(MEMBER, { action: 'rsvp', meetingId: m.id, answer: 'yes' })).status, 410, 'who’s coming is the calendar invite’s');
  const got = await rows('alex-rivera');
  assert.deepEqual(got.map((x) => [x.kind, x.ref, x.sub]), [['action', mine.id, 'done']], 'only the answer that worked');
  // A vote's row says they voted, never how
  const r = await post(MEMBER, { action: 'vote', meetingId: m.id, motionId: 'mo_1234', vote: 'against' });
  if (r.status === 200) assert.ok(!(await rows('alex-rivera')).some((x) => /against/.test(JSON.stringify(x))));
});

test('the calendar file once it came, and following a meeting only while it’s held (each look adds the time since the last)', async () => {
  const m = await meeting(0, { start: '00:00', end: '23:59' });
  // Not being held: following it isn't anything; a meeting that isn't there isn't either
  await page(MEMBER, { query: `?live=${m.id}` });
  await page(MEMBER, { query: '?ics=m_notthere' });
  await page(MEMBER, { query: '?live=m_notthere' });
  assert.deepEqual((await rows('alex-rivera')).map((x) => x.kind), []);
  await page(MEMBER, { query: `?ics=${m.id}` });
  await patchMeeting(env.DB, m.id, (x) => ({ ...x, live: { ...x.live, startedAt: new Date(Date.now() - 600_000).toISOString() } }));
  // A page in the background: its looks don't count
  await page(MEMBER, { query: `?live=${m.id}` });
  assert.deepEqual((await rows('alex-rivera')).map((x) => x.kind), ['calendar'], 'no one at the page: following it isn’t counted');
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookscrn01', kind: 'view', ref: `screen/${m.id}`, at: Date.now() - 5000, end: Date.now(), secs: 5 }] });
  await page(MEMBER, { query: `?live=${m.id}` });
  // The next look, 20 seconds on
  await env.DB.prepare("UPDATE board_activity SET until = ? WHERE kind = 'live'").bind(new Date(Date.now() - 20_000).toISOString()).run();
  await page(MEMBER, { query: `?live=${m.id}` });
  const got = await rows('alex-rivera');
  assert.deepEqual(got.map((x) => x.kind), ['calendar', 'view', 'live']);
  assert.ok(got[2].secs >= 19 && got[2].secs <= 21, `about 20 seconds of following (${got[2].secs})`);
  const until = (await env.DB.prepare("SELECT until FROM board_activity WHERE kind = 'live'").first()).until;
  assert.ok(Math.abs(Date.parse(until) - Date.now()) < 3000, 'it ends now, not later');
  // Beside the video call, nobody touching the page for ten minutes: in view, it looks every few seconds, and that's
  // following the meeting; a look 20 seconds on with nobody at it isn't
  await env.DB.prepare('UPDATE board_activity_reports SET at = ?').bind(new Date(Date.now() - 10 * 60_000).toISOString()).run();
  const live = async () => Number((await env.DB.prepare("SELECT secs FROM board_activity WHERE kind = 'live'").first()).secs);
  const was = await live();
  for (let i = 0; i < 3; i++) {
    await env.DB.prepare("UPDATE board_activity SET until = ? WHERE kind = 'live'").bind(new Date(Date.now() - 3000).toISOString()).run();
    await page(MEMBER, { query: `?live=${m.id}` });
  }
  assert.ok((await live()) - was >= 8, `three looks a few seconds apart: followed (${(await live()) - was})`);
  const then = await live();
  await env.DB.prepare("UPDATE board_activity SET until = ? WHERE kind = 'live'").bind(new Date(Date.now() - 20_000).toISOString()).run();
  await page(MEMBER, { query: `?live=${m.id}` });
  assert.equal(await live(), then, 'a tab in the background with nobody at the page');
});

test('a slowed background tab following a meeting is one row; no member writes more than 60 new rows a minute', async () => {
  const m = await meeting(0, { start: '00:00', end: '23:59' });
  await patchMeeting(env.DB, m.id, (x) => ({ ...x, live: { ...x.live, startedAt: new Date(Date.now() - 600_000).toISOString() } }));
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookscrn02', kind: 'view', ref: `screen/${m.id}`, at: Date.now() - 5000, end: Date.now(), secs: 5 }] });
  await page(MEMBER, { query: `?live=${m.id}` });
  await env.DB.prepare("UPDATE board_activity SET until = ? WHERE kind = 'live'").bind(new Date(Date.now() - 120_000).toISOString()).run();
  await page(MEMBER, { query: `?live=${m.id}` });
  assert.equal((await rows('alex-rivera')).filter((x) => x.kind === 'live').length, 1, 'a look two minutes on is the same following, not a new row');
  const t = Date.now() - 50_000;
  const many = Array.from({ length: 60 }, (_, i) => ({ kind: 'video', ref: m.id, at: t + i * 100, secs: 0 }));
  await post(MEMBER, { action: 'activity', events: many });
  await post(MEMBER, { action: 'activity', events: many.map((e) => ({ ...e, at: e.at + 10 })) });
  assert.equal((await rows('alex-rivera')).length, 60, 'the 61st new row this minute isn’t kept');
});

test('Print it all is a print of the meeting (Members says they printed them all, never which it drew); notes typed in many saves are one row, and one taken off says so', async () => {
  const m = await meeting();
  await fileIn(m, 'f_doc0001');
  await fileIn(m, 'f_doc0002');
  await fileIn(m, 'f_hidden1', { staffOnly: true });
  // A print of the page (⌘P on the meeting) prints only the agenda: no document counts as opened
  await post(MEMBER, { action: 'activity', events: [{ kind: 'print', ref: m.id, sub: 'page', at: Date.now(), secs: 0 }] });
  assert.deepEqual(Object.keys((await overview()).activity['alex-rivera'].files), []);
  await post(MEMBER, { action: 'activity', events: [{ kind: 'print', ref: m.id, sub: 'all', at: Date.now(), secs: 0 }] });
  await post(MEMBER, { action: 'activity', events: [{ kind: 'print', ref: m.id, sub: 'all', at: Date.now() + 1, secs: 0 }] });
  assert.equal((await rows('alex-rivera')).filter((x) => x.kind === 'print' && x.sub === 'all').length, 1, 'Print it all twice in a moment (a slow packet) is one print');
  const a = (await overview()).activity['alex-rivera'];
  assert.deepEqual(Object.keys(a.files), [], 'no document is written as opened: Board can’t tell which it drew');
  assert.ok(a.printedAll[m.id], 'they printed it all');
  // The chair's note, saved as it's typed, then emptied
  const { noteAnswer } = await import('../functions/api/_board-activity.js');
  const req = new Request('https://x/', { headers: { 'User-Agent': IPHONE } });
  const mem = { slug: 'alex-rivera' };
  const { answerOf: rowOf } = await import('../functions/api/_board-activity.js');
  for (const text of ['A', 'A note', 'A note on it']) await noteAnswer(env, mem, req, rowOf({ action: 'chair-note', meetingId: m.id, itemId: 'i_item001', text }));
  await noteAnswer(env, mem, req, rowOf({ action: 'chair-note', meetingId: m.id, itemId: 'i_item001', text: '' }));
  assert.deepEqual((await rows('alex-rivera')).filter((x) => /note/.test(x.kind)).map((x) => x.kind), ['note', 'unnote'], 'three saves are one note; emptied, it’s taken off');
});

test('a file opened in a tab of its own counts as opened; the viewer’s own fetch doesn’t; a click’s report claims no time; the calendar file once in ten minutes', async () => {
  const m = await meeting();
  await (await import('../functions/api/_board-activity.js')).ensureActivitySchema(env.DB);
  await fileIn(m);
  env.FILES = { get: async () => ({ body: new Uint8Array([37, 80, 68, 70]), size: 4, httpMetadata: { contentType: 'application/pdf' } }) };
  const open = (dest) => call(MEMBER, '/api/board-file?id=f_abc123', { handler: boardFile.onRequestGet, ...(dest ? { headers: { 'Sec-Fetch-Dest': dest } } : {}) });
  await open('');
  assert.equal((await rows('alex-rivera')).length, 0, 'the viewer’s fetch, or a thumbnail: the tracker says what’s read');
  await open('document');
  await open('document');
  assert.deepEqual((await rows('alex-rivera')).map((x) => [x.kind, x.ref]), [['file', 'f_abc123']], 'a new tab, once');
  // A click's report (no look in it) doesn't move the clock a look's next report is measured from
  await env.DB.prepare('INSERT OR REPLACE INTO board_activity_reports (slug, at) VALUES (?, ?)').bind('alex-rivera', new Date(Date.now() - 120_000).toISOString()).run();
  await post(MEMBER, { action: 'activity', events: [{ kind: 'video', ref: m.id, at: Date.now(), secs: 0 }] });
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookmeet77', kind: 'view', ref: `meeting/${m.id}`, at: Date.now() - 110_000, end: Date.now(), secs: 110 }] });
  assert.equal((await rows('alex-rivera')).find((x) => x.ref === `meeting/${m.id}`).secs, 110, 'the look keeps its 110 seconds');
  for (let i = 0; i < 5; i++) await page(MEMBER, { query: `?ics=${m.id}` });
  assert.equal((await rows('alex-rivera')).filter((x) => x.kind === 'calendar').length, 1, 'the calendar file, once');
});

test('the meeting’s screen watched untouched counts only in its own hours; one look twice in a report loses nothing; an id used for something else or a file printed that they can’t open is dropped', async () => {
  // A meeting three days ago, 6 to 7:30 PM: a screen left on through the night after
  const past = await meeting(-3, { start: '18:00', end: '19:30' });
  const t = Date.now() - 100_000;
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookscr901', kind: 'view', ref: `screen/${past.id}`, at: t, end: t + 90_000, secs: 90, touched: 5 }] });
  assert.equal((await rows('alex-rivera')).find((x) => x.ref === `screen/${past.id}`).secs, 5, 'outside its hours: only the touched seconds');
  // Today's meeting, all day: watching counts
  const today = await meeting(0, { start: '00:00', end: '23:59' });
  await later();
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookscr902', kind: 'view', ref: `screen/${today.id}`, at: t, end: t + 90_000, secs: 90, touched: 0 }] });
  assert.equal((await rows('alex-rivera')).find((x) => x.ref === `screen/${today.id}`).secs, 90, 'in its hours: watching is enough');
  // A failed report sent again with the next: the same look twice in one report keeps all its time
  await later();
  const u = Date.now() - 100_000;
  await post(MEMBER, { action: 'activity', events: [
    { id: 'lookdup001', kind: 'view', ref: 'home', at: u, end: u + 60_000, secs: 60 },
    { id: 'lookdup001', kind: 'view', ref: 'home', at: u, end: u + 80_000, secs: 80 },
  ] });
  assert.equal((await lookRow('lookdup001')).secs, 80);
  // An id once used for the home page can't put time on a file; a printed file they can't open isn't kept
  await fileIn(today, 'f_staff09', { staffOnly: true });
  await later();
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookdup001', kind: 'view', ref: 'people', at: u, end: Date.now(), secs: 95 }, { id: 'printx0001', kind: 'print', ref: 'f_staff09', sub: today.id, at: Date.now(), secs: 0 }] });
  assert.equal((await lookRow('lookdup001')).ref, 'home');
  assert.ok(!(await rows('alex-rivera')).some((x) => x.kind === 'print'), 'a staff-only file’s print isn’t kept');
  // A staff-only file can't be named by a print of any other kind either
  for (const sub of ['', 'page', 'all', 'form', 'paper']) await post(MEMBER, { action: 'activity', events: [{ id: `printf${sub || 'x'}01`.slice(0, 12), kind: 'print', ref: 'f_staff09', sub, at: Date.now(), secs: 0 }] });
  assert.ok(!(await rows('alex-rivera')).some((x) => x.kind === 'print'), 'whatever it says it was');
  // A paper written in Board, shared: read and printed. One made up, a meeting made up, a video call of nothing: dropped
  const paper = await saveDoc(env.DB, { title: 'Board Member Expectations', body: 'Come to the meetings.', sign: true, shared: true }, { by: FOUNDER });
  const hidden = await saveDoc(env.DB, { title: 'Draft policy', body: 'Not yet.', shared: false }, { by: FOUNDER });
  await later();
  await post(MEMBER, { action: 'activity', events: [
    { id: 'lookpap001', kind: 'view', ref: `paper/${paper.id}`, at: Date.now() - 40_000, end: Date.now(), secs: 40 },
    { id: 'printp0001', kind: 'print', ref: paper.id, sub: 'paper', at: Date.now(), secs: 0 },
    { id: 'lookpap002', kind: 'view', ref: 'paper/d_notreal', at: Date.now() - 1000, end: Date.now(), secs: 1 },
    { id: 'lookpap003', kind: 'view', ref: `paper/${hidden.id}`, at: Date.now() - 1000, end: Date.now(), secs: 1 },
    { id: 'lookrev001', kind: 'view', ref: 'review/m_notreal', at: Date.now() - 1000, end: Date.now(), secs: 1 },
    { id: 'lookmtg001', kind: 'view', ref: 'meeting/m_notreal', at: Date.now() - 1000, end: Date.now(), secs: 1 },
    { id: 'video00001', kind: 'video', ref: 'zzzzzzzz', at: Date.now(), secs: 0 },
    { id: 'printm0001', kind: 'print', ref: 'm_notreal', sub: 'all', at: Date.now(), secs: 0 },
  ] });
  assert.deepEqual((await rows('alex-rivera')).filter((x) => x.ref.includes(paper.id) || x.kind === 'print' || /notreal|zzz|d_/.test(x.ref)).map((x) => [x.kind, x.ref, x.sub, x.secs]),
    [['view', `paper/${paper.id}`, '', 40], ['print', paper.id, 'paper', 0]], 'a paper written in Board: read, and printed; nothing made up is kept');
  // The chair's review comes before the board has the meeting: it counts for a meeting that's there
  const ahead = await meeting(9, { shared: false });
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookrev002', kind: 'view', ref: `review/${ahead.id}`, at: Date.now() - 1000, end: Date.now(), secs: 1 }, { id: 'lookmtg002', kind: 'view', ref: `meeting/${ahead.id}`, at: Date.now() - 500, end: Date.now(), secs: 1 }] });
  assert.deepEqual((await rows('alex-rivera')).filter((x) => x.ref.includes(ahead.id)).map((x) => x.ref), [`review/${ahead.id}`], 'its review, never its page before the board has it');
});

test('votes and action items: one row per answer, however often it’s changed; answers keep to the 60-a-minute cap', async () => {
  const m = await meeting();
  const { noteAnswer, answerOf: rowOf } = await import('../functions/api/_board-activity.js');
  const req = new Request('https://x/', { headers: { 'User-Agent': IPHONE } });
  const mem = { slug: 'alex-rivera' };
  for (const vote of ['for', 'against', 'for']) await noteAnswer(env, mem, req, rowOf({ action: 'vote', meetingId: m.id, motionId: 'mo_123456', vote }));
  for (const done of [true, false, true, false]) await noteAnswer(env, mem, req, rowOf({ action: 'action-done', actionId: 'a_123456', done }));
  const got = await rows('alex-rivera');
  assert.deepEqual(got.map((x) => [x.kind, x.sub]), [['vote', 'mo_123456'], ['action', 'open']], 'one vote (never how, nor that it changed); the action item as it was left');
  // "Nothing new" in a report's place says so; a report emptied while typing is nothing yet; a motion rewritten is one
  await noteAnswer(env, mem, req, rowOf({ action: 'report', meetingId: m.id, itemId: 'i_item002', text: NOTHING_NEW }));
  await noteAnswer(env, mem, req, rowOf({ action: 'report', meetingId: m.id, itemId: 'i_item003', text: '  ' }));
  for (const text of ['To approve the budget', 'To approve the 2027 budget']) await noteAnswer(env, mem, req, rowOf({ action: 'motion', meetingId: m.id, itemId: 'i_item002', text }));
  assert.deepEqual((await rows('alex-rivera')).slice(2).map((x) => [x.kind, x.sub]), [['nothing', 'i_item002'], ['motion', 'i_item002']]);
  await noteAnswer(env, mem, req, rowOf({ action: 'detach', meetingId: m.id, itemId: 'i_item009', fileId: 'f_abc123' }));
  assert.deepEqual((await rows('alex-rivera')).at(-1), { kind: 'detach', ref: m.id, sub: 'i_item009', secs: 0, device: 'iPhone · Safari' }, 'a document taken off: the item it came off');
  for (let i = 0; i < 70; i++) await noteAnswer(env, mem, req, rowOf({ action: 'sign', docId: `d_${String(i).padStart(6, '0')}` }));
  assert.ok((await rows('alex-rivera')).length <= 60, 'no more than 60 new rows a minute');
});

test('the chair’s Approve is theirs only when it approved: never an agenda someone approved first, nor in test mode', async () => {
  const m = await meeting(5, { shared: false });
  await page(MEMBER);
  const t = await post(MEMBER, { action: 'chair-approve', meetingId: m.id });
  assert.equal(t.status, 200);
  assert.equal(t.body.test, true, 'test mode: the note as it would go, nothing kept');
  await writeState(env.DB, 'settings', { asks: 'on' });
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO board_asks (id, kind, meeting_id, item_id, slug, name, email, title, status, asked_at, in_at, msg_ids, files, updated_at)
    VALUES ('ask_first1', 'chair', ?, '', 'jane-doe', 'Jane Doe', ?, '', 'approved', ?, ?, '[]', '[]', ?)`).bind(m.id, FOUNDER, at, at, at).run();
  const r = await post(MEMBER, { action: 'chair-approve', meetingId: m.id });
  assert.equal(r.body.already, true);
  assert.ok(!(await rows('alex-rivera')).some((x) => x.kind === 'approve'), 'neither is something Alex did');
});

test('reports sent all at once share the time since the last, never adding it each', async () => {
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookfirst1', kind: 'view', ref: 'people', at: Date.now() - 1000, end: Date.now(), secs: 1 }] });
  await later(2);
  const t = Date.now() - 110_000;
  await Promise.all(Array.from({ length: 25 }, (_, i) => post(MEMBER, { action: 'activity', events: [{ id: `lookpar${String(i).padStart(3, '0')}`, kind: 'view', ref: 'home', at: t, end: Date.now(), secs: 110 }] })));
  const total = (await rows('alex-rivera')).filter((x) => x.ref === 'home').reduce((n, x) => n + x.secs, 0);
  assert.ok(total <= 122, `two minutes since the last report: at most that much, however many came at once (${total})`);
  assert.ok(total >= 100, `and the time that did pass is kept (${total})`);
});

test('the next meeting’s documents as the board page lists them: two formats are one, the last minutes with their item, opened when either copy was', () => {
  const pdf = { id: 'f_bud001', name: '2027 Budget.pdf', type: 'application/pdf' };
  const xls = { id: 'f_bud002', name: '2027 Budget.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  const stat = { id: 'f_sta001', name: 'September statements.pdf', type: 'application/pdf' };
  const pay = { id: 'f_pay001', name: 'Salaries.pdf', type: 'application/pdf', staffOnly: true };
  const mins = { id: 'f_min001', name: 'Q3 minutes.pdf', type: 'application/pdf', kind: 'minutes' };
  const next = { id: 'm_next01', files: [pdf, xls, stat, pay], sections: [{ items: [{ id: 'i_min001', title: 'Approve the minutes', live: 'minutes', about: 'm_prev01' }, { id: 'i_fin001', title: 'Finance', docs: [pdf.id, xls.id, stat.id, pay.id] }] }] };
  const meetings = [next, { id: 'm_prev01', files: [mins], sections: [] }];
  const reads = readOf(next, { files: { [xls.id]: 30, [mins.id]: 150 } }, meetings);
  assert.deepEqual(reads.map((x) => [x.d.title, x.secs]), [['Q3 minutes', 150], ['2027 Budget', 30], ['September statements', null]]);
  assert.equal(docsLine(reads), 'Opened 2 of 3 documents');
  assert.equal(docsLine(reads, true), 'Opened 2 of 3 documents, printed them all');
  assert.equal(docsLine(readOf(next, null, meetings), true), 'Printed them all');
  assert.equal(docsLine(readOf(next, null, meetings)), 'Hasn’t opened the 3 documents');
  assert.equal(docsLine(readOf(next, { files: { [pdf.id]: 5, [stat.id]: 9, [mins.id]: 1 } }, meetings)), 'Opened all 3 documents');
});

test('nothing a member makes up is kept: opens dated before their last report, the screen’s time without the tracker’s own count, a review that isn’t the chair’s of a meeting ahead, another meeting’s item, more than a day’s rows; reports seconds apart add only those seconds', async () => {
  const m = await meeting();
  await fileIn(m);
  await page(MEMBER);
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookhome20', kind: 'view', ref: 'home', at: Date.now() - 30_000, end: Date.now(), secs: 30 }] });
  // Opens dated last night: none kept; the look that's been going on carries on
  const night = Date.now() - 20 * 3_600_000;
  await later(1);
  await post(MEMBER, { action: 'activity', events: [
    { id: 'looknight1', kind: 'file', ref: 'f_abc123', sub: m.id, at: night, end: night, secs: 0 },
    { id: 'printnight', kind: 'print', ref: m.id, sub: 'all', at: night, secs: 0 },
    { id: 'lookhome20', kind: 'view', ref: 'home', at: Date.now() - 90_000, end: Date.now(), secs: 90 },
  ] });
  assert.ok(!(await lookRow('looknight1')) && !(await lookRow('printnight')), 'an open and a print dated the night before');
  assert.equal((await lookRow('lookhome20')).secs, 90, 'a look already going carries on');
  // Reports five seconds apart: five seconds each, never a grace on top
  await env.DB.prepare('UPDATE board_activity_reports SET at = ?').bind(new Date(Date.now() - 5000).toISOString()).run();
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookfast01', kind: 'view', ref: 'people', at: Date.now() - 60_000, end: Date.now(), secs: 60 }] });
  assert.ok((await lookRow('lookfast01')).secs <= 5, `${(await lookRow('lookfast01')).secs}`);
  // The screen of a meeting long over, its seconds not counted as touched: none
  const past = await meeting(-3, { start: '18:00', end: '19:30' });
  await later();
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookscr903', kind: 'view', ref: `screen/${past.id}`, at: Date.now() - 60_000, end: Date.now(), secs: 60 }] });
  assert.equal((await lookRow('lookscr903')).secs, 0);
  // The agenda's review: the chair's, of a board meeting ahead. A report page: an item of that meeting
  const ahead = await meeting(9, { shared: false });
  const staff = await meeting(9, { shared: false, notBoard: true });
  const mine = m.sections.flatMap((x) => x.items)[0].id;
  const theirs = ahead.sections.flatMap((x) => x.items)[0].id;
  await later();
  await post(OTHER, { action: 'activity', events: [{ id: 'lookrev101', kind: 'view', ref: `review/${ahead.id}`, at: Date.now() - 5000, end: Date.now(), secs: 5 }] });
  await post(MEMBER, { action: 'activity', events: [
    { id: 'lookrev102', kind: 'view', ref: `review/${past.id}`, at: Date.now() - 9000, end: Date.now() - 8000, secs: 1 },
    { id: 'lookrev103', kind: 'view', ref: `review/${staff.id}`, at: Date.now() - 7000, end: Date.now() - 6000, secs: 1 },
    { id: 'lookrev104', kind: 'view', ref: `review/${ahead.id}`, at: Date.now() - 5000, end: Date.now() - 4000, secs: 1 },
    { id: 'lookrep101', kind: 'view', ref: `report/${m.id}/${theirs}`, at: Date.now() - 3000, end: Date.now() - 2000, secs: 1 },
    { id: 'lookrep102', kind: 'view', ref: `report/${m.id}/${mine}`, at: Date.now() - 1000, end: Date.now(), secs: 1 },
  ] });
  assert.deepEqual(await Promise.all(['lookrev101', 'lookrev102', 'lookrev103', 'lookrev104', 'lookrep101', 'lookrep102'].map(async (id) => !!(await lookRow(id)))),
    [false, false, false, true, false, true], 'the treasurer; a meeting held; a staff meeting; the chair’s; another meeting’s item; its own');
  // A day's worth of rows: no more today
  await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
    INSERT INTO board_activity (slug, kind, ref, sub, secs, at, until, device, added) SELECT 'alex-rivera', 'view', 'home', '', 1, ?, ?, '', ? FROM n`)
    .bind(new Date(Date.now() - 7_200_000).toISOString(), new Date(Date.now() - 7_200_000).toISOString(), new Date(Date.now() - 7_200_000).toISOString()).run();
  await later();
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookfull01', kind: 'view', ref: 'people', at: Date.now() - 5000, end: Date.now(), secs: 5 }] });
  assert.ok(!(await lookRow('lookfull01')), '1,500 rows in a day is the most');
});

test('an earlier copy of a paper is named as one; Print it all counts for the documents there when it printed', async () => {
  const paper = await saveDoc(env.DB, { title: 'Conflict of Interest Policy', kind: 'policy', shared: true }, { by: FOUNDER });
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('f_old111', 'doc', paper.id, 'board/doc/x', 'COI 2025.pdf', 'application/pdf', 10, '', 0, new Date().toISOString(), FOUNDER).run();
  await page(MEMBER);
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookold111', kind: 'file', ref: 'f_old111', at: Date.now() - 40_000, end: Date.now(), secs: 40 }] });
  const got = (await call(FOUNDER, '/api/board-admin?activity=alex-rivera', { handler: admin.onRequestGet })).body;
  assert.deepEqual(got.files.f_old111, { name: 'COI 2025.pdf', ownerType: 'doc', ownerId: paper.id });
  const L = namesFrom({ meetings: [], docs: [{ id: paper.id, title: 'Conflict of Interest Policy', file: { id: 'f_new222', name: 'COI 2026.pdf' } }] }, got.files);
  assert.equal(said(got.events[0], L).text, 'Read an earlier copy of “Conflict of Interest Policy”');
  const reads = [{ d: { copies: [{ at: '2026-11-01T10:00:00.000Z' }] } }, { d: { copies: [{ at: '2026-11-03T10:00:00.000Z' }] } }];
  assert.equal(cameAfter(reads, '2026-11-02T10:00:00.000Z'), 1, 'one came after the print');
  assert.equal(cameAfter(reads, '2026-11-04T10:00:00.000Z'), 0, 'printed them all');
  assert.equal(cameAfter(reads, null), null);
});

test('a page name has no room for more; reports at once never pass the 60-a-minute cap; a screen left on elsewhere lasts as long as it counted and takes no time from the device in use; a connection that dropped a while keeps its reading', async () => {
  const m = await meeting();
  await page(MEMBER);
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookbig001', kind: 'view', ref: `home//${'x'.repeat(200_000)}`, at: Date.now() - 5000, end: Date.now(), secs: 5 }] });
  assert.ok(!(await lookRow('lookbig001')), 'a page name with more on it');
  // 20 reports of 60 new looks each, all at once
  const quick = env.DB;
  env.DB = slow(quick);
  await Promise.all(Array.from({ length: 20 }, (_, j) => post(MEMBER, { action: 'activity', events: Array.from({ length: 60 }, (_, i) => ({ id: `lookcap${String(j).padStart(2, '0')}${String(i).padStart(2, '0')}`, kind: 'view', ref: i % 2 ? 'home' : 'people', at: Date.now() - 50_000 + i * 500, end: Date.now() - 50_000 + i * 500 + 400, secs: 0 })) })));
  env.DB = quick;
  const n = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM board_activity WHERE slug = ?').bind('alex-rivera').first()).n);
  assert.ok(n <= 60, `however many come at once (${n})`);
  await env.DB.prepare("DELETE FROM board_activity WHERE look LIKE 'lookcap%'").run();
  // The screen of a meeting held days ago, left on in another room all night: it lasted as long as it counted, and
  // the phone reading just now keeps all its minutes
  const past = await meeting(-3, { start: '18:00', end: '19:30' });
  await later(10);
  const t = Date.now() - 300_000;
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookscr950', kind: 'view', ref: `screen/${past.id}`, at: t, end: Date.now(), secs: 300, touched: 0 }] });
  const scr = await env.DB.prepare('SELECT at, until, secs FROM board_activity WHERE look = ?').bind('lookscr950').first();
  assert.equal(scr.secs, 0);
  assert.equal(scr.until, scr.at, 'never “on the board page” all that while');
  await post(MEMBER, { action: 'activity', ua: MAC, events: [{ id: 'lookphone1', kind: 'view', ref: 'people', at: t, end: Date.now(), secs: 300 }] });
  assert.equal((await lookRow('lookphone1')).secs, 300, 'the screen took none of it');
  // Offline four minutes in the middle of reading: the time comes in when the connection's back
  await later(8);
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookoff001', kind: 'view', ref: `meeting/${m.id}`, at: Date.now() - 450_000, end: Date.now(), secs: 450 }] });
  assert.equal((await lookRow('lookoff001')).secs, 450);
});

test('a first visit offline for its first twelve minutes still counts; a board member’s new web address takes their activity with them; an upload is what the board page did with it', async () => {
  await page(OTHER);
  await post(OTHER, { action: 'activity', events: [{ id: 'lookfirst9', kind: 'view', ref: 'home', at: Date.now() - 12 * 60_000, end: Date.now(), secs: 700 }] });
  assert.equal((await lookRow('lookfirst9')).secs, 700, 'no report before: the half hour holds');
  await page(MEMBER);
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookren001', kind: 'view', ref: 'home', at: Date.now() - 20_000, end: Date.now(), secs: 20 }] });
  const r = await rename(env, { collection: 'team', from: 'alex-rivera', to: 'alex-rivera-smith' }, FOUNDER, async () => new Response('{}'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = (await overview()).activity;
  assert.ok(a['alex-rivera-smith']?.signIns === 1 && !a['alex-rivera'], 'their sign-in and what they did, under the new address');
  const { answerOf: rowOf } = await import('../functions/api/_board-activity.js');
  assert.equal(rowOf(null, new URLSearchParams('signed=d_123456&attach=m_abc123&item=i_def456')).kind, 'sign', 'a signed copy is a signature, whatever else the address says');
});

test('a screen opened hours early lasts until its meeting’s hours end; a page on since before the half hour counts from then; a former member’s address is never handed on', async () => {
  const hm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  const nowHm = hm(Date.now());
  let start = hm(Date.now() - 20 * 60_000);
  let end = hm(Date.now() + 60 * 60_000);
  if (start > nowHm) start = '00:00';
  if (end < nowHm) end = '23:59';
  const m = await meeting(0, { start, end });
  await page(MEMBER);
  // Opened two hours ago (an earlier report kept it), left on, nobody touching it
  const at = Date.now() - 2 * 3_600_000;
  await env.DB.prepare('INSERT INTO board_activity (slug, kind, ref, sub, secs, at, until, device, look, added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('alex-rivera', 'view', `screen/${m.id}`, '', 180, new Date(at).toISOString(), new Date(at + 180_000).toISOString(), 'Mac · Safari', 'lookscr777', new Date(at).toISOString()).run();
  await later(30);
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookscr777', kind: 'view', ref: `screen/${m.id}`, at, end: Date.now(), secs: 7200, touched: 0 }] });
  const row = await env.DB.prepare('SELECT secs, until FROM board_activity WHERE look = ?').bind('lookscr777').first();
  assert.ok(Math.abs(Date.parse(row.until) - Date.now()) < 5000, `on until now, in the meeting’s hours (${row.until})`);
  assert.ok(row.secs > 180, `and its time in them counts (${row.secs})`);
  // Sam's first visit: the page open since 35 minutes ago, offline all that while; from half an hour ago on, it counts
  await page(OTHER);
  await post(OTHER, { action: 'activity', events: [{ id: 'lookfirst8', kind: 'view', ref: 'home', at: Date.now() - 35 * 60_000, end: Date.now(), secs: 2100 }] });
  const first = await env.DB.prepare('SELECT secs, at FROM board_activity WHERE look = ?').bind('lookfirst8').first();
  assert.ok(first && first.secs <= 1800 && first.secs >= 1790 && Date.parse(first.at) >= Date.now() - 30 * 60_000 - 5000, JSON.stringify(first));
  // Sam leaves the board (People keeps their board records); Alex can't be given Sam's address
  await env.DB.prepare("DELETE FROM team WHERE slug = 'sam-ortiz'").run();
  const r = await rename(env, { collection: 'team', from: 'alex-rivera', to: 'sam-ortiz' }, FOUNDER, async () => new Response('{}'));
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /board member’s address/);
});

test('a phone’s clock that’s off is set right by its own time', async () => {
  const fast = Date.now() + 10 * 60_000;
  const r = await post(MEMBER, { action: 'activity', now: fast, events: [{ id: 'lookfast01', kind: 'view', ref: 'home', at: fast - 30_000, end: fast, secs: 25 }] });
  assert.equal(r.body.kept, 1, 'ten minutes fast: kept, not dropped');
  const row = await env.DB.prepare('SELECT at FROM board_activity').first();
  assert.ok(Math.abs(Date.parse(row.at) - (Date.now() - 30_000)) < 3000, 'at the real time');
});

test('Board → Members: each member’s summary (sign-ins, last on, the device, days, files) and their own sheet; only the board’s', async () => {
  const m = await meeting();
  await page(MEMBER);
  await fileIn(m);
  await post(MEMBER, { action: 'activity', events: [{ id: 'lookhome09', kind: 'view', ref: 'home', at: Date.now() - 200_000, end: Date.now() - 100_000, secs: 60 }, { id: 'lookfile09', kind: 'file', ref: 'f_abc123', sub: m.id, at: Date.now() - 95_000, end: Date.now(), secs: 40 }] });
  const all = await call(FOUNDER, '/api/board-admin?activity=', { handler: admin.onRequestGet });
  assert.equal(all.status, 200);
  assert.equal((await call(FOUNDER, '/api/board-admin', { handler: admin.onRequestGet })).body.activity, undefined, 'Board’s other tabs never work it out');
  const a = all.body.activity['alex-rivera'];
  assert.equal(a.signIns, 1);
  assert.equal(a.device, 'iPhone · Safari');
  assert.equal(a.files.f_abc123, 40);
  assert.equal(a.days[todayEastern()], 100);
  assert.equal(a.visits35, 1);
  assert.equal(all.body.activity['sam-ortiz'], undefined, 'Sam: nothing yet');
  const one = await call(FOUNDER, '/api/board-admin?activity=alex-rivera', { handler: admin.onRequestGet });
  assert.equal(one.body.signIns.length, 1);
  assert.deepEqual(one.body.events.map((e) => e.kind), ['file', 'view']);
  assert.equal((await call(FOUNDER, '/api/board-admin?activity=jane-doe', { handler: admin.onRequestGet })).status, 404, 'staff aren’t on it');
  assert.equal((await call(MEMBER, '/api/board-admin?activity=alex-rivera', { handler: admin.onRequestGet })).status, 403, 'a member can’t read it, their own included');
});

test('Board began keeping sign-ins when it first wrote one, not when an older sign-in happened; a clock a few seconds off is set right', async () => {
  // A sign-in typed nine days ago, first seen now
  await page(MEMBER, { iat: Math.floor(Date.now() / 1000) - 9 * 86_400 });
  const body = await overview();
  const a = body.activity['alex-rivera'];
  assert.ok(body.activityBegan > a.firstSignIn, 'Board began now, after the sign-in it first saw');
  assert.equal(a.signInsSince, 0, 'no sign-in since it began');
  // 25 seconds fast: a 20-second read stays 20 seconds
  const fast = Date.now() + 25_000;
  await post(MEMBER, { action: 'activity', now: fast, events: [{ id: 'lookfast25', kind: 'view', ref: 'home', at: fast - 20_000, end: fast, secs: 20 }] });
  assert.equal((await rows('alex-rivera')).find((x) => x.ref === 'home').secs, 20);
});

test('devices, sign-in times, pages a tracker may name, and sittings', () => {
  assert.equal(deviceOf(IPHONE), 'iPhone · Safari');
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Windows · Edge');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'), 'Android phone · Chrome');
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/340.0 Mobile/15E148 Safari/604.1'), 'iPhone · the Google app');
  assert.equal(deviceOf(''), 'A browser');
  assert.equal(accessIat(new Request('https://x.test/', { headers: { Cookie: `a=1; CF_Authorization=x.${b64u(JSON.stringify({ iat: 1790000000 }))}.y` } })), 1790000000);
  assert.equal(accessIat(new Request('https://x.test/')), null);
  for (const ok of ['home', 'meetings', 'meeting/m_abc123', 'screen/m_abc123', 'report/m_abc123/i_def456', 'gifts', 'documents']) assert.ok(pageOk(ok), ok);
  for (const bad of ['', 'home/x', 'meeting/', 'meeting/m_abc/extra', 'report/m_abc123', 'settings', 'meeting/<x>']) assert.ok(!pageOk(bad), bad);
  const t = Date.parse('2026-11-01T14:00:00Z');
  assert.equal(visitsOf([{ at: t, until: t + 60_000, secs: 60 }, { at: t + 20 * 60_000, until: t + 21 * 60_000, secs: 60 }, { at: t + 3 * 3600_000, until: t + 3 * 3600_000, secs: 0 }]).length, 2);
});

test('the board page’s tracker: the page’s name, the time while someone is there, a file in the viewer, pausing when idle or hidden', () => {
  assert.equal(pageOf('#/'), 'home');
  assert.equal(pageOf(''), 'home');
  assert.equal(pageOf('#/reveals'), 'home');
  assert.equal(pageOf('#/meetings'), 'meetings');
  assert.equal(pageOf('#/meetings/m_abc123'), 'meeting/m_abc123');
  assert.equal(pageOf('#/meetings/m_abc123/screen?at=x'), 'screen/m_abc123');
  assert.equal(pageOf('#/meetings/m_abc123/report/i_def456'), 'report/m_abc123/i_def456');
  assert.equal(pageOf('#/financials/gifts'), 'gifts');
  assert.equal(pageOf('#/meetings/m_abc123/review'), 'review/m_abc123', 'the chair’s review of the agenda');
  assert.equal(pageOf('#/documents/d_123456'), 'paper/d_123456', 'a paper written in Board, on its own page');
  assert.equal(pageOf('#/documents/<x>'), null);
  assert.equal(pageOf('#/settings'), null);
  assert.ok(pageOk('paper/d_123456') && pageOk('review/m_abc123') && !pageOk('paper/') && !pageOk('paper/d_123456/x'));
  assert.ok(!pageOk('home//x') && !pageOk('report/m_abc123/i_def456/x') && !pageOk('meetings/'), 'a page is exactly its parts');

  let clock = 1_000_000;
  const listeners = {};
  const doc = {
    visibilityState: 'visible', viewer: '',
    querySelector: (sel) => (sel.includes('.fv-newtab') && doc.viewer ? { getAttribute: () => doc.viewer } : sel.includes('.fv-card') ? doc.card || null : null),
    addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: () => {},
  };
  const win = { location: { hash: '#/', search: '' }, navigator: { maxTouchPoints: 0 }, addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: () => {}, setInterval: () => 0, clearInterval: () => {} };
  const sent = [];
  const tr = startTracking({ win, doc, send: (events) => sent.push(...events), now: () => clock });
  const secs = (n) => { for (let i = 0; i < n; i++) { clock += 1000; tr.tick(); } };
  secs(10);
  win.location.hash = '#/meetings/m_abc123';
  secs(5);
  doc.viewer = '/api/board-file?id=f_abc123';
  tr.tick();
  assert.deepEqual(sent.map((e) => [e.kind, e.ref, e.secs]), [['view', 'home', 10], ['view', 'meeting/m_abc123', 4], ['file', 'f_abc123', 0]], 'each look from the second after it starts; a file counts as opened at once');
  secs(8);
  // No touch for over three minutes: the time stops
  secs(200);
  listeners.pointerdown();
  secs(4);
  doc.viewer = '';
  tr.tick();
  // The tab in the background: nothing counts
  doc.visibilityState = 'hidden';
  secs(30);
  doc.visibilityState = 'visible';
  listeners.keydown();
  secs(3);
  tr.flush();
  const file = sent.filter((e) => e.kind === 'file').reduce((t, e) => t + e.secs, 0);
  // 8 s, then on until three minutes after the last touch (156 s more), then 4 s after a new touch
  assert.equal(file, 8 + 156 + 4, 'the file: while someone was there (up to three minutes without a touch)');
  assert.equal(sent.filter((e) => e.kind === 'view' && e.ref === 'meeting/m_abc123').reduce((t, e) => t + e.secs, 0), 4 + 3, 'the background minutes never count');
  assert.equal(startTracking({ win: { ...win, location: { hash: '#/', search: '?present' } }, doc }), null, 'an admin presenting isn’t tracked');
  // The window beside another app (not the one they're at), the mouse passing over it: nothing counts; the screen still does
  sent.length = 0;
  doc.hasFocus = () => false;
  listeners.pointerdown();
  secs(20);
  win.location.hash = '#/meetings/m_abc123/screen';
  secs(1);
  secs(10);
  tr.flush();
  assert.equal(sent.filter((e) => e.ref === 'meeting/m_abc123').reduce((t, e) => Math.max(t, e.secs), 0), 0, 'a page not in the window they’re at');
  assert.equal(sent.filter((e) => e.ref === 'screen/m_abc123').reduce((t, e) => Math.max(t, e.secs), 0), 10, 'a meeting’s screen is watched');
  delete doc.hasFocus;
  win.location.hash = '#/meetings/m_abc123';
  tr.tick();
  // A recording playing in the viewer, hands off for ten minutes: watched all the while; paused, the time stops
  sent.length = 0;
  doc.viewer = '/api/board-file?id=f_vid0001';
  const video = { paused: false, ended: false };
  doc.querySelectorAll = (sel) => (sel === '.fv video' ? [video] : []);
  tr.tick();
  secs(600);
  video.paused = true;
  secs(300);
  tr.flush();
  assert.equal(sent.filter((e) => e.ref === 'f_vid0001').reduce((t, e) => Math.max(t, e.secs), 0), 600, 'a video watched to its pause');
  delete doc.querySelectorAll;
  doc.viewer = '';
  listeners.keydown();
  tr.tick();
  // Away five minutes or more (the tab in the background), it's a new look once they're back; a click the page made itself isn't theirs
  sent.length = 0;
  const looks = () => [...new Set(sent.filter((e) => e.kind === 'view').map((e) => e.at))].length;
  secs(5);
  doc.visibilityState = 'hidden';
  secs(400);
  doc.visibilityState = 'visible';
  listeners.keydown();
  secs(5);
  tr.flush();
  assert.equal(looks(), 2, 'before and after the time away are two looks');
  // The computer asleep all night (no ticks at all): the first second after it wakes starts a new look
  sent.length = 0;
  secs(3);
  clock += 10 * 3600_000;
  listeners.keydown();
  secs(3);
  tr.flush();
  assert.equal(looks(), 2, 'the evening and the morning are two looks');
  const last = sent.filter((e) => e.kind === 'view').at(-1);
  assert.ok(last.end - last.at < 10_000, 'the morning look ends in the morning, not spanning the night');
  sent.length = 0;
  win.location.hash = '#/meetings/m_abc123/screen';
  secs(600);
  tr.flush();
  assert.ok(sent.filter((e) => e.ref === 'screen/m_abc123').reduce((t, e) => Math.max(t, e.secs), 0) >= 590, 'ten minutes watching the screen, untouched, are ten minutes');
  sent.length = 0;
  listeners.beforeprint();
  assert.deepEqual(sent.filter((e) => e.kind === 'print').map((e) => e.sub), ['page'], '⌘P on a page is a print of the page');
  doc.documentElement = { classList: { contains: (c) => c === 'bp-printing-all' } };
  listeners.beforeprint();
  assert.equal(sent.filter((e) => e.kind === 'print').at(-1).sub, 'all', 'Print it all, told by what the page put up');
  doc.documentElement = { classList: { contains: (c) => c === 'mt-printing' } };
  listeners.beforeprint();
  assert.equal(sent.filter((e) => e.kind === 'print').at(-1).sub, 'form', 'the secretary’s minutes form');
  doc.documentElement = null;
  win.location.hash = '#/documents/d_123456';
  listeners.beforeprint();
  assert.deepEqual([sent.filter((e) => e.kind === 'print').at(-1)].map((e) => [e.ref, e.sub])[0], ['d_123456', 'paper'], 'a paper written in Board');
  sent.length = 0;
  win.location.hash = '#/meetings/m_abc123';
  doc.viewer = '/api/board-file?id=f_old0001';
  doc.card = {};
  secs(30);
  tr.flush();
  assert.equal(sent.filter((e) => e.ref === 'f_old0001').reduce((t, e) => Math.max(t, e.secs), 0), 0, 'a file the viewer can’t show: opened, never read');
  doc.card = null;
  doc.viewer = '';
  sent.length = 0;
  // A tap the page passed on itself (during a page change) to the video link is still theirs
  listeners.click({ isTrusted: false, target: { closest: (sel) => (sel === 'a[href]' ? { href: 'https://meet.google.com/abc-defg-hij', closest: () => null, hasAttribute: () => false, getAttribute: () => '' } : null) } });
  tr.flush();
  assert.equal(sent.filter((e) => e.kind === 'video').length, 1, 'the video call, however the tap came');
});

test('Members’ words for what someone did, and their sittings', () => {
  const m = { id: 'm_abc123', date: '2026-11-05', title: '', files: [{ id: 'f_abc123', name: 'September financial statements.pdf' }], sections: [{ items: [{ id: 'i_def456', title: 'Finance report' }] }], actions: [{ id: 'a_123456', text: 'Send the venue contract' }], motions: [] };
  const L = namesFrom({ meetings: [m], docs: [{ id: 'd_123456', title: 'Conflict of Interest Policy', file: null }] });
  assert.match(said({ kind: 'file', ref: 'f_abc123', secs: 40 }, L).text, /^Read “September financial statements”$/);
  assert.match(said({ kind: 'file', ref: 'f_abc123', secs: 2 }, L).text, /^Opened “September financial statements”$/, 'a flip past it is only opened');
  assert.match(said({ kind: 'file', ref: 'f_gone00' }, L).text, /a file since removed/);
  assert.match(said({ kind: 'view', ref: 'meeting/m_abc123' }, L).text, /^Looked at the Q4 2026 Board Meeting$/);
  assert.match(said({ kind: 'view', ref: 'report/m_abc123/i_def456' }, L).text, /report page for “Finance report”/);
  assert.match(said({ kind: 'checkin', ref: 'm_abc123', sub: 'remote' }, L).text, /^Checked in at the Q4 2026 Board Meeting, on video$/);
  assert.match(said({ kind: 'sign', ref: 'd_123456' }, L).text, /Signed “Conflict of Interest Policy”/);
  assert.match(said({ kind: 'view', ref: 'paper/d_123456', secs: 90 }, L).text, /^Read “Conflict of Interest Policy”$/);
  assert.match(said({ kind: 'view', ref: 'paper/d_123456', secs: 3 }, L).text, /^Opened “Conflict of Interest Policy”$/);
  assert.match(said({ kind: 'view', ref: 'paper/d_gone00' }, L).text, /a paper since removed/);
  assert.match(said({ kind: 'print', ref: 'd_123456', sub: 'paper' }, L).text, /^Printed “Conflict of Interest Policy”$/);
  assert.match(said({ kind: 'view', ref: 'review/m_abc123' }, L).text, /^Looked over the agenda of the Q4 2026 Board Meeting, to approve it$/);
  assert.match(said({ kind: 'nothing', ref: 'm_abc123', sub: 'i_def456' }, L).text, /^Said there’s nothing new to report on “Finance report”$/);
  assert.match(said({ kind: 'motion', ref: 'm_abc123', sub: 'i_def456' }, L).text, /^Wrote the motion on “Finance report” for the board to vote on$/);
  assert.match(said({ kind: 'action', ref: 'a_123456', sub: 'done' }, L).text, /Checked off “Send the venue contract”/);
  assert.match(said({ kind: 'vote', ref: 'm_abc123', sub: 'mo_1' }, L).text, /^Voted on a motion at the Q4/);
  assert.match(said({ kind: 'print', ref: 'm_abc123', sub: 'all' }, L).text, /^Printed the Q4 2026 Board Meeting, all of it$/);
  assert.match(said({ kind: 'print', ref: 'm_abc123', sub: 'page' }, L).text, /^Printed the page for the Q4/);
  const L2 = namesFrom({ meetings: [], docs: [{ id: 'd_123456', title: 'Board Member Expectations', file: null, signed: { 'alex-rivera': { copy: { id: 'f_signed1', name: 'scan.pdf' } } } }] });
  assert.match(said({ kind: 'file', ref: 'f_signed1', secs: 3 }, L2).text, /^Opened their signed copy of “Board Member Expectations”$/);
  assert.deepEqual(merged([{ kind: 'view', ref: 'home', secs: 3 }, { kind: 'view', ref: 'home', secs: 4 }, { kind: 'file', ref: 'f_1', secs: 2 }, { kind: 'view', ref: 'home', secs: 1 }]).map((r) => [r.ref, r.secs]), [['home', 7], ['f_1', 2], ['home', 1]], 'the same page again in a row is one line');
  assert.equal(span(0), '');
  assert.equal(span(30), 'under a minute');
  assert.equal(span(125), '2 min');
  assert.equal(span(3900), '1 hr 5 min');
  const t = Date.parse('2026-11-01T14:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const v = sittingsOf({ signIns: [{ at: iso(t), device: 'iPhone · Safari' }], events: [{ kind: 'view', ref: 'home', secs: 30, at: iso(t + 10_000), until: iso(t + 40_000) }, { kind: 'view', ref: 'people', secs: 10, at: iso(t + 5 * 3600_000), until: iso(t + 5 * 3600_000 + 10_000) }] });
  assert.equal(v.length, 2, 'two sittings, five hours apart');
  assert.deepEqual(v[1].rows.map((r) => r.kind), ['signin', 'view'], 'oldest first inside');
  assert.equal(v[0].rows[0].ref, 'people', 'newest sitting first');
});
