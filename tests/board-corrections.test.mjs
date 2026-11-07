/**
 * Corrections to the minutes (functions/api/_board-corrections.js): a member suggests on the board page, the secretary
 * or a founder makes it in one press, and nothing changes until they do. Made-up people only (the repo is public).
 * Run: node --test tests/board-corrections.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, getMeeting, ensureSchema, patchMeeting, deleteMeeting } from '../functions/api/_board.js';
import { saveNotes, sendNotes, notesFor, notesState } from '../functions/api/_board-notes.js';
import { suggestCorrection, withdrawCorrection, decideCorrection, correctionsForPage, targetOf, canDecide, correctionEmail, correctionDecidedEmail } from '../functions/api/_board-corrections.js';
import { todayEastern, docxText } from '../public/admin/board-shared.js';

const PEOPLE = [
  { slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' },
  { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board' },
  { slug: 'kim-park', name: 'Kim Park', kind: 'board' },
  { slug: 'jane-doe', name: 'Jane Doe', kind: 'staff' },
];
const TODAY = todayEastern();
const SECRETARY = { member: { slug: 'kim-park', name: 'Kim Park', email: 'kim@example.com', seat: 'secretary' }, admin: false };
const MEMBER = { member: { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam@example.com', seat: '' }, admin: false };
const OTHER = { member: { slug: 'alex-rivera', name: 'Alex Rivera', email: 'alex@example.com', seat: '' }, admin: false };
const ADMIN = { member: null, admin: true, adminEmail: 'jane@example.com' };
const ID = 'm_fix000001';

const meetingBody = (over = {}) => ({
  id: ID, date: TODAY, start: '08:00', end: '10:00', shared: true,
  attendance: PEOPLE.map((p) => ({ slug: p.slug, name: p.name, kind: p.kind })),
  sections: [
    { id: 's_new', title: 'New business', items: [{ id: 'i_budget', title: 'Budget' }, { id: 'i_secret', title: 'A settlement', confidential: true }] },
    { id: 's_open', title: 'Open forum', items: [] },
  ],
  ...over,
});

let env;
const objects = new Map();
const bucket = {
  put: async (k, v) => { objects.set(k, new Uint8Array(v)); },
  get: async (k) => (objects.has(k) ? { body: new Blob([objects.get(k)]).stream() } : null),
  delete: async (k) => { objects.delete(k); },
};
const typed = async (notes = { 'n:i_budget': 'Budget is 1000', 'r:sam-ortiz': 'present', 'r:alex-rivera': 'present', 'r:kim-park': 'present' }) => {
  await saveNotes(env, ID, { changes: notes }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
};
const page = async (w = MEMBER) => (await correctionsForPage(env.DB, w))[ID] || [];
const noteOf = async (id = 'i_budget') => (await getMeeting(env.DB, ID)).sections.flatMap((s) => s.items).find((x) => x.id === id).notes;
const refused = async (fn, status, re) => { await assert.rejects(fn, (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return true; }); };

beforeEach(async () => {
  objects.clear();
  const DB = await createD1();
  env = { DB, FILES: bucket };
  await ensureSchema(DB);
  await DB.prepare('CREATE TABLE IF NOT EXISTS team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, data TEXT)').run().catch(() => {});
  for (const p of PEOPLE) await DB.prepare('INSERT OR REPLACE INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(p.slug, p.name, p.kind, JSON.stringify({ name: p.name, group: p.kind, status: 'active', seat: p.slug === 'kim-park' ? 'secretary' : '' })).run();
  await saveMeeting(DB, meetingBody(), { by: 'jane@example.com' });
});
afterEach(() => { env = null; });

test('nothing changes until someone decides, and the whole board sees what’s waiting', async () => {
  await typed();
  const { correction } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Budget is 2000', was: 'Budget is 1000' }, MEMBER);
  assert.equal(await noteOf(), 'Budget is 1000');
  assert.equal(correction.state, 'waiting');
  const seen = await page(OTHER);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].by, 'Sam Ortiz');
  assert.equal(seen[0].mine, false);
  assert.equal((await page(MEMBER))[0].mine, true);
});

test('made in one press: on the meeting, in the notes, the Word file made again, and who typed them doesn’t change', async () => {
  await typed();
  const before = await getMeeting(env.DB, ID);
  const firstAt = before.minutesFrom.at;
  const here = before.attendance.filter((p) => p.status === 'present').length;
  const fileWas = before.files.find((f) => f.kind === 'minutes').id;
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Budget is 2000', was: 'Budget is 1000' }, MEMBER);
  const done = await decideCorrection(env, { id: c.id, make: true }, ADMIN, { now: Date.now() + 1000 });
  assert.equal(done.state, 'made');
  const after = await getMeeting(env.DB, ID);
  assert.equal(await noteOf(), 'Budget is 2000');
  assert.equal(after.attendance.filter((p) => p.status === 'present').length, here);
  assert.equal(after.minutesFrom.first, firstAt, 'when they first went in stays');
  assert.notEqual(after.minutesFrom.at, firstAt);
  // The same Word file, with the new words in it
  const f = after.files.find((x) => x.kind === 'minutes');
  assert.equal(f.id, fileWas);
  const key = (await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ?').bind(f.id).first()).r2_key;
  assert.match(await docxText(objects.get(key)), /Budget is 2000/);
  assert.equal((await notesFor(env, ID, SECRETARY, { quick: true })).notes['n:i_budget'], 'Budget is 2000');
  const row = await env.DB.prepare('SELECT sent FROM board_minutes_notes WHERE meeting_id = ?').bind(ID).first();
  assert.equal(JSON.parse(row.sent).by, 'Kim Park');
  const [shown] = await page(OTHER);
  assert.equal(shown.state, 'made');
  assert.equal(shown.decidedBy, 'Jane Doe');
  assert.equal(shown.was, 'Budget is 1000');
});

test('a part’s own notes and a person on the roll are corrected the same way', async () => {
  await typed({ 'n:i_budget': 'Budget is 1000', 'n:s_open': 'Open words', 'r:sam-ortiz': 'present', 'r:alex-rivera': 'present' });
  const part = (await suggestCorrection(env, { meetingId: ID, target: 'n:s_open', words: 'Better words', was: 'Open words' }, MEMBER)).correction;
  await decideCorrection(env, { id: part.id, make: true }, SECRETARY);
  assert.equal((await getMeeting(env.DB, ID)).sections[1].notes, 'Better words');
  const roll = (await suggestCorrection(env, { meetingId: ID, target: 'r:sam-ortiz', words: 'remote' }, MEMBER)).correction;
  assert.equal(roll.kind, 'roll');
  await decideCorrection(env, { id: roll.id, make: true }, SECRETARY);
  assert.equal((await getMeeting(env.DB, ID)).attendance.find((p) => p.slug === 'sam-ortiz').status, 'remote');
});

test('what a founder changed in Board since: the correction still lands, on the meeting, with the Word file brought up', async () => {
  await typed();
  await patchMeeting(env.DB, ID, (m) => ({ ...m, sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_budget' ? { ...it, notes: 'Founder words' } : it)) })) }), { by: 'jane@example.com' });
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Corrected words', was: 'Founder words' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  assert.equal(await noteOf(), 'Corrected words');
});

test('minutes read from a file: the page changes, and the answer says the file keeps its words', async () => {
  await patchMeeting(env.DB, ID, (m) => ({ ...m, minutesFrom: { name: 'minutes.pdf', at: new Date().toISOString(), ai: true, tries: 0 }, sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_budget' ? { ...it, notes: 'Read from the file' } : it)) })) }), { by: 'x' });
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Fixed', was: 'Read from the file' }, MEMBER);
  const done = await decideCorrection(env, { id: c.id, make: true }, ADMIN);
  assert.equal(done.fileKeeps, true);
  assert.equal(await noteOf(), 'Fixed');
});

test('kept as it is: the minutes don’t move, and only who suggested it and who decides see the reason', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Wrong', was: 'Budget is 1000' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: false, reason: 'The treasurer checked it' }, SECRETARY);
  assert.equal(await noteOf(), 'Budget is 1000');
  assert.equal((await page(MEMBER))[0].reason, 'The treasurer checked it');
  assert.equal((await page(SECRETARY))[0].state, 'declined');
  assert.deepEqual(await page(OTHER), []);
});

test('only the secretary or a founder decides', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New', was: 'Budget is 1000' }, MEMBER);
  await refused(() => decideCorrection(env, { id: c.id, make: true }, MEMBER), 403);
  await refused(() => decideCorrection(env, { id: c.id, make: true }, OTHER), 403);
  assert.equal(canDecide(SECRETARY), true);
  assert.equal(canDecide(ADMIN), true);
  assert.equal(canDecide(MEMBER), false);
  assert.equal(await noteOf(), 'Budget is 1000');
});

test('decided once: pressing it on two devices can’t do it twice', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New', was: 'Budget is 1000' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  await refused(() => decideCorrection(env, { id: c.id, make: false }, ADMIN), 409);
  assert.equal(await noteOf(), 'New');
});

test('words that changed since it was suggested are never written over', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'From Sam', was: 'Budget is 1000' }, MEMBER);
  await saveNotes(env, ID, { changes: { 'n:i_budget': 'Secretary changed it' } }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
  await assert.rejects(() => decideCorrection(env, { id: c.id, make: true }, SECRETARY), (e) => { assert.equal(e.status, 409); assert.equal(e.extra.stale, true); return true; });
  assert.equal(await noteOf(), 'Secretary changed it');
  // Still there to decide: kept as it is
  assert.equal((await page(SECRETARY))[0].state, 'waiting');
  await decideCorrection(env, { id: c.id, make: false }, SECRETARY);
});

test('what’s typed and not sent stays that way: a correction changes its own box and nothing else', async () => {
  await typed({ 'n:i_budget': 'Budget is 1000', 'n:s_open': 'Forum', 'r:sam-ortiz': 'present' });
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New', was: 'Budget is 1000' }, MEMBER);
  await saveNotes(env, ID, { changes: { 'n:s_open': 'Half a sentence' } }, SECRETARY);
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  assert.equal(await noteOf(), 'New');
  assert.equal((await getMeeting(env.DB, ID)).sections[1].notes, 'Forum', 'unsent words didn’t go out with it');
  assert.equal((await notesFor(env, ID, SECRETARY, { quick: true })).notes['n:s_open'], 'Half a sentence');
  assert.ok((await notesState(env.DB)).waiting.includes(ID), 'and they still read as unsent');
});

test('unsent words in the same box are never written over', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'From Sam', was: 'Budget is 1000' }, MEMBER);
  await saveNotes(env, ID, { changes: { 'n:i_budget': 'The secretary is mid-sentence' } }, SECRETARY);
  await assert.rejects(() => decideCorrection(env, { id: c.id, make: true }, ADMIN), (e) => { assert.equal(e.extra?.unsent, true); return true; });
  assert.equal(await noteOf(), 'Budget is 1000');
  assert.equal((await notesFor(env, ID, SECRETARY, { quick: true })).notes['n:i_budget'], 'The secretary is mid-sentence');
  assert.equal((await page(SECRETARY))[0].state, 'waiting');
});

test('a correction can’t take the whole minutes off the meeting', async () => {
  await typed({ 'n:i_budget': 'Budget is 1000', adjourned: '10:00' });
  const before = await getMeeting(env.DB, ID);
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: '', was: 'Budget is 1000' }, MEMBER);
  await assert.rejects(() => decideCorrection(env, { id: c.id, make: true }, SECRETARY), (e) => { assert.equal(e.extra?.empties, true); return true; });
  const after = await getMeeting(env.DB, ID);
  assert.ok(after.minutesFrom?.typed);
  assert.equal(after.files.filter((f) => f.kind === 'minutes').length, before.files.filter((f) => f.kind === 'minutes').length);
  assert.equal(await noteOf(), 'Budget is 1000');
});

test('correcting one person changes nobody else on the roll, now or at the next send', async () => {
  await patchMeeting(env.DB, ID, (m) => ({ ...m, attendance: m.attendance.map((p) => (p.slug === 'alex-rivera' ? { ...p, status: 'remote' } : p.slug === 'kim-park' ? { ...p, status: 'present' } : p)) }), { by: 'x' });
  await typed({ 'n:i_budget': 'Budget is 1000' });
  const blank = (await getMeeting(env.DB, ID)).attendance.find((p) => p.slug === 'sam-ortiz').status;
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'r:alex-rivera', words: 'present' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  const m = await getMeeting(env.DB, ID);
  assert.equal(m.attendance.find((p) => p.slug === 'alex-rivera').status, 'present');
  assert.equal(m.attendance.find((p) => p.slug === 'sam-ortiz').status, blank);
  await saveNotes(env, ID, { changes: { 'n:i_budget': 'A later fix' } }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
  assert.equal((await getMeeting(env.DB, ID)).attendance.find((p) => p.slug === 'sam-ortiz').status, blank);
  assert.equal((await getMeeting(env.DB, ID)).attendance.find((p) => p.slug === 'alex-rivera').status, 'present');
});

test('after a correction, the next send keeps it and adds nothing: the notes and the meeting agree', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Corrected', was: 'Budget is 1000' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  assert.ok(!(await notesState(env.DB)).waiting.includes(ID), 'nothing reads as unsent');
  const n = await notesFor(env, ID, SECRETARY, { quick: true });
  assert.deepEqual(n.fixed, [], 'it doesn’t read as a founder’s change');
  await saveNotes(env, ID, { changes: { 'n:s_open': 'Something new' } }, SECRETARY);
  const r = await sendNotes(env, ID, SECRETARY);
  assert.equal(r.kept, 0);
  assert.equal(await noteOf(), 'Corrected');
  // And an item nobody typed under the first time
  await patchMeeting(env.DB, ID, (m) => ({ ...m, sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_secret' ? { ...it, notes: 'From the agenda' } : it)) })) }), { by: 'x' });
  const { correction: d } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_secret', words: 'Corrected too', was: 'From the agenda' }, MEMBER);
  await decideCorrection(env, { id: d.id, make: true }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
  assert.equal(await noteOf('i_secret'), 'Corrected too');
});

test('pressed again after it stopped partway, or two pressed at once: each ends up made', async () => {
  await typed({ 'n:i_budget': 'Budget is 1000', 'n:s_open': 'Forum', 'r:sam-ortiz': 'present' });
  const { correction: a } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New', was: 'Budget is 1000' }, MEMBER);
  const { correction: b } = await suggestCorrection(env, { meetingId: ID, target: 'n:s_open', words: 'Better', was: 'Forum' }, MEMBER);
  const both = await Promise.allSettled([decideCorrection(env, { id: a.id, make: true }, SECRETARY), decideCorrection(env, { id: b.id, make: true }, ADMIN)]);
  // (one send at a time: the other is asked to wait, with nothing left behind, and pressing again finishes it)
  for (const [i, r] of both.entries()) if (r.status === 'rejected') { assert.equal(r.reason.status, 409); await decideCorrection(env, { id: [a, b][i].id, make: true }, SECRETARY); }
  assert.deepEqual((await page(SECRETARY)).map((c) => c.state), ['made', 'made']);
  assert.equal(await noteOf(), 'New');
  assert.equal((await getMeeting(env.DB, ID)).sections[1].notes, 'Better');
  // The meeting has the words and the Worker stopped before saying so: its claim runs out, and it finishes
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'r:sam-ortiz', words: 'remote' }, MEMBER);
  await patchMeeting(env.DB, ID, (m) => ({ ...m, attendance: m.attendance.map((p) => (p.slug === 'sam-ortiz' ? { ...p, status: 'remote' } : p)) }), { by: 'x' });
  await env.DB.prepare("UPDATE board_minutes_corrections SET state = 'making', decided_at = ? WHERE id = ?").bind(new Date(Date.now() - 5 * 60 * 1000).toISOString(), c.id).run();
  assert.equal((await decideCorrection(env, { id: c.id, make: true }, SECRETARY)).state, 'made');
});

test('a correction holds through every later send, whoever it was about', async () => {
  // Words taken out of an item that had agenda words first: gone, and they stay gone
  await patchMeeting(env.DB, ID, (m) => ({ ...m, sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_budget' ? { ...it, notes: 'From the agenda' } : it)) })) }), { by: 'x' });
  await typed({ 'n:i_budget': 'Typed words', 'n:s_open': 'Forum', 'r:sam-ortiz': 'present', 'r:alex-rivera': 'present', guests: 'Jane Doe' });
  const out = (await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: '', was: 'Typed words' }, MEMBER)).correction;
  await decideCorrection(env, { id: out.id, make: true }, SECRETARY);
  assert.equal(await noteOf(), '');
  // Someone named on the Guests line, and the person keeping them: corrected, they stay corrected
  const jane = (await suggestCorrection(env, { meetingId: ID, target: 'r:jane-doe', words: 'remote' }, MEMBER)).correction;
  await decideCorrection(env, { id: jane.id, make: true }, SECRETARY);
  const kim = (await suggestCorrection(env, { meetingId: ID, target: 'r:kim-park', words: 'excused' }, MEMBER)).correction;
  await decideCorrection(env, { id: kim.id, make: true }, SECRETARY);
  const status = async (slug) => (await getMeeting(env.DB, ID)).attendance.find((p) => p.slug === slug).status;
  assert.equal(await status('jane-doe'), 'remote');
  assert.equal(await status('kim-park'), 'excused');
  await saveNotes(env, ID, { changes: { 'n:s_open': 'A later send' } }, SECRETARY);
  const r = await sendNotes(env, ID, SECRETARY);
  assert.equal(r.kept, 0, 'and nothing reads as a founder’s change');
  assert.equal(await noteOf(), '');
  assert.equal(await status('jane-doe'), 'remote');
  assert.equal(await status('kim-park'), 'excused');
});

test('a guest isn’t someone a correction can move: the Guests line is theirs', async () => {
  await typed({ 'n:i_budget': 'Budget is 1000', 'r:sam-ortiz': 'present', guests: 'Pat Visitor' });
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'r:guest:pat visitor', words: 'remote' }, MEMBER), 409);
});

test('the secretary already typed the same words: made, and nothing reads as unsent', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Same words', was: 'Budget is 1000' }, MEMBER);
  await saveNotes(env, ID, { changes: { 'n:i_budget': 'Same words' } }, SECRETARY, { now: Date.now() + 1000 });
  assert.ok((await notesState(env.DB)).waiting.includes(ID));
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY, { now: Date.now() + 2000 });
  assert.equal(await noteOf(), 'Same words');
  assert.ok(!(await notesState(env.DB)).waiting.includes(ID));
});

test('an item nobody typed under: the notes own the correction, so clearing the box takes it back', async () => {
  await patchMeeting(env.DB, ID, (m) => ({ ...m, sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_secret' ? { ...it, notes: 'From the agenda' } : it)) })) }), { by: 'x' });
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_secret', words: 'Corrected', was: 'From the agenda' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  await saveNotes(env, ID, { changes: { 'n:i_secret': null } }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
  assert.equal(await noteOf('i_secret'), 'From the agenda');
});

test('unsent words elsewhere don’t count as minutes: a correction can’t leave only those', async () => {
  await typed({ 'n:i_budget': 'The only sent words', adjourned: '10:00' });
  await saveNotes(env, ID, { changes: { 'n:s_open': 'Unsent words' } }, SECRETARY);
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: '', was: 'The only sent words' }, MEMBER);
  await assert.rejects(() => decideCorrection(env, { id: c.id, make: true }, SECRETARY), (e) => { assert.equal(e.extra?.empties, true); return true; });
  assert.ok((await getMeeting(env.DB, ID)).minutesFrom?.typed);
  assert.equal(await noteOf(), 'The only sent words');
});

test('a correction waits its turn behind a send under way, and leaves nothing behind', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New', was: 'Budget is 1000' }, MEMBER);
  await env.DB.prepare('UPDATE board_minutes_notes SET sending = ? WHERE meeting_id = ?').bind(new Date().toISOString(), ID).run();
  await refused(() => decideCorrection(env, { id: c.id, make: true }, SECRETARY), 409, /being sent right now/);
  assert.equal(await noteOf(), 'Budget is 1000');
  assert.equal((await notesFor(env, ID, SECRETARY, { quick: true })).notes['n:i_budget'], 'Budget is 1000');
  await env.DB.prepare('UPDATE board_minutes_notes SET sending = NULL WHERE meeting_id = ?').bind(ID).run();
  await decideCorrection(env, { id: c.id, make: false }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
  assert.equal(await noteOf(), 'Budget is 1000', 'declined, its words never reach the meeting');
});

test('a correction never touches anything but its box: held-back words stay held, and another meeting’s approval stays', async () => {
  await typed();
  // Words a send held back behind a founder's, then the founder clears theirs
  await patchMeeting(env.DB, ID, (m) => ({ ...m, sections: m.sections.map((s) => (s.id === 's_open' ? { ...s, notes: 'Founder words' } : s)) }), { by: 'x' });
  await saveNotes(env, ID, { changes: { 'n:s_open': 'Held back' } }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
  await patchMeeting(env.DB, ID, (m) => ({ ...m, sections: m.sections.map((s) => (s.id === 's_open' ? { ...s, notes: '' } : s)) }), { by: 'x' });
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Corrected', was: 'Budget is 1000' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: true }, ADMIN);
  const m = await getMeeting(env.DB, ID);
  assert.equal(m.sections[1].notes, '', 'the held-back words stay off the meeting');
  assert.equal(await noteOf(), 'Corrected');
});

test('a late check-in or an unusual roll can’t get into the Word file through a correction', async () => {
  await typed({ 'n:i_budget': 'Budget is 1000', 'r:sam-ortiz': 'present', 'r:kim-park': 'present' });
  await env.DB.prepare('INSERT INTO board_checkins (meeting_id, slug, how, at) VALUES (?, ?, ?, ?)').bind(ID, 'alex-rivera', 'present', new Date().toISOString()).run();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Corrected', was: 'Budget is 1000' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  const m = await getMeeting(env.DB, ID);
  const f = m.files.find((x) => x.kind === 'minutes');
  const key = (await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ?').bind(f.id).first()).r2_key;
  const text = await docxText(objects.get(key));
  assert.match(text, /Corrected/);
  assert.notEqual(m.attendance.find((p) => p.slug === 'alex-rivera').status, 'present');
  assert.doesNotMatch(text, /x Alex Rivera/, 'the file says what the meeting says');
});

test('a Word file someone deleted stays deleted', async () => {
  await typed();
  const { deleteFile } = await import('../functions/api/_board.js');
  const f = (await getMeeting(env.DB, ID)).files.find((x) => x.kind === 'minutes');
  await deleteFile(env, f.id);
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Corrected', was: 'Budget is 1000' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  assert.equal((await getMeeting(env.DB, ID)).files.filter((x) => x.kind === 'minutes').length, 0);
});

test('Make carries the words on the page: reworded since, they read it first', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'First go', was: 'Budget is 1000' }, MEMBER);
  await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Second go', was: 'Budget is 1000' }, MEMBER);
  await assert.rejects(() => decideCorrection(env, { id: c.id, make: true, saw: 'First go' }, SECRETARY), (e) => { assert.equal(e.extra?.reload, true); return true; });
  assert.equal(await noteOf(), 'Budget is 1000');
  assert.equal((await decideCorrection(env, { id: c.id, make: true, saw: 'Second go' }, SECRETARY)).state, 'made');
  assert.equal(await noteOf(), 'Second go');
});

test('it stopped after the meeting had it: pressing again brings the notes and the Word file up', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Corrected', was: 'Budget is 1000' }, MEMBER);
  await patchMeeting(env.DB, ID, (m) => ({ ...m, sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_budget' ? { ...it, notes: 'Corrected' } : it)) })) }), { by: 'x' });
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  assert.equal((await notesFor(env, ID, SECRETARY, { quick: true })).notes['n:i_budget'], 'Corrected');
  await sendNotes(env, ID, SECRETARY);
  assert.equal(await noteOf(), 'Corrected');
  const f = (await getMeeting(env.DB, ID)).files.find((x) => x.kind === 'minutes');
  const key = (await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ?').bind(f.id).first()).r2_key;
  assert.match(await docxText(objects.get(key)), /Corrected/);
});

test('a correction can’t empty the draft either, and taking the minutes back brings back what it took out', async () => {
  await typed({ 'n:i_budget': 'Typed', 'n:s_open': 'Forum' });
  await saveNotes(env, ID, { changes: { 'n:s_open': null } }, SECRETARY);
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: '', was: 'Typed' }, MEMBER);
  await assert.rejects(() => decideCorrection(env, { id: c.id, make: true }, SECRETARY), (e) => { assert.equal(e.extra?.empties, true); return true; });
  assert.equal(await noteOf(), 'Typed');
});

test('words a correction took out come back when the whole minutes are taken back', async () => {
  await patchMeeting(env.DB, ID, (m) => ({ ...m, sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_budget' ? { ...it, notes: 'From the agenda' } : it)) })) }), { by: 'x' });
  await typed({ 'n:i_budget': 'Typed', 'n:s_open': 'Forum' });
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: '', was: 'Typed' }, MEMBER);
  await decideCorrection(env, { id: c.id, make: true }, SECRETARY);
  assert.equal(await noteOf(), '');
  await saveNotes(env, ID, { changes: { 'n:s_open': 'Still here' } }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
  assert.equal(await noteOf(), '', 'gone through a later send');
  const row = JSON.parse((await env.DB.prepare('SELECT data FROM board_minutes_notes WHERE meeting_id = ?').bind(ID).first()).data);
  await saveNotes(env, ID, { changes: Object.fromEntries(Object.keys(row).map((k) => [k, null])) }, SECRETARY);
  assert.equal((await sendNotes(env, ID, SECRETARY)).cleared, true);
  assert.equal(await noteOf(), 'From the agenda');
});

test('a founder’s save that lands as a correction goes on is never written over', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Corrected', was: 'Budget is 1000' }, MEMBER);
  // The moment the notes row is read, after the meeting was: a founder's save lands
  const realPrepare = env.DB.prepare.bind(env.DB);
  let fired = false;
  env.DB.prepare = (sql) => {
    if (!fired && /^SELECT data, sent FROM board_minutes_notes/.test(sql)) { fired = true; return { bind: (...a) => ({ first: async () => { await patchMeeting({ ...env.DB, prepare: realPrepare, batch: env.DB.batch?.bind(env.DB) }, ID, (m) => ({ ...m, sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_budget' ? { ...it, notes: 'Founder got there first' } : it)) })) }), { by: 'x' }); return realPrepare(sql).bind(...a).first(); } }) }; }
    return realPrepare(sql);
  };
  await assert.rejects(() => decideCorrection(env, { id: c.id, make: true }, SECRETARY), (e) => { assert.equal(e.extra?.stale, true); return true; });
  env.DB.prepare = realPrepare;
  assert.equal(await noteOf(), 'Founder got there first');
  assert.equal((await page(SECRETARY))[0].state, 'waiting');
});

test('nobody marked as there yet: the roll can’t be corrected', async () => {
  await typed({ 'n:i_budget': 'Budget is 1000' });
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'r:sam-ortiz', words: 'remote' }, MEMBER), 409, /Nobody is marked/);
});

test('minutes taken off the meeting after it was suggested: a correction has nothing to go on', async () => {
  await typed({ 'n:i_budget': 'Budget is 1000', 'n:s_open': 'Forum', 'r:sam-ortiz': 'present' });
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'general', words: 'A note' }, MEMBER);
  const w = (await suggestCorrection(env, { meetingId: ID, target: 'n:i_secret', words: 'Blank box filled', was: '' }, MEMBER)).correction;
  const row = JSON.parse((await env.DB.prepare('SELECT data FROM board_minutes_notes WHERE meeting_id = ?').bind(ID).first()).data);
  await saveNotes(env, ID, { changes: Object.fromEntries(Object.keys(row).map((k) => [k, null])) }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
  await refused(() => decideCorrection(env, { id: w.id, make: true }, SECRETARY), 409, /aren’t on the meeting/);
  assert.equal(await noteOf('i_secret'), '');
  assert.equal((await decideCorrection(env, { id: c.id, make: false }, SECRETARY)).state, 'declined', 'it can still be closed');
});

test('being made right now says so, not “already decided”', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'general', words: 'A note' }, MEMBER);
  await env.DB.prepare("UPDATE board_minutes_corrections SET state = 'making', decided_at = ? WHERE id = ?").bind(new Date().toISOString(), c.id).run();
  await refused(() => decideCorrection(env, { id: c.id, make: true }, SECRETARY), 409, /being made right now/);
});

test('already what the minutes say: made, whichever was pressed, never “kept as they are”', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Fixed', was: 'Budget is 1000' }, MEMBER);
  await saveNotes(env, ID, { changes: { 'n:i_budget': 'Fixed' } }, SECRETARY);
  await sendNotes(env, ID, SECRETARY);
  assert.equal((await decideCorrection(env, { id: c.id, make: false }, SECRETARY)).state, 'made');
});

test('undecided when the board approves: said as such, and back to waiting if they go back to draft', async () => {
  await typed();
  await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New', was: 'Budget is 1000' }, MEMBER);
  await patchMeeting(env.DB, ID, (m) => ({ ...m, minutes: 'approved', approvedOn: TODAY }), { by: 'x' });
  assert.equal((await page(MEMBER))[0].state, 'closed');
  await patchMeeting(env.DB, ID, (m) => ({ ...m, minutes: 'draft', approvedOn: '' }), { by: 'x' });
  assert.equal((await page(MEMBER))[0].state, 'waiting');
});

test('a meeting taken off the board page takes its corrections with it, for members', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New', was: 'Budget is 1000' }, MEMBER);
  await saveMeeting(env.DB, { ...(await getMeeting(env.DB, ID)), shared: false }, { by: 'x' });
  assert.deepEqual(await page(MEMBER), []);
  assert.equal((await page(ADMIN)).length, 1);
  await refused(() => decideCorrection(env, { id: c.id, make: true }, SECRETARY), 404);
  assert.equal((await decideCorrection(env, { id: c.id, make: true }, ADMIN)).state, 'made');
});

test('approved minutes take no more corrections, and none can be made', async () => {
  await typed();
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New', was: 'Budget is 1000' }, MEMBER);
  await patchMeeting(env.DB, ID, (m) => ({ ...m, minutes: 'approved', approvedOn: TODAY }), { by: 'x' });
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Another', was: 'Budget is 1000' }, OTHER), 409, /approved/);
  await refused(() => decideCorrection(env, { id: c.id, make: true }, SECRETARY), 409, /approved/);
  assert.equal(await noteOf(), 'Budget is 1000');
});

test('what can’t be suggested', async () => {
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'x y z' }, MEMBER), 409, /aren’t in yet/);
  await typed();
  await refused(() => suggestCorrection(env, { meetingId: 'bad id!', target: 'general', words: 'abc' }, MEMBER), 400);
  await refused(() => suggestCorrection(env, { meetingId: 'm_nowhere1', target: 'general', words: 'abc' }, MEMBER), 404);
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'n:i_gone', words: 'abc' }, MEMBER), 409);
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'x:i_budget', words: 'abc' }, MEMBER), 409);
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Budget is 1000', was: 'Budget is 1000' }, MEMBER), 400, /says now/);
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New', was: 'Old words' }, MEMBER), 409, /changed/);
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'r:sam-ortiz', words: 'asleep' }, MEMBER), 400);
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'r:sam-ortiz', words: 'present' }, MEMBER), 400, /says now/);
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'general', words: 'a' }, MEMBER), 400);
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'general', words: 'abc' }, { member: null, admin: false }), 403);
  await saveMeeting(env.DB, { ...(await getMeeting(env.DB, ID)), shared: false }, { by: 'x' });
  await refused(() => suggestCorrection(env, { meetingId: ID, target: 'general', words: 'abc' }, MEMBER), 404);
});

test('saying it again replaces their own, and anything else is theirs to take back', async () => {
  await typed();
  await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'First go', was: 'Budget is 1000' }, MEMBER);
  await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Second go', was: 'Budget is 1000' }, MEMBER);
  await suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'Alex says', was: 'Budget is 1000' }, OTHER);
  const shown = await page(SECRETARY);
  assert.deepEqual(shown.map((c) => c.words), ['Second go', 'Alex says']);
  await refused(() => withdrawCorrection(env, shown[1].id, MEMBER), 409);
  await withdrawCorrection(env, shown[1].id, OTHER);
  assert.equal((await page(SECRETARY)).length, 1);
  const { correction: g } = await suggestCorrection(env, { meetingId: ID, target: 'general', words: 'The motion was seconded by Kim' }, MEMBER);
  await suggestCorrection(env, { meetingId: ID, target: 'general', words: 'And Sam is missing' }, MEMBER);
  assert.equal((await page(SECRETARY)).length, 3, 'each thing said about anything else is its own');
  await decideCorrection(env, { id: g.id, make: true }, SECRETARY);
  assert.equal((await page(OTHER)).find((c) => c.id === g.id).state, 'made');
});

test('a page that doesn’t say what it read can’t suggest words, and taking one back twice is taken back', async () => {
  await typed();
  await assert.rejects(() => suggestCorrection(env, { meetingId: ID, target: 'n:i_budget', words: 'New' }, MEMBER), (e) => { assert.equal(e.status, 409); assert.equal(e.extra?.reload, true); return true; });
  const { correction: c } = await suggestCorrection(env, { meetingId: ID, target: 'general', words: 'Add the guest' }, MEMBER);
  await withdrawCorrection(env, c.id, MEMBER);
  assert.deepEqual(await withdrawCorrection(env, c.id, MEMBER), { id: c.id });
  const { correction: d } = await suggestCorrection(env, { meetingId: ID, target: 'general', words: 'Add the other guest' }, MEMBER);
  await decideCorrection(env, { id: d.id, make: true }, SECRETARY);
  await refused(() => withdrawCorrection(env, d.id, MEMBER), 409, /already been decided/);
});

test('a founder can suggest one too, and sees it as theirs', async () => {
  await typed();
  await suggestCorrection(env, { meetingId: ID, target: 'general', words: 'Add the guest' }, ADMIN);
  const [c] = await page(ADMIN);
  assert.equal(c.by, 'Jane Doe');
  assert.equal(c.mine, true);
});

test('a deleted meeting takes its corrections with it', async () => {
  await typed();
  await suggestCorrection(env, { meetingId: ID, target: 'general', words: 'Add the guest' }, MEMBER);
  await deleteMeeting(env, ID).catch(async () => { await deleteMeeting(env.DB, ID); });
  assert.deepEqual(await correctionsForPage(env.DB, SECRETARY), {});
});

test('a board-only item isn’t named in the email, and the words are never in it', async () => {
  const m = await getMeeting(env.DB, ID);
  assert.equal(targetOf(m, 'n:i_secret').secret, true);
  assert.equal(targetOf(m, 'n:i_budget').secret, false);
  assert.equal(targetOf(m, 'n:nothing'), null);
  assert.equal(targetOf(m, 'r:nobody'), null);
  const mail = correctionEmail(m, { by: 'Sam Ortiz', where: 'a board-only item' });
  assert.match(mail.text, /Sam Ortiz suggested a correction/);
  assert.match(mail.text, /under a board-only item/);
  assert.doesNotMatch(mail.html, /A settlement/);
  assert.match(correctionDecidedEmail(m, { made: true, by: 'Kim Park' }).subject, /Your correction was made/);
  assert.match(correctionDecidedEmail(m, { made: false, by: 'Kim Park' }).text, /kept them as they are/);
});
