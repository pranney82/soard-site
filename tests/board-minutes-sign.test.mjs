/**
 * The secretary signs approved minutes on the board page (functions/api/_board-minutes-sign.js): only them, only once
 * approved, a fingerprint of what was approved, and a signed copy kept with the meeting. Made-up people only.
 * Run: node --test tests/board-minutes-sign.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, getMeeting, ensureSchema, patchMeeting, fileLocked, deleteMeeting, putFile } from '../functions/api/_board.js';
import { saveNotes, sendNotes } from '../functions/api/_board-notes.js';
import { signMinutes, buildMinutesRecord, maybeFinishSignedMinutes, signedMinutes, minutesHash, minutesPage } from '../functions/api/_board-minutes-sign.js';
import { checkChain } from '../functions/api/_board-sign.js';
import { minutesToSign, todayEastern } from '../public/admin/board-shared.js';

const TODAY = todayEastern();
const ID = 'm_sign00001';
const SECRETARY = { slug: 'kim-park', name: 'Kim Park', email: 'kim@example.com', seat: 'secretary', title: 'Board Secretary' };
const CHAIR = { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam@example.com', seat: 'chair' };
const MARK = { type: 'typed', style: 'dancing', text: 'Kim Park', initials: 'KP' };
const EVIDENCE = { ip: '203.0.113.9', device: 'Mac · Safari', signerEmail: 'kim@example.com' };

let env;
const objects = new Map();
const bucket = {
  put: async (k, v) => { objects.set(k, new Uint8Array(v)); },
  get: async (k) => (objects.has(k) ? { body: new Blob([objects.get(k)]).stream() } : null),
  delete: async (k) => { objects.delete(k); },
};
const pdf = async () => { const d = await PDFDocument.create(); d.addPage([612, 792]); return d.save(); };
let printed = '';
const render = async (html) => { printed = html; return pdf(); };
const approve = (over = {}) => patchMeeting(env.DB, ID, (m) => ({ ...m, minutes: 'approved', approvedOn: '2027-01-14', ...over }), { by: 'x' });
const refused = async (fn, status, re) => { await assert.rejects(fn, (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return true; }); };

beforeEach(async () => {
  objects.clear();
  printed = '';
  const DB = await createD1();
  env = { DB, FILES: bucket };
  await ensureSchema(DB);
  await DB.prepare('CREATE TABLE IF NOT EXISTS team (slug TEXT PRIMARY KEY, data TEXT)').run().catch(() => {});
  await DB.prepare('INSERT OR REPLACE INTO team (slug, data) VALUES (?, ?)').bind('kim-park', JSON.stringify({ name: 'Kim Park', group: 'board', status: 'active', seat: 'secretary' })).run();
  await saveMeeting(DB, {
    id: ID, date: TODAY, start: '08:00', end: '10:00', shared: true, location: 'The office',
    attendance: [{ slug: 'kim-park', name: 'Kim Park', kind: 'board', status: 'present' }, { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board', status: 'remote' }, { slug: 'pat-lee', name: 'Pat <Lee>', kind: 'board', status: 'excused' }],
    sections: [{ id: 's_a', title: 'New business', items: [{ id: 'i_a', title: 'Budget', notes: 'First line\nSecond & third' }, { id: 'i_b', title: 'Quiet' }, { id: 'i_c', title: 'Settlement', notes: 'Hush', confidential: true }] }],
    motions: [{ id: 'mo_1', text: 'Approve the budget', by: 'Kim Park', second: 'Sam Ortiz', result: 'passed', tally: { for: 3, against: 0, abstain: 1, of: 0, at: '' } }],
    actions: [{ id: 'a_one', text: 'Call the venue', owner: 'sam-ortiz', ownerName: 'Sam Ortiz', due: '2027-02-01' }],
  }, { by: 'jane@example.com' });
  await saveNotes(env, ID, { changes: { 'n:i_a': 'First line\nSecond & third', 'r:kim-park': 'present' } }, { member: SECRETARY, admin: false });
  await sendNotes(env, ID, { member: SECRETARY, admin: false });
});
afterEach(() => { env = null; });

test('only the secretary signs, and only what the board approved', async () => {
  await refused(() => signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true }), 409, /haven’t approved|hasn’t approved/);
  await approve();
  await refused(() => signMinutes(env, ID, CHAIR, { mark: MARK, consent: true }), 403);
  await refused(() => signMinutes(env, ID, null, { mark: MARK, consent: true }), 403);
  await refused(() => signMinutes(env, 'bad id!', SECRETARY, { mark: MARK, consent: true }), 400);
  await refused(() => signMinutes(env, 'm_nothing1', SECRETARY, { mark: MARK, consent: true }), 404);
  await refused(() => signMinutes(env, ID, SECRETARY, { mark: { ...MARK, text: 'Someone Else' }, consent: true }), 400, /own name/);
  await refused(() => signMinutes(env, ID, SECRETARY, { mark: { type: 'nope' }, consent: true }), 400);
  await refused(() => signMinutes(env, ID, SECRETARY, { mark: MARK }), 409, /agree to sign electronically/);
});

test('years gone by aren’t asked for or taken', async () => {
  await approve({ approvedOn: '2025-06-11' });
  assert.equal(minutesToSign(await getMeeting(env.DB, ID)), false);
  await refused(() => signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true }), 409, /before minutes were signed/);
});

test('signed: a signature on the chain, a signed copy kept as the meeting’s, and the secretary isn’t asked again', async () => {
  await approve();
  assert.equal(minutesToSign(await getMeeting(env.DB, ID)), true);
  const s = await signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true, evidence: EVIDENCE });
  assert.equal(s.name, 'Kim Park');
  assert.equal(s.how, 'typed');
  assert.equal(s.mark.text, 'Kim Park');
  const built = await buildMinutesRecord(env, ID, { render });
  assert.equal(built.built, true);
  const m = await getMeeting(env.DB, ID);
  const file = m.files.find((f) => f.kind === 'signed');
  assert.match(file.name, /^Signed minutes, /);
  assert.equal(minutesToSign(m), false);
  assert.ok((await checkChain(env.DB)).ok !== false);
  const facts = (await signedMinutes(env.DB))[ID];
  assert.deepEqual([facts.name, facts.made, facts.changed], ['Kim Park', true, false]);
  // The copy says what was approved, who signed in which seat, and who was there, every value escaped
  assert.match(printed, /Second &amp; third/);
  assert.match(printed, /Pat &lt;Lee&gt;/);
  assert.match(printed, /Approve the budget: Passed, 3 for, 0 against, 1 abstaining\. Moved by Kim Park, seconded by Sam Ortiz\./);
  assert.match(printed, /Call the venue, Sam Ortiz, by Feb 1/);
  assert.match(printed, /Settlement \(board only\)/);
  assert.match(printed, /Signing record/);
  assert.match(printed, /Kim Park, Board Secretary/);
  // The whole board can open it: where it was signed from isn't in it, and is kept in the row
  assert.doesNotMatch(printed, /203\.0\.113\.9|Mac · Safari|kim@example\.com/);
  assert.equal((await env.DB.prepare('SELECT ip FROM board_minutes_signed WHERE meeting_id = ?').bind(ID).first()).ip, '203.0.113.9');
  assert.equal(await fileLocked(env.DB, file.id), 'A signed copy is SOARD’s record of a signature, so it’s kept');
  // Its PDF is a real one, and it's made once
  const row = await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ?').bind(file.id).first();
  const doc = await PDFDocument.load(objects.get(row.r2_key));
  assert.ok(doc.getPageCount() >= 1);
  assert.equal((await buildMinutesRecord(env, ID, { render })).built, false);
});

test('a staff-only minutes file never goes into the copy the board opens, and renaming a file isn’t changing the minutes', async () => {
  const two = await PDFDocument.create(); two.addPage([612, 792]);
  const five = await PDFDocument.create(); for (let i = 0; i < 5; i++) five.addPage([612, 792]);
  await saveMeeting(env.DB, { id: 'm_filestaff', date: TODAY, shared: true, attendance: [], sections: [], minutesFrom: { name: 'minutes.pdf', at: new Date().toISOString(), ai: true, tries: 0 } }, { by: 'x' });
  await putFile(env, { ownerType: 'meeting', ownerId: 'm_filestaff', file: new File([await two.save()], 'minutes.pdf', { type: 'application/pdf' }), kind: 'minutes', by: 'x' });
  await putFile(env, { ownerType: 'meeting', ownerId: 'm_filestaff', file: new File([await five.save()], 'staff notes.pdf', { type: 'application/pdf' }), kind: 'minutes', staffOnly: true, by: 'x' });
  await patchMeeting(env.DB, 'm_filestaff', (m) => ({ ...m, minutes: 'approved', approvedOn: '2027-01-14' }), { by: 'x' });
  await signMinutes(env, 'm_filestaff', SECRETARY, { mark: MARK, consent: true });
  await buildMinutesRecord(env, 'm_filestaff', { render });
  const m = await getMeeting(env.DB, 'm_filestaff');
  const row = await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ?').bind(m.files.find((f) => f.kind === 'signed').id).first();
  assert.equal((await PDFDocument.load(objects.get(row.r2_key))).getPageCount(), 2, 'the one page and the signature, none of the five');
  const f = m.files.find((x) => x.kind === 'minutes' && !x.staffOnly);
  assert.equal(await minutesHash(m), await minutesHash({ ...m, files: m.files.map((x) => (x.id === f.id ? { ...x, name: 'Renamed.pdf' } : x)), minutesFrom: { ...m.minutesFrom, name: 'Renamed.pdf' } }));
});

test('a meeting that isn’t the board’s can’t be signed, and a deleted meeting leaves nothing to retry', async () => {
  await approve({ notBoard: true });
  await refused(() => signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true }), 404);
  await approve({ notBoard: false });
  await signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true });
  await deleteMeeting(env, ID);
  assert.equal(await env.DB.prepare('SELECT 1 AS y FROM board_minutes_signed WHERE meeting_id = ?').bind(ID).first(), null);
});

test('two devices signing at once are one signature', async () => {
  await approve();
  const both = await Promise.all([signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true }), signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true })]);
  assert.equal(both[0].at, both[1].at);
  assert.equal((await env.DB.prepare("SELECT count(*) AS n FROM board_sign_events WHERE kind = 'signed'").first()).n, 1);
  assert.equal((await env.DB.prepare("SELECT count(*) AS n FROM board_sign_events WHERE kind = 'consented'").first()).n, 1);
});

test('pressing Sign twice is one signature', async () => {
  await approve();
  const a = await signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true }, { now: Date.parse('2027-01-14T15:00:00Z') });
  const b = await signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true }, { now: Date.parse('2027-01-14T15:05:00Z') });
  assert.equal(a.at, b.at);
  const n = await env.DB.prepare("SELECT count(*) AS n FROM board_sign_events WHERE kind = 'signed'").first();
  assert.equal(n.n, 1);
});

test('the second time they don’t agree to e-sign again', async () => {
  await approve();
  await signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true });
  await patchMeeting(env.DB, ID, (m) => ({ ...m, motions: [] }), { by: 'x' });
  const again = await signMinutes(env, ID, SECRETARY, { mark: MARK });
  assert.equal(again.name, 'Kim Park');
});

test('minutes changed after signing say so, and signing again makes a new copy', async () => {
  await approve();
  await signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true }, { now: Date.parse('2027-01-14T15:00:00Z') });
  await buildMinutesRecord(env, ID, { render });
  const m = await getMeeting(env.DB, ID);
  await patchMeeting(env.DB, ID, (x) => ({ ...x, sections: x.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_a' ? { ...it, notes: 'Changed words' } : it)) })) }), { by: 'x' });
  assert.notEqual(await minutesHash(m), await minutesHash(await getMeeting(env.DB, ID)));
  assert.equal((await signedMinutes(env.DB))[ID].changed, true);
  await signMinutes(env, ID, SECRETARY, { mark: MARK }, { now: Date.parse('2027-01-14T16:00:00Z') });
  assert.equal((await signedMinutes(env.DB))[ID].changed, false);
  assert.equal((await signedMinutes(env.DB))[ID].made, false);
  await buildMinutesRecord(env, ID, { render, now: Date.parse('2027-01-14T16:00:00Z') });
  assert.equal((await getMeeting(env.DB, ID)).files.filter((f) => f.kind === 'signed').length, 2);
});

test('a to-do ticked done after signing doesn’t change what was signed', async () => {
  await approve();
  const m = await getMeeting(env.DB, ID);
  assert.equal(await minutesHash(m), await minutesHash({ ...m, actions: m.actions.map((a) => ({ ...a, done: true, doneOn: TODAY })), updatedAt: 'later' }));
});

test('a copy that didn’t get made is tried again by the heartbeat, and no browser means nothing is counted against it', async () => {
  await approve();
  await signMinutes(env, ID, SECRETARY, { mark: MARK, consent: true });
  assert.deepEqual(await buildMinutesRecord(env, ID), { built: false, error: 'no browser' });
  const row = await env.DB.prepare('SELECT record_tries FROM board_minutes_signed WHERE meeting_id = ?').bind(ID).first();
  assert.equal(row.record_tries, 0);
  assert.equal(await maybeFinishSignedMinutes(env), 0);
  // One that fails: told, its claim left, and it waits its turn
  const bad = await buildMinutesRecord(env, ID, { render: async () => { throw new Error('browser busy'); } });
  assert.equal(bad.built, false);
  assert.equal((await buildMinutesRecord(env, ID, { render })).error, 'claimed');
  const later = Date.now() + 4 * 60 * 1000;
  assert.equal((await buildMinutesRecord(env, ID, { render, now: later })).built, true);
});

test('minutes kept as a file: a PDF’s own pages come first, a Word file’s own words are the record', async () => {
  const { putFile } = await import('../functions/api/_board.js');
  const { minutesDocx } = await import('../public/admin/board-minutes-template.js');
  // A PDF someone sent: its two pages, then the signature
  const two = await PDFDocument.create(); two.addPage([612, 792]); two.addPage([612, 792]);
  await saveMeeting(env.DB, { id: 'm_filepdf01', date: TODAY, shared: true, attendance: [], sections: [], minutesFrom: { name: 'minutes.pdf', at: new Date().toISOString(), ai: true, tries: 0 } }, { by: 'x' });
  await putFile(env, { ownerType: 'meeting', ownerId: 'm_filepdf01', file: new File([await two.save()], 'minutes.pdf', { type: 'application/pdf' }), kind: 'minutes', by: 'x' });
  await patchMeeting(env.DB, 'm_filepdf01', (m) => ({ ...m, minutes: 'approved', approvedOn: '2027-01-14' }), { by: 'x' });
  await signMinutes(env, 'm_filepdf01', SECRETARY, { mark: MARK, consent: true });
  assert.equal((await buildMinutesRecord(env, 'm_filepdf01', { render })).built, true);
  assert.match(printed, /the pages before this one/);
  const file = (await getMeeting(env.DB, 'm_filepdf01')).files.find((f) => f.kind === 'signed');
  const row = await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ?').bind(file.id).first();
  assert.equal((await PDFDocument.load(objects.get(row.r2_key))).getPageCount(), 3);
  // A Word file someone sent: its words, not what was read from it
  const mine = await getMeeting(env.DB, ID);
  await saveMeeting(env.DB, { id: 'm_fileword1', date: TODAY, shared: true, attendance: [], sections: [], minutesFrom: { name: 'minutes.docx', at: new Date().toISOString(), ai: true, tries: 0 } }, { by: 'x' });
  await putFile(env, { ownerType: 'meeting', ownerId: 'm_fileword1', file: new File([minutesDocx(mine, { filled: { words: { i_a: 'Words only in the Word file' } } })], 'minutes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), kind: 'minutes', by: 'x' });
  await patchMeeting(env.DB, 'm_fileword1', (m) => ({ ...m, minutes: 'approved', approvedOn: '2027-01-14' }), { by: 'x' });
  await signMinutes(env, 'm_fileword1', SECRETARY, { mark: MARK });
  printed = '';
  assert.equal((await buildMinutesRecord(env, 'm_fileword1', { render })).built, true);
  assert.match(printed, /Words only in the Word file/);
});

test('corrections made before the vote are on the record: who suggested each and who made it, not the words', async () => {
  const m = await getMeeting(env.DB, ID);
  const page = minutesPage(m, { corrections: [{ target: 'n:i_a', kind: 'words', by_name: 'Sam Ortiz', decided_by: 'Kim Park', decided_at: '2026-12-02T12:00:00.000Z' }, { target: 'r:sam-ortiz', kind: 'roll', by_name: 'Sam Ortiz', decided_by: 'Kim Park', decided_at: '' }, { target: 'general', kind: 'other', by_name: 'Pat', decided_by: 'Jane', decided_at: '' }] });
  assert.match(page, /Corrected before the vote/);
  assert.match(page, /Budget: suggested by Sam Ortiz, made by Kim Park on Dec 2/);
  assert.match(page, /Who was there: suggested by Sam Ortiz/);
  assert.match(page, /The minutes: suggested by Pat/);
  assert.doesNotMatch(minutesPage(m), /Corrected before the vote/);
  // Nothing under an item: left out
  assert.doesNotMatch(page, /Quiet/);
});
