/**
 * Photos sorted into Before, During and After by when each was taken (functions/api/_photo-stages.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { stageOf, readTaken, sortJob, maybeSortPhotos, stagesFacts } from '../functions/api/_photo-stages.js';
import { tiff, jpeg, heic } from './lib/exif-fixtures.mjs';

const T = Date.parse('2026-11-11T22:00:00Z');
const job = (o = {}) => ({ demo: '2026-03-02', reveal: '2026-03-20', status: 'Building', community: false, ...o });

test('the rule: before the Demo date, from it until reveal day, reveal day on', () => {
  assert.equal(stageOf('2026-03-01 23:59:00', job()).stage, 'Before');
  assert.equal(stageOf('2026-03-02 07:00:00', job()).stage, 'During');
  assert.equal(stageOf('2026-03-19 22:00:00', job()).stage, 'During');
  assert.equal(stageOf('2026-03-20 06:00:00', job()).stage, 'After', 'reveal morning is After');
  assert.equal(stageOf('2026-04-02 10:00:00', job()).stage, 'After');
  // No Demo date yet: Before only while it's still before the build
  assert.equal(stageOf('2026-02-01 10:00:00', job({ demo: null, reveal: null, status: 'Design' })).stage, 'Before');
  assert.deepEqual(stageOf('2026-02-01 10:00:00', job({ demo: null, reveal: null, status: 'Building' })), { stage: null, why: 'missing its Demo date' });
  // Community projects: dates only
  assert.equal(stageOf('2026-03-21 10:00:00', job({ demo: null, community: true, status: 'On Site' })).stage, 'After');
  assert.equal(stageOf('2026-03-01 10:00:00', job({ demo: null, community: true, status: 'On Site' })).stage, null);
  // Bad clocks and no time
  assert.equal(stageOf('2009-01-01 00:00:00', job(), T).why, 'camera clock off');
  assert.equal(stageOf(null, job()).why, 'no time taken');
});

test('the camera’s own time is read from a JPEG and a HEIC; a picture without it has none', () => {
  const t = tiff({ lat: 33.7, lng: -84.3, taken: '2026:03:05 14:22:10' });
  const j = jpeg(t);
  assert.equal(readTaken(j.buffer.slice(j.byteOffset, j.byteOffset + j.byteLength)).taken, '2026-03-05 14:22:10');
  const h = heic(t);
  assert.equal(readTaken(h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength)).taken, '2026-03-05 14:22:10');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
  assert.equal(readTaken(png.buffer), null);
});

// A small JobTread: one job with its dates, its files, and their bytes behind each file link
function world({ files, dates = { demo: '2026-03-02', reveal: '2026-03-20', status: 'Building' }, tags = {} } = {}) {
  const w = { writes: [], ranges: [] };
  const bytes = new Map(files.map((f) => [f.id, f.bytes]));
  w.fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://cdn.example.com/')) {
      const id = u.split('/').pop();
      const b = bytes.get(id);
      w.ranges.push(init.headers?.Range);
      return b ? new Response(b, { status: 206 }) : new Response('gone', { status: 404 });
    }
    const q = JSON.parse(init.body).query;
    if (q.organization?.jobs) return Response.json({ organization: { jobs: { nextPage: null, nodes: [{ id: 'j1', name: 'Ava Stone (2026)' }, { id: 'jt', name: 'TEST Office (2026)' }] } } });
    if (q.job?.demo) return Response.json({ job: { id: 'j1', name: 'Ava Stone (2026)', closedOn: null, customFieldValues: { nodes: [{ value: dates.status }] }, demo: { nodes: dates.demo ? [{ startDate: dates.demo }] : [] }, reveal: { nodes: dates.reveal ? [{ startDate: dates.reveal }] : [] } } });
    if (q.job?.f) return Response.json({ job: { f: { nextPage: null, nodes: files.map((f) => ({ id: f.id, name: f.name, type: f.type, dailyLog: f.dailyLog ? { id: 'dl' } : null, document: f.document || null, createdByUser: { name: f.by || 'Clareece' }, url: `https://cdn.example.com/${f.id}`, fileTags: { nodes: f.tags || [] } })) } } });
    if (q.updateFile) { w.writes.push(q.updateFile.$); return Response.json({}); }
    throw new Error(`unexpected ${JSON.stringify(q).slice(0, 80)}`);
  };
  return w;
}
const photo = (id, taken, o = {}) => ({ id, name: o.name || `IMG_${id}.JPG`, type: o.type || 'image/jpeg', bytes: o.bytes || jpeg(tiff({ lat: 33.7, lng: -84.3, taken })), ...o });
const env = async () => {
  const e = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), JOBTREAD_GRANT_KEY: 'k' };
  await e.DB.prepare('CREATE TABLE IF NOT EXISTS file_tags (name TEXT PRIMARY KEY, id TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
  for (const [n, id] of [['Before', 'tB'], ['During', 'tD'], ['After', 'tA']]) await e.DB.prepare('INSERT INTO file_tags VALUES (?, ?, ?)').bind(n, id, 'x').run();
  return e;
};
const rows = async (DB) => Object.fromEntries((await DB.prepare('SELECT file_id, stage, why FROM photo_stages').all()).results.map((r) => [r.file_id, [r.stage, r.why]]));

test('a job’s photos are sorted, writing nothing; daily-log photos, screenshots and ones already tagged are left as they are', async () => {
  const e = await env();
  const w = world({ files: [
    photo('p1', '2026:02:20 10:00:00'), photo('p2', '2026:03:05 10:00:00'), photo('p3', '2026:03:20 09:00:00'),
    photo('p4', '2026:03:06 10:00:00', { dailyLog: true }),
    { id: 'p5', name: 'Screenshot.png', type: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]) },
    photo('p6', '2026:03:22 10:00:00', { tags: [{ id: 'tB', name: 'Before' }] }),
    { id: 'v1', name: 'IMG_9.MOV', type: 'video/quicktime', bytes: new Uint8Array(16) },
  ] });
  const r = await sortJob(e, { id: 'j1', name: 'Ava Stone (2026)' }, { fetchImpl: w.fetchImpl, now: T });
  const got = await rows(e.DB);
  assert.deepEqual(got.p1, ['Before', 'before the Demo date']);
  assert.deepEqual(got.p2, ['During', 'from the Demo date, before reveal day']);
  assert.deepEqual(got.p3, ['After', 'on or after reveal day']);
  assert.equal(got.p4, undefined, 'a daily log’s photo is never looked at');
  assert.deepEqual(got.p5, [null, 'not a camera photo']);
  assert.deepEqual(got.p6, ['Before', 'already tagged'], 'a person’s pick stands');
  assert.deepEqual(got.v1, [null, 'a video (no time read yet)']);
  assert.deepEqual(r.picks, { Before: 2, During: 1, After: 1, docs: 0, none: 2 });
  assert.deepEqual(w.writes, [], 'nothing written while WRITE is off');
  assert.ok(w.ranges.every((h) => h === 'bytes=0-262143'), 'only the first 256 KB of each');
  // Read once: the next turn reads no file again
  const n = w.ranges.length;
  await sortJob(e, { id: 'j1', name: 'Ava Stone (2026)' }, { fetchImpl: w.fetchImpl, now: T + 1000 });
  assert.equal(w.ranges.length, n);
});

test('when writing is on, a pick goes onto the file beside its other tags, and a moved date re-sorts without reading again', async () => {
  const e = await env();
  const files = [photo('p1', '2026:03:05 10:00:00', { tags: [{ id: 'tx', name: 'In Kind' }] })];
  const w = world({ files });
  await sortJob(e, { id: 'j1' }, { fetchImpl: w.fetchImpl, now: T, write: true });
  assert.deepEqual(w.writes, [{ id: 'p1', fileTagIds: ['tx', 'tD'] }]);
  const n = w.ranges.length;
  const w2 = world({ files, dates: { demo: '2026-03-10', reveal: '2026-03-20', status: 'Building' } });
  await sortJob(e, { id: 'j1' }, { fetchImpl: w2.fetchImpl, now: T + 1000 });
  assert.deepEqual((await rows(e.DB)).p1, ['Before', 'before the Demo date'], 'the Demo date moved later: Before now');
  assert.equal(w2.ranges.length, 0, 'the time taken is remembered');
  assert.ok(n > 0);
});

test('on the heartbeat: one job a turn, every 2 minutes; TEST jobs skipped; counted for Site → Automations', async () => {
  const e = await env();
  const w = world({ files: [photo('p1', '2026:02:20 10:00:00'), photo('p2', '2026:03:21 10:00:00')] });
  const r = await maybeSortPhotos(e, { fetchImpl: w.fetchImpl, now: T });
  assert.equal(r.job.name, 'Ava Stone (2026)');
  assert.equal(await maybeSortPhotos(e, { fetchImpl: w.fetchImpl, now: T + 60 * 1000 }), null, 'not again within 2 minutes');
  const facts = await stagesFacts(e.DB);
  assert.deepEqual([facts.jobs, facts.picks.Before, facts.picks.After, facts.write, facts.written], [1, 1, 1, false, 0]);
});

test('no Demo date yet: Before while still before the build, else listed as missing its Demo date', async () => {
  const e = await env();
  const w = world({ files: [photo('p1', '2026:02:20 10:00:00')], dates: { demo: null, reveal: null, status: 'Building' } });
  await maybeSortPhotos(e, { fetchImpl: w.fetchImpl, now: T });
  const facts = await stagesFacts(e.DB);
  assert.deepEqual(facts.missingDemo, ['Ava Stone (2026)']);
});

test('documents on an open job get Costs, Design or Plans by name; a private paper never; a file on a document only Costs; old-tag files left to the move', async () => {
  const e = await env();
  for (const [n, id] of [['Costs', 'tC'], ['Design', 'tG'], ['Plans', 'tP']]) await e.DB.prepare('INSERT INTO file_tags VALUES (?, ?, ?)').bind(n, id, 'x').run();
  const doc = (id, name, o = {}) => ({ id, name, type: 'application/pdf', bytes: new Uint8Array(8), ...o });
  const w = world({ files: [
    doc('d1', 'Lowes quote 3-14.pdf'), doc('d2', 'Bedroom 3D render.pdf'), doc('d3', 'Final plan set v2.pdf'),
    doc('d4', 'Project Summary Letter.pdf'), doc('d5', 'receipt business 1d.pdf', { by: 'QuickBooks Online' }),
    doc('d6', 'Layout.pdf', { document: { id: 'doc1', type: 'customerOrder' } }), doc('d7', 'notes.pdf'),
    doc('d8', 'Old plans.pdf', { tags: [{ id: 'old1', name: '.FinalPlans' }] }),
  ] });
  await sortJob(e, { id: 'j1' }, { fetchImpl: w.fetchImpl, now: T, write: true });
  const got = await rows(e.DB);
  assert.deepEqual(got.d1, ['Costs', 'named like a quote, bill or receipt']);
  assert.deepEqual(got.d2, ['Design', 'named like a design']);
  assert.deepEqual(got.d3, ['Plans', 'named like plans']);
  assert.deepEqual(got.d4, [null, 'a private paper']);
  assert.deepEqual(got.d5, ['Costs', 'sent by QuickBooks']);
  assert.deepEqual(got.d6, [null, 'on a document']);
  assert.deepEqual(got.d7, [null, 'nothing places it']);
  assert.equal(got.d8, undefined, 'a file on an old tag is the move’s');
  assert.deepEqual(w.writes.map((x) => [x.id, x.fileTagIds]).sort(), [['d1', ['tC']], ['d2', ['tG']], ['d3', ['tP']], ['d5', ['tC']]]);
});

test('a photo named like a paper (a signed layout, a consent) gets no Before, During or After', async () => {
  const e = await env();
  const w = world({ files: [photo('s1', '2026:02:20 10:00:00', { name: 'Leland_Signed Layout.jpg' })] });
  await sortJob(e, { id: 'j1' }, { fetchImpl: w.fetchImpl, now: T, write: true });
  assert.deepEqual((await rows(e.DB)).s1, [null, 'a picture of a private paper']);
  assert.deepEqual(w.writes, []);
});
