/**
 * Photos onto Before, During and After, by when each was taken
 * ===========================================================================
 * Peter, Nov 9–11 2026: "i also want things autotagged", and the tags
 * themselves (./_file-tags.js). Each open job's photos and videos are
 * sorted by the time the camera wrote into the file, against the job's
 * Demo and Reveal dates:
 *   the job still before the build          → Before (Status On Site,
 *                                              Awaiting Funding, Design,
 *                                              Finalization or Approval: the
 *                                              build hasn't started, whatever
 *                                              dates the job still carries)
 *   taken before the Demo date              → Before
 *   from the Demo date until reveal day     → During
 *   reveal day on                           → After
 * No Demo date on a job past those statuses: no pick, listed "missing its
 * Demo date". A finished job (Closed Done, Warranty) with no Reveal date: a
 * photo from the Demo date on gets none ("missing its Reveal date"), never
 * During for a year of photos after the build. A community project (they sit
 * at On Site throughout) goes by dates only while it's at On Site.
 *
 * Camera photos and videos get a stage: a photo by the camera's own "taken"
 * time (EXIF DateTimeOriginal), a video by its recording time (the movie
 * header's, in Eastern time). A picture without one (a design board, a
 * layout saved as a PNG, a screenshot) goes by its name as a document does:
 * Design, Plans or Costs, else none and staff only. Never a daily log's photo
 * or a document's (shared with whoever the log or document is), and never a
 * file that already has one of the new tags (a person's pick, or an earlier
 * one).
 *
 * Documents on an open job get Costs, Design or Plans by ./_tag-rules.js (a
 * private paper never; a file on a document only Costs). A file still on an
 * old tag is left to the move (./_tag-moves.js), which takes the old tag off.
 *
 * WRITE on Nov 11 2026, after the trial's picks were checked: every pick is
 * recorded in D1 (photo_stages), counted on Site → Automations, and written.
 * One job a turn, every 2 minutes on the heartbeat, a job's new photos read up
 * to FILES_PER_TURN at a time (the first 256 KB of each, from JobTread's own
 * file link; a video's movie header where it sits), every open job again
 * about every hour. Writing, at most WRITES_PER_TURN a turn (the same job
 * again next turn while it has more).
 */

import { SOARD_ORG_ID } from './_reveals.js';
import { pave } from './_jt-access.js';
import { FIELD_STATUS, REVEAL_TASK_TYPE, loadAllProjects, linkJobs } from './_kid-status.js';
import { heicExifPlace } from '../../public/admin/kid-guess.js';
import { tagIds } from './_file-tags.js';
import { docPick, isRetiring, isPrivateName } from './_tag-rules.js';

export const WRITE = true; // Nov 11 2026: the trial's picks checked; writing (Peter: "tomorrow?")
const TURN_MS = 2 * 60 * 1000;
const JOBS_EVERY_MS = 60 * 60 * 1000;
const FILES_PER_TURN = 30;
const WRITES_PER_TURN = 40;
const HEAD_BYTES = 256 * 1024;
const PAGE = 25;
const MAX_PAGES = 40;
const READ_TRIES = 3;
export const STAGES = ['Before', 'During', 'After'];
/** Statuses before the build starts: with no Demo date yet, a photo is Before */
export const PRE_BUILD = new Set(['On Site', 'Awaiting Funding', 'Design', 'Finalization', 'Approval']);
/** A finished job's statuses (as _kid-status.js) */
const DONE = new Set(['Closed Done', 'Warranty']);
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
    return movieTaken(v, 0);
  } catch { /* cut short or not a picture */ }
  return null;
}

// ─── Reading the time a video was recorded ──────────────────────────
const fourcc = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
const MAC_EPOCH_MS = Date.UTC(1904, 0, 1);
const IMAGE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);
const EASTERN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** A moment as Eastern wall clock, 'YYYY-MM-DD HH:MM:SS' (a photo's EXIF time is the wall clock where it was taken; SOARD's are Eastern) */
export function eastern(ms) {
  const p = Object.fromEntries(EASTERN.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
/** The movie header's creation time inside a moov box's children (at..end) */
function mvhdTaken(v, at, end) {
  for (let o = at; o + 8 <= end && o + 8 <= v.byteLength;) {
    const size = v.getUint32(o);
    if (fourcc(v, o + 4) === 'mvhd') {
      if (o + 24 > v.byteLength) return null;
      const secs = v.getUint8(o + 8) === 1 ? Number(v.getBigUint64(o + 12)) : v.getUint32(o + 12);
      return { taken: secs ? eastern(MAC_EPOCH_MS + secs * 1000) : null, camera: null };
    }
    if (size < 8) return null;
    o += size;
  }
  return null;
}
/**
 * A QuickTime or MP4 video's recording time, from bytes starting at file offset `base`:
 * { taken, camera: null } | { needsAt: file offset of the next box to read } | null (not a video, or no time)
 */
export function movieTaken(v, base = 0) {
  let o = 0;
  while (o + 8 <= v.byteLength) {
    let size = v.getUint32(o);
    const type = fourcc(v, o + 4);
    if (base === 0 && o === 0 && (type !== 'ftyp' || o + 12 > v.byteLength || IMAGE_BRANDS.has(fourcc(v, 8)))) return null;
    let head = 8;
    if (size === 1) {
      if (o + 16 > v.byteLength) return { needsAt: base + o };
      size = Number(v.getBigUint64(o + 8));
      head = 16;
    }
    if (type === 'moov') return mvhdTaken(v, o + head, size ? o + size : v.byteLength);
    if (size === 0 || size < head) return null; // runs to the end of the file, or broken
    o += size;
  }
  return { needsAt: base + o };
}

/** The first n bytes of a reply, never more (a server that ignores Range doesn't send a whole video into memory) */
async function headBytes(res, n) {
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(got, n));
  let o = 0;
  for (const p of parts) {
    const take = Math.min(p.byteLength, out.byteLength - o);
    out.set(p.subarray(0, take), o);
    o += take;
    if (o >= out.byteLength) break;
  }
  return out.buffer;
}

/** Read one file's taken time from JobTread's link: { taken, camera } | null (none in it) — throws on a failed fetch */
export async function fetchTaken(url, fetchImpl) {
  const head = await fetchImpl(url, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
  if (!head.ok) throw new Error(`file link answered ${head.status}`);
  const buf = await headBytes(head, HEAD_BYTES);
  let r = readTaken(buf);
  // A video whose movie header sits after its frames (as a phone writes it): jump to the next box, a few times at most
  for (let hop = 0; r?.needsAt != null && hop < 3; hop++) {
    const at = r.needsAt;
    const part = await fetchImpl(url, { headers: { Range: `bytes=${at}-${at + 65535}` } });
    if (part.status === 416) return null;
    if (!part.ok) throw new Error(`file link answered ${part.status}`);
    if (part.status !== 206) return null; // the whole file from the start, not the part asked for
    r = movieTaken(new DataView(await headBytes(part, 65536)), at);
  }
  if (r?.needsAt != null) return null;
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
  const status = String(job.status || '');
  // Still before the build: every photo so far is Before, whatever dates the job carries (a community project sits at On Site throughout)
  if (PRE_BUILD.has(status) && !(job.community && status === 'On Site')) return { stage: 'Before', why: `the build hasn’t started (Status ${status})` };
  if (reveal && day >= reveal) return { stage: 'After', why: 'on or after reveal day' };
  if (demo && day < demo) return { stage: 'Before', why: 'before the Demo date' };
  if (demo) return !reveal && DONE.has(status) ? { stage: null, why: 'missing its Reveal date' } : { stage: 'During', why: 'from the Demo date, before reveal day' };
  if (job.community) return { stage: null, why: 'community project with no Demo date' };
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

export async function jobDates(key, jobId, fetchImpl) {
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

/** The job's own files (not a daily log's): [{ id, name, type, url, createdBy, documentId, documentType, tags: [{ id, name }] }] */
async function jobFiles(key, jobId, fetchImpl) {
  const out = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await pave(key, { job: { $: { id: jobId }, f: { _: 'files', $: { size: PAGE, ...(page ? { page } : {}) },
      nextPage: {}, nodes: { id: {}, name: {}, type: {}, dailyLog: { id: {} }, document: { id: {}, type: {} }, createdByUser: { name: {} }, url: { $: { original: true } },
        fileTags: { $: { size: 10 }, nodes: { id: {}, name: {} } } } } } }, fetchImpl);
    const conn = body?.job?.f;
    if (!conn) throw new Error('JobTread sent no files');
    for (const f of conn.nodes || []) {
      if (f.dailyLog?.id) continue;
      out.push({ id: f.id, name: f.name || '', type: String(f.type || '').toLowerCase(), url: f.url || null, createdBy: f.createdByUser?.name || '',
        documentId: f.document?.id || null, documentType: f.document?.type || null, tags: f.fileTags?.nodes || [] });
    }
    page = conn.nextPage || null;
    if (!page) break;
  }
  return out;
}

// ─── One turn ───────────────────────────────────────────────────────
/** Sort one job's photos (reading at most FILES_PER_TURN new ones). → { job, read, picks: { Before, During, After, none }, left } */
export async function sortJob(env, job, { fetchImpl = fetch, now = Date.now(), community = false, write = WRITE, deadline = Infinity } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  await ensureSchema(DB);
  const dates = await jobDates(key, job.id, fetchImpl);
  const facts = { ...dates, community };
  const files = (await jobFiles(key, job.id, fetchImpl)).filter((f) => !f.tags.some((t) => isRetiring(t.name)));
  const ids = await tagIds(DB);
  const stageIds = new Map(STAGES.map((s) => [ids.get(s), s]).filter(([id]) => id));
  const docIds = new Map(['Costs', 'Design', 'Plans'].map((s) => [ids.get(s), s]).filter(([id]) => id));
  const known = new Map();
  for (let i = 0; i < files.length; i += 90) {
    const part = files.slice(i, i + 90).map((f) => f.id);
    if (!part.length) break;
    const { results } = await DB.prepare(`SELECT * FROM photo_stages WHERE file_id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results || []) known.set(r.file_id, r);
  }
  let read = 0;
  let wrote = 0;
  let failed = 0;
  let lastError = null;
  const picks = { Before: 0, During: 0, After: 0, docs: 0, none: 0 };
  let left = 0;
  // Writing, a turn's share: the rest next turn (the job stays up while it has more)
  const writeOne = async (f, tag) => {
    if (wrote >= WRITES_PER_TURN || Date.now() > deadline) { left += 1; return; }
    wrote += 1;
    try {
      await pave(key, { updateFile: { $: { id: f.id, fileTagIds: [...f.tags.map((t) => t.id), ids.get(tag)] } } }, fetchImpl);
      await DB.prepare('UPDATE photo_stages SET written_at = ? WHERE file_id = ?').bind(iso(now), f.id).run();
    } catch (e) {
      // One file JobTread won't take doesn't hold up the job: tried again on the job's next turn
      failed += 1;
      lastError = String(e?.message || e).slice(0, 200);
    }
  };
  const newTag = (f) => f.tags.map((t) => docIds.get(t.id) || stageIds.get(t.id)).find(Boolean) || null;
  const upsert = DB.prepare(`INSERT INTO photo_stages (file_id, job_id, name, kind, taken, camera, stage, why, reads, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET job_id = excluded.job_id, name = excluded.name, kind = excluded.kind, taken = excluded.taken, camera = excluded.camera,
      stage = excluded.stage, why = excluded.why, reads = excluded.reads, decided_at = excluded.decided_at`);
  for (const f of files) {
    const prior = known.get(f.id);
    const kind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'photo' : 'doc';
    // A document: Costs, Design or Plans by the shared rules; a file on a document only Costs
    if (kind === 'doc' || f.documentId) {
      const already = newTag(f);
      let dp = already ? { tag: already, why: 'already tagged' } : docPick({ name: f.name, createdBy: f.createdBy, documentType: f.documentType });
      if (!already && f.documentId && dp.tag && dp.tag !== 'Costs') dp = { tag: null, why: 'on a document' };
      if (!prior || prior.stage !== dp.tag || prior.why !== dp.why) await upsert.bind(f.id, job.id, f.name, kind, null, null, dp.tag, dp.why, 0, iso(now)).run();
      picks[dp.tag && STAGES.includes(dp.tag) ? dp.tag : dp.tag ? 'docs' : 'none'] = (picks[dp.tag && STAGES.includes(dp.tag) ? dp.tag : dp.tag ? 'docs' : 'none'] || 0) + 1;
      if (write && dp.tag && !already && f.tags.length < 10 && ids.get(dp.tag)) await writeOne(f, dp.tag);
      continue;
    }
    const fromCompanyCam = /^CompanyCam \d+$/.test(f.name);
    let taken = prior?.taken || null;
    let camera = prior?.camera ?? null;
    let reads = prior?.reads || 0;
    // A photo or video whose time hasn't been read yet (and hasn't failed too often): read now, if this turn has room
    if (camera == null && reads < READ_TRIES && f.url) {
      if (read >= FILES_PER_TURN) { left += 1; continue; }
      read += 1;
      reads += 1;
      try {
        const r = await fetchTaken(f.url, fetchImpl);
        taken = r?.taken || null;
        camera = r?.taken || fromCompanyCam ? 1 : 0;
      } catch { /* tried again next turn, up to READ_TRIES */ }
    }
    // Already on one of the new tags: a person's pick or an earlier one, left as it is
    const tagged = newTag(f);
    let pick;
    if (tagged) pick = { stage: tagged, why: 'already tagged' };
    else if (isPrivateName(f.name)) pick = { stage: null, why: 'a picture of a private paper' };
    // camera: null = not read (yet, or the link failed READ_TRIES times), 0 = read and no camera time, 1 = a camera photo or video
    else if (camera == null) pick = { stage: null, why: reads >= READ_TRIES ? 'couldn’t be read' : 'not read yet' };
    else if (camera && taken) pick = stageOf(taken, facts, now);
    else pick = { stage: null, why: kind === 'video' ? 'no time recorded' : camera ? 'no time taken' : 'not a camera photo' };
    // Not a camera photo, or one with no stage: a design board, a layout or a plan saved as a picture goes by its name
    if (!pick.stage && !tagged && camera != null && !isPrivateName(f.name)) {
      const byName = docPick({ name: f.name, createdBy: f.createdBy });
      if (byName.tag) pick = { stage: byName.tag, why: byName.why };
    }
    if (!prior || prior.stage !== pick.stage || prior.why !== pick.why || prior.taken !== taken || prior.reads !== reads) {
      await upsert.bind(f.id, job.id, f.name, kind, taken, camera, pick.stage, pick.why, reads, iso(now)).run();
    }
    picks[STAGES.includes(pick.stage) ? pick.stage : pick.stage ? 'docs' : 'none'] += 1;
    // Writing: only when switched on, only a pick the site made, onto a file with room for one more tag
    if (write && pick.stage && !tagged && f.tags.length < 10 && ids.get(pick.stage)) await writeOne(f, pick.stage);
  }
  return { job: { id: job.id, name: dates.name, demo: dates.demo, reveal: dates.reveal, status: dates.status }, files: files.length, read, wrote, failed, lastError, picks, left };
}

/** The heartbeat's call: every 2 minutes, one job (the same one again while it has photos left to read). Never throws. */
export async function maybeSortPhotos(env, { fetchImpl = fetch, now = Date.now(), write = WRITE, deadline = Infinity } = {}) {
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
    const r = await sortJob(env, job, { fetchImpl, now, community: (list.community || []).includes(job.id), write, deadline });
    if (!r.left) list.cursor = (list.cursor + 1) % list.jobs.length;
    await putState(DB, 'jobs', list, now);
    const byJob = (await getState(DB, 'by-job')) || {};
    byJob[job.id] = { name: r.job.name, demo: r.job.demo, reveal: r.job.reveal, status: r.job.status, files: r.files, picks: r.picks, left: r.left, at: iso(now) };
    await putState(DB, 'by-job', byJob, now);
    if (r.failed) await putState(DB, 'error', { at: iso(now), error: `JobTread took ${r.wrote - r.failed} of ${r.wrote} tag writes on ${r.job.name}: ${r.lastError}` }, now);
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
