/**
 * To-dos caught in the typed minutes (public/admin/board-todos.js): the lines that name someone and what they'll do,
 * offered in the secretary's own words, with who and by when. Made-up people only (the repo is public).
 * Run: node --test tests/board-todos.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findToDos, dueIn } from '../public/admin/board-todos.js';

const PEOPLE = [
  { slug: 'sam-ortiz', name: 'Sam Ortiz' },
  { slug: 'kim-park', name: 'Kim Park' },
  { slug: 'jane-doe', name: 'Jane Doe' },
  { slug: 'alex-rivera', name: 'Alex Rivera' },
  { slug: 'alex-chen', name: 'Alex Chen' },
];
const M = {
  date: '2026-11-05',
  actions: [],
  sections: [
    { id: 's_a', title: 'Committee reports', items: [
      { id: 'i_events', title: 'Events Committee' },
      { id: 'i_page', title: 'The board page' },
      { id: 'i_quiet', title: 'Store update' },
    ] },
    { id: 's_b', title: 'Open forum', items: [] },
  ],
};
const find = (notes, opts = {}) => findToDos(M, notes, { people: PEOPLE, next: '2027-01-14', ...opts });

test('the notes of a real meeting: each to-do found, with who, by when, and which topic', () => {
  const got = find({
    'n:i_events': 'Gala date: Aug. 28\nSame venue\n\nGolf tournament May 11 or 17\nHill Country Club\nSam to confirm by end of November\n\n15 year book going to sponsors',
    'n:i_page': 'Pulling fresh data - real-time\nJane to send out link to page; uses passcode',
    'n:i_quiet': 'Retail is down but store is profitable\nFlyer to share\nChair to attend board meetings',
    'n:s_b': 'A funding proposal\nCreate strategic plan on how to use funds\nStrategic plan meeting:  Kim to coordinate\nSam to ask how to honor them',
  });
  assert.deepEqual(got.map((x) => [x.text, x.owner, x.due]), [
    ['Golf tournament May 11 or 17: Sam to confirm by end of November', 'sam-ortiz', '2026-11-30'],
    ['The board page: Jane to send out link to page; uses passcode', 'jane-doe', ''],
    ['Strategic plan meeting: Kim to coordinate', 'kim-park', ''],
    ['A funding proposal: Sam to ask how to honor them', 'sam-ortiz', ''],
  ]);
  assert.equal(got[0].from, 'i_events');
  assert.equal(got[3].from, 's_b');
});

test('what isn’t a to-do stays a note', () => {
  for (const line of ['Thanks to Sam for hosting', 'Sam will be at the gala', 'Sam presented the budget', 'Committee to meet in January', 'Chair to attend', 'Board to review', 'Sam and the team did well', 'Flyer to share', 'Sam: the numbers look good', 'Samantha to call'])
    assert.deepEqual(find({ 'n:i_quiet': line }), [], line);
});

test('the ways people write them', () => {
  const owner = (line) => find({ 'n:i_quiet': line })[0]?.owner ?? null;
  assert.equal(owner('Sam will call the venue'), 'sam-ortiz');
  assert.equal(owner('Sam Ortiz to call the venue'), 'sam-ortiz');
  assert.equal(owner('sam to call the venue'), 'sam-ortiz');
  assert.equal(owner('Ask Sam to call the venue'), 'sam-ortiz');
  assert.equal(owner('Asked Kim to call the venue'), 'kim-park');
  assert.equal(owner('Kim needs to call the venue'), 'kim-park');
  assert.equal(owner('Kim agreed to call the venue'), 'kim-park');
  assert.equal(owner('Kim offered to call the venue'), 'kim-park');
  assert.equal(owner('Venue - Kim to call'), 'kim-park');
  assert.equal(owner('Sam and Kim to call the venue'), 'sam-ortiz');
  assert.equal(owner('Action: Kim to call'), 'kim-park');
  assert.equal(owner('To do: call the venue, Kim'), 'kim-park');
  assert.equal(owner('- Sam to call the venue'), 'sam-ortiz');
  // Says it's one and names nobody: offered, for the secretary to say who
  assert.equal(owner('Action item: call the venue'), '');
  assert.equal(find({ 'n:i_quiet': 'Follow up: call the venue' }).length, 1);
});

test('a first name two people share gives no owner, and a full name does', () => {
  const [a] = find({ 'n:i_quiet': 'Alex to call the venue' });
  assert.equal(a.owner, '');
  assert.equal(a.ownerName, '');
  assert.equal(find({ 'n:i_quiet': 'Alex Chen to call the venue' })[0].owner, 'alex-chen');
});

test('a line already an action item, or set aside, isn’t offered again', () => {
  const line = 'Sam to call the venue';
  const key = find({ 'n:i_quiet': line })[0].key;
  assert.deepEqual(find({ 'n:i_quiet': line, skipped: key }), []);
  assert.deepEqual(find({ 'n:i_quiet': line, 'a:a_row1': { text: 'Store update: Sam to call the venue' } }), []);
  assert.deepEqual(find({ 'n:i_quiet': line, 'a:a_row1': { text: line } }), []);
  assert.deepEqual(findToDos({ ...M, actions: [{ id: 'a_x', text: 'Store update: Sam to call the venue' }] }, { 'n:i_quiet': line }, { people: PEOPLE }), []);
  // (and the same line twice in one box is one to-do)
  assert.equal(find({ 'n:i_quiet': `${line}\n${line}` }).length, 1);
});

test('Not a to-do sticks on a long line, whatever falls at the end of its key', () => {
  const line = `Sam to call ${'the venue '.repeat(12)}`;
  for (let pad = 0; pad < 12; pad++) {
    const words = `${'x'.repeat(pad)} ${line}`.trim().replace(/^x+ /, '') + ' and more';
    const [f] = find({ 'n:i_quiet': words });
    assert.ok(f, words);
    assert.equal(f.key, f.key.trim());
    assert.deepEqual(find({ 'n:i_quiet': words, skipped: f.key }), []);
  }
});

test('nothing in the notes, nothing found', () => {
  assert.deepEqual(find({}), []);
  assert.deepEqual(find({ 'n:i_quiet': '   ' }), []);
  assert.deepEqual(findToDos(null, null || {}, {}), []);
  assert.deepEqual(findToDos(M, { 'n:i_quiet': 'Sam to call' }, { people: [] }), []);
});

test('a name with a regex character in it can’t break the search', () => {
  const people = [{ slug: 'j-r', name: 'J.R. (Bob) Smith' }, ...PEOPLE];
  assert.equal(findToDos(M, { 'n:i_quiet': 'J.R. (Bob) Smith to call' }, { people })[0].owner, 'j-r');
});

test('by when: counted from the meeting, and a date past is next year’s', () => {
  const on = '2026-11-05'; // a Thursday
  const due = (w, opts) => dueIn(w, on, opts);
  assert.equal(due('by end of November'), '2026-11-30');
  assert.equal(due('by the end of Nov.'), '2026-11-30');
  assert.equal(due('by end of February'), '2027-02-28');
  assert.equal(due('by end of the month'), '2026-11-30');
  assert.equal(due('by the end of the year'), '2026-12-31');
  assert.equal(due('by year-end'), '2026-12-31');
  assert.equal(due('by year end'), '2026-12-31');
  assert.equal(due('by end of quarter'), '2026-12-31');
  assert.equal(due('by end of week'), '2026-11-06');
  assert.equal(due('by next meeting', { next: '2027-01-14' }), '2027-01-14');
  assert.equal(due('before the next board meeting', { next: '2027-01-14' }), '2027-01-14');
  assert.equal(due('by next meeting'), '');
  assert.equal(due('by Dec 3'), '2026-12-03');
  assert.equal(due('by December 3rd'), '2026-12-03');
  assert.equal(due('by Jan. 15'), '2027-01-15');
  assert.equal(due('by Jan 15, 2028'), '2028-01-15');
  assert.equal(due('by 12/3'), '2026-12-03');
  assert.equal(due('by 1/15'), '2027-01-15');
  assert.equal(due('by 1/15/28'), '2028-01-15');
  assert.equal(due('by Friday'), '2026-11-06');
  assert.equal(due('by Thursday'), '2026-11-12');
  assert.equal(due('by next Monday'), '2026-11-09');
  assert.equal(due('next week'), '2026-11-12');
  assert.equal(due('due by Nov 30'), '2026-11-30');
  assert.equal(due('before Dec 1'), '2026-12-01');
  // No date in it, and no date that isn't one
  assert.equal(due('soon'), '');
  assert.equal(due('by Feb 31'), '');
  assert.equal(due('by 13/45'), '');
  assert.equal(due('Golf May 11 or 17'), '');
  assert.equal(dueIn('by Friday', ''), '');
  // A leap year's end of February
  assert.equal(dueIn('by end of February', '2027-11-05'), '2028-02-29');
});
