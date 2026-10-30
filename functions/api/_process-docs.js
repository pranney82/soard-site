/**
 * The makeover process, from SOARD's own Google Docs
 * ===========================================================================
 * (and the money side's rules, from the board's Financial Policy Manual)
 *
 * Site → Automations → Process shows how a kid's makeover and a community
 * project go, step by step, with what runs on its own at each step. The steps
 * are SOARD's two process Docs in the shared drive ("2026 Sunshine Makeover
 * Process", "2026 Sunshine Community Project Process"), read as they are:
 *  - found in Drive by name, the latest year first (a pasted link in Process
 *    overrides that, for a Doc named some other way)
 *  - read as the staff member looking at Process, through the site's service
 *    account (domain-wide delegation, drive.readonly: the scope Board's Drive
 *    reading already has), else as one of Board's admins
 *  - Drive is asked at most every 2 minutes; the Doc is read again only when
 *    it changed. The last good copy stays in D1, so a Drive hiccup shows that
 *    copy with a note, never an empty page
 * It never writes, moves or shares anything in Drive.
 *
 * The heartbeat checks both Docs hourly too (as Board's admins), so the
 * automations map knows when Drive stops answering without anyone opening
 * Process, and Process opens on a current copy.
 *
 * With them, who's at each stage right now: families and organizations at
 * Applied and In Review (the Applicants mirror), and open jobs by their
 * JobTread Status (a light read of JobTread, kept 5 minutes), each named and
 * linked: a family to its page in Applicants, a job to JobTread.
 */

import { accessToken } from './_google-calendar.js';
import { boardAdmins, isStaffEmail, activeBoard } from './_board-roles.js';
import { JT_URL, SOARD_ORG_ID, FIELD_JOB_STATUS, loadKids, loadProjects, matchProject, isProject, isRehearsalJob } from './_reveals.js';
import { jobtreadJobUrl } from './_applicants.js';
import { accountKindFor } from './_applicant-comms.js';
import { kindOf } from './_application-form.js';
import { DOCS, PROJECT_TRACKS, DOC_SEARCH, DOC_LIKE, GOOGLE_DOC, parseProcessHtml, policySections, approvalTiers, pickDoc, docIdOf } from '../../public/admin/process-shared.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,trashed,lastModifyingUser(displayName)';
/** How often Drive is asked whether a Doc changed */
export const CHECK_MS = 2 * 60 * 1000;
/** JobTread's job statuses from approved to built, in order (On Site: where an approved family's job starts) */
export const JOB_STAGES = ['On Site', 'Awaiting Funding', 'Design', 'Finalization', 'Approval', 'Mobilization', 'Build'];
const NAMES = 20;
const JOBS_MS = 5 * 60 * 1000;
/** How often the heartbeat checks the Docs */
export const REFRESH_MS = 60 * 60 * 1000;

const SCHEMA = 'CREATE TABLE IF NOT EXISTS process_docs (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)';
const _ready = new WeakSet();
async function ensure(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  _ready.add(DB);
}
async function readRow(DB, key) {
  const row = await DB.prepare('SELECT data FROM process_docs WHERE key = ?').bind(key).first();
  try { return row ? JSON.parse(row.data) || {} : {}; } catch { return {}; }
}
async function writeRow(DB, key, value, now) {
  await DB.prepare('INSERT INTO process_docs (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), new Date(now).toISOString()).run();
  return value;
}

/** The Doc links staff pasted in Process: { makeover: id|null, community: id|null, policy: id|null } */
export async function readOverrides(DB) {
  await ensure(DB);
  const s = await readRow(DB, 'settings');
  return Object.fromEntries(DOCS.map((d) => [d, s[d] || null]));
}
/** Each Doc's last yearly review marked in Process: { makeover: { at, by } | null, … } */
export async function readReviews(DB) {
  await ensure(DB);
  const r = await readRow(DB, 'reviews');
  return Object.fromEntries(DOCS.map((d) => [d, r[d]?.at ? { at: r[d].at, by: r[d].by || null } : null]));
}
/** "Reviewed, no changes": the Doc was looked over today, by whom → that review */
export async function markReviewed(DB, doc, by, now = Date.now()) {
  if (!DOCS.includes(doc)) throw Object.assign(new Error('Unknown process'), { status: 400 });
  await ensure(DB);
  const r = await readRow(DB, 'reviews');
  r[doc] = { at: new Date(now).toISOString(), by: by || null };
  await writeRow(DB, 'reviews', r, now);
  return r[doc];
}

/** Follow a pasted Doc instead of the one found by name ('' goes back to finding it) → the id, or null */
export async function setOverride(DB, track, link, now = Date.now()) {
  if (!DOCS.includes(track)) throw Object.assign(new Error('Unknown process'), { status: 400 });
  const id = link ? docIdOf(link) : '';
  if (link && !id) throw Object.assign(new Error('That isn’t a link to a Google Doc. Copy it from the Doc’s address bar or its Share button.'), { status: 400 });
  const s = await readOverrides(DB);
  s[track] = id || null;
  await writeRow(DB, 'settings', s, now);
  // Read it at once, not after the 2-minute wait
  const last = await readRow(DB, `doc:${track}`);
  if (last.checkedAt) await writeRow(DB, `doc:${track}`, { ...last, checkedAt: null }, now);
  return s[track];
}

class DriveError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function drive(token, path, fetchImpl, { text = false } = {}) {
  const res = await fetchImpl(`${DRIVE_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new DriveError(body?.error?.message || `Drive answered ${res.status}`, res.status);
  }
  return text ? res.text() : res.json();
}

/** Plain words for what went wrong reading a Doc */
function problemOf(err) {
  const m = String(err?.message || err || '');
  if (/unauthorized_client|access_denied|not authorized/i.test(m)) return 'Google hasn’t allowed the site to read Drive. Google Admin → Security → API controls → Domain-wide delegation: add drive.readonly to the site’s service account (Board → Meetings says how).';
  if (err?.status === 403 && /has not been used|is disabled|accessNotConfigured/i.test(m)) return 'The Google Drive API is switched off for the site’s Google project.';
  if (err?.status === 404) return 'That Doc is gone, or isn’t shared with whoever opened Process.';
  if (/GOOGLE_CALENDAR_KEY/.test(m)) return 'GOOGLE_CALENDAR_KEY is missing in Cloudflare, so the site can’t reach Google Drive.';
  return `Google Drive: ${m.slice(0, 200)}`;
}

/** A Drive token: as the staff member looking, else as Board's admins, the first Google lets in */
async function tokenFor(env, user, { fetchImpl, now }) {
  const people = [...new Set([isStaffEmail(user) ? user : null, ...(await boardAdmins(env.DB).catch(() => []))].filter(Boolean))];
  let last = null;
  for (const who of people) {
    try { return await accessToken(env, who, { fetchImpl, now, scope: DRIVE_SCOPE }); } catch (err) { last = err; }
  }
  throw last || new Error('Nobody to read Drive as: no staff sign-in and no Board admin.');
}

async function findDoc(token, track, override, fetchImpl) {
  if (override) return drive(token, `/files/${encodeURIComponent(override)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, fetchImpl);
  const q = [...DOC_SEARCH[track], `mimeType = '${GOOGLE_DOC}'`, 'trashed = false'].join(' and ');
  const body = await drive(token, `/files?q=${encodeURIComponent(q)}&corpora=allDrives&${ALL}&orderBy=modifiedTime%20desc&pageSize=50&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}`, fetchImpl);
  return pickDoc(body.files || [], track);
}

/** What Process shows of a saved read (the steps or the manual's sections, the Doc, and any problem) */
const view = (d) => ({
  ...(d.sections ? { sections: d.sections } : {}),
  doc: d.id ? { id: d.id, name: d.name, url: d.url || `https://docs.google.com/document/d/${d.id}/edit`, modifiedTime: d.modifiedTime || null, modifiedBy: d.modifiedBy || null } : null,
  steps: d.steps || [],
  readAt: d.readAt || null,
  checkedAt: d.checkedAt || null,
  error: d.error || null,
  errorAt: d.errorAt || null,
  override: !!d.override,
});

/**
 * Each track's Doc, read again when it changed → { makeover: view, community: view }.
 * `fresh` asks Drive now instead of within 2 minutes.
 */
export async function processDocs(env, { user = '', fetchImpl = fetch, now = Date.now(), fresh = false } = {}) {
  await ensure(env.DB);
  const overrides = await readOverrides(env.DB);
  const lasts = Object.fromEntries(await Promise.all(DOCS.map(async (t) => [t, await readRow(env.DB, `doc:${t}`)])));
  const due = DOCS.filter((t) => {
    const l = lasts[t];
    if (fresh || !l.checkedAt || l.error) return true;
    if ((overrides[t] || null) !== (l.override || null)) return true;
    return now - Date.parse(l.checkedAt) >= CHECK_MS;
  });
  if (due.length) {
    let token = null;
    let tokenErr = null;
    try { token = await tokenFor(env, user, { fetchImpl, now }); } catch (err) { tokenErr = err; }
    await Promise.all(due.map(async (track) => {
      const last = lasts[track];
      const at = new Date(now).toISOString();
      const failed = (err) => ({ ...last, override: overrides[track] || null, checkedAt: at, error: problemOf(err), errorAt: at });
      try {
        if (!token) throw tokenErr;
        const file = await findDoc(token, track, overrides[track], fetchImpl);
        if (!file || file.trashed) {
          const name = track === 'policy' ? DOC_LIKE.policy : `${new Date(now).getFullYear()} ${DOC_LIKE[track]}`;
          lasts[track] = await writeRow(env.DB, `doc:${track}`, { ...failed(null), error: `No Google Doc named like “${name}” is shared with whoever opened Process. Paste the Doc’s link to follow it.` }, now);
          return;
        }
        const meta = { id: file.id, name: file.name, url: file.webViewLink || null, modifiedTime: file.modifiedTime || null, modifiedBy: file.lastModifyingUser?.displayName || null, override: overrides[track] || null };
        // Unchanged since the last read: only the check is new
        if ((last.steps?.length || last.sections?.length) && last.id === file.id && last.modifiedTime === file.modifiedTime) {
          lasts[track] = await writeRow(env.DB, `doc:${track}`, { ...last, ...meta, checkedAt: at, error: null, errorAt: null }, now);
          return;
        }
        const html = await drive(token, `/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent('text/html')}`, fetchImpl, { text: true });
        // The manual: its sections by its contents; a process: its numbered steps
        const read = track === 'policy' ? { sections: policySections(html) } : { steps: parseProcessHtml(html).steps };
        if (!(read.steps || read.sections).length) {
          const why = track === 'policy' ? `“${file.name}” has no table of contents to find its sections by.` : `“${file.name}” has no numbered list, so there are no steps to show.`;
          lasts[track] = await writeRow(env.DB, `doc:${track}`, { ...last, ...meta, checkedAt: at, error: why, errorAt: at }, now);
          return;
        }
        lasts[track] = await writeRow(env.DB, `doc:${track}`, { ...meta, ...read, readAt: at, checkedAt: at, error: null, errorAt: null }, now);
      } catch (err) {
        console.error(`[process] ${track}`, err?.message);
        lasts[track] = await writeRow(env.DB, `doc:${track}`, failed(err), now);
      }
    }));
  }
  return Object.fromEntries(DOCS.map((t) => [t, view(lasts[t])]));
}

/**
 * The money side's settings against the manual → { approvals: { ok, text } | null }
 * Its Expenditures tiers ("over $15,000: Board Chair") against Job Costs →
 * Bills → Settings: the second-approval amount, and whether the Board Chair
 * (People → Board, the chair's seat) is a second approver. Names only, never emails.
 */
export async function policyChecks(env, policy) {
  const tiers = approvalTiers(policy?.sections);
  const top = tiers.filter((t) => t.over > 0).sort((a, b) => b.over - a.over)[0];
  if (!top) return { approvals: null };
  let cfg = {};
  try { cfg = JSON.parse((await env.DB.prepare("SELECT data FROM spend_state WHERE key = 'bill-pay'").first('data')) || '{}') || {}; } catch { /* not set up */ }
  const second = Math.round((cfg.bigBillCents ?? 1000000) / 100);
  const bigApprovers = (cfg.bigApprovers || []).map((e) => String(e).toLowerCase());
  const money = (n) => `$${n.toLocaleString('en-US')}`;
  const problems = [];
  let chair = null;
  if (/board chair/i.test(top.by)) {
    chair = (await activeBoard(env.DB).catch(() => [])).find((p) => p.seat === 'chair') || null;
    if (!chair) problems.push('Nobody holds the Chair’s seat in People → Board.');
    else if (!chair.email || !bigApprovers.includes(chair.email)) problems.push(`${chair.name}, the Board Chair, isn’t a second approver in Job Costs → Bills → Settings.`);
  }
  if (second > top.over) problems.push(`Bills up to ${money(second)} need only one approver.`);
  const rule = `The manual: over ${money(top.over)}, the ${top.by} approves.`;
  return {
    approvals: problems.length
      ? { ok: false, text: `${rule} ${problems.join(' ')}` }
      : { ok: true, text: `${rule} Bills over ${money(second)} need a second approver${chair ? `, and ${chair.name} is one` : ''}.` },
  };
}

/** For Site → Automations: each Doc's name, when it changed and was last reviewed, its last read and any problem (no steps) */
export async function processFacts(DB) {
  try {
    await ensure(DB);
    const reviews = await readReviews(DB);
    const out = {};
    for (const t of DOCS) {
      const d = await readRow(DB, `doc:${t}`);
      out[t] = { name: d.name || null, modifiedTime: d.modifiedTime || null, reviewedAt: reviews[t]?.at || null, readAt: d.readAt || null, checkedAt: d.checkedAt || null, steps: d.steps?.length || d.sections?.length || 0, error: d.error || null, errorAt: d.errorAt || null };
    }
    return out;
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * On the heartbeat: both Docs checked hourly as Board's admins, so the map
 * shows a Drive problem without anyone opening Process. Never throws.
 */
export async function maybeRefreshProcess(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    await ensure(env.DB);
    const slot = await readRow(env.DB, 'refresh');
    if (slot.at && now - Date.parse(slot.at) < REFRESH_MS) return null;
    await writeRow(env.DB, 'refresh', { at: new Date(now).toISOString() }, now);
    const lasts = await Promise.all(DOCS.map((t) => readRow(env.DB, `doc:${t}`)));
    if (lasts.every((l) => l.checkedAt && !l.error && now - Date.parse(l.checkedAt) < REFRESH_MS)) return null;
    return await processDocs(env, { fetchImpl, now });
  } catch (err) {
    console.error('[process] refresh', err?.message);
    return null;
  }
}

// ─── Who's where right now ────────────────

const listOf = (items) => ({ n: items.length, names: items.slice(0, NAMES) });
const bare = (name) => String(name || '').replace(/\s*\(\d{4}\)\s*$/, '').trim();

/** Applicants at Applied and In Review, by kind (TEST and archived left out), each linked to its page in Applicants */
async function applicantsNow(DB) {
  const run = (sql) => DB.prepare(sql).all().then((r) => r.results || []);
  const base = `SELECT a.account_id, a.name, a.status, a.fields%s FROM applicants a%s WHERE a.archived_at IS NULL AND a.status IN ('Applied', 'In Review') ORDER BY a.created_at`;
  let rows;
  try {
    rows = await run(base.replace('%s', ', ap.kind, ap.is_test').replace('%s', ' LEFT JOIN applications ap ON ap.jt_account_id = a.account_id'));
  } catch {
    try { rows = await run(base.replace('%s', '').replace('%s', '')); } catch { return null; }
  }
  const out = { makeover: { Applied: [], 'In Review': [] }, community: { Applied: [], 'In Review': [] } };
  for (const r of rows) {
    if (r.is_test || /^\s*test\b/i.test(r.name || '')) continue;
    let fields = {};
    try { fields = JSON.parse(r.fields || '{}') || {}; } catch { /* none */ }
    const kind = r.kind ? kindOf(r.kind) : accountKindFor({ birthday: fields.birthday, diagnosis: fields.diagnosis, name: r.name });
    out[kind === 'organization' ? 'community' : 'makeover'][r.status].push({ name: r.name || 'A family', href: `#applications/applicants/${r.account_id}` });
  }
  return out;
}

/** SOARD's open jobs, each with only its Status (one custom field, so the read stays small) */
async function openJobs(grantKey, fetchImpl) {
  const jobs = [];
  let page = null;
  for (let i = 0; i < 10; i++) {
    const res = await fetchImpl(JT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { $: { grantKey }, organization: { $: { id: SOARD_ORG_ID }, jobs: {
        $: { size: 100, where: ['closedOn', '=', null], ...(page ? { page } : {}) },
        nextPage: {},
        nodes: { id: {}, name: {}, customFieldValues: { $: { size: 1, where: [['customField', 'id'], '=', FIELD_JOB_STATUS] }, nodes: { value: {} } } },
      } } } }),
    });
    if (!res.ok) throw new Error(`JobTread returned ${res.status}`);
    const conn = (await res.json())?.organization?.jobs;
    if (!conn) throw new Error('JobTread sent no jobs');
    jobs.push(...(conn.nodes || []));
    page = conn.nextPage || null;
    if (!page) break;
  }
  return jobs;
}

/**
 * Open jobs by Status and track → { makeover: { Design: [{ name, href, page? }], … }, community: … }
 * A job is a community project's when it's linked to one or named for one,
 * else an organization's account says so, else it's a makeover. Kept 5 minutes.
 */
async function jobsNow(env, { fetchImpl, now }) {
  const cached = await readRow(env.DB, 'jobs');
  if (cached.at && now - Date.parse(cached.at) < JOBS_MS) return cached.value;
  if (!env.JOBTREAD_GRANT_KEY) return cached.value || null;
  try {
    const [jobs, kids, projects] = await Promise.all([
      openJobs(env.JOBTREAD_GRANT_KEY, fetchImpl),
      loadKids(env.DB).catch(() => []),
      loadProjects(env.DB, { drafts: true }).catch(() => []),
    ]);
    // The account behind each job, for an organization whose project isn't made yet
    const orgJobs = new Set();
    try {
      const { results } = await env.DB.prepare('SELECT job_id, name, fields FROM applicants WHERE job_id IS NOT NULL').all();
      for (const r of results || []) {
        let f = {};
        try { f = JSON.parse(r.fields || '{}') || {}; } catch { /* none */ }
        if (accountKindFor({ birthday: f.birthday, diagnosis: f.diagnosis, name: r.name }) === 'organization') orgJobs.add(r.job_id);
      }
    } catch { /* no mirror yet */ }
    const value = { makeover: {}, community: {} };
    for (const job of jobs) {
      if (isRehearsalJob(job)) continue;
      const status = String(job.customFieldValues?.nodes?.[0]?.value || '').trim();
      if (!JOB_STAGES.includes(status)) continue;
      const hit = matchProject(job.name, [...kids, ...projects], job.id);
      const community = isProject(hit) || orgJobs.has(job.id);
      const page = hit ? (isProject(hit) ? hit.page : `/kids/${hit.slug}/`) : null;
      (value[community ? 'community' : 'makeover'][status] ||= []).push({ name: hit?.name || bare(job.name) || 'A job', href: jobtreadJobUrl(job.id), ...(page ? { page } : {}) });
    }
    await writeRow(env.DB, 'jobs', { at: new Date(now).toISOString(), value }, now);
    return value;
  } catch (err) {
    console.error('[process] jobs', err?.message);
    return cached.value || null;
  }
}

/**
 * Right now, per track → { makeover: { applied, inReview, jobs: { 'On Site': { n, names }, … } }, community: … }
 * names: [{ name, href, page? }]. A part is null when its source can't be read.
 */
export async function pipelineNow(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  await ensure(env.DB);
  const [apps, jobs] = await Promise.all([
    applicantsNow(env.DB).catch(() => null),
    jobsNow(env, { fetchImpl, now }).catch(() => null),
  ]);
  const out = {};
  for (const t of PROJECT_TRACKS) {
    out[t] = {
      applied: apps ? listOf(apps[t].Applied) : null,
      inReview: apps ? listOf(apps[t]['In Review']) : null,
      jobs: jobs ? Object.fromEntries(JOB_STAGES.map((s) => [s, listOf(jobs[t]?.[s] || [])])) : null,
    };
  }
  return out;
}
