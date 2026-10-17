/**
 * Reveal checks: the weekday comments for Project Managers
 * (functions/api/_reveal-nudges.js)
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeJobTread } from './lib/fake-jobtread.mjs';
import { checkJob, runNudges, maybeNudge, writeNudgeConfig, readNudgeConfig, nudgeMessage, FIELD_PM, SANDBOX_JOB_ID, COMMENT_TITLE } from '../functions/api/_reveal-nudges.js';
import { FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED, easternToUtcIso } from '../functions/api/_reveals.js';

const FIELD_STATUS = '22P52qfFub9b';
const REVEAL = '22NZSbkR5rZw';
const NOW = Date.parse('2026-10-16T13:30:00Z'); // Friday 9:30 AM Eastern
const TODAY = '2026-10-16';
const DAY = 24 * 60 * 60 * 1000;

/** A job as the fake JobTread holds it; the field follows the task unless given */
function jt({ id = '22PRvFFPZsEA', name = 'Max Daniel (2026)', date = '2026-10-27', time = null, confirmed = false, pm = 'Christian Nielsen', status = 'Build', field, schedule = [], closedOn = null, progress = null } = {}) {
  return {
    id, name, closedOn,
    fields: {
      [FIELD_STATUS]: status, [FIELD_PM]: pm,
      [FIELD_REVEAL_CONFIRMED]: confirmed ? 'Yes 👍' : null,
      [FIELD_REVEAL_DATE]: field !== undefined ? field : (date ? easternToUtcIso(date, time) : null),
    },
    reveals: [{ id: `${id}-r`, startDate: date, startTime: time ? `${time}:00.000` : null, endDate: date, progress }],
    schedule,
  };
}

/** The shape checkJob reads (what JobTread returns) */
function rendered(o) {
  const j = jt(o);
  return {
    id: j.id, name: j.name, closedOn: j.closedOn, organization: { id: '22NJw42j5GLg' },
    customFieldValues: { nodes: Object.entries(j.fields).filter(([, v]) => v != null).map(([id, value]) => ({ value, customField: { id } })) },
    tasks: { nodes: j.reveals.map(t => ({ ...t, taskType: { id: REVEAL } })) },
  };
}

const keys = (r) => (r.issues || []).map(i => i.key.split(':')[0]);
const task = (name, endDate, o = {}) => ({ name, endDate, progress: null, isGroup: false, taskType: null, ...o });

// ── The checks ──────────────────────────────────────────────────────────────

test('not confirmed inside two weeks, with the weekday computed', () => {
  const r = checkJob(rendered({ date: '2026-10-27' }), [], { today: TODAY });
  assert.deepEqual(keys(r), ['unconfirmed']);
  assert.equal(r.issues[0].text, 'The reveal is Tuesday, October 27, 11 days away, and isn\'t confirmed yet. Once the family confirms, set the time and mark Reveal Date Confirmed as Yes.');
  assert.equal(r.pm, 'Christian');
  assert.match(checkJob(rendered({ date: '2026-10-17' }), [], { today: TODAY }).issues[0].text, /Saturday, October 17, tomorrow,/);
  assert.match(checkJob(rendered({ date: TODAY }), [], { today: TODAY }).issues[0].text, /Friday, October 16, today,/);
  assert.deepEqual(keys(checkJob(rendered({ date: '2026-10-31' }), [], { today: TODAY })), [], '15 days out is fine');
  assert.deepEqual(keys(checkJob(rendered({ date: '2026-10-30' }), [], { today: TODAY })), ['unconfirmed'], '14 days out counts');
});

test('date passed and the Reveal task still open', () => {
  const r = checkJob(rendered({ date: '2026-10-07' }), null, { today: TODAY });
  assert.deepEqual(keys(r), ['passed']);
  assert.match(r.issues[0].text, /^The reveal date on the schedule \(Wednesday, October 7\) has passed/);
});

test('confirmed without a time; confirmed with one is fine', () => {
  assert.deepEqual(keys(checkJob(rendered({ date: '2026-10-27', confirmed: true }), [], { today: TODAY })), ['no-time']);
  assert.deepEqual(keys(checkJob(rendered({ date: '2026-10-27', confirmed: true, time: '15:00' }), [], { today: TODAY })), []);
});

test('work that ends after the reveal, ignoring groups, finished work, the Reveal and follow-ups', () => {
  const schedule = [
    task('Paint', '2026-11-12'),
    task('Install Furniture', '2026-11-10'),
    task('Post Con', '2026-11-30', { isGroup: true }),
    task('Order Blinds', '2026-11-20', { progress: 1 }),
    task('Reveal', '2026-11-30', { taskType: { id: REVEAL } }),
    task('30 Day Check-up', '2026-12-10'),
    task('Warranty Walkthrough', '2026-12-10'),
    task('Family Survey', '2026-12-10'),
    task('Follow up call', '2026-12-10'),
    task('Install Shelves', '2026-11-11'),
    task('Demo', '2026-11-01'),
  ];
  const r = checkJob(rendered({ date: '2026-11-11', confirmed: true, time: '15:00' }), schedule, { today: TODAY });
  assert.deepEqual(keys(r), ['late']);
  assert.equal(r.issues[0].text, 'These tasks end after the reveal (November 11): Paint (November 12). Move the reveal or the work so the room is finished first.');
});

test('more than five late tasks are counted, not dropped', () => {
  const schedule = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n, i) => task(n, `2026-11-2${i}`));
  const r = checkJob(rendered({ date: '2026-11-11', confirmed: true, time: '15:00' }), schedule, { today: TODAY });
  assert.match(r.issues[0].text, /E \(November 24\), and 2 more\./);
});

test('field and task disagree (not confirmed): flagged first, both sides named', () => {
  const r = checkJob(rendered({ date: '2026-10-27', field: easternToUtcIso('2026-10-29', '14:00') }), [], { today: TODAY });
  assert.deepEqual(keys(r), ['mismatch', 'unconfirmed']);
  assert.equal(r.issues[0].text, 'The Reveal Date field says Thursday, October 29 at 2:00 PM but the Reveal task on the schedule says Tuesday, October 27 (time not set yet). Change whichever one is wrong and the other will follow.');
});

test('all issues together, in order, addressed to the PM', () => {
  const r = checkJob(rendered({ date: '2026-10-07', confirmed: false }), null, { today: TODAY });
  assert.equal(nudgeMessage(r.pm, r.issues), `Christian,\n\n${r.issues[0].text}`);
  assert.equal(nudgeMessage('', r.issues).split('\n')[0], 'Team,');
});

test('jobs that are left alone', () => {
  const skip = (o, opts = {}) => checkJob(rendered(o), [], { today: TODAY, ...opts }).skip;
  assert.equal(skip({ id: SANDBOX_JOB_ID }), 'office job');
  assert.equal(skip({ id: SANDBOX_JOB_ID }, { allowSandbox: true }), undefined, 'unless it\'s a deliberate test');
  assert.equal(skip({ closedOn: '2026-10-01' }), 'closed');
  for (const status of ['Closed Done', 'Denied', 'Warranty', 'Awaiting Funding']) assert.equal(skip({ status }), `status is ${status}`);
  assert.equal(skip({ progress: 1 }), 'no open Reveal task');
  assert.equal(checkJob({ ...rendered({}), organization: { id: 'other' } }, [], { today: TODAY }).skip, 'not a SOARD job');
});

// ── Posting ─────────────────────────────────────────────────────────────────

async function setup(jobs) {
  const fake = fakeJobTread(jobs);
  const env = { DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] }), JOBTREAD_GRANT_KEY: 'test-grant' };
  const run = (opts = {}) => runNudges(env, { fetchImpl: fake.fetchImpl, now: NOW, ...opts });
  return { fake, env, run };
}

test('posts one internal comment per job, then holds off until the problem changes or 3 days pass', async () => {
  const { fake, run } = await setup([jt({ date: '2026-10-27' }), jt({ id: 'quiet', date: '2026-12-15' })]);
  let results = await run();
  assert.deepEqual(results.map(r => r.action), ['posted', 'ok']);
  assert.equal(fake.state.comments.length, 1);
  const c = fake.state.comments[0];
  assert.equal(c.name, COMMENT_TITLE);
  assert.equal(c.targetId, '22PRvFFPZsEA');
  assert.deepEqual([c.isVisibleToInternalRoles, c.isVisibleToCustomerRoles, c.isVisibleToVendorRoles], [true, false, false]);

  // Next weekday: "10 days away" now, but the same problem, so no repeat
  results = await run({ now: NOW + DAY });
  assert.equal(results[0].action, 'repeat-skipped');

  // Three days on, still unconfirmed: remind again
  results = await run({ now: NOW + 3 * DAY });
  assert.equal(results[0].action, 'posted');
  assert.match(fake.state.comments[1].message, /8 days away/);

  // The family confirmed but nobody set a time: a new problem, said right away
  fake.job('22PRvFFPZsEA').fields[FIELD_REVEAL_CONFIRMED] = 'Yes 👍';
  results = await run({ now: NOW + 3 * DAY + 3600_000 });
  assert.equal(results[0].action, 'posted');
  assert.match(fake.state.comments[2].message, /doesn't have a time yet/);
});

test('dry run posts nothing and remembers nothing', async () => {
  const { fake, run } = await setup([jt({ date: '2026-10-27' })]);
  const [r] = await run({ dryRun: true });
  assert.equal(r.action, 'would-post');
  assert.match(r.message, /^Christian,/);
  assert.equal(fake.state.comments.length, 0);
  assert.equal((await run())[0].action, 'posted', 'a real run still posts');
});

test('the office sandbox is checked only when asked for by id', async () => {
  const { run } = await setup([jt({ id: SANDBOX_JOB_ID, date: '2026-10-27' })]);
  assert.equal((await run())[0].action, 'skip');
  assert.equal((await run({ jobIds: [SANDBOX_JOB_ID] }))[0].action, 'posted');
});

test('safety net: a confirmed reveal the schedule moved without a webhook is put back', async () => {
  const job = jt({ date: '2026-11-23', time: '15:00', confirmed: true, field: easternToUtcIso('2026-11-20', '15:00') });
  const { fake, run } = await setup([job]);
  const [r] = await run();
  assert.equal(r.repaired, 'snapped-back');
  assert.equal(fake.job(job.id).reveals[0].startDate, '2026-11-20');
  assert.equal(r.action, 'ok', 'nothing else wrong once it\'s back');
  assert.equal(fake.state.comments[0].name, 'Reveal date sync (automatic)');
});

test('safety net: an empty field is filled from the task; an unconfirmed disagreement is only flagged', async () => {
  const empty = jt({ id: 'empty', date: '2026-12-15', time: '15:00', field: null });
  const differ = jt({ id: 'differ', date: '2026-12-15', field: easternToUtcIso('2026-12-17', null) });
  const { fake, run } = await setup([empty, differ]);
  const [a, b] = await run();
  assert.equal(a.repaired, 'task-to-field');
  assert.equal(fake.job('empty').fields[FIELD_REVEAL_DATE], '2026-12-15T20:00:00.000Z');
  assert.equal(b.repaired, undefined);
  assert.equal(b.action, 'posted');
  assert.match(b.message, /The Reveal Date field says Thursday, December 17/);
  assert.equal(fake.job('differ').reveals[0].startDate, '2026-12-15', 'not guessed');
});

test('one job failing doesn\'t stop the rest', async () => {
  const { fake, env } = await setup([jt({ id: 'bad', date: '2026-10-27' }), jt({ id: 'good', date: '2026-10-28' })]);
  const flaky = async (url, init) => {
    const q = JSON.parse(init.body).query;
    if (q.createComment?.$.targetId === 'bad') return new Response('nope', { status: 500 });
    return fake.fetchImpl(url, init);
  };
  const results = await runNudges(env, { fetchImpl: flaky, now: NOW });
  assert.deepEqual(results.map(r => r.action), ['error', 'posted']);
  assert.match(results[0].error, /JobTread returned 500/);
});

// ── Once each weekday ───────────────────────────────────────────────────────

test('runs once per weekday after 8 AM Eastern, only when switched on', async () => {
  const { fake, env } = await setup([jt({ date: '2026-10-27' })]);
  const tick = (now) => maybeNudge(env, { fetchImpl: fake.fetchImpl, now });
  assert.equal(await tick(NOW), null, 'off by default');

  await writeNudgeConfig(env.DB, { enabled: true });
  assert.equal(await tick(Date.parse('2026-10-16T11:30:00Z')), null, '7:30 AM is too early');
  const run = await tick(NOW);
  assert.equal(run.day, TODAY);
  assert.equal(run.posted, 1);
  assert.equal(await tick(NOW + 3600_000), null, 'once a day');
  assert.equal(await tick(Date.parse('2026-10-17T14:00:00Z')), null, 'not on Saturday');
  assert.equal(await tick(Date.parse('2026-10-18T14:00:00Z')), null, 'not on Sunday');
  assert.equal((await tick(Date.parse('2026-10-19T12:05:00Z'))).day, '2026-10-19', 'Monday 8:05 AM');
});

test('if JobTread is down, the day isn\'t lost: it retries half an hour later', async () => {
  const { fake, env } = await setup([jt({ date: '2026-10-27' })]);
  await writeNudgeConfig(env.DB, { enabled: true });
  const down = async () => new Response('down', { status: 503 });
  assert.equal(await maybeNudge(env, { fetchImpl: down, now: NOW }), null);
  const config = await readNudgeConfig(env.DB);
  assert.match(config.lastError.error, /503/);
  assert.notEqual(config.lastRun?.day, TODAY, 'the day was released');

  assert.equal(await maybeNudge(env, { fetchImpl: fake.fetchImpl, now: NOW + 10 * 60_000 }), null, 'waits before retrying');
  const run = await maybeNudge(env, { fetchImpl: fake.fetchImpl, now: NOW + 31 * 60_000 });
  assert.equal(run.posted, 1);
  assert.equal((await readNudgeConfig(env.DB)).lastError, null);
});
