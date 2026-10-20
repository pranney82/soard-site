/**
 * Kid status follows JobTread (functions/api/_kid-status.js): the mapping,
 * hiding and showing again, saves that read like an admin save, the
 * auto-deploy cooldown, and the admin's view of each kid's JobTread status.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { siteStatusFor, planKid, jobFacts, syncKidStatuses, maybeSyncKidStatuses, FIELD_STATUS, REVEAL_TASK_TYPE, SYNC_USER } from '../functions/api/_kid-status.js';
import { buildAdminView } from '../functions/api/reveals-admin.js';

const job = (id, name, status, { revealDone = null, closedOn = null } = {}) => ({
  id, name, closedOn,
  customFieldValues: { nodes: status ? [{ value: status, customField: { id: FIELD_STATUS } }] : [] },
  tasks: { nodes: revealDone === null ? [] : [{ progress: revealDone ? 1 : 0.5 }] },
});

test('JobTread Status → the site', () => {
  const s = (status, revealDone = false) => siteStatusFor({ status, revealDone });
  assert.deepEqual(s('Awaiting Funding'), { status: 'needs-funding', hide: null });
  for (const v of ['Design', 'Finalization', 'Approval', 'Mobilization', 'Build']) assert.deepEqual(s(v), { status: 'in-progress', hide: null }, v);
  for (const v of ['Closed Done', 'Warranty']) assert.deepEqual(s(v), { status: 'completed', hide: null }, v);
  assert.deepEqual(s('Build', true), { status: 'completed', hide: null }, 'the Reveal task done means completed, whatever the Status says');
  assert.deepEqual(s('On Site'), { status: null, hide: 'on-site' });
  assert.deepEqual(s('Denied'), { status: null, hide: 'denied' });
  assert.deepEqual(s('Denied', true), { status: null, hide: 'denied' }, 'Denied still hides');
  assert.deepEqual(s(''), { status: null, hide: null }, 'no Status leaves the kid alone');
  assert.deepEqual(siteStatusFor({ status: 'Denied', closed: true }), { status: null, hide: null }, 'a closed job never hides a profile');
  assert.deepEqual(jobFacts(job('j', 'X (2026)', 'Build', { revealDone: true })), { status: 'Build', revealDone: true, closed: false });
  assert.deepEqual(jobFacts(job('j', 'X (2026)', 'Build')), { status: 'Build', revealDone: false, closed: false }, 'no Reveal task is not done');
});

test('hiding and showing again: only what the sync hid comes back', () => {
  const kid = { name: 'Ava', status: 'in-progress', publishStatus: 'published' };
  assert.equal(planKid(kid, { status: 'Build' }), null, 'already right: nothing to save');
  assert.deepEqual(planKid(kid, { status: 'Build', revealDone: true }).next, { ...kid, status: 'completed' });
  const hidden = planKid(kid, { status: 'Denied' });
  assert.deepEqual([hidden.next.publishStatus, hidden.next.hiddenBy, hidden.next.status, hidden.hide], ['draft', 'jobtread', 'in-progress', 'denied']);
  const back = planKid(hidden.next, { status: 'Awaiting Funding' }).next;
  assert.deepEqual([back.publishStatus, 'hiddenBy' in back, back.status], ['published', false, 'needs-funding']);
  // Staff hid it themselves: JobTread neither hides it again nor shows it
  const staffDraft = { name: 'Bo', status: 'in-progress', publishStatus: 'draft' };
  assert.equal(planKid(staffDraft, { status: 'Denied' }), null);
  assert.deepEqual(planKid(staffDraft, { status: 'Build', revealDone: true }).next, { ...staffDraft, status: 'completed' });
});

async function world(kids) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const k of kids) {
    await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(k.slug, k.name, k.year, k.status, JSON.stringify(k)).run();
  }
  return DB;
}
const jtFetch = (jobs) => async (url, init) => {
  const q = JSON.parse(init.body).query;
  if (q.job) return Response.json({ job: jobs.find((j) => j.id === q.job.$.id) || null });
  return Response.json({ organization: { jobs: { nextPage: null, nodes: jobs } } });
};
const row = async (DB, slug) => JSON.parse((await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first()).data);

test('a sweep brings kids in line, saved like an admin save, then publishes', async (t) => {
  const hooks = [];
  t.mock.method(globalThis, 'fetch', async (url) => { hooks.push(String(url)); return new Response('ok'); });
  const DB = await world([
    { slug: 'max', name: 'Max', year: 2026, status: 'in-progress', publishStatus: 'published' },
    { slug: 'colin', name: 'Colin', year: 2026, status: 'in-progress', publishStatus: 'published' },
    { slug: 'jackson', name: 'Jackson', year: 2026, status: 'in-progress', publishStatus: 'published' },
    { slug: 'kendall', name: 'Kendall', year: 2025, status: 'completed', publishStatus: 'published' },
    { slug: 'old', name: 'Old', year: 2015, status: 'completed', publishStatus: 'published' },
  ]);
  const jobs = [
    job('j1', 'Max Sample (2026)', 'Build', { revealDone: true }),
    job('j2', 'Colin Lindsay (2026)', 'Build', { revealDone: false }),
    job('j3', 'Jackson Getbehead (2026)', 'Awaiting Funding'),
    job('j4', 'Kendall Thomas (2025)', 'Denied'),
    job('j5', 'Somebody Else (2026)', 'Design'),
    job('t1', 'TEST Colin Lindsay (2026)', 'Denied'),
  ];
  const env = { DB, JOBTREAD_GRANT_KEY: 'k', CF_PAGES_DEPLOY_HOOK: 'https://hook.example/deploy' };
  const out = await syncKidStatuses(env, { fetchImpl: jtFetch(jobs), now: Date.parse('2026-10-20T15:00:00Z') });
  assert.deepEqual(out.map((o) => o.slug).sort(), ['jackson', 'kendall', 'max']);
  assert.equal((await row(DB, 'max')).status, 'completed', 'Reveal task done: completed');
  assert.equal((await row(DB, 'colin')).status, 'in-progress', 'unchanged');
  assert.equal((await row(DB, 'jackson')).status, 'needs-funding');
  assert.deepEqual([(await row(DB, 'kendall')).publishStatus, (await row(DB, 'kendall')).hiddenBy], ['draft', 'jobtread']);
  assert.equal((await row(DB, 'old')).status, 'completed', 'a kid without a job is left to the admin');
  const col = await DB.prepare("SELECT status FROM kids WHERE slug = 'jackson'").first();
  assert.equal(col.status, 'needs-funding', 'the indexed column follows');
  const audit = (await DB.prepare("SELECT user_email, action, entity_slug FROM audit_log WHERE entity_type = 'kids' ORDER BY id").all()).results;
  assert.deepEqual(audit.map((a) => [a.user_email, a.entity_slug]).sort(), [[SYNC_USER, 'jackson'], [SYNC_USER, 'kendall'], [SYNC_USER, 'max']]);
  assert.equal(audit.find((a) => a.entity_slug === 'kendall').action, 'drafted');
  const versions = (await DB.prepare("SELECT slug, user_email FROM content_versions WHERE collection = 'kids' AND user_email IS NOT NULL").all()).results;
  assert.equal(versions.length, 3, 'History keeps each change');
  assert.deepEqual(hooks, ['https://hook.example/deploy'], 'one deploy for the lot');

  // A change ten minutes inside the cooldown waits; the next wake-up after it publishes
  jobs[1] = job('j2', 'Colin Lindsay (2026)', 'Closed Done');
  await syncKidStatuses(env, { jobId: 'j2', fetchImpl: jtFetch(jobs), now: Date.parse('2026-10-20T15:05:00Z') });
  assert.equal((await row(DB, 'colin')).status, 'completed');
  assert.equal(hooks.length, 1, 'held back by the cooldown');
  await maybeSyncKidStatuses(env, { fetchImpl: jtFetch(jobs), now: Date.parse('2026-10-20T15:11:00Z') });
  assert.equal(hooks.length, 2, 'published once the cooldown passed');

  // Denied again later: still hidden, no second heads-up; back to Awaiting Funding: shown again
  const state = async () => JSON.parse((await DB.prepare("SELECT value FROM kid_status_state WHERE key = 'state'").first()).value);
  assert.ok((await state()).alerted.kendall, 'the Denied heads-up is remembered');
  jobs[3] = job('j4', 'Kendall Thomas (2025)', 'Awaiting Funding');
  await syncKidStatuses(env, { jobId: 'j4', fetchImpl: jtFetch(jobs), now: Date.parse('2026-10-20T16:00:00Z') });
  const k = await row(DB, 'kendall');
  assert.deepEqual([k.publishStatus, 'hiddenBy' in k, k.status], ['published', false, 'needs-funding']);
  assert.equal((await state()).alerted.kendall, undefined);
});

test('the sweep runs hourly; nothing to do, no deploy', async (t) => {
  const hooks = [];
  t.mock.method(globalThis, 'fetch', async (url) => { hooks.push(String(url)); return new Response('ok'); });
  const DB = await world([{ slug: 'max', name: 'Max', year: 2026, status: 'completed', publishStatus: 'published' }]);
  const env = { DB, JOBTREAD_GRANT_KEY: 'k', CF_PAGES_DEPLOY_HOOK: 'https://hook.example/deploy' };
  const jobs = [job('j1', 'Max Sample (2026)', 'Closed Done')];
  const t0 = Date.parse('2026-10-20T12:00:00Z');
  assert.deepEqual(await maybeSyncKidStatuses(env, { fetchImpl: jtFetch(jobs), now: t0 }), []);
  assert.equal(await maybeSyncKidStatuses(env, { fetchImpl: jtFetch(jobs), now: t0 + 30 * 60e3 }), null, 'not due yet');
  assert.deepEqual(await maybeSyncKidStatuses(env, { fetchImpl: jtFetch(jobs), now: t0 + 61 * 60e3 }), []);
  assert.deepEqual(hooks, []);
  assert.deepEqual(await syncKidStatuses({ DB }, {}), [], 'without the JobTread key it does nothing');
});

test('the admin sees each linked kid’s JobTread status, hidden kids included', () => {
  const kids = [{ slug: 'max', name: 'Max', year: 2026 }, { slug: 'kendall', name: 'Kendall', year: 2025 }];
  const { jobs, statuses } = buildAdminView([
    job('old', 'Max Sample (2026)', 'Closed Done', { closedOn: '2026-01-01' }),
    job('j1', 'Max Sample (2026)', 'Build'),
    job('j4', 'Kendall Thomas (2025)', 'Denied'),
  ], kids);
  assert.deepEqual(jobs, { max: 'j1', kendall: 'j4' }, 'the open job wins');
  assert.deepEqual(statuses, { max: 'Build', kendall: 'Denied' });
});

test('the Reveal task query asks for the Reveal task type', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body).query); return Response.json({ job: null }); };
  const DB = await world([]);
  await syncKidStatuses({ DB, JOBTREAD_GRANT_KEY: 'k' }, { jobId: 'abc123', fetchImpl });
  assert.deepEqual(seen[0].job.tasks.$.where, [['taskType', 'id'], '=', REVEAL_TASK_TYPE]);
});

test('the sweep asks for a jobs page JobTread accepts (no 413)', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body).query); return Response.json({ organization: { jobs: { nextPage: null, nodes: [] } } }); };
  await syncKidStatuses({ DB: await world([]), JOBTREAD_GRANT_KEY: 'k' }, { fetchImpl });
  const jobs = seen[0].organization.jobs;
  assert.deepEqual(jobs.nodes.customFieldValues.$.where, [['customField', 'id'], '=', FIELD_STATUS], 'only the Status field');
  // 100 jobs × (50 fields + 20 tasks) was refused in production; reveals-admin's 100 × 50 is accepted
  const worst = jobs.$.size * (jobs.nodes.customFieldValues.$.size + jobs.nodes.tasks.$.size);
  assert.ok(worst <= 5000, `worst case ${worst} stays within what JobTread accepts`);
});

test('a JobTread failure is remembered for Site → Automations, and the next success clears it', async () => {
  const DB = await world([{ slug: 'max', name: 'Max', year: 2026, status: 'completed', publishStatus: 'published' }]);
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  const state = async () => JSON.parse((await DB.prepare("SELECT value FROM kid_status_state WHERE key = 'state'").first()).value);
  await syncKidStatuses(env, { fetchImpl: async () => new Response('Request Entity Too Large', { status: 413 }), now: Date.parse('2026-10-20T16:54:47Z') });
  let s = await state();
  assert.equal(s.lastError.at, '2026-10-20T16:54:47.000Z');
  assert.match(s.lastError.error, /413/);
  assert.equal(s.lastRun, undefined, 'no run is recorded');
  await syncKidStatuses(env, { fetchImpl: jtFetch([job('j1', 'Max Sample (2026)', 'Closed Done')]), now: Date.parse('2026-10-20T17:54:47Z') });
  s = await state();
  assert.equal(s.lastRun.at, '2026-10-20T17:54:47.000Z', 'the next run is recorded after the error, so the map shows it working again');
});
