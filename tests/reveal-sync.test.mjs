/**
 * Reveal date sync (functions/api/_reveal-sync.js) and the Eastern ↔ UTC
 * helpers it relies on (functions/api/_reveals.js)
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeJobTread } from './lib/fake-jobtread.mjs';
import { planSync, syncJob, taskKey, fieldKey, whenLabel } from '../functions/api/_reveal-sync.js';
import { easternToUtcIso, easternParts, longDay, clockTime, daysBetween, FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED } from '../functions/api/_reveals.js';

const NOW = Date.parse('2026-10-16T14:00:00Z');
const JOB = '22PRvFFPZsEA';

function jobState({ field = null, confirmed = false, reveals } = {}) {
  return {
    id: JOB, name: 'Max Daniel (2026)',
    fields: { [FIELD_REVEAL_DATE]: field, [FIELD_REVEAL_CONFIRMED]: confirmed ? 'Yes 👍' : null },
    reveals: reveals ?? [{ id: 'rt1', startDate: '2026-11-20', startTime: '15:00:00.000', endDate: '2026-11-20', endTime: '16:00:00.000' }],
  };
}

async function setup(opts) {
  const jt = fakeJobTread([jobState(opts)]);
  const env = { DB: await createD1(), JOBTREAD_GRANT_KEY: 'test-grant' };
  const sync = (payload, now = NOW) => syncJob(env, { jobId: JOB, ...payload }, { fetchImpl: jt.fetchImpl, now });
  return { jt, env, sync, job: jt.job(JOB) };
}

// ── Time helpers ────────────────────────────────────────────────────────────

test('Eastern ↔ UTC is exact on both sides of daylight saving', () => {
  const cases = [
    ['2026-11-20', '15:00', '2026-11-20T20:00:00.000Z'], // EST
    ['2027-07-15', '14:00', '2027-07-15T18:00:00.000Z'], // EDT
    ['2026-11-11', null, '2026-11-11T05:00:00.000Z'],    // no time = midnight
    ['2027-01-14', '20:00', '2027-01-15T01:00:00.000Z'], // crosses the UTC date
    ['2026-11-01', '10:00', '2026-11-01T15:00:00.000Z'], // the day clocks fall back
    ['2027-03-14', '10:00', '2027-03-14T14:00:00.000Z'], // the day clocks spring forward
    ['2026-10-31', '18:30', '2026-10-31T22:30:00.000Z'],
  ];
  for (const [date, time, iso] of cases) {
    assert.equal(easternToUtcIso(date, time), iso, `${date} ${time}`);
    assert.deepEqual(easternParts(iso), { date, time }, `back from ${iso}`);
  }
});

test('labels compute the weekday, never guess it', () => {
  assert.equal(longDay('2026-10-21'), 'Wednesday, October 21');
  assert.equal(longDay('2027-07-23'), 'Friday, July 23');
  assert.equal(clockTime('15:00'), '3:00 PM');
  assert.equal(clockTime('00:30'), '12:30 AM');
  assert.equal(clockTime('12:00'), '12:00 PM');
  assert.equal(whenLabel('2026-11-20', '15:00'), 'Friday, November 20 at 3:00 PM');
  assert.equal(whenLabel('2026-11-20', null), 'Friday, November 20 (time not set yet)');
  assert.equal(daysBetween('2026-10-16', '2026-10-27'), 11);
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2, 'across the clock change');
});

test('echo keys match what the JobTread workflows send', () => {
  assert.equal(taskKey('2027-07-22', '10:00:00.000'), '2027-07-22 10:00');
  assert.equal(taskKey('2027-07-22', '10:00'), '2027-07-22 10:00');
  assert.equal(taskKey('2026-11-06', 'null'), '2026-11-06');
  assert.equal(fieldKey('2027-07-23T19:30:00.000Z'), '2027-07-23T19:30:00.000Z');
  assert.equal(fieldKey('2027-07-23T19:30:00Z'), '2027-07-23T19:30:00.000Z');
  assert.equal(fieldKey('null'), '');
  assert.equal(fieldKey('not a date'), '');
});

// ── Who wins ────────────────────────────────────────────────────────────────

test('not confirmed: a task move is copied to the field', async () => {
  const { sync, job, jt } = await setup({ field: '2026-11-18T20:00:00.000Z' });
  const r = await sync({ source: 'task', taskStartDate: '2026-11-20', taskStartTime: '15:00:00.000' });
  assert.equal(r.action, 'task-to-field');
  assert.equal(job.fields[FIELD_REVEAL_DATE], '2026-11-20T20:00:00.000Z');
  assert.equal(jt.state.comments.length, 0);
});

test('not confirmed: a field change moves the task, quietly, keeping an hour block', async () => {
  const { sync, job, jt } = await setup({ field: '2026-11-24T19:00:00.000Z' });
  const r = await sync({ source: 'field', revealDate: '2026-11-24T19:00:00.000Z' });
  assert.equal(r.action, 'field-to-task');
  const update = jt.state.calls.find(c => c.updateTask).updateTask;
  assert.equal(update.notify, false, 'JobTread notifies assignees by default');
  assert.deepEqual(
    { startDate: update.startDate, startTime: update.startTime, endDate: update.endDate, endTime: update.endTime },
    { startDate: '2026-11-24', startTime: '14:00', endDate: '2026-11-24', endTime: '15:00' },
  );
  assert.equal(job.reveals[0].startDate, '2026-11-24');
});

test('a task with a longer block on the same day keeps its end time', async () => {
  const { sync, jt } = await setup({
    field: '2026-11-20T19:00:00.000Z', // 2 PM
    reveals: [{ id: 'rt1', startDate: '2026-11-20', startTime: '15:00:00.000', endDate: '2026-11-20', endTime: '17:30:00.000' }],
  });
  await sync({ source: 'field', revealDate: '2026-11-20T19:00:00.000Z' });
  const update = jt.state.calls.find(c => c.updateTask).updateTask;
  assert.equal(update.startTime, '14:00');
  assert.equal(update.endTime, '17:30');
});

test('midnight in the field means no time: the task becomes all day', async () => {
  const { sync, jt, job } = await setup({ field: '2026-12-02T05:00:00.000Z' });
  await sync({ source: 'field', revealDate: '2026-12-02T05:00:00.000Z' });
  const update = jt.state.calls.find(c => c.updateTask).updateTask;
  assert.equal(update.startDate, '2026-12-02');
  assert.equal(update.startTime, null);
  assert.equal(update.endTime, null);
  assert.equal(job.reveals[0].startDate, '2026-12-02');
});

test('a task with no time writes midnight Eastern to the field', async () => {
  const { sync, job } = await setup({
    field: '2026-11-20T20:00:00.000Z',
    reveals: [{ id: 'rt1', startDate: '2026-11-06', startTime: null }],
  });
  await sync({ source: 'task', taskStartDate: '2026-11-06', taskStartTime: 'null' });
  assert.equal(job.fields[FIELD_REVEAL_DATE], '2026-11-06T05:00:00.000Z');
});

test('one side empty: the side with a date fills it, whichever changed', async () => {
  let s = await setup({ field: null });
  assert.equal((await s.sync({ source: 'field', revealDate: 'null' })).action, 'task-to-field');
  assert.equal(s.job.fields[FIELD_REVEAL_DATE], '2026-11-20T20:00:00.000Z');

  s = await setup({ field: '2026-11-24T19:00:00.000Z', reveals: [{ id: 'rt1', startDate: null, startTime: null }] });
  assert.equal((await s.sync({ source: 'task', taskStartDate: 'null', taskStartTime: 'null' })).action, 'field-to-task');
  assert.equal(s.job.reveals[0].startDate, '2026-11-24');
});

test('confirmed: the field is the authority and a schedule shift is put back, with a note', async () => {
  // Field says Nov 20 at 3 PM; JobTread pushed the task to Nov 23 because an earlier task slipped
  const { sync, job, jt } = await setup({
    field: '2026-11-20T20:00:00.000Z', confirmed: true,
    reveals: [{ id: 'rt1', startDate: '2026-11-23', startTime: '15:00:00.000', endDate: '2026-11-23', endTime: '16:00:00.000' }],
  });
  const r = await sync({ source: 'task', taskStartDate: '2026-11-23', taskStartTime: '15:00:00.000' });
  assert.equal(r.action, 'snapped-back');
  assert.equal(job.reveals[0].startDate, '2026-11-20');
  assert.equal(job.fields[FIELD_REVEAL_DATE], '2026-11-20T20:00:00.000Z', 'field untouched');
  assert.equal(jt.state.comments.length, 1);
  const c = jt.state.comments[0];
  assert.equal(c.name, 'Reveal date sync (automatic)');
  assert.equal(c.message, 'This reveal is confirmed for Friday, November 20 at 3:00 PM. The schedule moved it to Monday, November 23 at 3:00 PM, usually because an earlier task moved. I put it back. To reschedule a confirmed reveal, change the Reveal Date field.');
  assert.deepEqual([c.isVisibleToInternalRoles, c.isVisibleToCustomerRoles, c.isVisibleToVendorRoles], [true, false, false], 'never visible to the family');
});

test('confirmed: changing the field reschedules the task, no note', async () => {
  const { sync, job, jt } = await setup({ field: '2026-11-21T15:00:00.000Z', confirmed: true });
  const r = await sync({ source: 'field', revealDate: '2026-11-21T15:00:00.000Z' });
  assert.equal(r.action, 'field-to-task');
  assert.deepEqual([job.reveals[0].startDate, job.reveals[0].startTime], ['2026-11-21', '10:00']);
  assert.equal(jt.state.comments.length, 0);
});

// ── Echoes ──────────────────────────────────────────────────────────────────

test('our own write coming back is ignored, and a person\'s quick second edit still counts', async () => {
  const { sync, job, jt } = await setup({ field: '2026-11-18T20:00:00.000Z' });
  await sync({ source: 'task', taskStartDate: '2026-11-20', taskStartTime: '15:00:00.000' });
  assert.equal(job.fields[FIELD_REVEAL_DATE], '2026-11-20T20:00:00.000Z');

  // JobTread's field workflow fires for the value we just wrote
  const before = jt.state.calls.length;
  assert.equal((await sync({ source: 'field', revealDate: '2026-11-20T20:00:00.000Z' }, NOW + 20_000)).action, 'echo');
  assert.equal(jt.state.calls.length, before, 'no writes for an echo');

  // A minute later Clareece edits the field herself: that is not an echo
  job.fields[FIELD_REVEAL_DATE] = '2026-11-20T21:00:00.000Z';
  const r = await sync({ source: 'field', revealDate: '2026-11-20T21:00:00.000Z' }, NOW + 60_000);
  assert.equal(r.action, 'field-to-task');
  assert.equal(job.reveals[0].startTime, '16:00');
});

test('the echo of a task write matches JobTread\'s "10:00:00.000" time format', async () => {
  const { sync } = await setup({ field: '2026-11-24T19:00:00.000Z' });
  await sync({ source: 'field', revealDate: '2026-11-24T19:00:00.000Z' });
  assert.equal((await sync({ source: 'task', taskStartDate: '2026-11-24', taskStartTime: '14:00:00.000' }, NOW + 15_000)).action, 'echo');
});

test('an old remembered write isn\'t mistaken for an echo', async () => {
  const { sync, job } = await setup({ field: '2026-11-18T20:00:00.000Z' });
  await sync({ source: 'task', taskStartDate: '2026-11-20', taskStartTime: '15:00:00.000' });
  // Same value arrives 20 minutes later: re-checked against JobTread instead (already in sync)
  const r = await sync({ source: 'field', revealDate: '2026-11-20T20:00:00.000Z' }, NOW + 20 * 60_000);
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'already in sync');
  assert.equal(job.fields[FIELD_REVEAL_DATE], '2026-11-20T20:00:00.000Z');
});

// ── Can't sync: say so once ─────────────────────────────────────────────────

test('no Reveal task: one note, not one per change', async () => {
  const { sync, jt } = await setup({ field: '2026-11-20T20:00:00.000Z', reveals: [] });
  assert.equal((await sync({ source: 'field', revealDate: '2026-11-20T20:00:00.000Z' })).action, 'noted');
  assert.equal((await sync({ source: 'field', revealDate: '2026-11-20T20:00:00.000Z' }, NOW + 3600_000)).action, 'none');
  assert.equal(jt.state.comments.length, 1);
  assert.match(jt.state.comments[0].message, /no Reveal task/);
});

test('no Reveal task and no Reveal Date: nothing to sync, no note', async () => {
  const { sync, jt } = await setup({ field: null, reveals: [] });
  const r = await sync({ source: 'field', revealDate: 'null' });
  assert.deepEqual([r.action, r.reason], ['none', 'no Reveal task and no Reveal Date']);
  assert.equal(jt.state.comments.length, 0);
});

test('several open Reveal tasks: a note naming the problem', async () => {
  const { sync, jt } = await setup({
    field: '2026-11-20T20:00:00.000Z',
    reveals: [{ id: 'a', startDate: '2026-11-20' }, { id: 'b', startDate: '2026-11-21' }],
  });
  assert.equal((await sync({ source: 'task', taskStartDate: '2026-11-21' })).action, 'noted');
  assert.match(jt.state.comments[0].message, /2 open Reveal tasks/);
});

test('nothing to do', () => {
  const job = (o = {}) => ({
    id: JOB, organization: { id: '22NJw42j5GLg' },
    customFieldValues: { nodes: [{ value: '2026-11-20T20:00:00.000Z', customField: { id: FIELD_REVEAL_DATE } }] },
    tasks: { nodes: [{ id: 'rt1', startDate: '2026-11-20', startTime: '15:00:00.000', progress: null }] },
    ...o,
  });
  assert.equal(planSync(job(), 'task').reason, 'already in sync');
  assert.equal(planSync(job({ organization: { id: 'someone-else' } }), 'task').reason, 'not a SOARD job');
  assert.equal(planSync(job({ tasks: { nodes: [{ id: 'rt1', startDate: '2026-10-07', progress: 1 }] } }), 'task').reason, 'the reveal is marked complete');
  assert.equal(planSync(null, 'task').reason, 'job not found');
  assert.equal(planSync(job({ customFieldValues: { nodes: [] }, tasks: { nodes: [{ id: 'rt1', startDate: null }] } }), 'task').reason, 'no date on either side');
});
