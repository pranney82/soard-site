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
import { videoFileUrl } from '../functions/api/_companycam.js';
import { takeEvent } from '../functions/api/_companycam-sync.js';

const T0 = Date.parse('2026-10-21T15:00:00Z');
const MIN = 60 * 1000;
const at = (m) => T0 + m * MIN;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let w; let env; let realFetch;

const newWorld = () => ({ jobs: new Map(), files: new Map(), projects: new Map(), photos: new Map(), videos: new Map(), comments: new Map(), gone: new Set(), lookups: [], writes: [], slack: [], next: 100, now: T0 });
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
  if (op === 'account') {
    const files = [...w.files.values()].filter((f) => f.jobId === q.$.id);
    return json({ account: { cc: { nextPage: null, nodes: files.filter((f) => f.name.startsWith('CompanyCam')).map((f) => ({ id: f.id, name: f.name, description: f.description || null })) } } });
  }
  if (op === 'job') {
    const files = [...w.files.values()].filter((f) => f.jobId === q.$.id);
    if (q.cc) return json({ job: { cc: { nextPage: null, nodes: files.filter((f) => f.name.startsWith('CompanyCam')).map((f) => ({ id: f.id, name: f.name, description: f.description || null, createdAt: f.createdAt, createdByUser: { name: f.by }, comments: { nodes: f.comments ? [{ id: 'c' }] : [] } })) } } });
    if (q.img) return json({ job: { img: { count: files.filter((f) => f.name.startsWith('IMG')).length } } });
  }
  w.writes.push({ op, args: q.$ });
  if (op === 'deleteFile') { w.files.delete(q.$.id); return json({}); }
  if (op === 'updateFile') { const f = w.files.get(q.$.id); if (f && 'description' in q.$) f.description = q.$.description; return json({}); }
  if (op === 'createUploadRequest') {
    if (String(q.$.url || '').includes('Refused')) return new Response('file is too large', { status: 400 });
    return json({ createUploadRequest: { createdUploadRequest: { id: `up${w.writes.length}` } } });
  }
  if (op === 'createFile') { const id = fid(); w.files.set(id, { id, jobId: q.$.targetId, targetType: q.$.targetType, folder: q.$.folder || null, tags: q.$.fileTagIds || [], name: q.$.name, createdAt: new Date(w.now).toISOString(), by: null }); return json({ createFile: { createdFile: { id } } }); }
  throw new Error(`unexpected JobTread call ${op}`);
}

function companycam(url) {
  const path = url.pathname.replace('/public_api/v1', '');
  if (/\/comments$/.test(path)) { if (w.busy) return json({ errors: ['Too many requests'] }, 429); w.lookups.push(path); }
  let m;
  const page = (data) => json({ data, errors: [], meta: { has_next: false } });
  if (path === '/projects') return page([...w.projects.values()].filter((p) => !!p.archived === (url.searchParams.get('archived') === 'true')));
  if ((m = path.match(/^\/projects\/(\d+)\/photos$/))) return w.gone.has(m[1]) ? json({ data: null, errors: [{ code: 'not_found', message: 'Not found' }], meta: {} }, 404) : page([...w.photos.values()].filter((p) => p.project_id === m[1]));
  // Comments: v1 has them for photos; a video's are asked of v2
  if ((m = path.match(/^\/photos\/(\d+)\/comments$/))) return page(w.comments.get(m[1]) || []);
  if ((m = path.match(/^\/videos\/(\d+)\/comments$/))) return json({ data: null, errors: [{ code: 'not_found', message: 'Not found' }], meta: {} }, 404);
  if ((m = path.match(/^\/v2\/videos\/(\d+)\/comments$/))) return w.noVideoComments ? json({ errors: ['Not found'] }, 404) : json(w.comments.get(m[1]) || []);
  // v1 lists a video by its original upload; v2 (a bare array, page by page) by its stream on Mux
  if ((m = path.match(/^\/projects\/(\d+)\/videos$/))) return page([...w.videos.values()].filter((v) => v.project_id === m[1]).map((v) => ({ ...v, status: v.status === 'processed' ? 'active' : v.status, playback_url: `https://companycam-video.s3.amazonaws.com/uploads/${v.id}.mov`, format: 'mov' })));
  if ((m = path.match(/^\/v2\/projects\/(\d+)\/videos$/))) {
    if (w.v2Refused) return json({ errors: ['Unauthorized'] }, 401);
    const all = [...w.videos.values()].filter((v) => v.project_id === m[1]);
    const pg = Number(url.searchParams.get('page') || 1);
    const per = Number(url.searchParams.get('per_page') || 50);
    return json(all.slice((pg - 1) * per, pg * per));
  }
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
function video(id, projectId, { status = 'processed', playback = `Mux${id}`, created = at(-24 * 60) } = {}) {
  w.videos.set(id, { id, project_id: projectId, created_at: Math.floor(created / 1000), status, playback_url: status === 'processed' ? `https://stream.mux.com/${playback}.m3u8` : `https://uploads.example.com/${id}.mov`, format: status === 'processed' ? 'm3u8' : 'mov', duration: 30 });
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
  assert.equal(await row('j4'), null, 'a closed one waits until the open ones have had their turn');
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

test('a photo JobTread copied twice keeps its oldest copy; a person’s upload or a commented copy is never touched', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  photo('3009001', '500');
  const first = copy('j1', '3009001', { created: at(-10000) });
  const second = copy('j1', '3009001', { created: at(-100) });
  photo('3009002', '500');
  copy('j1', '3009002', { created: at(-10000) });
  const talked = copy('j1', '3009002', { created: at(-50), comments: true });
  const theirs = copy('j1', '3009002', { created: at(-40), by: 'Linzi Berkowitz' }); // a person's upload with the same name
  await run(0, { dedupe: false });
  assert.equal((await row('j1')).double_copies, 3, 'counted while removal is off');
  assert.ok(w.files.has(second));
  await run(61);
  assert.ok(w.files.has(first) && !w.files.has(second), 'the oldest stays, the second goes');
  assert.ok(w.files.has(talked), 'one someone commented on stays');
  assert.ok(w.files.has(theirs), 'a person’s upload is never touched');
  assert.match(JSON.stringify(w.slack.at(-1)?.blocks || []), /1 second copy removed/);
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

test('a new photo CompanyCam tells the site about is copied on the very next run, and a job still owed photos comes round in 10 minutes', async () => {
  twoJobs();
  await run(0);
  photo('3009104', '600', { created: at(5) }); // taken just now in a project JobTread lost the link to
  await takeEvent(env, { event_type: 'photo.created', payload: { photo: { id: '3009104', project_id: '600' } } }, { now: at(5) });
  await run(6);
  assert.ok(names('j2').includes('CompanyCam 3009104'), 'copied a minute after the alert');
  // A photo JobTread's own link should bring: it gets its hour, and the job is looked at every 10 minutes meanwhile
  photo('3009003', '500', { created: at(6) });
  await nudgeJobsFor(env.DB, '500');
  await run(7);
  assert.equal((await row('j1')).missing, 1);
  const before = (await row('j1')).checked_at;
  await run(12);
  assert.equal((await row('j1')).checked_at, before, 'not due again yet');
  await run(18);
  assert.ok((await row('j1')).checked_at > before, 'back after 10 minutes, not an hour');
  await run(70);
  assert.ok(names('j1').includes('CompanyCam 3009003'), 'the site copies it once JobTread’s hour is up');
});

// Before CompanyCam closes (Peter, Nov 9 2026: "i will droping company cam in december"), closed jobs too
const closedJob = () => {
  project('800', 'Old Family (2024) (007)', { street: '3 Past Ct', created: '2024-02-01T00:00:00Z' });
  job('j4', 'Old Family (2024)', { street: '3 Past Ct', closedOn: '2024-06-01', createdAt: '2024-02-01T00:00:00Z' });
  for (const id of ['3009801', '3009802', '3009803']) photo(id, '800');
  copy('j4', '3009801');
};

test('a closed job gets its missing CompanyCam photos too, after the open jobs, then weekly', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  closedJob();
  await run(0);
  assert.deepEqual(names('j4'), ['CompanyCam 3009801', 'CompanyCam 3009802', 'CompanyCam 3009803']);
  assert.ok(!w.writes.some((x) => x.op === 'updateJob'), 'never relinked, closed or not');
  const posts = w.slack.filter((s) => /copied into closed jobs in JobTread/.test(s.text || ''));
  assert.equal(posts.length, 1, 'one post once the closed jobs are caught up');
  assert.match(JSON.stringify(posts[0].blocks), /Old Family \(2024\): 2 copied/);
  const facts = await jobsFacts(env);
  assert.deepEqual([facts.closedToo, facts.closedAudit.jobs, facts.closedAudit.missing], [true, 1, 0]);
  assert.equal(facts.audit.jobs, 1, 'the open jobs’ write-up stays the open jobs’');
  const first = (await row('j4')).checked_at;
  await run(61);
  assert.equal((await row('j4')).checked_at, first, 'not hourly');
  await run(7 * 24 * 60 + 1);
  assert.ok((await row('j4')).checked_at > first, 'back a week later');
});

test('open jobs always go first: a closed job never holds up a makeover under way', async () => {
  for (const [id, n] of [['j1', 'Ava Stone'], ['j2', 'Ben Cole'], ['j5', 'Cal Reed']]) job(id, `${n} (2026)`, { street: `${id} Lane` });
  closedJob();
  await run(0);
  assert.equal(await row('j4'), null);
  await run(1);
  await run(2);
  assert.ok(await row('j4'), 'its turn comes once the open ones are done');
});

test('CompanyCam projects no job draws from are listed for a person, biggest first; TEST and empty ones aren’t', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  photo('3009001', '500');
  closedJob();
  project('900', 'Rosa Lane 2026', { street: '8 Review Way' }); // a family still in review
  for (const id of ['3009901', '3009902']) photo(id, '900');
  project('901', 'Office shelving', { street: '1 Office Pkwy' });
  photo('3009911', '901');
  project('902', 'TEST CompanyCam check');
  photo('3009921', '902');
  project('903', 'Empty one');
  await run(0);
  const { orphans } = await jobsFacts(env);
  assert.deepEqual([orphans.projects, orphans.photos], [2, 3]);
  assert.deepEqual(orphans.list.map((p) => [p.id, p.photos]), [['900', 2], ['901', 1]]);
  assert.deepEqual(names('j4').length, 3, 'the closed job’s own project isn’t an orphan');
});

test('with closed jobs switched off, only open jobs are looked at, as before', async () => {
  closedJob();
  await run(0, { closedToo: false });
  assert.equal(await row('j4'), null);
  assert.deepEqual(w.writes, []);
});

// Projects no job draws from that Peter gave a home (Nov 9 2026): copied there, untagged, and no longer orphans
test('a project given a home has its photos copied there once, untagged, into its folder, and stops being an orphan', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  closedJob();
  project('900', 'Rosa Lane 2026', { street: '8 Review Way' }); // a denied family's home visit
  for (const id of ['3009901', '3009902']) photo(id, '900');
  project('910', 'Repair visit', { street: '2 Fix St' }); // a repair on a closed job
  photo('3009911', '910');
  job('j9', 'Repair Family (2025)', { street: '2 Fix St', closedOn: '2025-02-01', createdAt: '2024-12-01T00:00:00Z' });
  project('920', 'Not placed', { street: '7 Other Rd' });
  photo('3009921', '920');
  const placed = [
    { project: '900', targetType: 'account', targetId: 'acct-rosa', folder: 'Home visit' },
    { project: '910', targetType: 'job', targetId: 'j9', folder: null },
  ];
  await run(0, { placed });
  const onAccount = [...w.files.values()].filter((f) => f.jobId === 'acct-rosa');
  assert.deepEqual(onAccount.map((f) => [f.name, f.targetType, f.folder, f.tags.length]).sort(), [['CompanyCam 3009901', 'account', 'Home visit', 0], ['CompanyCam 3009902', 'account', 'Home visit', 0]]);
  assert.deepEqual(names('j9').filter((n) => n === 'CompanyCam 3009911'), ['CompanyCam 3009911'], 'the repair visit on its closed job');
  const before = w.files.size;
  await run(11, { placed });
  assert.equal(w.files.size, before, 'nothing copied twice');
  const st = JSON.parse(await env.DB.prepare("SELECT value FROM companycam_jobs_state WHERE key = 'placed'").first('value'));
  assert.deepEqual([st['900'].missing, st['900'].copied, st['910'].missing], [0, 2, 0]);
  const orph = JSON.parse(await env.DB.prepare("SELECT value FROM companycam_jobs_state WHERE key = 'orphans'").first('value'));
  assert.deepEqual(orph.list.map((p) => p.id), ['920'], 'only the project with no home is left');
});

// Videos (Nov 11 2026, days before CompanyCam closes): the whole MP4 of each, fetched by JobTread itself
test('a job’s CompanyCam videos are copied whole, as MP4s JobTread fetches itself, two a run, until none is missing', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  for (const id of ['7700101', '7700102', '7700103']) video(id, '500');
  video('7700104', '500', { status: 'processing' }); // still being processed at CompanyCam
  await run(0);
  const ups = w.writes.filter((x) => x.op === 'createUploadRequest').map((x) => x.args.url);
  assert.deepEqual(ups, ['https://stream.mux.com/Mux7700101/highest.mp4', 'https://stream.mux.com/Mux7700102/highest.mp4'], 'JobTread is handed the MP4; the site never fetches it (Mux isn’t in the fake)');
  assert.deepEqual(names('j1'), ['CompanyCam 7700101', 'CompanyCam 7700102']);
  let r = await row('j1');
  assert.deepEqual([r.cc_videos, r.video_copies, r.videos_missing], [4, 2, 2]);
  await run(11);
  assert.ok(names('j1').includes('CompanyCam 7700103'), 'the job came round in 10 minutes for the rest');
  r = await row('j1');
  assert.equal(r.videos_missing, 1, 'the one still processing waits');
  w.videos.get('7700104').status = 'processed';
  w.videos.get('7700104').playback_url = 'https://stream.mux.com/Mux7700104.m3u8';
  await run(22);
  r = await row('j1');
  assert.deepEqual([r.videos_missing, r.problem], [0, null]);
  const before = w.files.size;
  await run(83);
  assert.equal(w.files.size, before, 'nothing copied twice');
  const facts = await jobsFacts(env);
  assert.deepEqual([facts.audit.videos, facts.audit.videosMissing], [4, 0]);
  assert.ok(w.slack.some((m) => /videos? copied/.test(m.text || '')), 'Slack hears the videos with the photos');
});

test('a video JobTread refuses is named and tried again; the job’s other videos still go', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  video('7700110', '500', { playback: 'Refused7700110' });
  video('7700111', '500');
  await run(0);
  assert.deepEqual(names('j1'), ['CompanyCam 7700111']);
  const r = await row('j1');
  assert.equal(r.problem, 'videos');
  assert.match(r.detail, /video 7700110: JobTread returned 400/);
  assert.equal(r.videos_missing, 1);
  const facts = await jobsFacts(env);
  assert.equal(facts.audit.videoErrors.length, 1);
  assert.deepEqual(facts.audit.errors, [], 'the job’s photos were still checked');
});

test('every job whose videos were never looked at is due at once, closed ones too', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  closedJob();
  video('7700120', '800');
  await run(0);
  await run(1);
  assert.ok(names('j4').includes('CompanyCam 7700120'));
  // As the jobs looked at before videos came: checked an hour ago, videos never
  await env.DB.prepare('UPDATE companycam_jobs SET cc_videos = NULL, video_copies = NULL, videos_missing = NULL, checked_at = ?').bind(at(30)).run();
  video('7700121', '800');
  await run(31);
  await run(32);
  assert.ok(names('j4').includes('CompanyCam 7700121'), 'the closed job didn’t wait its week');
});

test('a placed project’s videos go to its home with its photos; a photo deleted in CompanyCam stays out', async () => {
  project('710', 'Repair visit', { street: '2 Fix St' });
  photo('3007101', '710');
  photo('3007102', '710');
  w.photos.get('3007102').status = 'deleted'; // deleted on purpose in CompanyCam
  video('7700130', '710');
  job('j8', 'Repair Family (2025)', { street: '2 Fix St', closedOn: '2025-02-01', createdAt: '2024-12-01T00:00:00Z' });
  const placed = [{ project: '710', targetType: 'job', targetId: 'j8', folder: null }];
  await run(0, { placed });
  assert.deepEqual(names('j8').filter((n) => /3007|7700130/.test(n)), ['CompanyCam 3007101', 'CompanyCam 7700130']);
  const st = JSON.parse(await env.DB.prepare("SELECT value FROM companycam_jobs_state WHERE key = 'placed'").first('value'));
  assert.deepEqual([st['710'].missing, st['710'].videos, st['710'].videosMissing, st['710'].error], [0, 1, 0, null]);
  assert.equal((await jobsFacts(env)).placed.videosMissing, 0);
});

test('a placed project CompanyCam no longer shows is an error, not taken as empty', async () => {
  w.gone.add('730');
  await run(0, { placed: [{ project: '730', targetType: 'job', targetId: 'j7', folder: null }] });
  const st = JSON.parse(await env.DB.prepare("SELECT value FROM companycam_jobs_state WHERE key = 'placed'").first('value'));
  assert.match(st['730'].error, /doesn’t show this project any more/);
  assert.equal((await jobsFacts(env)).placed.errors, 1);
});

test('a video’s file is Mux’s whole MP4, only once CompanyCam has processed it', () => {
  assert.equal(videoFileUrl({ status: 'processed', playback_url: 'https://stream.mux.com/AbC012xyz.m3u8' }), 'https://stream.mux.com/AbC012xyz/highest.mp4');
  assert.equal(videoFileUrl({ status: 'processed', playback_url: 'https://stream.mux.com/AbC012xyz.m3u8?token=1' }), 'https://stream.mux.com/AbC012xyz/highest.mp4');
  assert.equal(videoFileUrl({ status: 'processing', playback_url: 'https://uploads.example.com/a.mov' }), null);
  assert.equal(videoFileUrl({ status: 'processed', playback_url: 'https://elsewhere.example.com/a.m3u8' }), null);
  assert.equal(videoFileUrl({}), null);
  // v1 says ready the way it does for photos
  assert.equal(videoFileUrl({ status: 'active', processing_status: 'processed', playback_url: 'https://stream.mux.com/AbC012xyz.m3u8' }), 'https://stream.mux.com/AbC012xyz/highest.mp4');
  assert.equal(videoFileUrl({ status: 'active', processing_status: 'processing', playback_url: 'https://stream.mux.com/AbC012xyz.m3u8' }), null);
  assert.equal(videoFileUrl({ status: 'deleted', processing_status: 'processed', playback_url: 'https://stream.mux.com/AbC012xyz.m3u8' }), null);
  assert.equal(videoFileUrl({ status: 'active', uris: [{ type: 'hls', url: 'https://stream.mux.com/Zz9.m3u8' }] }), 'https://stream.mux.com/Zz9/highest.mp4');
  // v1's original upload, used as it is when there's no stream
  assert.equal(videoFileUrl({ status: 'active', playback_url: 'https://companycam-video.s3.amazonaws.com/uploads/abc/IMG_1.MOV?X-Amz-Expires=600' }), 'https://companycam-video.s3.amazonaws.com/uploads/abc/IMG_1.MOV?X-Amz-Expires=600');
  assert.equal(videoFileUrl({ status: 'active', playback_url: 'https://companycam-video.s3.amazonaws.com/uploads/abc/notes.txt' }), null);
});

test('when CompanyCam’s v2 won’t answer the key, each video’s original upload goes to JobTread instead', async () => {
  w.v2Refused = true;
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  video('7700160', '500');
  await run(0);
  assert.deepEqual(w.writes.filter((x) => x.op === 'createUploadRequest').map((x) => x.args.url), ['https://companycam-video.s3.amazonaws.com/uploads/7700160.mov']);
  assert.deepEqual(names('j1'), ['CompanyCam 7700160']);
  assert.equal((await row('j1')).videos_missing, 0);
});

test('a video that gives no file is noted on its job (how CompanyCam described it), not counted as a problem', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  video('7700150', '500', { status: 'processing' });
  await run(0);
  const r = await row('j1');
  assert.equal(r.problem, null);
  assert.match(r.detail, /video 7700150 gave no file yet: status processing/);
  assert.doesNotMatch(r.detail, /uploads\.example\.com\/7700150/, 'never the link itself');
});

test('a video JobTread’s own link already brought isn’t copied again, and a new one in the linked project waits its hour', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  video('7700140', '500');
  copy('j1', '7700140'); // JobTread's link brought it, under its own name
  video('7700141', '500', { created: at(-5) }); // taken five minutes ago
  await run(0);
  assert.deepEqual(w.writes.filter((x) => x.op === 'createUploadRequest'), [], 'nothing copied: one is there, one is JobTread’s to bring');
  assert.equal((await row('j1')).videos_missing, 1);
  await run(70);
  assert.ok(names('j1').includes('CompanyCam 7700141'), 'the site brings it once JobTread’s hour is up');
  assert.equal(names('j1').filter((n) => n === 'CompanyCam 7700140').length, 1, 'never twice');
});

// What was on a job stays decided, and CompanyCam's comments travel with their photos (Nov 11 2026)
const desc = (jobId, itemId) => [...w.files.values()].find((f) => f.jobId === jobId && f.name === `CompanyCam ${itemId}`)?.description || null;

test('a CompanyCam photo or video someone deleted from the job in JobTread is never put back', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  photo('3009001', '500');
  const fileId = copy('j1', '3009001');
  video('7700170', '500');
  await run(0);
  assert.ok(names('j1').includes('CompanyCam 7700170'));
  // A person deletes both in JobTread
  w.files.delete(fileId);
  w.files.delete([...w.files.values()].find((f) => f.name === 'CompanyCam 7700170').id);
  await run(61);
  await run(122);
  assert.deepEqual(names('j1'), [], 'neither came back');
  const r = await row('j1');
  assert.deepEqual([r.missing, r.videos_missing, r.left_out], [0, 0, 2]);
  assert.equal((await jobsFacts(env)).audit.leftOut, 2);
});

test('the comments staff wrote on a photo in CompanyCam become its JobTread description, never over a person’s words, each looked up once', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  for (const id of ['3009001', '3009002', '3009003']) { photo(id, '500'); copy('j1', id); }
  w.comments.set('3009001', [{ id: 'c1', content: 'Window is 31 x 50 1/2', creator_name: 'Lizzie T', status: 'active', created_at: '2026-01-20T10:00:00Z' }]);
  w.comments.set('3009002', [{ id: 'c2', content: 'Dble niche', creator_name: 'Sam R', status: 'active', created_at: 1754000000 }, { id: 'c3', content: '14x9.5ish.', creator_name: 'Sam R', status: 'active', created_at: 1754000100 }]);
  [...w.files.values()].find((f) => f.name === 'CompanyCam 3009002').description = 'Staff wrote this in JobTread';
  video('7700180', '500');
  copy('j1', '7700180');
  w.comments.set('7700180', [{ id: 'c4', content: 'Crown molding installed', creator_name: 'Lizzie T', status: 'active', created_at: 1754000200 }]);
  await run(0);
  assert.equal(desc('j1', '3009001'), 'Lizzie T: Window is 31 x 50 1/2');
  assert.equal(desc('j1', '3009002'), 'Staff wrote this in JobTread', 'a person’s words stay');
  assert.equal(desc('j1', '3009003'), null, 'no comments, nothing written');
  assert.equal(desc('j1', '7700180'), 'Lizzie T: Crown molding installed', 'a video’s too, from v2');
  const r = await row('j1');
  assert.deepEqual([r.notes_left, r.notes_written, r.problem], [0, 2, null]);
  const n = w.lookups.length;
  await run(61);
  assert.equal(w.lookups.length, n, 'each looked up once');
  assert.equal(w.writes.filter((x) => x.op === 'updateFile').length, 2, 'and written once');
});

test('comments are looked up 25 a turn, and a job with more to look up comes round in 10 minutes', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  for (let i = 0; i < 50; i++) { const id = String(3008000 + i); photo(id, '500'); copy('j1', id); }
  await run(0);
  assert.equal((await row('j1')).notes_left, 25);
  await run(11);
  assert.equal((await row('j1')).notes_left, 0);
  assert.equal(w.lookups.length, 50);
});

test('a video whose comments CompanyCam doesn’t keep is simply without a note', async () => {
  w.noVideoComments = true;
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  video('7700190', '500');
  copy('j1', '7700190');
  await run(0);
  const r = await row('j1');
  assert.deepEqual([r.notes_left, r.problem], [0, null]);
});

test('a placed project’s comments go onto its copies on the account', async () => {
  project('900', 'Rosa Lane 2026', { street: '8 Review Way' });
  photo('3009901', '900');
  w.comments.set('3009901', [{ id: 'c9', content: 'Confirmed no blocking', creator_name: 'Bryce W', status: 'active', created_at: 1754000300 }]);
  const placed = [{ project: '900', targetType: 'account', targetId: 'acct-rosa', folder: 'Warranty' }];
  await run(0, { placed });
  await run(11, { placed });
  assert.equal(desc('acct-rosa', '3009901'), 'Bryce W: Confirmed no blocking', 'copied first, its note on the next run');
  const st = JSON.parse(await env.DB.prepare("SELECT value FROM companycam_jobs_state WHERE key = 'placed'").first('value'));
  assert.deepEqual([st['900'].notesLeft, st['900'].notesWritten], [0, 1]);
});

test('when CompanyCam turns comment look-ups away, the job is back in 10 minutes and finishes', async () => {
  project('500', 'Ava Stone (2026) (019)');
  job('j1', 'Ava Stone (2026)', { companycamId: '500' });
  photo('3009001', '500');
  copy('j1', '3009001');
  w.comments.set('3009001', [{ id: 'c1', content: 'Kitchenette', creator_name: 'Clare C', status: 'active', created_at: 1754000000 }]);
  w.busy = true;
  await run(0);
  let r = await row('j1');
  assert.equal(r.problem, 'notes');
  assert.ok(r.notes_left > 0, 'still owed');
  w.busy = false;
  await run(11);
  r = await row('j1');
  assert.deepEqual([r.problem, r.notes_left, desc('j1', '3009001')], [null, 0, 'Clare C: Kitchenette']);
});
