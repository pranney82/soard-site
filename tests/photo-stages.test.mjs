/**
 * Photos sorted into Before, During and After by when each was taken (functions/api/_photo-stages.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { stageOf, readTaken, fetchTaken, sortJob, maybeSortPhotos, stagesFacts, eastern } from '../functions/api/_photo-stages.js';
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
  // Still before the build: Before, whatever dates the job still carries (Axel at Design, Reveal Oct 7)
  assert.deepEqual(stageOf('2026-11-12 10:00:00', job({ demo: '2026-09-23', reveal: '2026-10-07', status: 'Design' })), { stage: 'Before', why: 'the build hasn’t started (Status Design)' });
  assert.equal(stageOf('2026-11-12 10:00:00', job({ status: 'Awaiting Funding' })).stage, 'Before');
  // A community project sits at On Site throughout: dates there; past it, as any job
  assert.equal(stageOf('2026-03-05 10:00:00', job({ community: true, status: 'On Site' })).stage, 'During');
  assert.equal(stageOf('2026-06-20 10:00:00', job({ demo: null, reveal: null, community: true, status: 'Design' })).stage, 'Before');
  // A finished job with no Reveal date: a year of photos after the build isn't During (Sunshine Office)
  assert.deepEqual(stageOf('2026-01-10 10:00:00', job({ demo: '2025-05-05', reveal: null, status: 'Closed Done' })), { stage: null, why: 'missing its Reveal date' });
  assert.equal(stageOf('2025-04-10 10:00:00', job({ demo: '2025-05-05', reveal: null, status: 'Closed Done' })).stage, 'Before');
  assert.equal(stageOf('2026-11-09 10:00:00', job({ demo: '2026-11-06', reveal: null, status: 'Build' })).stage, 'During', 'still building: During');
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
  const r = await sortJob(e, { id: 'j1', name: 'Ava Stone (2026)' }, { fetchImpl: w.fetchImpl, now: T, write: false });
  const got = await rows(e.DB);
  assert.deepEqual(got.p1, ['Before', 'before the Demo date']);
  assert.deepEqual(got.p2, ['During', 'from the Demo date, before reveal day']);
  assert.deepEqual(got.p3, ['After', 'on or after reveal day']);
  assert.equal(got.p4, undefined, 'a daily log’s photo is never looked at');
  assert.deepEqual(got.p5, [null, 'not a camera photo']);
  assert.deepEqual(got.p6, ['Before', 'already tagged'], 'a person’s pick stands');
  assert.deepEqual(got.v1, [null, 'no time recorded'], 'a video with no movie header time');
  assert.deepEqual(r.picks, { Before: 2, During: 1, After: 1, docs: 0, none: 2 });
  assert.deepEqual(w.writes, [], 'nothing written while WRITE is off');
  assert.ok(w.ranges.every((h) => h === 'bytes=0-262143'), 'only the first 256 KB of each');
  // Read once: the next turn reads no file again
  const n = w.ranges.length;
  await sortJob(e, { id: 'j1', name: 'Ava Stone (2026)' }, { fetchImpl: w.fetchImpl, now: T + 1000, write: false });
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
  await sortJob(e, { id: 'j1' }, { fetchImpl: w2.fetchImpl, now: T + 1000, write: false });
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
  assert.deepEqual([facts.jobs, facts.picks.Before, facts.picks.After, facts.write, facts.written], [1, 1, 1, true, 2]);
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

// A phone's video: ftyp, then the frames (mdat), then the movie header (moov → mvhd, seconds since 1904, UTC)
function movie(utc, { frames = 400000, brand = 'qt  ' } = {}) {
  const box = (type, body) => { const b = new Uint8Array(8 + body.length); new DataView(b.buffer).setUint32(0, b.length); b.set([...type].map((c) => c.charCodeAt(0)), 4); b.set(body, 8); return b; };
  const ftyp = box('ftyp', new Uint8Array([...brand].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0])));
  const mvhdBody = new Uint8Array(100);
  new DataView(mvhdBody.buffer).setUint32(4, Math.round((Date.parse(utc) - Date.UTC(1904, 0, 1)) / 1000));
  const moov = box('moov', box('mvhd', mvhdBody));
  const mdat = box('mdat', new Uint8Array(frames));
  const out = new Uint8Array(ftyp.length + mdat.length + moov.length);
  out.set(ftyp, 0); out.set(mdat, ftyp.length); out.set(moov, ftyp.length + mdat.length);
  return out;
}
// A file link that answers Range as a real one does
const ranged = (bytes, seen = []) => async (_url, init = {}) => {
  const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range || '');
  seen.push(init.headers?.Range);
  if (!m) return new Response(bytes, { status: 200 });
  const a = Number(m[1]);
  if (a >= bytes.length) return new Response('', { status: 416 });
  return new Response(bytes.slice(a, Math.min(bytes.length, Number(m[2]) + 1)), { status: 206 });
};

test('a video’s recording time is read from its movie header, after its frames, in Eastern time', async () => {
  assert.equal(eastern(Date.parse('2026-03-05T19:22:10Z')), '2026-03-05 14:22:10');
  assert.equal(eastern(Date.parse('2026-07-05T19:22:10Z')), '2026-07-05 15:22:10', 'summer time');
  const seen = [];
  const r = await fetchTaken('https://cdn.example.com/v', ranged(movie('2026-03-06T02:30:00Z'), seen));
  assert.equal(r.taken, '2026-03-05 21:30:00', 'the evening of the 5th in Atlanta');
  assert.equal(seen.length, 2, 'the first 256 KB, then the movie header where it sits');
  // A HEIC is a picture, not a movie; a reply that ignores Range isn't misread
  const heicLike = movie('2026-03-06T02:30:00Z', { brand: 'heic' });
  assert.equal(await fetchTaken('https://cdn.example.com/h', ranged(heicLike)), null);
  const whole = movie('2026-03-06T02:30:00Z');
  assert.equal(await fetchTaken('https://cdn.example.com/v', async () => new Response(whole, { status: 200 })), null);
  // Moov first (a web video): read from the first bytes alone
  const fast = movie('2026-03-21T15:00:00Z', { frames: 10 });
  assert.equal(readTaken(fast.buffer).taken, '2026-03-21 11:00:00');
});

test('on a job, a video sorts by its recording time; a design board saved as a picture goes to Design', async () => {
  const e = await env();
  for (const [n, id] of [['Costs', 'tC'], ['Design', 'tG'], ['Plans', 'tP']]) await e.DB.prepare('INSERT INTO file_tags VALUES (?, ?, ?)').bind(n, id, 'x').run();
  const v = movie('2026-03-21T15:00:00Z', { frames: 10 });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
  const w = world({ files: [
    { id: 'v1', name: 'IMG_9.MOV', type: 'video/quicktime', bytes: v },
    { id: 'g1', name: 'Harper’s Design Board.png', type: 'image/png', bytes: png },
    { id: 'g2', name: 'Leland Mood Board.png', type: 'image/png', bytes: png, tags: [{ id: 'tG', name: 'Design' }] },
  ] });
  await sortJob(e, { id: 'j1' }, { fetchImpl: w.fetchImpl, now: T, write: true });
  const got = await rows(e.DB);
  assert.deepEqual(got.v1, ['After', 'on or after reveal day']);
  assert.deepEqual(got.g1, ['Design', 'named like a design']);
  assert.deepEqual(got.g2, ['Design', 'already tagged']);
  assert.deepEqual(w.writes.map((x) => [x.id, x.fileTagIds]).sort(), [['g1', ['tG']], ['v1', ['tA']]]);
});

test('writing: at most 40 a turn, the same job again next turn for the rest; a write JobTread refuses doesn’t hold up the job', async () => {
  const e = await env();
  const files = Array.from({ length: 46 }, (_, i) => photo(`p${i}`, '2026:03:05 10:00:00'));
  const w = world({ files });
  const real = w.fetchImpl;
  w.fetchImpl = async (url, init = {}) => {
    const q = init.body ? JSON.parse(init.body).query : null;
    if (q?.updateFile?.$.id === 'p3') return new Response('{"errors":["nope"]}', { status: 400 });
    // As JobTread: a written tag is on the file from then on
    if (q?.updateFile) files.find((f) => f.id === q.updateFile.$.id).tags = q.updateFile.$.fileTagIds.map((id) => ({ id, name: id }));
    return real(url, init);
  };
  // Read in the trial (30 a turn), as live: every photo's time is already known when writing starts
  await sortJob(e, { id: 'j1' }, { fetchImpl: w.fetchImpl, now: T, write: false });
  await sortJob(e, { id: 'j1' }, { fetchImpl: w.fetchImpl, now: T + 1000, write: false });
  const first = await sortJob(e, { id: 'j1' }, { fetchImpl: w.fetchImpl, now: T + 2000, write: true });
  assert.deepEqual([first.read, first.wrote, first.failed], [0, 40, 1]);
  assert.ok(first.left > 0, 'the job stays up for the rest');
  const second = await sortJob(e, { id: 'j1' }, { fetchImpl: w.fetchImpl, now: T + 3000, write: true });
  assert.deepEqual([second.wrote, second.failed], [7, 1], 'the other 6, and the refused one tried again');
  assert.equal(new Set(w.writes.map((x) => x.id)).size, 45, 'every photo but the refused one');
});
