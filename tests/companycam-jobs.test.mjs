/**
 * CompanyCam photos on every job (functions/api/_companycam-jobs.js): a
 * job's sources (linked, its own photos' project, its name, the family's
 * second project at their address; never another job's, nor an earlier
 * makeover's), copying what it's missing without ever relinking, the hour
 * a linked project's photos wait, second copies counted (removed only with
 * DEDUPE), the webhook moving a job to the front, and Slack once a pass.
 * All names, addresses and ids are made up.
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { maybeCheckJobs, jobsFacts, nudgeJobsFor } from '../functions/api/_companycam-jobs.js';
import { takeEvent } from '../functions/api/_companycam-sync.js';

const T0 = Date.parse('2026-10-21T15:00:00Z');
const MIN = 60 * 1000;
const at = (m) => T0 + m * MIN;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let w; let env; let realFetch;

const newWorld = () => ({ jobs: new Map(), files: new Map(), projects: new Map(), photos: new Map(), writes: [], slack: [], next: 100, now: T0 });
const fid = () => `f${++w.next}`;

function jobtread(body) {
  const { $, ...rest } = body.query;
  const [op] = Object.keys(rest);
  const q = rest[op];
  if (op === 'organization' && q.jobs?.$?.where) {
    const ids = [].concat(q.jobs.$.where[2]).map(String);
    return json({ organization: { jobs: { nodes: [...w.jobs.values()].filter((j) => ids.includes(String(j.companycamId))).map((j) => ({ id: j.id, companycamId: j.companycamId })) } } });
  }
  if (op === 'organization') {
    return json({ organization: { jobs: { nextPage: null, nodes: [...w.jobs.values()].map((j) => ({ id: j.id, name: j.name, createdAt: j.createdAt, closedOn: j.closedOn || null, companycamId: j.companycamId || null, location: { street: j.street, account: { name: j.account } } })) } } });
  }
  if (op === 'job') {
    const files = [...w.files.values()].filter((f) => f.jobId === q.$.id);
    if (q.cc) return json({ job: { cc: { nextPage: null, nodes: files.filter((f) => f.name.startsWith('CompanyCam')).map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt, createdByUser: { name: f.by }, comments: { nodes: f.comments ? [{ id: 'c' }] : [] } })) } } });
    if (q.img) return json({ job: { img: { count: files.filter((f) => f.name.startsWith('IMG')).length } } });
  }
  w.writes.push({ op, args: q.$ });
  if (op === 'deleteFile') { w.files.delete(q.$.id); return json({}); }
  if (op === 'createUploadRequest') return json({ createUploadRequest: { createdUploadRequest: { id: `up${w.writes.length}` } } });
  if (op === 'createFile') { const id = fid(); w.files.set(id, { id, jobId: q.$.targetId, name: q.$.name, createdAt: new Date(w.now).toISOString(), by: null }); return json({ createFile: { createdFile: { id } } }); }
  throw new Error(`unexpected JobTread call ${op}`);
}

function companycam(url) {
  const path = url.pathname.replace('/public_api/v1', '');
  let m;
  const page = (data) => json({ data, errors: [], meta: { has_next: false } });
  if (path === '/projects') return page([...w.projects.values()].filter((p) => !!p.archived === (url.searchParams.get('archived') === 'true')));
  if ((m = path.match(/^\/projects\/(\d+)\/photos$/))) return page([...w.photos.values()].filter((p) => p.project_id === m[1]));
  if ((m = path.match(/^\/photos\/(\d+)$/))) return w.photos.has(m[1]) ? json({ data: w.photos.get(m[1]), errors: [], meta: {} }) : json({ data: {}, errors: [{ code: 'not_found', message: 'Not found' }], meta: {} }, 404);
  throw new Error(`unexpected CompanyCam call ${path}`);
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.href === 'https://api.jobtread.com/pave') return jobtread(JSON.parse(init.body));
  if (url.host === 'api.companycam.com') return companycam(url);
  if (url.host === 'slack.com') { const b = JSON.parse(init.body || '{}'); w.slack.push(b); return json({ ok: true, channel: b.channel, ts: `${w.slack.length}.1` }); }
  throw new Error(`unexpected fetch ${url.href}`);
}

const job = (id, name, { companycamId = null, street = '5 Sample Rd', closedOn = null, createdAt = '2026-02-11T00:00:00Z' } = {}) => w.jobs.set(id, { id, name, createdAt, companycamId, street, account: name, closedOn });
const project = (id, name, { street = '5 Sample Rd', created = '2026-02-11T00:00:00Z' } = {}) => w.projects.set(id, { id, name, address: { street_address_1: street }, archived: false, photo_count: 0, created_at: created });
function photo(id, projectId, { created = at(-24 * 60) } = {}) {
  w.photos.set(id, { id, project_id: projectId, status: 'active', processing_status: 'processed', created_at: new Date(created).toISOString(), uris: [{ type: 'original', url: `https://cdn.example.com/${id}.jpg` }] });
  w.projects.get(projectId).photo_count += 1;
}
const copy = (jobId, photoId, { by = 'CompanyCam', created = at(-60 * 24 * 30), comments = false } = {}) => { const id = fid(); w.files.set(id, { id, jobId, name: `CompanyCam ${photoId}`, createdAt: new Date(created).toISOString(), by, comments }); return id; };
const run = (m, o = {}) => { w.now = at(m); return maybeCheckJobs(env, { fetchImpl: fakeFetch, now: at(m), force: true, ...o }); };
const row = (jobId) => env.DB.prepare('SELECT * FROM companycam_jobs WHERE job_id = ?').bind(jobId).first();
const names = (jobId) => [...w.files.values()].filter((f) => f.jobId === jobId).map((f) => f.name).sort();

beforeEach(async () => {
  w = newWorld();
  env = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), JOBTREAD_GRANT_KEY: 'site-grant', COMPANYCAM_TOKEN: 'cc-token', SLACK_BOT_TOKEN: 'xoxb-test' };
  await writeSlackConfig(env.DB, { channel: { id: 'C0NEWS', name: 'team' }, attention: { id: 'C0ALERT', name: 'alerts' } });
  realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function twoJobs() {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  for (const id of ['3009001', '3009002']) { photo(id, '500'); copy('j1', id); }
  project('600', 'Ben Cole (2026) (020)', { street: '9 Other Ln' });
  job('j2', 'Ben Cole (2026)', { street: '9 Other Ln' });
  photo('3009101', '600'); copy('j2', '3009101'); // synced before JobTread's link dropped
  photo('3009102', '600'); photo('3009103', '600'); // taken since: never reached JobTread
}

test('only looking: each job’s sources found, what’s missing counted, nothing written, nobody told', async () => {
  twoJobs();
  job('j3', 'TEST Something (2027)');
  job('j4', 'Old Family (2024)', { closedOn: '2025-01-01' });
  await run(0, { copy: false });
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.slack, []);
  assert.deepEqual([(await row('j1')).found_by, (await row('j1')).missing], ['linked', 0]);
  const r2 = await row('j2');
  assert.deepEqual([r2.project_id, r2.found_by, r2.linked, r2.missing], ['600', 'its photos', 0, 2], 'its own earlier photo says which project');
  assert.equal(await row('j3'), null, 'TEST jobs aren’t looked at');
  assert.equal(await row('j4'), null, 'nor closed ones');
  const facts = await jobsFacts(env);
  assert.deepEqual([facts.audit.jobs, facts.audit.linked, facts.audit.missing], [2, 1, 2]);
  assert.deepEqual(facts.audit.missingBy, [{ job: 'Ben Cole (2026)', missing: 2 }]);
});

test('a job JobTread lost the link for gets its missing photos copied, under JobTread’s own name, and is never relinked', async () => {
  twoJobs();
  await run(0);
  assert.deepEqual(names('j2'), ['CompanyCam 3009101', 'CompanyCam 3009102', 'CompanyCam 3009103']);
  assert.ok(!w.writes.some((x) => x.op === 'updateJob'), 'no relink (it makes JobTread copy every photo again)');
  assert.equal((await row('j2')).missing, 0);
  const posts = w.slack.filter((s) => /copied into JobTread/.test(s.text || ''));
  assert.equal(posts.length, 1, 'one post for the pass');
  assert.match(JSON.stringify(posts[0].blocks), /Ben Cole \(2026\): 2/);
  await run(61);
  assert.equal(w.slack.filter((s) => /copied into JobTread/.test(s.text || '')).length, 1, 'nothing new, nothing posted');
});

test('a photo in the project JobTread is still linked to gets its hour first, so the two never race', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  photo('3009001', '500', { created: at(-10) });   // ten minutes old: JobTread's to bring
  photo('3009002', '500', { created: at(-120) });  // two hours old and still not there: the site's
  await run(0);
  assert.deepEqual(names('j1'), ['CompanyCam 3009002']);
  assert.equal((await row('j1')).missing, 1);
  await run(70);
  assert.deepEqual(names('j1'), ['CompanyCam 3009001', 'CompanyCam 3009002']);
});

test('the family’s photos in a second project at their address are copied too; nothing is relinked or archived', async () => {
  project('117', 'Lena Fox (2026) (024)'); // JobTread's, empty, and the one the job is linked to
  job('j11', 'Lena Fox (2026)', { companycamId: '117' });
  project('98', 'Elena Fox (2026) (024)'); // staff's, with the photos
  for (const id of ['3009401', '3009402']) photo(id, '98');
  copy('j11', '3009401'); // came in back when the job was linked to it
  await run(0);
  assert.deepEqual(names('j11'), ['CompanyCam 3009401', 'CompanyCam 3009402']);
  const sources = JSON.parse((await row('j11')).sources).map((s) => [s.id, s.why]);
  assert.deepEqual(sources, [['117', 'linked'], ['98', 'its photos']]);
  assert.ok(!w.writes.some((x) => x.op === 'updateJob'));
});

test('the second project is found by the family’s name and address even with no photos in JobTread yet', async () => {
  project('840', 'Jory Gale (2026) (023)'); // JobTread's, empty, unlinked now
  job('j12', 'Jory Gale (2026)');
  project('841', 'Jory 2026', { created: '2026-01-05T00:00:00Z' });
  photo('3009501', '841');
  await run(0);
  assert.deepEqual(names('j12'), ['CompanyCam 3009501']);
  assert.deepEqual(JSON.parse((await row('j12')).sources).map((s) => s.why), ['its name', 'same family, same address']);
});

test('never another job’s project, nor an earlier makeover’s at the same address, nor someone else’s', async () => {
  project('700', 'Cal Reed (2026) (021)');
  job('j5', 'Cal Reed (2026)');
  job('j6', 'Someone Else (2026)', { companycamId: '700', street: '1 Far Away' });
  photo('3009601', '700');
  project('701', 'Cal Reed (2023)', { created: '2023-03-01T00:00:00Z' }); // the house's earlier makeover
  photo('3009602', '701');
  project('702', 'Previous Owners', { created: '2026-02-01T00:00:00Z' });
  photo('3009603', '702');
  await run(0);
  assert.deepEqual(names('j5'), []);
  assert.equal((await row('j5')).problem, 'no-project');
});

test('second copies are counted; with DEDUPE the oldest stays, and one someone commented on is never touched', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  photo('3009001', '500');
  const first = copy('j1', '3009001', { created: at(-10000) });
  const second = copy('j1', '3009001', { created: at(-100) });
  photo('3009002', '500');
  copy('j1', '3009002', { created: at(-10000) });
  const talked = copy('j1', '3009002', { created: at(-50), comments: true });
  await run(0);
  assert.equal((await row('j1')).double_copies, 2);
  assert.ok(w.files.has(second), 'DEDUPE is off: nothing removed');
  await run(61, { dedupe: true });
  assert.ok(w.files.has(first) && !w.files.has(second));
  assert.ok(w.files.has(talked));
});

test('a new photo in a job’s source sends that job to the front of the queue', async () => {
  twoJobs();
  await run(0);
  assert.ok((await row('j2')).checked_at > 0);
  assert.equal(await nudgeJobsFor(env.DB, '600'), 1);
  assert.equal((await row('j2')).checked_at, 0);
  await env.DB.prepare('UPDATE companycam_jobs SET checked_at = ?').bind(at(0)).run();
  // The same through CompanyCam's webhook
  await takeEvent(env, { event_type: 'photo.created', payload: { photo: { id: '3009104', project_id: '600' } } }, { now: at(5) });
  assert.equal((await row('j2')).checked_at, 0);
  assert.ok((await row('j1')).checked_at > 0, 'other jobs keep their place');
});
