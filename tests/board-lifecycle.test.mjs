/**
 * Makeovers from application to reveal on the board page: where each family is (functions/api/_board-families.js
 * stageOf, familiesList) and who is "now" (public/admin/board/stages.js). Made-up families; JobTread is faked. The
 * page itself is walked in scripts/test-board-family-map.mjs.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { ensureApplicantSchema } from '../functions/api/_applicants.js';
import { stageOf, familiesList } from '../functions/api/_board-families.js';
import { FIELD_JOB_STATUS } from '../functions/api/_reveals.js';
import { STAGE_OF_JOB, inMotion, countsOf, shownStages, trackStages, windowWords, byStage, keyOf, stageLabel } from '../public/admin/board/stages.js';

describe('where a family is', () => {
  const open = { jBuild: 'Build', jWait: 'Awaiting Funding', jDone: 'Closed Done', jWarr: 'Warranty', jNo: 'Denied', jSite: 'On Site', jNone: '', jDesign: 'Design', jFinal: 'Finalization' };
  for (const [a, want, why] of [
    [{ jobId: 'jBuild', status: 'Approved' }, 'build', 'their open job’s status'],
    [{ jobId: 'jWait', status: 'Approved' }, 'funding', 'awaiting funding'],
    [{ jobId: 'jFinal', status: 'Approved' }, 'finalization', 'finalization, when JobTread says it'],
    [{ jobId: 'jDone', status: 'Approved' }, 'revealed', 'Closed Done is done'],
    [{ jobId: 'jWarr', status: 'Approved' }, 'revealed', 'Warranty is done'],
    [{ jobId: 'jNo', status: 'Approved' }, 'denied', 'a job JobTread calls Denied'],
    [{ jobId: 'jSite', status: 'In Review' }, 'review', 'On Site says nothing: the application does (a visit while it’s decided)'],
    [{ jobId: 'jSite', status: 'Approved' }, 'approved', 'On Site, approved: approved'],
    [{ jobId: 'jNone', status: 'Approved' }, 'approved', 'an open job with no status yet'],
    [{ jobId: 'jClosed', status: 'Approved' }, 'revealed', 'approved, and their job is closed: their reveal’s done'],
    [{ jobId: 'jClosed', status: 'Applied' }, 'applied', 'a family applying again: their old job’s closed, they’re applying'],
    [{ status: 'Applied' }, 'applied', 'no job: the application'],
    [{ status: 'In Review' }, 'review', 'in review'],
    [{ status: 'Approved' }, 'approved', 'approved, no job yet'],
    [{ status: 'Denied' }, 'denied', 'not chosen'],
    [{ status: '' }, 'none', 'no status is no status'],
  ]) test(`${why} → ${want}`, () => assert.equal(stageOf(a, open), want));
  test('their kid page says completed (the Reveal task done): revealed, whatever the job’s status still says', () => {
    assert.equal(stageOf({ jobId: 'jBuild', status: 'Approved', kid: { slug: 'max', status: 'completed' } }, open), 'revealed');
    assert.equal(stageOf({ jobId: 'jBuild', status: 'Approved', kid: { slug: 'max', status: 'in-progress' } }, open), 'build');
    assert.equal(stageOf({ jobId: 'jBuild', status: 'Approved', kid: { slug: 'oak', kind: 'community', status: 'completed' } }, open), 'build', 'a community project goes by its job');
  });
  test('JobTread can’t be read: the application’s status, never a guess that a makeover is done', () => {
    assert.equal(stageOf({ jobId: 'jBuild', status: 'Approved' }, null), 'approved');
    assert.equal(stageOf({ jobId: 'jClosed', status: 'Approved' }, null), 'approved');
  });
  test('the server and the page read JobTread’s statuses from one table', () => {
    for (const [status, stage] of Object.entries(STAGE_OF_JOB)) assert.equal(stageOf({ jobId: 'j', status: 'Approved' }, { j: status }), stage);
  });
});

describe('the families list, each where they are', () => {
  let DB;
  let env;
  let jobs;
  let down;
  const realFetch = globalThis.fetch;
  const JOB = (id, status) => ({ id, name: `${id} (2026)`, customFieldValues: { nodes: [{ value: status, customField: { id: FIELD_JOB_STATUS } }] } });
  const applicant = (id, name, status, year, jobId = null) => DB.prepare(`INSERT INTO applicants (account_id, name, status, year, types, fields, contacts, synced_at, job_id)
    VALUES (?, ?, ?, ?, '["Bedroom"]', '{}', '[]', ?, ?)`).bind(id, name, status, year, new Date().toISOString(), jobId).run();
  beforeEach(async () => {
    DB = await createD1();
    await ensureApplicantSchema(DB);
    for (const sql of [
      'CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, jt_account_id TEXT, lang TEXT, jt_state TEXT, files TEXT, is_test INTEGER DEFAULT 0, submitted_at TEXT, kind TEXT, deleted_at TEXT)',
      'CREATE TABLE IF NOT EXISTS kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)',
      'CREATE TABLE IF NOT EXISTS community (slug TEXT PRIMARY KEY, name TEXT, data TEXT)',
      'CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
    ]) await DB.exec(sql);
    await applicant('acctMax001', 'Max Example', 'Approved', '2026', 'jMax');
    await applicant('acctSam001', 'Sam Example', 'Approved', '2026', 'jSamOld');
    await applicant('acctMia001', 'Mia Example', 'Applied', '2027');
    await applicant('acctTest01', 'TEST Applicant', 'Approved', '2026', 'jTest');
    await DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('ruby', 'Ruby', 2025, JSON.stringify({ name: 'Ruby', jobtreadJobId: 'jRuby', heroImage: 'https://imagedelivery.net/abc123/kids/ruby/photo-1/public' })).run();
    // Sam's page: built this year for last season's application; Ada's: revealed this year, her family not an applicant;
    // Old's: revealed years ago
    const thisYear = new Date().getFullYear();
    for (const [slug, name, year, job] of [['sam', 'Sam', thisYear, 'jSamOld'], ['ada', 'Ada', thisYear, 'jAdaOld'], ['old', 'Old', thisYear - 4, 'jOldOld']]) {
      await DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind(slug, name, year, JSON.stringify({ name, jobtreadJobId: job, status: 'completed', heroImage: `https://imagedelivery.net/abc123/kids/${slug}/photo-1/public` })).run();
    }
    await DB.prepare('INSERT INTO site_config (key, data) VALUES (?, ?)').bind('settings', JSON.stringify({ application: { open: true, year: '2027', closesAt: '2027-01-31T23:59:00-05:00', closedMessage: 'Staff words', maxApplications: 40, formUrl: 'https://example.com/form' } })).run();
    jobs = [JOB('jMax', 'Build'), JOB('jRuby', 'Design'), JOB('jTest', 'Build')];
    down = false;
    env = { DB, JOBTREAD_GRANT_KEY: 'jt' };
    globalThis.fetch = async (input, init = {}) => {
      if (String(input) !== 'https://api.jobtread.com/pave') throw new Error(`unexpected ${input}`);
      if (down) return new Response('down', { status: 503 });
      return Response.json({ organization: { jobs: { nodes: jobs, nextPage: null } } });
    };
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('each family where they are: being built, revealed, applying', async () => {
    const { families } = await familiesList(env);
    const at = Object.fromEntries(families.map((f) => [f.name, f.stage]));
    assert.deepEqual(at, { 'Max Example': 'build', 'Sam Example': 'revealed', 'Mia Example': 'applied' });
  });
  test('a makeover whose family isn’t an applicant is still on the way, by its page; a test run’s never is', async () => {
    const { makeovers } = await familiesList(env);
    assert.deepEqual(makeovers.filter((m) => m.stage !== 'revealed').map((m) => [m.id, m.name, m.stage, m.page]), [['job-jRuby', 'Ruby', 'design', '/kids/ruby/']]);
  });
  test('a revealed family carries the year of their reveal, their page’s: often the season after the one they applied for', async () => {
    const { families } = await familiesList(env);
    assert.equal(families.find((f) => f.name === 'Sam Example').revealYear, String(new Date().getFullYear()));
    assert.equal(families.find((f) => f.name === 'Max Example').revealYear, undefined, 'not one still being built');
  });
  test('this year’s and last year’s reveals whose family isn’t an applicant, by their page; never an old one, never twice', async () => {
    const { makeovers } = await familiesList(env);
    const shown = makeovers.filter((m) => m.stage === 'revealed').map((m) => [m.id, m.name, m.revealYear, m.page]);
    assert.deepEqual(shown, [['kid-ada', 'Ada', String(new Date().getFullYear()), '/kids/ada/']]);
  });
  test('the application’s window, and nothing else of its settings', async () => {
    const { application } = await familiesList(env);
    assert.deepEqual(application, { open: true, year: '2027', opensAt: '', closesAt: '2027-01-31T23:59:00-05:00' });
  });
  test('JobTread down and nothing kept: the applications’ statuses, and the page is told', async () => {
    down = true;
    const r = await familiesList(env);
    assert.equal(r.jobs, false);
    assert.equal(r.families.find((f) => f.name === 'Max Example').stage, 'approved');
    assert.deepEqual(r.makeovers.filter((m) => m.id.startsWith('job-')), [], 'no makeover from JobTread (a reveal on a page still shows)');
  });
  test('JobTread’s answer is kept a few minutes: the list asks it once, not once a family', async () => {
    let asked = 0;
    const was = globalThis.fetch;
    globalThis.fetch = async (...a) => { asked += 1; return was(...a); };
    await familiesList(env);
    await familiesList(env);
    assert.equal(asked, 1);
  });
});

describe('who is “now”', () => {
  const F = (name, stage, season) => ({ id: name, name, stage, season });
  const all = [
    F('Mia', 'applied', '2027'), F('Jay', 'review', '2027'), F('Old', 'applied', '2025'),
    F('Iris', 'approved', '2027'), F('Ana', 'approved', '2026'), F('Bry', 'approved', '2023'),
    F('Max', 'build', '2026'), F('Ava', 'funding', '2025'), F('Sam', 'revealed', '2026'), F('Ben', 'revealed', '2025'),
    F('Omar', 'denied', '2027'), F('Noah', 'none', '2027'),
  ];
  test('this season’s applications, every makeover being built, the new approvals, the reveals of the seasons still being built', () => {
    assert.deepEqual(inMotion(all, { year: '2027' }).map((f) => f.name), ['Mia', 'Jay', 'Iris', 'Ana', 'Max', 'Ava', 'Sam', 'Ben']);
  });
  test('a reveal is “now” by its year: this year’s, whatever season they applied for', () => {
    const y = String(new Date().getFullYear());
    const list = [{ id: 'a', stage: 'revealed', season: '2019', revealYear: y }, { id: 'b', stage: 'revealed', season: '2019', revealYear: String(Number(y) - 1) }, { id: 'c', stage: 'build', season: '2019' }];
    assert.deepEqual(inMotion(list, { year: String(Number(y) + 1) }).map((f) => f.id), ['a', 'c']);
  });
  test('never an old application nobody decided, an old approval with no job, or anyone not chosen', () => {
    const now = inMotion(all, { year: '2027' }).map((f) => f.name);
    for (const n of ['Old', 'Bry', 'Omar', 'Noah']) assert.ok(!now.includes(n), n);
  });
  test('with no window, the newest season is the one applying', () => {
    assert.deepEqual(inMotion(all, null).map((f) => f.name), inMotion(all, { year: '2027' }).map((f) => f.name));
  });
  test('the board’s columns: everyone’s steps, and Applied while applications are open (nobody yet says so)', () => {
    const counts = countsOf([F('Max', 'build', '2026')]);
    assert.deepEqual(shownStages(counts, { open: true }).map((s) => s.key), ['applied', 'build']);
    assert.deepEqual(shownStages(counts, { open: false }).map((s) => s.key), ['build']);
  });
  test('the track: every step but Finalization, unless someone’s at it', () => {
    assert.ok(!trackStages({}).some((s) => s.key === 'finalization'));
    assert.ok(trackStages({ finalization: 1 }).some((s) => s.key === 'finalization'));
  });
  test('the window in a few words', () => {
    assert.equal(windowWords({ open: true, closesAt: '2027-01-31T23:59:00-05:00' }), 'Open until Jan 31');
    assert.equal(windowWords({ open: true }), 'Open now');
    assert.equal(windowWords({ open: false, opensAt: '2027-03-01T09:00:00-05:00' }, '2026-11-07'), 'Opens Mar 1');
    assert.equal(windowWords({ open: false, opensAt: '2026-03-01' }, '2026-11-07'), 'Closed');
    assert.equal(windowWords({ open: false }), 'Closed');
  });
  test('a list in the way’s order: applying first, revealed last, then not chosen and no status', () => {
    assert.deepEqual([F('a', 'revealed'), F('b', 'none'), F('c', 'applied'), F('d', 'denied'), F('e', 'build')].sort(byStage).map((f) => f.stage), ['applied', 'build', 'revealed', 'denied', 'none']);
  });
  test('the map’s key: the building steps as one', () => {
    assert.deepEqual(['applied', 'review', 'approved', 'funding', 'build', 'revealed', 'denied', 'none', 'weird'].map((s) => keyOf({ stage: s })), ['applied', 'review', 'building', 'building', 'building', 'revealed', 'denied', 'none', 'none']);
    assert.equal(stageLabel('denied'), 'Not chosen');
  });
});
