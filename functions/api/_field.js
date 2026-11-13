/**
 * Field work in JobTread, as the person doing it: daily logs, photos on them, and the schedule
 * ===========================================================================
 * Peter, Nov 12 2026: "i need a single place for him to do photos, logs, schedule updates",
 * "i need it to be easy and seamless for him to use", "build it here". Christian, SOARD's
 * project manager, talks to Claude through the SOARD connection (./_mcp/field.js); everything
 * he does there lands in JobTread under his own name, the way his logs from the JobTread app
 * do, never as the website's login (Agent Gracie).
 *
 * Each person connects their own JobTread once. JobTread's sign-in for other sites (its OAuth:
 * nothing to register) sends them back to /api/jobtread-callback with a code, and the code buys a
 * key that acts as them. The key stays in D1 jt_links: never in a browser, never in Claude. It's
 * kept only for someone on SOARD's team in JobTread (an internal member of SOARD's organization),
 * never for the website's own login. JobTread drops a key that goes 90 days unused, and a person
 * can delete theirs in their JobTread profile: either way the next call asks them to connect again.
 *
 * Photos go straight from the phone to JobTread's own storage. The site asks JobTread for an
 * upload slot for each photo (as the person), the page sends the photo there (JobTread's storage
 * takes a browser's upload from any page), and the site then puts the uploads on the person's log
 * for that day, starting the log when there isn't one. field_uploads remembers each upload put on
 * a log, so trying again never adds a photo twice.
 */

import { pave, SOARD_ORG_ID, SITE_LOGIN } from './_reveals.js';
import { SITE_URL } from './_reveal-invite-email.js';
import { dayIn } from '../../public/admin/events-shared.js';

const AUTHORIZE = 'https://app.jobtread.com/oauth/authorize';
const TOKEN = 'https://api.jobtread.com/oauth/token';
export const CALLBACK = `${SITE_URL}/api/jobtread-callback`;
/**
 * Where a person connects their JobTread. It's the photo page, behind the admin's sign-in, which goes straight on
 * to JobTread's sign-in (/api/field-admin?connect=1) when they aren't connected yet. Never /api/field-admin itself:
 * the /api/ routes don't send anyone to sign in, so a phone's fresh browser (a link opened from Claude) would get
 * "Unauthorized" there.
 */
export const CONNECT_URL = `${SITE_URL}/admin/photos/?connect=1`;
/** The page that adds photos when the box in Claude can't open the phone's camera */
export const photosPage = ({ jobId, date }) => `${SITE_URL}/admin/photos/?job=${encodeURIComponent(jobId)}${date ? `&date=${date}` : ''}`;
export const jobUrl = (id) => `https://app.jobtread.com/jobs/${id}`;
export const scheduleUrl = (id) => `https://app.jobtread.com/jobs/${id}/schedule`;

const STATE_MS = 15 * 60 * 1000;
// The job's Status and Project Manager fields (as ./_kid-status.js and ./_reveal-nudges.js read them)
const FIELD_STATUS = '22P52qfFub9b';
const FIELD_PM = '22NMZbwAM7X5';
/** Photos in one go, and the biggest file JobTread is asked to take */
export const MAX_FILES = 30;
export const MAX_BYTES = 2 * 1024 ** 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const JT_ID = /^[A-Za-z0-9]{10,16}$/;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS jt_links (email TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT, membership_id TEXT, grant_key TEXT NOT NULL, linked_at TEXT NOT NULL, used_at TEXT, error TEXT, error_at TEXT)',
  'CREATE TABLE IF NOT EXISTS jt_link_states (state TEXT PRIMARY KEY, email TEXT NOT NULL, back TEXT, made_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS field_uploads (upload_id TEXT PRIMARY KEY, email TEXT NOT NULL, job_id TEXT NOT NULL, log_id TEXT NOT NULL, file_id TEXT, at TEXT NOT NULL)',
];
const _ready = new WeakSet();
async function ready(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((q) => DB.prepare(q)));
  _ready.add(DB);
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
/** JobTread's own words from a failed call, without the wrapper */
const jtWords = (err) => String(err?.message || err || '').replace(/^JobTread returned \d+:\s*/, '').slice(0, 200) || 'JobTread didn’t answer';

/** Said when someone has to connect (or connect again) before JobTread work can be theirs */
export class LinkNeeded extends Error {
  constructor(broken) {
    super(broken
      ? `Your JobTread connection stopped working (JobTread lets a connection go after 90 days unused). Connect it again, once, here: ${CONNECT_URL}`
      : `First connect your JobTread, once, so what you do here shows your name in JobTread: ${CONNECT_URL}`);
    this.code = 'LINK';
    this.connect = CONNECT_URL;
  }
}

// ── Connecting a person's JobTread ─────────────────────────────────────────

/** Where JobTread's sign-in starts for this person; `back` is the admin page to return to */
export async function startLink(env, email, { back = '', now = Date.now() } = {}) {
  await ready(env.DB);
  const state = hex(24);
  const to = /^\/admin\/[\w\-./?=&%#]*$/.test(back) && !back.includes('//') ? back : '';
  await env.DB.batch([
    env.DB.prepare('DELETE FROM jt_link_states WHERE made_at < ?').bind(iso(now - STATE_MS)),
    env.DB.prepare('INSERT INTO jt_link_states (state, email, back, made_at) VALUES (?, ?, ?, ?)').bind(state, email, to, iso(now)),
  ]);
  return `${AUTHORIZE}?redirect_uri=${encodeURIComponent(CALLBACK)}&state=${state}`;
}

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * JobTread's code → this person's key, kept once it's checked to be someone on SOARD's team.
 * → { email, name, back }. Throws with code STATE (stale or unknown), NOT_STAFF, SITE_LOGIN or FAILED.
 */
export async function finishLink(env, { code, state }, { fetchImpl = fetch, now = Date.now() } = {}) {
  await ready(env.DB);
  if (!/^[a-f0-9]{48}$/.test(String(state || ''))) throw fail('STATE', 'This sign-in wasn’t started here');
  const row = await env.DB.prepare('SELECT email, back, made_at FROM jt_link_states WHERE state = ?').bind(state).first();
  await env.DB.prepare('DELETE FROM jt_link_states WHERE state = ?').bind(state).run();
  if (!row || Date.parse(row.made_at) < now - STATE_MS) throw fail('STATE', 'This sign-in started too long ago');
  const c = String(code || '');
  if (!c || c.length > 500) throw fail('FAILED', 'JobTread sent no code');
  const res = await fetchImpl(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }) });
  const body = await res.json().catch(() => null);
  const key = body?.access_token;
  if (!res.ok || typeof key !== 'string' || !key) throw fail('FAILED', `JobTread didn’t hand back a key (${res.status})`);
  const out = await pave(key, { currentGrant: { user: {
    id: {}, name: {}, emailAddress: {},
    memberships: { $: { size: 50 }, nodes: { id: {}, isInternal: {}, organization: { id: {} } } },
  } } }, fetchImpl).catch((err) => { throw fail('FAILED', jtWords(err)); });
  const user = out?.currentGrant?.user;
  if (String(user?.emailAddress || '').toLowerCase() === SITE_LOGIN) throw fail('SITE_LOGIN', 'That’s the website’s own JobTread login');
  const m = (user?.memberships?.nodes || []).find((x) => x?.organization?.id === SOARD_ORG_ID && x.isInternal);
  if (!user?.id || !m) throw fail('NOT_STAFF', 'That JobTread login isn’t on SOARD’s team');
  await env.DB.prepare('INSERT OR REPLACE INTO jt_links (email, user_id, user_name, membership_id, grant_key, linked_at, used_at, error, error_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)')
    .bind(row.email, user.id, user.name || null, m.id, key, iso(now)).run();
  return { email: row.email, name: user.name || '', back: row.back || '' };
}

/**
 * Whether a JobTread login's name looks like the person signed in (a word of it in their email: "Christian Nielsen"
 * and cnielsen@): a connection made while the browser was signed in to JobTread as someone else (Nov 13: Peter as
 * DATAx, an integration's login) shows as that login on everything, so the pages and Claude say so.
 */
export function looksLike(name, email) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const words = String(name || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  return !local || !words.length || words.some((w) => local.includes(w));
}

/** Whether this person's JobTread is connected → { linked, name, since, broken, likely } (likely: the login looks like them) */
export async function linkStatus(env, email) {
  await ready(env.DB);
  const row = await env.DB.prepare('SELECT user_name, linked_at, error FROM jt_links WHERE email = ?').bind(email).first();
  return row ? { linked: !row.error, name: row.user_name || null, since: row.linked_at, broken: !!row.error, likely: looksLike(row.user_name, email) }
    : { linked: false, name: null, since: null, broken: false, likely: true };
}

/** Forget this person's key (their JobTread profile can delete it too) */
export async function unlink(env, email) {
  await ready(env.DB);
  await env.DB.prepare('DELETE FROM jt_links WHERE email = ?').bind(email).run();
}

/**
 * JobTread as this person: q(query) runs a Pave query with their key. → { q, email, userId, name, membershipId }
 * Throws LinkNeeded when they haven't connected, or JobTread no longer takes their key.
 */
export async function asPerson(env, email, fetchImpl = fetch) {
  await ready(env.DB);
  const row = await env.DB.prepare('SELECT user_id, user_name, membership_id, grant_key, error FROM jt_links WHERE email = ?').bind(email).first();
  if (!row) throw new LinkNeeded(false);
  if (row.error) throw new LinkNeeded(true);
  let used = false;
  const q = async (query) => {
    try {
      const out = await pave(row.grant_key, query, fetchImpl);
      if (!used) {
        used = true;
        await env.DB.prepare('UPDATE jt_links SET used_at = ? WHERE email = ?').bind(iso(), email).run().catch(() => {});
      }
      return out;
    } catch (err) {
      if (/invalid or expired/i.test(String(err?.message || ''))) {
        await env.DB.prepare('UPDATE jt_links SET error = ?, error_at = ? WHERE email = ?').bind('expired', iso(), email).run().catch(() => {});
        throw new LinkNeeded(true);
      }
      throw new Error(jtWords(err));
    }
  };
  return { q, email, userId: row.user_id, name: row.user_name || '', membershipId: row.membership_id };
}

// ── Jobs ───────────────────────────────────────────────────────────────────

const JOB = {
  id: {}, name: {}, closedOn: {},
  customFieldValues: { $: { size: 5, where: [['customField', 'id'], 'in', [FIELD_STATUS, FIELD_PM]] }, nodes: { value: {}, customField: { id: {} } } },
};
const shapeJob = (j) => {
  const v = Object.fromEntries((j?.customFieldValues?.nodes || []).map((n) => [n.customField?.id, n.value]));
  return { id: j.id, name: j.name, status: v[FIELD_STATUS] || null, pm: v[FIELD_PM] || null, closed: !!j.closedOn };
};

/** SOARD's open jobs, by name */
export async function openJobs(p) {
  const jobs = [];
  let page = '';
  for (let i = 0; i < 4; i++) {
    const r = await p.q({ organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, where: ['closedOn', '=', null], ...(page ? { page } : {}) }, nextPage: {}, nodes: JOB } } });
    const c = r?.organization?.jobs;
    jobs.push(...(c?.nodes || []).map(shapeJob));
    page = c?.nextPage || '';
    if (!page) break;
  }
  return jobs.sort((a, b) => a.name.localeCompare(b.name));
}

const FILLER = new Set(['job', 'jobs', 'the', 'house', 'home', 'log', 'logs', 'room', 'rooms', 'makeover', 'project']);
/** The words of a job named in passing ("Lizzie's", "max daniel") */
const wordsOf = (text) => String(text || '').toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !FILLER.has(w));

/**
 * A job from its id or its name in passing ("Lizzie", "Max Daniel", "Dylan's"): open jobs only.
 * → { job } | { choices: [job] } | { none: true, open: [job] }
 */
export async function findJob(p, text) {
  const t = String(text || '').trim();
  if (JT_ID.test(t) && t.startsWith('22')) {
    const r = await p.q({ job: { $: { id: t }, ...JOB } });
    if (r?.job) return r.job.closedOn ? { closed: shapeJob(r.job) } : { job: shapeJob(r.job) };
  }
  const jobs = await openJobs(p);
  const words = wordsOf(t);
  if (!words.length) return { none: true, open: jobs };
  const hits = jobs.filter((j) => words.every((w) => j.name.toLowerCase().includes(w)));
  if (hits.length === 1) return { job: hits[0] };
  if (hits.length > 1) {
    // A whole word beats part of one: "Max" is Max Daniel, not Maxwell
    const whole = hits.filter((j) => words.every((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(j.name.toLowerCase())));
    if (whole.length === 1) return { job: whole[0] };
    return { choices: (whole.length ? whole : hits).slice(0, 12) };
  }
  return { none: true, open: jobs };
}

// ── Daily logs ─────────────────────────────────────────────────────────────

const LOG = { id: {}, date: {}, notes: {}, createdAt: {}, user: { id: {}, name: {} }, files: { count: {} } };
const shapeLog = (l) => ({ id: l.id, date: l.date, by: l.user?.name || null, notes: l.notes || '', photos: l.files?.count || 0 });

/** A job's logs on one day → { job, logs } */
async function logsOn(p, jobId, date) {
  const r = await p.q({ job: { $: { id: jobId }, id: {}, name: {}, closedOn: {}, dailyLogs: { $: { size: 25, where: ['date', '=', date] }, nodes: LOG } } });
  if (!r?.job) throw new Error('That job isn’t in JobTread');
  return { job: r.job, logs: r.job.dailyLogs?.nodes || [] };
}

export const today = (now = Date.now()) => dayIn(now);
const checkDay = (date, now = Date.now()) => {
  const d = date || today(now);
  if (!DAY.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`))) throw new Error('A date is YYYY-MM-DD');
  return d;
};

/**
 * Today's (or that day's) log for this job, theirs: what they said goes on it, after anything it already says
 * (or in place of it, with replace). A log by someone else that day is left alone; theirs is started if there's none.
 * → { logId, job: { id, name }, date, was: 'created' | 'added' | 'replaced', notes, photos }
 */
export async function writeLog(p, { jobId, date, notes, replace = false }, now = Date.now()) {
  const day = checkDay(date, now);
  const words = String(notes || '').replace(/\r\n?/g, '\n').trim();
  if (!words) throw new Error('A daily log needs what happened');
  const { job, logs } = await logsOn(p, jobId, day);
  const mine = logs.find((l) => l.user?.id === p.userId);
  if (mine) {
    const had = String(mine.notes || '').trim();
    const next = replace || !had ? words : had.includes(words) ? had : `${had}\n\n${words}`;
    if (next.length > 10000) throw new Error('That’s more than a log holds (10,000 characters). Say it in fewer words, or replace the log.');
    if (next !== had) await p.q({ updateDailyLog: { $: { id: mine.id, notes: next } } });
    return { logId: mine.id, job: { id: job.id, name: job.name }, date: day, was: replace ? 'replaced' : 'added', notes: next, photos: mine.files?.count || 0 };
  }
  if (words.length > 10000) throw new Error('That’s more than a log holds (10,000 characters).');
  const r = await p.q({ createDailyLog: { $: { jobId, date: day, notes: words }, createdDailyLog: { id: {} } } });
  const id = r?.createDailyLog?.createdDailyLog?.id;
  if (!id) throw new Error('JobTread didn’t make the log');
  return { logId: id, job: { id: job.id, name: job.name }, date: day, was: 'created', notes: words, photos: 0 };
}

/** The person's own log on a job for a day, if they've started one → { job, log } */
export async function ownLog(p, jobId, date, now = Date.now()) {
  const day = checkDay(date, now);
  const { job, logs } = await logsOn(p, jobId, day);
  const mine = logs.find((l) => l.user?.id === p.userId);
  return { job: { id: job.id, name: job.name, closed: !!job.closedOn }, date: day, log: mine ? shapeLog(mine) : null };
}

/** Logs on a job (or all open jobs' logs) from a day to a day, newest first */
export async function readLogs(p, { jobId, from, to }, now = Date.now()) {
  const end = checkDay(to, now);
  const start = checkDay(from || new Date(Date.parse(`${end}T12:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10), now);
  const where = { and: [['date', '>=', start], ['date', '<=', end]] };
  const sel = { $: { size: 60, where, sortBy: [{ field: 'date', order: 'desc' }] }, nodes: { ...LOG, job: { id: {}, name: {} } } };
  const r = jobId ? await p.q({ job: { $: { id: jobId }, dailyLogs: sel } }) : await p.q({ organization: { $: { id: SOARD_ORG_ID }, dailyLogs: sel } });
  const nodes = (jobId ? r?.job?.dailyLogs?.nodes : r?.organization?.dailyLogs?.nodes) || [];
  return { from: start, to: end, logs: nodes.map((l) => ({ ...shapeLog(l), job: l.job?.name || null })) };
}

// ── Photos ─────────────────────────────────────────────────────────────────

const MEDIA = /^(image|video)\/[\w.+-]+$/;
/** A file's name as JobTread shows it: its own (IMG_2843.jpeg), cleaned, never a path */
export function fileName(name, type, n = 1) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (base && base !== '.' && base !== '..') return base;
  const ext = (String(type).split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('quicktime', 'mov').slice(0, 8);
  return `Photo ${n}.${ext}`;
}

/**
 * An upload slot in JobTread's storage for each file (as the person): the page sends each file straight there.
 * files: [{ name, type, size }] → [{ name, uploadId, url, method, headers } | { name, problem }]
 */
export async function photoSlots(p, files) {
  if (!Array.isArray(files) || !files.length) throw new Error('No photos were picked');
  if (files.length > MAX_FILES) throw new Error(`Up to ${MAX_FILES} at a time`);
  const one = async (f, i) => {
    const name = fileName(f?.name, f?.type, i + 1);
    const type = String(f?.type || '').toLowerCase();
    const size = Math.floor(Number(f?.size));
    if (!MEDIA.test(type)) return { name, problem: 'Only photos and videos go on a log' };
    if (!(size > 0)) return { name, problem: 'This file is empty' };
    if (size > MAX_BYTES) return { name, problem: 'This file is bigger than 2 GB' };
    try {
      const r = await p.q({ createUploadRequest: { $: { organizationId: SOARD_ORG_ID, size, type }, createdUploadRequest: { id: {}, url: {}, method: {}, headers: {} } } });
      const u = r?.createUploadRequest?.createdUploadRequest;
      if (!u?.id || !/^https:\/\/storage\.googleapis\.com\//.test(String(u.url || ''))) return { name, problem: 'JobTread didn’t give a place to send it' };
      return { name, uploadId: u.id, url: u.url, method: u.method || 'PUT', headers: u.headers || {} };
    } catch (err) {
      if (err?.code === 'LINK') throw err;
      return { name, problem: jtWords(err) };
    }
  };
  // A few at a time: JobTread answers each in a moment
  const out = [];
  for (let i = 0; i < files.length; i += 6) out.push(...await Promise.all(files.slice(i, i + 6).map((f, k) => one(f, i + k))));
  return out;
}

/**
 * The sent photos onto the person's log for that day (started now if there isn't one), each once.
 * files: [{ uploadId, name }] → { logId, job, date, added, already, failed: [{ name, problem }] }
 */
export async function photosDone(env, p, { jobId, date, logId, files }, now = Date.now()) {
  await ready(env.DB);
  if (!Array.isArray(files) || !files.length) throw new Error('No photos to add');
  if (files.length > MAX_FILES) throw new Error(`Up to ${MAX_FILES} at a time`);
  const day = checkDay(date, now);
  let log = logId || null;
  const { job, logs } = await logsOn(p, jobId, day);
  if (job.closedOn) throw new Error('That job is closed in JobTread');
  if (log && !logs.some((l) => l.id === log)) {
    // A log from another day still has to be this job's
    const r = await p.q({ dailyLog: { $: { id: log }, id: {}, job: { id: {} } } });
    if (r?.dailyLog?.job?.id !== job.id) throw new Error('That log isn’t this job’s');
  }
  if (!log) log = logs.find((l) => l.user?.id === p.userId)?.id || null;
  if (!log) {
    const r = await p.q({ createDailyLog: { $: { jobId: job.id, date: day, notes: null }, createdDailyLog: { id: {} } } });
    log = r?.createDailyLog?.createdDailyLog?.id;
    if (!log) throw new Error('JobTread didn’t make the log');
  }
  let added = 0;
  let already = 0;
  const failed = [];
  for (const [i, f] of files.entries()) {
    const id = String(f?.uploadId || '');
    const name = fileName(f?.name, '', i + 1);
    if (!JT_ID.test(id)) { failed.push({ uploadId: id, name, problem: 'That upload isn’t one of JobTread’s' }); continue; }
    // Claimed first, so two tries at once never put it on twice
    const claim = await env.DB.prepare('INSERT OR IGNORE INTO field_uploads (upload_id, email, job_id, log_id, file_id, at) VALUES (?, ?, ?, ?, NULL, ?)')
      .bind(id, p.email, job.id, log, iso(now)).run();
    if (!claim?.meta?.changes) { already++; continue; }
    try {
      const r = await p.q({ createFile: { $: { targetType: 'dailyLog', targetId: log, uploadRequestId: id, name }, createdFile: { id: {} } } });
      await env.DB.prepare('UPDATE field_uploads SET file_id = ? WHERE upload_id = ?').bind(r?.createFile?.createdFile?.id || '', id).run();
      added++;
    } catch (err) {
      await env.DB.prepare('DELETE FROM field_uploads WHERE upload_id = ? AND file_id IS NULL').bind(id).run().catch(() => {});
      if (err?.code === 'LINK') throw err;
      failed.push({ uploadId: id, name, problem: jtWords(err) });
    }
  }
  return { logId: log, job: { id: job.id, name: job.name }, date: day, added, already, failed };
}

// ── The schedule ───────────────────────────────────────────────────────────

/** One task, asked for by its id */
const TASK = {
  id: {}, name: {}, startDate: {}, endDate: {}, startTime: {}, endTime: {}, progress: {}, isToDo: {},
  taskType: { name: {} }, job: { id: {}, name: {} },
  assignedMemberships: { $: { size: 10 }, nodes: { id: {}, user: { name: {} } } },
};
/**
 * Each task in a job's list. JobTread refuses a list that reaches through each task's people to their names
 * ("Request Entity Too Large", even 50 at a time; seen live Nov 13 2026 on Lizzie's 80 tasks), so the list asks
 * only who is on each task, by membership id, and namesOf() looks the names up in one flat request.
 */
const TASK_ROW = {
  id: {}, name: {}, startDate: {}, endDate: {}, startTime: {}, endTime: {}, progress: {}, isToDo: {},
  taskType: { name: {} },
  assignedMemberships: { $: { size: 10 }, nodes: { id: {} } },
};
const shapeTask = (t, day, names) => ({
  id: t.id, name: t.name, kind: t.isToDo ? 'to-do' : 'schedule', type: t.taskType?.name || null,
  start: t.startDate || null, end: t.endDate || null, ...(t.startTime ? { startTime: t.startTime } : {}),
  done: (t.progress ?? 0) >= 1, progress: Math.round((t.progress ?? 0) * 100),
  overdue: !!t.endDate && t.endDate < day && (t.progress ?? 0) < 1,
  who: (t.assignedMemberships?.nodes || []).map((m) => m.user?.name || names?.get(m.id)).filter(Boolean),
});

/**
 * A job's schedule and to-dos: everything not done that's late or within the window, and what's done inside it.
 * → { job, from, to, tasks }
 */
export async function jobTasks(p, jobId, { from, to } = {}, now = Date.now()) {
  const day = today(now);
  const start = checkDay(from || new Date(Date.parse(`${day}T12:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10), now);
  const end = checkDay(to || new Date(Date.parse(`${day}T12:00:00Z`) + 28 * 86400000).toISOString().slice(0, 10), now);
  const all = [];
  let page = '';
  let name = '';
  for (let i = 0; i < 3; i++) {
    const r = await p.q({ job: { $: { id: jobId }, id: {}, name: {}, tasks: { $: { size: 100, where: ['isGroup', '=', false], ...(page ? { page } : {}) }, nextPage: {}, nodes: TASK_ROW } } });
    if (!r?.job) throw new Error('That job isn’t in JobTread');
    name = r.job.name;
    all.push(...(r.job.tasks?.nodes || []));
    page = r.job.tasks?.nextPage || '';
    if (!page) break;
  }
  const inWindow = (t) => (t.endDate || t.startDate || '') >= start && (t.startDate || t.endDate || '') <= end;
  const open = (t) => (t.progress ?? 0) < 1;
  const shown = all.filter((t) => (open(t) && (!t.startDate || t.startDate <= end)) || inWindow(t));
  const names = await namesOf(p, shown.flatMap((t) => (t.assignedMemberships?.nodes || []).map((m) => m.id)));
  const tasks = shown.map((t) => shapeTask(t, day, names))
    .sort((a, b) => String(a.start || a.end || '9999').localeCompare(String(b.start || b.end || '9999')) || a.name.localeCompare(b.name));
  return { job: { id: jobId, name }, from: start, to: end, tasks };
}

/** Membership ids → Map(id → the person's name), 50 to a request (anyone on a task: staff, a trade, a vendor) */
async function namesOf(p, ids) {
  const want = [...new Set(ids.filter(Boolean))];
  const names = new Map();
  for (let i = 0; i < want.length; i += 50) {
    const r = await p.q({ organization: { $: { id: SOARD_ORG_ID }, memberships: { $: { size: 50, where: ['id', 'in', want.slice(i, i + 50)] }, nodes: { id: {}, user: { name: {} } } } } });
    for (const m of r?.organization?.memberships?.nodes || []) if (m.user?.name) names.set(m.id, m.user.name);
  }
  return names;
}

/** SOARD's team in JobTread → [{ membershipId, name }]; never the website's own login (Agent Gracie), which no task is for */
async function team(p) {
  const r = await p.q({ organization: { $: { id: SOARD_ORG_ID }, memberships: { $: { size: 50, where: ['isInternal', '=', true] }, nodes: { id: {}, user: { name: {}, emailAddress: {} } } } } });
  return (r?.organization?.memberships?.nodes || [])
    .filter((m) => String(m.user?.emailAddress || '').toLowerCase() !== SITE_LOGIN)
    .map((m) => ({ membershipId: m.id, name: m.user?.name || '' })).filter((m) => m.name);
}

/** Names ("Christian", "Clareece Cunningham", "me") → their memberships, or a plain reason none matched */
async function membershipsFor(p, names) {
  const people = await team(p);
  const ids = [];
  for (const raw of names) {
    const n = String(raw || '').trim().toLowerCase();
    if (!n) continue;
    if (n === 'me' || n === 'myself') { ids.push(p.membershipId); continue; }
    const full = people.filter((m) => m.name.toLowerCase() === n);
    const first = people.filter((m) => m.name.toLowerCase().split(/\s+/)[0] === n);
    const hit = full.length === 1 ? full : first.length === 1 ? first : [];
    if (!hit.length) throw new Error(`“${raw}” isn’t one person on SOARD’s team in JobTread. The team: ${people.map((m) => m.name).join(', ')}.`);
    ids.push(hit[0].membershipId);
  }
  return [...new Set(ids)];
}

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/**
 * Change one task: its dates (a new start alone keeps its length; JobTread moves the tasks linked after it, as in
 * the app), done or not, how far along, who it's on, its name. → { before, after }
 */
export async function changeTask(p, { taskId, startDate, endDate, done, progress, assignees, name, onJob }, now = Date.now()) {
  if (!JT_ID.test(String(taskId || ''))) throw new Error('That isn’t a task’s id. Get it from the job’s schedule.');
  const r = await p.q({ task: { $: { id: taskId }, ...TASK } });
  const t = r?.task;
  if (!t?.job?.id) throw new Error('That task isn’t on one of SOARD’s jobs');
  if (onJob && t.job.id !== onJob) throw new Error('That task isn’t on this job');
  const day = today(now);
  const $ = { id: taskId };
  if (startDate !== undefined) $.startDate = checkDay(startDate, now);
  if (endDate !== undefined) $.endDate = checkDay(endDate, now);
  if ($.startDate && endDate === undefined && t.startDate && t.endDate) $.endDate = addDays($.startDate, daysBetween(t.startDate, t.endDate));
  if ($.startDate && $.endDate && $.endDate < $.startDate) throw new Error('It can’t end before it starts');
  if (!$.startDate && $.endDate && t.startDate && $.endDate < t.startDate) throw new Error('It can’t end before it starts');
  if (done !== undefined) $.progress = done ? 1 : 0;
  else if (progress !== undefined) $.progress = Math.max(0, Math.min(100, Number(progress))) / 100;
  if (Array.isArray(assignees)) $.assignedMembershipIds = await membershipsFor(p, assignees);
  if (name !== undefined) {
    const n = String(name).replace(/\s+/g, ' ').trim();
    if (!n) throw new Error('A task needs a name');
    $.name = n.slice(0, 200);
  }
  if (Object.keys($).length === 1) throw new Error('Say what to change: dates, done, progress, who, or the name');
  await p.q({ updateTask: { $ } });
  const after = (await p.q({ task: { $: { id: taskId }, ...TASK } }))?.task || { ...t, ...$ };
  return { job: { id: t.job.id, name: t.job.name }, before: shapeTask(t, day), after: shapeTask(after, day) };
}

/**
 * Everything the schedule window draws for a job (./_mcp/field.js, public/mcp-app/schedule-1.js): its tasks (as
 * jobTasks), today, who's signed in and SOARD's team (the names a task can be put on).
 * → { job: { id, name, schedule }, as, today, from, to, team: [name], tasks }
 */
export async function scheduleView(p, jobId, { from, to } = {}, now = Date.now()) {
  const [s, people] = await Promise.all([
    jobTasks(p, jobId, { from, to }, now),
    // Without the team the window still works: only who's on a task already can be kept
    team(p).catch((err) => { if (err?.code === 'LINK') throw err; return []; }),
  ]);
  const names = [...new Set(people.map((m) => m.name))].sort((a, b) => a.localeCompare(b));
  return { job: { id: jobId, name: s.job.name, schedule: scheduleUrl(jobId) }, as: p.name, today: today(now), from: s.from, to: s.to, team: names, tasks: s.tasks };
}

/** A new task on a job's schedule, or a to-do → the task */
export async function addTask(p, { jobId, name, startDate, endDate, assignees, todo = false }, now = Date.now()) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) throw new Error('A task needs a name');
  const $ = { targetType: 'job', targetId: jobId, name: n.slice(0, 200), isToDo: !!todo };
  if (startDate) $.startDate = checkDay(startDate, now);
  if (endDate) $.endDate = checkDay(endDate, now);
  if ($.startDate && !$.endDate && !todo) $.endDate = $.startDate;
  if ($.startDate && $.endDate && $.endDate < $.startDate) throw new Error('It can’t end before it starts');
  if (Array.isArray(assignees) && assignees.length) $.assignedMembershipIds = await membershipsFor(p, assignees);
  const r = await p.q({ createTask: { $, createdTask: { id: {} } } });
  const id = r?.createTask?.createdTask?.id;
  if (!id) throw new Error('JobTread didn’t make the task');
  const t = (await p.q({ task: { $: { id }, ...TASK } }))?.task;
  return shapeTask(t || { id, name: $.name, startDate: $.startDate, endDate: $.endDate, isToDo: !!todo }, today(now));
}
