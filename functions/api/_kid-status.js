/**
 * Kid status follows JobTread (Peter, Oct 20 2026)
 * =================================================
 * A kid's status on the site comes from their JobTread job, not the admin:
 *   Status Awaiting Funding                               → Awaiting funding
 *   Status Design, Finalization, Approval, Mobilization,
 *          Build                                          → In build
 *   Status Closed Done or Warranty, or the Reveal task
 *          marked done (whichever comes first)            → Completed
 *   Status On Site                                        → kept off the site
 *   Status Denied                                         → hidden, and the team
 *                                                            hears it once by email
 * Kids are matched to jobs the way the reveal feed does it (name + year,
 * ambiguous = no match, see ./_reveals.js); a kid with no job (most rooms
 * before 2025) keeps the status set in the admin. A profile the sync hid
 * carries hiddenBy: 'jobtread', so it comes back once the job moves on; a
 * profile staff hid stays hidden.
 *
 * Each change is saved the way an admin save is (D1, the GitHub copy, the
 * audit log and History) as "JobTread (automatic)", and the site redeploys
 * by itself (at most every 10 minutes) so nobody has to press Publish.
 * Woken by JobTread's workflows (POST /api/reveal-invites: a status change,
 * a task finished) for one job at a time, and swept every hour from the
 * live hub heartbeat and /api/reveals as a safety net.
 */
import { JT_URL, SOARD_ORG_ID, matchKid } from './_reveals.js';
import { EXTRACTORS, generateSha } from './_collections.js';
import { commitFile } from './_github.js';
import { logAudit, diffJson } from './_audit.js';
import { recordVersion } from './_content-history.js';
import { sendEmails, slackPost, emailConfigured } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { syncJobCovers } from './_job-covers.js';

export const FIELD_STATUS = '22P52qfFub9b';
export const REVEAL_TASK_TYPE = '22NZSbkR5rZw';
export const SYNC_USER = 'JobTread (automatic)';
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const DEPLOY_COOLDOWN_MS = 10 * 60 * 1000;
const HOOK_ENV_VARS = ['CF_PAGES_DEPLOY_HOOK', 'CF_DEPLOY_HOOK', 'DEPLOY_HOOK_URL'];
const MAX_PAGES = 8;
const SITE = 'https://sunshineonaranneyday.com';
const DEFAULT_ALERT_EMAILS = ['peter@soardcharity.com'];

const BUILDING = new Set(['Design', 'Finalization', 'Approval', 'Mobilization', 'Build']);
const DONE = new Set(['Closed Done', 'Warranty']);

/**
 * What the site should show for a job: { status, hide }.
 * status: 'needs-funding' | 'in-progress' | 'completed' | null (leave it);
 * hide: 'on-site' | 'denied' | null.
 */
export function siteStatusFor({ status, revealDone = false, closed = false } = {}) {
  const s = String(status || '').trim();
  // A closed job is history: it can confirm a finished room, never take a profile down
  if (closed && (s === 'Denied' || s === 'On Site')) return { status: revealDone ? 'completed' : null, hide: null };
  if (s === 'Denied') return { status: null, hide: 'denied' };
  if (s === 'On Site') return { status: null, hide: 'on-site' };
  if (revealDone || DONE.has(s)) return { status: 'completed', hide: null };
  if (s === 'Awaiting Funding') return { status: 'needs-funding', hide: null };
  if (BUILDING.has(s)) return { status: 'in-progress', hide: null };
  return { status: null, hide: null };
}

/** A job's Status value and whether its Reveal task is done */
export function jobFacts(job) {
  const values = {};
  for (const v of job?.customFieldValues?.nodes || []) values[v.customField?.id] = v.value;
  const reveals = job?.tasks?.nodes || [];
  return { status: values[FIELD_STATUS] || null, revealDone: reveals.length > 0 && reveals.every((t) => (t.progress ?? 0) >= 1), closed: !!job?.closedOn };
}

/**
 * The record a kid should have given its job, or null when nothing changes.
 * Only status, publishStatus and the hiddenBy marker are touched.
 */
export function planKid(kid, facts) {
  const want = siteStatusFor(facts);
  const next = { ...kid };
  if (want.hide) {
    // Off the site; a profile staff already hid stays theirs
    if (kid.publishStatus !== 'draft') { next.publishStatus = 'draft'; next.hiddenBy = 'jobtread'; }
  } else {
    // Back on the site once the job moves on, if it was the sync that hid it
    if (kid.hiddenBy === 'jobtread') { next.publishStatus = 'published'; delete next.hiddenBy; }
    if (want.status && kid.status !== want.status) next.status = want.status;
  }
  const changed = next.status !== kid.status || next.publishStatus !== kid.publishStatus || next.hiddenBy !== kid.hiddenBy;
  return changed ? { next, hide: want.hide } : null;
}

// JobTread refuses (413) a query whose worst case (page size times each
// nested list) is too big, so each job brings only its Status and Reveal task
const JOB_FIELDS = {
  id: {}, name: {}, closedOn: {},
  customFieldValues: { $: { size: 1, where: [['customField', 'id'], '=', FIELD_STATUS] }, nodes: { value: {}, customField: { id: {} } } },
  tasks: { $: { size: 5, where: [['taskType', 'id'], '=', REVEAL_TASK_TYPE] }, nodes: { progress: {} } },
};

async function pave(grantKey, query, fetchImpl) {
  const res = await fetchImpl(JT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: { $: { grantKey }, ...query } }) });
  if (!res.ok) throw new Error(`JobTread returned ${res.status}`);
  return res.json();
}

/** One job, or every SOARD job (open and closed), with Status and the Reveal task */
export async function fetchJobs(grantKey, { jobId = null, fetchImpl = fetch } = {}) {
  if (jobId) {
    const body = await pave(grantKey, { job: { $: { id: jobId }, ...JOB_FIELDS } }, fetchImpl);
    return body?.job ? [body.job] : [];
  }
  const jobs = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await pave(grantKey, { organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, ...(page ? { page } : {}) }, nextPage: {}, nodes: JOB_FIELDS } } }, fetchImpl);
    const conn = body?.organization?.jobs;
    if (!conn) throw new Error('JobTread response had no jobs');
    jobs.push(...(conn.nodes || []));
    page = conn.nextPage || null;
    if (!page) break;
  }
  return jobs;
}

/** Every kid, drafts included (a hidden profile can come back) */
export async function loadAllKids(DB) {
  const { results } = await DB.prepare('SELECT slug, name, year, data FROM kids').all();
  return (results || []).map((row) => {
    let data = {};
    try { data = JSON.parse(row.data || '{}'); } catch { /* use the columns */ }
    return { slug: row.slug, name: data.name || row.name, year: row.year ?? data.year, data };
  });
}

/** Kid slug → the job it belongs to (the open one when an old closed job matches too) */
export function linkJobs(jobs, kids) {
  const links = new Map();
  for (const job of jobs) {
    // Office test jobs ("TEST Colin Lindsay (2026)") would match the real kid
    if (/^\s*test\b/i.test(job.name || '')) continue;
    const kid = matchKid(job.name, kids, job.id);
    if (kid && (!links.has(kid.slug) || !job.closedOn)) links.set(kid.slug, job);
  }
  return links;
}

// ── State: when the sweep last ran, the auto-deploy cooldown, alerts sent ──
async function ensureState(DB) {
  await DB.prepare('CREATE TABLE IF NOT EXISTS kid_status_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
}
async function readState(DB) {
  await ensureState(DB);
  const row = await DB.prepare("SELECT value FROM kid_status_state WHERE key = 'state'").first();
  try { return JSON.parse(row?.value || '{}'); } catch { return {}; }
}
async function writeState(DB, patch) {
  const next = { ...(await readState(DB)), ...patch };
  await DB.prepare("INSERT OR REPLACE INTO kid_status_state (key, value) VALUES ('state', ?)").bind(JSON.stringify(next)).run();
  return next;
}

/** Saved the way an admin save is: D1, the GitHub copy, the audit log, History */
async function saveKid(env, slug, before, after, message, now) {
  const { DB } = env;
  const json = JSON.stringify(after);
  const [cols, vals] = EXTRACTORS.kids(after);
  const all = ['"slug"', '"data"', '"updated_at"', ...cols];
  await DB.prepare(`INSERT OR REPLACE INTO kids (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`).bind(slug, json, now, ...vals).run();
  const path = `src/content/kids/${slug}.json`;
  let gitStatus = 'ok';
  try { await commitFile(env, path, JSON.stringify(after, null, 2) + '\n', message); } catch { gitStatus = 'failed'; }
  await logAudit(DB, { userEmail: SYNC_USER, action: after.publishStatus === 'draft' ? 'drafted' : 'updated', entityType: 'kids', entitySlug: slug, entityName: after.name, changes: diffJson(before, after), path, gitStatus });
  try { await recordVersion(DB, { collection: 'kids', slug, data: after, previous: before, userEmail: SYNC_USER, now }); } catch { /* history is a nicety */ }
  return generateSha(json);
}

const STATUS_WORDS = { 'needs-funding': 'awaiting funding', 'in-progress': 'in build', completed: 'completed' };
function describe(before, after, facts) {
  if (after.publishStatus === 'draft' && before.publishStatus !== 'draft') return `hidden (JobTread status ${facts.status})`;
  const parts = [];
  if (before.publishStatus === 'draft' && after.publishStatus !== 'draft') parts.push('shown again');
  if (after.status !== before.status) parts.push(`${STATUS_WORDS[before.status] || before.status || 'no status'} → ${STATUS_WORDS[after.status]}`);
  return `${parts.join(', ')} (JobTread ${facts.revealDone && after.status === 'completed' ? 'Reveal task done' : `status ${facts.status}`})`;
}

/** A kid JobTread marks Denied is hidden; staff hear it once */
async function alertDenied(env, { kid, jobId }) {
  const to = [...new Set([...DEFAULT_ALERT_EMAILS, ...String(env.ALERT_EMAILS || '').split(',').map((s) => s.trim())].filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '')))];
  const title = `${kid.name}’s profile is hidden`;
  const detail = `JobTread marks ${kid.name}’s job Denied, so the site took their profile off Meet the Kids. Everything is kept in the admin.`;
  const fix = 'If that’s a mistake, change the job’s Status in JobTread and the profile comes back by itself.';
  const admin = `${SITE}/admin/#kids-hub`;
  const job = `https://app.jobtread.com/jobs/${jobId}`;
  await Promise.allSettled([
    slackPost(env, slackCard({
      icon: '⚠️', title, lead: detail, fix,
      buttons: [{ label: 'Open the job in JobTread', url: job }, { label: 'Open Kids', url: admin }],
    })),
    emailConfigured(env) && to.length ? sendEmails(env, {
      to, subject: `[SOARD] ${title}`,
      html: `<p><strong>${title}</strong></p><p>${detail}</p><p>${fix}</p><p><a href="${job}">Open the job in JobTread</a> · <a href="${admin}">Open Kids in the admin</a></p>`,
      text: `${title}\n\n${detail}\n\n${fix}\n\nJobTread: ${job}\nAdmin: ${admin}`,
      tags: [{ name: 'category', value: 'kid-status' }],
    }) : null,
  ]);
}

/** Fires the deploy hook the admin's Publish uses, at most every 10 minutes */
async function deploy(env, state, now) {
  const hook = HOOK_ENV_VARS.map((k) => env[k]).find(Boolean);
  if (!hook) return { deployed: false, pending: false };
  const last = state.lastAutoDeployAt ? Date.parse(state.lastAutoDeployAt) : 0;
  if (now - last < DEPLOY_COOLDOWN_MS) return { deployed: false, pending: true };
  try {
    const res = await fetch(hook, { method: 'POST' });
    if (!res.ok) return { deployed: false, pending: true };
  } catch {
    return { deployed: false, pending: true };
  }
  await logAudit(env.DB, { userEmail: SYNC_USER, action: 'deployed', entityType: 'site', entityName: 'Kid status from JobTread' });
  return { deployed: true, pending: false };
}

/**
 * Bring kids in line with JobTread: one job (a workflow wake-up) or all of
 * them (the sweep). Returns [{ slug, name, change }]. Never throws.
 */
export async function syncKidStatuses(env, { jobId = null, fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return [];
    const [jobs, kids] = await Promise.all([fetchJobs(env.JOBTREAD_GRANT_KEY, { jobId, fetchImpl }), loadAllKids(env.DB)]);
    const state = await readState(env.DB);
    const alerted = { ...(state.alerted || {}) };
    const out = [];
    const iso = new Date(now).toISOString();
    const links = linkJobs(jobs, kids);
    for (const [slug, job] of links) {
      const kid = kids.find((k) => k.slug === slug);
      const facts = jobFacts(job);
      if (facts.status !== 'Denied') delete alerted[slug];
      const plan = planKid(kid.data, facts);
      if (!plan) continue;
      const change = describe(kid.data, plan.next, facts);
      await saveKid(env, slug, kid.data, plan.next, `Kid status from JobTread: ${kid.name} ${change}`, iso);
      out.push({ slug, name: kid.name, change });
      if (plan.hide === 'denied' && !alerted[slug]) { await alertDenied(env, { kid, jobId: job.id }); alerted[slug] = iso; }
    }
    // Each job's cover shows the kid's Main photo (./_job-covers.js)
    const covers = await syncJobCovers(env, links, kids, { fetchImpl, now });
    const patch = { alerted, lastRun: { at: iso, scope: jobId ? 'job' : 'all', changed: out.length, covers: covers.length } };
    if (!jobId) patch.lastSweepAt = iso;
    if (out.length || state.deployPending) {
      const d = await deploy(env, state, now);
      if (d.deployed) patch.lastAutoDeployAt = iso;
      patch.deployPending = d.pending;
    }
    await writeState(env.DB, patch);
    return out;
  } catch (err) {
    console.error('[kid-status]', err.message);
    // Kept so Site → Automations can say the last check failed
    try { await writeState(env.DB, { lastError: { at: new Date(now).toISOString(), scope: jobId ? 'job' : 'all', error: String(err.message || err).slice(0, 200) } }); } catch { /* nothing more to do */ }
    return [];
  }
}

/** The hourly safety sweep (and a deploy the cooldown held back). Never throws. */
export async function maybeSyncKidStatuses(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    const state = await readState(env.DB);
    const due = now - Date.parse(state.lastSweepAt || 0) >= SWEEP_EVERY_MS;
    const deployDue = state.deployPending && now - Date.parse(state.lastAutoDeployAt || 0) >= DEPLOY_COOLDOWN_MS;
    if (!due && !deployDue) return null;
    // Claim the slot first so overlapping wake-ups don't double up
    if (due) await writeState(env.DB, { lastSweepAt: new Date(now).toISOString() });
    return await syncKidStatuses(env, { fetchImpl, now });
  } catch {
    return null;
  }
}
