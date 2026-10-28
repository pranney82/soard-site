/**
 * Board's past meetings from Google Drive: the year folders and their meeting
 * folders walked, each meeting folder's files onto its meeting (Google's own
 * as PDFs), the minutes read for who was there and the approval, what isn't
 * meeting material left alone, nothing twice, a change in Drive replacing its
 * copy, and the backlog read a little each look. Made-up people and file
 * names only (the repo is public). The older years' ways are read too: loose
 * minutes in the year folder, undated folders of meetings, one copy of each.
 * And Documents gets the board manual's papers and the founding papers.
 * Run: node --test tests/board-drive.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import {
  readBoardDrive, maybeReadBoardDrive, driveStatus, folderDate, fileDate, stemOf, meetingDoc, docSlot, docTitle, docKind, nameYear, folderIdOf, driveKind, driveSkip, DRIVE_BY, DEFAULT_DRIVE_FOLDER, DRIVE_SCOPE,
} from '../functions/api/_board-drive.js';
import { listMeetings, getMeeting, saveMeeting, listDocs, deleteDoc } from '../functions/api/_board.js';
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
const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
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
      const q = u.searchParams.get('q');
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      let all;
      if (parent) all = Object.values(g.files).filter((f) => f.parent === parent);
      else {
        // A search of the Board folder's shared drive by name
        assert.deepEqual([u.searchParams.get('corpora'), u.searchParams.get('driveId')], ['drive', 'shared-1']);
        const names = [...q.matchAll(/name contains '([^']+)'/g)].map((x) => x[1].toLowerCase());
        const folders = q.includes(`mimeType = '${FOLDER}'`);
        const noFolders = q.includes(`mimeType != '${FOLDER}'`);
        all = Object.values(g.files).filter((f) => f.id !== ROOT && names.some((x) => f.name.toLowerCase().includes(x)) && (!folders || f.mimeType === FOLDER) && (!noFolders || f.mimeType !== FOLDER));
      }
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
    return Response.json({ id: f.id, name: f.name, driveId: 'shared-1' });
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

test('the older files’ dates, which loose files are a board meeting’s, and the copies of one document', () => {
  assert.equal(fileDate('Board Meeting Minutes 1/21/16', 2016), '2016-01-21');
  assert.equal(fileDate('Example Board Meeting Notes 1.27.16 .pdf', 2016), '2016-01-27');
  assert.equal(fileDate('Example Board Mtg Notes - 20140605.docx', 2014), '2014-06-05');
  assert.equal(fileDate('Example Board Meeting_Minutes 012121.docx', 2021), '2021-01-21');
  assert.equal(fileDate('Example Board Meeting_Notes 042221 (1).docx', 2021), '2021-04-22');
  assert.equal(fileDate('Example Board Meeting- December 17, 2018.docx (1).pdf', 2018), '2018-12-17');
  assert.equal(fileDate('Copy of Example Board Meeting- March 27, 2018.docx', 2018), '2018-03-27');
  assert.equal(fileDate('Board Meeting Agenda Jan. 27, 2016.docx', 2016), '2016-01-27');
  assert.equal(fileDate('Example Board Meeting- June 15 2016.docx', 2016), '2016-06-15');
  assert.equal(fileDate('Example Board Meeting- June 2 8am.docx', 2015), '2015-06-02', 'no year: the year folder’s');
  assert.equal(fileDate('Example Board Meeting 2_26.docx', 2015), '2015-02-26');
  assert.equal(fileDate('Example Board Meeting 2_26.docx'), '', 'no year anywhere');
  assert.equal(fileDate('Example Board Meeting- December 17, 2018.docx', 2024), '', 'a date far from its year folder');
  assert.equal(fileDate('Example Board Meeting- February 30, 2018.docx', 2018), '');
  assert.equal(fileDate('Updated Example Board Agenda 2026.pages', 2026), '');
  assert.deepEqual(['Board Meeting Minutes 1/21/16', 'Example Board Mtg Notes - 20140605.docx', 'Example Board Meeting_Minutes 012121.docx', 'Board Meeting Agenda 12/21/16',
    'Board Expectations Updated 01_14_25.pdf', 'Example Board Nominee 2020.pdf', '02/04/2021 - Governance Committee Meeting', 'Example Board Committee Meeting Notes 3.1.21', 'Partner Meeting Agenda 2.11.19', 'Board Members 2015.docx'].map(meetingDoc),
  [true, true, true, true, false, false, false, false, false, false]);
  const one = stemOf('Example Board Meeting- December 17, 2018.docx');
  assert.deepEqual(['Example Board Meeting- December 17, 2018.docx (1).pdf', 'Copy of Example Board Meeting- December 17, 2018.docx', 'Example Board Meeting- December 17, 2018.docx.pdf', 'example board meeting december 17 2018'].map(stemOf), [one, one, one, one]);
  assert.notEqual(stemOf('2026 budget & actual (January 2026).pdf'), stemOf('2026 budget & actual.pdf'), 'only a copy’s number comes off');
});

test('the older years: loose minutes on the meeting of their day, undated folders of meetings, an undated meeting’s folder, one copy of each, and nothing else loose', async () => {
  // 2014: a meeting folder, and loose notes named by the day
  const y14 = add(ROOT, '2014 Board', { mimeType: FOLDER });
  add(add(y14, '10.13.2014', { mimeType: FOLDER }), 'Minutes.pdf', { text: MINUTES('October 13, 2014') });
  const notes14 = add(y14, 'Example Board Mtg Notes - 20140605.docx', { mimeType: WORD });
  const plan14 = add(y14, 'Example 2014 Plan.pptx');
  // 2015: a folder of the year's meetings' notes, without a date; loose files that aren't a meeting's
  const y15 = add(ROOT, '2015 Board', { mimeType: FOLDER });
  const notes15 = add(y15, '2015 Board Meeting Notes', { mimeType: FOLDER });
  add(notes15, 'Example Board Meeting 2_26.docx', { mimeType: WORD });
  add(notes15, 'Example Board Meeting- Oct. 15, 2015.docx', { mimeType: WORD });
  const members15 = add(y15, 'Example Board Members 2015.docx', { mimeType: WORD });
  const report15 = add(y15, '10.15.2015 Finance Report.xlsx');
  // 2016: a folder of meetings with an agenda in two formats, and loose minutes as Google Docs
  const y16 = add(ROOT, '2016 Board', { mimeType: FOLDER });
  const m16 = add(y16, '2016 Board Meetings', { mimeType: FOLDER });
  add(m16, 'Board Meeting Agenda Jan. 27, 2016.docx', { mimeType: WORD });
  const agendaPdf = add(m16, 'Board Meeting Agenda Jan. 27, 2016.pdf');
  add(m16, 'Example Board Meeting Notes 1.27.16 .pdf', { text: MINUTES('January 27, 2016') });
  add(y16, 'Board Meeting Minutes 12/21/16', { mimeType: DOC, text: MINUTES('December 21, 2016') });
  add(y16, 'Board Meeting Agenda 12/21/16', { mimeType: DOC });
  const sheet16 = add(y16, 'Balance sheet.pdf');
  // 2018: loose minutes, their PDF and a copy; and the end of year meeting's undated folder with its statements
  const y18 = add(ROOT, '2018 Board', { mimeType: FOLDER });
  const dec = add(y18, 'Example Board Meeting- December 17, 2018.docx', { mimeType: WORD });
  const decPdf = add(y18, 'Example Board Meeting- December 17, 2018.docx (1).pdf', { text: MINUTES('December 17, 2018') });
  const decCopy = add(y18, 'Copy of Example Board Meeting- December 17, 2018.docx', { mimeType: WORD });
  const eoy = add(y18, '2018 Example End of Year Board Meeting', { mimeType: FOLDER });
  add(eoy, 'Example 2018 - Profit and Loss.pdf');
  const eoyMin = add(eoy, 'Example Board Meeting- December 17, 2018.docx.pdf');
  add(y18, 'Example Board Meeting- June 13, 2018.docx', { mimeType: WORD });
  // 2025: a shared folder of the board's reference files, undated: never read
  const y25 = add(ROOT, '2025 Board', { mimeType: FOLDER });
  const shared = add(y25, 'Board Shared Folder- Example', { mimeType: FOLDER });
  const payroll = add(shared, 'Example Payroll.pdf');
  const committee = add(y25, '02/04/2025 - Governance Committee Meeting', { mimeType: DOC });

  const st = await readBoardDrive(env, { budgetMs: 60000 });
  assert.equal(st.ok, true, JSON.stringify(st.errors));
  const meetings = await listMeetings(env.DB);
  assert.deepEqual(meetings.map((m) => m.date).sort(), ['2014-06-05', '2014-10-13', '2015-02-26', '2015-10-15', '2016-01-27', '2016-12-21', '2018-06-13', '2018-12-17']);
  assert.equal(st.backlog, 0);
  const names = (date) => by(meetings, date).files.map((f) => f.name).sort();
  assert.deepEqual(names('2014-06-05'), ['Example Board Mtg Notes - 20140605.docx']);
  assert.deepEqual(names('2016-01-27'), ['Board Meeting Agenda Jan. 27, 2016.pdf', 'Example Board Meeting Notes 1.27.16 .pdf'], 'the agenda once, as its PDF');
  assert.deepEqual(names('2016-12-21'), ['Board Meeting Agenda 12/21/16.pdf', 'Board Meeting Minutes 12/21/16.pdf']);
  assert.deepEqual(by(meetings, '2016-12-21').files.map((f) => f.kind).sort(), ['agenda', 'minutes']);
  assert.deepEqual(names('2018-12-17'), ['Example 2018 - Profit and Loss.pdf', 'Example Board Meeting- December 17, 2018.docx.pdf'], 'the loose minutes and the end of year folder are one meeting, its minutes once');
  assert.equal(by(meetings, '2018-12-17').files.find((f) => f.kind === 'financials')?.name, 'Example 2018 - Profit and Loss.pdf');
  assert.ok(fetched(eoyMin) && fetched(notes14) && fetched(agendaPdf));
  for (const id of [dec, decCopy, plan14, members15, report15, sheet16, payroll, committee]) assert.ok(!fetched(id), `${g.files[id].name} isn’t read`);
  assert.ok(!g.calls.some((c) => c.includes(`'${shared}'`)), 'a folder that isn’t a meeting’s isn’t opened');
  assert.ok(fetched(decPdf), 'the loose PDF read for its words, then kept as the copy already there');
  assert.equal(by(meetings, '2018-12-17').attendance.find((p) => p.slug === 'alex-rivera')?.status, 'present');
  assert.deepEqual(Object.fromEntries(by(meetings, '2016-12-21').attendance.map((p) => [p.slug, p.status]))['kim-park'], 'absent', 'loose minutes are read for who was there');
  assert.equal(by(meetings, '2016-12-21').minutes, 'approved', 'a later meeting exists');

  // Read again: nothing twice
  await readBoardDrive(env, { now: Date.now() + 2 * 60 * 60 * 1000, budgetMs: 60000 });
  assert.equal((await listMeetings(env.DB)).reduce((x, m) => x + m.files.length, 0), meetings.reduce((x, m) => x + m.files.length, 0));
});

test('an upgrade walks the folder again for what it missed but doesn’t read again what it read', async () => {
  const y = add(ROOT, '2018 Board', { mimeType: FOLDER });
  const read = add(y, '3.27.18 Board Meeting', { mimeType: FOLDER });
  add(read, 'Minutes.pdf', { text: MINUTES('March 27, 2018') });
  add(y, 'Example Board Meeting- June 13, 2018.docx', { mimeType: WORD });
  // What the last version walked and read
  await writeState(env.DB, 'drive-done', { version: 1, root: ROOT, walkedAt: new Date().toISOString(), folders: [{ id: read, name: '3.27.18 Board Meeting', date: '2018-03-27' }], seen: { [read]: new Date().toISOString() } });
  await writeState(env.DB, 'drive', { version: 1, ok: true, checkedAt: new Date().toISOString(), backlog: 0 });
  const r = await maybeReadBoardDrive(env);
  assert.equal(r.busy, true, 'due at once after an upgrade');
  assert.deepEqual((await listMeetings(env.DB)).map((m) => m.date), ['2018-06-13']);
  assert.ok(!g.calls.some((c) => c.includes(`'${read}'`)), 'the folder read before isn’t listed again');
  assert.deepEqual([(await driveStatus(env.DB)).folders, (await driveStatus(env.DB)).backlog], [2, 0]);
});

test('which Documents entry a paper fills, its title and its kind', () => {
  assert.deepEqual(['Articles of Incorporation-State (1).pdf', 'Articles of Amendment.doc.pdf', '3-501(c)(3) Letter of Determination (6).pdf', 'Signed Amended Bylaws.pdf', 'Signed Amended Bylaws 2027.pdf'].map(docSlot),
    ['articles', 'amendment', 'irs-letter', 'manual:signed amended bylaws', 'manual:signed amended bylaws']);
  assert.deepEqual(['SOARD EIN number.pdf', '2026 W9 SOARD.pdf', '2022 Charitable Organization Permit.pdf', '24-25 D&O Insurance Policy.pdf'].map(docSlot), ['ein', 'w9', 'charity-permit', 'dno']);
  assert.ok(['SOARD 401k EIN.pdf', 'Example Holdings EIN.pdf', 'Example Vendor W-9.pdf', 'Example Org Incorporated.pdf'].every((n) => docSlot(n).startsWith('manual:')), 'another plan’s EIN, another company’s, a vendor’s W-9 and an order form are none of SOARD’s papers');
  assert.deepEqual(['2026 W9 SOARD.pdf', '24-25 D&O Insurance Policy.pdf', 'SOARD W9.pdf'].map(nameYear), [2026, 2025, 0]);
  assert.equal(docTitle('Example Org, Inc._Board Manual with Policies .pdf'), 'Example Org, Inc. Board Manual with Policies');
  assert.equal(docTitle('Articles of Amendment.doc.pdf'), 'Articles of Amendment');
  assert.deepEqual(['Signed Amended Bylaws.pdf', 'Example Org_Board Manual with Policies', 'Conflict of Interest Policy.pdf', 'Org chart.pdf'].map(docKind), ['governance', 'policy', 'policy', 'other']);
});

test('Documents gets the newest board manual’s papers and SOARD’s own papers, one copy each (the newest, for the renewed ones), never the members’ signed copies, look-alikes or anything else beside them', async () => {
  add(add(add(ROOT, '2025 Board', { mimeType: FOLDER }), '1.23.25 Meeting', { mimeType: FOLDER }), 'Minutes.pdf', { text: MINUTES('January 23, 2025') });
  const legal = add('', '2025/2026 Legal Checkup', { mimeType: FOLDER });
  const old = add(add('', 'Old legal', { mimeType: FOLDER }), '2025 Board Manual', { mimeType: FOLDER });
  const oldBylaws = add(old, 'Bylaws 2025.pdf');
  const manual = add(legal, '2026 Board Manual', { mimeType: FOLDER });
  const bylaws = add(manual, 'Signed Amended Bylaws.pdf');
  add(manual, 'Example Org_Board Manual with Policies', { mimeType: DOC, text: 'policies' });
  const manualPdf = add(manual, 'Example Org_Board Manual with Policies .pdf');
  const pages = add(manual, 'Example Org_Board Manual with Policies (2).pages', { mimeType: 'application/x-iwork-pages-sffpages' });
  const stateArticles = add(manual, 'Articles of Incorporation-State (1).pdf');
  const signedDir = add(manual, 'Board Signed Documents', { mimeType: FOLDER });
  const signedCopy = add(signedDir, 'Example Org_Board Manual with Policies - Pat Example.pdf');
  // Where the founding papers are kept, beside papers that are nobody else's business
  const biz = add('', 'Business licenses and docs', { mimeType: FOLDER });
  const irs = add(biz, '501(c)(3) Letter of Determination.pdf', { modifiedTime: '2014-01-01T00:00:00Z' });
  const grantCopy = add(add('', 'Grants', { mimeType: FOLDER }), '3-501(c)(3) Letter of Determination (6).pdf');
  const amendment = add(biz, 'Articles of Amendment.doc.pdf');
  const redline = add(biz, 'Redline - Articles of Amendment.pdf');
  const otherArticles = add(biz, 'Articles of Incorporation Example.pdf');
  const license = add(biz, 'Example Drivers License.pdf');
  // Renewed papers: the newest copy; and look-alikes that are someone else's
  const ein = add(biz, 'SOARD EIN number.pdf', { modifiedTime: '2017-06-14T00:00:00Z' });
  const plan401k = add(biz, 'SOARD 401k EIN.pdf');
  const otherEin = add(biz, 'Example Holdings EIN.pdf');
  const oldW9 = add(biz, 'SOARD W9.pdf', { modifiedTime: '2018-06-25T00:00:00Z' });
  const w9 = add('', '2026 W9 SOARD.pdf', { modifiedTime: '2026-01-05T00:00:00Z' });
  const vendorW9 = add(biz, 'Example Vendor W-9.pdf', { modifiedTime: '2026-09-01T00:00:00Z' });
  const oldPermit = add(biz, 'SOARD - Charitable Organization Permit.pdf', { modifiedTime: '2016-12-20T00:00:00Z' });
  const permit = add(biz, '2022 Charitable Organization Permit.pdf', { modifiedTime: '2022-03-01T00:00:00Z' });
  const oldDno = add(ROOT, '2017 Board D&O Insurance.pdf', { modifiedTime: '2016-12-15T00:00:00Z' });
  const dno = add(add(ROOT, '2025 Board', { mimeType: FOLDER }), '24-25 D&O Insurance Policy.pdf', { modifiedTime: '2025-01-23T00:00:00Z' });
  const order = add('', 'Example Org Incorporated.pdf');

  const st = await readBoardDrive(env, { budgetMs: 60000 });
  assert.equal(st.ok, true, JSON.stringify(st.errors));
  assert.deepEqual([st.docs.count, st.docs.manual, st.docs.missing], [9, '2026 Board Manual', []]);
  let docs = await listDocs(env.DB);
  assert.deepEqual(docs.map((d) => [d.title, d.kind, d.year, d.shared, d.sign]).sort(), [
    ['Articles of Amendment', 'governance', null, true, false],
    ['Articles of Incorporation', 'governance', null, true, false],
    ['Charitable Organization Permit', 'governance', null, true, false],
    ['D&O insurance', 'governance', null, true, false],
    ['EIN letter', 'governance', null, true, false],
    ['Example Org Board Manual with Policies', 'policy', 2026, true, false],
    ['IRS 501(c)(3) determination letter', 'governance', null, true, false],
    ['Signed Amended Bylaws', 'governance', 2026, true, false],
    ['W-9', 'governance', null, true, false],
  ]);
  const fileOf = (title) => docs.find((d) => d.title === title).file.name;
  assert.deepEqual(['EIN letter', 'W-9', 'Charitable Organization Permit', 'D&O insurance'].map(fileOf),
    ['SOARD EIN number.pdf', '2026 W9 SOARD.pdf', '2022 Charitable Organization Permit.pdf', '24-25 D&O Insurance Policy.pdf'], 'the newest copy of each');
  for (const id of [ein, w9, permit, dno]) assert.ok(fetched(id), `${g.files[id].name} is read`);
  for (const id of [plan401k, otherEin, oldW9, vendorW9, oldPermit, oldDno, order]) assert.ok(!fetched(id), `${g.files[id].name} isn’t read`);
  assert.ok(docs.every((d) => d.file), 'each with its file');
  assert.equal(docs.find((d) => d.title === 'Articles of Incorporation').file.name, 'Articles of Incorporation-State (1).pdf', 'the manual’s own copy');
  for (const id of [bylaws, stateArticles, irs, amendment]) assert.ok(fetched(id), `${g.files[id].name} is read`);
  for (const id of [oldBylaws, pages, signedCopy, grantCopy, redline, otherArticles, license]) assert.ok(!fetched(id), `${g.files[id].name} isn’t read`);
  assert.ok(!g.calls.some((c) => c.includes(`'${signedDir}'`) || c.includes(`'${biz}'`)), 'the folders beside them aren’t opened');
  assert.equal(fetched(manualPdf) ? 1 : 0, 0, 'the Doc and its PDF are one document (the Doc, as a PDF)');

  // Within the hour: not again. An hour later, nothing changed: nothing brought
  g.calls = [];
  await readBoardDrive(env, { now: Date.now() + 30 * 60 * 1000 });
  assert.ok(!g.calls.some((c) => c.includes('corpora=drive')));
  await readBoardDrive(env, { now: Date.now() + 2 * 60 * 60 * 1000 });
  assert.equal((await driveStatus(env.DB)).docs.brought, 0);

  // Taken out in Board: it stays out. The bylaws changed in Drive: the new file replaces the old
  await deleteDoc(env, docs.find((d) => d.title === 'Articles of Amendment').id);
  const before = docs.find((d) => d.title === 'Signed Amended Bylaws').file;
  g.files[bylaws].modifiedTime = '2026-09-01T00:00:00Z';
  await readBoardDrive(env, { now: Date.now() + 4 * 60 * 60 * 1000 });
  docs = await listDocs(env.DB);
  assert.equal(docs.length, 8);
  const after = docs.find((d) => d.title === 'Signed Amended Bylaws').file;
  assert.notEqual(after.id, before.id);
  assert.equal(await env.DB.prepare('SELECT count(*) AS n FROM board_files WHERE owner_type = ?').bind('doc').first().then((r) => r.n), 8, 'the old copy is gone');

  // Next year's manual: its bylaws fill the same document, which is that year's now
  const next = add(legal, '2027 Board Manual', { mimeType: FOLDER });
  add(next, 'Signed Amended Bylaws 2027.pdf');
  await readBoardDrive(env, { now: Date.now() + 6 * 60 * 60 * 1000 });
  docs = await listDocs(env.DB);
  const b = docs.find((d) => d.title === 'Signed Amended Bylaws');
  assert.deepEqual([b.year, b.file.name, docs.length], [2027, 'Signed Amended Bylaws 2027.pdf', 8]);
  assert.equal((await driveStatus(env.DB)).docs.manual, '2027 Board Manual');
});

test('Documents waits for the past meetings to be read', async () => {
  const y = add(ROOT, '2025 Board', { mimeType: FOLDER });
  for (const md of ['1.16.25', '4.17.25']) add(add(y, `${md} Meeting`, { mimeType: FOLDER }), 'Minutes.pdf', { text: MINUTES(md) });
  add(add('', '2026 Board Manual', { mimeType: FOLDER }), 'Signed Amended Bylaws.pdf');
  let st = await readBoardDrive(env, { budgetMs: 0 });
  assert.deepEqual([st.backlog, st.docs], [1, null]);
  st = await readBoardDrive(env, { budgetMs: 0 });
  assert.deepEqual([st.backlog, st.docs?.count], [0, 1]);
});
