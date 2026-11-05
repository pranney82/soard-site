/**
 * A board meeting's minutes read into the meeting (functions/api/_board-minutes.js): who was there, each agenda
 * item's notes, the motions and the action items, from SOARD's outline minutes and from prose minutes; Workers AI
 * where the rules can't, the rules alone when it's missing or fails; the agenda keeping its items and documents;
 * and the admin's upload (POST /api/board-admin read-minutes). Made-up people only (the repo is public).
 * Run: node --test tests/board-minutes.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequest, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import * as admin from '../functions/api/board-admin.js';
import { saveMeeting, getMeeting, putFile } from '../functions/api/_board.js';
import {
  readMinutes, applyMinutes, minutesNewer, matchPerson, motionsIn, approvalIn, likeness, shapeFrom, excerpt, readSomething,
} from '../functions/api/_board-minutes.js';
import { cleanMeeting } from '../public/admin/board-shared.js';

const PEOPLE = [
  { slug: 'alex-rivera', name: 'Alex Rivera', org: 'Rivera Builders', kind: 'board' },
  { slug: 'sam-ortiz', name: 'Sam Ortiz', org: 'Ortiz & Co', kind: 'board' },
  { slug: 'kim-park', name: 'Kim Park', org: 'Park Media', kind: 'board' },
  { slug: 'lee-example', name: 'Lee Example', org: '', kind: 'board' },
  { slug: 'max-sample', name: 'Max Sample', org: '', kind: 'board' },
  { slug: 'jane-doe', name: 'Jane Doe', org: 'SOARD', kind: 'staff' },
];

/** Minutes the way SOARD writes them: the attendee table (x = there), numbered sections in capitals, lettered points */
const SOARD_MINUTES = `MEETING Example Board – Minutes DATE 08/06/2026
LOCATION Example Hall TIME 8:00a - 10:00a
ATTENDEE COMPANY ATTENDEE COMPANY
x Alex Rivera Rivera Builders x Jane Doe SOARD
Kim Park Park Media
x Sam Ortiz Ortiz & Co
1. CALL TO ORDER
1. Roll Call
2. APPROVE MEETING MINUTES
1. Q2 Board Meeting
a. Minutes approved
3. COMMITTEE REPORTS
1. Financial (Sam)
a. Reserves grew this quarter
b. Motion to approve the 2027 budget by Alex, seconded by Sam. Motion passed.
2. Project updates and upcoming reveals (Alex)
a. Two families are in Build
4. NEW BUSINESS
1. Spring gala venue
a. Kim will send the venue options by 9/15`;

/** Minutes written as prose, no outline */
const PROSE = `Example Board of Directors – Meeting Minutes, August 6, 2026
Present: Alex Rivera, Sam Ortiz, Jane Doe
Absent – Kim Park
The meeting was called to order at 8:02 a.m. Sam walked the board through the financials: reserves grew this quarter.
Alex moved to approve the 2027 budget; Sam Ortiz seconded. The motion carried unanimously.
Kim will send the venue options for the spring gala by September 15.
The meeting adjourned at 9:45 a.m.`;

/** A fake Workers AI: `answer` is what the model says (or a function of what it was asked); every call is kept */
function fakeAI(answer) {
  const calls = [];
  return {
    calls,
    run: async (model, opts) => {
      calls.push({ model, opts });
      const a = typeof answer === 'function' ? answer(opts) : answer;
      if (a instanceof Error) throw a;
      return { response: opts.response_format ? a : JSON.stringify(a) };
    },
  };
}

test('names as minutes write them: full, first with an initial, a first or last name only one person has', () => {
  const at = (n) => matchPerson(n, PEOPLE)?.slug || null;
  assert.deepEqual(['Alex Rivera', 'Alex R.', 'Alex', 'Ms. Park', 'Kim Park (Park Media)', 'jane doe', 'Sam O', 'Pat Nobody', ''].map(at),
    ['alex-rivera', 'alex-rivera', 'alex-rivera', 'kim-park', 'kim-park', 'jane-doe', 'sam-ortiz', null, null]);
  const twoAlexes = [...PEOPLE, { slug: 'alex-other', name: 'Alex Other', kind: 'board' }];
  assert.equal(matchPerson('Alex', twoAlexes), null, 'a first name two people share is nobody');
  assert.equal(matchPerson('Alex Other', twoAlexes).slug, 'alex-other');
});

test('motions the usual ways: who moved and seconded, and the result from the sentence or the next ones', () => {
  const m = motionsIn([
    'Motion to approve the 2027 budget by Alex, seconded by Sam. Motion passed.',
    'Kim Park moved to table the gala venue decision; Alex Rivera seconded. The motion failed.',
    'Motion by Sam Ortiz to approve the minutes of the Q2 meeting, second by Kim. Carried unanimously.',
    'A motion was made by Alex to move reserves into a money market fund and was seconded by Sam.',
    'The board moved to adjourn.',
    'Motion to accept the store report carried unanimously.',
  ].join('\n'), PEOPLE);
  assert.deepEqual(m.map((x) => [x.text, x.by, x.second, x.result]), [
    ['Approve the 2027 budget', 'Alex Rivera', 'Sam Ortiz', 'passed'],
    ['Table the gala venue decision', 'Kim Park', 'Alex Rivera', 'failed'],
    ['Approve the minutes of the Q2 meeting', 'Sam Ortiz', 'Kim Park', 'passed'],
    ['Move reserves into a money market fund', 'Alex Rivera', 'Sam Ortiz', 'passed'],
    ['Accept the store report', '', '', 'passed'],
  ]);
  assert.equal(approvalIn([], m), true, 'a passed motion to approve the minutes');
  assert.equal(approvalIn([{ title: 'Approve meeting minutes', items: [{ title: 'Q2 Board Meeting', notes: '- Minutes approved' }] }], []), true);
  assert.equal(approvalIn([{ title: 'Approve meeting minutes', items: [{ title: 'Q2 Board Meeting', notes: '- Not approved yet: corrections' }] }], []), false);
  assert.equal(approvalIn([{ title: 'Committee reports', items: [{ title: 'Financial', notes: '- Budget approved' }] }], []), false, 'approved, but not the minutes');
});

test('SOARD’s outline minutes, by the rules alone: who was there, each part’s notes, the motion, the last minutes approved', async () => {
  const read = await readMinutes({}, { text: SOARD_MINUTES, people: PEOPLE });
  assert.equal(read.said.by, 'rules');
  assert.deepEqual(read.attendance.map((p) => `${p.slug}:${p.status}`).sort(), ['alex-rivera:present', 'jane-doe:present', 'kim-park:absent', 'sam-ortiz:present']);
  assert.deepEqual(read.sections.map((s) => [s.title, s.items.map((it) => it.title)]), [
    ['Call to order', ['Roll Call']],
    ['Approve meeting minutes', ['Q2 Board Meeting']],
    ['Committee reports', ['Financial', 'Project updates and upcoming reveals']],
    ['New business', ['Spring gala venue']],
  ]);
  assert.match(read.sections[2].items[0].notes, /Reserves grew this quarter/);
  assert.deepEqual(read.motions.map((x) => [x.text, x.by, x.second, x.result]), [['Approve the 2027 budget', 'Alex Rivera', 'Sam Ortiz', 'passed']]);
  assert.deepEqual(read.actions, [], 'action items need the model');
  assert.equal(read.approvedPrev, true);
  assert.equal(read.said.date, '2026-08-06');
  assert.ok(readSomething(read));
});

test('Workers AI adds the action items (whose, by when) and the motions; the rules’ attendance and outline stay', async () => {
  const ai = fakeAI({
    attendance: [{ name: 'Alex Rivera', status: 'present' }],
    motions: [{ text: 'Approve the 2027 budget.', by: 'Alex', second: 'Sam', result: 'passed' }, { text: 'Approve the minutes of the Q2 meeting', by: '', second: '', result: 'passed' }],
    actions: [{ text: 'Send the venue options for the spring gala', owner: 'Kim', due: '2026-09-15' }, { text: 'Book the photographer', owner: 'Someone New', due: 'next week' }],
    approvedPrev: false,
  });
  const meeting = cleanMeeting({ date: '2026-08-06', title: 'Q3 Board Meeting' });
  const prev = cleanMeeting({ date: '2026-04-30', title: 'Q2 Board Meeting' });
  const read = await readMinutes({ AI: ai }, { text: SOARD_MINUTES, people: PEOPLE, meeting, prev });
  assert.equal(read.said.by, 'ai');
  assert.equal(ai.calls.length, 1);
  const { opts } = ai.calls[0];
  assert.equal(opts.response_format.type, 'json_schema');
  assert.ok(!('topics' in opts.response_format.json_schema.properties), 'the rules read the outline, so the model isn’t asked for one');
  assert.match(opts.messages[1].content, /This meeting: the Q3 Board Meeting on Aug 6, 2026/);
  assert.match(opts.messages[1].content, /The previous meeting: the Q2 Board Meeting on Apr 30, 2026/);
  assert.match(opts.messages[1].content, /Kim Park/);
  assert.equal(read.attendance.length, 4, 'the attendee table’s marks, not the model’s');
  assert.deepEqual(read.motions.map((x) => [x.text, x.by, x.second]), [['Approve the 2027 budget', 'Alex Rivera', 'Sam Ortiz'], ['Approve the minutes of the Q2 meeting', '', '']]);
  assert.deepEqual(read.actions.map((x) => [x.text, x.owner, x.ownerName, x.due]), [
    ['Send the venue options for the spring gala', 'kim-park', 'Kim Park', '2026-09-15'],
    ['Book the photographer', '', 'Someone New', ''],
  ]);
  assert.equal(read.approvedPrev, true, 'the outline says so even when the model doesn’t');
});

test('prose minutes: the model writes the outline from the agenda’s wording, and its attendance fills in a guest', async () => {
  const ai = fakeAI({
    attendance: [{ name: 'Alex Rivera', status: 'present' }, { name: 'Sam', status: 'remote' }, { name: 'Pat Visitor', status: 'present' }, { name: 'Kim Park', status: 'absent' }],
    motions: [{ text: 'Approve the 2027 budget', by: 'Alex', second: 'Sam Ortiz', result: 'passed' }],
    actions: [{ text: 'Send the venue options', owner: 'Kim Park', due: '2026-09-15' }],
    approvedPrev: true,
    topics: [
      { section: 'Committee reports', title: 'Financial', points: ['Reserves grew this quarter.'] },
      { section: 'New business', title: 'Spring gala', points: ['Kim will send venue options.'] },
    ],
  });
  const meeting = cleanMeeting({ date: '2026-08-06', sections: [{ title: 'Committee reports', items: [{ title: 'Financial' }] }] });
  // No attendee table here, and "Present:" lines would be found by the rules: take those out to see the model's used
  const text = PROSE.replace(/^Present:.*\n|^Absent.*\n/gm, '');
  const read = await readMinutes({ AI: ai }, { text, people: PEOPLE, meeting });
  assert.ok(ai.calls[0].opts.response_format.json_schema.properties.topics, 'asked for the outline');
  assert.match(ai.calls[0].opts.messages[1].content, /The agenda's items:\nCommittee reports: Financial/);
  assert.deepEqual(read.attendance.map((p) => `${p.slug || p.kind}:${p.name}:${p.status}`), ['alex-rivera:Alex Rivera:present', 'sam-ortiz:Sam Ortiz:remote', 'guest:Pat Visitor:present', 'kim-park:Kim Park:absent']);
  assert.deepEqual(read.sections.map((s) => [s.title, s.items.map((it) => [it.title, it.notes])]), [
    ['Committee reports', [['Financial', '- Reserves grew this quarter.']]],
    ['New business', [['Spring gala', '- Kim will send venue options.']]],
  ]);
  assert.equal(read.approvedPrev, true);
  // With the "Present:" lines, the rules' reading wins
  const ruled = await readMinutes({ AI: fakeAI({ attendance: [{ name: 'Kim Park', status: 'present' }], motions: [], actions: [], approvedPrev: false, topics: [] }) }, { text: PROSE, people: PEOPLE });
  assert.deepEqual(ruled.attendance.map((p) => `${p.slug}:${p.status}`), ['alex-rivera:present', 'sam-ortiz:present', 'jane-doe:present', 'kim-park:absent']);
  assert.deepEqual(ruled.motions.map((x) => [x.text, x.by, x.second, x.result]), [['Approve the 2027 budget', 'Alex Rivera', 'Sam Ortiz', 'passed']], 'the model found none: the rules’ motion');
});

test('without Workers AI, or when it fails or answers nonsense, the rules read the minutes and nothing throws', async () => {
  const noAI = await readMinutes({}, { text: PROSE, people: PEOPLE });
  assert.equal(noAI.said.by, 'rules');
  assert.equal(noAI.motions.length, 1);
  const down = fakeAI(new Error('model unavailable'));
  const failed = await readMinutes({ AI: down }, { text: PROSE, people: PEOPLE });
  assert.deepEqual([failed.said.by, down.calls.length, failed.motions.length], ['rules', 2, 1], 'tried with JSON and without, then the rules');
  const quickDown = fakeAI(new Error('model unavailable'));
  await readMinutes({ AI: quickDown }, { text: PROSE, people: PEOPLE, quick: true });
  assert.equal(quickDown.calls.length, 1, 'Board’s own readers try once');
  const nonsense = await readMinutes({ AI: fakeAI('no idea') }, { text: PROSE, people: PEOPLE });
  assert.equal(nonsense.said.by, 'rules');
  const empty = await readMinutes({}, { text: '   ', people: PEOPLE });
  assert.deepEqual([empty.attendance, empty.sections, empty.motions, empty.said.chars], [[], [], [], 0]);
  assert.equal(readSomething(empty), false);
  // A file nobody can read: Word read here, a PDF needs the converter
  assert.equal((await readMinutes({}, { name: 'Minutes.pdf', bytes: new TextEncoder().encode('%PDF-1.4'), people: PEOPLE })).said.chars, 0);
});

test('long minutes: the model reads the start and every line about motions, votes, tasks and attendance', () => {
  const filler = Array.from({ length: 900 }, (_, i) => `Line ${i} of the discussion about the season.`).join('\n');
  const text = `Present: Alex Rivera\n${filler}\nMotion to approve the 2027 budget by Alex, seconded by Sam.\n${filler}\nKim will send the venue options by Friday.`;
  const ex = excerpt(text, 6000);
  assert.ok(ex.length <= 6000);
  assert.match(ex, /^Present: Alex Rivera/);
  assert.match(ex, /Motion to approve the 2027 budget/);
  assert.match(ex, /Kim will send the venue options/);
  assert.equal(excerpt('short', 6000), 'short');
});

// ─── Onto the meeting ───────────────────────────────────────────────

const AT = '2026-08-06T15:00:00.000Z';
/** A meeting whose agenda someone wrote: items with presenters, documents, live numbers, a background note */
const written = () => cleanMeeting({
  id: 'm_written1', date: '2026-08-06', agendaFrom: { kind: 'typed', name: '', at: AT },
  sections: [
    { id: 's_one', title: 'Call to order', items: [{ id: 'i_roll', title: 'Roll call' }] },
    { id: 's_two', title: 'Approve meeting minutes', items: [{ id: 'i_min', title: 'Minutes of the Q2 Board Meeting (Apr 30)', live: 'minutes', about: 'm_prev1' }] },
    { id: 's_three', title: 'Committee reports', items: [
      { id: 'i_fin', title: 'Financial', live: 'cash', who: ['sam-ortiz'], presenter: 'Sam Ortiz', docs: ['f_sheet1'] },
      { id: 'i_proj', title: 'Projects updates and upcoming reveals', live: 'projects' },
      { id: 'i_store', title: 'Store update', notes: '- Holiday hours start in November', staffNote: 'Ask about the lease' },
    ] },
  ],
  attendance: [
    { slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board', rsvp: 'yes' },
    { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board', status: 'remote' },
    { slug: 'kim-park', name: 'Kim Park', kind: 'board', status: 'excused' },
    { slug: 'lee-example', name: 'Lee Example', kind: 'board', status: 'excused' },
    { slug: 'max-sample', name: 'Max Sample', kind: 'board', rsvp: 'yes' },
    { slug: 'jane-doe', name: 'Jane Doe', kind: 'staff' },
  ],
  motions: [{ id: 'v_live1', text: 'Approve the 2027 budget', by: 'Alex Rivera', second: 'Sam Ortiz', result: 'passed', tally: { for: 3, against: 0, abstain: 0, of: 3, at: AT } }],
  actions: [{ id: 'a_old1', text: 'Send the venue options for the spring gala', owner: 'kim-park', ownerName: 'Kim Park' }],
});

test('a written agenda keeps every item and its documents; each takes its notes from the minutes; what the agenda didn’t have is added', async () => {
  const read = await readMinutes({}, { text: SOARD_MINUTES, people: PEOPLE });
  read.actions = [{ text: 'Send the venue options for the spring gala.', owner: 'kim-park', ownerName: 'Kim Park', due: '2026-09-15' }, { text: 'Book the photographer', owner: '', ownerName: 'Pat Visitor', due: '' }];
  const cur = written();
  assert.equal(shapeFrom(cur, read), 'agenda');
  const next = applyMinutes(cur, read, { fileName: 'Q3 minutes.pdf', now: Date.parse(AT) });
  assert.deepEqual(next.sections.map((s) => [s.id, s.title, s.items.map((it) => it.id.startsWith('i_') && ['i_roll', 'i_min', 'i_fin', 'i_proj', 'i_store'].includes(it.id) ? it.id : it.title)]), [
    ['s_one', 'Call to order', ['i_roll']],
    ['s_two', 'Approve meeting minutes', ['i_min']],
    ['s_three', 'Committee reports', ['i_fin', 'i_proj', 'i_store']],
    [next.sections[3].id, 'New business', ['Spring gala venue']],
  ], 'every agenda item where it was, the minutes’ new business after');
  const item = (id) => next.sections.flatMap((s) => s.items).find((it) => it.id === id);
  assert.equal(item('i_min').notes, '- Minutes approved', 'the approval item is the minutes’ “Q2 Board Meeting”');
  assert.match(item('i_fin').notes, /Reserves grew this quarter/);
  assert.deepEqual([item('i_fin').docs, item('i_fin').who, item('i_fin').live, item('i_fin').presenter], [['f_sheet1'], ['sam-ortiz'], 'cash', 'Sam Ortiz'], 'what only the agenda has stays');
  assert.equal(item('i_proj').notes, '- Two families are in Build', 'alike titles match (“Projects updates” and “Project updates”)');
  assert.deepEqual([item('i_store').notes, item('i_store').staffNote], ['- Holiday hours start in November', 'Ask about the lease'], 'an item the minutes don’t mention keeps what it had');
  assert.equal(next.agendaFrom.kind, 'typed', 'still the agenda someone wrote');
  // Who was there: the minutes are the record
  assert.deepEqual(next.attendance.map((p) => `${p.slug}:${p.status}:${p.rsvp}`), [
    'alex-rivera:present:yes', 'jane-doe:present:', 'kim-park:absent:', 'sam-ortiz:present:',
    'lee-example:excused:', 'max-sample:absent:yes',
  ], 'named ones as the minutes say (Sam in the room, not on video); unnamed board members absent, an excused one stays excused; answers kept');
  // Motions: the board page's vote stays and isn't doubled; actions likewise
  assert.deepEqual(next.motions.map((x) => [x.id, x.tally?.for ?? null]), [['v_live1', 3]]);
  assert.deepEqual(next.actions.map((x) => x.text), ['Send the venue options for the spring gala', 'Book the photographer']);
  assert.deepEqual(next.actions[1].ownerName, 'Pat Visitor');
  assert.deepEqual(next.minutesFrom, { name: 'Q3 minutes.pdf', at: AT, ai: false, tries: 1 }, 'read by the rules alone: marked to be read again by the model');
  // The same minutes again: nothing doubled
  const twice = applyMinutes(next, read, { fileName: 'Q3 minutes.pdf', now: Date.parse(AT) });
  assert.deepEqual(twice.sections.map((s) => s.items.length), next.sections.map((s) => s.items.length));
  assert.equal(twice.motions.length, next.motions.length);
  assert.equal(twice.actions.length, next.actions.length);
  // And it saves as a clean meeting
  assert.equal(cleanMeeting(twice).sections.length, 4);
});

test('a draft agenda takes the minutes’ outline; items that were on it keep their id and documents; one with documents the minutes skip stays', async () => {
  const read = await readMinutes({}, { text: SOARD_MINUTES, people: PEOPLE });
  const cur = cleanMeeting({
    id: 'm_draft1', date: '2026-08-06', agendaFrom: { kind: 'last-meeting', name: 'Q2 Board Meeting (Apr 30)', at: AT },
    sections: [
      { id: 's_a', title: 'Call to order', items: [{ id: 'i_roll2', title: 'Roll call' }, { id: 'i_welcome', title: 'Welcome and introductions' }] },
      { id: 's_b', title: 'Committee reports', items: [{ id: 'i_fin2', title: 'Financial', live: 'cash', docs: ['f_sheet2'] }, { id: 'i_mission', title: 'Mission Advancement', docs: ['f_deck1'] }] },
    ],
  });
  assert.equal(shapeFrom(cur, read), 'minutes');
  const next = applyMinutes(cur, read, { fileName: 'Q3 minutes.docx', now: Date.parse(AT) });
  assert.deepEqual(next.sections.map((s) => [s.title, s.items.map((it) => it.title)]), [
    ['Call to order', ['Roll Call']],
    ['Approve meeting minutes', ['Q2 Board Meeting']],
    ['Committee reports', ['Financial', 'Project updates and upcoming reveals', 'Mission Advancement']],
    ['New business', ['Spring gala venue']],
  ], 'the welcome nobody gave is gone; Mission Advancement stays for its deck');
  const fin = next.sections[2].items[0];
  assert.deepEqual([fin.id, fin.docs, fin.live], ['i_fin2', ['f_sheet2'], 'cash']);
  assert.equal(next.sections[0].items[0].id, 'i_roll2');
  assert.deepEqual([next.agendaFrom.kind, next.agendaFrom.name], ['typed', 'Q3 minutes.docx'], 'the meeting’s own now, so no newer draft replaces it');
  assert.equal(applyMinutes(cur, read, { fileName: 'x', agendaFrom: { kind: 'drive', name: 'x.pdf', at: AT, v: 2 } }).agendaFrom.kind, 'drive', 'Board’s readers name where it came from');
  // A title that says nothing of its own ("Update") is the agenda item in its place; two different titles never are
  const agenda = cleanMeeting({ date: '2026-08-06', agendaFrom: { kind: 'typed', name: '', at: AT }, sections: [{ id: 's_c', title: 'Committee reports', items: [{ id: 'i_gov', title: 'Governance' }, { id: 'i_st', title: 'Store update', docs: ['f_store1'] }, { id: 'i_ev', title: 'Events', docs: ['f_ev1'] }] }] });
  const said = { attendance: [], motions: [], actions: [], sections: [{ id: 's_m', title: 'Committee reports', items: [{ id: 'i_m1', title: 'Governance', notes: '- Bylaws signed' }, { id: 'i_m2', title: 'Update', notes: '- Holiday sales up' }, { id: 'i_m3', title: 'Golf tournament', notes: '- $300k raised' }] }] };
  const placed = applyMinutes(agenda, said, { fileName: 'm.pdf' }).sections[0].items;
  assert.deepEqual(placed.map((it) => [it.id, it.title, it.notes]), [
    ['i_gov', 'Governance', '- Bylaws signed'], ['i_st', 'Store update', '- Holiday sales up'], ['i_ev', 'Events', ''], ['i_m3', 'Golf tournament', '- $300k raised'],
  ]);
  // Too little outline (Drive asks for two parts): the draft stays, nothing taken from the minutes' outline
  const thin = { ...read, sections: read.sections.slice(0, 1) };
  assert.equal(shapeFrom(cur, thin, { minSections: 2 }), 'agenda');
});

test('Board’s own readers leave attendance someone marked as it is; minutes come in only when newer than ones read in by hand', () => {
  const read = { attendance: [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board', status: 'absent' }], sections: [], motions: [], actions: [], approvedPrev: false, said: { by: 'rules' } };
  const marked = written();
  assert.deepEqual(applyMinutes(marked, read, { keepMarked: true }).attendance, marked.attendance);
  const unmarked = cleanMeeting({ date: '2026-08-06', attendance: [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' }, { slug: 'kim-park', name: 'Kim Park', kind: 'board' }] });
  assert.deepEqual(applyMinutes(unmarked, read, { keepMarked: true }).attendance.map((p) => `${p.slug}:${p.status}`), ['alex-rivera:absent', 'kim-park:'], 'only absences named: nobody else is marked absent');
  // Which minutes may go on
  const had = { minutesFrom: { name: 'Q3 minutes.pdf', at: '2026-08-10T12:00:00.000Z' } };
  assert.equal(minutesNewer({}, { name: 'Anything.pdf' }), true, 'none read in yet');
  assert.equal(minutesNewer(had, { name: 'Q3 minutes.docx', at: '2026-01-01T00:00:00Z' }), true, 'the same minutes in another format');
  assert.equal(minutesNewer(had, { name: 'Draft minutes.pdf', at: '2026-08-09T00:00:00Z' }), false, 'older than the ones read in by hand');
  assert.equal(minutesNewer(had, { name: 'Corrected minutes.pdf', at: '2026-08-12T00:00:00Z' }), true, 'changed since');
  assert.equal(minutesNewer(had, { name: 'Draft minutes.pdf' }), false);
  assert.ok(likeness('Financial report', 'Financial') === 1 && likeness('Governance', 'Store update') === 0);
});

// ─── The admin's upload: POST /api/board-admin read-minutes ─────────

const TEAM = 'soard';
const AUD = 'aud-tag';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const FOUNDER = 'jane@soardcharity.com';
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
class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, bytes, opts) { this.map.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType }); }
  async get(key) { const o = this.map.get(key); return o ? { body: o.bytes, size: o.bytes.length, httpMetadata: { contentType: o.type } } : null; }
  async delete(key) { this.map.delete(key); }
}
let env;
let texts; // what Workers AI's PDF converter reads in each file, by name
const realFetch = globalThis.fetch;
beforeEach(async () => {
  texts = {};
  env = { DB: await createD1(), FILES: new FakeR2(), CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, AI: { toMarkdown: async (doc) => ({ name: doc.name, format: 'text', data: texts[doc.name] || '' }) } };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  for (const [slug, d] of [
    ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
    ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair', organization: 'Rivera Builders' }],
    ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
    ['kim-park', { name: 'Kim Park', group: 'board', title: 'Board Member' }],
  ]) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  _resetKeyCacheForTests();
  globalThis.fetch = async (input) => {
    if (String(input) === `${ISS}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${input}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function adminPost(body) {
  const request = new Request('https://sunshineonaranneyday.com/api/board-admin', {
    method: 'POST', headers: { 'CF-Access-JWT-Assertion': await signIn(FOUNDER), Origin: 'https://sunshineonaranneyday.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const ctx = { request, env, data: {}, waitUntil: () => {} };
  ctx.next = async () => admin.onRequestPost(ctx);
  const res = await onRequest(ctx);
  return { status: res.status, body: await res.json() };
}
const pdf = (name) => new File([new TextEncoder().encode(`%PDF-1.7\n% ${name}\n`)], name, { type: 'application/pdf' });

test('the admin uploads the minutes: the meeting fills itself, the file is filed as the minutes, and the last minutes are approved', async () => {
  const prev = await saveMeeting(env.DB, cleanMeeting({ date: '2026-04-30', title: 'Q2 Board Meeting' }), { by: FOUNDER });
  const m = await saveMeeting(env.DB, cleanMeeting({
    date: '2026-08-06', title: 'Q3 Board Meeting', agendaFrom: { kind: 'typed', name: '', at: AT },
    sections: [{ title: 'Approve meeting minutes', items: [{ title: 'Minutes of the Q2 Board Meeting (Apr 30)', live: 'minutes', about: prev.id }] }, { title: 'Committee reports', items: [{ title: 'Financial', live: 'cash' }] }],
    attendance: [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' }, { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board' }, { slug: 'kim-park', name: 'Kim Park', kind: 'board' }],
  }), { by: FOUNDER });
  const file = await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: pdf('Q3 notes.pdf'), kind: 'other', by: FOUNDER });
  texts['Q3 notes.pdf'] = SOARD_MINUTES;
  const r = await adminPost({ action: 'read-minutes', id: m.id, fileId: file.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.read, { attendance: { here: 2, of: 3 }, notes: 4, motions: 1, actions: 0, ai: false });
  assert.equal(r.body.approvedPrev, prev.id);
  const after = await getMeeting(env.DB, m.id);
  assert.deepEqual(after.attendance.filter((p) => p.kind === 'board').map((p) => `${p.slug}:${p.status}`), ['alex-rivera:present', 'kim-park:absent', 'sam-ortiz:present']);
  assert.deepEqual(after.sections.map((s) => s.title), ['Approve meeting minutes', 'Committee reports', 'Call to order', 'New business']);
  assert.equal(after.sections[0].items[0].notes, '- Minutes approved');
  assert.deepEqual(after.motions.map((x) => x.text), ['Approve the 2027 budget']);
  assert.equal(after.files.find((f) => f.id === file.id).kind, 'minutes');
  assert.deepEqual([(await getMeeting(env.DB, prev.id)).minutes, (await getMeeting(env.DB, prev.id)).approvedOn], ['approved', '2026-08-06']);
  const log = (await env.DB.prepare('SELECT entity_name FROM audit_log').all()).results.map((x) => x.entity_name);
  assert.ok(log.includes('Board minutes read in: Q3 Board Meeting'), 'audited by name only');

  // A file with nothing in it to read, another meeting's file, no file
  const blank = await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: pdf('Scan.pdf'), kind: 'minutes', by: FOUNDER });
  const none = await adminPost({ action: 'read-minutes', id: m.id, fileId: blank.id });
  assert.deepEqual([none.status, none.body.ok], [422, false]);
  assert.match(none.body.error, /couldn’t read that file/i);
  texts['Words.pdf'] = 'Some words that are not minutes at all.';
  const words = await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: pdf('Words.pdf'), kind: 'minutes', by: FOUNDER });
  assert.match((await adminPost({ action: 'read-minutes', id: m.id, fileId: words.id })).body.error, /couldn’t find minutes/i);
  const elsewhere = await putFile(env, { ownerType: 'meeting', ownerId: prev.id, file: pdf('Other.pdf'), kind: 'minutes', by: FOUNDER });
  assert.equal((await adminPost({ action: 'read-minutes', id: m.id, fileId: elsewhere.id })).status, 404);
  assert.equal((await adminPost({ action: 'read-minutes', id: 'm_gone1', fileId: file.id })).status, 404);
  assert.equal((await adminPost({ action: 'read-minutes', id: 'x', fileId: file.id })).status, 400);
});

test('minutes the heartbeat read without the model are read again later for their motions and action items, three tries at most', async () => {
  const { maybeFinishMinutes } = await import('../functions/api/_board-minutes.js');
  const { createD1 } = await import('./lib/d1-shim.mjs');
  const { saveMeeting, getMeeting, ensureSchema, putFile } = await import('../functions/api/_board.js');
  class R2 { constructor() { this.map = new Map(); } async put(k, b) { this.map.set(k, new Uint8Array(b)); } async get(k) { const b = this.map.get(k); return b ? { body: b, size: b.length } : null; } async delete(k) { this.map.delete(k); } }
  let answer = null;
  const env = { DB: await createD1(), FILES: new R2(), AI: { toMarkdown: async (doc) => ({ name: doc.name, format: 'text', data: SOARD_MINUTES }), run: async () => { if (!answer) throw new Error('timeout'); return { response: answer }; } } };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await ensureSchema(env.DB);
  const m = await saveMeeting(env.DB, { id: 'm_fin00001', date: '2026-08-06', sections: [{ title: 'Call to order', items: [{ title: 'Roll call' }] }] }, { by: 'test' });
  const f = await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')], 'Q3 minutes.pdf', { type: 'application/pdf' }), kind: 'minutes', by: 'test' });
  await saveMeeting(env.DB, { ...(await getMeeting(env.DB, m.id)), minutesFrom: { name: f.name, at: '2026-08-07T12:00:00.000Z', ai: false, tries: 1 } }, { by: 'test' });
  let now = Date.parse('2026-08-08T12:00:00Z');
  assert.equal(await maybeFinishMinutes(env, { now }), m.id, 'it tries the meeting');
  assert.equal((await getMeeting(env.DB, m.id)).minutesFrom.tries, 2, 'the model out of time again: one more try counted');
  assert.equal(await maybeFinishMinutes(env, { now: now + 60 * 1000 }), null, 'not again within two minutes');
  answer = { motions: [{ text: 'Approve the 2027 budget', by: 'Alex Rivera', second: 'Sam Ortiz', result: 'passed' }], actions: [{ text: 'Send the venue contract', owner: 'Alex Rivera', due: '' }], approvedPrev: false };
  now += 3 * 60 * 1000;
  await maybeFinishMinutes(env, { now });
  const done = await getMeeting(env.DB, m.id);
  assert.equal(done.minutesFrom.ai, true);
  assert.ok(done.motions.some((x) => x.text === 'Approve the 2027 budget') && done.actions.some((x) => x.text === 'Send the venue contract'), 'its motions and action items come in');
  assert.equal(await maybeFinishMinutes(env, { now: now + 3 * 60 * 1000 }), null, 'and it isn’t read again');
});

// ─── The minutes template (public/admin/board-minutes-template.js) ─────────────

/** An agenda to make the template from: an empty row left in a part, the last minutes up for approval, a live list with no title, a part with nothing in it yet */
const forTemplate = () => cleanMeeting({
  id: 'm_tmpl0001', date: '2026-11-05', start: '08:00', end: '10:00', location: 'Example Hall', address: '1 Example St, Exampleton, GA',
  attendance: PEOPLE.map((p) => ({ slug: p.slug, name: p.name, org: p.org, kind: p.kind })),
  sections: [
    { id: 's_one', title: 'Call to order', items: [{ id: 'i_roll', title: 'Roll call', presenter: 'Alex Rivera' }, { id: 'i_blank', title: '' }] },
    { id: 's_two', title: 'Approve meeting minutes', items: [{ id: 'i_min', title: 'Minutes of the Q3 2026 Board Meeting (Aug 6, 2026)', live: 'minutes' }] },
    { id: 's_three', title: 'Committee reports', items: [{ id: 'i_fin', title: 'Financial', presenter: 'Sam', live: 'cash' }, { id: 'i_proj', title: 'Project updates', presenter: 'Kim', live: 'projects' }, { id: 'i_rev', title: '', live: 'reveals' }, { id: 'i_store', title: 'Store update', presenter: 'Jane' }] },
    { id: 's_four', title: 'New business', items: [] },
  ],
});

/**
 * The Word template typed into the way a person does it in Word: `roll` { name: ['x' or '', 'video' / 'excused'] },
 * `notes` typed into the empty bullets in order, `paragraph` { 'Item title': text } typed after an item with the
 * bullet turned off, `lists` { 'PART IN CAPITALS': [lines] } typed into a part's empty numbered line, `guests`
 */
async function typeInto(bytes, { roll = {}, notes = [], paragraph = {}, lists = {}, guests = '' }) {
  const { unzip } = await import('../public/admin/board-shared.js');
  const { zip } = await import('../public/admin/board-minutes-template.js');
  const names = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml'];
  const parts = await unzip(bytes, names);
  const text = (b) => new TextDecoder().decode(b);
  const run = (s) => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
  let doc = text(parts['word/document.xml']);
  for (const [name, marks] of Object.entries(roll)) {
    doc = doc.replace(new RegExp(`<w:tr>(?:(?!</w:tr>)[\\s\\S])*?>${name}<(?:(?!</w:tr>)[\\s\\S])*?</w:tr>`), (row) => {
      let i = 0;
      return row.replace(/(<w:pStyle w:val="Cell"\/>(?:<w:jc w:val="center"\/>)?<\/w:pPr>)(<\/w:p>)/g, (all, a, b) => { const v = marks[i++]; return v ? `${a}${run(v)}${b}` : all; });
    });
  }
  if (guests) doc = doc.replace('Guests: </w:t></w:r>', `Guests: </w:t></w:r>${run(guests)}`);
  let k = 0;
  doc = doc.replace(/(<w:p><w:pPr><w:pStyle w:val="Note"\/><w:numPr><w:ilvl w:val="2"\/><w:numId w:val="1"\/><\/w:numPr><\/w:pPr>)(<\/w:p>)/g, (all, a, b) => { const v = notes[k++]; return v ? `${a}${run(v)}${b}` : all; });
  for (const [title, words] of Object.entries(paragraph)) doc = doc.replace(new RegExp(`(>${title}</w:t></w:r>[\\s\\S]*?</w:p>)`), `$1<w:p>${run(words)}</w:p>`);
  const item = '<w:p><w:pPr><w:pStyle w:val="Item"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr></w:p>';
  for (const [part, lines] of Object.entries(lists)) doc = doc.replace(`>${part}</w:t></w:r></w:p>${item}`, `>${part}</w:t></w:r></w:p>${lines.map((l) => item.replace('</w:pPr></w:p>', `</w:pPr>${run(l)}</w:p>`)).join('')}`);
  return zip(names.map((n) => [n, n === 'word/document.xml' ? doc : text(parts[n])]));
}

test('the minutes template is the agenda the way Board reads minutes: the roll, each part in capitals, each item with who presents', async () => {
  const { minutesDocx, minutesFileName, minutesOutline } = await import('../public/admin/board-minutes-template.js');
  const { docxText } = await import('../public/admin/board-shared.js');
  const m = forTemplate();
  const next = { id: 'm_next0001', date: '2027-02-11', start: '08:00', sections: [], attendance: [] };
  assert.equal(minutesFileName(m), 'Q4 2026 Board Meeting minutes (2026-11-05).docx', '“minutes” and the date in the name, for the email and Drive readers');
  const o = minutesOutline(m, { meetings: [m, next] });
  assert.deepEqual([o.board, o.quorum, o.next?.name], [5, 3, 'Q1 2027 Board Meeting']);
  // Who presents picked from People (`who`), with no names typed: by name all the same
  m.sections[2].items[1] = { ...m.sections[2].items[1], presenter: '', who: ['kim-park', 'jane-doe'] };
  const lines = (await docxText(minutesDocx(m, { meetings: [m, next], people: PEOPLE }))).split('\n');
  for (const want of ['Max Sample', 'Alex Rivera', 'Jane Doe', 'Guests:', '1. CALL TO ORDER', '   1. Roll call (Alex Rivera)', '2. APPROVE MEETING MINUTES',
    '   1. Minutes of the Q3 2026 Board Meeting (Aug 6, 2026)', '   1. Financial (Sam Ortiz)', '   2. Project updates (Kim Park & Jane Doe)', '   3. Upcoming reveals', '4. NEW BUSINESS', '5. MOTIONS', '6. ACTION ITEMS']) {
    assert.ok(lines.includes(want), `has “${want}”`);
  }
  assert.ok(!lines.some((l) => /^\s+2\. $|^\s+2\.\s*$/.test(l)) && lines.indexOf('2. APPROVE MEETING MINUTES') === lines.indexOf('   1. Roll call (Alex Rivera)') + 1, 'the row left empty isn’t on it');
  assert.ok(lines.some((l) => l.startsWith('Next meeting: Q1 2027 Board Meeting')));
});

test('the template left blank and dropped in changes nothing: nobody marked absent, no notes, no motions', async () => {
  const { minutesDocx } = await import('../public/admin/board-minutes-template.js');
  const m = forTemplate();
  const read = await readMinutes({}, { name: 'Q4 minutes.docx', bytes: minutesDocx(m), meeting: m, people: PEOPLE });
  assert.deepEqual([read.attendance, read.motions, read.actions, read.approvedPrev], [[], [], [], false]);
  const next = applyMinutes(m, read, { fileName: 'Q4 minutes.docx', now: Date.parse(AT) });
  assert.deepEqual(next.sections.map((s) => [s.id, s.items.map((it) => [it.id, it.notes])]), m.sections.map((s) => [s.id, s.items.map((it) => [it.id, it.notes])]));
  assert.ok(next.attendance.every((p) => !p.status));
});

test('the template typed into and dropped in: the roll with video, excused and guests, each note on its own item, the motions and action items, no new parts', async () => {
  const { minutesDocx } = await import('../public/admin/board-minutes-template.js');
  const m = forTemplate();
  const bytes = await typeInto(minutesDocx(m), {
    roll: { 'Alex Rivera': ['x'], 'Sam Ortiz': ['x', 'on video'], 'Kim Park': ['', 'excused'], 'Jane Doe': ['x'] },
    guests: 'Pat Visitor (Example Co), none',
    notes: ['Alex called the meeting to order at 8:04 AM.', 'Motion to approve the Q3 minutes by Sam Ortiz, seconded by Kim Park. Motion passed.', 'Reserves grew this quarter.'],
    paragraph: { 'Store update': 'Holiday hours start in November.' },
    lists: {
      'NEW BUSINESS': ['Spring gala venue'],
      MOTIONS: ['Motion to adopt the 2027 budget by Alex Rivera, seconded by Lee Example. Motion passed.'],
      'ACTION ITEMS': ['Sam will send the bank letters to the board by Nov 20', 'Lee: bylaws draft by Jan 15'],
    },
  });
  const read = await readMinutes({}, { name: 'Q4 minutes.docx', bytes, meeting: m, people: PEOPLE });
  assert.deepEqual(read.attendance.map((p) => `${p.name}:${p.status}`), ['Alex Rivera:present', 'Sam Ortiz:remote', 'Kim Park:excused', 'Lee Example:absent', 'Max Sample:absent', 'Jane Doe:present', 'Pat Visitor:present']);
  assert.deepEqual(read.motions.map((x) => [x.text, x.by, x.second, x.result]), [['Approve the Q3 minutes', 'Sam Ortiz', 'Kim Park', 'passed'], ['Adopt the 2027 budget', 'Alex Rivera', 'Lee Example', 'passed']]);
  assert.deepEqual(read.actions.map((x) => [x.owner, x.due]), [['sam-ortiz', '2026-11-20'], ['lee-example', '2027-01-15']], 'whose, and January after a November meeting is next year’s');
  assert.equal(read.approvedPrev, true, 'the motion on the minutes item passed');
  const next = applyMinutes(m, read, { fileName: 'Q4 minutes.docx', now: Date.parse(AT) });
  assert.deepEqual(next.sections.map((s) => [s.id, s.items.map((it) => it.id.startsWith('i_') && it.id.length < 9 ? it.id : it.title)]), [
    ['s_one', ['i_roll', 'i_blank']], ['s_two', ['i_min']], ['s_three', ['i_fin', 'i_proj', 'i_rev', 'i_store']], ['s_four', ['Spring gala venue']],
  ], 'the agenda as it was, “Upcoming reveals” matched to the untitled list, the new business topic under New business, no Motions or Action items part');
  const item = (id) => next.sections.flatMap((s) => s.items).find((it) => it.id === id);
  assert.equal(item('i_roll').notes, '- Alex called the meeting to order at 8:04 AM.');
  assert.match(item('i_min').notes, /Motion to approve the Q3 minutes/);
  assert.equal(item('i_fin').notes, '- Reserves grew this quarter.');
  assert.equal(item('i_store').notes, '- Holiday hours start in November.', 'a plain paragraph under an item is a note on it, never part of its title');
  assert.equal(item('i_store').title, 'Store update');
  assert.deepEqual([item('i_fin').live, item('i_fin').presenter], ['cash', 'Sam']);
  assert.deepEqual(next.actions.map((x) => x.ownerName), ['Sam Ortiz', 'Lee Example']);
});

test('an agenda with its own “Action items” part keeps it as a part (only the template’s own are left off the agenda)', async () => {
  const m = cleanMeeting({ id: 'm_own00001', date: '2026-11-05', sections: [{ id: 's_act', title: 'Action items', items: [{ id: 'i_rev1', title: 'Review last quarter’s items' }] }] });
  const read = await readMinutes({}, { text: '1. ACTION ITEMS\n1. Review last quarter’s items\na. All done but one', meeting: m, people: PEOPLE });
  assert.deepEqual(read.sections.map((s) => s.title), ['Action items']);
});

test('the board’s secretary sends the typed minutes template from the board page: read into the meeting at once; nobody else can, nor before the day', async () => {
  const portal = await import('../functions/api/board-portal.js');
  const { minutesDocx } = await import('../public/admin/board-minutes-template.js');
  await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind('lee-example', 'Lee Example', 'board', JSON.stringify({ name: 'Lee Example', group: 'board', title: 'Board Secretary' })).run();
  for (const [slug, email] of [['lee-example', 'lee.board@example.com'], ['kim-park', 'kim.board@example.com']]) await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  const people = [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' }, { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board' }, { slug: 'kim-park', name: 'Kim Park', kind: 'board' }, { slug: 'lee-example', name: 'Lee Example', kind: 'board' }];
  const meeting = (extra) => saveMeeting(env.DB, cleanMeeting({
    date: '2026-08-06', title: 'Q3 Board Meeting', shared: true, agendaFrom: { kind: 'typed', name: '', at: AT }, attendance: people,
    sections: [{ title: 'Committee reports', items: [{ title: 'Financial', live: 'cash', staffNote: 'PRIVATE: ask counsel' }] }], ...extra,
  }), { by: FOUNDER });
  const m = await meeting({});
  // Lee types into the template: everyone there but Kim, a note under Financial
  let doc = new TextDecoder().decode((await (await import('../public/admin/board-shared.js')).unzip(minutesDocx(m), ['word/document.xml']))['word/document.xml']);
  for (const name of ['Alex Rivera', 'Sam Ortiz', 'Lee Example']) doc = doc.replace(new RegExp(`(<w:tr>(?:(?!</w:tr>)[\\s\\S])*?<w:jc w:val="center"/></w:pPr>)(</w:p>(?:(?!</w:tr>)[\\s\\S])*?>${name}<)`), '$1<w:r><w:t>x</w:t></w:r>$2');
  doc = doc.replace(/(<w:pStyle w:val="Note"\/>(?:(?!<\/w:p>)[\s\S])*?<\/w:pPr>)(<\/w:p>)/, '$1<w:r><w:t>Reserves grew this quarter.</w:t></w:r>$2');
  const { unzip } = await import('../public/admin/board-shared.js');
  const { zip } = await import('../public/admin/board-minutes-template.js');
  const all = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml'];
  const parts = await unzip(minutesDocx(m), all);
  const typed = zip(all.map((n) => [n, n === 'word/document.xml' ? doc : new TextDecoder().decode(parts[n])]));
  const send = async (email, id, file) => {
    const form = new FormData();
    if (file) form.append('file', file);
    const request = new Request(`https://sunshineonaranneyday.com/api/board-portal?minutes=${id}`, { method: 'POST', headers: { 'CF-Access-JWT-Assertion': await signIn(email), Origin: 'https://sunshineonaranneyday.com' }, body: form });
    const ctx = { request, env, data: {}, waitUntil: () => {} };
    ctx.next = async () => portal.onRequestPost(ctx);
    const res = await onRequest(ctx);
    return { status: res.status, body: await res.json() };
  };
  const word = (name = 'Q3 minutes.docx') => new File([typed], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  // Not the secretary: refused, nothing kept
  assert.equal((await send('kim.board@example.com', m.id, word())).status, 403);
  assert.equal((await getMeeting(env.DB, m.id)).files.length, 0);
  // The secretary
  const r = await send('lee.board@example.com', m.id, word());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.read, { attendance: { here: 3, of: 4 }, notes: 1, motions: 0, actions: 0, ai: false });
  assert.ok(!('meeting' in r.body) && !JSON.stringify(r.body).includes('PRIVATE'), 'a board member gets back what was read, never Board’s own copy of the meeting');
  const after = await getMeeting(env.DB, m.id);
  assert.equal(after.sections[0].items[0].notes, '- Reserves grew this quarter.');
  assert.deepEqual(after.attendance.map((p) => `${p.slug}:${p.status}`), ['alex-rivera:present', 'sam-ortiz:present', 'kim-park:absent', 'lee-example:present']);
  assert.deepEqual([after.files.length, after.files[0].kind, after.files[0].name, after.minutesFrom.name], [1, 'minutes', 'Q3 minutes.docx', 'Q3 minutes.docx']);
  // Not before the meeting's day, not a meeting the board can't see, not something that isn't minutes
  assert.equal((await send('lee.board@example.com', (await meeting({ date: '2099-02-11' })).id, word())).status, 400);
  assert.equal((await send('lee.board@example.com', (await meeting({ shared: false })).id, word())).status, 404);
  assert.equal((await send('lee.board@example.com', m.id, new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }))).status, 400);
  assert.equal((await send('lee.board@example.com', m.id, null)).status, 400);
});

test('another meeting’s minutes, by their own heading or file name, go on a meeting only when someone says so', async () => {
  const { otherMeetingIn } = await import('../functions/api/_board-minutes.js');
  const q4 = { date: '2026-11-05', title: '' };
  assert.deepEqual(otherMeetingIn(q4, { name: 'Q3 2026 Board Meeting minutes.docx' }), { date: '', name: 'Q3 2026 Board Meeting' });
  assert.deepEqual(otherMeetingIn(q4, { name: 'Q3 minutes.pdf', date: '2026-08-06' }), { date: '2026-08-06', name: 'Q3 2026 Board Meeting' });
  assert.equal(otherMeetingIn(q4, { name: 'Q4 2026 Board Meeting minutes (2026-11-05).docx' }), null, 'the template’s own name');
  assert.equal(otherMeetingIn(q4, { text: 'Q4 2026 Board Meeting minutes\nDate  Thursday, November 5, 2026\n1. CALL TO ORDER\n   1. Minutes of the Q3 2026 Board Meeting (Aug 6, 2026)' }), null, 'the last minutes up for approval never count');
  assert.equal(otherMeetingIn(q4, { name: 'Board minutes.docx', text: 'Board minutes\nDate: November 12, 2026\n1. CALL TO ORDER' }), null, 'a meeting moved by a week is still this one');
  // The founders' drop: 409 saying whose, nothing on the meeting; then read in when they say so
  const m = await saveMeeting(env.DB, cleanMeeting({ date: '2026-11-05', agendaFrom: { kind: 'typed', name: '', at: AT }, sections: [{ title: 'Committee reports', items: [{ title: 'Financial', live: 'cash' }] }], attendance: [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' }, { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board' }] }), { by: FOUNDER });
  const file = await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: pdf('Q3 minutes.pdf'), kind: 'minutes', by: FOUNDER });
  texts['Q3 minutes.pdf'] = SOARD_MINUTES;
  const r = await adminPost({ action: 'read-minutes', id: m.id, fileId: file.id });
  assert.equal(r.status, 409);
  assert.deepEqual([r.body.other, r.body.fileId], [{ date: '2026-08-06', name: 'Q3 2026 Board Meeting' }, file.id]);
  assert.match(r.body.error, /^These look like the minutes of the Q3 2026 Board Meeting \(Aug 6, 2026\), not this meeting’s \(Q4 2026 Board Meeting, Nov 5, 2026\)\.$/);
  assert.ok(!(await getMeeting(env.DB, m.id)).minutesFrom, 'nothing put on the meeting');
  const anyway = await adminPost({ action: 'read-minutes', id: m.id, fileId: file.id, anyway: true });
  assert.equal(anyway.status, 200);
  assert.equal((await getMeeting(env.DB, m.id)).minutesFrom.name, 'Q3 minutes.pdf');
});

test('the secretary sending another meeting’s minutes: nothing kept, and “send it anyway” sends them', async () => {
  const portal = await import('../functions/api/board-portal.js');
  await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind('lee-example', 'Lee Example', 'board', JSON.stringify({ name: 'Lee Example', group: 'board', title: 'Board Secretary' })).run();
  await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('lee-example', 'lee.board@example.com').run();
  const m = await saveMeeting(env.DB, cleanMeeting({ date: '2026-11-02', shared: true, agendaFrom: { kind: 'typed', name: '', at: AT }, sections: [{ title: 'Committee reports', items: [{ title: 'Financial' }] }], attendance: [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' }] }), { by: FOUNDER });
  texts['Minutes 2026-08-06.pdf'] = SOARD_MINUTES;
  const send = async (anyway) => {
    const form = new FormData();
    form.append('file', pdf('Minutes 2026-08-06.pdf'));
    const request = new Request(`https://sunshineonaranneyday.com/api/board-portal?minutes=${m.id}${anyway ? '&anyway=1' : ''}`, { method: 'POST', headers: { 'CF-Access-JWT-Assertion': await signIn('lee.board@example.com'), Origin: 'https://sunshineonaranneyday.com' }, body: form });
    const ctx = { request, env, data: {}, waitUntil: () => {} };
    ctx.next = async () => portal.onRequestPost(ctx);
    const res = await onRequest(ctx);
    return { status: res.status, body: await res.json() };
  };
  const r = await send(false);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.other.date, '2026-08-06');
  assert.equal((await getMeeting(env.DB, m.id)).files.length, 0, 'nothing kept');
  assert.equal((await send(true)).status, 200);
  assert.deepEqual((await getMeeting(env.DB, m.id)).files.map((f) => f.name), ['Minutes 2026-08-06.pdf']);
});

test('the minutes finisher counts its try before the read: a run cut off during the model’s long answer can’t repeat every 2 minutes for good', async () => {
  const { maybeFinishMinutes } = await import('../functions/api/_board-minutes.js');
  const { createD1 } = await import('./lib/d1-shim.mjs');
  const { saveMeeting, getMeeting, ensureSchema, putFile } = await import('../functions/api/_board.js');
  class R2 { constructor() { this.map = new Map(); } async put(k, b) { this.map.set(k, new Uint8Array(b)); } async get(k) { const b = this.map.get(k); return b ? { body: b, size: b.length } : null; } async delete(k) { this.map.delete(k); } }
  const env = { DB: await createD1(), FILES: new R2(), AI: { toMarkdown: async (doc) => ({ name: doc.name, format: 'text', data: SOARD_MINUTES }), run: async () => { throw new Error('no answer'); } } };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await ensureSchema(env.DB);
  const m = await saveMeeting(env.DB, { id: 'm_fin00002', date: '2026-08-06', sections: [{ title: 'Call to order', items: [{ title: 'Roll call' }] }] }, { by: 'test' });
  const f = await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')], 'Q3 minutes.pdf', { type: 'application/pdf' }), kind: 'minutes', by: 'test' });
  await saveMeeting(env.DB, { ...(await getMeeting(env.DB, m.id)), minutesFrom: { name: f.name, at: '2026-08-07T12:00:00.000Z', ai: false, tries: 0 } }, { by: 'test' });
  // Cut off where the long model call is: nothing after this point runs
  env.FILES.get = async () => { throw new Error('killed'); };
  let now = Date.parse('2026-08-08T12:00:00Z');
  for (let k = 1; k <= 3; k++) {
    await maybeFinishMinutes(env, { now });
    assert.equal((await getMeeting(env.DB, m.id)).minutesFrom.tries, k);
    now += 3 * 60 * 1000;
  }
  assert.equal(await maybeFinishMinutes(env, { now }), null, 'three tries, then let be');
});
const CAP = "2045: Spend limit exceeded: rule 'site-day' (cost limit 5 per 86400s, sliding) for internal-workers-ai @cf/meta/llama-3.3-70b-instruct-fp8-fast";

test('a cap reached: the minutes finisher gives its try back and rests, so motions still come in when it lifts', async () => {
  const { maybeFinishMinutes } = await import('../functions/api/_board-minutes.js');
  const { createD1 } = await import('./lib/d1-shim.mjs');
  const { saveMeeting, getMeeting, ensureSchema, putFile } = await import('../functions/api/_board.js');
  class R2 { constructor() { this.map = new Map(); } async put(k, b) { this.map.set(k, new Uint8Array(b)); } async get(k) { const b = this.map.get(k); return b ? { body: b, size: b.length } : null; } async delete(k) { this.map.delete(k); } }
  let refused = 0;
  let answer = null;
  const env = { DB: await createD1(), FILES: new R2(), AI: { toMarkdown: async (doc) => ({ name: doc.name, format: 'text', data: SOARD_MINUTES }), run: async () => { if (!answer) { refused++; throw new Error(CAP); } return { response: answer }; } } };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await ensureSchema(env.DB);
  const m = await saveMeeting(env.DB, { id: 'm_fin00003', date: '2026-08-06', sections: [{ title: 'Call to order', items: [{ title: 'Roll call' }] }] }, { by: 'test' });
  const f = await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')], 'Q3 minutes.pdf', { type: 'application/pdf' }), kind: 'minutes', by: 'test' });
  await saveMeeting(env.DB, { ...(await getMeeting(env.DB, m.id)), minutesFrom: { name: f.name, at: '2026-08-07T12:00:00.000Z', ai: false, tries: 0 } }, { by: 'test' });
  let now = Date.parse('2026-08-08T12:00:00Z');
  for (let k = 0; k < 6; k++) { await maybeFinishMinutes(env, { now }); now += 3 * 60 * 1000; }
  assert.equal(refused, 1, 'one refusal, then it rests');
  assert.equal((await getMeeting(env.DB, m.id)).minutesFrom.tries || 0, 0, 'no try spent');
  answer = { motions: [{ text: 'Approve the 2027 budget', by: 'Alex Rivera', second: 'Sam Ortiz', result: 'passed' }], actions: [], attendance: [], topics: [] };
  now += 20 * 60 * 1000;
  await maybeFinishMinutes(env, { now });
  const done = await getMeeting(env.DB, m.id);
  assert.equal(done.minutesFrom.ai, true);
  assert.ok(done.motions.some((x) => x.text === 'Approve the 2027 budget'), 'the motions come in after all');
});
