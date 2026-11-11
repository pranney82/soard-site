/**
 * Photos onto Before, During and After, by when each was taken
 * ===========================================================================
 * Peter, Nov 9–11 2026: "i also want things autotagged", and the tags
 * themselves (./_file-tags.js). Each open job's photos and videos are
 * sorted by the time the camera wrote into the file, against the job's
 * Demo and Reveal dates:
 *   taken before the Demo date              → Before
 *   from the Demo date until reveal day     → During
 *   reveal day on                           → After
 * A job with no Demo date yet: before the build (Status On Site, Awaiting
 * Funding, Design, Finalization or Approval) → Before; any other Status → no
 * pick, and the job is listed "missing its Demo date". A community project
 * (they sit at On Site throughout) goes by dates only.
 *
 * Only camera photos get a pick: a file with the camera's own "taken" time
 * (EXIF DateTimeOriginal), or a CompanyCam copy. Screenshots, renders, scans,
 * plans and anything without that time get none and stay staff only. Never a
 * daily log's photo or a document's (shared with whoever the log or document
 * is), and never a file that already has Before, During or After (a person's
 * pick, or an earlier one).
 *
 * WRITE is off: every pick is recorded in D1 (photo_stages) and counted on
 * Site → Automations, and nothing is written to JobTread until the picks are
 * checked. One job a turn, every 2 minutes on the heartbeat, a job's new
 * photos read up to FILES_PER_TURN at a time (the first 256 KB of each, from
 * JobTread's own file link), every open job again about every few hours.
 */

import { SOARD_ORG_ID } from './_reveals.js';
import { pave } from './_jt-access.js';
import { FIELD_STATUS, REVEAL_TASK_TYPE, loadAllProjects, linkJobs } from './_kid-status.js';
import { heicExifPlace } from '../../public/admin/kid-guess.js';
import { tagIds } from './_file-tags.js';

export const WRITE = false; // Nov 11 2026: picks recorded, nothing written, until they're checked
const TURN_MS = 2 * 60 * 1000;
const JOBS_EVERY_MS = 60 * 60 * 1000;
const FILES_PER_TURN = 30;
const HEAD_BYTES = 256 * 1024;
const PAGE = 25;
const MAX_PAGES = 40;
const READ_TRIES = 3;
export const STAGES = ['Before', 'During', 'After'];
/** Statuses before the build starts: with no Demo date yet, a photo is Before */
export const PRE_BUILD = new Set(['On Site', 'Awaiting Funding', 'Design', 'Finalization', 'Approval']);
const isTest = (name) => /^\s*test\b/i.test(String(name || ''));
const iso = (t) => new Date(t).toISOString();

// ─── D1 ─────────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS photo_stages (
    file_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, name TEXT, kind TEXT, taken TEXT, camera INTEGER,
    stage TEXT, why TEXT, reads INTEGER NOT NULL DEFAULT 0, decided_at TEXT, written_at TEXT)`,
  'CREATE TABLE IF NOT EXISTS photo_stages_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}
async function getState(DB, key) {
  const v = await DB.prepare('SELECT value FROM photo_stages_state WHERE key = ?').bind(key).first('value');
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
const putState = (DB, key, value, now) => DB.prepare('INSERT INTO photo_stages_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
  .bind(key, JSON.stringify(value), iso(now)).run();

// ─── Reading the time a photo was taken ─────────────────────────────
const ascii = (v, start, at, count) => {
  let s = '';
  for (let i = 0; i < count && start + at + i < v.byteLength; i++) { const c = v.getUint8(start + at + i); if (!c) break; s += String.fromCharCode(c); }
  return s;
};
/** From a TIFF block at `start`: { taken: 'YYYY-MM-DD HH:MM:SS' | null, camera: 'Make Model' | null } */
function tiffTaken(v, start) {
  const order = v.getUint16(start);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  if (u16(2) !== 42) return null;
  const ifd = (off) => {
    const tags = new Map();
    if (!off || start + off + 2 > v.byteLength) return tags;
    for (let i = 0, n = u16(off); i < n && i < 400; i++) {
      const e = off + 2 + i * 12;
      if (start + e + 12 > v.byteLength) break;
      tags.set(u16(e), { count: u32(e + 4), at: e + 8, type: u16(e + 2) });
    }
    return tags;
  };
  const str = (t) => (t ? ascii(v, start, t.count <= 4 ? t.at : u32(t.at), t.count).trim() : '');
  const ifd0 = ifd(u32(4));
  const exif = ifd0.get(0x8769) ? ifd(u32(ifd0.get(0x8769).at)) : new Map();
  const when = str(exif.get(0x9003)).match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
  const camera = [str(ifd0.get(0x010f)), str(ifd0.get(0x0110))].filter(Boolean).join(' ') || null;
  return { taken: when ? `${when[1]}-${when[2]}-${when[3]} ${when[4]}:${when[5]}:${when[6]}` : null, camera };
}
/** The camera's own "taken" time (wall clock where it was taken) from a JPEG's or HEIC's first bytes, or null */
export function readTaken(buf) {
  const v = new DataView(buf);
  try {
    if (v.byteLength > 4 && v.getUint16(0) === 0xffd8) {
      let o = 2;
      while (o + 4 <= v.byteLength) {
        if (v.getUint8(o) !== 0xff) return null;
        const marker = v.getUint8(o + 1);
        if (marker === 0xe1 && o + 10 <= v.byteLength && v.getUint32(o + 4) === 0x45786966 && v.getUint16(o + 8) === 0) return tiffTaken(v, o + 10);
        if (marker === 0xda || marker === 0xd9) return null;
        o += 2 + v.getUint16(o + 2);
      }
      return null;
    }
    const place = heicExifPlace(buf);
    if (place && place.offset + place.length <= v.byteLength) return tiffTaken(v, place.offset + 4 + v.getUint32(place.offset));
    if (place) return { needs: place };
  } catch { /* cut short or not a picture */ }
  return null;
}

/** Read one file's taken time from JobTread's link: { taken, camera } | null (none in it) — throws on a failed fetch */
async function fetchTaken(url, fetchImpl) {
  const head = await fetchImpl(url, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
  if (!head.ok) throw new Error(`file link answered ${head.status}`);
  const buf = await head.arrayBuffer();
  const r = readTaken(buf);
  if (!r?.needs) return r;
  // A HEIC whose Exif item sits further in: just those bytes
  const { offset, length } = r.needs;
  const part = await fetchImpl(url, { headers: { Range: `bytes=${offset}-${offset + Math.min(length, 65536) - 1}` } });
  if (!part.ok) throw new Error(`file link answered ${part.status}`);
  const b = await part.arrayBuffer();
  const v = new DataView(b);
  return tiffTaken(v, 4 + v.getUint32(0));
}

// ─── The rule ───────────────────────────────────────────────────────
/**
 * The pick for a camera photo: { stage: 'Before' | 'During' | 'After' | null, why }.
 * taken: 'YYYY-MM-DD HH:MM:SS' (the wall clock where it was taken, Eastern for SOARD);
 * job: { demo: 'YYYY-MM-DD' | null, reveal: 'YYYY-MM-DD' | null, status, community }
 */
export function stageOf(taken, job, now = Date.now()) {
  const day = String(taken || '').slice(0, 10);
  if (!/^\d{4}-\d\d-\d\d$/.test(day)) return { stage: null, why: 'no time taken' };
  if (day < '2012-01-01' || day > iso(now + 2 * 86400000).slice(0, 10)) return { stage: null, why: 'camera clock off' };
  const { demo, reveal } = job;
  if (reveal && day >= reveal) return { stage: 'After', why: 'on or after reveal day' };
  if (demo) return day >= demo ? { stage: 'During', why: 'from the Demo date, before reveal day' } : { stage: 'Before', why: 'before the Demo date' };
  if (job.community) return { stage: null, why: 'community project with no Demo date' };
  if (PRE_BUILD.has(String(job.status || ''))) return { stage: 'Before', why: `no Demo date yet, Status ${job.status}` };
  return { stage: null, why: 'missing its Demo date' };
}

// ─── JobTread ───────────────────────────────────────────────────────
async function openJobs(key, fetchImpl) {
  const out = [];
  let page = null;
  for (let i = 0; i < 8; i++) {
    const body = await pave(key, { organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, where: ['closedOn', '=', null], ...(page ? { page } : {}) }, nextPage: {}, nodes: { id: {}, name: {} } } } }, fetchImpl);
    const conn = body?.organization?.jobs;
    if (!conn) throw new Error('JobTread sent no jobs');
    for (const j of conn.nodes || []) if (!isTest(j.name)) out.push({ id: j.id, name: j.name });
    page = conn.nextPage || null;
    if (!page) break;
  }
  return out;
}

async function jobDates(key, jobId, fetchImpl) {
  const body = await pave(key, { job: { $: { id: jobId }, id: {}, name: {}, closedOn: {},
    customFieldValues: { $: { size: 1, where: [['customField', 'id'], '=', FIELD_STATUS] }, nodes: { value: {} } },
    demo: { _: 'tasks', $: { size: 5, where: { and: [['isGroup', '=', false], ['name', '=', 'Demo']] } }, nodes: { startDate: {} } },
    reveal: { _: 'tasks', $: { size: 5, where: [['taskType', 'id'], '=', REVEAL_TASK_TYPE] }, nodes: { startDate: {} } },
  } }, fetchImpl);
  const j = body?.job;
  if (!j) throw new Error('JobTread sent no job');
  const first = (nodes) => (nodes || []).map((t) => t.startDate).filter(Boolean).sort()[0] || null;
  return { name: j.name, closed: !!j.closedOn, status: j.customFieldValues?.nodes?.[0]?.value || null, demo: first(j.demo?.nodes), reveal: first(j.reveal?.nodes) };
}

/** The job's own photos and videos (not a daily log's or a document's): [{ id, name, type, url, tags: [{ id, name }] }] */
async function jobPhotos(key, jobId, fetchImpl) {
  const out = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await pave(key, { job: { $: { id: jobId }, f: { _: 'files', $: { size: PAGE, where: { or: [['type', 'like', 'image/%'], ['type', 'like', 'video/%']] }, ...(page ? { page } : {}) },
      nextPage: {}, nodes: { id: {}, name: {}, type: {}, dailyLog: { id: {} }, document: { id: {} }, url: { $: { original: true } },
        fileTags: { $: { size: 10 }, nodes: { id: {}, name: {} } } } } } }, fetchImpl);
    const conn = body?.job?.f;
    if (!conn) throw new Error('JobTread sent no files');
    for (const f of conn.nodes || []) {
      if (f.dailyLog?.id || f.document?.id) continue;
      out.push({ id: f.id, name: f.name || '', type: String(f.type || '').toLowerCase(), url: f.url || null, tags: f.fileTags?.nodes || [] });
    }
    page = conn.nextPage || null;
    if (!page) break;
  }
  return out;
}

// ─── One turn ───────────────────────────────────────────────────────
/** Sort one job's photos (reading at most FILES_PER_TURN new ones). → { job, read, picks: { Before, During, After, none }, left } */
export async function sortJob(env, job, { fetchImpl = fetch, now = Date.now(), community = false, write = WRITE } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  await ensureSchema(DB);
  const dates = await jobDates(key, job.id, fetchImpl);
  const facts = { ...dates, community };
  const files = await jobPhotos(key, job.id, fetchImpl);
  const ids = await tagIds(DB);
  const stageIds = new Map(STAGES.map((s) => [ids.get(s), s]).filter(([id]) => id));
  const known = new Map();
  for (let i = 0; i < files.length; i += 90) {
    const part = files.slice(i, i + 90).map((f) => f.id);
    if (!part.length) break;
    const { results } = await DB.prepare(`SELECT * FROM photo_stages WHERE file_id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results || []) known.set(r.file_id, r);
  }
  let read = 0;
  const picks = { Before: 0, During: 0, After: 0, none: 0 };
  let left = 0;
  const upsert = DB.prepare(`INSERT INTO photo_stages (file_id, job_id, name, kind, taken, camera, stage, why, reads, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET job_id = excluded.job_id, name = excluded.name, kind = excluded.kind, taken = excluded.taken, camera = excluded.camera,
      stage = excluded.stage, why = excluded.why, reads = excluded.reads, decided_at = excluded.decided_at`);
  for (const f of files) {
    const prior = known.get(f.id);
    const kind = f.type.startsWith('video/') ? 'video' : 'photo';
    const fromCompanyCam = /^CompanyCam \d+$/.test(f.name);
    let taken = prior?.taken || null;
    let camera = prior?.camera ?? null;
    let reads = prior?.reads || 0;
    // A photo whose time hasn't been read yet (and hasn't failed too often): read now, if this turn has room
    if (camera == null && kind === 'photo' && reads < READ_TRIES && f.url) {
      if (read >= FILES_PER_TURN) { left += 1; continue; }
      read += 1;
      reads += 1;
      try {
        const r = await fetchTaken(f.url, fetchImpl);
        taken = r?.taken || null;
        camera = r?.taken || fromCompanyCam ? 1 : 0;
      } catch { /* tried again next turn, up to READ_TRIES */ }
    }
    // Already on Before, During or After: a person's pick or an earlier one, left as it is
    const tagged = f.tags.map((t) => stageIds.get(t.id)).find(Boolean) || null;
    let pick;
    if (tagged) pick = { stage: tagged, why: 'already tagged' };
    else if (kind === 'video') pick = { stage: null, why: 'a video (no time read yet)' };
    // camera: null = not read (yet, or the link failed READ_TRIES times), 0 = read and no camera time, 1 = a camera photo
    else if (camera == null) pick = { stage: null, why: reads >= READ_TRIES ? 'couldn’t be read' : 'not read yet' };
    else if (!camera) pick = { stage: null, why: 'not a camera photo' };
    else pick = stageOf(taken, facts, now);
    if (!prior || prior.stage !== pick.stage || prior.why !== pick.why || prior.taken !== taken || prior.reads !== reads) {
      await upsert.bind(f.id, job.id, f.name, kind, taken, camera, pick.stage, pick.why, reads, iso(now)).run();
    }
    picks[pick.stage || 'none'] += 1;
    // Writing: only when switched on, only a pick the site made, onto a file with room for one more tag
    if (write && pick.stage && !tagged && f.tags.length < 10 && ids.get(pick.stage)) {
      await pave(key, { updateFile: { $: { id: f.id, fileTagIds: [...f.tags.map((t) => t.id), ids.get(pick.stage)] } } }, fetchImpl);
      await DB.prepare('UPDATE photo_stages SET written_at = ? WHERE file_id = ?').bind(iso(now), f.id).run();
    }
  }
  return { job: { id: job.id, name: dates.name, demo: dates.demo, reveal: dates.reveal, status: dates.status }, files: files.length, read, picks, left };
}

/** The heartbeat's call: every 2 minutes, one job (the same one again while it has photos left to read). Never throws. */
export async function maybeSortPhotos(env, { fetchImpl = fetch, now = Date.now(), write = WRITE } = {}) {
  const { DB } = env;
  if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
  try {
    await ensureSchema(DB);
    const next = String(now + TURN_MS);
    const ins = await DB.prepare("INSERT OR IGNORE INTO photo_stages_state (key, value, updated_at) VALUES ('turn', ?, ?)").bind(next, iso(now)).run();
    if (!ins?.meta?.changes) {
      const upd = await DB.prepare("UPDATE photo_stages_state SET value = ?, updated_at = ? WHERE key = 'turn' AND CAST(value AS INTEGER) <= ?").bind(next, iso(now), now).run();
      if (!upd?.meta?.changes) return null;
    }
    let list = await getState(DB, 'jobs');
    if (!list?.at || Date.parse(list.at) < now - JOBS_EVERY_MS || !list.jobs?.length) {
      const jobs = await openJobs(env.JOBTREAD_GRANT_KEY, fetchImpl);
      // Community projects go by dates only: the jobs linked to a community project page
      const links = linkJobs(jobs, await loadAllProjects(DB));
      const community = [...links.values()].map((j) => j.id);
      list = { at: iso(now), jobs, community, cursor: (list?.cursor || 0) % Math.max(1, jobs.length) };
    }
    if (!list.jobs.length) return null;
    const job = list.jobs[list.cursor % list.jobs.length];
    const r = await sortJob(env, job, { fetchImpl, now, community: (list.community || []).includes(job.id), write });
    if (!r.left) list.cursor = (list.cursor + 1) % list.jobs.length;
    await putState(DB, 'jobs', list, now);
    const byJob = (await getState(DB, 'by-job')) || {};
    byJob[job.id] = { name: r.job.name, demo: r.job.demo, reveal: r.job.reveal, status: r.job.status, files: r.files, picks: r.picks, left: r.left, at: iso(now) };
    await putState(DB, 'by-job', byJob, now);
    return r;
  } catch (e) {
    await putState(DB, 'error', { at: iso(now), error: String(e?.message || e).slice(0, 300) }, now).catch(() => null);
    return null;
  }
}

/** For Site → Automations: counts only (no names of photos), and the jobs missing a Demo date */
export async function stagesFacts(DB) {
  await ensureSchema(DB);
  const byJob = (await getState(DB, 'by-job')) || {};
  const jobs = Object.values(byJob);
  const sum = (k) => jobs.reduce((n, j) => n + (j.picks?.[k] || 0), 0);
  const { results } = await DB.prepare('SELECT count(*) AS n, sum(written_at IS NOT NULL) AS written FROM photo_stages').all();
  return {
    write: WRITE, jobs: jobs.length, files: jobs.reduce((n, j) => n + (j.files || 0), 0),
    picks: { Before: sum('Before'), During: sum('During'), After: sum('After'), none: sum('none') },
    written: results?.[0]?.written || 0, left: jobs.reduce((n, j) => n + (j.left || 0), 0),
    missingDemo: jobs.filter((j) => !j.demo && (j.picks?.none || 0) > 0).map((j) => j.name).slice(0, 20),
    lastAt: jobs.map((j) => j.at).sort().pop() || null, error: await getState(DB, 'error'),
  };
}
