/**
 * CompanyCam photos on every job: JobTread kept whole without relinking
 * ===========================================================================
 * Peter, Oct 21 2026: "my team is saying that the comapny cam to jt
 * connection hasnt always been working and they have duplicates" ... "do it
 * all". What JobTread and CompanyCam showed that day:
 *   - JobTread's integration had dropped the link on 16 of 21 open jobs
 *     (several in the same minutes on May 19), so photos taken since never
 *     came over; staff uploaded phone photos by hand (176 of them).
 *   - Linking a job again makes JobTread copy every photo in the project
 *     again: Axel's 33 photos arrived a second time when his job was relinked.
 *     That is where the duplicates come from, so this never relinks.
 *   - Some families' photos are in a second project at their address (one
 *     staff started, while JobTread made an empty one for the job).
 *
 * So the site copies what's missing itself. A job's sources: the project
 * it's linked to; the project its own earlier CompanyCam photos came from
 * (CompanyCam says which, by photo id); else the one project named for it;
 * plus a project at the same address under the family's name, started
 * within half a year of the job (never one another job holds, nor TEST). Any
 * photo in a source that the job doesn't have ("CompanyCam <id>", JobTread's
 * own naming) is copied to it. A photo in the project JobTread is still
 * linked to waits an hour first, so JobTread's own sync has its turn.
 *
 * Every open job (not TEST) about once an hour, a couple a minute on the
 * heartbeat; a new photo in a job's source moves that job to the front
 * (CompanyCam's webhook, ./_companycam-sync.js takeEvent). Slack hears once
 * a pass what was copied. Copies JobTread holds twice are counted;
 * removing them (DEDUPE: keep the oldest, never one someone commented on)
 * waits for Peter's go.
 *
 * Results in D1 companycam_jobs and companycam_jobs_state "jobs-audit" (Site
 * → Automations). Videos stay in CompanyCam: its API gives a stream, not a
 * file. Env: COMPANYCAM_TOKEN, JOBTREAD_GRANT_KEY.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import { slackPost } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { companycamOn, CompanyCamError, ccAll, getPhoto, projectPhotos, photoImageUrl } from './_companycam.js';
import { uploadToJobTread } from './_companycam-sync.js';

export const COPY = true;    // copy what a job is missing
export const DEDUPE = false; // remove JobTread's second copies: waits for Peter's go
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CHECK_EVERY_MS = HOUR;
const INDEX_EVERY_MS = HOUR;
const PER_TICK = 2;
const BUDGET_MS = 18000;
const LINKED_GRACE_MS = HOUR;      // JobTread's own sync gets its turn with the linked project
const FRESH_MS = 2 * MIN;          // a photo CompanyCam is still settling
const COPY_PER_RUN = 15;
const MAX_PHOTOS = 2000;
const SAME_FAMILY_WITHIN_MS = 183 * DAY;

const iso = (t = Date.now()) => new Date(t).toISOString();
const errText = (e) => String(e?.message || e).slice(0, 300);
const jt = (env, query, fetchImpl) => pave(env.JOBTREAD_GRANT_KEY, query, fetchImpl);
const isTest = (name) => /^\s*test\b/i.test(String(name || ''));
const ccName = (photoId) => `CompanyCam ${photoId}`;
const photoIdOf = (fileName) => (String(fileName || '').match(/^CompanyCam (\d{6,})$/) || [])[1] || null;
const ABBR = { street: 'st', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', avenue: 'ave', boulevard: 'blvd', circle: 'cir', place: 'pl', parkway: 'pkwy', trail: 'trl', crossing: 'xing', terrace: 'ter', highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w' };
const streetKey = (s) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map((w) => ABBR[w] || w).join(' ');
/** "Remi & Nico Powell (2026) (019)" → "remi nico powell 2026": a job's name as its project carries it */
const nameKey = (s) => String(s || '').toLowerCase().replace(/\(\d{3}\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** The words in a family's name worth matching ("Lizzie Francis (2026)" → lizzie, francis) */
const familyWords = (s) => new Set(String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z]+/).filter((w) => w.length >= 4));
const sharesWord = (name, words) => [...familyWords(name)].some((w) => words.has(w));

// ─── D1 ─────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS companycam_jobs (
    job_id TEXT PRIMARY KEY, job_name TEXT, project_id TEXT, project_name TEXT, found_by TEXT, linked INTEGER,
    cc_photos INTEGER, jt_copies INTEGER, missing INTEGER, double_copies INTEGER, by_hand INTEGER,
    other_projects TEXT, relinked_at TEXT, relinks INTEGER NOT NULL DEFAULT 0, copied INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0,
    problem TEXT, detail TEXT, checked_at INTEGER, updated_at TEXT NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS companycam_jobs_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  await DB.prepare('ALTER TABLE companycam_jobs ADD COLUMN sources TEXT').run().catch(() => null); // added after the first passes
  _ready.add(DB);
}
async function getState(DB, key) {
  const v = await DB.prepare('SELECT value FROM companycam_jobs_state WHERE key = ?').bind(key).first('value');
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
const putState = (DB, key, value, now) => DB.prepare('INSERT INTO companycam_jobs_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
  .bind(key, JSON.stringify(value), iso(now)).run();
async function takeTurn(DB, key, everyMs, now) {
  const next = String(now + everyMs);
  const ins = await DB.prepare('INSERT OR IGNORE INTO companycam_jobs_state (key, value, updated_at) VALUES (?, ?, ?)').bind(`turn:${key}`, next, iso(now)).run();
  if (ins?.meta?.changes > 0) return true;
  const upd = await DB.prepare('UPDATE companycam_jobs_state SET value = ?, updated_at = ? WHERE key = ? AND CAST(value AS INTEGER) <= ?').bind(next, iso(now), `turn:${key}`, now).run();
  return upd?.meta?.changes > 0;
}
const COLS = ['job_name', 'project_id', 'project_name', 'found_by', 'linked', 'cc_photos', 'jt_copies', 'missing', 'double_copies', 'by_hand', 'other_projects', 'sources', 'copied', 'removed', 'problem', 'detail', 'checked_at'];
async function saveJob(DB, row, now) {
  const cols = COLS.filter((c) => c in row);
  await DB.prepare(`INSERT INTO companycam_jobs (job_id, ${cols.join(', ')}, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)
    ON CONFLICT(job_id) DO UPDATE SET ${[...cols.map((c) => `${c} = excluded.${c}`), 'updated_at = excluded.updated_at'].join(', ')}`)
    .bind(row.job_id, ...cols.map((c) => row[c] ?? null), iso(now)).run();
}
const getJob = (DB, jobId) => DB.prepare('SELECT * FROM companycam_jobs WHERE job_id = ?').bind(jobId).first();
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ─── JobTread ───────────────────────────────────────────────────────

/** Open jobs, not TEST: { id, name, createdAt, companycamId, street, accountName } */
export async function openJobs(env, fetchImpl = fetch) {
  const out = [];
  let page = null;
  for (let i = 0; i < 5; i++) {
    const r = await jt(env, { organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, ...(page ? { page } : {}) }, nextPage: {}, nodes: { id: {}, name: {}, createdAt: {}, closedOn: {}, companycamId: {}, location: { street: {}, account: { name: {} } } } } } }, fetchImpl);
    const jobs = r?.organization?.jobs;
    for (const j of jobs?.nodes || []) {
      if (j.closedOn || isTest(j.name) || isTest(j.location?.account?.name)) continue;
      out.push({ id: j.id, name: j.name || '', createdAt: j.createdAt || null, companycamId: j.companycamId ? String(j.companycamId) : null, street: j.location?.street || '', accountName: j.location?.account?.name || '' });
    }
    if (!jobs?.nextPage) break;
    page = jobs.nextPage;
  }
  return out;
}

/** The job's copies of CompanyCam photos: [{ id, photoId, createdAt, byCompanyCam, comments }] and its hand uploads */
async function jobCopies(env, jobId, fetchImpl) {
  const copies = [];
  let page = null;
  for (let i = 0; i < 25; i++) {
    const r = await jt(env, { job: { $: { id: jobId }, cc: { _: 'files', $: { size: 100, where: ['name', 'like', 'CompanyCam%'], ...(page ? { page } : {}) }, nextPage: {}, nodes: { id: {}, name: {}, createdAt: {}, createdByUser: { name: {} }, comments: { $: { size: 1 }, nodes: { id: {} } } } } } }, fetchImpl);
    const cc = r?.job?.cc;
    for (const f of cc?.nodes || []) {
      const photoId = photoIdOf(f.name);
      if (photoId) copies.push({ id: f.id, photoId, createdAt: f.createdAt, byCompanyCam: f.createdByUser?.name === 'CompanyCam', comments: (f.comments?.nodes || []).length });
    }
    if (!cc?.nextPage) break;
    page = cc.nextPage;
  }
  const hand = await jt(env, { job: { $: { id: jobId }, img: { _: 'files', $: { size: 1, where: ['name', 'like', 'IMG%'] }, count: {} } } }, fetchImpl).catch(() => null);
  return { copies, byHand: hand?.job?.img?.count || 0 };
}

/** Of these projects, the ones a JobTread job uses: Map(project id → job id) */
async function jobsUsing(env, ids, fetchImpl) {
  const list = [...new Set(ids.map(String))];
  if (!list.length) return new Map();
  const r = await jt(env, { organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, where: ['companycamId', 'in', list] }, nodes: { id: {}, companycamId: {} } } } }, fetchImpl);
  return new Map((r?.organization?.jobs?.nodes || []).map((j) => [String(j.companycamId), j.id]));
}

// ─── CompanyCam ─────────────────────────────────────────────────────

/** Every project (open and archived), refreshed hourly: [{ id, name, street, archived, photos, createdAt }] */
async function projectIndex(env, { fetchImpl, now, force = false }) {
  const { DB } = env;
  const have = await getState(DB, 'index');
  if (!force && have?.at && Date.parse(have.at) > now - INDEX_EVERY_MS) return have.projects;
  const slim = (p) => ({ id: String(p.id), name: p.name || '', street: p.address?.street_address_1 || '', archived: !!p.archived, photos: p.photo_count || 0, createdAt: p.created_at || null });
  const [open, archived] = await Promise.all([
    ccAll(env, '/projects', { query: { archived: 'false' }, max: 2000, fetchImpl }),
    ccAll(env, '/projects', { query: { archived: 'true' }, max: 2000, fetchImpl }).catch(() => []),
  ]);
  const seen = new Set();
  const projects = [...open, ...archived].filter((p) => p?.id && !seen.has(String(p.id)) && seen.add(String(p.id))).map(slim);
  await putState(DB, 'index', { at: iso(now), projects }, now);
  return projects;
}

// ─── One job ────────────────────────────────────────────────────────

/** The projects a job's photos come from: Map(project id → why) */
async function sourcesFor(env, job, copies, index, prior, { fetchImpl }) {
  const sources = new Map();
  if (job.companycamId) sources.set(job.companycamId, 'linked');
  // Where its own earlier photos live (remembered, so a photo is looked up once)
  const known = parse(prior?.sources, []).filter((s) => s.why === 'its photos').map((s) => s.id);
  if (known.length) for (const id of known) if (!sources.has(id)) sources.set(id, 'its photos');
  if (!known.length && copies.length) {
    const newest = [...copies].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 3);
    for (const c of newest) {
      try {
        const p = await getPhoto(env, c.photoId, { fetchImpl });
        if (p?.project_id && !sources.has(String(p.project_id))) sources.set(String(p.project_id), 'its photos');
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
  }
  // Nothing yet: the one project named for it
  if (!sources.size) {
    const named = index.filter((p) => nameKey(p.name) === nameKey(job.name));
    if (named.length === 1) sources.set(named[0].id, 'its name');
  }
  // The family's other project at their address (staff started one while JobTread made its own)
  const sk = streetKey(job.street);
  const words = familyWords(job.name);
  const since = (Date.parse(job.createdAt || '') || 0) - SAME_FAMILY_WITHIN_MS;
  if (sk && words.size) {
    for (const p of index) {
      if (sources.has(p.id) || !p.photos || isTest(p.name) || streetKey(p.street) !== sk || !sharesWord(p.name, words)) continue;
      if ((Date.parse(p.createdAt || '') || 0) < since) continue; // an earlier makeover's
      sources.set(p.id, 'same family, same address');
    }
  }
  // Never a project another job holds
  const others = [...sources.keys()].filter((id) => id !== job.companycamId);
  const held = await jobsUsing(env, others, fetchImpl);
  for (const [id, holder] of held) if (holder !== job.id) sources.delete(id);
  return { sources, held: [...held].filter(([, h]) => h !== job.id).map(([id]) => id) };
}

/** Look at one job and copy what it's missing. Returns what it found and copied. Never throws. */
export async function checkJob(env, job, index, { fetchImpl = fetch, now = Date.now(), copy = COPY, dedupe = DEDUPE } = {}) {
  const { DB } = env;
  const prior = await getJob(DB, job.id);
  try {
    const { copies, byHand } = await jobCopies(env, job.id, fetchImpl);
    const { sources, held } = await sourcesFor(env, job, copies, index, prior, { fetchImpl });

    // Every photo in every source, against the job's copies
    const photos = [];
    for (const [id, why] of sources) {
      const list = await projectPhotos(env, id, { max: MAX_PHOTOS, fetchImpl }).catch((e) => { if (e.status === 404) return []; throw e; });
      for (const p of list) if (p?.status !== 'deleted' && p?.processing_status === 'processed') photos.push({ ...p, source: id, why });
    }
    const unique = [...new Map(photos.map((p) => [String(p.id), p])).values()];
    const have = new Set(copies.map((c) => c.photoId));
    let missing = unique.filter((p) => !have.has(String(p.id)));
    const byId = new Map();
    for (const c of copies) byId.set(c.photoId, [...(byId.get(c.photoId) || []), c]);
    const doubles = [...byId.values()].filter((list) => list.length > 1);

    // Copy: a photo JobTread's own link should bring waits its hour; anything else, once CompanyCam has settled it
    let copiedNow = 0;
    let removedNow = 0;
    if (copy) {
      const due = missing.filter((p) => {
        const age = now - Date.parse(p.created_at || p.captured_at || 0);
        return p.source === job.companycamId ? age > LINKED_GRACE_MS : age > FRESH_MS;
      }).slice(0, COPY_PER_RUN);
      const done = new Set();
      for (const p of due) {
        const url = photoImageUrl(p);
        if (!url) continue;
        const uploadRequestId = await uploadToJobTread(env, url, fetchImpl);
        await jt(env, { createFile: { $: { name: ccName(p.id), targetType: 'job', targetId: job.id, uploadRequestId }, createdFile: { id: {} } } }, fetchImpl);
        copiedNow += 1;
        done.add(String(p.id));
      }
      missing = missing.filter((p) => !done.has(String(p.id)));
    }
    if (dedupe) {
      for (const list of doubles) {
        const keep = [...list].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
        for (const c of list) {
          if (c === keep || c.comments || !c.byCompanyCam) continue;
          await jt(env, { deleteFile: { $: { id: c.id } } }, fetchImpl);
          removedNow += 1;
        }
      }
    }

    const main = job.companycamId || [...sources.keys()][0] || null;
    const info = (id) => index.find((p) => p.id === id) || null;
    const row = {
      job_id: job.id, job_name: job.name, project_id: main, project_name: main ? info(main)?.name || null : null, found_by: main ? sources.get(main) || 'linked' : 'none',
      linked: job.companycamId ? 1 : 0, cc_photos: unique.length, jt_copies: copies.length + copiedNow - removedNow, missing: missing.length,
      double_copies: Math.max(0, doubles.reduce((n, l) => n + l.length - 1, 0) - removedNow), by_hand: byHand,
      sources: JSON.stringify([...sources].map(([id, why]) => ({ id, why, name: info(id)?.name || null, photos: info(id)?.photos ?? null }))),
      other_projects: held.length ? JSON.stringify(held) : null,
      copied: (prior?.copied || 0) + copiedNow, removed: (prior?.removed || 0) + removedNow,
      problem: sources.size ? null : 'no-project', detail: sources.size ? null : 'No CompanyCam project for this job', checked_at: now,
    };
    await saveJob(DB, row, now);
    return { row, copied: copiedNow, removed: removedNow };
  } catch (e) {
    await saveJob(DB, { job_id: job.id, job_name: job.name, problem: 'error', detail: errText(e), checked_at: now }, now).catch(() => null);
    return { row: { job_id: job.id, job_name: job.name, problem: 'error', detail: errText(e) }, copied: 0, removed: 0, error: errText(e) };
  }
}

/** A new photo in this project: the jobs it feeds go to the front of the queue (./_companycam-sync.js takeEvent). Never throws. */
export async function nudgeJobsFor(DB, projectId) {
  try {
    const r = await DB.prepare("UPDATE companycam_jobs SET checked_at = 0 WHERE project_id = ? OR instr(COALESCE(sources, ''), ?) > 0")
      .bind(String(projectId), `"id":"${String(projectId)}"`).run();
    return r?.meta?.changes || 0;
  } catch {
    return 0; // no table before the first pass
  }
}

// ─── The heartbeat ──────────────────────────────────────────────────

/** The heartbeat's call: a couple of jobs a tick, each about hourly; Slack once a pass about what was copied. Never throws. */
export async function maybeCheckJobs(env, { fetchImpl = fetch, now = Date.now(), force = false, copy = COPY, dedupe = DEDUPE } = {}) {
  const { DB } = env;
  try {
    if (!DB || !companycamOn(env) || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(DB);
    if (!force && !(await takeTurn(DB, 'tick', MIN, now))) return null;
    const deadline = Date.now() + BUDGET_MS;
    const jobs = await openJobs(env, fetchImpl);
    const { results } = await DB.prepare('SELECT job_id, checked_at FROM companycam_jobs').all();
    const last = new Map((results || []).map((r) => [r.job_id, r.checked_at || 0]));
    const due = jobs.filter((j) => (last.get(j.id) || 0) <= now - CHECK_EVERY_MS).sort((a, b) => (last.get(a.id) || 0) - (last.get(b.id) || 0)).slice(0, PER_TICK);
    if (!due.length) return { checked: 0 };
    const index = await projectIndex(env, { fetchImpl, now });
    const pass = (await getState(DB, 'pass')) || { copied: [] };
    pass.copied ||= [];
    for (const job of due) {
      if (Date.now() > deadline) break;
      const r = await checkJob(env, job, index, { fetchImpl, now, copy, dedupe });
      if (r.copied) pass.copied.push({ job: job.name, count: r.copied });
    }
    const { results: after } = await DB.prepare('SELECT job_id, checked_at FROM companycam_jobs').all();
    const fresh = new Map((after || []).map((r) => [r.job_id, r.checked_at || 0]));
    const complete = jobs.every((j) => (fresh.get(j.id) || 0) > now - CHECK_EVERY_MS);
    if (complete) {
      await putState(DB, 'jobs-audit', await auditSummary(DB, jobs, now, { copy, dedupe }), now);
      if (pass.copied.length) await slackPost(env, copiedCard(pass.copied), { kind: 'news' }).catch(() => null);
      await putState(DB, 'pass', { copied: [] }, now);
    } else {
      await putState(DB, 'pass', pass, now);
    }
    return { checked: due.length, complete };
  } catch (e) {
    if (e instanceof CompanyCamError && e.status === 401) return null; // ./_companycam-sync.js tells Slack about the key
    console.error('[companycam-jobs]', e.message);
    return null;
  }
}

/** What a pass found, for the record and Site → Automations */
async function auditSummary(DB, jobs, now, { copy, dedupe }) {
  const ids = new Set(jobs.map((j) => j.id));
  const { results } = await DB.prepare('SELECT * FROM companycam_jobs ORDER BY job_name').all();
  const rows = (results || []).filter((r) => ids.has(r.job_id));
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  return {
    at: iso(now), copy, dedupe, jobs: rows.length, linked: rows.filter((r) => r.linked).length, withPhotos: rows.filter((r) => r.cc_photos).length,
    missing: sum('missing'), doubleCopies: sum('double_copies'), byHand: sum('by_hand'), copied: sum('copied'), removed: sum('removed'),
    missingBy: rows.filter((r) => r.missing).map((r) => ({ job: r.job_name, missing: r.missing })),
    doublesBy: rows.filter((r) => r.double_copies).map((r) => ({ job: r.job_name, doubles: r.double_copies })),
    twoProjects: rows.filter((r) => parse(r.sources, []).length > 1).map((r) => ({ job: r.job_name, projects: parse(r.sources, []).map((s) => s.name) })),
    noProject: rows.filter((r) => r.problem === 'no-project').map((r) => r.job_name),
    errors: rows.filter((r) => r.problem === 'error').map((r) => ({ job: r.job_name, detail: r.detail })),
  };
}

function copiedCard(copied) {
  const total = copied.reduce((n, c) => n + c.count, 0);
  return slackCard({
    icon: '📸', title: `${total} CompanyCam photo${total === 1 ? '' : 's'} copied into JobTread`,
    lead: copied.slice(0, 20).map((c) => `${c.job}: ${c.count}`).join('\n'),
    footer: 'They were in CompanyCam but not on the job (JobTread’s link had dropped, or the photos were in a second project). The site checks every open job hourly.',
  });
}

/** For Site → Automations */
export async function jobsFacts(env) {
  if (!companycamOn(env)) return { on: false };
  await ensureSchema(env.DB);
  const audit = await getState(env.DB, 'jobs-audit');
  const { results } = await env.DB.prepare('SELECT max(checked_at) AS at, count(*) AS n FROM companycam_jobs').all();
  return { on: true, copy: COPY, dedupe: DEDUPE, audit, lastChecked: results?.[0]?.at ? iso(results[0].at) : null, jobs: results?.[0]?.n || 0 };
}
