/**
 * The secretary's notes typed beside the agenda (functions/api/_board-notes.js): theirs and the admins' alone until
 * sent, saved one box at a time, and sent onto the meeting by exact id with a filled-in Word file as the record.
 * Made-up people only (the repo is public).
 * Run: node --test tests/board-notes.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, getMeeting, deleteMeeting, ensureSchema } from '../functions/api/_board.js';
import { applyNotes, cleanChange, notesFor, saveNotes, sendNotes, notesWaiting, notesState, refreshMinutesFile } from '../functions/api/_board-notes.js';
import { readMinutes, applyMinutes, withoutVoteLines, minutesNewer, readMinutesInto, secretarySends } from '../functions/api/_board-minutes.js';
import { minutesDocx } from '../public/admin/board-minutes-template.js';
import { docxText, todayEastern, draftAgenda, agendaItems, agendaIsDraft } from '../public/admin/board-shared.js';

const PEOPLE = [
  { slug: 'alex-rivera', name: 'Alex Rivera', org: '', kind: 'board' },
  { slug: 'sam-ortiz', name: 'Sam Ortiz', org: '', kind: 'board' },
  { slug: 'kim-park', name: 'Kim Park', org: '', kind: 'board' },
  { slug: 'jane-doe', name: 'Jane Doe', org: 'SOARD', kind: 'staff' },
];
const TODAY = todayEastern();
const shift = (days) => new Date(Date.parse(`${TODAY}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const SECRETARY = { member: { slug: 'kim-park', name: 'Kim Park', email: 'kim@example.com', seat: 'secretary' }, admin: false };
const MEMBER = { member: { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam@example.com', seat: '' }, admin: false };
const ADMIN = { member: null, admin: true, adminEmail: 'jane@example.com' };

const meetingBody = (over = {}) => ({
  id: 'm_notes0001', date: TODAY, start: '08:00', end: '10:00', shared: true,
  attendance: [...PEOPLE.map((p) => ({ slug: p.slug, name: p.name, kind: p.kind }))],
  sections: [
    { id: 's_call', title: 'Call to order', items: [{ id: 'i_roll', title: 'Roll call' }] },
    { id: 's_prev', title: 'Approve meeting minutes', items: [{ id: 'i_prev', title: 'Last minutes', live: 'minutes' }] },
    { id: 's_new', title: 'New business', items: [{ id: 'i_budget', title: 'Budget', notes: 'Background from the treasurer', motion: 'Approve the 2027 budget' }] },
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
beforeEach(async () => {
  objects.clear();
  const DB = await createD1();
  env = { DB, FILES: bucket };
  await ensureSchema(DB);
  await DB.prepare('CREATE TABLE IF NOT EXISTS team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, data TEXT)').run().catch(() => {});
  for (const p of PEOPLE) await DB.prepare('INSERT OR REPLACE INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(p.slug, p.name, p.kind === 'staff' ? 'team' : 'board', JSON.stringify({ name: p.name, group: p.kind === 'staff' ? 'team' : 'board' })).run();
  await DB.prepare('CREATE TABLE IF NOT EXISTS reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT)').run();
  await DB.prepare('INSERT OR REPLACE INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('kim-park', 'kim@example.com').run();
  await saveMeeting(DB, { ...meetingBody() }, { by: 'jane@example.com' });
  await saveMeeting(DB, { id: 'm_prev00001', date: shift(-90), start: '08:00', shared: true, attendance: [], sections: [] }, { by: 'jane@example.com' });
});
afterEach(() => { env = null; });

const fill = (changes, w = SECRETARY) => saveNotes(env, 'm_notes0001', { changes }, w);
const refused = (p, status, msg) => assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (msg) assert.match(e.message, msg); return true; });

test('only the secretary’s seat and Board’s admins can read, save or send the draft', async () => {
  await fill({ 'n:i_roll': 'Called to order at 8:02' });
  await refused(notesFor(env, 'm_notes0001', MEMBER), 403);
  await refused(saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'x' } }, MEMBER), 403);
  await refused(sendNotes(env, 'm_notes0001', MEMBER), 403);
  assert.equal((await notesFor(env, 'm_notes0001', SECRETARY)).notes['n:i_roll'], 'Called to order at 8:02');
  assert.equal((await notesFor(env, 'm_notes0001', ADMIN)).notes['n:i_roll'], 'Called to order at 8:02');
});

test('a meeting the board can’t see isn’t the secretary’s to take notes on', async () => {
  await saveMeeting(env.DB, { ...meetingBody({ id: 'm_notshared', shared: false }) }, { by: 'x' });
  await refused(notesFor(env, 'm_notshared', SECRETARY), 404);
  await notesFor(env, 'm_notshared', ADMIN);
});

test('saving merges box by box: two devices can’t undo each other, and an emptied box is gone', async () => {
  await fill({ 'n:i_roll': 'From the laptop' });
  await fill({ 'n:i_budget': 'From the phone' });
  await fill({ 'r:alex-rivera': 'present', guests: 'Ann Guest' });
  await fill({ 'n:i_roll': '' });
  const { notes } = await notesFor(env, 'm_notes0001', SECRETARY);
  assert.deepEqual(Object.keys(notes).sort(), ['guests', 'n:i_budget', 'r:alex-rivera']);
});

test('nothing strange is kept: unknown boxes, a made-up status, a motion with nothing on it', async () => {
  assert.throws(() => cleanChange('secret', 'x'), (e) => e.status === 400);
  assert.throws(() => cleanChange('n:../../x', 'x'), (e) => e.status === 400);
  assert.throws(() => cleanChange('r:alex-rivera', 'asleep'), (e) => e.status === 400);
  assert.throws(() => cleanChange('m:v_abc', 'not an object'), (e) => e.status === 400);
  assert.deepEqual(cleanChange('m:v_abc', { by: '', result: 'maybe' }), { by: null, result: null }, 'only the fields that changed, a cleared one taken off');
  assert.equal(cleanChange('n:i_roll', '   \n '), null);
  assert.deepEqual(cleanChange('a:a_abc', { due: 'soon' }), { due: null });
  assert.deepEqual(cleanChange('m:v_abc', { text: 'Buy a van', by: 'Alex', for: '4', against: 0, abstain: -1, result: 'passed' }), { text: 'Buy a van', by: 'Alex', for: 4, against: 0, abstain: null, result: 'passed' });
  assert.equal(cleanChange('n:i_roll', 'one\u000Btwo\u000Cthree'), 'one\ntwo\nthree', 'a paste’s odd line breaks stay line breaks');
  await refused(fill(Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`n:i_x${i}`, 'x']))), 413);
});

test('two devices on one box of words: the save that started from older words doesn’t overwrite, it comes back to choose', async () => {
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'From the laptop' }, was: { 'n:i_roll': '' } }, SECRETARY);
  const r = await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'From the phone', 'n:i_budget': 'Another box' }, was: { 'n:i_roll': '', 'n:i_budget': '' } }, SECRETARY);
  assert.deepEqual(r.clashes, [{ key: 'n:i_roll', theirs: 'From the laptop' }]);
  let { notes } = await notesFor(env, 'm_notes0001', SECRETARY);
  assert.equal(notes['n:i_roll'], 'From the laptop');
  assert.equal(notes['n:i_budget'], 'Another box', 'the other box goes in all the same');
  const kept = await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'From the phone' }, was: { 'n:i_roll': 'From the laptop' } }, SECRETARY);
  assert.deepEqual(kept.clashes, []);
  ({ notes } = await notesFor(env, 'm_notes0001', SECRETARY));
  assert.equal(notes['n:i_roll'], 'From the phone');
});

test('one field of a vote at a time: a founder pressing Passed leaves who moved it', async () => {
  await fill({ 'm:i_budget': { text: 'Approve the 2027 budget', by: 'Alex Rivera', second: 'Sam Ortiz', for: 3 } });
  await fill({ 'm:i_budget': { result: 'passed' } }, ADMIN);
  await fill({ 'm:i_budget': { second: '' } });
  const { notes } = await notesFor(env, 'm_notes0001', SECRETARY);
  assert.deepEqual(notes['m:i_budget'], { text: 'Approve the 2027 budget', by: 'Alex Rivera', for: 3, result: 'passed' });
});

test('who the meeting already has comes with the draft, and a send never overwrites what nobody touched', async () => {
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, attendance: held.attendance.map((p) => (p.slug === 'alex-rivera' ? { ...p, status: 'present' } : p)) }, { by: 'x' });
  await env.DB.prepare('INSERT INTO board_checkins (meeting_id, slug, name, how, at) VALUES (?, ?, ?, ?, ?)').bind('m_notes0001', 'sam-ortiz', 'Sam Ortiz', 'remote', 'x').run();
  assert.deepEqual((await notesFor(env, 'm_notes0001', SECRETARY)).roll, { 'sam-ortiz': 'remote', 'alex-rivera': 'present' });
  // Notes alone, with a check-in: the panel shows them here, and the secretary keeping it, so the meeting says so too
  await fill({ 'n:i_roll': 'Called to order' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  let m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual(['alex-rivera', 'sam-ortiz', 'kim-park'].map((x) => m.attendance.find((p) => p.slug === x).status), ['present', 'remote', 'present']);
  // Someone marked: what they had stands
  await fill({ 'r:kim-park': 'present' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual(['alex-rivera', 'sam-ortiz', 'kim-park'].map((x) => m.attendance.find((p) => p.slug === x).status), ['present', 'remote', 'present']);
  // Marked off: `absent` beats what the meeting had
  await fill({ 'r:alex-rivera': 'absent' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  m = await getMeeting(env.DB, 'm_notes0001');
  assert.equal(m.attendance.find((p) => p.slug === 'alex-rivera').status, 'absent');
});

test('notes alone, with nobody marked and nobody checked in, leave the attendance as it was', async () => {
  await fill({ 'n:i_roll': 'Called to order' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual(['alex-rivera', 'kim-park'].map((x) => m.attendance.find((p) => p.slug === x).status), ['', '']);
});

test('someone already on the meeting as here: what the panel shows goes in, the secretary with them', async () => {
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, attendance: held.attendance.map((p) => (p.slug === 'alex-rivera' ? { ...p, status: 'present' } : p)) }, { by: 'x' });
  await fill({ 'n:i_roll': 'Called to order' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual(['alex-rivera', 'kim-park'].map((x) => m.attendance.find((p) => p.slug === x).status), ['present', 'present']);
});

test('fixing a word never changes who was there or who took the minutes: a new secretary, or one who missed it', async () => {
  const word = async () => docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  const NEXT = { member: { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam@example.com', seat: 'secretary' }, admin: false };
  const status = async (slug) => (await getMeeting(env.DB, 'm_notes0001')).attendance.find((p) => p.slug === slug).status;
  // The seat moves on after the send
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to ordr' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(await status('kim-park'), 'present');
  assert.equal(await status('sam-ortiz'), 'absent');
  await fill({ 'n:i_roll': 'Called to order' }, NEXT);
  await sendNotes(env, 'm_notes0001', NEXT);
  assert.equal(await status('kim-park'), 'present');
  assert.equal(await status('sam-ortiz'), 'absent');
  assert.match(await word(), /Minutes taken by: Kim Park/);
});

test('a secretary who missed the meeting and fixes a word afterwards doesn’t become there, or the one who took them', async () => {
  const word = async () => docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  await fill({ 'r:alex-rivera': 'present', 'r:sam-ortiz': 'present', 'n:i_roll': 'Called to ordr' }, ADMIN);
  await sendNotes(env, 'm_notes0001', ADMIN);
  const before = await word();
  const status = async () => (await getMeeting(env.DB, 'm_notes0001')).attendance.find((p) => p.slug === 'kim-park').status;
  assert.equal(await status(), 'absent');
  await fill({ 'n:i_roll': 'Called to order' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(await status(), 'absent');
  assert.equal((await word()).match(/Minutes taken by:[^\n]*/)[0], before.match(/Minutes taken by:[^\n]*/)[0]);
});

test('a row’s words are guarded like a box’s: two devices, nothing written over, the other row’s fields wait for the choice', async () => {
  await fill({ 'a:a_todo0001': { text: 'Call the venue' } });
  await fill({ 'a:a_todo0001': { text: 'Phone: call the venue and book it' } });
  const r = await saveNotes(env, 'm_notes0001', { changes: { 'a:a_todo0001': { text: 'Call the venue by Friday' } }, wasText: { 'a:a_todo0001': ['Call the venue'] } }, SECRETARY);
  assert.deepEqual(r.clashes, [{ key: 'a:a_todo0001', theirs: 'Phone: call the venue and book it', field: 'text' }]);
  assert.equal((await notesFor(env, 'm_notes0001', SECRETARY)).notes['a:a_todo0001'].text, 'Phone: call the venue and book it');
  // Its own words, whose answer was lost, are no clash
  const again = await saveNotes(env, 'm_notes0001', { changes: { 'a:a_todo0001': { text: 'Phone: book it' } }, wasText: { 'a:a_todo0001': ['Call the venue', 'Phone: call the venue and book it'] } }, SECRETARY);
  assert.deepEqual(again.clashes, []);
  assert.equal((await notesFor(env, 'm_notes0001', SECRETARY)).notes['a:a_todo0001'].text, 'Phone: book it');
});

test('the panel is told which items the send put words on, and which Board has changed since', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to order' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  let got = await notesFor(env, 'm_notes0001', SECRETARY, { quick: true });
  assert.deepEqual([got.on, got.fixed], [['i_roll'], []]);
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, sections: held.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_roll' ? { ...it, notes: 'Called to order at 8' } : it.id === 'i_prev' ? { ...it, notes: 'A founder’s note' } : it)) })) }, { by: 'x' });
  got = await notesFor(env, 'm_notes0001', SECRETARY, { quick: true });
  assert.deepEqual([got.on, got.fixed.sort()], [[], ['i_prev', 'i_roll']]);
});

test('the kept Word file follows a founder’s fixes by itself, the same file, with nothing typed since', async () => {
  const word = async () => docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to ordr' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const held = await getMeeting(env.DB, 'm_notes0001');
  const id = held.files.find((f) => f.kind === 'minutes').id;
  await fill({ 'n:s_open': 'Typed since, not sent' });
  await saveMeeting(env.DB, { ...held, sections: held.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_roll' ? { ...it, notes: 'Called to order' } : it)) })) }, { by: 'x' });
  assert.equal(await refreshMinutesFile(env, 'm_notes0001'), true);
  const text = await word();
  assert.ok(text.includes('Called to order') && !text.includes('Called to ordr'), text);
  assert.ok(!text.includes('Typed since'), 'only what was sent');
  assert.match(text, /Minutes taken by: Kim Park/);
  assert.deepEqual((await getMeeting(env.DB, 'm_notes0001')).files.filter((f) => f.kind === 'minutes').map((f) => f.id), [id]);
  assert.equal(objects.size, 1);
});

test('a founder’s fix to a part’s own notes stays through a send, is said, and is what the Word file says', async () => {
  const word = async () => docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  await fill({ 'r:alex-rivera': 'present', 'n:s_open': 'Pelican auction question' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, sections: held.sections.map((s) => (s.id === 's_open' ? { ...s, notes: 'A question about the auction' } : s)) }, { by: 'x' });
  await fill({ 'n:i_roll': 'Called to order' });
  let r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(r.kept, 1);
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).sections.at(-1).notes, 'A question about the auction');
  assert.ok((await word()).includes('A question about the auction'));
  assert.ok(!(await word()).includes('Pelican'));
  r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).sections.at(-1).notes, 'A question about the auction');
});

test('a Word file a founder made staff-only stays staff-only through the next send', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to order' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const held = await getMeeting(env.DB, 'm_notes0001');
  const id = held.files.find((f) => f.kind === 'minutes').id;
  await env.DB.prepare('UPDATE board_files SET staff_only = 1 WHERE id = ?').bind(id).run();
  await fill({ 'n:i_roll': 'Called to order at 8' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).files.find((f) => f.kind === 'minutes').staffOnly, true);
});

test('the chair’s end goes in as the adjourned time unless the secretary typed one; a practice run’s doesn’t', async () => {
  const word = async () => docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, live: { ...held.live, startedAt: `${TODAY}T13:00:00.000Z`, endedAt: `${TODAY}T14:47:00.000Z` } }, { by: 'x' });
  await fill({ 'r:alex-rivera': 'present' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.match(await word(), /Adjourned at: \d/);
  await fill({ adjourned: '09:30' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.match(await word(), /Adjourned at: 9:30/);
});

test('no Word file to bring up: nothing happens', async () => {
  assert.equal(await refreshMinutesFile(env, 'm_notes0001'), false);
});

test('a vote corrected so it no longer approves says so', async () => {
  await fill({ 'r:alex-rivera': 'present', 'm:i_prev': { result: 'passed', text: 'x' } });
  const first = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(first.approvedPrev, true);
  await fill({ 'm:i_prev': { result: 'failed' } });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(r.withdrawn, true);
});

test('a vote the board took that isn’t on the agenda takes who moved it from the notes, and stays one motion', async () => {
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, motions: [{ id: 'v_floor9', text: 'Accept the auditor proposal', by: '', second: '', result: 'passed', tally: { for: 3, against: 0, abstain: 0, of: 3, at: new Date().toISOString() } }] }, { by: 'x' });
  await fill({ 'r:alex-rivera': 'present', 'm:t_v_floor9': { text: 'Accept the auditor proposal', by: 'Alex Rivera', second: 'Sam Ortiz' } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual(m.motions.map((x) => [x.id, x.by, x.second, x.result, x.tally.for]), [['v_floor9', 'Alex Rivera', 'Sam Ortiz', 'passed', 3]]);
});

test('nothing goes to the meeting before its day, or with nothing typed; and an approved meeting is closed', async () => {
  await refused(sendNotes(env, 'm_notes0001', SECRETARY), 400, /Nothing is typed/);
  await saveMeeting(env.DB, { ...meetingBody({ id: 'm_ahead0001', date: shift(7) }) }, { by: 'x' });
  await saveNotes(env, 'm_ahead0001', { changes: { 'n:i_roll': 'Getting ready' } }, SECRETARY);
  await refused(sendNotes(env, 'm_ahead0001', SECRETARY), 400, /day of the meeting/);
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, minutes: 'approved', approvedOn: TODAY }, { by: 'x' });
  await refused(fill({ 'n:i_roll': 'too late' }), 409, /approved/);
});

test('sent: every note on its own item, the roll, the votes, the action items, and the Word file as the record', async () => {
  await fill({
    'r:alex-rivera': 'present', 'r:sam-ortiz': 'remote', 'r:jane-doe': 'present', guests: 'Ann Guest\nBo Visitor',
    'n:i_roll': 'Called to order at 8:02\nA quorum was present',
    'n:i_budget': '- Reserves grew\n- Everyone agreed',
    'n:s_open': 'A question about the spring gala',
    'm:i_budget': { by: 'Alex Rivera', second: 'Sam Ortiz', for: 2, against: 1, abstain: 0, result: 'passed' },
    'm:i_prev': { by: 'Sam Ortiz', second: 'Alex Rivera', result: 'passed' },
    'm:v_floor0001': { text: 'Buy a new van', by: 'Kim Park', second: 'Alex Rivera', result: 'tabled' },
    'a:a_todo0001': { text: 'Send the bylaws to the board', owner: 'alex-rivera', due: shift(10) },
    adjourned: '09:41',
  });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.deepEqual(r.read, { attendance: { here: 3, of: 3 }, notes: 3, motions: 3, actions: 1, ai: false });
  assert.equal(r.kept, 0);
  assert.equal(r.approvedPrev, true, 'the vote on the last minutes approves them');
  assert.equal((await getMeeting(env.DB, 'm_prev00001')).minutes, 'approved');

  const m = await getMeeting(env.DB, 'm_notes0001');
  const item = (id) => m.sections.flatMap((s) => s.items).find((it) => it.id === id);
  assert.equal(item('i_roll').notes, 'Called to order at 8:02\nA quorum was present');
  assert.equal(item('i_budget').notes, '- Reserves grew\n- Everyone agreed');
  assert.equal(item('i_budget').motion, 'Approve the 2027 budget', 'the agenda keeps the item as it was');
  assert.equal(m.sections[3].notes, 'A question about the spring gala');
  assert.equal(m.sections[3].items.length, 0, 'a part open to the floor stays one');
  assert.deepEqual(m.attendance.filter((p) => p.kind !== 'guest').map((p) => `${p.slug}:${p.status}`), ['alex-rivera:present', 'sam-ortiz:remote', 'kim-park:present', 'jane-doe:present'], 'the secretary keeping them counts as there');
  assert.deepEqual(m.attendance.filter((p) => p.kind === 'guest').map((p) => p.name), ['Ann Guest', 'Bo Visitor']);
  const budget = m.motions.find((x) => /2027 budget/.test(x.text));
  assert.deepEqual([budget.by, budget.second, budget.result, budget.tally.for, budget.tally.against], ['Alex Rivera', 'Sam Ortiz', 'passed', 2, 1]);
  assert.ok(m.motions.some((x) => /Approve the minutes of the/.test(x.text) && x.result === 'passed'));
  assert.ok(m.motions.some((x) => x.text === 'Buy a new van' && x.result === 'tabled'));
  assert.deepEqual(m.actions.map((a) => [a.text, a.owner, a.ownerName, a.due]), [['Send the bylaws to the board', 'alex-rivera', 'Alex Rivera', shift(10)]]);
  assert.equal(m.minutesFrom.ai, true, 'the heartbeat never reads typed minutes again (it would add its own guesses)');
  const kept = m.files.filter((f) => f.kind === 'minutes');
  assert.equal(kept.length, 1);
  assert.match(kept[0].name, /minutes \(\d{4}-\d{2}-\d{2}\)\.docx$/);
});

test('an item with no notes keeps its background; a vote nobody recorded isn’t a decision', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to order', 'm:i_budget': { by: 'Alex Rivera' } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.equal(m.sections[2].items[0].notes, 'Background from the treasurer');
  assert.equal(m.motions.length, 0);
});

test('sent again, it replaces: no second copy of a vote, a fixed roll, a removed row gone, the background back, one file', async () => {
  await fill({
    'r:alex-rivera': 'present', 'r:sam-ortiz': 'present', 'r:jane-doe': 'remote', guests: 'Ann Guest',
    'n:i_budget': 'First go', 'n:s_open': 'A question',
    'm:v_floor0001': { text: 'Buy a new van', by: 'Kim Park', result: 'passed' },
    'a:a_todo0001': { text: 'Call the printer', owner: 'sam-ortiz', due: '' },
  });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  await fill({
    'r:sam-ortiz': 'excused', 'r:jane-doe': '', guests: 'Bo Visitor',
    'n:i_budget': '', 'n:s_open': '',
    'm:v_floor0001': { text: 'Buy a new truck', by: 'Kim Park', result: 'failed' },
    'a:a_todo0001': null, 'a:a_todo0002': { text: 'Book the hall', owner: '', due: '' },
  });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual(m.motions.map((x) => [x.text, x.result]), [['Buy a new truck', 'failed']]);
  assert.deepEqual(m.actions.map((x) => x.text), ['Book the hall']);
  assert.equal(m.sections[2].items[0].notes, 'Background from the treasurer');
  assert.equal(m.sections[3].notes, '', 'the part’s note is gone');
  const status = Object.fromEntries(m.attendance.map((p) => [p.name, p.status]));
  assert.deepEqual([status['Alex Rivera'], status['Sam Ortiz'], status['Jane Doe'], status['Bo Visitor'], status['Ann Guest']], ['present', 'excused', '', 'present', undefined]);
  assert.equal(m.files.filter((f) => f.kind === 'minutes').length, 1);
  assert.equal(objects.size, 1, 'the last Word file is gone from storage');
});

test('a vote already on the meeting (the board page’s, or a file’s) isn’t added twice', () => {
  const cur = { ...meetingBody(), motions: [{ id: 'v_live00001', text: 'Approve the 2027 budget', by: '', second: '', result: 'passed', tally: { for: 3, against: 0, abstain: 0, of: 3, at: 'x' } }], actions: [{ id: 'a_old000001', text: 'Book the hall', owner: '', ownerName: '', due: '', done: true, doneOn: TODAY }] };
  const { next } = applyNotes(cur, { 'm:i_budget': { by: 'Alex Rivera', second: 'Sam Ortiz', result: 'passed' }, 'a:a_new000001': { text: 'Book the hall', owner: '', due: '' } }, { people: PEOPLE });
  assert.equal(next.motions.length, 1);
  assert.deepEqual([next.motions[0].id, next.motions[0].by, next.motions[0].tally.for], ['v_live00001', 'Alex Rivera', 3]);
  assert.equal(next.actions.length, 1);
  assert.equal(next.actions[0].done, true);
});

test('a roll typed for a meeting with no list yet comes from the board as People has it', () => {
  const { next } = applyNotes({ ...meetingBody(), attendance: [] }, { 'r:alex-rivera': 'present' }, { people: PEOPLE });
  assert.deepEqual(next.attendance.map((p) => [p.slug, p.status, p.kind]), [['alex-rivera', 'present', 'board'], ['sam-ortiz', 'absent', 'board'], ['kim-park', 'absent', 'board']], 'the whole board, as the panel shows it');
});

test('the filled-in Word file says what was typed, and Board reads it back to the same thing', async () => {
  const notes = {
    'r:alex-rivera': 'present', 'r:sam-ortiz': 'remote', 'r:kim-park': 'excused', guests: 'Ann Guest',
    'n:i_roll': 'Called to order at 8:02', 'n:s_open': 'A question about the gala',
    'm:i_budget': { by: 'Alex Rivera', second: 'Sam Ortiz', for: 2, against: 0, abstain: 1, result: 'passed' },
    'm:v_floor0001': { text: 'Buy a new van', by: 'Kim Park', second: 'Alex Rivera', result: 'failed' },
    'a:a_todo0001': { text: 'Send the bylaws', owner: 'alex-rivera', due: '2027-01-15' },
    adjourned: '09:41',
  };
  const m = await getMeeting(env.DB, 'm_notes0001');
  const seen = applyNotes(m, notes, { people: PEOPLE });
  const bytes = minutesDocx(seen.next, { people: PEOPLE, filled: { ...seen.record, by: 'Kim Park' } });
  const text = await docxText(bytes);
  for (const want of ['Minutes taken by: Kim Park', 'Guests: Ann Guest', 'Called to order at 8:02', 'A question about the gala', 'Motion: Approve the 2027 budget', 'Moved by: Alex Rivera', 'Buy a new van', 'Send the bylaws (Alex Rivera) by', 'January 15, 2027', 'Adjourned at: 9:41 AM']) assert.ok(text.includes(want), `says “${want}”\n${text}`);
  const read = await readMinutes({}, { name: 'minutes.docx', bytes, meeting: m, people: PEOPLE });
  assert.deepEqual(read.attendance.filter((p) => p.kind === 'board').map((p) => [p.slug, p.status]).sort(), [['alex-rivera', 'present'], ['kim-park', 'excused'], ['sam-ortiz', 'remote']]);
  const budget = read.motions.find((x) => /2027 budget/.test(x.text));
  assert.deepEqual([budget?.by, budget?.second, budget?.result, budget?.tally?.for], ['Alex Rivera', 'Sam Ortiz', 'passed', 2]);
  assert.equal(read.motions.find((x) => /new van/.test(x.text))?.result, 'failed');
  assert.ok(read.actions.some((a) => /Send the bylaws/.test(a.text) && a.owner === 'alex-rivera'));
});

test('every row typed lands: similar motions and action items are each their own, and the count is true', async () => {
  await fill({
    'r:alex-rivera': 'present',
    'm:v_golf00001': { text: 'Approve the golf budget', by: 'Alex Rivera', result: 'failed' },
    'm:v_golf00002': { text: 'Approve the golf budget as amended', by: 'Alex Rivera', result: 'passed' },
    'm:v_event0001': { text: 'Approve the event budget for 2027', result: 'passed' },
    'm:v_store0001': { text: 'Approve the store budget for 2027', result: 'passed' },
    'a:a_bylaws001': { text: 'Send the bylaws to Alex' },
    'a:a_bylaws002': { text: 'Send the bylaws to Sam' },
  });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.equal(m.motions.length, 4);
  assert.equal(m.actions.length, 2);
  assert.deepEqual([r.read.motions, r.read.actions], [4, 2]);
  assert.equal(m.motions.find((x) => /as amended/.test(x.text)).result, 'passed');
  const text = await docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  assert.ok(text.includes('Approve the golf budget as amended') && text.includes('Send the bylaws to Sam'), 'the Word file says the same');
});

test('only a passed vote on the agenda’s minutes item approves, the meeting the item names; corrected, it’s taken back', async () => {
  await saveMeeting(env.DB, { id: 'm_named0001', title: 'Named', date: shift(-200), shared: true, attendance: [], sections: [] }, { by: 'x' });
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, sections: held.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_prev' ? { ...it, about: 'm_named0001' } : it)) })) }, { by: 'x' });
  assert.match((await notesFor(env, 'm_notes0001', SECRETARY)).approving, /Named/);
  // Wording never approves anything
  await fill({ 'r:alex-rivera': 'present', 'n:i_prev': 'To be approved next time once corrected.', 'm:v_format001': { text: 'Approve keeping the minutes in the new format', result: 'passed' } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal((await getMeeting(env.DB, 'm_named0001')).minutes, 'draft');
  assert.equal((await getMeeting(env.DB, 'm_prev00001')).minutes, 'draft');
  // The vote on the item does, the meeting it names
  await fill({ 'm:i_prev': { result: 'passed' } });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(r.approvedPrev, true);
  assert.equal((await getMeeting(env.DB, 'm_named0001')).minutes, 'approved');
  assert.equal((await getMeeting(env.DB, 'm_prev00001')).minutes, 'draft');
  // The vote corrected: taken back
  await fill({ 'm:i_prev': { result: 'failed' } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal((await getMeeting(env.DB, 'm_named0001')).minutes, 'draft');
});

test('minutes approved some other way are left approved when a vote is corrected here', async () => {
  const prev = await getMeeting(env.DB, 'm_prev00001');
  await saveMeeting(env.DB, { ...prev, minutes: 'approved', approvedOn: shift(-1) }, { by: 'x' });
  await fill({ 'r:alex-rivera': 'present', 'm:i_prev': { result: 'passed' } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  await fill({ 'm:i_prev': { result: 'failed' } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal((await getMeeting(env.DB, 'm_prev00001')).minutes, 'approved');
});

test('a recorded vote stays when the agenda changes: the motion off the item, or the item off the agenda', async () => {
  await fill({ 'r:alex-rivera': 'present', 'm:i_budget': { text: 'Approve the 2027 budget', by: 'Alex Rivera', result: 'passed' } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, sections: held.sections.filter((s) => s.id !== 's_new') }, { by: 'x' });
  await fill({ 'n:i_roll': 'A small fix' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual(m.motions.map((x) => [x.text, x.result]), [['Approve the 2027 budget', 'passed']]);
});

test('a tally keeps what was typed, a blank taken as none', () => {
  const { next } = applyNotes(meetingBody(), { 'm:i_budget': { for: 5, abstain: 1, result: 'passed' } }, { people: PEOPLE });
  assert.deepEqual([next.motions[0].tally.for, next.motions[0].tally.against, next.motions[0].tally.abstain], [5, 0, 1]);
});

test('the board page’s own vote keeps its result; only who moved it is added, and the Word file says the same', async () => {
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, motions: [{ id: 'v_live00001', text: 'Approve the 2027 budget', by: '', second: '', result: 'passed', tally: { for: 3, against: 0, abstain: 0, of: 3, at: '2026-01-01T00:00:00.000Z' } }] }, { by: 'x' });
  await fill({ 'r:alex-rivera': 'present', 'm:i_budget': { text: 'Approve the 2027 budget', by: 'Alex Rivera', result: 'failed', for: 1, against: 2 } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual(m.motions.map((x) => [x.id, x.by, x.result, x.tally.for]), [['v_live00001', 'Alex Rivera', 'passed', 3]]);
  const text = await docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  assert.ok(/For: 3/.test(text) && /Passed/.test(text) && !/Failed/.test(text), text);
});

test('what a founder changed in Board since a send stays, and Board says so', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to ordr', 'm:v_floor0001': { text: 'Buy a van', result: 'passed' } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, sections: held.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_roll' ? { ...it, notes: 'Called to order' } : it)) })), motions: held.motions.map((x) => ({ ...x, text: 'Buy a new van' })) }, { by: 'x' });
  await fill({ 'n:i_roll': 'Called to ordr, and more', 'n:i_budget': 'Something new' });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.equal(m.sections[0].items[0].notes, 'Called to order');
  assert.equal(m.sections[2].items[0].notes, 'Something new');
  assert.deepEqual(m.motions.map((x) => x.text), ['Buy a new van']);
  assert.equal(r.kept, 2);
});

test('everything cleared and sent takes the send back off the meeting, an un-marked person too', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:i_budget': 'A mistake', 'n:s_open': 'A mistake', guests: 'Ann Guest', 'm:v_floor0001': { text: 'Buy a van', result: 'passed' }, 'a:a_todo0001': { text: 'A mistake' } });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  await fill({ 'r:alex-rivera': 'absent', 'n:i_budget': null, 'n:s_open': null, guests: null, 'm:v_floor0001': null, 'a:a_todo0001': null });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(r.cleared, true);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual([m.motions.length, m.actions.length, m.files.length, m.minutesFrom], [0, 0, 0, null]);
  assert.equal(m.sections[2].items[0].notes, 'Background from the treasurer');
  assert.equal(m.sections[3].notes, '');
  assert.ok(m.attendance.every((p) => !p.status));
  assert.ok(!m.attendance.some((p) => p.kind === 'guest'));
  await refused(sendNotes(env, 'm_notes0001', SECRETARY), 400, /Nothing is typed/);
});

test('one send at a time, and a send that fails frees the next', async () => {
  await fill({ 'n:i_roll': 'Called to order' });
  await env.DB.prepare('UPDATE board_minutes_notes SET sending = ? WHERE meeting_id = ?').bind(new Date().toISOString(), 'm_notes0001').run();
  await refused(sendNotes(env, 'm_notes0001', SECRETARY), 409, /being sent/);
  await env.DB.prepare('UPDATE board_minutes_notes SET sending = ? WHERE meeting_id = ?').bind(new Date(Date.now() - 120000).toISOString(), 'm_notes0001').run();
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal((await env.DB.prepare('SELECT sending FROM board_minutes_notes WHERE meeting_id = ?').bind('m_notes0001').first()).sending, null);
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).sections[0].items[0].notes, 'Called to order');
});

test('with no list on the meeting, the Word file’s roll still says who was there', async () => {
  await env.DB.prepare('UPDATE team SET data = ? WHERE slug = ?').bind(JSON.stringify({ name: 'Kim Park', group: 'board', title: 'Board Secretary' }), 'kim-park').run();
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, attendance: [] }, { by: 'x' });
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to order' });
  await sendNotes(env, 'm_notes0001', ADMIN);
  const lines = (await docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()))).split('\n');
  assert.ok(lines.some((l) => /x.*Alex Rivera/.test(l)), lines.join('\n'));
});

test('guests are one to a line; a guest on the roll is that person, there', () => {
  const { next } = applyNotes(meetingBody(), { 'r:sam-ortiz': 'present', guests: 'Dr. Pat Ames, CPA\nSmith, John\nKim Park' }, { people: PEOPLE });
  assert.deepEqual(next.attendance.filter((p) => p.kind === 'guest').map((p) => p.name), ['Dr. Pat Ames, CPA', 'Smith, John']);
  assert.equal(next.attendance.find((p) => p.slug === 'kim-park').status, 'present');
});

test('The minutes as written is the file the minutes came from, not an older upload', async () => {
  const { minutesFileOf } = await import('../public/admin/board-shared.js');
  const a = { id: 'f_a', kind: 'minutes', name: 'Old upload.pdf', type: 'application/pdf', at: '2026-01-01' };
  const b = { id: 'f_b', kind: 'minutes', name: 'Q4 minutes.docx', at: '2026-01-02' };
  const c = { id: 'f_c', kind: 'minutes', name: 'Q4 minutes.docx', at: '2026-01-03' };
  assert.equal(minutesFileOf({ files: [a, b, c], minutesFrom: { name: 'Q4 minutes.docx' } }).id, 'f_c');
  assert.equal(minutesFileOf({ files: [a, b] }).id, 'f_a', 'with nothing to go on: the PDF before the Word copy, as ever');
});

test('what’s saved, even with no answer back, is known as this device’s own; nothing false is called a clash', async () => {
  // A box with only a space in it saves as nothing, and a paste's odd line break as a line break
  await fill({ 'n:i_roll': '  \n' });
  let r = await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'Real words' }, was: { 'n:i_roll': ['  \n'] } }, SECRETARY);
  assert.deepEqual(r.clashes, []);
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_budget': 'One\u000BTwo' }, was: { 'n:i_budget': [''] } }, SECRETARY);
  r = await saveNotes(env, 'm_notes0001', { changes: { 'n:i_budget': 'One\nTwo more' }, was: { 'n:i_budget': ['One\u000BTwo'] } }, SECRETARY);
  assert.deepEqual(r.clashes, []);
  // The server got it and the answer was lost: the next try lists what it tried
  await saveNotes(env, 'm_notes0001', { changes: { 'n:s_open': 'Lost answer' }, was: { 'n:s_open': [''] } }, SECRETARY);
  r = await saveNotes(env, 'm_notes0001', { changes: { 'n:s_open': 'Lost answer, and more' }, was: { 'n:s_open': ['', 'Lost answer'] } }, SECRETARY);
  assert.deepEqual(r.clashes, []);
});

test('a device coming back can’t quietly change how a vote went or who was there', async () => {
  await fill({ 'm:i_budget': { result: 'failed' }, 'r:sam-ortiz': 'present' });
  const r = await saveNotes(env, 'm_notes0001', { changes: { 'm:i_budget': { by: 'Alex Rivera', result: 'passed' }, 'r:sam-ortiz': 'excused' }, was: { 'm:i_budget': [''], 'r:sam-ortiz': [''] } }, SECRETARY);
  assert.deepEqual(r.clashes.map((c) => [c.key, c.theirs]).sort(), [['m:i_budget', 'failed'], ['r:sam-ortiz', 'present']]);
  const { notes } = await notesFor(env, 'm_notes0001', SECRETARY);
  assert.deepEqual([notes['m:i_budget'].result, notes['m:i_budget'].by, notes['r:sam-ortiz']], ['failed', 'Alex Rivera', 'present'], 'the rest of what it sent goes in');
});

test('what a founder changed or deleted in Board stays, send after send, and is said; the Word file says the same', async () => {
  await fill({
    'r:alex-rivera': 'present', 'n:i_roll': 'Called to ordr', 'n:s_open': 'A question',
    'm:v_floor0001': { text: 'Buy a van', result: 'passed' }, 'm:v_floor0002': { text: 'Paint the shed', result: 'passed' },
    'a:a_todo0001': { text: 'Call the printer' }, 'a:a_todo0002': { text: 'Book the hall' },
  });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const held = await getMeeting(env.DB, 'm_notes0001');
  assert.equal(held.attendance.find((p) => p.slug === 'sam-ortiz').status, 'absent');
  await saveMeeting(env.DB, {
    ...held,
    attendance: held.attendance.map((p) => (p.slug === 'sam-ortiz' ? { ...p, status: 'present' } : p)),
    sections: held.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_roll' ? { ...it, notes: 'Called to order' } : it)) })),
    motions: held.motions.filter((x) => x.text !== 'Paint the shed').map((x) => ({ ...x, text: 'Buy a new van' })),
    actions: held.actions.filter((x) => x.text !== 'Book the hall').map((x) => ({ ...x, text: 'Call the print shop' })),
  }, { by: 'x' });
  await fill({ 'r:sam-ortiz': 'excused' });
  for (let i = 0; i < 2; i += 1) {
    const r = await sendNotes(env, 'm_notes0001', SECRETARY);
    const m = await getMeeting(env.DB, 'm_notes0001');
    assert.equal(m.sections[0].items[0].notes, 'Called to order');
    assert.deepEqual(m.motions.map((x) => x.text), ['Buy a new van'], `send ${i + 2}: no deleted motion back, the edited one kept`);
    assert.deepEqual(m.actions.map((x) => x.text), ['Call the print shop']);
    assert.equal(m.attendance.find((p) => p.slug === 'sam-ortiz').status, 'present');
    assert.ok(r.kept >= 5, `said (${r.kept})`);
    const text = await docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
    assert.ok(text.includes('Called to order') && !text.includes('Called to ordr') && text.includes('Buy a new van') && !text.includes('Paint the shed'), text);
  }
});

test('a note a founder adds in Board under an item the send left blank stays, and the Word file has it', async () => {
  const word = async () => docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to order' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.ok(!(await word()).includes('Background from the treasurer'), 'an agenda’s background isn’t minutes');
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, sections: held.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_prev' ? { ...it, notes: 'Approved with one spelling fix' } : it)) })) }, { by: 'x' });
  let r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(r.kept, 0, 'nothing typed says otherwise');
  assert.ok((await word()).includes('Approved with one spelling fix'));
  assert.ok(!(await word()).includes('Background from the treasurer'), 'and the rest stays as it was');
  // Typed over later: Board's stands, and it's said
  await fill({ 'n:i_prev': 'Approved' });
  for (let i = 0; i < 2; i += 1) {
    r = await sendNotes(env, 'm_notes0001', SECRETARY);
    assert.equal(r.kept, 1);
    assert.equal((await getMeeting(env.DB, 'm_notes0001')).sections[1].items[0].notes, 'Approved with one spelling fix');
    assert.ok((await word()).includes('Approved with one spelling fix'));
  }
});

test('a note that starts with a space can be corrected; nobody is told Board changed it', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': '  \n  Gala nets 50000' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  await fill({ 'n:i_roll': ' Gala nets 75000' });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(r.kept, 0);
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).sections[0].items[0].notes, 'Gala nets 75000');
});

test('with no attendance list the whole board counts, on the meeting and in the Word file', async () => {
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, attendance: [] }, { by: 'x' });
  await fill({ 'r:alex-rivera': 'present', 'r:kim-park': 'present' });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.deepEqual(r.read.attendance, { here: 2, of: 3 });
  const text = await docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  assert.ok(text.includes('Sam Ortiz'), text);
});

test('someone outside the roll given an action item is named on it', () => {
  const { next, record } = applyNotes(meetingBody(), { 'a:a_todo0001': { text: 'Ask the advisors', owner: 'ada-advisor', ownerName: 'Ada Advisor' } }, { people: PEOPLE });
  assert.deepEqual([next.actions[0].owner, next.actions[0].ownerName], ['ada-advisor', 'Ada Advisor']);
  assert.equal(record.actions[0].who, 'Ada Advisor');
});

test('a person from People typed under guests can be taken off again', async () => {
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, attendance: held.attendance.filter((p) => p.slug !== 'jane-doe') }, { by: 'x' });
  await fill({ 'r:alex-rivera': 'present', guests: 'Jane Doe' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).attendance.find((p) => p.slug === 'jane-doe')?.status, 'present');
  await fill({ guests: null });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).attendance.find((p) => p.slug === 'jane-doe'), undefined);
});

test('a part’s notes are the part’s own, never an item: the agenda, the screen and the next agenda are as they were', async () => {
  const before = agendaItems(await getMeeting(env.DB, 'm_notes0001')).map((x) => x.id);
  await fill({ 'r:alex-rivera': 'present', 'n:s_open': 'A question' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.deepEqual(agendaItems(m).map((x) => x.id), before);
  const next = draftAgenda(m).find((s) => s.title === 'Open forum');
  assert.deepEqual([next.items.length, next.notes], [0, undefined]);
});

test('the Word file says what the meeting says, the chair’s votes and Board’s action items too', async () => {
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held,
    motions: [
      { id: 'v_live00001', text: 'Approve the 2027 budget', by: '', second: '', result: 'passed', tally: { for: 3, against: 0, abstain: 0, of: 3, at: '2026-01-01T00:00:00.000Z' } },
      { id: 'v_live00002', text: 'Buy a new van', by: '', second: '', result: 'failed', tally: { for: 1, against: 2, abstain: 0, of: 3, at: '2026-01-01T00:00:00.000Z' } },
    ],
    actions: [{ id: 'a_board0001', text: 'Book the hall', owner: 'sam-ortiz', ownerName: 'Sam Ortiz', due: '', done: false, doneOn: '' }],
  }, { by: 'x' });
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to order' });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.deepEqual([r.read.motions, r.read.actions], [2, 1], 'and the count is what’s on the meeting');
  const text = await docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  for (const want of ['Motion: Approve the 2027 budget', 'For: 3', 'Motion: Buy a new van', 'For: 1', 'Book the hall (Sam Ortiz)']) assert.ok(text.includes(want), `says “${want}”\n${text}`);
  assert.ok(!text.includes('Passed / Failed'), 'no blank record line for a vote that was taken');
});

test('a passed vote warns when the meeting it approves has notes never sent', async () => {
  await saveNotes(env, 'm_prev00001', { changes: { 'n:s_gone': 'Never sent' } }, SECRETARY);
  assert.equal((await notesFor(env, 'm_notes0001', SECRETARY)).approvingWaiting, true);
});

test('a meeting the chair ended ahead of its date can be sent', async () => {
  await saveMeeting(env.DB, meetingBody({ id: 'm_early0001', date: shift(7) }), { by: 'x' });
  await saveNotes(env, 'm_early0001', { changes: { 'n:i_roll': 'Held early' } }, SECRETARY);
  await refused(sendNotes(env, 'm_early0001', SECRETARY), 400, /day of the meeting/);
  const m = await getMeeting(env.DB, 'm_early0001');
  await saveMeeting(env.DB, { ...m, live: { ...m.live, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() } }, { by: 'x' });
  await sendNotes(env, 'm_early0001', SECRETARY);
});

test('notes typed and never sent are known, for an approval to warn and the secretary to reach', async () => {
  assert.deepEqual(await notesWaiting(env.DB), []);
  await fill({ 'n:i_roll': 'Typed, not sent' });
  assert.deepEqual(await notesWaiting(env.DB), ['m_notes0001']);
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.deepEqual(await notesWaiting(env.DB), []);
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'A change' } }, SECRETARY, { now: Date.now() + 5000 });
  assert.deepEqual(await notesWaiting(env.DB), ['m_notes0001']);
});

test('the secretary who typed them is who the record names, whoever saved last or pressed Send', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to order, typed by Kim' });
  await fill({ 'n:i_budget': 'A founder’s one small line' }, ADMIN);
  await sendNotes(env, 'm_notes0001', ADMIN);
  const text = await docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  assert.ok(text.includes('Minutes taken by: Kim Park'), text);
});

test('a founder who kept them alone isn’t named as the secretary', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to order' }, ADMIN);
  await sendNotes(env, 'm_notes0001', ADMIN);
  const text = await docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  assert.ok(!text.includes('Kim Park (') && !/Minutes taken by: Kim Park/.test(text), text);
});

test('the template’s vote lines aren’t read as notes on the item; other lines are left', () => {
  assert.equal(withoutVoteLines('- Reserves grew\n- Motion: Approve the 2027 budget\n- Moved by: Alex      Seconded by: Sam      For: 3      Passed\n- Everyone agreed'), '- Reserves grew\n- Everyone agreed');
  assert.equal(withoutVoteLines('Motion: the board talked about a motion'), 'Motion: the board talked about a motion');
});

test('sending again doesn’t re-approve what a founder put back to draft, and says so', async () => {
  await fill({ 'r:alex-rivera': 'present', 'm:i_prev': { result: 'passed' } });
  const first = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal(first.approvedPrev, true);
  const prev = await getMeeting(env.DB, 'm_prev00001');
  await saveMeeting(env.DB, { ...prev, minutes: 'draft', approvedOn: '' }, { by: 'x' });
  await fill({ 'n:i_roll': 'A typo fixed' });
  const r = await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.equal((await getMeeting(env.DB, 'm_prev00001')).minutes, 'draft');
  assert.equal(r.kept, 1);
});

test('whoever took the minutes was there, unless they said otherwise', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:i_roll': 'Called to order' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  let m = await getMeeting(env.DB, 'm_notes0001');
  assert.equal(m.attendance.find((p) => p.slug === 'kim-park').status, 'present');
  await fill({ 'r:kim-park': 'remote' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  m = await getMeeting(env.DB, 'm_notes0001');
  assert.equal(m.attendance.find((p) => p.slug === 'kim-park').status, 'remote');
});

test('a guest already on the meeting is in the Word file’s Guests too', async () => {
  const held = await getMeeting(env.DB, 'm_notes0001');
  await saveMeeting(env.DB, { ...held, attendance: [...held.attendance, { name: 'Gia Guest', kind: 'guest', status: 'present' }] }, { by: 'x' });
  await fill({ 'r:alex-rivera': 'present' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const text = await docxText(new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer()));
  assert.ok(text.includes('Guests: Gia Guest'), text);
});

test('a draft with only a vote half written counts as notes waiting', async () => {
  await fill({ 'm:i_budget': { by: 'Alex Rivera' } });
  assert.deepEqual(await notesWaiting(env.DB), ['m_notes0001']);
});

test('the kept Word file with a word fixed in a part’s notes and dropped back in: the part’s notes change, no new item', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:s_open': 'A member askd about the roof\nAnother about parking' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  const read = { attendance: [], sections: [{ title: 'Open forum', items: [{ title: 'A member asked about the roof', notes: '' }, { title: 'Another about parking', notes: '' }] }], motions: [], actions: [] };
  const after = applyMinutes(m, read, { fileName: 'minutes.docx' });
  const open = after.sections.find((s) => s.title === 'Open forum');
  assert.equal(open.items.length, 0);
  assert.equal(open.notes, 'A member asked about the roof\nAnother about parking');
});

test('the kept Word file dropped back in doesn’t turn a part’s notes into items', async () => {
  await fill({ 'r:alex-rivera': 'present', 'n:s_open': 'A question about the gala\nAnother about parking' });
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const m = await getMeeting(env.DB, 'm_notes0001');
  const bytes = new Uint8Array(await new Response((await bucket.get([...objects.keys()][0])).body).arrayBuffer());
  const read = await readMinutes({}, { name: 'minutes.docx', bytes, meeting: m, people: PEOPLE });
  const after = applyMinutes(m, read, { fileName: 'minutes.docx' });
  assert.equal(after.sections[3].items.length, 0);
  assert.equal(after.sections[3].notes, 'A question about the gala\nAnother about parking');
});

test('a meeting deleted takes its draft with it', async () => {
  await fill({ 'n:i_roll': 'Called to order' });
  await deleteMeeting(env, 'm_notes0001');
  assert.equal(await env.DB.prepare('SELECT 1 AS x FROM board_minutes_notes WHERE meeting_id = ?').bind('m_notes0001').first(), null);
});

test('who typed the minutes is who typed them: never who pressed Send, nor whoever holds the seat', async () => {
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'All here' } }, SECRETARY);
  await sendNotes(env, 'm_notes0001', ADMIN);
  assert.equal((await notesState(env.DB)).typedBy.m_notes0001, 'Kim Park', 'the secretary typed them; a founder only pressed Send');

  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'All here, on time' } }, ADMIN);
  await sendNotes(env, 'm_notes0001', ADMIN);
  assert.equal((await notesState(env.DB)).typedBy.m_notes0001, 'Kim Park', 'a founder’s fix doesn’t change who took them');
});

test('a founder who types the minutes is named, though a secretary holds the seat and staff have no email on the roster', async () => {
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'All here' } }, ADMIN);
  await sendNotes(env, 'm_notes0001', ADMIN);
  assert.equal((await notesState(env.DB)).typedBy.m_notes0001, 'Jane Doe');
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).minutesFrom.typed, true);
});

test('nothing sent: nobody named, and the draft still waits', async () => {
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'All here' } }, SECRETARY);
  const state = await notesState(env.DB);
  assert.deepEqual(state.typedBy, {});
  assert.deepEqual(state.waiting, ['m_notes0001']);
  assert.deepEqual(await notesWaiting(env.DB), ['m_notes0001']);
});

test('minutes emailed in later never read over what was typed and sent', () => {
  const typed = { minutesFrom: { name: 'Q4 minutes.docx', at: '2026-11-05T15:00:00.000Z', typed: true } };
  assert.equal(minutesNewer(typed, { name: 'Q4 minutes.pdf', at: '2026-12-01T15:00:00.000Z' }), false);
});

test('typed minutes take no file: on the admin’s drop, or the board page’s send, whatever a tab left open thinks', async () => {
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'All here' } }, SECRETARY);
  await sendNotes(env, 'm_notes0001', SECRETARY);
  await refused(readMinutesInto(env, 'm_notes0001', 'f_anything'), 409);
  await refused(secretarySends(env, 'm_notes0001', new File(['x'], 'minutes.pdf', { type: 'application/pdf' }), SECRETARY), 409);
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).sections[0].items[0].notes, 'All here');
});

test('taken back off, nobody took the minutes: the next to type them is named, and nobody is marked there by it', async () => {
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'All here' } }, SECRETARY);
  await sendNotes(env, 'm_notes0001', SECRETARY);
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': null } }, SECRETARY);
  await sendNotes(env, 'm_notes0001', SECRETARY);
  assert.deepEqual((await notesState(env.DB)).typedBy, {});

  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'Founder’s words', 'r:alex-rivera': 'present' } }, ADMIN);
  await sendNotes(env, 'm_notes0001', ADMIN);
  assert.equal((await notesState(env.DB)).typedBy.m_notes0001, 'Jane Doe');
  const m = await getMeeting(env.DB, 'm_notes0001');
  assert.notEqual(m.attendance.find((p) => p.slug === 'kim-park').status, 'present', 'the secretary who took them back isn’t marked there by it');
});

test('a box typed and emptied before any send leaves nobody as having taken the minutes', async () => {
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'Oops' } }, SECRETARY);
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': null } }, SECRETARY);
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_roll': 'Founder’s words' } }, ADMIN);
  await sendNotes(env, 'm_notes0001', ADMIN);
  assert.equal((await notesState(env.DB)).typedBy.m_notes0001, 'Jane Doe');
});

test('who pressed Send is never named as who typed them', async () => {
  await env.DB.prepare("INSERT INTO board_minutes_notes (meeting_id, data, updated_at, updated_by) VALUES ('m_notes0001', ?, ?, 'office@example.com')").bind(JSON.stringify({ 'n:i_roll': 'All here' }), new Date().toISOString()).run();
  await sendNotes(env, 'm_notes0001', ADMIN);
  assert.deepEqual((await notesState(env.DB)).typedBy, {});
});

test('a meeting with typed minutes is never a draft to start over, whatever its agenda came from', async () => {
  const m = { agendaFrom: { kind: 'template' }, sections: [{ id: 's_a', title: 'Call to order', items: [{ id: 'i_a', title: 'Roll call', notes: 'Typed under it' }] }] };
  assert.equal(agendaIsDraft(m), true);
  assert.equal(agendaIsDraft({ ...m, minutesFrom: { name: 'x.docx', typed: true } }), false);
  assert.equal(agendaIsDraft({ ...m, minutesFrom: { name: 'x.pdf' } }), true, 'read from a file: as it was');
});

test('a file the secretary sends that isn’t minutes doesn’t stay on the meeting', async () => {
  await assert.rejects(secretarySends(env, 'm_notes0001', new File(['nothing like minutes'], 'lunch order.pdf', { type: 'application/pdf' }), SECRETARY), (err) => !!err.status);
  assert.equal((await getMeeting(env.DB, 'm_notes0001')).files.length, 0);
});

test('saying a line isn’t a to-do changes nothing the minutes say: sent minutes stay sent, and a key that can’t be kept isn’t', async () => {
  await saveNotes(env, 'm_notes0001', { changes: { 'n:i_budget': 'Words', 'r:alex-rivera': 'present' } }, SECRETARY);
  await sendNotes(env, 'm_notes0001', SECRETARY);
  const j = await saveNotes(env, 'm_notes0001', { changes: { skipped: 'i_budget:sam to call\ni_budget:sam to call\n  \n' } }, SECRETARY);
  assert.equal(j.at, '');
  assert.equal((await notesState(env.DB)).waiting.includes('m_notes0001'), false);
  assert.equal((await notesFor(env, 'm_notes0001', SECRETARY, { quick: true })).notes.skipped, 'i_budget:sam to call');
  assert.equal(cleanChange('skipped', ''), null);
});
