/**
 * Scanned scoresheets (functions/api/_score-scans.js): what two readers agree
 * on, who a sheet is about and who scored it, what saves on its own and what
 * waits for a person, and undoing an upload. The readers are fakes here; the
 * real ones are Workers AI models.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { keysOf } from '../public/admin/scoring-shared.js';
import {
  cleanSheets, mergeReads, matchFamily, matchScorer, familyNames, familyCode, ALL_CRITERIA, READ_SCHEMA,
  startScan, readPage, confirmItem, skipItem, unskipItem, unsaveItem, undoScan, seasonScans, ensureScanSchema, applyHeld,
} from '../functions/api/_score-scans.js';
import { saveScorecard, scorecardsFor, importScores } from '../functions/api/_applicant-scores.js';
import { ensureApplicantSchema } from '../functions/api/_applicants.js';
import { ensureCompanyCamSchema } from '../functions/api/_companycam-sync.js';

const V1 = keysOf(1);
const V2 = keysOf(2);
const scores = (list, keys = V1) => Object.fromEntries(keys.map((k, i) => [k, list[i]]));
const sheet = (family, list, { scorer = '', code = '', total = 0, keys = V1 } = {}) => ({ family, scorer, code, total, scores: scores(list, keys) });
const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

let DB; let env; let files;
beforeEach(async () => {
  DB = await createD1();
  await ensureApplicantSchema(DB);
  await ensureCompanyCamSchema(DB);
  await ensureScanSchema(DB);
  const add = (id, name, year, status = 'Approved', job = null) => DB.prepare('INSERT INTO applicants (account_id, name, status, year, job_name, synced_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, name, status, year, job, '2026-10-01T00:00:00Z').run();
  await add('acct0001', 'Avery Thompson', '2026');
  await add('acct0002', 'Mateo Ruiz', '2026', 'Approved', 'Mateo "Teo" Ruiz (2026)');
  await add('acct0003', 'Rowan Burns', '2026', 'Denied');
  await add('acct0004', 'Mateo Lin', '2026');
  await add('acct0005', 'Harper Lin', '2027', 'In Review');
  await add('acct0006', 'Jonah Brooks', '2027', 'Approved');
  await DB.prepare('CREATE TABLE IF NOT EXISTS staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)').run();
  await DB.prepare('INSERT INTO staff_state (key, data, updated_at) VALUES (?, ?, ?)').bind('directory', JSON.stringify({ accounts: [
    { email: 'linzi@soardcharity.com', name: 'Linzi Lawsky', active: true },
    { email: 'cnielsen@soardcharity.com', name: 'Christian Nielsen', active: true },
    { email: 'ccunningham@soardcharity.com', name: 'Clareece Cunningham', active: true },
    { email: 'chris@soardcharity.com', name: 'Chris Parker', active: true },
    { email: 'gone@soardcharity.com', name: 'Linzi Gone', active: false },
  ] }), '2026-11-01T00:00:00Z').run();
  files = new Map();
  env = { DB, VENDOR_FILES: { put: async (k, v) => { files.set(k, v); }, get: async (k) => (files.has(k) ? { body: files.get(k), httpMetadata: { contentType: 'image/jpeg' } } : null), delete: async (keys) => { for (const k of [].concat(keys)) files.delete(k); } } };
});

/** Two fake readers that see what they're told to */
const readers = (a, b) => ({ one: async () => a, two: async () => b });
const start = async (over = {}) => (await startScan(DB, { year: '2026', name: 'scores.pdf', hash: 'a'.repeat(64), pages: 3, ...over }, { user: 'linzi@soardcharity.com' })).scan;

test('the reading prompt asks for every criterion of both rubrics, and JSON mode requires every field it reads', () => {
  assert.deepEqual(ALL_CRITERIA.map((c) => c.key), [...V1, 'financial']);
  const item = READ_SCHEMA.properties.sheets.items;
  assert.deepEqual(item.required.sort(), ['code', 'family', 'notes', 'scorer', 'scores', 'total']);
  assert.deepEqual(READ_SCHEMA.required, ['labels', 'sheets']);
  assert.deepEqual(item.properties.scores.required, [...V1, 'financial']);
});

test('a reader’s sheets are trusted for nothing: 0, 6 and 3.5 are no score, a silly total is none', () => {
  const [s] = cleanSheets([{ family: ' Avery ', scorer: 'Linzi', code: 's26-abcde', total: 400, scores: { mobility: 0, safety: 6, medical: 3.5, caregiver: '4', longevity: 5 } }]);
  assert.equal(s.family, 'Avery');
  assert.equal(s.code, 'S26-ABCDE');
  assert.equal(s.total, null);
  assert.deepEqual([s.scores.mobility, s.scores.safety, s.scores.medical, s.scores.caregiver, s.scores.longevity], [null, null, null, 4, 5]);
  assert.equal(cleanSheets([{ family: '', scorer: '', code: '', total: 0, scores: {} }]).length, 0, 'an empty row is no sheet');
});

test('two readers: what they agree on stands, what they don’t is left for a person, a sheet one missed is alone', () => {
  const a = [sheet('Avery Thompson', [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]), sheet('Mateo Ruiz', [3, 3, 3, 3, 3, 3, 3, 3, 3, 3])];
  const b = [sheet('Mateo Ruiz', [3, 3, 3, 3, 3, 3, 3, 3, 3, 2]), sheet('Avery Thompson', [4, 4, 4, 4, 4, 4, 4, 4, 4, 4])];
  const m = mergeReads({ one: a, two: b });
  assert.equal(m.length, 2);
  assert.deepEqual(Object.values(m[0].scores).slice(0, 10), Array(10).fill(4), 'paired by name, not by order');
  assert.equal(m[0].disagree.length, 0);
  assert.equal(m[1].scores.mission, null);
  assert.deepEqual(m[1].disagree.map((d) => [d.key, d.values.one, d.values.two]), [['mission', 3, 2]]);
  assert.equal(m[0].alone, false);
  const lone = mergeReads({ one: a, two: null });
  assert.ok(lone.every((s) => s.alone), 'one reader not answering means nothing is agreed');
  const extra = mergeReads({ one: [a[0]], two: [b[1], sheet('Harper Lin', [5, 5, 5, 5, 5, 5, 5, 5, 5, 5])] });
  assert.equal(extra.length, 2);
  assert.equal(extra.find((s) => s.family === 'Harper Lin').alone, true);
});

test('who a sheet is about: full name, a nickname from the job, a unique first name, the printed code; a letter off only suggests, and never a guess between two', async () => {
  const fams = [
    { id: 'acct0001', name: 'Avery Thompson', jobName: '' },
    { id: 'acct0002', name: 'Mateo Ruiz', jobName: 'Mateo "Teo" Ruiz (2026)' },
    { id: 'acct0003', name: 'Rowan Burns', jobName: '' },
    { id: 'acct0004', name: 'Mateo Lin', jobName: '' },
  ];
  assert.deepEqual(familyNames(fams[1]), ['Mateo Ruiz', 'Teo Ruiz', 'Mateo "Teo" Ruiz']);
  const id = (w, code = '') => matchFamily({ family: w, code }, fams, '2026').family?.id || null;
  assert.equal(id('Avery Thompson'), 'acct0001');
  assert.equal(id('thompson, avery'), 'acct0001');
  assert.equal(id('Teo Ruiz'), 'acct0002');
  assert.equal(id('Avery'), 'acct0001');
  assert.equal(id('Rowen Burns'), null, 'one letter off only suggests (Mia is not Mya)');
  assert.equal(matchFamily({ family: 'Rowen Burns' }, fams, '2026').candidates[0].id, 'acct0003');
  assert.equal(id('Mateo'), null, 'two Mateos: ask');
  assert.equal(id('Ruiz'), null, 'a last name alone isn’t enough');
  assert.equal(id('Somebody Else'), null);
  assert.equal(id('', familyCode('2026', 'acct0004')), 'acct0004');
  assert.deepEqual(matchFamily({ family: 'Mateo' }, fams, '2026').candidates.map((c) => c.id).sort(), ['acct0002', 'acct0004']);
  const codes = new Set(Array.from({ length: 400 }, (_, i) => familyCode('2027', `acct${i}`)));
  assert.equal(codes.size, 400, 'codes don’t collide across a season’s worth of families');
  assert.match(familyCode('2027', 'x'), /^S27-[2-9A-HJ-NP-Z]{5}$/);
});

test('who scored it: by name among SOARD’s Google accounts, only when one person fits', () => {
  const people = [
    { email: 'linzi@soardcharity.com', name: 'Linzi Lawsky' }, { email: 'cnielsen@soardcharity.com', name: 'Christian Nielsen' },
    { email: 'ccunningham@soardcharity.com', name: 'Clareece Cunningham' }, { email: 'chris@soardcharity.com', name: 'Chris Parker' },
  ];
  const who = (w) => matchScorer(w, people)?.email || null;
  assert.equal(who('Linzi'), 'linzi@soardcharity.com');
  assert.equal(who('linzi lawsky'), 'linzi@soardcharity.com');
  assert.equal(who('Christian N.'), 'cnielsen@soardcharity.com');
  assert.equal(who('C. Cunningham'), 'ccunningham@soardcharity.com');
  assert.equal(who('Clareece'), 'ccunningham@soardcharity.com');
  assert.equal(who('Chris'), null, 'Chris Parker, or Christian for short: a person decides');
  assert.equal(who('Chris Parker'), 'chris@soardcharity.com');
  assert.equal(who('C.'), null);
  assert.equal(who(''), null);
  assert.equal(matchScorer('Pat', [...people, { email: 'pat@x.org', name: 'Pat One' }, { email: 'pat2@x.org', name: 'Pat Two' }]), null, 'two Pats: ask');
});

test('a sheet both readers agree on, for a family and scorer that match, saves as that scorer’s card', async () => {
  const scan = await start();
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi', total: 43 })];
  const out = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'linzi@soardcharity.com', readers: readers(s, s) });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].status, 'saved');
  assert.equal(out.items[0].evaluator, 'linzi@soardcharity.com');
  const [card] = await scorecardsFor(DB, 'acct0001');
  assert.equal(card.source, 'scan');
  assert.equal(card.ref, `${scan.id}:1:0`);
  assert.equal(card.total, 43);
  assert.equal(out.summaries.acct0001.total, 43);
  assert.ok(files.has(`scoresheets/2026/${scan.id}/1.jpg`), 'the page picture is kept, privately');
  // The same page again (a retry) changes nothing
  const again = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([], []) });
  assert.equal(again.items[0].status, 'saved');
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 1);
});

test('what waits for a person: a disagreement, a total that doesn’t add up, an unknown scorer, two Mateos, one reader silent', async () => {
  const scan = await start();
  const base = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  const page = async (n, a, b) => (await readPage(env, { scan: scan.id, page: n, image: IMAGE }, { user: 'x', readers: readers(a, b) })).items[0];
  let it = await page(1, [sheet('Avery Thompson', base, { scorer: 'Linzi' })], [sheet('Avery Thompson', [...base.slice(0, 9), 3], { scorer: 'Linzi' })]);
  assert.equal(it.status, 'check');
  assert.ok(it.problems.includes('disagree'));
  assert.deepEqual(it.disagree.map((d) => d.key), ['mission']);
  it = await page(2, [sheet('Avery Thompson', base, { scorer: 'Linzi', total: 44 })], [sheet('Avery Thompson', base, { scorer: 'Linzi', total: 44 })]);
  assert.deepEqual(it.problems, ['total'], '43 written as 44');
  it = await page(3, [sheet('Avery Thompson', base, { scorer: 'Sam' })], [sheet('Avery Thompson', base, { scorer: 'Sam' })]);
  assert.deepEqual(it.problems, ['scorer']);
  const scan2 = await start({ hash: 'b'.repeat(64) });
  const two = await readPage(env, { scan: scan2.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Mateo', base, { scorer: 'Linzi' })], [sheet('Mateo', base, { scorer: 'Linzi' })]) });
  assert.deepEqual(two.items[0].problems, ['family']);
  assert.equal(two.items[0].candidates.length, 2);
  const lone = await readPage(env, { scan: scan2.id, page: 2, image: IMAGE }, { user: 'x', readers: readers([sheet('Avery Thompson', base, { scorer: 'Linzi' })], null) });
  assert.deepEqual(lone.items[0].problems, ['alone']);
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0, 'nothing that waits is saved');
});

test('a card the scorer filled in on the site is theirs: a scan that differs never replaces it unless a person says so, and one that matches changes nothing', async () => {
  await saveScorecard(DB, 'acct0001', { evaluator: 'linzi@soardcharity.com', scores: scores([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]) });
  const scan = await start();
  const s = [sheet('Avery Thompson', [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], { scorer: 'Linzi' })];
  const out = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  assert.deepEqual(out.items[0].problems, ['has-card']);
  assert.equal(out.items[0].theirs.total, 30);
  assert.equal((await scorecardsFor(DB, 'acct0001'))[0].total, 30);
  await assert.rejects(confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0001', evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(5)) }, { user: 'x' }), /already have scores/);
  const ok = await confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0001', evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(5)), override: true }, { user: 'x' });
  assert.equal(ok.item.status, 'saved');
  assert.equal(ok.summary.total, 50);
  // Undo puts the site card back
  const u = await undoScan(env, scan.id, { user: 'x' });
  assert.equal(u.restored, 1);
  const [back] = await scorecardsFor(DB, 'acct0001');
  assert.equal(back.source, 'site');
  assert.equal(back.total, 30);
});

test('confirming a waiting sheet needs the whole rubric, a season family and a scorer; skipping leaves it out', async () => {
  const scan = await start();
  const base = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Mateo', base)], [sheet('Mateo', base)]) });
  const ask = (o) => confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0004', evaluator: 'cnielsen@soardcharity.com', scores: scores(base), ...o }, { user: 'x' });
  await assert.rejects(ask({ account: 'acct0005' }), /2026 families/, 'a 2027 family');
  await assert.rejects(ask({ evaluator: 'nobody' }), /who scored/);
  await assert.rejects(ask({ scores: { ...scores(base), mission: null } }), /Mission & story/);
  const ok = await ask({});
  assert.equal(ok.item.status, 'saved');
  assert.equal(ok.item.evaluatorName, 'Christian Nielsen');
  assert.equal((await scorecardsFor(DB, 'acct0004'))[0].total, 43);
  await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers([sheet('Mateo', base)], [sheet('Mateo', base)]) });
  await skipItem(env, { scan: scan.id, page: 2, idx: 0 }, { user: 'x' });
  await assert.rejects(skipItem(env, { scan: scan.id, page: 2, idx: 0 }, { user: 'x' }), /isn’t waiting/);
  const season = await seasonScans(DB, '2026');
  assert.equal(season.waiting.length, 0);
  assert.deepEqual(season.scans[0].counts, { saved: 1, same: 0, check: 0, skipped: 1, empty: 0 });
  assert.ok(season.scorers.some((p) => p.email === 'cnielsen@soardcharity.com'));
  assert.ok(!season.scorers.some((p) => p.email === 'gone@soardcharity.com'), 'a suspended account doesn’t score');
  assert.equal(season.families.find((f) => f.id === 'acct0001').code, familyCode('2026', 'acct0001'));
});

test('2027: readiness waits for the home visit, and a 2026-style sheet (Mission & story) waits to be put on the 2027 rubric', async () => {
  const scan = (await startScan(DB, { year: '2027', name: 'x.pdf', pages: 4 }, { user: 'cnielsen@soardcharity.com' })).scan;
  const v2 = [4, 4, 4, 4, 4, 4, 4, 4, 5, 3];
  const s = [sheet('Harper Lin', v2, { scorer: 'Christian N.', keys: V2 })];
  const out = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  assert.equal(out.items[0].status, 'saved');
  const [card] = await scorecardsFor(DB, 'acct0005');
  assert.equal(card.scores.readiness, undefined, 'In Review, no visit yet: readiness held back');
  assert.equal(card.complete, false);
  assert.deepEqual(out.items[0].held, { readiness: 5 });
  assert.equal(await applyHeld(DB), 0, 'still no visit');
  await DB.prepare("UPDATE applicants SET status = 'Approved' WHERE account_id = 'acct0005'").run();
  assert.equal(await applyHeld(DB), 1, 'the visit happened: onto the card');
  const [full] = await scorecardsFor(DB, 'acct0005');
  assert.equal(full.scores.readiness, 5);
  assert.equal(full.complete, true);
  assert.equal(full.total, 40);
  assert.equal(await applyHeld(DB), 0, 'only once');
  const old = [sheet('Jonah Brooks', [4, 4, 4, 4, 4, 4, 4, 4, 4, 4], { scorer: 'Linzi' })];
  const it = (await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers(old, old) })).items[0];
  assert.ok(it.problems.includes('rubric'));
  assert.ok(it.problems.includes('unread'), 'no Financial need on it');
});

test('a page with no scoresheet is empty; a page no reader could read waits, and can be read again', async () => {
  const scan = await start();
  const empty = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([], []) });
  assert.equal(empty.items[0].status, 'empty');
  const failed = await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers(null, null) });
  assert.equal(failed.items[0].status, 'failed');
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  const second = await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  assert.equal(second.items[0].status, 'saved');
  await assert.rejects(readPage(env, { scan: scan.id, page: 9, image: IMAGE }, { user: 'x', readers: readers(s, s) }), /Which page/);
  await assert.rejects(readPage(env, { scan: scan.id, page: 3, image: 'data:text/html;base64,PGI+' }, { user: 'x', readers: readers(s, s) }), /picture/);
});

test('the same file twice is caught, the same scorer twice in one upload waits, and undo leaves a card changed since alone', async () => {
  const scan = await start({ pages: 4 });
  const dup = await startScan(DB, { year: '2026', name: 'again.pdf', hash: 'a'.repeat(64), pages: 1 }, { user: 'x' });
  assert.equal(dup.duplicate.id, scan.id);
  assert.ok((await startScan(DB, { year: '2026', name: 'again.pdf', hash: 'a'.repeat(64), pages: 1, again: true }, { user: 'x' })).scan);
  const s = (fam) => [sheet(fam, [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s('Avery Thompson'), s('Avery Thompson')) });
  const copy = await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers(s('Avery Thompson'), s('Avery Thompson')) });
  assert.equal(copy.items[0].status, 'same', 'a second copy of the same sheet changes nothing');
  const other = [sheet('Avery Thompson', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], { scorer: 'Linzi' })];
  const twice = await readPage(env, { scan: scan.id, page: 4, image: IMAGE }, { user: 'x', readers: readers(other, other) });
  assert.deepEqual(twice.items[0].problems, ['twice'], 'two different sheets from Linzi for Avery in one upload');
  await readPage(env, { scan: scan.id, page: 3, image: IMAGE }, { user: 'x', readers: readers(s('Teo Ruiz'), s('Teo Ruiz')) });
  // Linzi changes Mateo's card on the site after the scan
  await saveScorecard(DB, 'acct0002', { evaluator: 'linzi@soardcharity.com', scores: { mission: 1 } });
  const u = await undoScan(env, scan.id, { user: 'x' });
  assert.deepEqual([u.restored, u.changed], [1, 1]);
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0, 'Avery’s scanned card is gone');
  assert.equal((await scorecardsFor(DB, 'acct0002'))[0].scores.mission, 1, 'Mateo’s, changed since, stays');
  await assert.rejects(readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([], []) }), /undone/);
  assert.ok((await startScan(DB, { year: '2026', name: 'again.pdf', hash: 'a'.repeat(64), pages: 1 }, { user: 'x' })).duplicate, 'the again-copy is still there');
});

test('a card brought over from the spreadsheet: a scan that says the same changes nothing, one that differs waits', async () => {
  await importScores(DB, { year: '2026', evaluator: 'linzi@soardcharity.com', rows: [{ child: 'Avery Thompson', scores: scores([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]) }] });
  const scan = await start();
  const same = [sheet('Avery Thompson', [3, 3, 3, 3, 3, 3, 3, 3, 3, 3], { scorer: 'Linzi' })];
  const one = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(same, same) });
  assert.equal(one.items[0].status, 'same');
  assert.equal((await scorecardsFor(DB, 'acct0001'))[0].source, 'sheet');
  const differs = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  const two = await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers(differs, differs) });
  assert.deepEqual(two.items[0].problems, ['has-card']);
  assert.equal((await scorecardsFor(DB, 'acct0001'))[0].total, 30, 'the checked spreadsheet card stays');
  await confirmItem(env, { scan: scan.id, page: 2, idx: 0, account: 'acct0001', evaluator: 'linzi@soardcharity.com', scores: two.items[0].scores, override: true }, { user: 'x' });
  assert.equal((await scorecardsFor(DB, 'acct0001'))[0].total, 43);
  await undoScan(env, scan.id, { user: 'x' });
  const [back] = await scorecardsFor(DB, 'acct0001');
  assert.equal(back.source, 'sheet');
  assert.equal(back.total, 30);
});

test('a scorer who has never scored, named on a sheet someone else uploaded, waits once to be confirmed', async () => {
  const scan = await start({ hash: 'c'.repeat(64) });
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Chris Parker' })];
  const it = (await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0];
  assert.deepEqual(it.problems, ['new-scorer']);
  assert.equal(it.evaluator, 'chris@soardcharity.com', 'the match is offered');
});

test('a saved sheet can be taken back off on its own; it waits again and the card goes back', async () => {
  const scan = await start();
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  const off = await unsaveItem(env, { scan: scan.id, page: 1, idx: 0 }, { user: 'x' });
  assert.equal(off.restored, true);
  assert.equal(off.item.status, 'check');
  assert.deepEqual(off.item.problems, ['taken-off']);
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0);
  await assert.rejects(unsaveItem(env, { scan: scan.id, page: 1, idx: 0 }, { user: 'x' }), /isn’t saved/);
});

test('2027: a sheet whose printed criteria are 2026’s (Mission & story) never saves as Financial need', async () => {
  const scan = (await startScan(DB, { year: '2027', name: 'y.pdf', pages: 1 }, { user: 'linzi@soardcharity.com' })).scan;
  const labels = ['Mobility', 'Safety', 'Medical', 'Caregiver', 'Longevity', 'Severity', 'Feasibility', 'Structure', 'Readiness', 'Mission & story'];
  const s = { sheets: [sheet('Jonah Brooks', [4, 4, 4, 4, 4, 4, 4, 4, 4, 3], { scorer: 'Linzi', keys: V2 })], labels };
  const it = (await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0];
  assert.ok(it.problems.includes('rubric'), 'both readers filed Mission & story under Financial need by its place');
  assert.equal((await scorecardsFor(DB, 'acct0006')).length, 0);
});

test('an upload that stopped partway picks up where it left off', async () => {
  const scan = await start();
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  const dup = await startScan(DB, { year: '2026', name: 'scores.pdf', hash: 'a'.repeat(64), pages: 3 }, { user: 'x' });
  assert.deepEqual([dup.duplicate.read, dup.duplicate.pages], [1, 3]);
  const again = await startScan(DB, { resume: dup.duplicate.id }, { user: 'x' });
  assert.deepEqual(again.scan.done, [1]);
});

test('uploads for one family or one scorer: the sheet’s own words win, a clash waits', async () => {
  const base = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  const forFamily = (await startScan(DB, { year: '2026', name: 'p.jpg', pages: 2, account: 'acct0004' }, { user: 'linzi@soardcharity.com' })).scan;
  let it = (await readPage(env, { scan: forFamily.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('', base, { scorer: 'Linzi' })], [sheet('', base, { scorer: 'Linzi' })]) })).items[0];
  assert.equal(it.status, 'saved');
  assert.equal(it.account, 'acct0004', 'no name on it: the family it was added for');
  it = (await readPage(env, { scan: forFamily.id, page: 2, image: IMAGE }, { user: 'x', readers: readers([sheet('Avery Thompson', base, { scorer: 'Linzi' })], [sheet('Avery Thompson', base, { scorer: 'Linzi' })]) })).items[0];
  assert.deepEqual(it.problems, ['family'], 'names another family');
  const mine = (await startScan(DB, { year: '2026', name: 'm.pdf', pages: 2, scorer: 'ccunningham@soardcharity.com' }, { user: 'x' })).scan;
  it = (await readPage(env, { scan: mine.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Avery Thompson', base)], [sheet('Avery Thompson', base)]) })).items[0];
  assert.equal(it.evaluator, 'ccunningham@soardcharity.com');
  it = (await readPage(env, { scan: mine.id, page: 2, image: IMAGE }, { user: 'x', readers: readers([sheet('Teo Ruiz', base, { scorer: 'Linzi' })], [sheet('Teo Ruiz', base, { scorer: 'Linzi' })]) })).items[0];
  assert.deepEqual(it.problems, ['scorer'], 'signed by someone else');
});

// ── What the break-it pass found (Nov 4 2026) ──

test('the readers must agree on who too: a family read two ways, a scorer read two ways, a code beside another family’s name', async () => {
  const scan = await start({ pages: 3 });
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  const page = async (n, a, b) => (await readPage(env, { scan: scan.id, page: n, image: IMAGE }, { user: 'x', readers: readers(a, b) })).items[0];
  let it = await page(1, [sheet('Avery Thompson', v, { scorer: 'Linzi' })], [sheet('Avery Thomas', v, { scorer: 'Linzi' })]);
  assert.ok(it.problems.includes('family'), 'Avery Thompson or Avery Thomas: a person decides');
  it = await page(2, [sheet('Avery Thompson', v, { scorer: 'Linzi' })], [sheet('Avery Thompson', v, { scorer: 'Christian' })]);
  assert.ok(it.problems.includes('scorer'));
  const code = familyCode('2026', 'acct0004');
  it = await page(3, [sheet('Avery Thompson', v, { scorer: 'Linzi', code })], [sheet('Avery Thompson', v, { scorer: 'Linzi', code })]);
  assert.ok(it.problems.includes('family'), 'Mateo Lin’s code beside Avery’s name');
  assert.deepEqual(it.candidates.slice(0, 2).map((c) => c.id).sort(), ['acct0001', 'acct0004']);
  assert.equal((await scorecardsFor(DB, 'acct0001')).length + (await scorecardsFor(DB, 'acct0004')).length, 0);
});

test('2027: readiness left blank before the home visit doesn’t hold the sheet up, and can be confirmed blank', async () => {
  const scan = (await startScan(DB, { year: '2027', name: 'z.pdf', pages: 2 }, { user: 'linzi@soardcharity.com' })).scan;
  const blank = { ...scores([4, 4, 4, 4, 4, 4, 4, 4, 0, 3], V2), readiness: null };
  const s = [{ family: 'Harper Lin', scorer: 'Linzi', code: '', total: 0, notes: '', scores: blank }];
  const it = (await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0];
  assert.equal(it.status, 'saved', 'Harper hasn’t had her visit: blank readiness is what the sheet should say');
  assert.equal((await scorecardsFor(DB, 'acct0005'))[0].done, 9);
  const t = [{ family: 'Harper Lin', scorer: 'Linzi', code: '', total: 0, notes: '', scores: blank }];
  const other = [{ ...t[0], scores: { ...blank, mobility: 2 } }];
  const w = (await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers(t, other) })).items[0];
  assert.ok(w.problems.includes('disagree') && !w.problems.includes('unread'));
  await DB.prepare('DELETE FROM applicant_scores').run();
  const ok = await confirmItem(env, { scan: scan.id, page: 2, idx: 0, account: 'acct0005', evaluator: 'linzi@soardcharity.com', scores: { ...blank, mobility: 4 } }, { user: 'x' });
  assert.equal(ok.item.status, 'saved');
  // Jonah has had his visit (Approved): blank readiness is a score missing
  const j = [{ family: 'Jonah Brooks', scorer: 'Linzi', code: '', total: 0, notes: '', scores: blank }];
  const scan2 = (await startScan(DB, { year: '2027', name: 'j.pdf', pages: 1 }, { user: 'linzi@soardcharity.com' })).scan;
  const jt = (await readPage(env, { scan: scan2.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(j, j) })).items[0];
  assert.ok(jt.problems.includes('unread'));
});

test('undo puts back what was there before the upload, whatever order its sheets were saved in', async () => {
  const scan = await start({ pages: 2 });
  const a = [sheet('Avery Thompson', [3, 3, 3, 3, 3, 3, 3, 3, 3, 3], { scorer: 'Linzi' })];
  const b = [sheet('Avery Thompson', [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], { scorer: 'Linzi' })];
  // Page 1 waits (the readers differ); page 2 saves; page 1 is then confirmed over page 2's card
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(a, [sheet('Avery Thompson', [3, 3, 3, 3, 3, 3, 3, 3, 3, 2], { scorer: 'Linzi' })]) });
  await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers(b, b) });
  await confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0001', evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(3)), override: true }, { user: 'x' });
  const u = await undoScan(env, scan.id, { user: 'x' });
  assert.deepEqual([u.restored, u.changed], [2, 0]);
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0, 'nothing of it left');
  assert.ok(![...files.keys()].some((k) => k.includes(scan.id)), 'nor its page pictures');
});

test('undoing an older upload, then the newer one that replaced its card, never brings the older one’s scores back', async () => {
  await saveScorecard(DB, 'acct0002', { evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(2)) });
  const y1 = await start({ hash: '1'.repeat(64), pages: 1 });
  const y2 = await start({ hash: '2'.repeat(64), pages: 1 });
  const s1 = [sheet('Mateo Ruiz', Array(10).fill(4), { scorer: 'Linzi' })];
  const s2 = [sheet('Mateo Ruiz', Array(10).fill(5), { scorer: 'Linzi' })];
  await readPage(env, { scan: y1.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s1, s1) });
  await confirmItem(env, { scan: y1.id, page: 1, idx: 0, account: 'acct0002', evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(4)), override: true }, { user: 'x' });
  await readPage(env, { scan: y2.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s2, s2) });
  await confirmItem(env, { scan: y2.id, page: 1, idx: 0, account: 'acct0002', evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(5)), override: true }, { user: 'x' });
  await undoScan(env, y1.id, { user: 'x' });
  assert.equal((await scorecardsFor(DB, 'acct0002'))[0].total, 50, 'y2’s card stands');
  await undoScan(env, y2.id, { user: 'x' });
  const [back] = await scorecardsFor(DB, 'acct0002');
  assert.equal(back.source, 'site');
  assert.equal(back.total, 20, 'Linzi’s own card, not y1’s 40');
});

test('a page being read can’t be read a second time at once', async () => {
  const scan = await start();
  let release;
  const slow = new Promise((r) => { release = r; });
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  const first = readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: { one: async () => { await slow; return s; }, two: async () => s } });
  await new Promise((r) => setTimeout(r, 20));
  const second = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  assert.equal(second.busy, true);
  assert.equal((await startScan(DB, { year: '2026', name: 'scores.pdf', hash: 'a'.repeat(64), pages: 3 }, { user: 'x' })).duplicate.reading, true);
  release();
  const done = await first;
  assert.equal(done.items[0].status, 'saved');
  assert.equal((await startScan(DB, { year: '2026', name: 'scores.pdf', hash: 'a'.repeat(64), pages: 3 }, { user: 'x' })).duplicate.reading, true, 'a page read moments ago, two to go: it may still be coming');
  assert.equal((await startScan(DB, { year: '2026', name: 'scores.pdf', hash: 'a'.repeat(64), pages: 3 }, { user: 'x', now: Date.now() + 3 * 60 * 1000 })).duplicate.reading, false, 'quiet for minutes: it stopped');
});

test('a page nobody could read is read again from the picture the site kept', async () => {
  const scan = await start();
  // The fake bucket keeps bytes as given; give it the real thing back as a body
  env.VENDOR_FILES.get = async (k) => (files.has(k) ? { body: files.get(k), arrayBuffer: async () => files.get(k).buffer.slice(0), httpMetadata: { contentType: 'image/jpeg' } } : null);
  const failed = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(null, null) });
  assert.equal(failed.items[0].status, 'failed');
  let seen = null;
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  const again = await readPage(env, { scan: scan.id, page: 1, again: true }, { user: 'x', readers: { one: async (x) => { seen = x.image; return s; }, two: async () => s } });
  assert.equal(again.items[0].status, 'saved');
  assert.equal(seen, IMAGE, 'the same picture, read back from private storage');
  await assert.rejects(readPage(env, { scan: scan.id, page: 2, again: true }, { user: 'x', readers: readers(s, s) }), /isn’t kept/);
});

// ── The second break-it pass (Nov 4 2026) ──

test('an upload undone while a page is being read saves nothing from that page', async () => {
  const scan = await start();
  let release;
  const slow = new Promise((r) => { release = r; });
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  const reading = readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: { one: async () => { await slow; return s; }, two: async () => s } });
  await new Promise((r) => setTimeout(r, 20));
  await undoScan(env, scan.id, { user: 'x' });
  release();
  const out = await reading;
  assert.equal(out.items[0].status, 'skipped');
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0);
});

test('"these are all Linzi’s" never covers a sheet signed by someone else, known or not', async () => {
  const scan = (await startScan(DB, { year: '2026', name: 'l.pdf', pages: 2, scorer: 'linzi@soardcharity.com' }, { user: 'linzi@soardcharity.com' })).scan;
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  for (const [n, who] of [[1, 'Bob Smith'], [2, 'CN']]) {
    const s = [sheet('Avery Thompson', v, { scorer: who })];
    const it = (await readPage(env, { scan: scan.id, page: n, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0];
    assert.ok(it.problems.includes('scorer'), who);
  }
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0);
});

test('"the Owen family": a surname; one word that could be two families waits', async () => {
  await DB.prepare('INSERT INTO applicants (account_id, name, status, year, synced_at) VALUES (?, ?, ?, ?, ?)').bind('acct0010', 'Clara Thompson', 'Approved', '2027', 'x').run();
  await DB.prepare('INSERT INTO applicants (account_id, name, status, year, synced_at) VALUES (?, ?, ?, ?, ?)').bind('acct0011', 'Thompson Reyes', 'Approved', '2027', 'x').run();
  const fams = [{ id: 'a', name: 'Owen Lindgren' }, { id: 'b', name: 'Clara Owen' }, { id: 'c', name: 'Avery Thompson' }];
  assert.equal(matchFamily({ family: 'Owen Family' }, fams, '2027').family?.id, 'b', 'a surname');
  assert.equal(matchFamily({ family: 'The Thompson family' }, fams, '2027').family?.id, 'c');
  assert.equal(matchFamily({ family: 'Owen' }, fams, '2027').family, null, 'Owen Lindgren or Clara Owen: a person decides');
  assert.equal(matchFamily({ family: 'Avery' }, fams, '2027').family?.id, 'c');
  assert.equal(matchFamily({ family: 'Lee family' }, [{ id: 'h', name: 'Harper Lee' }, { id: 'l', name: 'Lee Chang' }], '2027').family?.id, 'h', 'the Lees are Harper’s family; Lee Chang is a Chang');
});

test('Take off on a card that has changed since is refused, and leaves the sheet saved', async () => {
  const scan = await start();
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  await saveScorecard(DB, 'acct0001', { evaluator: 'linzi@soardcharity.com', scores: { mission: 1 } });
  await assert.rejects(unsaveItem(env, { scan: scan.id, page: 1, idx: 0 }, { user: 'x' }), /changed since/);
  const season = await seasonScans(DB, '2026');
  assert.equal(season.saved.length, 1);
  assert.equal((await scorecardsFor(DB, 'acct0001'))[0].scores.mission, 1);
});

test('held readiness goes only onto the card the scan saved: not a site card it matched, not one started over', async () => {
  // Harper: Linzi's own 9-of-10 site card; her paper sheet says the same plus readiness 5
  const nineOnSite = scores([4, 4, 4, 4, 4, 4, 4, 4, 4, 3], V2);
  delete nineOnSite.readiness;
  await saveScorecard(DB, 'acct0005', { evaluator: 'linzi@soardcharity.com', scores: nineOnSite });
  const nine = { ...scores([4, 4, 4, 4, 4, 4, 4, 4, 5, 3], V2) };
  const scan = (await startScan(DB, { year: '2027', name: 'h.pdf', pages: 2 }, { user: 'linzi@soardcharity.com' })).scan;
  const s = [{ family: 'Harper Lin', scorer: 'Linzi', code: '', total: 0, notes: '', scores: nine }];
  const it = (await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0];
  assert.equal(it.status, 'same');
  await DB.prepare("UPDATE applicants SET status = 'Approved' WHERE account_id = 'acct0005'").run();
  await applyHeld(DB);
  assert.equal((await scorecardsFor(DB, 'acct0005'))[0].scores.readiness, undefined, 'her site card: she scores readiness herself');
  // Jonah: a scanned card held readiness, then Christian started over on the site
  await DB.prepare("UPDATE applicants SET status = 'In Review' WHERE account_id = 'acct0006'").run();
  const scan2 = (await startScan(DB, { year: '2027', name: 'c.pdf', pages: 1 }, { user: 'cnielsen@soardcharity.com' })).scan;
  const j = [{ family: 'Jonah Brooks', scorer: 'Christian N.', code: '', total: 0, notes: '', scores: nine }];
  assert.equal((await readPage(env, { scan: scan2.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(j, j) })).items[0].status, 'saved');
  await DB.prepare("DELETE FROM applicant_scores WHERE account_id = 'acct0006'").run();
  await saveScorecard(DB, 'acct0006', { evaluator: 'cnielsen@soardcharity.com', scores: { mobility: 2 } });
  await DB.prepare("UPDATE applicants SET status = 'Approved' WHERE account_id = 'acct0006'").run();
  await applyHeld(DB);
  assert.equal((await scorecardsFor(DB, 'acct0006'))[0].scores.readiness, undefined, 'his new card doesn’t get the old sheet’s readiness');
});

test('readings that name different families or scorers fill nothing in and offer each', async () => {
  const scan = await start();
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  const it = (await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Mateo Ruiz', v, { scorer: 'Linzi' })], [sheet('Mateo Lin', v, { scorer: 'Christian' })]) })).items[0];
  assert.equal(it.account, null);
  assert.equal(it.evaluator, null);
  assert.deepEqual(it.candidates.map((c) => c.id).sort(), ['acct0002', 'acct0004']);
  // Names too different to be the same sheet are two sheets, each read once: both wait
  const two = await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers([sheet('Avery Thompson', v, { scorer: 'Linzi' })], [sheet('Teo Ruiz', v, { scorer: 'Linzi' })]) });
  assert.deepEqual(two.items.map((x) => x.problems.includes('alone')), [true, true]);
});

test('a sheet with no scorer on it never takes another sheet’s scorer from the same page', async () => {
  const scan = await start();
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  const s = [sheet('Avery Thompson', v, { scorer: 'Linzi' }), sheet('Teo Ruiz', v)];
  const out = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  assert.equal(out.items[0].status, 'saved');
  assert.deepEqual(out.items[1].problems, ['scorer']);
  assert.equal((await scorecardsFor(DB, 'acct0002')).length, 0);
});

// ── The third break-it pass (Nov 4 2026) ──

test('undoing one copy of a file keeps the scores the other copy says too; undoing that one takes them off', async () => {
  const a = await start({ hash: 'd'.repeat(64), pages: 1 });
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  await readPage(env, { scan: a.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  const b = (await startScan(DB, { year: '2026', name: 'again.pdf', hash: 'd'.repeat(64), pages: 1, again: true }, { user: 'linzi@soardcharity.com' })).scan;
  assert.equal((await readPage(env, { scan: b.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0].status, 'same');
  await undoScan(env, a.id, { user: 'x' });
  const [kept] = await scorecardsFor(DB, 'acct0001');
  assert.equal(kept?.total, 43, 'the second copy still says 43');
  assert.equal(kept.ref, `${b.id}:1:0`);
  assert.equal((await seasonScans(DB, '2026')).saved.find((it) => it.scan === b.id).status, 'saved', 'and can be taken off or undone now');
  await undoScan(env, b.id, { user: 'x' });
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0);
});

test('every upload and waiting sheet stays reachable, however many there are', async () => {
  for (let k = 0; k < 55; k++) {
    const sc = (await startScan(DB, { year: '2026', name: `p${k}.jpg`, pages: 1 }, { user: 'linzi@soardcharity.com' })).scan;
    await readPage(env, { scan: sc.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Nobody Here', Array(10).fill(3), { scorer: 'Linzi' })], [sheet('Nobody Here', Array(10).fill(3), { scorer: 'Linzi' })]) });
  }
  const season = await seasonScans(DB, '2026');
  assert.equal(season.scans.length, 55);
  assert.equal(season.waiting.length, 55);
});

test('apostrophes in names aren’t nickname quotes', () => {
  const fams = [{ id: 'd', name: 'De’Shawn O’Neil', jobName: "De'Shawn O'Neil (2027)" }, { id: 's', name: "Shawn O'Malley", jobName: '' }, { id: 'k', name: "Ma'Kayla D'Souza", jobName: "Ma'Kayla D'Souza (2027)" }];
  assert.deepEqual(familyNames(fams[0]), ['De’Shawn O’Neil', "De'Shawn O'Neil"]);
  assert.equal(matchFamily({ family: 'Shawn O.' }, fams, '2027').family, null);
  assert.equal(matchFamily({ family: "Shawn O'Malley" }, fams, '2027').family?.id, 's');
  assert.equal(matchFamily({ family: 'Kayla' }, fams, '2027').family, null, 'no Kayla here; Ma’Kayla is MaKayla');
  assert.equal(matchFamily({ family: "Ma'Kayla" }, fams, '2027').family?.id, 'k');
});

test('only a finished card for a real family counts as having scored: not a TEST family, and a suspended account never matches', async () => {
  await DB.prepare('INSERT INTO applicants (account_id, name, status, year, synced_at) VALUES (?, ?, ?, ?, ?)').bind('acct0099', 'TEST Family', 'Applied', '2026', 'x').run();
  await saveScorecard(DB, 'acct0099', { evaluator: 'chris@soardcharity.com', scores: scores(Array(10).fill(3)) });
  const scan = await start({ hash: 'e'.repeat(64) });
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Chris Parker' })];
  assert.deepEqual((await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0].problems, ['new-scorer']);
  // Linzi Gone: suspended, with an old card
  await saveScorecard(DB, 'acct0004', { evaluator: 'gone@soardcharity.com', scores: scores(Array(10).fill(3)) });
  const g = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi Gone' })];
  const it = (await readPage(env, { scan: scan.id, page: 2, image: IMAGE }, { user: 'x', readers: readers(g, g) })).items[0];
  assert.ok(it.problems.includes('scorer'));
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0);
  await assert.rejects(startScan(DB, { year: '2026', name: 'q.pdf', pages: 1, scorer: 'typo@gmial.com' }, { user: 'x' }), /SOARD’s people/);
});

test('a scorer who signs in with an alias has one card: a scan finds the alias card, never adds a second', async () => {
  await DB.prepare('UPDATE staff_state SET data = ? WHERE key = ?').bind(JSON.stringify({ accounts: [
    { email: 'linzi@soardcharity.com', aliases: ['llawsky@soardcharity.com'], name: 'Linzi Lawsky', active: true },
  ] }), 'directory').run();
  await saveScorecard(DB, 'acct0001', { evaluator: 'llawsky@soardcharity.com', scores: scores(Array(10).fill(2)) });
  const scan = await start({ hash: 'f'.repeat(64) });
  const s = [sheet('Avery Thompson', Array(10).fill(5), { scorer: 'Linzi' })];
  const it = (await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0];
  assert.deepEqual(it.problems, ['has-card']);
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 1);
  await confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0001', evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(5)), override: true }, { user: 'x' });
  const cards = await scorecardsFor(DB, 'acct0001');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].evaluator, 'llawsky@soardcharity.com');
  assert.equal(cards[0].total, 50);
});

test('a sheet already saved can’t be confirmed again over it (two people checking at once)', async () => {
  const scan = await start();
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Mateo', v, { scorer: 'Linzi' })], [sheet('Mateo', v, { scorer: 'Linzi' })]) });
  const first = await confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0004', evaluator: 'linzi@soardcharity.com', scores: scores(v) }, { user: 'linzi@soardcharity.com' });
  assert.equal(first.item.status, 'saved');
  await assert.rejects(confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0004', evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(1)), override: true }, { user: 'x' }), /saved already by linzi/);
  assert.equal((await scorecardsFor(DB, 'acct0004'))[0].total, 43);
});

test('readiness held for families off the board keeps waiting, and held sheets past the first 200 still apply', async () => {
  const scan = (await startScan(DB, { year: '2027', name: 'r.pdf', pages: 1 }, { user: 'linzi@soardcharity.com' })).scan;
  const s = [{ family: 'Harper Lin', scorer: 'Linzi', code: '', total: 0, notes: '', scores: scores([4, 4, 4, 4, 4, 4, 4, 4, 5, 3], V2) }];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  // 205 others held for families that never had a visit, older than Harper's
  for (let k = 0; k < 205; k++) await DB.prepare("INSERT INTO score_scan_items (scan_id, page, idx, status, account_id, evaluator, dropped, created_at) VALUES (?, ?, 0, 'saved', ?, 'linzi@soardcharity.com', '{\"readiness\":3}', '2026-01-01T00:00:00Z')").bind(scan.id, 1000 + k, `ghost${k}`).run();
  await DB.prepare("UPDATE applicants SET status = 'Approved' WHERE account_id = 'acct0005'").run();
  assert.equal(await applyHeld(DB), 1);
  assert.equal((await scorecardsFor(DB, 'acct0005'))[0].scores.readiness, 5);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM score_scan_items WHERE dropped IS NOT NULL AND held_at IS NULL').first()).n, 205, 'families off the board keep waiting (they may come back)');
});

test('bad requests are refused, never a crash; an undone upload’s pictures are gone', async () => {
  const scan = await start();
  await assert.rejects(readPage(env, { scan: scan.id, page: 1, image: 'data:image/jpeg;base64,A' }, { user: 'x', readers: readers([], []) }), /picture/);
  await assert.rejects(readPage(env, { scan: scan.id, page: 1, image: 'data:image/jpeg;base64,AB=C' }, { user: 'x', readers: readers([], []) }), /picture/);
  const api = await import('../functions/api/score-scans-admin.js');
  const res = await api.onRequestPost({ env, request: new Request('https://x/api/score-scans-admin', { method: 'POST', body: 'null' }), data: { userEmail: 'linzi@soardcharity.com' } });
  assert.equal(res.status, 400);
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  assert.ok(files.has(`scoresheets/2026/${scan.id}/1.jpg`));
  await undoScan(env, scan.id, { user: 'x' });
  assert.ok(!files.has(`scoresheets/2026/${scan.id}/1.jpg`));
  const img = await api.onRequestGet({ env, request: new Request(`https://x/api/score-scans-admin?image=${scan.id}&page=1`), data: {} });
  assert.equal(img.status, 404);
});

// ── The fourth break-it pass (Nov 4 2026) ──

test('a page that fails partway leaves nothing behind, and is read whole the next time', async () => {
  const scan = await start();
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  const four = [sheet('Avery Thompson', v, { scorer: 'Linzi' }), sheet('Teo Ruiz', v, { scorer: 'Linzi' }), sheet('Mateo Lin', v, { scorer: 'Linzi' }), sheet('Rowan Burns', v, { scorer: 'Linzi' })];
  const realBatch = DB.batch.bind(DB);
  let calls = 0;
  DB.batch = async (stmts) => { if (++calls === 2) throw new Error('D1 hiccup'); return realBatch(stmts); };
  await assert.rejects(readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(four, four) }), /hiccup/);
  DB.batch = realBatch;
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0, 'the first sheet’s card was taken back');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM score_scan_items WHERE scan_id = ?').bind(scan.id).first()).n, 0);
  const again = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(four, four) });
  assert.deepEqual(again.items.map((it) => it.status), ['saved', 'saved', 'saved', 'saved']);
  // A reading cut off (its claim left behind, one card saved): taken back and read whole once the claim is old
  const scan2 = await start({ hash: '9'.repeat(64), pages: 1 });
  await DB.prepare("INSERT INTO score_scan_items (scan_id, page, idx, status, created_at) VALUES (?, 1, -1, 'reading', ?)").bind(scan2.id, '2026-01-01T00:00:00Z').run();
  const late = await readPage(env, { scan: scan2.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Avery Thompson', v, { scorer: 'Linzi' })], [sheet('Avery Thompson', v, { scorer: 'Linzi' })]) });
  assert.equal(late.items[0].status, 'same', 'read afresh (Avery’s card from the first upload says the same)');
});

test('two copies of a sheet with readiness held: taking one off keeps the card for the other', async () => {
  const s = [{ family: 'Harper Lin', scorer: 'Linzi', code: '', total: 0, notes: '', scores: scores([4, 4, 4, 4, 4, 4, 4, 4, 5, 3], V2) }];
  const a = (await startScan(DB, { year: '2027', name: 'a.pdf', hash: '7'.repeat(64), pages: 1 }, { user: 'linzi@soardcharity.com' })).scan;
  const b = (await startScan(DB, { year: '2027', name: 'b.pdf', hash: '8'.repeat(64), pages: 1 }, { user: 'linzi@soardcharity.com' })).scan;
  assert.equal((await readPage(env, { scan: a.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0].status, 'saved');
  assert.equal((await readPage(env, { scan: b.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0].status, 'same');
  const off = await unsaveItem(env, { scan: a.id, page: 1, idx: 0 }, { user: 'x' });
  assert.equal(off.kept, true);
  const [card] = await scorecardsFor(DB, 'acct0005');
  assert.equal(card.ref, `${b.id}:1:0`);
  await DB.prepare("UPDATE applicants SET status = 'Approved' WHERE account_id = 'acct0005'").run();
  await applyHeld(DB);
  assert.equal((await scorecardsFor(DB, 'acct0005'))[0].scores.readiness, 5, 'the other copy’s held readiness lands after the visit');
});

test('two people confirming one sheet at the same moment: one saves, the other is told', async () => {
  const scan = await start();
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Mateo', v, { scorer: 'Linzi' })], [sheet('Mateo', v, { scorer: 'Linzi' })]) });
  const ask = (n, who) => confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0004', evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(n)) }, { user: who });
  const both = await Promise.allSettled([ask(4, 'linzi@soardcharity.com'), ask(1, 'ccunningham@soardcharity.com')]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const total = (await scorecardsFor(DB, 'acct0004'))[0].total;
  assert.ok(total === 40 || total === 10);
  assert.match(both.find((r) => r.status === 'rejected').reason.message, /saving that sheet right now|saved already/);
});

test('a sheet left out can be put back under Check these', async () => {
  const scan = await start();
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Mateo', v)], [sheet('Mateo', v)]) });
  await skipItem(env, { scan: scan.id, page: 1, idx: 0 }, { user: 'x' });
  await assert.rejects(confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0004', evaluator: 'linzi@soardcharity.com', scores: scores(v) }, { user: 'x' }), /left out by x|left out/);
  assert.equal((await seasonScans(DB, '2026')).left.length, 1);
  await unskipItem(env, { scan: scan.id, page: 1, idx: 0 });
  assert.equal((await seasonScans(DB, '2026')).waiting.length, 1);
  await assert.rejects(unskipItem(env, { scan: scan.id, page: 1, idx: 0 }), /isn’t left out/);
});

test('which families the person looking has scored comes from the server, whatever the board shows', async () => {
  await saveScorecard(DB, 'acct0001', { evaluator: 'linzi@soardcharity.com', scores: { mobility: 3 } });
  const season = await seasonScans(DB, '2026', { me: 'linzi@soardcharity.com' });
  assert.equal(season.me, 'linzi@soardcharity.com');
  assert.equal(season.families.find((f) => f.id === 'acct0001').mine, true);
  assert.equal(season.families.find((f) => f.id === 'acct0002').mine, false);
});

// ── The fifth break-it pass: a database call failing at any step (Nov 4 2026) ──

/** The next query whose SQL matches fails once */
function failOnce(re) {
  const real = DB.prepare.bind(DB);
  let armed = true;
  DB.prepare = (sql) => {
    const st = real(sql);
    if (!armed || !re.test(sql)) return st;
    armed = false;
    const boom = async () => { throw new Error('D1 hiccup'); };
    return { bind: () => ({ first: boom, all: boom, run: boom }), first: boom, all: boom, run: boom };
  };
  return () => { DB.prepare = real; };
}

test('a failed read of the family never saves a card on a guessed rubric: the page fails and is read again', async () => {
  const scan = await start();
  const s = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi' })];
  const undo = failOnce(/^SELECT name, status, year FROM applicants/);
  await assert.rejects(readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) }), /hiccup/);
  undo();
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0);
  const again = await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  assert.equal(again.items[0].status, 'saved');
  assert.equal((await scorecardsFor(DB, 'acct0001'))[0].rubric, 1, '2026’s rubric');
});

test('a save cut off after the sheet was locked frees the sheet after two minutes', async () => {
  const scan = await start();
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers([sheet('Mateo', v)], [sheet('Mateo', v)]) });
  // As if a save locked it and the Worker stopped there
  await DB.prepare("UPDATE score_scan_items SET status = 'saving', saved_at = ?, saved_by = '~check' WHERE scan_id = ?").bind(new Date(Date.now() - 3 * 60 * 1000).toISOString(), scan.id).run();
  const season = await seasonScans(DB, '2026');
  assert.equal(season.waiting.length, 1, 'back under Check these');
  const ok = await confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0004', evaluator: 'linzi@soardcharity.com', scores: scores(v) }, { user: 'x' });
  assert.equal(ok.item.status, 'saved');
});

test('Take off is all or nothing: a failure leaves the sheet saved and its card in place', async () => {
  await saveScorecard(DB, 'acct0001', { evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(2)) });
  const scan = await start();
  const s = [sheet('Avery Thompson', Array(10).fill(5), { scorer: 'Linzi' })];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  await confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0001', evaluator: 'linzi@soardcharity.com', scores: scores(Array(10).fill(5)), override: true }, { user: 'x' });
  const realBatch = DB.batch.bind(DB);
  DB.batch = async () => { throw new Error('D1 hiccup'); };
  await assert.rejects(unsaveItem(env, { scan: scan.id, page: 1, idx: 0 }, { user: 'x' }), /hiccup/);
  DB.batch = realBatch;
  assert.equal((await scorecardsFor(DB, 'acct0001'))[0].total, 50);
  assert.equal((await seasonScans(DB, '2026')).saved.length, 1);
  // Then it works, and Undo after it says nothing untrue
  await unsaveItem(env, { scan: scan.id, page: 1, idx: 0 }, { user: 'x' });
  assert.equal((await scorecardsFor(DB, 'acct0001'))[0].total, 20);
  const u = await undoScan(env, scan.id, { user: 'x' });
  assert.deepEqual([u.restored, u.changed], [0, 0]);
});

test('a page whose reading was cut off: its sheets can’t be checked until it’s read whole', async () => {
  const scan = await start();
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  await DB.prepare("INSERT INTO score_scan_items (scan_id, page, idx, status, created_at) VALUES (?, 1, -1, 'reading', ?)").bind(scan.id, new Date().toISOString()).run();
  await DB.prepare("INSERT INTO score_scan_items (scan_id, page, idx, status, account_id, scores, problems, reads, created_at) VALUES (?, 1, 0, 'check', 'acct0004', ?, '[\"family\"]', '{}', ?)").bind(scan.id, JSON.stringify(scores(v)), new Date().toISOString()).run();
  assert.equal((await seasonScans(DB, '2026')).waiting.length, 0, 'not shown while the page is half read');
  await assert.rejects(confirmItem(env, { scan: scan.id, page: 1, idx: 0, account: 'acct0004', evaluator: 'linzi@soardcharity.com', scores: scores(v) }, { user: 'x' }), /still being read/);
});

test('a notes-only edit keeps a scanned card the scan’s, so readiness held for the visit still lands', async () => {
  const scan = (await startScan(DB, { year: '2027', name: 'n.pdf', pages: 1 }, { user: 'linzi@soardcharity.com' })).scan;
  const s = [{ family: 'Harper Lin', scorer: 'Linzi', code: '', total: 0, notes: '', scores: scores([4, 4, 4, 4, 4, 4, 4, 4, 5, 3], V2) }];
  await readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(s, s) });
  await saveScorecard(DB, 'acct0005', { evaluator: 'linzi@soardcharity.com', notes: 'Visit is next Tuesday' });
  const [card] = await scorecardsFor(DB, 'acct0005');
  assert.equal(card.source, 'scan');
  await DB.prepare("UPDATE applicants SET status = 'Approved' WHERE account_id = 'acct0005'").run();
  await applyHeld(DB);
  assert.equal((await scorecardsFor(DB, 'acct0005'))[0].scores.readiness, 5);
});

test('a failed read of the staff list fails the step, never lets a suspended account through', async () => {
  await saveScorecard(DB, 'acct0004', { evaluator: 'gone@soardcharity.com', scores: scores(Array(10).fill(3)) });
  const scan = await start();
  const g = [sheet('Avery Thompson', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4], { scorer: 'Linzi Gone' })];
  const undo = failOnce(/FROM staff_state/);
  await assert.rejects(readPage(env, { scan: scan.id, page: 1, image: IMAGE }, { user: 'x', readers: readers(g, g) }), /hiccup/);
  undo();
  assert.equal((await scorecardsFor(DB, 'acct0001')).length, 0);
});

test('someone whose Google account is on another of the organization’s domains, with a soardcharity.com alias, is a scorer by that alias and by every name their cards carry', async () => {
  await DB.prepare('UPDATE staff_state SET data = ? WHERE key = ?').bind(JSON.stringify({ accounts: [
    { email: 'pjones@example-store.com', aliases: ['pat@soardcharity.com'], name: 'Pat Jones', active: true },
    { email: 'linzi@soardcharity.com', name: 'Linzi Lawsky', active: true },
  ] }), 'directory').run();
  await importScores(DB, { year: '2026', evaluator: 'pat@soardcharity.com', name: 'Pat Smith', rows: [{ child: 'Mateo Lin', scores: scores(Array(10).fill(3)) }] });
  const { scorers: people } = await seasonScans(DB, '2026');
  const pat = people.find((p) => p.email === 'pat@soardcharity.com');
  assert.ok(pat, 'listed by the address they sign in with here');
  assert.equal(pat.scored, true);
  const scan = await start({ hash: 'b1'.padEnd(64, '0') });
  const v = [5, 4, 4, 5, 5, 4, 3, 4, 5, 4];
  for (const [n, who] of [[1, 'Pat Smith'], [2, 'Pat Jones']]) {
    const s = [sheet(n === 1 ? 'Avery Thompson' : 'Teo Ruiz', v, { scorer: who })];
    const it = (await readPage(env, { scan: scan.id, page: n, image: IMAGE }, { user: 'x', readers: readers(s, s) })).items[0];
    assert.equal(it.status, 'saved', who);
    assert.equal(it.evaluator, 'pat@soardcharity.com', `${who}: one card key, the SOARD address`);
  }
  const { staffDirectory } = await import('../functions/api/_staff-access.js');
  assert.ok((await staffDirectory(DB)).some((a) => a.email === 'pjones@example-store.com'), 'the shared staff list includes them');
});
