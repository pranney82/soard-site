/**
 * Makeover scores (functions/api/_applicant-scores.js and public/admin/scoring-shared.js):
 * the rubric's math, each evaluator's own scorecard, a season's capacity, and
 * bringing an evaluator's spreadsheet tab over by name
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  CRITERIA, CRITERION_KEYS, RUBRICS, TIERS, tierOf, totalOf, isComplete, combine, cleanScores, keysOf, rubricOfSeason, fmtScore, TALK_GAP,
} from '../public/admin/scoring-shared.js';
import {
  ensureScoreSchema, saveScorecard, clearScorecard, familyScores, scoreSummaries, capacities, setCapacity, importScores,
} from '../functions/api/_applicant-scores.js';
import { ensureApplicantSchema } from '../functions/api/_applicants.js';
import { ensureCompanyCamSchema } from '../functions/api/_companycam-sync.js';

const SHEET_KEYS = keysOf(1);
/** [mobility, safety, medical, caregiver, longevity, severity, feasibility, structural, readiness, mission] → a 2026 scorecard */
const card = (list) => ({ rubric: 1, scores: Object.fromEntries(SHEET_KEYS.map((k, i) => [k, list[i]])) });
const all = (n, keys = CRITERION_KEYS) => Object.fromEntries(keys.map(k => [k, n]));

// Three families from the 2026 spreadsheet, numbers only: each evaluator's ten scores, what its
// Averaged Scores tab said (each criterion's average rounded, then added) and the plain average
const SHEET = [
  { cards: [[5, 5, 4, 5, 5, 5, 5, 5, 5, 5], [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], [5, 3, 3, 3, 5, 3, 5, 4, 5, 5]], sheet: 46, total: 46.7, tier: 'high' },
  { cards: [[3, 4, 3, 5, 5, 3, 5, 5, 5, 5], [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], [2, 3, 4, 4, 5, 4, 4, 4, 5, 5]], sheet: 45, total: 44.3, tier: 'high' },
  { cards: [[4, 2, 1, 3, 4, 4, 3, 3, 2, 2], [5, 3, 3, 3, 4, 4, 5, 5, 1, 1], [5, 1, 2, 2, 4, 4, 4, 3, 1, 1]], sheet: 30, total: 29.7, tier: 'lower' },
];

test('two rubrics: the 2026 spreadsheet’s, and from 2027 readiness after the home visit and Financial need for Mission & story', () => {
  for (const v of [1, 2]) {
    assert.equal(RUBRICS[v].length, 10);
    for (const c of RUBRICS[v]) assert.equal(c.levels.length, 5, `${v} ${c.key}`);
  }
  assert.match(RUBRICS[1].find(c => c.key === 'mission').note, /afford/);
  assert.equal(RUBRICS[1].find(c => c.key === 'readiness').after, undefined);
  assert.deepEqual(CRITERION_KEYS, ['mobility', 'safety', 'medical', 'caregiver', 'longevity', 'severity', 'feasibility', 'structural', 'readiness', 'financial']);
  assert.equal(CRITERIA.find(c => c.key === 'readiness').after, 'visit');
  assert.deepEqual(CRITERIA.find(c => c.key === 'readiness').levels, RUBRICS[1].find(c => c.key === 'readiness').levels, 'readiness keeps the spreadsheet’s five levels');
  assert.deepEqual([rubricOfSeason('2025'), rubricOfSeason('2026'), rubricOfSeason('2027'), rubricOfSeason(null)], [1, 1, 2, 2]);
  assert.deepEqual(TIERS.map(t => [t.label, t.min]), [['High Priority', 40], ['Strong Candidate', 30], ['Lower Priority', 20], ['Do Not Proceed', 0]]);
});

test('tiers start at 40, 30 and 20', () => {
  assert.deepEqual([50, 40, 39.9, 30, 29.7, 20, 19.9, 10].map(n => tierOf(n).id), ['high', 'high', 'strong', 'strong', 'lower', 'lower', 'stop', 'stop']);
  assert.equal(tierOf(null), null);
});

test('a family’s score is the plain average of everyone’s totals, to one decimal, not the spreadsheet’s rounding', () => {
  for (const s of SHEET) {
    const c = combine(s.cards.map(card));
    assert.equal(c.total, s.total);
    assert.equal(c.tier, s.tier);
    assert.equal(c.count, 3);
    assert.equal(c.rubric, 1);
    assert.notEqual(c.total, s.sheet);
  }
  // 49, 50 and 41: the spreadsheet said 46
  assert.deepEqual(combine(SHEET[0].cards.map(card)).totals, [49, 50, 41]);
  // The spreadsheet's 30 was a Strong Candidate; 28, 34 and 27 average 29.7, Lower Priority
  assert.equal(tierOf(SHEET[2].sheet).id, 'strong');
  // Each criterion's average, to one decimal
  assert.equal(combine(SHEET[0].cards.map(card)).criteria.safety, 4.3);
  assert.deepEqual([fmtScore(47), fmtScore(46.7), fmtScore(null)], ['47', '46.7', '–']);
});

test('halves round up at the decimal', () => {
  const c = combine([card([4, 4, 4, 4, 4, 4, 4, 4, 4, 4]), card([5, 4, 4, 4, 4, 4, 4, 4, 4, 4])]);
  assert.equal(c.criteria.mobility, 4.5);
  assert.equal(c.total, 40.5);
  const t = combine([card([4, 4, 4, 4, 4, 4, 4, 4, 4, 4]), card([4, 4, 4, 4, 4, 4, 4, 4, 4, 4]), card([5, 4, 4, 4, 4, 4, 4, 4, 4, 4])]);
  assert.equal(t.total, 40.3);
});

test('only finished scorecards count; evaluators far apart on a criterion are worth talking about', () => {
  const partial = { rubric: 1, scores: { mobility: 1, safety: 1 } };
  assert.equal(isComplete(partial.scores, 1), false);
  assert.equal(totalOf(partial.scores, 1), null);
  assert.equal(combine([partial]), null);
  const c = combine([card(SHEET[1].cards[0]), card(SHEET[1].cards[1]), card(SHEET[1].cards[2]), partial]);
  assert.equal(c.count, 3);
  assert.equal(c.total, 44.3);
  // Mobility went 3, 5 and 2: three apart
  assert.deepEqual(c.talk, ['mobility']);
  assert.deepEqual(c.range.mobility, [2, 5]);
  assert.equal(TALK_GAP, 3);
});

test('scores are whole numbers from 1 to 5 on the rubric’s criteria', () => {
  assert.deepEqual(cleanScores({ mobility: 5, safety: '3', medical: 0, caregiver: 6, longevity: 2.5, made_up: 4 }), { mobility: 5, safety: 3 });
  assert.deepEqual(cleanScores({ mission: 4, financial: 5 }), { financial: 5 });
  assert.deepEqual(cleanScores({ mission: 4, financial: 5 }, 1), { mission: 4 });
});

let DB;
beforeEach(async () => {
  DB = await createD1();
  await ensureApplicantSchema(DB);
  await ensureScoreSchema(DB);
  await ensureCompanyCamSchema(DB);
  const add = (id, name, year, status = 'Approved') => DB.prepare('INSERT INTO applicants (account_id, name, status, year, synced_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, status, year, '2026-10-01T00:00:00Z').run();
  await add('acct0001', 'Jamie Example', '2026');
  await add('acct0002', 'Ari & Bo Sample', '2026');
  await add('acct0003', 'Zoë Test-Family', '2026');
  await add('acct0004', 'Jamie Example', '2027'); // a different season
  await add('acct0006', 'Rory Example', '2027');
  await add('acct0007', 'Sky Example', '2027', 'In Review');
  await add('acct0008', 'TEST Family', '2027');
});

const photo = (id, account, origin) => DB.prepare(`INSERT INTO companycam_files (cc_id, kind, project_id, account_id, origin, state, created_at, updated_at)
  VALUES (?, 'photo', 'proj1', ?, ?, 'copied', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).bind(id, account, origin).run();

test('each person scores on their own card, saved as they go; it counts once all 10 are in', async () => {
  const a = await saveScorecard(DB, 'acct0004', { evaluator: 'Linzi@SOARDcharity.com', name: 'Linzi', scores: { mobility: 4, safety: 3 } });
  assert.equal(a.card.evaluator, 'linzi@soardcharity.com');
  assert.equal(a.card.done, 2);
  assert.equal(a.card.complete, false);
  assert.equal(a.finished, false);
  assert.equal(a.summary.total, null);
  assert.deepEqual(a.summary.started, ['linzi@soardcharity.com']);
  // The rest, and a note; then changing one after it's finished isn't "finished" again
  const rest = Object.fromEntries(CRITERION_KEYS.slice(2).map(k => [k, 4]));
  const b = await saveScorecard(DB, 'acct0004', { evaluator: 'linzi@soardcharity.com', scores: rest, notes: 'Home visit went well' });
  assert.equal(b.finished, true);
  assert.equal(b.card.total, 39);
  assert.equal(b.card.notes, 'Home visit went well');
  assert.equal(b.card.name, 'Linzi');
  assert.ok(b.card.completedAt);
  assert.equal(b.summary.total, 39);
  assert.equal(b.summary.tier, 'strong');
  assert.deepEqual(b.summary.by, ['linzi@soardcharity.com']);
  assert.equal(b.card.rubric, 2);
  const c = await saveScorecard(DB, 'acct0004', { evaluator: 'linzi@soardcharity.com', scores: { mobility: 5 } });
  assert.equal(c.finished, false);
  assert.equal(c.card.total, 40);
  assert.equal(c.card.notes, 'Home visit went well', 'notes left out of a save stay as they were');
  // A second evaluator: the family's score is the average of the two totals
  await saveScorecard(DB, 'acct0004', { evaluator: 'clareece@soardcharity.com', scores: all(2) });
  const fam = await familyScores(DB, 'acct0004');
  assert.equal(fam.cards.length, 2);
  assert.equal(fam.rubric, 2);
  // 40 and 20 (the spreadsheet's way said 31)
  assert.equal(fam.summary.total, 30);
  assert.equal(fam.summary.count, 2);
  // Clearing a criterion takes it back out of the count
  const d = await saveScorecard(DB, 'acct0004', { evaluator: 'clareece@soardcharity.com', scores: { financial: null } });
  assert.equal(d.card.complete, false);
  assert.equal(d.card.completedAt, null);
  assert.equal(d.summary.count, 1);
  assert.equal(d.summary.total, 40);
});

test('a score outside 1 to 5, or no signed-in person, is refused', async () => {
  await assert.rejects(saveScorecard(DB, 'acct0001', { evaluator: 'linzi@soardcharity.com', scores: { mobility: 6 } }), { status: 422 });
  await assert.rejects(saveScorecard(DB, 'acct0001', { evaluator: 'admin', scores: { mobility: 3 } }), { status: 403 });
  await assert.rejects(saveScorecard(DB, 'acct0001', { evaluator: 'unknown', scores: { mobility: 3 } }), { status: 403 });
  assert.equal((await familyScores(DB, 'acct0001')).cards.length, 0);
});

test('starting over removes only your own card', async () => {
  const all5 = all(5, SHEET_KEYS);
  await saveScorecard(DB, 'acct0001', { evaluator: 'linzi@soardcharity.com', scores: all5 });
  await saveScorecard(DB, 'acct0001', { evaluator: 'clareece@soardcharity.com', scores: all5 });
  const out = await clearScorecard(DB, 'acct0001', { evaluator: 'linzi@soardcharity.com' });
  assert.deepEqual(out.summary.by, ['clareece@soardcharity.com']);
  const sums = await scoreSummaries(DB);
  assert.equal(sums.get('acct0001').total, 50);
  assert.equal(sums.has('acct0002'), false);
});

test('a season’s capacity: set, changed, cleared; never zero or a fraction', async () => {
  assert.deepEqual(await capacities(DB), {});
  await setCapacity(DB, '2026', 12, { user: 'peter@soardcharity.com' });
  await setCapacity(DB, 2027, '10');
  const c = await capacities(DB);
  assert.equal(c['2026'].count, 12);
  assert.equal(c['2026'].updatedBy, 'peter@soardcharity.com');
  assert.equal(c['2027'].count, 10);
  await assert.rejects(setCapacity(DB, '2026', 0), { status: 422 });
  await assert.rejects(setCapacity(DB, '2026', 2.5), { status: 422 });
  await assert.rejects(setCapacity(DB, 'soon', 4), { status: 400 });
  await setCapacity(DB, '2027', null);
  assert.deepEqual(Object.keys(await capacities(DB)), ['2026']);
});

test('an evaluator’s spreadsheet tab comes over by name, onto that season’s families', async () => {
  const row = (child, list, notes) => ({ child, notes, scores: Object.fromEntries(SHEET_KEYS.map((k, i) => [k, typeof list[i] === 'number' ? `${list[i]} – Whatever` : list[i]])) });
  const rows = [
    row('Jamie Example', SHEET[0].cards[0], 'Strong case'),
    row('Ari and Bo Sample', SHEET[0].cards[1]),          // "&" in JobTread, "and" in the sheet
    row('zoe test family', SHEET[0].cards[2]),            // case, accents and the hyphen don't matter
    row('Someone Else', SHEET[0].cards[2]),
  ];
  const dry = await importScores(DB, { year: '2026', evaluator: 'clareece@soardcharity.com', name: 'Clareece', rows, dryRun: true });
  assert.deepEqual(dry.matched.map(m => m.id), ['acct0001', 'acct0002', 'acct0003']);
  assert.deepEqual(dry.unmatched, ['Someone Else']);
  assert.equal(dry.written, 0);
  assert.equal((await scoreSummaries(DB)).size, 0, 'a dry run writes nothing');
  const out = await importScores(DB, { year: '2026', evaluator: 'clareece@soardcharity.com', name: 'Clareece', rows });
  assert.equal(out.written, 3);
  assert.deepEqual(out.matched.map(m => m.total), [49, 50, 41]);
  const fam = await familyScores(DB, 'acct0001');
  assert.equal(fam.cards[0].source, 'sheet');
  assert.equal(fam.cards[0].notes, 'Strong case');
  assert.equal(fam.cards[0].total, 49);
  assert.equal(fam.cards[0].rubric, 1);
  assert.equal(fam.summary.total, 49);
  // The 2027 Jamie wasn't touched
  assert.equal((await familyScores(DB, 'acct0004')).cards.length, 0);
});

test('bringing a tab over again updates its cards, but never one the evaluator scored on the site', async () => {
  await importScores(DB, { year: '2026', evaluator: 'linzi@soardcharity.com', rows: [{ child: 'Jamie Example', scores: all(3, SHEET_KEYS) }] });
  // A 2026 family scored on the site uses the spreadsheet's rubric too
  const site = await saveScorecard(DB, 'acct0002', { evaluator: 'linzi@soardcharity.com', scores: all(4, SHEET_KEYS) });
  assert.equal(site.card.rubric, 1);
  assert.equal(site.card.complete, true);
  const again = await importScores(DB, { year: '2026', evaluator: 'linzi@soardcharity.com', rows: [{ child: 'Jamie Example', scores: all(2, SHEET_KEYS) }, { child: 'Ari & Bo Sample', scores: all(1, SHEET_KEYS) }] });
  assert.deepEqual(again.kept, ['Ari & Bo Sample']);
  const sums = await scoreSummaries(DB);
  assert.equal(sums.get('acct0001').total, 20);
  assert.equal(sums.get('acct0002').total, 40);
});

test('names that differ between the sheet and JobTread can be matched by account; two families with one name are never guessed', async () => {
  await DB.prepare('INSERT INTO applicants (account_id, name, status, year, synced_at) VALUES (?, ?, ?, ?, ?)').bind('acct0005', 'Jamie Example', 'Applied', '2026', '2026-10-01T00:00:00Z').run();
  const fours = all(4, SHEET_KEYS);
  const out = await importScores(DB, { year: '2026', evaluator: 'linzi@soardcharity.com', rows: [{ child: 'Jamie Example', scores: fours }, { child: 'J. Example', id: 'acct0005', scores: fours }] });
  assert.deepEqual(out.unmatched, ['Jamie Example']);
  assert.deepEqual(out.matched.map(m => m.id), ['acct0005']);
  await assert.rejects(importScores(DB, { year: '2026', evaluator: 'nobody', rows: [{ child: 'x' }] }), { status: 400 });
});

test('a family is ranked once everyone scoring its season has finished a card for it', async () => {
  const linzi = 'linzi@soardcharity.com';
  const clareece = 'clareece@soardcharity.com';
  await saveScorecard(DB, 'acct0004', { evaluator: linzi, scores: all(5) });
  let s = (await scoreSummaries(DB)).get('acct0004');
  assert.equal(s.ranked, true, 'one person scoring the season so far');
  assert.equal(s.of, 1);
  // Clareece scores another 2027 family: now she's scoring 2027 too, and Jamie waits for her
  await saveScorecard(DB, 'acct0006', { evaluator: clareece, scores: all(3) });
  let sums = await scoreSummaries(DB);
  s = sums.get('acct0004');
  assert.equal(s.ranked, false);
  assert.equal(s.total, 50, 'the score so far is still there, for the family’s own tab');
  assert.deepEqual([s.count, s.of, s.waiting], [1, 2, [clareece]]);
  assert.deepEqual(sums.get('acct0006').waiting, [linzi]);
  // The drawer says the same
  assert.deepEqual((await familyScores(DB, 'acct0004')).summary.waiting, [clareece]);
  // A card partway done doesn't make someone a scorer of the season
  await saveScorecard(DB, 'acct0006', { evaluator: 'christian@soardcharity.com', scores: { mobility: 2 } });
  assert.equal((await scoreSummaries(DB)).get('acct0004').of, 2);
  // Clareece finishes Jamie: ranked, and the save says so
  const done = await saveScorecard(DB, 'acct0004', { evaluator: clareece, scores: all(4) });
  assert.equal(done.summary.ranked, true);
  assert.equal(done.summary.total, 45);
  // Another season's scorers don't hold 2027 up, and a TEST family neither waits nor holds anyone up
  await saveScorecard(DB, 'acct0001', { evaluator: 'christian@soardcharity.com', scores: all(3, SHEET_KEYS) });
  await saveScorecard(DB, 'acct0008', { evaluator: 'peter@soardcharity.com', scores: all(4) });
  sums = await scoreSummaries(DB);
  assert.equal(sums.get('acct0004').ranked, true);
  assert.equal(sums.get('acct0008').ranked, true);
  assert.equal(sums.get('acct0001').ranked, true);
  assert.equal(sums.get('acct0004').of, 2);
});

test('from 2027, Family readiness waits for the home visit: photos taken in CompanyCam, or a decision', async () => {
  const linzi = 'linzi@soardcharity.com';
  const rest = Object.fromEntries(CRITERION_KEYS.filter(k => k !== 'readiness').map(k => [k, 4]));
  const a = await saveScorecard(DB, 'acct0007', { evaluator: linzi, scores: rest });
  assert.equal(a.card.done, 9);
  assert.equal((await familyScores(DB, 'acct0007')).visited, false);
  await assert.rejects(saveScorecard(DB, 'acct0007', { evaluator: linzi, scores: { readiness: 4 } }), { status: 409, message: /after the home visit/ });
  // The family's application photos copied into CompanyCam aren't a visit
  await photo('photo:1', 'acct0007', 'application');
  assert.equal((await familyScores(DB, 'acct0007')).visited, false);
  // A photo taken at the house is
  await photo('photo:2', 'acct0007', 'companycam');
  assert.equal((await familyScores(DB, 'acct0007')).visited, true);
  const b = await saveScorecard(DB, 'acct0007', { evaluator: linzi, scores: { readiness: 5 } });
  assert.equal(b.finished, true);
  assert.equal(b.card.total, 41);
  // Approved or Denied counts as visited; the 2026 rubric never waits
  assert.equal((await familyScores(DB, 'acct0006')).visited, true);
  await DB.prepare("UPDATE applicants SET status = 'In Review' WHERE account_id = 'acct0002'").run();
  const old = await saveScorecard(DB, 'acct0002', { evaluator: linzi, scores: { readiness: 2 } });
  assert.equal(old.card.scores.readiness, 2);
});
