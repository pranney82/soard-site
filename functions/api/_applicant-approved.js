/**
 * Approved → the makeover's JobTread job and the kid's website profile
 * ===========================================================================
 * Peter, Oct 20 2026: "when customer status is approved, jobtread job should
 * be created, but i also want the kids webpage made at that point too".
 * The Zapier "account updated" Zap made the job until it went off that day
 * (named "Child (Year)", Status On Site, Makeover Type copied, posted as the
 * Qualification Committee). This replaces it and adds the profile.
 *
 * When: once the approval is settled, the way ./_applicant-notify.js sees it:
 * Status Approved, nothing waiting or held for the family's email (sent,
 * "Don't email", or no address to send to), and unchanged for the decision
 * wait (definition.notify waits.decision, 30 min). So a mis-click that's moved
 * back makes nothing, a 9 PM approval waits for its 8 AM email, and nothing
 * runs while family emails are paused for a cleanup. Only approvals after
 * this first ran count (applicant_approval_state 'launch'), so families
 * approved in past seasons are never touched.
 *
 * The job: the family's open job (or any job for that year) is used if there
 * is one; else createJob at their home, as the Qualification Committee. DataX
 * adds the cover photo and CompanyCam its project by themselves (JobTread's
 * history: within 2 seconds of every job created). A family who had their
 * home visit with a CompanyCam project (./_companycam-sync.js) gets their job
 * made with that project's id, so CompanyCam doesn't start a second one.
 *
 * The profile: a hidden draft in Admin → Kids, first name only, age, year,
 * rooms, Awaiting funding, linked by jobtreadJobId so its status follows the
 * job (./_kid-status.js). Its GitHub copy is public, so nothing private goes
 * in: no last name, diagnosis, address or photos. Staff add the story and
 * photos and switch on "Show on Meet the Kids". A kid already in Kids for that
 * job (same name and year) is linked, never rewritten. An organization (no
 * birthday or diagnosis, e.g. a school) gets the job only. An office test (an
 * account named "TEST …") gets its job, which everything else ignores, and a
 * dry-run profile: worked out and logged, never saved; its Slack posts say
 * it's a test.
 *
 * Once per family (claimed in applicant_approvals first), retried with
 * backoff. What was made goes to Slack (good news) and the family's history
 * in Admin → Applicants; a family it can't finish (no home address, no
 * *Makeover Year) is a Slack problem that turns ✅ when it's done. Never
 * deletes anything: a later move back or Denied leaves the job and profile,
 * and the profile's visibility follows the job's Status.
 *
 * Woken by the application sweep (./_applications.js, every 2 minutes).
 */

import { pave, SOARD_ORG_ID, matchKid, parseJobName, todayEastern } from './_reveals.js';
import { FIELD_STATUS, FIELD_DIAGNOSIS, qcGrant, madeByForm } from './_applicant-comms.js';
import { ensureNotifySchema, pauseState } from './_applicant-notify.js';
import { getLiveForm } from './_application-forms.js';
import { notifySettings } from './_application-form.js';
import { FIELD_STATUS as JOB_FIELD_STATUS, SYNC_USER, loadAllKids } from './_kid-status.js';
import { EXTRACTORS } from './_collections.js';
import { commitFile } from './_github.js';
import { logAudit } from './_audit.js';
import { recordVersion } from './_content-history.js';
import { slackPost, slackIssue, slackResolved, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { kidRecord, buildFields, buildsOf } from '../../public/admin/kids-shared.js';
import { applicationPhotoFile, coverFromFile, rememberCover } from './_job-covers.js';
import { familyProjectId } from './_companycam-link.js';

const FIELD_YEAR = '22P52xmCz3cx';      // customer: *Makeover Year
const FIELD_TYPES = '22P5KVgrLeXK';     // customer: *Makeover Type (multi)
const FIELD_BIRTHDAY = '22P46syd4j6E';  // customer: Birthday
export const JOB_FIELD_TYPES = '22P3SQTcgurh'; // job: Makeover Type (same choices)
export const JOB_START_STATUS = 'On Site';     // where the Zap started every job
const JOB_NAME_MAX = 30;                // JobTread's limit for a job name

/** The account's Makeover Type → the kid profile's room */
const BUILD_FOR_TYPE = { Bedroom: 'Dream Bedroom', Bathroom: 'Accessible Bathroom', 'Therapy Room': 'Therapy Room', Ramp: 'Wheelchair Ramp' };

const CLAIM_STALE_MS = 10 * 60 * 1000;
const RETRY_MS = [5, 15, 30, 60].map(m => m * 60 * 1000); // then hourly
const ALERT_AFTER = 3;                  // JobTread errors before Slack hears of it
const SITE = SITE_ORIGIN;
const KIDS_ADMIN = `${SITE}/admin/#kids-hub`;
const APPLICANTS_ADMIN = `${SITE}/admin/#applications`;
const jobUrl = (id) => `https://app.jobtread.com/jobs/${id}`;
const accountUrl = (id) => `https://app.jobtread.com/customers/${id}`;
const iso = (t = Date.now()) => new Date(t).toISOString();

// ─── Names, years, ages ─────────────────────────────────────────────

/** An office test ("TEST Notify Check"): it gets its job (TEST jobs are skipped everywhere else) but its profile isn't saved */
export const isTestFamily = (name) => /^\s*test\b/i.test(String(name || ''));

/** A real makeover year from the field ("2027"), else null ("**ADD YEAR**", blank) */
export function cleanYear(v) {
  const m = String(v ?? '').trim().match(/^(20\d\d)$/);
  return m ? Number(m[1]) : null;
}

/** The names in an account name: "Remi & Nico Powell" → ['Remi', 'Nico Powell'] */
const namesIn = (s) => String(s || '').replace(/\s*\(\d{4}\)\s*$/, '').split(/\s*(?:&|\+|,|\band\b)\s*/i).map(p => p.trim()).filter(Boolean);
const joinNames = (list) => (list.length > 2 ? `${list.slice(0, -1).join(', ')} & ${list.at(-1)}` : list.join(' & '));

const NAME_MAX = 30;      // one child's name
const SITE_NAME_MAX = 60; // all of them, joined

/**
 * One name as the public pages may show it: letters (any alphabet), their
 * accents, spaces, apostrophes, hyphens and periods. Anything else a family
 * typed (markup, quotes, emoji, digits) becomes a space; runs of spaces close
 * up, and it's capped at NAME_MAX characters.
 */
export function cleanName(s, max = NAME_MAX) {
  const clean = String(s ?? '').normalize('NFC').replace(/[^\p{L}\p{M}\s'’.-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('').trim();
}

/**
 * The name the site shows: the first name(s), never the last.
 *   "Remi & Nico Powell" → "Remi & Nico", "Declan “Dex” Noel" → "Dex",
 *   "Logan Michael Sesto" → "Logan". `first` (the form's first-name answer)
 *   wins when there is one. The name ends up in the kid's page (HTML and
 *   JSON-LD), so each name is cleaned and only the " & " and ", " between
 *   names are the site's own.
 */
export function siteNameOf(accountName, first = null) {
  const done = (names) => [...joinNames(names.map(n => cleanName(n)).filter(Boolean))].slice(0, SITE_NAME_MAX).join('').replace(/[\s,&]+$/, '');
  const typed = done(namesIn(first));
  if (typed) return typed;
  const raw = String(accountName || '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
  const nick = cleanName(raw.match(/["“”]([^"“”]{2,30})["“”]/)?.[1]);
  if (nick.length >= 2) return nick;
  return done(namesIn(raw).map(p => p.split(/\s+/)[0])) || cleanName(raw);
}

/** How many children the name covers: "Remi & Nico" → 2 */
export const childCountOf = (siteName) => Math.max(1, namesIn(siteName).length);

/** "Remi & Nico Powell (2026)", shortened to JobTread's 30 characters if it must be */
export function jobNameFor(accountName, year) {
  const suffix = ` (${year})`;
  const room = JOB_NAME_MAX - suffix.length;
  let base = String(accountName || '').replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+/g, ' ').trim() || 'Makeover';
  if (base.length > room) {
    // Middle names go first: "Oakley Faye Xiu Ping Roberson" → "Oakley Roberson"
    const words = base.split(' ');
    if (words.length > 2) base = `${words[0]} ${words.at(-1)}`;
  }
  if (base.length > room) base = base.slice(0, room).trim();
  return `${base}${suffix}`;
}

/** Age in whole years on `today` ('YYYY-MM-DD'), or null */
export function ageOn(birthday, today) {
  const b = String(birthday || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = String(today || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!b || !t) return null;
  let age = Number(t[1]) - Number(b[1]);
  if (t[2] < b[2] || (t[2] === b[2] && t[3] < b[3])) age--;
  return age >= 0 && age < 30 ? age : null;
}

const slugify = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A slug nobody has: "remi-and-nico", then "remi-and-nico-2027", "-2", … (the admin's rule, by makeover year) */
export function freeSlug(name, year, taken) {
  const base = slugify(name) || 'kid';
  if (!taken.has(base)) return base;
  const withYear = `${base}-${year}`;
  if (!taken.has(withYear)) return withYear;
  let n = 2;
  while (taken.has(`${withYear}-${n}`)) n++;
  return `${withYear}-${n}`;
}

/**
 * The job to use for this makeover, if the family already has one: an open
 * job for that year, any job for that year, or an open job with no year in
 * its name (staff made it by hand). A job for another year is another
 * makeover (a family coming back), so it doesn't count.
 */
export function existingJob(jobs, year) {
  const yearOf = (j) => parseJobName(j.name).year;
  const open = jobs.filter(j => !j.closedOn);
  return open.find(j => yearOf(j) === year) || jobs.find(j => yearOf(j) === year) || open.find(j => !yearOf(j)) || null;
}

/** The new profile, exactly as the admin's Save writes one (a hidden draft) */
export function newKidRecord({ name, slug, year, age = null, types = [], jobId }) {
  const roomTypes = [...new Set(types.map(t => BUILD_FOR_TYPE[t]).filter(Boolean))];
  const base = {
    name, slug, status: 'needs-funding', year, age, diagnosis: '',
    roomTypes, childCount: childCountOf(name),
    heroSummary: '', bio: '', quote: '', heroImage: '', accentImage: '', photos: [], photoCount: 0, photographer: '',
    plans: [], beforeAfterPhotos: [], partnerLogos: [], streamVideoId: '', videoUrl: '', revealVideoUrl: '',
    fundraisingUrl: '', shortDescription: '', metaDescription: '', publishStatus: 'draft',
    jobtreadJobId: jobId,
  };
  return kidRecord({ ...base, ...buildFields(buildsOf(base), base) });
}

// ─── D1 ─────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS applicant_approvals (
    account_id TEXT PRIMARY KEY, name TEXT, approved_at TEXT, state TEXT NOT NULL,
    job_id TEXT, job_name TEXT, job_made INTEGER, kid_slug TEXT, kid_made INTEGER,
    problem TEXT, detail TEXT, attempts INTEGER DEFAULT 0, next_try_at INTEGER,
    claimed_at INTEGER, alerted INTEGER DEFAULT 0, done_at TEXT, updated_at TEXT NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS applicant_approval_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
export async function ensureApprovalSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _ready.add(DB);
}

async function getState(DB, key) {
  const r = await DB.prepare('SELECT value FROM applicant_approval_state WHERE key = ?').bind(key).first();
  try { return r?.value ? JSON.parse(r.value) : null; } catch { return null; }
}
async function setState(DB, key, value, now) {
  await DB.prepare('INSERT INTO applicant_approval_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), iso(now)).run();
}

/** When this first ran: approvals before it belong to the Zap era and are left alone */
async function launchAt(DB, now) {
  await DB.prepare('INSERT OR IGNORE INTO applicant_approval_state (key, value, updated_at) VALUES (?, ?, ?)').bind('launch', JSON.stringify(iso(now)), iso(now)).run();
  return (await getState(DB, 'launch')) || iso(now);
}

const COLS = ['account_id', 'name', 'approved_at', 'state', 'job_id', 'job_name', 'job_made', 'kid_slug', 'kid_made', 'problem', 'detail', 'attempts', 'next_try_at', 'claimed_at', 'alerted', 'done_at', 'updated_at'];
async function getRow(DB, id) {
  return DB.prepare('SELECT * FROM applicant_approvals WHERE account_id = ?').bind(id).first();
}
async function putRow(DB, row, now) {
  const r = { ...row, updated_at: iso(now) };
  await DB.prepare(`INSERT INTO applicant_approvals (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})
    ON CONFLICT(account_id) DO UPDATE SET ${COLS.slice(1).map(c => `${c} = excluded.${c}`).join(', ')}`).bind(...COLS.map(c => r[c] ?? null)).run();
  return r;
}

/** Take this family's turn; false if another run has it or it's finished */
async function claim(DB, { account_id, name, since }, now) {
  const r = await DB.prepare(`INSERT INTO applicant_approvals (account_id, name, approved_at, state, attempts, claimed_at, updated_at) VALUES (?, ?, ?, 'working', 0, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET state = 'working', name = excluded.name, approved_at = excluded.approved_at, claimed_at = excluded.claimed_at, updated_at = excluded.updated_at
    WHERE applicant_approvals.state = 'waiting' OR (applicant_approvals.state = 'working' AND applicant_approvals.claimed_at < ?)`)
    .bind(account_id, name, since, now, iso(now), now - CLAIM_STALE_MS).run();
  return (r?.meta?.changes || 0) > 0;
}

/** Families whose approval has settled and still needs its job or profile */
async function dueFamilies(DB, { launch, settledBy, now, limit }) {
  const { results } = await DB.prepare(`SELECT n.account_id, n.name, n.since FROM applicant_notify n
    LEFT JOIN applicant_approvals a ON a.account_id = n.account_id
    WHERE n.status = 'Approved' AND n.kind IS NULL AND n.hold IS NULL AND n.since >= ? AND n.since <= ?
      AND (a.account_id IS NULL
        OR (a.state = 'waiting' AND COALESCE(a.next_try_at, 0) <= ?)
        OR (a.state = 'working' AND COALESCE(a.claimed_at, 0) < ?))
    ORDER BY n.since LIMIT ?`).bind(launch, iso(settledBy), now, now - CLAIM_STALE_MS, limit).all();
  return results || [];
}

/** In the family's history (Admin → Applicants), like ./_applicants.js writes it */
async function logActivity(DB, accountId, { title, body = null, data = null }, now) {
  await DB.prepare('INSERT OR IGNORE INTO applicant_activity (id, account_id, at, kind, by_name, source, title, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`approved:${now}:${Math.random().toString(36).slice(2, 8)}`, accountId, iso(now), 'job', 'Website (automatic)', 'website', title, body, data ? JSON.stringify(data) : null).run();
}

// ─── JobTread ───────────────────────────────────────────────────────

// Small explicit sizes: JobTread sizes a query by its worst case (413 otherwise)
const ACCOUNT = {
  id: {}, name: {}, type: {}, createdAt: {}, archivedAt: {},
  organization: { id: {} },
  customFieldValues: { $: { size: 12, where: [['customField', 'id'], 'in', [FIELD_STATUS, FIELD_YEAR, FIELD_TYPES, FIELD_BIRTHDAY, FIELD_DIAGNOSIS]] }, nodes: { value: {}, customField: { id: {} } } },
  primaryLocation: { id: {} },
  locations: { $: { size: 5, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: { id: {} } },
  jobs: { $: { size: 10, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: { id: {}, name: {}, closedOn: {} } },
};

/** The account as this needs it, or null if it isn't a SOARD customer */
export async function readAccount(env, accountId, fetchImpl = fetch) {
  const a = (await pave(env.JOBTREAD_GRANT_KEY, { account: { $: { id: accountId }, ...ACCOUNT } }, fetchImpl))?.account;
  if (!a || a.type !== 'customer' || a.organization?.id !== SOARD_ORG_ID) return null;
  const one = {};
  const types = [];
  for (const v of a.customFieldValues?.nodes || []) {
    const id = v.customField?.id;
    if (id === FIELD_TYPES) { if (v.value) types.push(...(Array.isArray(v.value) ? v.value : [v.value])); } else one[id] = v.value;
  }
  return {
    id: a.id, name: a.name, archivedAt: a.archivedAt || null,
    status: one[FIELD_STATUS] || '', year: cleanYear(one[FIELD_YEAR]), yearText: one[FIELD_YEAR] || '',
    types: [...new Set(types)], birthday: one[FIELD_BIRTHDAY] || null, hasDiagnosis: !!String(one[FIELD_DIAGNOSIS] || '').trim(),
    locationId: a.primaryLocation?.id || a.locations?.nodes?.[0]?.id || null,
    jobs: (a.jobs?.nodes || []).map(j => ({ id: j.id, name: j.name || '', closedOn: j.closedOn || null })),
  };
}

/** createJob as the Qualification Committee (the Zap's author), falling back to the site's grant */
async function createJob(env, { locationId, name, types, companycamId = null }, fetchImpl) {
  const customFieldValues = { [JOB_FIELD_STATUS]: JOB_START_STATUS };
  if (types.length) customFieldValues[JOB_FIELD_TYPES] = types;
  const input = { locationId, name, customFieldValues };
  if (companycamId) input.companycamId = companycamId; // the home-visit project, not a new one
  const query = { createJob: { $: input, createdJob: { id: {}, name: {} } } };
  const grants = [...new Set([qcGrant(env), env.JOBTREAD_GRANT_KEY].filter(Boolean))];
  let last = null;
  for (const grant of grants) {
    try {
      const job = (await pave(grant, query, fetchImpl))?.createJob?.createdJob;
      if (job?.id) return { id: job.id, name: job.name || name };
      last = new Error('JobTread didn’t return the new job');
    } catch (e) {
      last = e;
      // JobTread refused this grant's request (4xx), so nothing was made: the next grant may do it.
      // A 5xx or a lost answer might have made the job; the next run finds it rather than making two.
      if (!/JobTread returned 4\d\d/.test(e.message)) break;
    }
  }
  throw last;
}

// ─── The profile ────────────────────────────────────────────────────

/** The form's first-name answer, when the site's form made this account */
async function formFirstName(DB, accountId) {
  try {
    const row = await DB.prepare('SELECT answers FROM applications WHERE jt_account_id = ?').bind(accountId).first();
    return String(JSON.parse(row?.answers || '{}')?.childName?.first || '').trim() || null;
  } catch {
    return null;
  }
}

/** A brand-new kid, saved the way the admin's Save writes one: D1, the GitHub copy, the audit log, History */
async function createKid(env, record, now) {
  const { DB } = env;
  const json = JSON.stringify(record);
  const [cols, vals] = EXTRACTORS.kids(record);
  const all = ['"slug"', '"data"', '"updated_at"', ...cols];
  // INSERT, not REPLACE: never write over a profile that has this slug
  await DB.prepare(`INSERT INTO kids (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`).bind(record.slug, json, iso(now), ...vals).run();
  const path = `src/content/kids/${record.slug}.json`;
  let gitStatus = 'ok';
  try { await commitFile(env, path, JSON.stringify(record, null, 2) + '\n', `Add kid: ${record.name} (approved in JobTread)`); } catch { gitStatus = 'failed'; }
  await logAudit(DB, { userEmail: SYNC_USER, action: 'created', entityType: 'kids', entitySlug: record.slug, entityName: record.name, changes: null, path, gitStatus });
  try { await recordVersion(DB, { collection: 'kids', slug: record.slug, data: record, userEmail: SYNC_USER, now: iso(now) }); } catch { /* history is a nicety */ }
}

/**
 * The family's profile: the one already linked or named for this job, else a
 * new hidden draft → { slug, name, made }. A dry run (a TEST family) works it
 * all out and saves nothing → { slug, name, made: false, test: true }.
 */
async function profileFor(env, acct, job, year, now, { dryRun = false } = {}) {
  const { DB } = env;
  const kids = await loadAllKids(DB);
  const linked = kids.find(k => k.data?.jobtreadJobId === job.id);
  if (linked) return { slug: linked.slug, name: linked.name, made: false };
  // A profile staff made for this family (same name and year), not already another job's
  const named = matchKid(job.name, kids.filter(k => !k.data?.jobtreadJobId));
  if (named) return { slug: named.slug, name: named.name, made: false };
  const name = siteNameOf(acct.name, await formFirstName(DB, acct.id));
  const taken = new Set(kids.map(k => k.slug));
  const age = ageOn(acct.birthday, todayEastern(now));
  for (let i = 0; i < 5; i++) {
    const slug = freeSlug(name, year, taken);
    const record = newKidRecord({ name, slug, year, age, types: acct.types, jobId: job.id });
    if (dryRun) return { slug, name, made: false, test: true };
    try {
      await createKid(env, record, now);
      return { slug, name, made: true };
    } catch (e) {
      if (!/unique|constraint/i.test(e.message)) throw e;
      taken.add(slug); // someone saved that slug a moment ago: take the next
    }
  }
  throw new Error('Couldn’t find a free web address for the profile');
}

/** The application's child photo as the job's cover, once, unless the job already shows a kid's photo. Never throws. */
async function applicationCover(env, accountId, job, fetchImpl, now) {
  try {
    const fileId = await applicationPhotoFile(env.DB, accountId);
    if (!fileId) return;
    const had = await env.DB.prepare('SELECT source FROM job_covers WHERE job_id = ?').bind(job.id).first().catch(() => null);
    if (had?.source) return;
    await coverFromFile(env, job.id, fileId, fetchImpl);
    await rememberCover(env.DB, job.id, { source: `application:${fileId}` }, now);
  } catch (e) {
    console.error('[applicant-approved] cover', e.message); // the job and profile matter more than its picture
  }
}

// ─── One family ─────────────────────────────────────────────────────

const PROBLEMS = {
  'no-home': {
    why: 'JobTread has no home address for this family, and a job needs one.',
    fix: 'Add the family’s home on their customer page in JobTread. The job and profile follow within a few minutes.',
  },
  'no-year': {
    why: 'The family’s *Makeover Year in JobTread is blank or “ADD YEAR”, and the job is named for its year.',
    fix: 'Set *Makeover Year on their customer page in JobTread. The job and profile follow within a few minutes.',
  },
  error: {
    why: 'JobTread didn’t take the request.',
    fix: 'Nothing to do if it clears by itself. If it keeps happening, make the job in JobTread by hand and the profile follows.',
  },
};

function problemCard({ acct, problem, detail }) {
  const p = PROBLEMS[problem] || PROBLEMS.error;
  return slackCard({
    test: isTestFamily(acct.name) ? 'Test family · nothing real is waiting' : null,
    icon: '⚠️', title: `${acct.name}: makeover job not made yet`,
    lead: `${acct.name} is approved, but the site couldn’t make their JobTread job and website profile.\n${p.why}`,
    facts: problem === 'error' ? [['JobTread said', String(detail || '').slice(0, 200)]] : [],
    fix: p.fix,
    buttons: [{ label: 'Open the family in JobTread', url: accountUrl(acct.id) }, { label: 'Open Applicants', url: APPLICANTS_ADMIN }],
  });
}

/** Not finished: try again later; Slack hears of it once (a missing detail at once, JobTread errors after a few) */
async function wait(env, row, acct, problem, detail, now) {
  const attempts = (row.attempts || 0) + 1;
  const delay = problem === 'error' ? RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)] : 15 * 60 * 1000;
  const next = { ...row, state: 'waiting', problem, detail: detail ? String(detail).slice(0, 500) : null, attempts, next_try_at: now + delay, claimed_at: null };
  const tell = !row.alerted && (problem !== 'error' || attempts >= ALERT_AFTER);
  if (tell) {
    next.alerted = 1;
    await slackIssue(env, `approved:${acct.id}`, problemCard({ acct, problem, detail }), { title: `${acct.name}: makeover job`, kind: 'attention' }).catch(() => null);
    await logActivity(env.DB, acct.id, { title: 'Couldn’t make the makeover job yet', body: `${(PROBLEMS[problem] || PROBLEMS.error).why} ${(PROBLEMS[problem] || PROBLEMS.error).fix}`, data: { problem } }, now);
  }
  await putRow(env.DB, next, now);
  return { id: acct.id, name: acct.name, waiting: problem };
}

/**
 * Make (or find) the job and the profile for one approved family. Safe to
 * repeat: the job id is saved the moment it exists, and both steps look for
 * what's already there first.
 */
export async function approveFamily(env, accountId, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const row = await getRow(DB, accountId);
  const acct = await readAccount(env, accountId, fetchImpl);
  if (!acct || acct.archivedAt) {
    await putRow(DB, { ...row, state: 'skipped', problem: null, detail: acct ? 'archived' : 'not a SOARD customer', claimed_at: null, done_at: iso(now) }, now);
    return { id: accountId, skipped: acct ? 'archived' : 'not a SOARD customer' };
  }
  // Moved on before its turn: nothing to make (a later approval starts over)
  if (acct.status !== 'Approved') {
    await DB.prepare('DELETE FROM applicant_approvals WHERE account_id = ?').bind(accountId).run();
    if (row?.alerted) await slackResolved(env, `approved:${accountId}`, slackCard({ icon: '✅', title: `${acct.name} is no longer approved`, lead: `Their status is now ${acct.status || 'blank'}, so no job is needed.` }), { summary: 'No longer approved' }).catch(() => null);
    return { id: accountId, moved: acct.status || 'blank' };
  }
  if (!acct.year) return wait(env, row, acct, 'no-year', acct.yearText, now);

  // The job: the one saved last time, one the family already has, or a new one
  let job = (row?.job_id && acct.jobs.find(j => j.id === row.job_id)) || existingJob(acct.jobs, acct.year);
  let jobMade = !!(job && row?.job_made && row.job_id === job.id);
  if (!job) {
    if (!acct.locationId) return wait(env, row, acct, 'no-home', null, now);
    try {
      const companycamId = await familyProjectId(DB, accountId);
      job = await createJob(env, { locationId: acct.locationId, name: jobNameFor(acct.name, acct.year), types: acct.types, companycamId }, fetchImpl);
    } catch (e) {
      return wait(env, row, acct, 'error', e.message, now);
    }
    jobMade = true;
    await putRow(DB, { ...row, job_id: job.id, job_name: job.name, job_made: 1 }, now);
  }

  // The job's cover: the child's photo from their application (./_job-covers.js; the profile's Main photo takes over later)
  await applicationCover(env, accountId, job, fetchImpl, now);

  // The profile: kids only (a school or clinic gets the job alone)
  const child = !!acct.birthday || acct.hasDiagnosis || await madeByForm(DB, accountId);
  let kid = null;
  if (child) {
    try {
      kid = await profileFor(env, acct, job, acct.year, now, { dryRun: isTestFamily(acct.name) });
    } catch (e) {
      return wait(env, { ...(await getRow(DB, accountId)) }, acct, 'error', e.message, now);
    }
  }

  const done = {
    ...(await getRow(DB, accountId)), state: 'done', job_id: job.id, job_name: job.name, job_made: jobMade ? 1 : 0,
    kid_slug: kid?.test ? null : kid?.slug || null, kid_made: kid?.made ? 1 : 0, problem: null, detail: kid?.test ? `test: profile not saved (/kids/${kid.slug}/)` : child ? null : 'organization: no profile', next_try_at: null, claimed_at: null, done_at: iso(now),
  };
  await putRow(DB, done, now);
  if (!jobMade) await logActivity(DB, accountId, { title: `Makeover job: ${job.name}`, body: 'The family already had this job in JobTread, so the site used it.', data: { jobId: job.id } }, now);
  if (kid?.test) await logActivity(DB, accountId, { title: 'Test family: profile not saved', body: `A real family would get /kids/${kid.slug}/ (${kid.name}, ${acct.year}) as a hidden draft in Admin → Kids.`, data: { slug: kid.slug, jobId: job.id, test: true } }, now);
  else if (kid?.made) await logActivity(DB, accountId, { title: `Website profile made: ${kid.name}`, body: `/kids/${kid.slug}/ in Admin → Kids. It stays off Meet the Kids until someone adds the story and photos and switches on “Show on Meet the Kids”.`, data: { slug: kid.slug, jobId: job.id } }, now);
  else if (kid) await logActivity(DB, accountId, { title: `Website profile: ${kid.name}`, body: `Already in Admin → Kids (/kids/${kid.slug}/), so the site linked it to the job.`, data: { slug: kid.slug, jobId: job.id } }, now);
  else await logActivity(DB, accountId, { title: 'No website profile', body: 'This account has no birthday or diagnosis, so it looks like an organization. Add a Community project in the admin if it should have a page.', data: { jobId: job.id } }, now);
  if (row?.alerted) {
    await slackResolved(env, `approved:${accountId}`, slackCard({ icon: '✅', title: `${acct.name}: makeover job made`, lead: `${job.name} is in JobTread${kid?.made ? ` and ${kid.name}’s profile is in Admin → Kids` : ''}.`, buttons: [{ label: 'Open the job in JobTread', url: jobUrl(job.id) }] }), { summary: 'The job is made' }).catch(() => null);
  }
  return { id: accountId, name: acct.name, job: { id: job.id, name: job.name, made: jobMade }, kid };
}

// ─── Slack: what each run made ──────────────────────────────────────

export function madeCard(made, { test = false } = {}) {
  const testWords = test ? 'Test family · the profile isn’t saved' : null;
  const line = (m) => [
    m.job.made ? `JobTread job ${m.job.name}` : `JobTread job ${m.job.name} (already there)`,
    m.kid ? (m.kid.test ? `profile /kids/${m.kid.slug}/ (a test: not saved)` : m.kid.made ? `profile /kids/${m.kid.slug}/ (hidden until it’s ready)` : `profile /kids/${m.kid.slug}/ (already in Kids)`) : 'no profile (an organization)',
  ].join(', ');
  if (made.length === 1) {
    const m = made[0];
    const who = m.kid?.name || m.name;
    return slackCard({
      test: testWords, icon: '🛠', title: `${who}’s makeover is set up`,
      lead: `${m.name} was approved, so the site ${m.job.made ? 'made the JobTread job' : 'found the JobTread job'}${m.kid?.made ? ' and a website profile' : ''}.`,
      facts: [['JobTread job', m.job.made ? m.job.name : `${m.job.name} (already there)`], ['Website profile', m.kid ? `/kids/${m.kid.slug}/${m.kid.test ? ', a test: not saved' : m.kid.made ? ', hidden until the story and photos are in' : ', already in Kids'}` : 'none (an organization)']],
      buttons: [{ label: 'Open the job in JobTread', url: jobUrl(m.job.id) }, ...(m.kid ? [{ label: 'Open Kids', url: KIDS_ADMIN }] : [])],
      footer: 'Approved in JobTread',
    });
  }
  return slackCard({
    test: testWords, icon: '🛠', title: `${made.length} approved families are set up`,
    lead: made.map(m => `${m.name}: ${line(m)}`).join('\n'),
    buttons: [{ label: 'Open Kids', url: KIDS_ADMIN }, { label: 'Open Applicants', url: APPLICANTS_ADMIN }],
    footer: 'Approved in JobTread',
  });
}

// ─── The sweep ──────────────────────────────────────────────────────

async function decisionWaitMs(env) {
  try { return notifySettings((await getLiveForm(env.DB)).definition?.notify).waits.decision * 60 * 1000; } catch { return notifySettings(null).waits.decision * 60 * 1000; }
}

/** A family that's no longer approved while it waited: forget it and clear its Slack problem */
async function dropUnapproved(env, now) {
  const { results } = await env.DB.prepare(`SELECT a.account_id, a.name, a.alerted, n.status FROM applicant_approvals a JOIN applicant_notify n ON n.account_id = a.account_id
    WHERE a.state = 'waiting' AND n.status != 'Approved' LIMIT 20`).all();
  for (const r of results || []) {
    await env.DB.prepare('DELETE FROM applicant_approvals WHERE account_id = ?').bind(r.account_id).run();
    if (r.alerted) await slackResolved(env, `approved:${r.account_id}`, slackCard({ icon: '✅', title: `${r.name} is no longer approved`, lead: `Their status is now ${r.status || 'blank'}, so no job is needed.` }), { summary: 'No longer approved' }).catch(() => null);
  }
}

/**
 * Every settled approval that still needs its job or profile, a few per run.
 * Safe to call any number of times; never throws.
 */
export async function runApprovals(env, { fetchImpl = fetch, now = Date.now(), limit = 5 } = {}) {
  const { DB } = env;
  if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
  const out = { made: [], waiting: [], other: [] };
  try {
    await ensureApprovalSchema(DB);
    await ensureNotifySchema(DB);
    const launch = await launchAt(DB, now);
    if ((await pauseState(DB, now)).active) {
      // Statuses may be moving for a cleanup: nothing is made, but it did run (Site → Automations)
      await setState(DB, 'lastRun', { at: iso(now), made: 0, waiting: 0, paused: true }, now);
      return { ...out, paused: true };
    }
    await dropUnapproved(env, now);
    const due = await dueFamilies(DB, { launch, settledBy: now - (await decisionWaitMs(env)), now, limit });
    for (const f of due) {
      if (!(await claim(DB, f, now))) continue;
      let r;
      try {
        r = await approveFamily(env, f.account_id, { fetchImpl, now });
      } catch (e) {
        // Couldn't even read the family: their turn comes round again
        const row = await getRow(DB, f.account_id);
        r = await wait(env, row, { id: f.account_id, name: f.name }, 'error', e.message, now);
      }
      if (r.job) out.made.push(r); else if (r.waiting) out.waiting.push(r); else out.other.push(r);
    }
    // Good news when something new exists; finding what was already there (a past family's status bounced) is no news
    const news = out.made.filter(m => m.job.made || m.kid?.made || m.kid?.test);
    const real = news.filter(m => !isTestFamily(m.name));
    const tests = news.filter(m => isTestFamily(m.name));
    if (real.length) await slackPost(env, madeCard(real), { kind: 'news' }).catch(() => null);
    if (tests.length) await slackPost(env, madeCard(tests, { test: true }), { kind: 'news' }).catch(() => null);
    await setState(DB, 'lastRun', { at: iso(now), made: out.made.length, waiting: out.waiting.length }, now);
  } catch (e) {
    out.error = e.message;
    try { await setState(DB, 'lastError', { at: iso(now), error: String(e.message || e).slice(0, 200) }, now); } catch { /* nothing more to do */ }
  }
  return out;
}

/** For Site → Automations: when it last ran, what it made lately, who's waiting and why */
export async function approvalsStatus(DB) {
  try {
    await ensureApprovalSchema(DB);
    const [lastRun, lastError, launch, recent, waiting] = await Promise.all([
      getState(DB, 'lastRun'), getState(DB, 'lastError'), getState(DB, 'launch'),
      DB.prepare("SELECT account_id, name, job_id, job_name, job_made, kid_slug, kid_made, done_at FROM applicant_approvals WHERE state = 'done' ORDER BY done_at DESC LIMIT 5").all(),
      DB.prepare("SELECT account_id, name, problem, attempts, next_try_at FROM applicant_approvals WHERE state = 'waiting' ORDER BY approved_at").all(),
    ]);
    return { lastRun, lastError, launch, recent: recent.results || [], waiting: waiting.results || [] };
  } catch {
    return null;
  }
}
