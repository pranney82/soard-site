/**
 * CompanyCam ↔ JobTread jobs: keeping JobTread's own integration whole
 * ===========================================================================
 * Peter, Oct 21 2026: "my team is saying that the comapny cam to jt
 * connection hasnt always been working and they have duplicates" ... "do it
 * all". What JobTread showed that day: 13 of 18 open makeover jobs had lost
 * their CompanyCam link (JobTread's integration clears it, several jobs
 * within the same minutes on May 19), so photos taken since never reached
 * JobTread, and staff uploaded phone photos by hand.
 *
 * Every open job (not "TEST …") gets a look about once an hour, a few per
 * heartbeat:
 *   - Its project: the one it's linked to; else the project its own earlier
 *     CompanyCam photos came from (CompanyCam says which, by photo id); else
 *     the one project named for the job. Never one another job uses.
 *   - Photos in that project against JobTread's copies ("CompanyCam <id>"),
 *     copies JobTread holds twice, other projects at the same address with
 *     photos (a family's photos split over two), photos uploaded by hand.
 *   - Repair (REPAIR): a job that lost its link is linked again, and JobTread
 *     copies what it's missing. A photo still missing after REFILL_AFTER_MS
 *     is copied by the site under JobTread's own name. A second copy of the
 *     same CompanyCam photo is removed (the oldest stays; never one someone
 *     commented on). Slack hears what was fixed, once a run, and once about
 *     what only a person can fix: two projects to merge in CompanyCam (its
 *     API can't move photos), or a project JobTread says another job holds.
 *
 * Results in D1 companycam_jobs and companycam_state "jobs-audit" (Site →
 * Automations). Env: COMPANYCAM_TOKEN, JOBTREAD_GRANT_KEY.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import { jobtreadJobUrl } from './_applicants.js';
import { slackPost, slackIssue, slackResolved } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { companycamOn, CompanyCamError, ccAll, getPhoto, projectPhotos, photoImageUrl, projectUrl } from './_companycam.js';
import { uploadToJobTread } from './_companycam-sync.js';

export const REPAIR = false; // the first passes only look; flipped once their report was read
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const CHECK_EVERY_MS = HOUR;
const INDEX_EVERY_MS = HOUR;
const PER_TICK = 2;
const BUDGET_MS = 18000;
const REFILL_AFTER_MS = 30 * MIN;  // JobTread copies a relinked project's photos within seconds; this is room to spare
const MISSING_GRACE_MS = HOUR;     // a photo taken minutes ago may still be on its way
const COPY_PER_RUN = 12;
const MAX_PHOTOS = 2000;

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
const COLS = ['job_name', 'project_id', 'project_name', 'found_by', 'linked', 'cc_photos', 'jt_copies', 'missing', 'double_copies', 'by_hand', 'other_projects', 'relinked_at', 'relinks', 'copied', 'removed', 'problem', 'detail', 'checked_at'];
async function saveJob(DB, row, now) {
  const cols = COLS.filter((c) => c in row);
  await DB.prepare(`INSERT INTO companycam_jobs (job_id, ${cols.join(', ')}, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)
    ON CONFLICT(job_id) DO UPDATE SET ${[...cols.map((c) => `${c} = excluded.${c}`), 'updated_at = excluded.updated_at'].join(', ')}`)
    .bind(row.job_id, ...cols.map((c) => row[c] ?? null), iso(now)).run();
}
const getJob = (DB, jobId) => DB.prepare('SELECT * FROM companycam_jobs WHERE job_id = ?').bind(jobId).first();

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

/** The job's copies of CompanyCam photos: [{ id, name, photoId, createdAt, byCompanyCam, comments }] and its hand uploads */
async function jobCopies(env, jobId, fetchImpl) {
  const copies = [];
  let page = null;
  for (let i = 0; i < 25; i++) {
    const r = await jt(env, { job: { $: { id: jobId }, cc: { _: 'files', $: { size: 100, where: ['name', 'like', 'CompanyCam%'], ...(page ? { page } : {}) }, nextPage: {}, nodes: { id: {}, name: {}, createdAt: {}, createdByUser: { name: {} }, comments: { $: { size: 1 }, nodes: { id: {} } } } } } }, fetchImpl);
    const cc = r?.job?.cc;
    for (const f of cc?.nodes || []) {
      const photoId = photoIdOf(f.name);
      if (photoId) copies.push({ id: f.id, name: f.name, photoId, createdAt: f.createdAt, byCompanyCam: f.createdByUser?.name === 'CompanyCam', comments: (f.comments?.nodes || []).length });
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

/** The job's project, and how it was found */
async function projectFor(env, job, copies, index, row, { fetchImpl }) {
  if (job.companycamId) return { projectId: job.companycamId, foundBy: 'linked' };
  if (row?.project_id) return { projectId: row.project_id, foundBy: row.found_by || 'remembered' };
  // Where its own earlier CompanyCam photos live (newest first: a later project wins)
  const newest = [...copies].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 3);
  for (const c of newest) {
    try {
      const p = await getPhoto(env, c.photoId, { fetchImpl });
      if (p?.project_id) return { projectId: String(p.project_id), foundBy: 'its photos' };
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  // The one project named for the job (JobTread names its projects "<job> (NNN)")
  const want = nameKey(job.name);
  const named = index.filter((p) => nameKey(p.name) === want);
  if (named.length === 1) return { projectId: named[0].id, foundBy: 'its name' };
  return { projectId: null, foundBy: named.length > 1 ? 'several named for it' : 'none' };
}

/**
 * Look at one job, and (REPAIR) fix what can be fixed. Returns what it found
 * and did. Never throws.
 */
export async function checkJob(env, job, index, { fetchImpl = fetch, now = Date.now(), repair = REPAIR } = {}) {
  const { DB } = env;
  const prior = await getJob(DB, job.id);
  const did = [];
  try {
    const { copies, byHand } = await jobCopies(env, job.id, fetchImpl);
    let { projectId, foundBy } = await projectFor(env, job, copies, index, prior, { fetchImpl });
    const project = projectId ? index.find((p) => p.id === projectId) : null;

    // Another job holds this project: not this job's to take
    if (projectId && !job.companycamId) {
      const holder = (await jobsUsing(env, [projectId], fetchImpl)).get(projectId);
      if (holder && holder !== job.id) { projectId = null; foundBy = 'held by another job'; }
    }

    // Other projects at the same address with photos in them: the family's photos split over two
    const sk = streetKey(job.street);
    const others = sk ? index.filter((p) => p.id !== projectId && p.photos > 0 && streetKey(p.street) === sk && !/^\s*test\b/i.test(p.name)) : [];
    const othersFree = others.length ? await jobsUsing(env, others.map((p) => p.id), fetchImpl) : new Map();
    const split = others.filter((p) => !othersFree.has(p.id)).map((p) => ({ id: p.id, name: p.name, photos: p.photos, archived: p.archived }));

    // Photos against copies
    const photos = projectId ? await projectPhotos(env, projectId, { max: MAX_PHOTOS, fetchImpl }).catch((e) => { if (e.status === 404) return []; throw e; }) : [];
    const live = photos.filter((p) => p?.status !== 'deleted' && p?.processing_status !== 'duplicate');
    const haveIds = new Set(copies.map((c) => c.photoId));
    const missing = live.filter((p) => !haveIds.has(String(p.id)));
    const byId = new Map();
    for (const c of copies) byId.set(c.photoId, [...(byId.get(c.photoId) || []), c]);
    const doubles = [...byId.values()].filter((list) => list.length > 1);

    let linked = !!job.companycamId;
    let problem = null;
    let detail = null;
    let relinkedAt = prior?.relinked_at || null;
    let relinks = prior?.relinks || 0;
    let copied = prior?.copied || 0;
    let removed = prior?.removed || 0;
    let copiedNow = 0;
    let removedNow = 0;

    if (repair) {
      // 1. The link JobTread lost
      if (!linked && projectId) {
        try {
          await jt(env, { updateJob: { $: { id: job.id, companycamId: projectId } } }, fetchImpl);
          linked = true; relinkedAt = iso(now); relinks += 1;
          did.push({ job: job.name, did: 'linked again', project: project?.name || projectId, missing: missing.length });
        } catch (e) {
          if (!/JobTread returned 4\d\d/.test(e.message)) throw e;
          problem = 'link-refused'; detail = errText(e);
        }
      }
      // 2. Copies JobTread made twice: the oldest stays
      for (const list of doubles) {
        const keep = [...list].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
        for (const c of list) {
          if (c === keep || c.comments || !c.byCompanyCam) continue;
          await jt(env, { deleteFile: { $: { id: c.id } } }, fetchImpl);
          removed += 1; removedNow += 1;
        }
      }
      // 3. Photos still missing once JobTread has had its turn
      const settled = !relinkedAt || now - Date.parse(relinkedAt) > REFILL_AFTER_MS;
      if (linked && settled) {
        const due = missing.filter((p) => now - Date.parse(p.created_at || p.captured_at || 0) > MISSING_GRACE_MS).slice(0, COPY_PER_RUN);
        for (const p of due) {
          const url = photoImageUrl(p);
          if (!url) continue;
          const uploadRequestId = await uploadToJobTread(env, url, fetchImpl);
          await jt(env, { createFile: { $: { name: ccName(p.id), targetType: 'job', targetId: job.id, uploadRequestId }, createdFile: { id: {} } } }, fetchImpl);
          copied += 1; copiedNow += 1;
        }
        if (due.length) did.push({ job: job.name, did: 'copied missing photos', count: due.length });
      }
    }
    if (!projectId && !problem) { problem = foundBy === 'held by another job' ? 'project-held' : 'no-project'; detail = foundBy; }

    const row = {
      job_id: job.id, job_name: job.name, project_id: projectId, project_name: project?.name || null, found_by: foundBy, linked: linked ? 1 : 0,
      cc_photos: live.length, jt_copies: copies.length + copiedNow - removedNow, missing: Math.max(0, missing.length - copiedNow), double_copies: Math.max(0, doubles.reduce((n, l) => n + l.length - 1, 0) - removedNow), by_hand: byHand,
      other_projects: split.length ? JSON.stringify(split) : null, relinked_at: relinkedAt, relinks, copied, removed, problem, detail, checked_at: now,
    };
    await saveJob(DB, row, now);
    return { row, did, split };
  } catch (e) {
    await saveJob(DB, { job_id: job.id, job_name: job.name, problem: 'error', detail: errText(e), checked_at: now }, now).catch(() => null);
    return { row: { job_id: job.id, job_name: job.name, problem: 'error', detail: errText(e) }, did, split: [], error: errText(e) };
  }
}

// ─── The heartbeat ──────────────────────────────────────────────────

/**
 * The heartbeat's call: a few jobs a tick, each about once an hour; Slack
 * once per pass about what was fixed, and once per job about what needs a
 * person. Never throws.
 */
export async function maybeCheckJobs(env, { fetchImpl = fetch, now = Date.now(), force = false, repair = REPAIR } = {}) {
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
    const pass = (await getState(DB, 'pass')) || { did: [] };
    for (const job of due) {
      if (Date.now() > deadline) break;
      const r = await checkJob(env, job, index, { fetchImpl, now, repair });
      pass.did.push(...r.did);
      if (repair) await needsAPerson(env, job, r, now); // the read-only passes tell nobody
    }
    // A pass is over when every open job has had its look: then the report, and Slack hears what was fixed
    const { results: after } = await DB.prepare('SELECT job_id, checked_at FROM companycam_jobs').all();
    const fresh = new Map((after || []).map((r) => [r.job_id, r.checked_at || 0]));
    const complete = jobs.every((j) => (fresh.get(j.id) || 0) > now - CHECK_EVERY_MS);
    if (complete) {
      await putState(DB, 'jobs-audit', await auditSummary(DB, jobs, now, repair), now);
      if (pass.did.length) await slackPost(env, fixedCard(pass.did), { kind: 'news' }).catch(() => null);
      await putState(DB, 'pass', { did: [] }, now);
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
async function auditSummary(DB, jobs, now, repair) {
  const ids = new Set(jobs.map((j) => j.id));
  const { results } = await DB.prepare('SELECT * FROM companycam_jobs ORDER BY job_name').all();
  const rows = (results || []).filter((r) => ids.has(r.job_id));
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  return {
    at: iso(now), repair, jobs: rows.length, linked: rows.filter((r) => r.linked).length,
    unlinked: rows.filter((r) => !r.linked).map((r) => ({ job: r.job_name, project: r.project_name, foundBy: r.found_by, missing: r.missing })),
    missing: sum('missing'), doubleCopies: sum('double_copies'), byHand: sum('by_hand'), relinks: sum('relinks'), copied: sum('copied'), removed: sum('removed'),
    split: rows.filter((r) => r.other_projects).map((r) => ({ job: r.job_name, others: JSON.parse(r.other_projects) })),
    problems: rows.filter((r) => r.problem).map((r) => ({ job: r.job_name, problem: r.problem, detail: r.detail })),
  };
}

function fixedCard(did) {
  const lines = did.map((d) => (d.did === 'linked again' ? `${d.job}: linked to its CompanyCam project again${d.missing ? ` (${d.missing} photos to bring in)` : ''}` : `${d.job}: ${d.count} missing photo${d.count === 1 ? '' : 's'} copied`));
  return slackCard({
    icon: '🔗', title: 'CompanyCam photos are reaching JobTread again',
    lead: lines.slice(0, 20).join('\n'),
    footer: 'JobTread’s CompanyCam link had dropped on these jobs. The site checks every open job hourly.',
  });
}

/** Two projects to merge, or a project JobTread says another job holds: Slack once, ✅ when it clears */
async function needsAPerson(env, job, r, now) {
  const key = `companycam:job:${job.id}`;
  const split = r.split || [];
  const held = r.row?.problem === 'project-held' || r.row?.problem === 'link-refused';
  const st = (await getState(env.DB, key)) || {};
  if (split.length || held) {
    if (st.alerted) return;
    const lead = held
      ? 'Its CompanyCam project is linked to another job, so JobTread won’t link it here.'
      : `Its photos are split: ${split.map((p) => `“${p.name}” (${p.photos} photos)`).join(', ')} at the same address isn’t linked to any job.`;
    const fix = held
      ? 'In JobTread, check which job should have the project, and unlink it from the other.'
      : 'In CompanyCam, open the extra project and merge it into the job’s project (Project → ⋯ → Merge). Its photos then reach JobTread.';
    await slackIssue(env, key, slackCard({ icon: '⚠️', title: `${job.name}: CompanyCam needs a hand`, lead, fix, buttons: [{ label: 'Open the job in JobTread', url: jobtreadJobUrl(job.id) }, ...(split[0] ? [{ label: 'Open the extra project', url: projectUrl(split[0].id) }] : [])] }), { title: `${job.name}: CompanyCam`, kind: 'attention' }).catch(() => null);
    await putState(env.DB, key, { alerted: iso(now) }, now);
  } else if (st.alerted) {
    await slackResolved(env, key, slackCard({ icon: '✅', title: `${job.name}: CompanyCam sorted`, lead: 'One project, linked, and its photos reach JobTread.' }), { summary: 'Sorted' }).catch(() => null);
    await putState(env.DB, key, {}, now);
  }
}

/** For Site → Automations */
export async function jobsFacts(env) {
  if (!companycamOn(env)) return { on: false };
  await ensureSchema(env.DB);
  const audit = await getState(env.DB, 'jobs-audit');
  const { results } = await env.DB.prepare('SELECT max(checked_at) AS at, count(*) AS n FROM companycam_jobs').all();
  return { on: true, repair: REPAIR, audit, lastChecked: results?.[0]?.at ? iso(results[0].at) : null, jobs: results?.[0]?.n || 0 };
}
