/**
 * Kid status follows JobTread (functions/api/_kid-status.js): the mapping,
 * hiding and showing again, saves that read like an admin save, the
 * auto-deploy cooldown, and the admin's view of each kid's JobTread status.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { siteStatusFor, planKid, planProject, jobFacts, syncKidStatuses, maybeSyncKidStatuses, deniedAlert, FIELD_STATUS, REVEAL_TASK_TYPE, SYNC_USER } from '../functions/api/_kid-status.js';
import { buildAdminView } from '../functions/api/reveals-admin.js';

const SOARD = '22NJw42j5GLg';
const job = (id, name, status, { revealDone = null, closedOn = null, org = SOARD } = {}) => ({
  id, name, closedOn, organization: { id: org },
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

test('a community project follows its job: In progress, then Completed; only Denied hides it', () => {
  const p = { name: 'Perfect Harmony Health', status: 'in-progress', publishStatus: 'published' };
  assert.equal(planProject(p, { status: 'Build' }), null, 'already in progress');
  assert.equal(planProject(p, { status: 'Awaiting Funding' }), null, 'a project has no Awaiting funding: still in progress');
  assert.equal(planProject(p, { status: 'On Site' }), null, 'organizations’ jobs often sit at On Site: the page stays');
  assert.deepEqual(planProject(p, { status: 'Closed Done' }).next, { ...p, status: 'completed' });
  assert.deepEqual(planProject(p, { status: 'Build', revealDone: true }).next, { ...p, status: 'completed' }, 'Reveal task done');
  const hidden = planProject(p, { status: 'Denied' });
  assert.deepEqual([hidden.next.publishStatus, hidden.next.hiddenBy, hidden.hide], ['draft', 'jobtread', 'denied']);
  assert.deepEqual(planProject(hidden.next, { status: 'Build' }).next, p, 'back once the job moves on');
  const staffDraft = { ...p, publishStatus: 'draft' };
  assert.deepEqual(planProject(staffDraft, { status: 'Closed Done' }).next, { ...staffDraft, status: 'completed' }, 'a staff draft stays a draft');
  // Going back from Completed: only the job the project is linked to, and only while it's open
  const done = { name: 'Camp Twin Lakes', status: 'completed', publishStatus: 'published' };
  assert.equal(planProject(done, { status: 'Build' }), null, 'matched by name: an old job left open never reopens a finished project');
  const linked = { ...done, jobtreadJobId: 'J9' };
  assert.deepEqual(planProject(linked, { status: 'Build' }).next, { ...linked, status: 'in-progress' }, 'its own job reopened');
  assert.equal(planProject(linked, { status: 'Build', closed: true }), null, 'a closed job only confirms Completed');
  assert.equal(planProject({ name: 'Old', publishStatus: 'published' }, { status: 'Closed Done' }), null, 'no status is Completed already');
  const words = deniedAlert({ kid: { name: 'Perfect Harmony Health' }, jobId: 'J1', project: true });
  assert.match(words.title, /Perfect Harmony Health’s page is hidden/);
  assert.match(words.detail, /off the Community page/);
  assert.match(words.admin, /#kids\/community$/);
  assert.match(deniedAlert({ kid: { name: 'Max' }, jobId: 'J1' }).title, /Max’s profile is hidden/, 'kids read as before');
});

test('a sweep brings community projects in line too, next to the kids, and their jobs get the project’s photo', async (t) => {
  const hooks = [];
  t.mock.method(globalThis, 'fetch', async (url) => { hooks.push(String(url)); return new Response('ok'); });
  const DB = await world([{ slug: 'grace', name: 'Grace', year: 2026, status: 'in-progress', publishStatus: 'published' }]);
  const add = (p) => DB.prepare('INSERT INTO community (slug, name, order_num, data) VALUES (?, ?, 0, ?)').bind(p.slug, p.name, JSON.stringify(p)).run();
  await add({ slug: 'perfect-harmony-health', name: 'Perfect Harmony Health', year: '2026', status: 'in-progress', publishStatus: 'published',
    heroImage: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/community/php/1.jpg/public', photos: [{ url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/community/php/1.jpg/public', alt: '' }] });
  await add({ slug: 'the-lionheart-school', name: 'The Lionheart School', year: '2026', status: 'in-progress', publishStatus: 'draft', jobtreadJobId: 'jLion' });
  await add({ slug: 'childrens-development-academy', name: 'Children’s Development Academy', year: '2025 - 2026', status: 'in-progress', publishStatus: 'published' });
  await add({ slug: 'grace-academy', name: 'Grace Academy', year: '2026', status: 'in-progress', publishStatus: 'published' });
  await add({ slug: 'camp-twin-lakes', name: 'Camp Twin Lakes', year: '2018', status: 'completed', publishStatus: 'published' });
  const jobs = [
    job('jPHH', 'Perfect Harmony Health (2026)', 'Closed Done'),
    job('jLion', 'The Lionheart School', 'On Site'),
    job('jCDA', 'Childrens Development Academy (2025)', 'Build', { revealDone: true }),
    job('jGA', 'Grace Academy (2026)', 'Closed Done'),
    job('jCamp', 'Camp Twin Lakes (2018)', 'Build'),
  ];
  const covers = [];
  const jt = async (url, init) => {
    const q = JSON.parse(init.body).query;
    if (q.updateJob || q.createUploadRequest) { covers.push(q); return Response.json(q.createUploadRequest ? { createUploadRequest: { createdUploadRequest: { id: 'up1' } } } : { updateJob: {} }); }
    return jtFetch(jobs)(url, init);
  };
  const env = { DB, JOBTREAD_GRANT_KEY: 'k', CF_PAGES_DEPLOY_HOOK: 'https://hook.example/deploy' };
  const out = await syncKidStatuses(env, { fetchImpl: jt, now: Date.parse('2026-10-20T15:00:00Z') });
  assert.deepEqual(out.map((o) => [o.slug, o.kind]).sort(), [['childrens-development-academy', 'community'], ['grace-academy', 'community'], ['perfect-harmony-health', 'community']]);
  const proj = async (slug) => JSON.parse((await DB.prepare('SELECT data FROM community WHERE slug = ?').bind(slug).first()).data);
  assert.equal((await proj('perfect-harmony-health')).status, 'completed', 'its job is Closed Done');
  assert.equal((await proj('childrens-development-academy')).status, 'completed', 'a "2025 - 2026" project matches its 2025 job');
  assert.equal((await proj('grace-academy')).status, 'completed', '"Grace Academy (2026)" is the academy’s, not the kid Grace’s');
  assert.equal((await row(DB, 'grace')).status, 'in-progress', 'the kid Grace is left alone');
  assert.deepEqual([(await proj('the-lionheart-school')).publishStatus, (await proj('the-lionheart-school')).status], ['draft', 'in-progress'], 'On Site leaves the draft as it is');
  assert.equal((await proj('camp-twin-lakes')).status, 'completed', 'an old job left open doesn’t reopen it');
  const audit = (await DB.prepare("SELECT user_email, entity_type, entity_slug FROM audit_log WHERE entity_type = 'community'").all()).results;
  assert.equal(audit.length, 3, 'saved like an admin save');
  assert.ok(audit.every((a) => a.user_email === SYNC_USER));
  const versions = (await DB.prepare("SELECT slug FROM content_versions WHERE collection = 'community' AND user_email IS NOT NULL").all()).results;
  assert.equal(versions.length, 3, 'History keeps each change');
  assert.deepEqual(hooks, ['https://hook.example/deploy'], 'and the site publishes');
  const cover = await DB.prepare("SELECT slug, source FROM job_covers WHERE job_id = 'jPHH'").first();
  assert.equal(cover?.slug, 'community/perfect-harmony-health', 'the project’s Main photo is its job’s cover');
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

test('a wake-up for one job only counts a SOARD job: another org, or no org at all, changes nothing', async () => {
  for (const organization of [{ id: 'someOtherOrg' }, null, undefined]) {
    const DB = await world([{ slug: 'max', name: 'Max', year: 2026, status: 'in-progress', publishStatus: 'published' }]);
    const seen = [];
    const theirs = { ...job('j1', 'Max Sample (2026)', 'Denied'), organization };
    const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body).query); return Response.json({ job: theirs }); };
    assert.deepEqual(await syncKidStatuses({ DB, JOBTREAD_GRANT_KEY: 'k' }, { jobId: 'j1', fetchImpl }), [], JSON.stringify(organization));
    assert.deepEqual(seen[0].job.organization, { id: {} }, 'the job read asks whose it is');
    assert.equal((await row(DB, 'max')).publishStatus, 'published', 'not hidden');
  }
  // The same job, SOARD's: Denied hides it
  const DB = await world([{ slug: 'max', name: 'Max', year: 2026, status: 'in-progress', publishStatus: 'published' }]);
  const out = await syncKidStatuses({ DB, JOBTREAD_GRANT_KEY: 'k' }, { jobId: 'j1', fetchImpl: jtFetch([job('j1', 'Max Sample (2026)', 'Denied')]) });
  assert.equal(out.length, 1);
  assert.equal((await row(DB, 'max')).publishStatus, 'draft');
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
