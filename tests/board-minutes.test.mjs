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
