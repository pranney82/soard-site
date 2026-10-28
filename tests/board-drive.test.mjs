/**
 * Board's past meetings from Google Drive: the year folders and their meeting
 * folders walked, each meeting folder's files onto its meeting (Google's own
 * as PDFs), the minutes read for who was there and the approval, what isn't
 * meeting material left alone, nothing twice, a change in Drive replacing its
 * copy, and the backlog read a little each look. Made-up people and file
 * names only (the repo is public).
 * Run: node --test tests/board-drive.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import {
  readBoardDrive, maybeReadBoardDrive, driveStatus, folderDate, folderIdOf, driveKind, driveSkip, DRIVE_BY, DEFAULT_DRIVE_FOLDER, DRIVE_SCOPE,
} from '../functions/api/_board-drive.js';
import { listMeetings, getMeeting, saveMeeting } from '../functions/api/_board.js';
import { writeState } from '../functions/api/_board-roles.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { cleanMeeting, todayEastern } from '../public/admin/board-shared.js';

const FOUNDER = 'jane@soardcharity.com';
const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair', organization: 'Rivera Builders' }],
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
  ['kim-park', { name: 'Kim Park', group: 'board', title: 'Board Member' }],
];
const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, bytes, opts) { this.map.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType }); }
  async get(key) { const o = this.map.get(key); return o ? { body: o.bytes, size: o.bytes.length, httpMetadata: { contentType: o.type } } : null; }
  async delete(key) { this.map.delete(key); }
}

const realFetch = globalThis.fetch;
let env;
let g; // the fake Drive: { files: { id: { id, name, mimeType, parent, modifiedTime, bytes, text } }, calls, noScope, apiOff }
const ROOT = DEFAULT_DRIVE_FOLDER;
const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const pdfOf = (t) => new TextEncoder().encode(`%PDF-1.4 ${t}`);
const MINUTES = (when) => `Example Board of Directors – Meeting Minutes\n${when}\nPresent: Alex Rivera, Sam Ortiz, Jane Doe\nAbsent – Kim Park\n1. CALL TO ORDER\n1. Roll Call\n- Called to order at 8:02 a.m.\n2. COMMITTEE REPORTS\n1. Financial (Sam)\n- Reserves grew\nThe meeting adjourned at 9:45 a.m.`;

let n = 0;
/** A folder or a file in the fake Drive → its id */
function add(parent, name, { mimeType = 'application/pdf', text = '', modifiedTime = '2026-01-01T00:00:00Z', size } = {}) {
  const id = `f${++n}x${'0'.repeat(10)}`;
  const bytes = mimeType === FOLDER ? null : /^image\//.test(mimeType) ? new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0]) : pdfOf(`${name} ${text.length}`);
  g.files[id] = { id, name, mimeType, parent, modifiedTime, bytes, text, size: size ?? bytes?.byteLength };
  return id;
}
/** "M.D.YY" for a day `days` from today */
const mdyy = (days) => { const d = new Date(Date.now() + days * 86400000); return `${d.getUTCMonth() + 1}.${d.getUTCDate()}.${String(d.getUTCFullYear()).slice(2)}`; };

beforeEach(async () => {
  env = { DB: await createD1(), FILES: new FakeR2(), GOOGLE_CALENDAR_KEY: JSON.stringify({ type: 'service_account', client_email: 'reader@example.iam.gserviceaccount.com', client_id: '1234567890', private_key: SA_PEM }) };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  n = 0;
  g = { files: { [ROOT]: { id: ROOT, name: 'Board', mimeType: FOLDER, parent: '' } }, calls: [], noScope: false, apiOff: false, pageSize: 1000, scopes: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(String(init.body)).get('assertion').split('.')[1], 'base64url').toString());
      g.scopes.push(claims.scope);
      if (g.noScope) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' }, { status: 401 });
      return Response.json({ access_token: `tok-${claims.sub}`, expires_in: 3600 });
    }
    const u = new URL(url);
    if (u.hostname !== 'www.googleapis.com' || !u.pathname.startsWith('/drive/v3/files')) throw new Error(`unexpected call ${method} ${url}`);
    if (method !== 'GET') throw new Error(`Drive is never written to (${method} ${url})`);
    g.calls.push(u.pathname + u.search);
    if (g.apiOff) return Response.json({ error: { code: 403, message: 'Google Drive API has not been used in project 123 before or it is disabled.' } }, { status: 403 });
    if (!u.pathname.endsWith('/export')) assert.equal(u.searchParams.get('supportsAllDrives'), 'true', 'shared drives are always included');
    if (u.pathname === '/drive/v3/files') {
      assert.equal(u.searchParams.get('includeItemsFromAllDrives'), 'true');
      const parent = u.searchParams.get('q').match(/'([^']+)' in parents/)[1];
      const all = Object.values(g.files).filter((f) => f.parent === parent);
      const from = Number(u.searchParams.get('pageToken') || 0);
      const page = all.slice(from, from + g.pageSize).map(({ bytes, text, parent: p, ...f }) => ({ ...f, size: f.mimeType.startsWith('application/vnd.google-apps') ? undefined : String(f.size) }));
      return Response.json({ files: page, ...(from + g.pageSize < all.length ? { nextPageToken: String(from + g.pageSize) } : {}) });
    }
    const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    const f = m && g.files[decodeURIComponent(m[1])];
    if (!f) return Response.json({ error: { code: 404, message: 'File not found' } }, { status: 404 });
    if (m[2]) {
      const type = u.searchParams.get('mimeType');
      return type === 'text/plain' ? new Response(f.text) : new Response(pdfOf(`${f.name} as a PDF ${f.text.length}`));
    }
    if (u.searchParams.get('alt') === 'media') return new Response(f.bytes);
    return Response.json({ id: f.id, name: f.name });
  };
  // A PDF's text through Workers AI's converter: the minutes' words for the files that have them
  env.AI = { toMarkdown: async (doc) => ({ name: doc.name, format: 'text', data: Object.values(g.files).find((f) => f.name === doc.name)?.text || '' }) };
  clearTokenCache();
});
afterEach(() => { globalThis.fetch = realFetch; });

const by = (meetings, date) => meetings.find((m) => m.date === date);
const fetched = (id) => g.calls.some((c) => c.includes(`/files/${id}`) && (c.includes('alt=media') || c.includes('/export')));

test('dates in folder names, the folder in a link, what a file is, and what stays out', () => {
  assert.equal(folderDate('1.23.25 Meeting', 2025), '2025-01-23');
  assert.equal(folderDate('8.6.26 Board Meeting', 2026), '2026-08-06');
  assert.equal(folderDate('11.13.2025 Meeting'), '2025-11-13');
  assert.equal(folderDate('2025.07.24 minutes'), '2025-07-24');
  assert.equal(folderDate('4-30-26 Board Meeting', 2026), '2026-04-30');
  assert.equal(folderDate('12.15.25 Meeting', 2026), '2025-12-15', 'a meeting filed with the year after it');
  assert.equal(folderDate('1.10.22 Meeting', 2026), '', 'a date far from its year folder');
  assert.equal(folderDate('13.1.25 Meeting'), '');
  assert.equal(folderDate('2.30.25 Meeting'), '');
  assert.equal(folderDate('Board Photos'), '');
  assert.equal(folderIdOf('https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp?usp=sharing'), '1AbCdEfGhIjKlMnOp');
  assert.equal(folderIdOf('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp'), '1AbCdEfGhIjKlMnOp');
  assert.equal(folderIdOf('1AbCdEfGhIjKlMnOp'), '1AbCdEfGhIjKlMnOp');
  assert.equal(folderIdOf('not a folder'), '');
  assert.deepEqual(['Example Q3 Board Meeting Minutes 2025.07.24.pdf', 'Board notes', 'Agenda.docx', 'Example_Statement of Activity', '2026 budget & actual (May 2026)', 'P&L by month.pdf', 'Treasurer Report.pdf'].map(driveKind),
    ['minutes', 'minutes', 'agenda', 'financials', 'financials', 'financials', 'packet']);
  assert.deepEqual([
    { name: 'Photo.jpg', mimeType: 'image/jpeg' }, { name: 'Agenda.pages', mimeType: 'application/octet-stream' }, { name: 'Pat Example Resume.pdf', mimeType: 'application/pdf' },
    { name: 'Big deck.pdf', mimeType: 'application/pdf', size: 20 * 1024 * 1024 }, { name: 'Sign-up', mimeType: 'application/vnd.google-apps.form' },
    { name: 'Link', mimeType: 'application/vnd.google-apps.shortcut' }, { name: 'Report.pdf', mimeType: 'application/pdf', size: 1000 }, { name: 'Minutes', mimeType: DOC },
  ].map((f) => Boolean(driveSkip(f))), [true, true, true, true, true, true, false, false]);
});

test('the year folders’ meeting folders become past meetings with their files; loose files, other folders and meetings ahead stay out', async () => {
  const y24 = add(ROOT, '2024 Board', { mimeType: FOLDER });
  const y25 = add(ROOT, '2025 Board', { mimeType: FOLDER });
  const y26 = add(ROOT, '2026 Board', { mimeType: FOLDER });
  const docs = add(ROOT, '2021 Board Documents', { mimeType: FOLDER });
  add(docs, 'Example bylaws.pdf');
  const photos = add(ROOT, 'Board Photos', { mimeType: FOLDER });
  add(photos, 'Group photo.jpg', { mimeType: 'image/jpeg' });
  const rootLoose = add(ROOT, 'Board Roles.pdf');
  add(ROOT, '3.14.24 Meeting', { mimeType: FOLDER }); // a meeting folder right in the root, with nothing in it yet
  // 2025: two meetings, each with its minutes; loose files beside them
  const q1 = add(y25, '1.23.25 Meeting', { mimeType: FOLDER });
  const q1min = add(q1, 'Example Q1 Board Meeting Minutes 2025.01.23.pdf', { text: MINUTES('January 23, 2025') });
  const q3 = add(y25, '7.24.25 Meeting', { mimeType: FOLDER });
  add(q3, 'Example Q3 Board Meeting Minutes 2025.07.24.pdf', { text: MINUTES('July 24, 2025') });
  const loose = [add(y25, 'Board Expectations Updated.pdf'), add(y25, 'Headshot.jpg', { mimeType: 'image/jpeg' }), add(y25, 'Board Birthdays & Shirt Sizes', { mimeType: SHEET })];
  // 2026: the whole packet as Google files and PDFs, a folder inside it, and what isn't the meeting's
  const f26 = add(y26, '2.12.26 Board Meeting', { mimeType: FOLDER });
  const doc = add(f26, '2026 Q1 Example Board Meeting Minutes 2026.02.12', { mimeType: DOC, text: MINUTES('February 12, 2026') });
  const sheet = add(f26, '2026 budget & actual (January 2026)', { mimeType: SHEET });
  add(f26, 'Treasurer Report- Q1 board meeting.pdf');
  const skippedIds = [add(f26, 'Photo of the room.jpg', { mimeType: 'image/jpeg' }), add(f26, 'Old agenda.pages', { mimeType: 'application/x-iwork-pages-sffpages' }), add(f26, 'Pat Example Resume.pdf')];
  const extras = add(f26, 'Extras', { mimeType: FOLDER });
  add(extras, 'Extra handout.pdf');
  // A meeting ahead: its agenda is written in Board
  const aheadYear = add(ROOT, `${new Date(Date.now() + 30 * 86400000).getUTCFullYear()} Board`, { mimeType: FOLDER });
  const ahead = add(aheadYear, `${mdyy(30)} Board Meeting`, { mimeType: FOLDER });
  add(ahead, 'Draft agenda.pdf');
  // An older year with nothing dated in it
  add(y24, 'Board Nominees', { mimeType: SHEET });

  const st = await readBoardDrive(env, { budgetMs: 60000 });
  assert.equal(st.ok, true, JSON.stringify(st.errors));
  assert.deepEqual([st.folders, st.backlog, st.read], [5, 0, 4], 'five meeting folders, the one ahead left for Board');
  assert.ok(g.scopes.every((s) => s === DRIVE_SCOPE));
  const meetings = await listMeetings(env.DB);
  assert.deepEqual(meetings.map((m) => m.date).sort(), ['2025-01-23', '2025-07-24', '2026-02-12'], 'an empty meeting folder makes no meeting of its own');
  assert.ok(meetings.every((m) => m.updatedBy === DRIVE_BY && m.shared), 'past records, on the board page');
  // The 2026 packet: Google's own as PDFs, the folder inside it too; nothing that isn't the meeting's
  const m26 = by(meetings, '2026-02-12');
  assert.deepEqual(m26.files.map((f) => [f.name, f.kind, f.staffOnly]).sort(), [
    ['2026 Q1 Example Board Meeting Minutes 2026.02.12.pdf', 'minutes', false],
    ['2026 budget & actual (January 2026).pdf', 'financials', false],
    ['Extra handout.pdf', 'packet', false],
    ['Treasurer Report- Q1 board meeting.pdf', 'packet', false],
  ]);
  assert.ok(g.calls.some((c) => c.startsWith(`/drive/v3/files/${doc}/export?mimeType=application%2Fpdf`)) && g.calls.some((c) => c.startsWith(`/drive/v3/files/${doc}/export?mimeType=text%2Fplain`)), 'a Doc as a PDF, and its words read');
  assert.ok(g.calls.some((c) => c.startsWith(`/drive/v3/files/${sheet}/export?mimeType=application%2Fpdf`)), 'a Sheet as a PDF');
  for (const id of [...skippedIds, ...loose, rootLoose]) assert.ok(!fetched(id), `${g.files[id].name} isn’t read`);
  assert.ok(!Object.values(g.files).filter((f) => f.parent === ahead).some((f) => fetched(f.id)), 'nothing for the meeting ahead');
  // The minutes: who was there, the sections and notes, approved once a later meeting exists (the latest stays draft)
  const m1 = by(meetings, '2025-01-23');
  assert.deepEqual(Object.fromEntries(m1.attendance.map((p) => [p.slug, p.status])), { 'alex-rivera': 'present', 'sam-ortiz': 'present', 'jane-doe': 'present', 'kim-park': 'absent' });
  assert.deepEqual([m1.minutes, m1.approvedOn], ['approved', '2025-07-24']);
  assert.deepEqual(m1.sections.map((s) => s.title), ['Call to order', 'Committee reports'], 'the minutes’ sections and items are the meeting’s');
  assert.deepEqual([m1.agendaFrom?.kind, m1.agendaFrom?.name], ['drive', 'Example Q1 Board Meeting Minutes 2025.01.23.pdf']);
  assert.equal(m26.minutes, 'draft', 'no meeting after it yet');
  assert.deepEqual(m26.attendance.filter((p) => p.status === 'present').map((p) => p.slug).sort(), ['alex-rivera', 'jane-doe', 'sam-ortiz'], 'a Google Doc’s minutes are read as text');
  assert.ok(fetched(q1min));
  const state = await driveStatus(env.DB);
  assert.deepEqual([state.meetings, state.files, state.root], [3, 6, ROOT]);

  // Read again: nothing twice, and the older folders aren't asked for again
  g.calls = [];
  const again = await readBoardDrive(env, { now: Date.now() + 2 * 60 * 60 * 1000 });
  assert.equal((await listMeetings(env.DB)).length, 3);
  assert.equal(by(await listMeetings(env.DB), '2026-02-12').files.length, 4);
  assert.ok(!g.calls.some((c) => c.includes(`'${q1}'`)), 'a folder over a year old isn’t listed again');
  assert.equal(again.backlog, 0);
});

test('a meeting already in Board within three days is the one filled, never twice; a file changed in Drive replaces its copy; a meeting someone worked on is theirs to share', async () => {
  const y = add(ROOT, '2026 Board', { mimeType: FOLDER });
  const recent = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const [yy, mm, dd] = recent.split('-');
  const folder = add(y, `${Number(mm)}.${Number(dd)}.${yy.slice(2)} Board Meeting`, { mimeType: FOLDER });
  const min = add(folder, 'Example Board Meeting Minutes.pdf', { text: MINUTES('the meeting') });
  // On the calendar the day before (the folder is named for the day it was filed)
  const dayBefore = new Date(Date.parse(`${recent}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const cal = await saveMeeting(env.DB, cleanMeeting({ date: dayBefore }), { by: 'the calendar' });
  // And someone worked on a later one: Drive fills it but leaves its sharing and approval alone
  const worked = await saveMeeting(env.DB, cleanMeeting({ date: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10), attendance: [{ slug: 'kim-park', name: 'Kim Park', kind: 'board', status: 'present' }] }), { by: FOUNDER });
  const f2 = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10).split('-');
  const later = add(y, `${Number(f2[1])}.${Number(f2[2])}.${f2[0].slice(2)} Meeting`, { mimeType: FOLDER });
  add(later, 'Later minutes.pdf', { text: MINUTES('later') });

  await readBoardDrive(env, { budgetMs: 60000 });
  let meetings = await listMeetings(env.DB);
  assert.equal(meetings.length, 2, 'linked, not doubled');
  const m = await getMeeting(env.DB, cal.id);
  assert.deepEqual([m.files.length, m.shared, m.minutes], [1, true, 'approved'], 'the calendar’s meeting gets its minutes, goes on the board page, and is approved (a later meeting exists)');
  const w = await getMeeting(env.DB, worked.id);
  assert.deepEqual([w.files.length, w.shared, w.minutes], [1, false, 'draft'], 'someone worked on this one');
  assert.deepEqual(w.attendance.map((p) => [p.slug, p.status]), [['kim-park', 'present']], 'attendance someone marked stays');

  // Changed in Drive: the old copy goes, the new one comes in (an hour later, a recent folder is looked at again)
  const before = m.files[0];
  g.files[min].modifiedTime = '2026-09-01T00:00:00Z';
  g.files[min].bytes = pdfOf('the corrected minutes, longer than before');
  g.files[min].size = g.files[min].bytes.byteLength;
  await readBoardDrive(env, { now: Date.now() + 2 * 60 * 60 * 1000 });
  const after = (await getMeeting(env.DB, cal.id)).files;
  assert.equal(after.length, 1);
  assert.notEqual(after[0].id, before.id);
  assert.equal(after[0].size, g.files[min].size);
  assert.equal(await env.DB.prepare('SELECT count(*) AS n FROM board_files WHERE id = ?').bind(before.id).first().then((r) => r.n), 0, 'the old copy is gone');
  // Nothing changed: nothing brought again
  await readBoardDrive(env, { now: Date.now() + 4 * 60 * 60 * 1000 });
  meetings = await listMeetings(env.DB);
  assert.equal(meetings.reduce((x, y) => x + y.files.length, 0), 2);
});

test('the Settings folder is the one read; Google Admin’s say-so and the Drive API are named when they’re missing', async () => {
  const other = add('', 'Another board folder', { mimeType: FOLDER });
  const y = add(other, '2025 Board', { mimeType: FOLDER });
  add(add(y, '4.17.25 Meeting', { mimeType: FOLDER }), 'Minutes.pdf', { text: MINUTES('April 17, 2025') });
  await writeState(env.DB, 'settings', { driveFolder: `https://drive.google.com/drive/u/0/folders/${other}?usp=sharing` });
  const st = await readBoardDrive(env, { budgetMs: 60000 });
  assert.deepEqual([st.root, st.folders, (await listMeetings(env.DB)).map((m) => m.date)], [other, 1, ['2025-04-17']]);

  g.noScope = true;
  clearTokenCache();
  let s = await readBoardDrive(env, { now: Date.now() + 2 * 60 * 60 * 1000 });
  assert.deepEqual([s.ok, s.needsScope, s.apiOff], [false, true, false]);
  g.noScope = false;
  g.apiOff = true;
  clearTokenCache();
  s = await readBoardDrive(env, { now: Date.now() + 4 * 60 * 60 * 1000 });
  assert.deepEqual([s.ok, s.needsScope, s.apiOff], [false, false, true]);
  // No key: says so, reads nothing
  delete env.GOOGLE_CALENDAR_KEY;
  assert.deepEqual(await maybeReadBoardDrive(env), { busy: false });
});

test('a backlog is read a folder or more each look, newest first; caught up, it waits an hour', async () => {
  const y = add(ROOT, '2025 Board', { mimeType: FOLDER });
  for (const [md, i] of [['1.16.25', 1], ['4.17.25', 2], ['7.24.25', 3], ['10.16.25', 4]]) add(add(y, `${md} Meeting`, { mimeType: FOLDER }), `Minutes ${i}.pdf`, { text: MINUTES(md) });
  let st = await readBoardDrive(env, { budgetMs: 0 });
  assert.deepEqual([st.read, st.backlog], [1, 3], 'at least one each look');
  assert.deepEqual((await listMeetings(env.DB)).map((m) => m.date), ['2025-10-16'], 'newest first');
  // The heartbeat: busy while there's a backlog (board mail waits its turn), quiet once caught up
  let busy = 0;
  for (let i = 0; i < 6; i++) if ((await maybeReadBoardDrive(env)).busy) busy += 1;
  st = await driveStatus(env.DB);
  assert.equal(st.backlog, 0);
  assert.equal((await listMeetings(env.DB)).length, 4);
  assert.ok(busy >= 1);
  g.calls = [];
  assert.deepEqual(await maybeReadBoardDrive(env, { now: Date.now() + 10 * 60 * 1000 }), { busy: false });
  assert.equal(g.calls.length, 0, 'within the hour, Drive isn’t asked');
  // Many files in a folder come a page at a time
  g.pageSize = 2;
  const big = add(y, '12.11.25 Meeting', { mimeType: FOLDER });
  for (let i = 0; i < 5; i++) add(big, `Report ${i}.pdf`);
  await readBoardDrive(env, { now: Date.now() + 2 * 60 * 60 * 1000, budgetMs: 60000 });
  assert.equal(by(await listMeetings(env.DB), '2025-12-11').files.length, 5);
  assert.equal(todayEastern() > '2025-12-11', true);
});
