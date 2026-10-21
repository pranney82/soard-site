/**
 * CompanyCam ↔ JobTread jobs (functions/api/_companycam-jobs.js): each open
 * job's project found (linked, from its own photos, or by name), photos
 * against JobTread's copies, the read-only passes, and the repair: the lost
 * link, second copies, missing photos, and what Slack hears.
 * All names, addresses and ids are made up.
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { maybeCheckJobs, jobsFacts } from '../functions/api/_companycam-jobs.js';

const T0 = Date.parse('2026-10-21T15:00:00Z');
const MIN = 60 * 1000;
const at = (m) => T0 + m * MIN;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let w; let env; let realFetch;

function world() {
  return { jobs: new Map(), files: new Map(), projects: new Map(), photos: new Map(), writes: [], slack: [], slackEdits: [], next: 100 };
}
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
  if (op === 'updateJob') {
    const holder = [...w.jobs.values()].find((j) => j.id !== q.$.id && j.companycamId === q.$.companycamId);
    if (holder) return new Response(`This CompanyCam project is already linked to ${holder.name}.`, { status: 400 });
    w.jobs.get(q.$.id).companycamId = q.$.companycamId;
    return json({});
  }
  if (op === 'deleteFile') { w.files.delete(q.$.id); return json({}); }
  if (op === 'createUploadRequest') return json({ createUploadRequest: { createdUploadRequest: { id: `up${w.writes.length}` } } });
  if (op === 'createFile') { const id = fid(); w.files.set(id, { id, jobId: q.$.targetId, name: q.$.name, createdAt: new Date(w.now).toISOString(), by: 'site' }); return json({ createFile: { createdFile: { id } } }); }
  throw new Error(`unexpected JobTread call ${op}`);
}

function companycam(url, init) {
  const path = url.pathname.replace('/public_api/v1', '');
  let m;
  const page = (data) => json({ data, errors: [], meta: { has_next: false } });
  if (path === '/projects') {
    const archived = url.searchParams.get('archived') === 'true';
    return page([...w.projects.values()].filter((p) => !!p.archived === archived));
  }
  if ((m = path.match(/^\/projects\/(\d+)\/photos$/))) return page([...w.photos.values()].filter((p) => p.project_id === m[1]));
  if ((m = path.match(/^\/photos\/(\d+)$/))) return w.photos.has(m[1]) ? json({ data: w.photos.get(m[1]), errors: [], meta: {} }) : json({ data: {}, errors: [{ code: 'not_found', message: 'Not found' }], meta: {} }, 404);
  throw new Error(`unexpected CompanyCam call ${init?.method || 'GET'} ${path}`);
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.href === 'https://api.jobtread.com/pave') return jobtread(JSON.parse(init.body));
  if (url.host === 'api.companycam.com') return companycam(url, init);
  if (url.host === 'slack.com') {
    const b = JSON.parse(init.body || '{}');
    if (url.pathname.endsWith('/chat.update')) { w.slackEdits.push(b); return json({ ok: true, channel: b.channel, ts: b.ts }); }
    w.slack.push(b);
    return json({ ok: true, channel: b.channel, ts: `${w.slack.length}.1` });
  }
  throw new Error(`unexpected fetch ${url.href}`);
}

const job = (id, name, { companycamId = null, street = '5 Sample Rd', account = name, closedOn = null } = {}) => w.jobs.set(id, { id, name, createdAt: '2026-02-11T00:00:00Z', companycamId, street, account, closedOn });
const project = (id, name, { street = '5 Sample Rd', archived = false } = {}) => w.projects.set(id, { id, name, address: { street_address_1: street }, archived, photo_count: 0, created_at: '2026-02-11T00:00:00Z' });
function photo(id, projectId, { created = at(-24 * 60) } = {}) {
  w.photos.set(id, { id, project_id: projectId, status: 'active', processing_status: 'processed', created_at: new Date(created).toISOString(), uris: [{ type: 'original', url: `https://cdn.example.com/${id}.jpg` }] });
  w.projects.get(projectId).photo_count += 1;
}
const copy = (jobId, photoId, { by = 'CompanyCam', created = at(-60 * 24 * 30), comments = false } = {}) => { const id = fid(); w.files.set(id, { id, jobId, name: `CompanyCam ${photoId}`, createdAt: new Date(created).toISOString(), by, comments }); return id; };
const run = (m, repair) => { w.now = at(m); return maybeCheckJobs(env, { fetchImpl: fakeFetch, now: at(m), force: true, repair }); };
const row = (jobId) => env.DB.prepare('SELECT * FROM companycam_jobs WHERE job_id = ?').bind(jobId).first();

beforeEach(async () => {
  w = world();
  env = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), JOBTREAD_GRANT_KEY: 'site-grant', COMPANYCAM_TOKEN: 'cc-token', SLACK_BOT_TOKEN: 'xoxb-test' };
  await writeSlackConfig(env.DB, { channel: { id: 'C0NEWS', name: 'team' }, attention: { id: 'C0ALERT', name: 'alerts' } });
  realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

// The world most tests use: one healthy job, one that lost its link
function twoJobs() {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  for (const id of ['309001', '309002']) { photo(id, '500'); copy('j1', id); }
  project('600', 'Ben Cole (2026) (020)', { street: '9 Other Ln' });
  job('j2', 'Ben Cole (2026)', { street: '9 Other Ln' });
  photo('309101', '600'); copy('j2', '309101'); // synced before the link dropped
  photo('309102', '600'); photo('309103', '600'); // taken since: never reached JobTread
}

test('the read-only passes: each job’s project found, what’s missing counted, nothing written, nobody told', async () => {
  twoJobs();
  job('j3', 'TEST Something (2027)');
  job('j4', 'Old Family (2024)', { closedOn: '2025-01-01' });
  await run(0, false);
  assert.deepEqual(w.writes, [], 'not one change');
  assert.deepEqual(w.slack, []);
  const r1 = await row('j1');
  assert.deepEqual([r1.found_by, r1.linked, r1.cc_photos, r1.jt_copies, r1.missing], ['linked', 1, 2, 2, 0]);
  const r2 = await row('j2');
  assert.deepEqual([r2.project_id, r2.found_by, r2.linked, r2.missing], ['600', 'its photos', 0, 2], 'its own earlier photo says which project');
  assert.equal(await row('j3'), null, 'TEST jobs aren’t looked at');
  assert.equal(await row('j4'), null, 'nor closed ones');
  const facts = await jobsFacts(env);
  assert.deepEqual([facts.audit.jobs, facts.audit.linked, facts.audit.missing], [2, 1, 2]);
  assert.deepEqual(facts.audit.unlinked, [{ job: 'Ben Cole (2026)', project: 'Ben Cole (2026) (020)', foundBy: 'its photos', missing: 2 }]);
});

test('repair: the lost link comes back, then anything JobTread still hasn’t copied is copied under its name', async () => {
  twoJobs();
  await run(0, true);
  assert.equal(w.jobs.get('j2').companycamId, '600', 'linked again');
  assert.equal([...w.files.values()].filter((f) => f.jobId === 'j2').length, 1, 'JobTread gets its turn first');
  const posts = w.slack.filter((s) => /reaching JobTread again/.test(s.text || ''));
  assert.equal(posts.length, 1, 'one post for the pass');
  assert.match(JSON.stringify(posts[0].blocks), /Ben Cole \(2026\): linked to its CompanyCam project again \(2 photos to bring in\)/);
  // An hour later JobTread still hasn't copied them: the site does
  await run(61, true);
  const names = [...w.files.values()].filter((f) => f.jobId === 'j2').map((f) => f.name).sort();
  assert.deepEqual(names, ['CompanyCam 309101', 'CompanyCam 309102', 'CompanyCam 309103']);
  assert.equal((await row('j2')).missing, 0);
});

test('a photo JobTread copied twice: the oldest stays, and a copy someone commented on is never touched', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  photo('309001', '500');
  const first = copy('j1', '309001', { created: at(-10000) });
  const second = copy('j1', '309001', { created: at(-100) });
  photo('309002', '500');
  copy('j1', '309002', { created: at(-10000) });
  const talked = copy('j1', '309002', { created: at(-50), comments: true });
  await run(0, false);
  assert.equal((await row('j1')).double_copies, 2, 'counted while only looking');
  await run(61, true);
  assert.ok(w.files.has(first) && !w.files.has(second));
  assert.ok(w.files.has(talked), 'kept: someone talked about it');
});

test('a project another job holds is never taken, and Slack hears once', async () => {
  project('700', 'Cal Reed (2026) (021)');
  job('j5', 'Cal Reed (2026)'); // no link, no photos of its own
  job('j6', 'Someone Else (2026)', { companycamId: '700', street: '1 Far Away' });
  await run(0, true);
  const r = await row('j5');
  assert.equal(r.project_id, null);
  assert.equal(r.problem, 'project-held');
  assert.equal(w.jobs.get('j5').companycamId, null);
  await run(61, true);
  assert.equal(w.slack.filter((s) => /Cal Reed \(2026\): CompanyCam needs a hand/.test(s.text || '')).length, 1);
});

test('photos split over two projects at one address: Slack once, with the way to merge them; ✅ when merged', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  photo('309001', '500'); copy('j1', '309001');
  project('501', 'Ava home visit');
  photo('309201', '501');
  await run(0, true);
  await run(61, true);
  const posts = w.slack.filter((s) => /Ava Stone \(2026\): CompanyCam needs a hand/.test(s.text || ''));
  assert.equal(posts.length, 1);
  assert.match(JSON.stringify(posts[0].blocks), /Merge/);
  // Merged in CompanyCam: the extra one's photos are in the job's project now
  w.photos.get('309201').project_id = '500';
  w.projects.get('501').photo_count = 0;
  await run(122, true);
  assert.ok(w.slackEdits.some((e) => /Resolved/.test(JSON.stringify(e))));
});

test('a job with no photos yet finds the one project named for it; two named for it, none', async () => {
  project('800', 'Dee Park (2026) (022)');
  job('j7', 'Dee Park (2026)');
  project('810', 'Eli Ross (2026) (023)'); project('811', 'Eli Ross (2026) (024)');
  job('j8', 'Eli Ross (2026)');
  await run(0, false);
  assert.deepEqual([(await row('j7')).project_id, (await row('j7')).found_by], ['800', 'its name']);
  assert.deepEqual([(await row('j8')).project_id, (await row('j8')).found_by], [null, 'several named for it']);
});

test('a project another job took over meanwhile is left with it, not fought over', async () => {
  project('900', 'Fay Lin (2026) (025)');
  job('j9', 'Fay Lin (2026)');
  photo('3009301', '900'); copy('j9', '3009301'); // its own earlier photo is in 900
  job('j10', 'Fay Lin dup (2026)', { street: '2 Else St', companycamId: '900' });
  await run(0, true);
  const r = await row('j9');
  assert.equal(r.problem, 'project-held');
  assert.ok(!w.writes.some((x) => x.op === 'updateJob'), 'no tug of war');
});
