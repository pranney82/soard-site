/**
 * The kid's photo as their JobTread job's cover (functions/api/_job-covers.js):
 * which photo, the crop JobTread gets, set once per photo, retried when
 * JobTread can't take it, and riding the kid status sync.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { coverOf, syncJobCovers, coverFacts, applicationPhotoFile } from '../functions/api/_job-covers.js';
import { syncKidStatuses, FIELD_STATUS } from '../functions/api/_kid-status.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const photo = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;
const T0 = Date.parse('2026-10-21T15:00:00Z');

let env; let calls; let failUploads;
/** JobTread, as far as covers go: upload requests from a URL and updateJob */
async function jt(url, init) {
  const { query } = JSON.parse(init.body);
  const { $, ...rest } = query;
  if (rest.createUploadRequest) {
    calls.push({ op: 'upload', url: rest.createUploadRequest.$.url });
    if (failUploads > 0) { failUploads--; return new Response('could not fetch', { status: 400 }); }
    return Response.json({ createUploadRequest: { createdUploadRequest: { id: `up${calls.length}` } } });
  }
  if (rest.updateJob) {
    calls.push({ op: 'cover', jobId: rest.updateJob.$.id, coverPhoto: rest.updateJob.$.coverPhoto, selects: Object.keys(rest.updateJob).filter((k) => k !== '$') });
    return Response.json({ updateJob: {} });
  }
  if (rest.organization?.jobs) return Response.json({ organization: { jobs: { nodes: JOBS, nextPage: null } } });
  throw new Error(`unexpected JobTread call: ${Object.keys(rest)}`);
}
let JOBS = [];
const job = (id, name, status = 'Build') => ({ id, name, closedOn: null, customFieldValues: { nodes: [{ value: status, customField: { id: FIELD_STATUS } }] }, tasks: { nodes: [] } });

beforeEach(async () => {
  env = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), JOBTREAD_GRANT_KEY: 'site-grant' };
  calls = [];
  failUploads = 0;
  JOBS = [];
});
const kidRow = (slug, data) => env.DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(slug, data.name, data.year, data.status || 'in-progress', JSON.stringify({ slug, ...data })).run();

test('the cover is the profile’s Main photo, cropped to 3:2 around the face or the focal point', () => {
  const plain = coverOf({ heroImage: photo('kids/ava/hero.jpg'), photos: [{ url: photo('kids/ava/hero.jpg') }] });
  assert.equal(plain.url, `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${HASH}/kids/ava/hero.jpg/w=1500,h=1000,fit=cover,gravity=face,q=85`);
  assert.equal(plain.source, 'photo:kids/ava/hero.jpg@face');
  const focused = coverOf({ heroImage: photo('kids/ava/hero.jpg'), photos: [{ url: photo('kids/ava/hero.jpg'), focus: { x: 0.42, y: 0.31 } }] });
  assert.match(focused.url, /gravity=0\.42x0\.31/, 'the focal point set in the admin');
  assert.notEqual(focused.source, plain.source, 'moving the focal point is a new cover');
  assert.equal(coverOf({ heroImage: '' }), null, 'no Main photo, no cover');
  assert.equal(coverOf({ heroImage: 'https://example.com/a.jpg' }), null, 'only the site’s own photos');
  assert.equal(coverOf(null), null);
});

test('set once per photo, again when the Main photo changes, and retried if JobTread can’t take it', async () => {
  const kids = [
    { slug: 'ava', data: { heroImage: photo('kids/ava/1.jpg') } },
    { slug: 'ben', data: { heroImage: '' } },
  ];
  const links = new Map([['ava', { id: 'J1' }], ['ben', { id: 'J2' }]]);
  assert.deepEqual(await syncJobCovers(env, links, kids, { fetchImpl: jt, now: T0 }), [{ slug: 'ava', jobId: 'J1' }]);
  assert.deepEqual(calls.map((c) => c.op), ['upload', 'cover']);
  assert.equal(calls[1].coverPhoto.uploadRequestId, 'up1');
  assert.deepEqual(calls[1].selects, [], 'updateJob selects nothing (JobTread returns the query root)');

  calls = [];
  assert.deepEqual(await syncJobCovers(env, links, kids, { fetchImpl: jt, now: T0 + 1 }), [], 'same photo: nothing to do');
  assert.equal(calls.length, 0);

  kids[0].data.heroImage = photo('kids/ava/2.jpg');
  failUploads = 1;
  assert.deepEqual(await syncJobCovers(env, links, kids, { fetchImpl: jt, now: T0 + 2 }), [], 'JobTread couldn’t fetch it');
  assert.equal((await coverFacts(env.DB)).failing, 1);
  assert.deepEqual(await syncJobCovers(env, links, kids, { fetchImpl: jt, now: T0 + 3 }), [{ slug: 'ava', jobId: 'J1' }], 'the next run tries again');
  const facts = await coverFacts(env.DB);
  assert.deepEqual([facts.covers, facts.failing, facts.last.slug], [1, 0, 'ava']);
});

test('a few jobs per run, so the first run over every job doesn’t stall the sync', async () => {
  const kids = Array.from({ length: 12 }, (_, i) => ({ slug: `k${i}`, data: { heroImage: photo(`kids/k${i}/1.jpg`) } }));
  const links = new Map(kids.map((k, i) => [k.slug, { id: `J${i}` }]));
  assert.equal((await syncJobCovers(env, links, kids, { fetchImpl: jt, now: T0 })).length, 8);
  assert.equal((await syncJobCovers(env, links, kids, { fetchImpl: jt, now: T0 + 1 })).length, 4, 'the rest next time');
  assert.equal((await syncJobCovers(env, links, kids, { fetchImpl: jt, now: T0 + 2 })).length, 0);
});

test('it rides the kid status sync: every linked job gets its kid’s photo', async () => {
  await kidRow('max', { name: 'Max', year: 2026, heroImage: photo('kids/max/hero.jpg') });
  await kidRow('lizzie', { name: 'Lizzie', year: 2026, heroImage: '' });
  JOBS = [job('JMAX', 'Max Sample (2026)'), job('JLIZ', 'Lizzie Francis (2026)'), job('JT1', 'TEST Max Sample (2026)')];
  await syncKidStatuses(env, { fetchImpl: jt, now: T0 });
  assert.deepEqual(calls.filter((c) => c.op === 'cover').map((c) => c.jobId), ['JMAX'], 'Lizzie has no Main photo yet; TEST jobs are skipped');
  assert.match(calls.find((c) => c.op === 'upload').url, /kids\/max\/hero\.jpg\/w=1500,h=1000/);
  const state = JSON.parse(await env.DB.prepare("SELECT value FROM kid_status_state WHERE key = 'state'").first('value'));
  assert.equal(state.lastRun.covers, 1);
});

test('the application’s child photo: the file the form attached to the account', async () => {
  assert.equal(await applicationPhotoFile(env.DB, 'acct1'), null, 'no applications table yet');
  await env.DB.prepare('CREATE TABLE applications (id TEXT, jt_account_id TEXT, jt_state TEXT, answers TEXT)').run();
  await env.DB.prepare('INSERT INTO applications VALUES (?, ?, ?, ?)').bind('app1', 'acct1', JSON.stringify({ files: { photoChild: { id: 'FILE1' }, photoFamily: { id: 'FILE2' } } }), '{}').run();
  assert.equal(await applicationPhotoFile(env.DB, 'acct1'), 'FILE1');
  assert.equal(await applicationPhotoFile(env.DB, 'acct2'), null, 'a family who didn’t apply on the site');
});
