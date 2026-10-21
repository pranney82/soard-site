/**
 * Reveal date sync (functions/api/_reveal-sync.js) and the Eastern ↔ UTC
 * helpers it relies on (functions/api/_reveals.js)
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeJobTread } from './lib/fake-jobtread.mjs';
import { planSync, syncJob, wakeSync, taskKey, fieldKey, whenLabel } from '../functions/api/_reveal-sync.js';
import { easternToUtcIso, easternParts, longDay, clockTime, daysBetween, FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED } from '../functions/api/_reveals.js';
import * as route from '../functions/api/reveal-sync.js';

const NOW = Date.parse('2026-10-16T14:00:00Z');
const JOB = '22PTestJob001';
const ORG = '22NJw42j5GLg';
const SITE_GRANT = '22PgGhFHkmbz';
const REVEAL_TYPE = '22NZSbkR5rZw';
const MIN = 60_000;

function jobState({ field = null, confirmed = false, reveals } = {}) {
  return {
    id: JOB, name: 'Max Sample (2026)',
    fields: { [FIELD_REVEAL_DATE]: field, [FIELD_REVEAL_CONFIRMED]: confirmed ? 'Yes 👍' : null },
    reveals: reveals ?? [{ id: 'rt1', startDate: '2026-11-20', startTime: '15:00:00.000', endDate: '2026-11-20', endTime: '16:00:00.000' }],
  };
}

async function setup(opts) {
  const jt = fakeJobTread([jobState(opts)]);
  const env = { DB: await createD1(), JOBTREAD_GRANT_KEY: 'test-grant' };
  // JobTread's event log, for the wake-ups (the shared fake answers everything else)
  const events = {};
  const fetchImpl = async (url, init) => {
    const { query } = JSON.parse(init.body);
    if (query.event) return Response.json({ event: events[query.event.$.id] || null });
    return jt.fetchImpl(url, init);
  };
  const sync = (payload, now = NOW) => syncJob(env, { jobId: JOB, ...payload }, { fetchImpl, now });
  let n = 0;
  /** JobTread logs a change (a person's, unless `by` says otherwise); returns the event's id */
  const log = (kind, { at = NOW, by = 'personGrant', job = JOB, org = ORG, ...rest } = {}) => {
    const id = `evt${String(++n).padStart(6, '0')}`;
    const base = { id, createdAt: new Date(at).toISOString(), createdByGrantId: by, organization: { id: org }, job: { id: job }, task: null };
    events[id] = kind === 'task'
      ? { ...base, type: 'taskUpdated', task: { id: 'rt1', taskType: { id: REVEAL_TYPE } }, ...rest }
      : { ...base, type: 'jobUpdated', ...rest };
    return id;
  };
  /** The workflow's wake-up for a change */
  const wake = (eventId, now = NOW) => wakeSync(env, { jobId: JOB, eventId }, { fetchImpl, now });
  const writes = () => jt.state.calls.filter(c => c.updateJob || c.updateTask).length;
  return { jt, env, sync, log, wake, writes, fetchImpl, events, job: jt.job(JOB) };
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

// ── Wake-ups: JobTread's event decides, never the body ──────────────────────

test('which side changed comes from the JobTread event: a Reveal task event is the task, a job event the field', async () => {
  // The two sides disagree and nothing is confirmed, so the side that changed wins
  let s = await setup({ field: '2026-11-18T20:00:00.000Z' });
  let r = await s.wake(s.log('task'));
  assert.deepEqual([r.action, r.ran], ['task-to-field', true]);
  assert.equal(s.job.fields[FIELD_REVEAL_DATE], '2026-11-20T20:00:00.000Z');

  s = await setup({ field: '2026-11-18T20:00:00.000Z' });
  r = await s.wake(s.log('field'));
  assert.equal(r.action, 'field-to-task');
  assert.equal(s.job.reveals[0].startDate, '2026-11-18', 'the task follows the field');
  assert.equal(s.job.fields[FIELD_REVEAL_DATE], '2026-11-18T20:00:00.000Z', 'the field is untouched');
});

test('a wake-up that doesn\'t check out with JobTread does nothing', async () => {
  const s = await setup({ field: '2026-11-18T20:00:00.000Z' });
  // Each try a minute apart, so the per-job limit never answers for the check
  let t = NOW;
  const nothing = async (event, why) => {
    t += MIN;
    const eventId = typeof event === 'function' ? event(t) : event;
    const r = await s.wake(eventId, t);
    assert.deepEqual([r.action, r.ran], ['unverified', false], why);
  };
  await nothing('', 'no event id (a body with only a jobId and a source)');
  await nothing('evtNoSuchThing', 'an event JobTread never logged');
  await nothing((at) => s.log('task', { at, job: '22POtherJob01' }), 'another job\'s event');
  await nothing((at) => s.log('task', { at, org: 'someOtherOrg' }), 'another organization\'s event');
  await nothing((at) => s.log('task', { at, org: null }), 'an event that doesn\'t say whose it is');
  await nothing((at) => s.log('task', { at: at - 16 * MIN }), 'older than 15 minutes (a replay)');
  await nothing((at) => s.log('task', { at: at + 10 * MIN }), 'from the future');
  await nothing((at) => s.log('task', { at, task: { id: 'other', taskType: { id: 'notReveal' } } }), 'a task that isn\'t the Reveal task');
  await nothing((at) => s.log('task', { at, type: 'taskDeleted' }), 'not a create or update');
  await nothing((at) => s.log('task', { at, type: 'accountUpdated' }), 'not a job or task event');
  assert.equal(s.writes(), 0);
  assert.equal(s.job.fields[FIELD_REVEAL_DATE], '2026-11-18T20:00:00.000Z');
});

test('our own write coming back is an echo, and a person\'s quick second edit still counts', async () => {
  const s = await setup({ field: '2026-11-18T20:00:00.000Z' });
  await s.wake(s.log('task'));
  assert.equal(s.job.fields[FIELD_REVEAL_DATE], '2026-11-20T20:00:00.000Z');
  const before = s.writes();
  // JobTread logs our field write (made with the site's grant); a wake-up for it changes nothing
  const r = await s.wake(s.log('field', { by: SITE_GRANT, at: NOW + 20_000 }), NOW + 20_000);
  assert.deepEqual([r.action, r.ran], ['echo', false]);
  assert.equal(s.writes(), before, 'no writes for an echo');
  // A minute later Clareece edits the field herself: that is not an echo
  s.job.fields[FIELD_REVEAL_DATE] = '2026-11-20T21:00:00.000Z';
  assert.equal((await s.wake(s.log('field', { at: NOW + MIN }), NOW + MIN)).action, 'field-to-task');
  assert.equal(s.job.reveals[0].startTime, '16:00');
});

test('the same event twice (JobTread retrying, or a replay) is handled once', async () => {
  const s = await setup({ field: '2026-11-18T20:00:00.000Z' });
  const id = s.log('task');
  assert.equal((await s.wake(id)).action, 'task-to-field');
  // Someone moves the field back by hand; replaying the old task event mustn't undo that
  s.job.fields[FIELD_REVEAL_DATE] = '2026-11-18T20:00:00.000Z';
  const again = await s.wake(id, NOW + 2 * MIN);
  assert.deepEqual([again.action, again.ran], ['already handled', false]);
  assert.equal(s.job.fields[FIELD_REVEAL_DATE], '2026-11-18T20:00:00.000Z');
});

test('a flood of wake-ups for one job stops after six a minute (the weekday check settles the rest)', async () => {
  const s = await setup({ field: '2026-11-20T20:00:00.000Z' });
  const reads = () => s.jt.state.calls.length;
  const out = [];
  for (let i = 0; i < 9; i++) out.push((await s.wake(s.log('task'))).action);
  assert.deepEqual(out.slice(6), ['throttled', 'throttled', 'throttled']);
  assert.ok(out.slice(0, 6).every(a => a !== 'throttled'));
  // A minute on, it listens again
  assert.notEqual((await s.wake(s.log('task', { at: NOW + MIN + 1 }), NOW + MIN + 1)).action, 'throttled');
  assert.equal(reads(), 0, 'no writes: the sides already agreed');
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
  assert.equal(planSync(job({ organization: null }), 'task').reason, 'not a SOARD job', 'no organization is not SOARD\'s either');
  assert.equal(planSync(job({ organization: undefined }), 'task').reason, 'not a SOARD job');
  assert.equal(planSync(job({ tasks: { nodes: [{ id: 'rt1', startDate: '2026-10-07', progress: 1 }] } }), 'task').reason, 'the reveal is marked complete');
  assert.equal(planSync(null, 'task').reason, 'job not found');
  assert.equal(planSync(job({ customFieldValues: { nodes: [] }, tasks: { nodes: [{ id: 'rt1', startDate: null }] } }), 'task').reason, 'no date on either side');
});

// ── The public route ────────────────────────────────────────────────────────

async function callRoute(s, body, { url = 'https://x/api/reveal-sync', headers = {}, env = s.env, ip = '198.51.100.7' } = {}) {
  const waits = [];
  const real = globalThis.fetch;
  globalThis.fetch = s.fetchImpl;
  try {
    const res = await route.onRequestPost({ request: new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers }, body: JSON.stringify(body) }), env, waitUntil: (p) => waits.push(p) });
    await Promise.allSettled(waits);
    return { status: res.status, body: await res.json(), waits: waits.length };
  } finally {
    globalThis.fetch = real;
  }
}

test('the route: the shared secret when one is set, and { ok } is all it ever says', async () => {
  const s = await setup({ field: '2026-11-18T20:00:00.000Z' });
  const secured = { ...s.env, JOBTREAD_WEBHOOK_SECRET: 'wake-secret-example' };
  const id = s.log('task', { at: Date.now() });
  // Wrong or missing secret: refused before anything is read
  assert.equal((await callRoute(s, { jobId: JOB, eventId: id }, { env: secured })).status, 401);
  assert.equal((await callRoute(s, { jobId: JOB, eventId: id }, { env: secured, url: 'https://x/api/reveal-sync?key=nope' })).status, 401);
  assert.equal(s.writes(), 0);
  // The secret in the URL (or the X-Webhook-Secret header) lets it through
  const ok = await callRoute(s, { jobId: JOB, eventId: id, source: 'field' }, { env: secured, url: 'https://x/api/reveal-sync?key=wake-secret-example' });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }], 'no action, reason or dates in the answer');
  assert.equal(s.job.fields[FIELD_REVEAL_DATE], '2026-11-20T20:00:00.000Z', 'the event said task, so the body\'s "field" was ignored');
  assert.equal(ok.waits, 1, 'the countdown takes a look');
  const header = await callRoute(s, { jobId: JOB, eventId: s.log('field', { at: Date.now() }) }, { env: secured, headers: { 'X-Webhook-Secret': 'wake-secret-example' } });
  assert.equal(header.status, 200);
  // A forged body that names no real event: { ok: true }, nothing done, nothing said, no countdown check
  const forged = await callRoute(s, { jobId: JOB, source: 'field', revealDate: '2030-01-01T00:00:00Z' }, { env: secured, headers: { 'X-Webhook-Secret': 'wake-secret-example' } });
  assert.deepEqual([forged.status, forged.body, forged.waits], [200, { ok: true }, 0]);
  assert.equal((await callRoute(s, { jobId: 'bad id!' })).status, 400);
});

test('the route: junk from one address is cut off at 30 a minute and never counted, so a real wake-up still runs', async () => {
  const s = await setup({ field: '2026-11-18T20:00:00.000Z' });
  const count = async (key) => (await s.env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first())?.count || 0;
  const answers = [];
  for (let i = 0; i < 120; i++) answers.push((await callRoute(s, { jobId: JOB, eventId: `junk${String(i).padStart(6, '0')}`, source: 'field' }, { ip: '203.0.113.9' })).status);
  assert.equal(answers.filter((x) => x === 200).length, 30);
  assert.equal(answers.filter((x) => x === 429).length, 90, 'refused before JobTread is asked');
  // Spread over many addresses: none of it counts against the job or the site
  for (let i = 0; i < 150; i++) await callRoute(s, { jobId: JOB, eventId: `junkB${String(i).padStart(6, '0')}` }, { ip: `203.0.113.${10 + (i % 6)}` });
  assert.equal(await count(`reveal-sync:job:${JOB}`), 0);
  assert.equal(await count('reveal-sync:all'), 0);
  assert.equal(s.writes(), 0);
  // JobTread's real wake-up, from its own address, goes straight through
  const real = await callRoute(s, { jobId: JOB, eventId: s.log('task', { at: Date.now() }) });
  assert.deepEqual(real.body, { ok: true });
  assert.equal(s.job.fields[FIELD_REVEAL_DATE], '2026-11-20T20:00:00.000Z', 'the task\'s date reached the field');
  assert.equal(await count(`reveal-sync:job:${JOB}`), 1, 'only the real change counted');
});

test('a real change past the limits waits for a retry: it isn\'t marked as handled', async () => {
  const s = await setup({ field: '2026-11-20T20:00:00.000Z' });
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push(s.log('task'));
  const out = [];
  for (const id of ids) out.push((await s.wake(id)).action);
  assert.equal(out[6], 'throttled');
  // A minute on, JobTread retrying that same event is acted on
  assert.notEqual((await s.wake(ids[6], NOW + MIN + 1)).action, 'already handled');
});
