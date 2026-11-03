/**
 * The board page's search (public/admin/board/find.js): words found the way a person types them, a plural or a
 * misspelling found as the word that's there, the small words never needed, and what's found ranked. Made-up
 * content only (the repo is public).
 * Run: node --test tests/board-find.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prep, termsOf, termIn, planOf, matches, scoreOf, marksOf, stemsOf, stemIn, nearest, vocabOf, distance, pageAt } from '../public/admin/board/find.js';

const TEXTS = [
  'Selected as beneficiary of the Example golf tournament',
  '2023 BudgetvsActuals',
  '2026 budget & actual (August 2026)',
  'Board elections: Jane Wierson elected chair',
  'Example Electric, Inc.',
  'D&O insurance',
  'W-9',
  'IRS 501(c)(3) determination letter',
  '$7,500 from Pat O’Brien',
  'Two-thirds of the board',
  'Reserve Fund Policy 5/29/24',
  'Insurance renewal',
  'Policies and procedures',
  'Taxes filed',
  'Half of it: 1/2',
  'Q1 P&L by business',
  'Plumbing donated by Example Plantation',
  'Documents and donations',
  'Signed Amended Bylaws',
  'Pat Lawson, board member',
  'Gift from Jo Parker',
  'Parking at the back lot',
  'Treasury management',
  'The treasurer reported',
  'D&O insurance: 700,000 policyholders',
  'Gala sponsors 2016',
  'The gala',
  'Volunteer hours 1,240',
  'Total 12,401',
  'SOARD Meeting Minutes 2024.04.25',
  'Minutes of 4/25/24',
  'Donor: Example Borden',
  'Board meeting',
  'Board minutes',
  'Board roles',
];
const SPS = TEXTS.map(prep);
const VOCAB = vocabOf(SPS);
const has = (w, how) => SPS.some((sp) => (how === 'one' ? sp.includes(` ${w}`) : how ? stemIn(sp, w) : termIn(sp, w)));
const find = (q) => {
  const plan = planOf(termsOf(q), { vocab: VOCAB, has });
  return { found: TEXTS.filter((_, i) => matches(SPS[i], plan)), fixed: plan.fixed };
};

test('a word is found at the start of a word, never from inside another', () => {
  assert.deepEqual(find('elect').found, ['Board elections: Jane Wierson elected chair', 'Example Electric, Inc.']);
  assert.deepEqual(find('elected').found, ['Board elections: Jane Wierson elected chair'], '“elected” isn’t in “selected”, and its stem isn’t “electric”');
  assert.deepEqual(find('lected').found, []);
  assert.deepEqual(find('scot').found, []);
});

test('whatever the punctuation: W-9, 501(c)(3), 7,500, O’Brien, D&O, two-thirds, a fraction', () => {
  assert.deepEqual(find('w9').found, ['W-9']);
  assert.deepEqual(find('501c3').found, ['IRS 501(c)(3) determination letter']);
  assert.deepEqual(find('7500').found, ['$7,500 from Pat O’Brien']);
  assert.deepEqual(find('obrien').found, ['$7,500 from Pat O’Brien']);
  assert.deepEqual(find('d&o').found, ['D&O insurance', 'D&O insurance: 700,000 policyholders']);
  assert.ok(['D&O insurance', 'D&O insurance: 700,000 policyholders'].every((t) => find('do insurance').found.includes(t)), '“do” a question’s word now: D&O still found');
  assert.deepEqual(find('two thirds').found, ['Two-thirds of the board']);
  assert.deepEqual(find('1/2').found, ['Half of it: 1/2']);
  assert.deepEqual(termsOf('½'), ['1 2'], 'the one-character half too');
});

test('a word run together is found by its parts, and the small words never have to be there', () => {
  assert.deepEqual(find('actual').found, ['2023 BudgetvsActuals', '2026 budget & actual (August 2026)']);
  assert.deepEqual(find('budget vs actual').found, ['2023 BudgetvsActuals', '2026 budget & actual (August 2026)']);
  assert.deepEqual(find('the reserve fund').found, ['Reserve Fund Policy 5/29/24']);
  assert.deepEqual(find('of').found, ['Selected as beneficiary of the Example golf tournament', 'Two-thirds of the board', 'Half of it: 1/2', 'Minutes of 4/25/24'], 'only small words: found by them');
  assert.deepEqual(find('boardelections').found, ['Board elections: Jane Wierson elected chair'], 'two words typed as one');
});

test('a plural or another ending finds the word, with the endings it takes', () => {
  assert.deepEqual(stemsOf('policies'), ['policy']);
  assert.deepEqual(stemsOf('taxes'), ['tax']);
  assert.deepEqual(stemsOf('elected'), ['elect']);
  assert.deepEqual(stemsOf('news'), [], 'a short word keeps its s');
  assert.deepEqual(find('budgets').found, ['2026 budget & actual (August 2026)'], 'a plural is its word with the endings it takes, not every word starting so');
  assert.deepEqual(find('policy').found, ['Reserve Fund Policy 5/29/24', 'D&O insurance: 700,000 policyholders'], 'typed whole, the start of a word as ever');
  assert.deepEqual(find('policies').found, ['Reserve Fund Policy 5/29/24', 'Policies and procedures']);
  assert.ok(stemIn(prep('the elections'), 'elect') && !stemIn(prep('electric'), 'elect'));
});

test('a word nothing has, misspelt, is read as the nearest word there, and says so', () => {
  assert.equal(distance('bugdet', 'budget'), 1, 'two letters swapped are one slip');
  assert.deepEqual(find('bugdet'), { found: ['2023 BudgetvsActuals', '2026 budget & actual (August 2026)'], fixed: [['bugdet', 'budget']] });
  assert.deepEqual(find('insurence').fixed, [['insurence', 'insurance']]);
  assert.deepEqual(find('wierzon').found, ['Board elections: Jane Wierson elected chair']);
  assert.deepEqual(find('bugd').fixed, [['bugd', 'budget']], 'still typing: the start of the nearest word');
  assert.deepEqual(find('budget').fixed, [], 'a word that’s there is never read as another');
  assert.deepEqual(find('7600').found, [], 'a number is never guessed at');
  assert.equal(nearest('zzzz', VOCAB), '');
  assert.ok(marksOf(planOf(['bugdet'], { vocab: VOCAB, has })).includes('budget'), 'the word it was read as is marked');
});

test('ranked: the title before the text, whole words before a start, side by side, often, and the newer first', () => {
  const plan = planOf(termsOf('sam'));
  const score = (title, text = '', date = '') => scoreOf({ title: prep(title), sp: prep(`${title} ${text}`), date }, plan, { today: '2026-11-03' });
  assert.ok(score('Sam Rivers') > score('Sample Builders'), 'Sam Rivers before Sample Builders');
  assert.ok(score('Sample Builders') > score('Minutes', 'Sam moved to approve'), 'in the title before in the text');
  assert.ok(score('Minutes', 'Sam moved. Sam seconded. Sam asked') > score('Minutes', 'Sam moved'), 'more often, higher (a little)');
  assert.ok(score('Minutes', 'Sam moved', '2026-08-06') > score('Minutes', 'Sam moved', '2019-02-11'), 'the newer first');
  const two = planOf(termsOf('reserve fund'));
  const s2 = (text) => scoreOf({ title: prep('Minutes'), sp: prep(text) }, two, {});
  assert.ok(s2('adopt the reserve fund policy') > s2('all rights reserved; the fund'), 'the words side by side, higher');
});

test('a file’s page, from where its words are (pages apart by a form feed)', () => {
  const words = 'Page one\fPage two words\fThird';
  assert.equal(pageAt(words, 0), 1);
  assert.equal(pageAt(words, words.indexOf('two')), 2);
  assert.equal(pageAt(words, words.indexOf('Third')), 3);
});

test('a long text is found by its words as they are: never run on across its spaces (fast, and no false finds)', () => {
  const long = prep(`${'lorem ipsum '.repeat(500)}board meeting`);
  assert.equal(termIn(long, 'boardmeeting'), false);
  assert.equal(termIn(prep('board meeting'), 'boardmeeting'), true);
});

test('an abbreviation with & is found as itself, never as every word starting with its letters', () => {
  assert.deepEqual(termsOf('p&l'), ['p l']);
  assert.deepEqual(find('p&l').found, ['Q1 P&L by business']);
  assert.deepEqual(find('d&o').found, ['D&O insurance', 'D&O insurance: 700,000 policyholders']);
});

test('a date typed with slashes or dashes finds it written any of those ways', () => {
  assert.deepEqual(termsOf('4/25/24'), ['2024 04 25']);
  assert.deepEqual(termsOf('04/25/2024'), ['2024 04 25']);
  assert.deepEqual(termsOf('2024-04-25'), ['2024 04 25']);
  assert.deepEqual(find('4/25/24').found, ['SOARD Meeting Minutes 2024.04.25', 'Minutes of 4/25/24']);
  assert.deepEqual(termsOf('13/45/24'), ['134524'], 'not a date: as typed');
});

test('two words typed apart that the page has as one: “by laws” is Bylaws, and ranks first', () => {
  const { found } = find('by laws');
  assert.ok(found.includes('Signed Amended Bylaws'));
  const plan = planOf(termsOf('by laws'), { vocab: VOCAB, has });
  const sc = (t) => scoreOf({ title: prep(t), sp: prep(t) }, plan, {});
  assert.ok(sc('Signed Amended Bylaws') > sc('Pat Lawson, board member'));
});

test('an ending never runs on into another word: parking isn’t Parker, treasurer isn’t Treasury, policies isn’t policyholders, galas isn’t “gala s(ponsors)”', () => {
  assert.deepEqual(find('parking').found, ['Parking at the back lot']);
  assert.deepEqual(find('treasurer').found, ['The treasurer reported']);
  assert.ok(!find('policies').found.includes('D&O insurance: 700,000 policyholders'));
  assert.deepEqual(find('galas').found, ['Gala sponsors 2016', 'The gala'], 'the gala, by its plural');
  const plan = planOf(termsOf('galas'), { vocab: VOCAB, has });
  assert.ok(scoreOf({ title: prep('The gala'), sp: prep('The gala') }, plan, {}) >= scoreOf({ title: prep('Gala sponsors 2016'), sp: prep('Gala sponsors 2016') }, plan, {}));
});

test('a number is the whole number: 1240 is 1,240, never 12,401', () => {
  assert.deepEqual(find('1240').found, ['Volunteer hours 1,240']);
  assert.deepEqual(find('12401').found, ['Total 12,401']);
});

test('a word that only starts a rare word is read as the common word one letter off, ahead of it', () => {
  const r = find('bord');
  assert.deepEqual(r.fixed, [['bord', 'board']]);
  assert.ok(r.found.includes('Donor: Example Borden') && r.found.includes('Board meeting'));
  const plan = planOf(termsOf('bord'), { vocab: VOCAB, has });
  assert.ok(scoreOf({ title: prep('Board meeting'), sp: prep('Board meeting') }, plan, {}) > scoreOf({ title: prep('Donor: Example Borden'), sp: prep('Donor: Example Borden') }, plan, {}));
  assert.deepEqual(find('boar').fixed, [], 'the start of a common word is left as typed');
});

test('a number is never the tail of a bigger one, a decimal keeps its point, and a time is found as written', () => {
  const T = ['Call to order at 6:05 pm', 'Total 41,605', 'Revenue of $1.2 million', 'Up 12 percent', 'Raised $300k at the gala', 'Minutes of April 25, 2024', 'Officers elected', 'The office moved', 'Founders circle', 'A family foundation', 'Partly Sunny', 'PartlySunny store'];
  const sps = T.map(prep);
  const has2 = (w, how) => sps.some((sp) => (how === 'one' ? sp.includes(` ${w}`) : how ? stemIn(sp, w) : termIn(sp, w)));
  const v = vocabOf(sps);
  const f = (q) => { const plan = planOf(termsOf(q), { vocab: v, has: has2 }); return T.filter((_, i) => matches(sps[i], plan)); };
  assert.deepEqual(f('6:05'), ['Call to order at 6:05 pm']);
  assert.deepEqual(f('6:05 pm'), ['Call to order at 6:05 pm']);
  assert.deepEqual(f('605'), [], 'not in 41,605 or 6:05');
  assert.deepEqual(f('41605'), ['Total 41,605']);
  assert.deepEqual(f('12'), ['Up 12 percent'], 'never $1.2');
  assert.deepEqual(f('1.2'), ['Revenue of $1.2 million']);
  assert.deepEqual(f('$1.2 million'), ['Revenue of $1.2 million']);
  assert.deepEqual(f('300,000'), ['Raised $300k at the gala']);
  assert.deepEqual(f('4/25/24'), ['Minutes of April 25, 2024']);
  assert.deepEqual(f('officer'), ['Officers elected'], 'never office');
  assert.deepEqual(f('founders'), ['Founders circle'], 'never foundation');
  assert.deepEqual(f('partly sunny'), ['Partly Sunny', 'PartlySunny store']);
});

test('two words side by side aren’t one word: “golf tournament” still finds them apart', () => {
  const T = ['Golf tournament sponsors', 'The tournament for golf', 'Golf'];
  const sps = T.map(prep);
  const has3 = (w, how) => sps.some((sp) => (how === 'one' ? sp.includes(` ${w}`) : how ? stemIn(sp, w) : termIn(sp, w)));
  const plan = planOf(termsOf('golf tournament'), { vocab: vocabOf(sps), has: has3 });
  assert.deepEqual(plan.joins, []);
  assert.deepEqual(T.filter((_, i) => matches(sps[i], plan)), ['Golf tournament sponsors', 'The tournament for golf']);
});

test('a question is read for what it asks; a role finds who has it; approved is adopted; Tom is Thomas; a pasted page is read by how it starts', () => {
  const T = ['The board adopted the reserve fund policy', 'Board Treasurer: Thomas Wilson', 'Store report presented by Thomas Wilson', 'The 990s for 2023 and 2024', 'Revenue of $1.2 million'];
  const sps = T.map(prep);
  const hasT = (w, how) => sps.some((sp) => (how === 'one' ? sp.includes(` ${w}`) : how ? stemIn(sp, w) : termIn(sp, w)));
  const roles = new Map([['treasurer', ['thomas wilson']]]);
  const f = (q) => { const plan = planOf(termsOf(q), { vocab: vocabOf(sps), has: hasT, roles }); return T.filter((_, i) => matches(sps[i], plan)); };
  assert.deepEqual(f('when was the reserve fund policy approved'), ['The board adopted the reserve fund policy']);
  assert.deepEqual(f('what did the treasurer say about the store'), ['Store report presented by Thomas Wilson']);
  assert.deepEqual(f('tom wilson'), ['Board Treasurer: Thomas Wilson', 'Store report presented by Thomas Wilson']);
  assert.deepEqual(f('990'), ['The 990s for 2023 and 2024']);
  assert.deepEqual(f('990s'), ['The 990s for 2023 and 2024']);
  assert.deepEqual(f('$1.2M'), ['Revenue of $1.2 million']);
  const long = 'The board met and reviewed the minutes and the budget '.repeat(120);
  assert.ok(termsOf(long).length <= 12 && termsOf(long).every((w) => w.length <= 40));
  assert.doesNotThrow(() => planOf(termsOf(long)));
});
