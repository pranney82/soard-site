/**
 * Demo Day calendar invites
 * ===========================================================================
 * Demo day is the first day of construction. When a job's "Set Start Date"
 * task is checked off in JobTread, the site sends "Dylan's Demo Day" from
 * the organizer's calendar (Clareece, the same as reveal invites) for the
 * date on the job's Demo task: at the Demo task's own time when it has one,
 * otherwise at the default start from the admin (9:00 AM, for an hour).
 *
 * Guests (the organizer is never one, and nobody sees the others):
 *   family   the job's customer contacts with an email, and Makeover Family
 *            users given access to the job
 *   staff    internal Admin and Designer users in JobTread
 *   sponsor  everyone with the Sponsor role given access to the job in
 *            JobTread; the job's Monetary Sponsor field names which sponsor
 *            that is (the admin flags a sponsor with nobody on the job)
 *   always   the admin's "Every demo day" list (social media, …)
 * Nobody else from the job's JobTread access list (Peter, Oct 22 2026: the
 * family, the internal team, the monetary sponsor and social media).
 * The every-demo-day list is the only one kept in the admin (everyone else
 * comes from JobTread). Its emails live in D1 (demo_invite_people), never in
 * site_config, which is written into builds (the repo is public).
 *
 * After it's out the invite follows the job: the Demo task moves and the same
 * event moves (guests get an update); people added or taken off get their
 * invite or cancellation (staff-only changes update quietly). Same rules as
 * reveal invites: the site never cancels a demo day invite (delete the event
 * in Google Calendar and the site leaves it alone for good), a job closed or
 * put on hold keeps its invite with one heads-up to staff, and a demo day
 * that has happened is never touched again.
 *
 * Sent by hand already: before the first send, the organizer's calendar is
 * read around the demo date. An event there titled with "demo" and the kid's
 * name that isn't the site's means someone already invited people by hand, so
 * the site leaves that demo day alone ("Send ours anyway" in the admin
 * overrides it).
 *
 * Woken by the same JobTread workflow as reveal invites: any task checked or
 * un-checked posts { jobId, eventId } to /api/reveal-invites, which checks
 * this job's demo invite too. The Demo task moving or the Monetary Sponsor
 * changing fires no workflow, so every 5 minutes (maybeCheckDemos, on the
 * heartbeat) the open jobs whose demo day is ahead are re-read; that check is
 * also the safety net for a missed wake-up.
 *
 * Off until turned on in the admin (its own Demo Day page). TEST jobs and the
 * office sandbox send even while off, only to the test guests, marked TEST,
 * and the 5-minute check keeps following TEST jobs while off, so a whole
 * rehearsal (Set Start Date, then the Demo task moving) can run before it's on.
 * The admin shows each invite's answers (yes, no, maybe, not yet) by name,
 * read from Google, including on an invite someone sent by hand.
 */

import { SOARD_ORG_ID, todayEastern, easternParts, loadKids } from './_reveals.js';
import {
  readConfig as readInviteConfig, ensureSchema as ensureInviteSchema, fetchStaff, guestGroups, renderTemplate,
  JOB_ACCESS, FIELD_STATUS, FIELD_MAKEOVER_TYPE, DEFAULT_ORGANIZER, DEFAULT_TEST_GUESTS, SANDBOX_JOB_ID, BY_HAND,
  isTestJob, borrowRealAddress, NOT_STAFF, EMAIL_ALIASES, STAFF_DOMAIN, INACTIVE_STATUSES, pave, normEmail, isEmail,
  fieldValues, hhmm, displayName, hashOf, alertList, escapeHtml, lockJob, unlockJob,
} from './_reveal-invites.js';
import { accessToken, eventIdFor, upsertEvent, cancelEvent, getEvent, listEvents } from './_google-calendar.js';
import { sendEmails, slackPost, slackIssue, slackResolved, emailConfigured } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';

export const FIELD_MONETARY_SPONSOR = '22PZJHV29WFw';
export const DEMO_TASK = 'Demo';
export const SET_START_TASK = 'Set Start Date';
const CONFIG_KEY = 'demo-invites';
const CHECK_KEY = 'demo-invites-check';
const CHECK_EVERY_MS = 5 * 60 * 1000;
const TZ = 'America/New_York';
const SITE = 'https://sunshineonaranneyday.com';
const ADMIN_URL = `${SITE}/admin/#demo-day`;
// An invite sent by hand counts when it's within this many days of the Demo task's date
const BY_HAND_WINDOW_DAYS = 14;
export const SENT_BY_HAND = 'sent by hand';
export const LIST_ALWAYS = 'always';
const MAX_PEOPLE = 50;

export const DEFAULT_TEMPLATE = {
  title: "{name}'s Demo Day",
  message: "{name}'s {space} makeover starts with demo day on {when}.\n\nIt's the first day of construction. Please accept or decline so we know who to expect.",
};
export const TEMPLATE_LIMITS = { title: 150, message: 2000 };
export const DEFAULT_START = '09:00';
export const DEFAULT_MINUTES = 60;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS demo_invites (
    job_id TEXT PRIMARY KEY, event_id TEXT, state TEXT, hash TEXT, demo_date TEXT,
    guests TEXT, last_action TEXT, error TEXT, updated_at TEXT)`,
  // Every invite that went out (sent, updated, found sent by hand…), for the admin
  `CREATE TABLE IF NOT EXISTS demo_invite_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, action TEXT,
    guests INTEGER, demo_date TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_demo_invite_log_job ON demo_invite_log(job_id)`,
  // Who the admin adds to every demo day (list 'always')
  `CREATE TABLE IF NOT EXISTS demo_invite_people (
    list TEXT NOT NULL, email TEXT NOT NULL, name TEXT, role TEXT, updated_at TEXT,
    PRIMARY KEY (list, email))`,
];
const _schemaReady = new WeakSet();
export async function ensureSchema(DB) {
  if (_schemaReady.has(DB)) return;
  // The reveal invite tables hold the per-job lock both kinds of invite use
  await ensureInviteSchema(DB);
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  _schemaReady.add(DB);
}

export async function readConfig(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(CONFIG_KEY).first();
  let data = {};
  try { data = row ? JSON.parse(row.data) : {}; } catch { /* default */ }
  return { enabled: false, startTime: DEFAULT_START, minutes: DEFAULT_MINUTES, ...data, template: { ...DEFAULT_TEMPLATE, ...(data.template || {}) } };
}

export async function writeConfig(DB, patch) {
  const next = { ...(await readConfig(DB)), ...patch };
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(CONFIG_KEY, JSON.stringify(next), new Date().toISOString()).run();
  return next;
}

// ─── People the admin adds ───────────────────

const cleanList = (list = LIST_ALWAYS) => (String(list).trim() === LIST_ALWAYS ? LIST_ALWAYS : null);

/** { always: [{ email, name, role }] }: the every-demo-day list */
export async function listPeople(DB) {
  await ensureSchema(DB);
  const { results } = await DB.prepare('SELECT email, name, role FROM demo_invite_people WHERE list = ? ORDER BY updated_at, email').bind(LIST_ALWAYS).all();
  return { always: (results || []).map((r) => ({ email: r.email, name: r.name || null, role: r.role || null })) };
}

/** Add someone to every demo day (or change their name or role). Throws a readable error. */
export async function savePerson(DB, { list = LIST_ALWAYS, email, name = '', role = '' }) {
  await ensureSchema(DB);
  const l = cleanList(list);
  if (!l) throw new Error('That list doesn\'t exist');
  const e = normEmail(email);
  if (!isEmail(e)) throw new Error('That email doesn\'t look right');
  const count = await DB.prepare('SELECT COUNT(*) AS n FROM demo_invite_people WHERE list = ? AND email != ?').bind(l, e).first('n');
  if (count >= MAX_PEOPLE) throw new Error(`That list is full (${MAX_PEOPLE} people)`);
  await DB.prepare('INSERT OR REPLACE INTO demo_invite_people (list, email, name, role, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(l, e, String(name || '').trim().slice(0, 100) || null, String(role || '').trim().slice(0, 60) || null, new Date().toISOString()).run();
  return { list: l, email: e };
}

export async function removePerson(DB, { list = LIST_ALWAYS, email }) {
  await ensureSchema(DB);
  const l = cleanList(list);
  if (!l) throw new Error('That list doesn\'t exist');
  await DB.prepare('DELETE FROM demo_invite_people WHERE list = ? AND email = ?').bind(l, normEmail(email)).run();
}

// ─── JobTread ───────────────────

const TASK_FIELDS = { id: {}, name: {}, isGroup: {}, startDate: {}, startTime: {}, endDate: {}, endTime: {}, progress: {} };
// The two tasks this reads, by name: they come from the job template ("Designer Pre Con" and "Construction")
const DEMO_TASKS_WHERE = { and: [['isGroup', '=', false], { or: [['name', '=', DEMO_TASK], ['name', '=', SET_START_TASK]] }] };

export async function fetchDemoJob(grantKey, jobId, fetchImpl = fetch) {
  const cf = { nodes: { value: {}, customField: { id: {} } } };
  const body = await pave(grantKey, {
    job: {
      $: { id: jobId },
      id: {}, name: {}, closedOn: {},
      organization: { id: {} },
      location: { address: {}, account: { contacts: { $: { size: 50 }, nodes: { name: {}, customFieldValues: cf } } } },
      customFieldValues: { $: { size: 50 }, ...cf },
      tasks: { $: { size: 20, where: DEMO_TASKS_WHERE }, nodes: TASK_FIELDS },
      aces: JOB_ACCESS,
    },
  }, fetchImpl);
  const job = body?.job || null;
  await borrowRealAddress(grantKey, job, fetchImpl);
  return job;
}

/** Every open job with its Demo and Set Start Date tasks (25 a page: JobTread refuses big worst-case queries) */
async function openJobs(grantKey, fetchImpl) {
  const jobs = [];
  let page = null;
  for (let i = 0; i < 10; i++) {
    const body = await pave(grantKey, {
      organization: {
        $: { id: SOARD_ORG_ID },
        jobs: {
          $: { size: 25, where: ['closedOn', '=', null], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: { id: {}, name: {}, tasks: { $: { size: 10, where: DEMO_TASKS_WHERE }, nodes: TASK_FIELDS } },
        },
      },
    }, fetchImpl);
    jobs.push(...(body?.organization?.jobs?.nodes || []));
    page = body?.organization?.jobs?.nextPage || null;
    if (!page) break;
  }
  return jobs;
}

const named = (job, name) => (job?.tasks?.nodes || [])
  .filter((t) => !t.isGroup && String(t.name || '').trim().toLowerCase() === name.toLowerCase());

/** The job's Demo task (the open one with a date first) and whether Set Start Date is checked off */
export function demoTasks(job) {
  const demos = named(job, DEMO_TASK);
  const demo = demos.find((t) => (t.progress ?? 0) < 1 && t.startDate) || demos.find((t) => t.startDate) || demos[0] || null;
  return { demo, startSet: named(job, SET_START_TASK).some((t) => t.progress === 1) };
}

function addMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const t = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Start and end, "HH:MM": the Demo task's own times, else the default start for the default length */
export function demoSlot(demo, { startTime = DEFAULT_START, minutes = DEFAULT_MINUTES } = {}) {
  const start = hhmm(demo?.startTime) || startTime;
  const own = hhmm(demo?.endTime);
  const end = own && own > start && (demo.endDate || demo.startDate) === demo.startDate ? own : addMinutes(start, minutes);
  return { start, end };
}

/** Demo day is over or under way: its day is past, its start time today has passed, or the Demo task is done */
export function demoHappened(demo, start, now = Date.now()) {
  if (!demo?.startDate) return false;
  if (demo.progress === 1) return true;
  const n = easternParts(new Date(now).toISOString());
  if (demo.startDate !== n.date) return demo.startDate < n.date;
  return start <= (n.time || '00:00');
}

/**
 * What the calendar should have for this job's demo day:
 * { action: 'upsert', event, guests, people } | { action: 'hold', reason, waiting? } | { action: 'skip', reason }
 * `sent`: the invite is out, so Set Start Date no longer gates it.
 * 'hold' + waiting: Set Start Date is checked off but there's no Demo date to invite people to.
 */
export function planDemo(job, staff, { kids = [], people = { always: [] }, organizer = DEFAULT_ORGANIZER, now = Date.now(), config = {}, sent = false, onlyGuests = null } = {}) {
  if (!job) return { action: 'skip', reason: 'job not found' };
  if (job.organization?.id !== SOARD_ORG_ID) return { action: 'skip', reason: 'not a SOARD job' };

  const { demo, startSet } = demoTasks(job);
  const slot = demo?.startDate ? demoSlot(demo, { startTime: config.startTime || DEFAULT_START, minutes: Number(config.minutes) || DEFAULT_MINUTES }) : null;
  if (slot && demoHappened(demo, slot.start, now)) return { action: 'skip', reason: 'demo day has already happened' };

  const values = fieldValues(job.customFieldValues?.nodes);
  if (job.closedOn) return { action: 'hold', reason: 'job closed' };
  if (INACTIVE_STATUSES.has(values[FIELD_STATUS])) return { action: 'hold', reason: `status is ${values[FIELD_STATUS]}` };
  if (!demo?.startDate) return { action: 'hold', reason: demo ? 'the Demo task has no date' : 'the job has no Demo task', waiting: startSet };
  if (!sent && !startSet) return { action: 'skip', reason: 'Set Start Date is not checked off yet' };

  const who = displayName(job, kids);
  const date = demo.startDate;
  const { start, end } = slot;
  const t = { ...DEFAULT_TEMPLATE, ...(config.template || {}) };
  const fill = (text) => renderTemplate(text, { name: who.name, space: values[FIELD_MAKEOVER_TYPE], date, time: start });
  // Labeled links as plain text (HTML descriptions arrive as raw tags in some calendars)
  const lines = [fill(t.message).trim(), ''];
  if (who.slug) lines.push(`Meet ${who.name}: ${SITE}/kids/${who.slug}/`, '');
  const host = (staff || []).find((s) => s.email === organizer)?.name;
  lines.push(`Questions? Email ${host ? `${host} at ` : ''}${organizer}.`, 'Sunshine on a Ranney Day');

  const sponsor = String(values[FIELD_MONETARY_SPONSOR] || '').trim() || null;
  const guests = [];
  const byEmail = {}; // email → { name, kind, role } for the admin's preview
  const seen = new Set([organizer.toLowerCase(), ...NOT_STAFF]);
  const add = (p, kind) => {
    const e = normEmail(p.email);
    if (!isEmail(e) || seen.has(e)) return;
    seen.add(e);
    guests.push(e);
    byEmail[e] = { name: p.name || null, kind, ...(p.role ? { role: p.role } : {}) };
  };
  if (onlyGuests) {
    onlyGuests.forEach((email) => add({ email }, 'test'));
  } else {
    const g = guestGroups(job, staff, []);
    g.family.forEach((p) => add(p, 'family'));
    g.staff.forEach((p) => add(p, 'staff'));
    // The monetary sponsor: Sponsor users given access to the job. Vendors, photographers and design partners aren't invited.
    g.confirmed.filter((p) => p.kind === 'sponsor').forEach((p) => add(p, 'sponsor'));
    (people.always || []).forEach((p) => add(p, 'always'));
  }

  const address = job.location?.address || null;
  const event = {
    id: eventIdFor('soarddemo', job.id),
    summary: fill(t.title).trim() || `${who.name}'s Demo Day`,
    status: 'confirmed',
    location: address || undefined,
    description: lines.join('\n'),
    start: { dateTime: `${date}T${start}:00`, timeZone: TZ },
    end: { dateTime: `${date}T${end}:00`, timeZone: TZ },
    attendees: guests.map((email) => ({ email })),
    guestsCanSeeOtherGuests: false,
    guestsCanInviteOthers: false,
    transparency: 'opaque',
  };
  // What guests act on: they're emailed when these change, not the wording
  const facts = { date, start, end, address };
  return { action: 'upsert', event, guests, people: byEmail, date, facts, name: who.name, sponsor };
}

// ─── Sending ───────────────────

const readRow = (DB, jobId) => DB.prepare('SELECT * FROM demo_invites WHERE job_id = ?').bind(jobId).first();

async function writeRow(DB, row) {
  await DB.prepare(`INSERT OR REPLACE INTO demo_invites (job_id, event_id, state, hash, demo_date, guests, last_action, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.job_id, row.event_id ?? null, row.state ?? null, row.hash ?? null, row.demo_date ?? null,
      row.guests ?? null, row.last_action ?? null, row.error ?? null, new Date().toISOString()).run();
}

async function logInvite(DB, { jobId, action, guests = null, demoDate = null }) {
  await DB.prepare('INSERT INTO demo_invite_log (job_id, action, guests, demo_date, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(jobId, action, guests, demoDate, new Date().toISOString()).run().catch(() => {});
}

const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * A Demo Day invite someone already sent by hand from the organizer's
 * calendar: titled with "demo" and one of the kid's names (from the site or
 * the job: "Dylan Demo Day", "Maddie & Tyrece Demo Day!!"), within two weeks
 * of the demo date, and not one of the site's own. Null when there's none.
 */
export async function findSentByHand(token, organizer, { date, name, jobName }, { fetchImpl = fetch } = {}) {
  const day = 86_400_000;
  const mid = Date.parse(`${date}T12:00:00Z`);
  const items = await listEvents(token, organizer, {
    timeMin: new Date(mid - (BY_HAND_WINDOW_DAYS + 1) * day).toISOString(),
    timeMax: new Date(mid + (BY_HAND_WINDOW_DAYS + 1) * day).toISOString(),
    q: 'demo',
    fetchImpl,
  });
  const names = new Set([...normalize(name).split(' '), ...normalize(String(jobName || '').replace(/\(\d{4}\)\s*$/, '')).split(' ')]
    .filter((t) => t.length >= 3 && t !== 'and' && t !== 'test'));
  return items.find((e) => {
    if (!e.id || String(e.id).startsWith('soarddemo')) return false;
    const words = normalize(e.summary).split(' ');
    return words.some((w) => w.startsWith('demo')) && words.some((w) => names.has(w));
  }) || null;
}

/**
 * Bring the calendar in line with JobTread for one job's demo day. Sends
 * nothing unless sending is on (or `force`, an admin's Retry / Send ours
 * anyway), and nothing when the invite already says it. { action: 'busy' }
 * when another update to the same job's invite holds the lock.
 */
export async function reconcileDemo(env, jobId, opts = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  if (!env.JOBTREAD_GRANT_KEY) return { jobId, action: 'skip', reason: 'JOBTREAD_GRANT_KEY is not set' };
  if (opts.dryRun) return reconcileLocked(env, jobId, opts);
  const key = `demo:${jobId}`;
  if (!(await lockJob(DB, key, opts.wait ?? true))) return { jobId, action: 'busy', reason: 'another update to this invite is running' };
  try {
    return await reconcileLocked(env, jobId, opts);
  } finally {
    await unlockJob(DB, key);
  }
}

async function reconcileLocked(env, jobId, { fetchImpl = fetch, now = Date.now(), force = false, rewrite = false, dryRun = false, verify = false, preloaded = null } = {}) {
  const { DB } = env;
  const [config, inviteConfig] = await Promise.all([readConfig(DB), readInviteConfig(DB)]);
  const organizer = inviteConfig.organizer || DEFAULT_ORGANIZER;
  const [job, staff, kids, people] = await Promise.all([
    fetchDemoJob(env.JOBTREAD_GRANT_KEY, jobId, fetchImpl),
    preloaded?.staff || fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    preloaded?.kids || loadKids(DB).catch(() => []),
    preloaded?.people || listPeople(DB),
  ]);
  const sandbox = jobId === SANDBOX_JOB_ID || isTestJob(job);
  const row = await readRow(DB, jobId);
  const sent = !!(row?.event_id && row.state === 'sent');
  const plan = planDemo(job, staff, { kids, people, organizer, now, config, sent, onlyGuests: sandbox ? (inviteConfig.testGuests || DEFAULT_TEST_GUESTS) : null });
  if (sandbox && plan.event) plan.event.summary = `TEST · ${plan.event.summary}`;
  const live = !dryRun && (config.enabled || force || sandbox);
  const name = job ? displayName(job, kids).name : null;
  const taskId = demoTasks(job).demo?.id;
  const guestCount = () => (row?.guests ? JSON.parse(row.guests).length : null);
  const failed = async (err) => {
    await writeRow(DB, { ...(row || { job_id: jobId }), error: err.message });
    if (err.message !== row?.error) await alertDemo(env, inviteConfig, 'problem', { jobId, name, error: err.message, taskId }).catch(() => {});
    return { jobId, action: 'error', error: err.message };
  };

  if (plan.action === 'skip') return { jobId, action: 'skip', reason: plan.reason };
  // Someone invited people by hand, or deleted the site's invite: left alone unless an admin says otherwise
  if (row?.state === 'by-hand' && !force) return { jobId, action: 'skip', reason: SENT_BY_HAND };
  if (row?.state === 'cancelled' && row.last_action === BY_HAND && !force) return { jobId, action: 'skip', reason: BY_HAND };

  // Calling a demo day off is done by deleting its event in Google Calendar.
  // Once that's happened it's only recorded, never written to again.
  const handCancelled = async () => {
    const token = await accessToken(env, organizer, { fetchImpl, now });
    const onCalendar = await getEvent(token, organizer, row.event_id, { fetchImpl });
    if (onCalendar && onCalendar.status !== 'cancelled') return null;
    await writeRow(DB, { ...row, state: 'cancelled', last_action: BY_HAND, error: null });
    await logInvite(DB, { jobId, action: BY_HAND, guests: guestCount(), demoDate: row.demo_date });
    return { jobId, action: 'skip', reason: BY_HAND };
  };

  if (plan.action === 'hold') {
    if (!sent) {
      if (!plan.waiting) return { jobId, action: 'skip', reason: plan.reason };
      // Set Start Date is checked off, but there's no day to invite people to: staff hear it once
      if (!live) return { jobId, action: 'would-wait', reason: plan.reason };
      const note = `waiting: ${plan.reason}`;
      if (row?.last_action !== note) {
        await writeRow(DB, { ...(row || { job_id: jobId }), last_action: note, error: null });
        await logInvite(DB, { jobId, action: note });
        await alertDemo(env, inviteConfig, 'waiting', { jobId, name, reason: plan.reason, taskId }).catch(() => {});
      }
      return { jobId, action: 'waiting', reason: plan.reason };
    }
    if (!live) return { jobId, action: 'would-hold', reason: plan.reason };
    try {
      if (verify && !force) {
        const gone = await handCancelled();
        if (gone) return gone;
      }
      if (sandbox) {
        const token = await accessToken(env, organizer, { fetchImpl, now });
        await cancelEvent(token, organizer, row.event_id, { fetchImpl });
        await writeRow(DB, { ...row, state: 'cancelled', hash: null, last_action: `cancelled: ${plan.reason}`, error: null });
        await logInvite(DB, { jobId, action: 'cancelled', guests: guestCount(), demoDate: row.demo_date });
        return { jobId, action: 'cancelled', reason: plan.reason };
      }
      const note = `kept: ${plan.reason}`;
      if (row.last_action !== note) {
        await writeRow(DB, { ...row, last_action: note, error: null });
        await logInvite(DB, { jobId, action: note, guests: guestCount(), demoDate: row.demo_date });
        await alertDemo(env, inviteConfig, 'held', { jobId, name, reason: plan.reason, taskId }).catch(() => {});
      }
      return { jobId, action: 'held', reason: plan.reason };
    } catch (err) {
      return failed(err);
    }
  }

  // Kept as "<facts>:<event>": an invite that is out changes when its facts
  // do (date, time, address, guests). New wording alone waits for that, or
  // for an admin's rewrite, so a reworded sentence never emails every family.
  const factsHash = await hashOf({ ...plan.facts, guests: plan.guests });
  const eventHash = await hashOf(plan.event);
  const out = sent ? row : null;
  const [oldFacts, oldEvent] = String(out?.hash || '').split(':');
  if (out && verify && live && !force) {
    try {
      const gone = await handCancelled();
      if (gone) return gone;
    } catch (err) {
      return failed(err);
    }
  }
  if (out && oldFacts === factsHash && (!rewrite || oldEvent === eventHash)) {
    // Held, and JobTread is back to normal (reopened, status back): clear the note
    if (!dryRun && /^kept: /.test(out.last_action || '')) await DB.prepare('UPDATE demo_invites SET last_action = ? WHERE job_id = ?').bind('back on in JobTread', jobId).run();
    return { jobId, action: 'unchanged', eventId: plan.event.id };
  }
  if (!live) return { jobId, action: out ? 'would-update' : 'would-create', event: plan.event, guests: plan.guests };

  // Only staff joined or left? Update quietly: Workspace calendars sync on
  // their own, and the family isn't emailed about a guest list it can't see.
  let sendUpdates = 'all';
  if (out?.guests) {
    const before = JSON.parse(out.guests);
    const sameFacts = (await hashOf({ ...plan.facts, guests: before })) === oldFacts;
    const reworded = rewrite && (await hashOf({ ...plan.event, attendees: before.map((email) => ({ email })) })) !== oldEvent;
    const changed = [...plan.guests.filter((g) => !before.includes(g)), ...before.filter((g) => !plan.guests.includes(g))];
    if (sameFacts && !reworded && changed.every((g) => g.endsWith(STAFF_DOMAIN) || EMAIL_ALIASES[g])) sendUpdates = 'none';
  }

  try {
    // Never write over an invite someone deleted by hand: that would send it again
    if (out && !force) {
      const gone = await handCancelled();
      if (gone) return gone;
    }
    const token = await accessToken(env, organizer, { fetchImpl, now });
    // The first send: someone may already have invited people by hand
    if (!out && !sandbox && !force) {
      const mine = await findSentByHand(token, organizer, { date: plan.date, name: plan.name, jobName: job.name }, { fetchImpl });
      if (mine) {
        const when = mine.start?.date || easternParts(mine.start?.dateTime || '')?.date || '';
        await writeRow(DB, { job_id: jobId, state: 'by-hand', demo_date: plan.date, last_action: `${SENT_BY_HAND}: "${String(mine.summary || '').slice(0, 120)}"${when && when !== plan.date ? ` on ${when}` : ''}` });
        await logInvite(DB, { jobId, action: SENT_BY_HAND, demoDate: plan.date });
        return { jobId, action: 'by-hand', found: mine.summary || null };
      }
    }
    const { created } = await upsertEvent(token, organizer, plan.event, { fetchImpl, sendUpdates });
    const action = created ? 'created' : sendUpdates === 'none' ? 'updated quietly' : 'updated';
    await writeRow(DB, {
      job_id: jobId, event_id: plan.event.id, state: 'sent', hash: `${factsHash}:${eventHash}`, demo_date: plan.date,
      guests: JSON.stringify(plan.guests), last_action: sendUpdates === 'none' ? 'updated quietly (staff guest list only)' : action, error: null,
    });
    await logInvite(DB, { jobId, action, guests: plan.guests.length, demoDate: plan.date });
    if (row?.error) {
      const summary = `${name ? `${name}'s demo day invite` : 'The demo day invite'} went out after all (${action}).`;
      await slackResolved(env, `demo-invite:${jobId}`, slackCard({ icon: '✅', title: `Demo day invite fixed${name ? `: ${name}` : ''}`, lead: summary }), { summary }).catch(() => null);
    }
    return { jobId, action, eventId: plan.event.id, guests: plan.guests.length };
  } catch (err) {
    return failed(err);
  }
}

// ─── Telling staff ───────────────────

const scheduleUrl = (jobId, taskId) => `https://app.jobtread.com/jobs/${jobId}/schedule${taskId ? `?taskId=${taskId}` : ''}`;

/**
 * What staff are told: 'problem' (it couldn't be sent), 'held' (JobTread says
 * demo day may be off) or 'waiting' (Set Start Date is done but there's no
 * Demo date). The words for Slack, and the email.
 */
export function demoAlert(kind, { jobId, name, error, reason, taskId }) {
  const who = name ? `${name}'s` : 'A';
  let title, detail, fix;
  if (kind === 'waiting') {
    title = `${who} demo day invite is waiting`;
    detail = `Set Start Date is checked off in JobTread, but ${reason}, so there's no day to invite people to yet.`;
    fix = 'Give the Demo task its date in JobTread. The invite goes out within a few minutes.';
  } else if (kind === 'held') {
    title = `${who} demo day invite is still out`;
    detail = `JobTread says: ${reason}. The calendar invite hasn't been cancelled; the site never cancels one on its own.`;
    fix = 'If demo day is off, delete the event in the organizer\'s Google Calendar and choose to email the guests. If it\'s still on, there is nothing to do.';
  } else {
    title = `Demo day invite problem${name ? `: ${name}` : ''}`;
    detail = `The demo day invite for ${name || `job ${jobId}`} couldn't be sent. Google or JobTread said: ${error}`;
    fix = /unauthorized_client|GOOGLE_CALENDAR_KEY|sign-in/i.test(error || '')
      ? 'The Google key or its domain-wide delegation needs attention (Cloudflare GOOGLE_CALENDAR_KEY, Workspace Admin → Domain-wide delegation).'
      : 'Open Demo Day in the admin and press Retry on this job. If it keeps failing, check the job in JobTread.';
  }
  const schedule = scheduleUrl(jobId, taskId);
  return {
    title, detail, fix,
    subject: `[SOARD] ${title}`,
    html: `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(detail)}</p><p>${kind === 'problem' ? '<strong>Fix:</strong> ' : ''}${escapeHtml(fix)}</p><p><a href="${ADMIN_URL}">Open Demo Day in the admin</a></p><p><a href="${schedule}">Open the schedule in JobTread</a></p>`,
    text: `${title}\n\n${detail}\n\n${kind === 'problem' ? 'Fix: ' : ''}${fix}\n\nAdmin: ${ADMIN_URL}\nJobTread schedule: ${schedule}`,
  };
}

async function alertDemo(env, inviteConfig, kind, info) {
  const to = alertList(env, inviteConfig);
  const { title, detail, fix, subject, html, text } = demoAlert(kind, info);
  const card = slackCard({
    icon: kind === 'problem' ? '⚠️' : '📅', title, lead: detail, fix,
    buttons: [{ label: 'Open Demo Day', url: ADMIN_URL }, { label: 'JobTread schedule', url: scheduleUrl(info.jobId, info.taskId) }],
    footer: 'Demo day calendar invites',
  });
  await Promise.allSettled([
    // A problem threads under the first one for the job, and a good send turns it ✅
    kind === 'problem' ? slackIssue(env, `demo-invite:${info.jobId}`, card, { title }) : slackPost(env, card),
    emailConfigured(env) && to.length ? sendEmails(env, { to, subject, html, text, tags: [{ name: 'category', value: 'demo-invite-alert' }] }) : null,
  ]);
}

// ─── Checks, the admin, tests ───────────────────

/** Open jobs whose demo day is ahead and that are due an invite (or have one out), plus invites out on jobs since closed */
async function dueJobs(env, { fetchImpl, now, onlyTest = false }) {
  const { DB } = env;
  const today = todayEastern(now);
  const [jobs, rowsRes] = await Promise.all([
    openJobs(env.JOBTREAD_GRANT_KEY, fetchImpl),
    DB.prepare('SELECT job_id, state, demo_date, last_action FROM demo_invites').all(),
  ]);
  const rows = rowsRes.results || [];
  // Sent by hand, or deleted in Google Calendar: left alone, so not re-read either
  const leftAlone = new Set(rows.filter((r) => r.state === 'by-hand' || (r.state === 'cancelled' && r.last_action === BY_HAND)).map((r) => r.job_id));
  // Out and still ahead: followed even once the job closes (staff hear it's still out)
  const out = rows.filter((r) => r.state === 'sent' && r.demo_date >= today).map((r) => r.job_id);
  const ids = new Set(out);
  for (const job of jobs) {
    const { demo, startSet } = demoTasks(job);
    // Due: Set Start Date checked off and the Demo date ahead (or none yet: staff are told)
    if (startSet && (!demo?.startDate || (demo.startDate >= today && (demo.progress ?? 0) < 1))) ids.add(job.id);
  }
  // While sending is off, only rehearsals: jobs named "TEST …" (they reach only the test guests)
  const tests = new Set(jobs.filter(isTestJob).map((j) => j.id));
  return [...ids].filter((id) => id !== SANDBOX_JOB_ID && !leftAlone.has(id) && (!onlyTest || tests.has(id)));
}

/**
 * Every 5 minutes at most (the heartbeat, admin loads): re-read the open jobs
 * whose demo day is ahead, so a Demo task that moved, a sponsor set, or a
 * wake-up JobTread never sent reaches the calendar. The slot is claimed with
 * one conditional write, so overlapping wake-ups run it once. Never throws.
 */
export async function maybeCheckDemos(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const { DB } = env;
    if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(DB);
    const { enabled } = await readConfig(DB);
    const next = String(now + CHECK_EVERY_MS);
    const at = new Date(now).toISOString();
    const ins = await DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(CHECK_KEY, next, at).run();
    if (!(ins?.meta?.changes > 0)) {
      const upd = await DB.prepare('UPDATE site_config SET data = ?, updated_at = ? WHERE key = ? AND CAST(data AS INTEGER) <= ?').bind(next, at, CHECK_KEY, now).run();
      if (!(upd?.meta?.changes > 0)) return null;
    }
    // Off: TEST jobs only, so a rehearsal can run end to end before sending is turned on
    return await checkAll(env, { fetchImpl, now, verify: true, onlyTest: !enabled });
  } catch {
    return null;
  }
}

/** Reconcile every job that's due (the 5-minute check, and the admin after a list or wording change) */
export async function checkAll(env, { fetchImpl = fetch, now = Date.now(), verify = false, rewrite = false, onlyTest = false } = {}) {
  const ids = await dueJobs(env, { fetchImpl, now, onlyTest });
  if (!ids.length) return [];
  const [staff, kids, people] = await Promise.all([
    fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    loadKids(env.DB).catch(() => []),
    listPeople(env.DB),
  ]);
  const out = [];
  for (const id of ids) {
    // One job JobTread can't read doesn't hold up the rest
    out.push(await reconcileDemo(env, id, { fetchImpl, now, verify, rewrite, wait: false, preloaded: { staff, kids, people } })
      .catch((err) => ({ jobId: id, action: 'error', error: err.message })));
  }
  return out;
}

/** Someone was added to or taken off a list: invites already out follow now. Never throws. */
export async function refreshOpen(env) {
  try {
    if (!env.JOBTREAD_GRANT_KEY || !(await readConfig(env.DB)).enabled) return null;
    return await checkAll(env);
  } catch { return null; }
}

/**
 * Admin test: this job's invite as it would go out, sent only to `testEmail`
 * as a separate TEST event, so nobody else is involved. `sample`: a made-up
 * job to use instead of reading JobTread (Emails & invites → Send it to me).
 */
export async function sendTestDemo(env, jobId, testEmail, { cancel = false, sample = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const [config, inviteConfig] = await Promise.all([readConfig(DB), readInviteConfig(DB)]);
  const organizer = inviteConfig.organizer || DEFAULT_ORGANIZER;
  const token = await accessToken(env, organizer, { fetchImpl, now });
  const eventId = eventIdFor('soarddemotest', jobId);
  if (cancel) {
    await cancelEvent(token, organizer, eventId, { fetchImpl });
    return { action: 'cancelled', eventId };
  }
  const [job, staff, kids, people] = await Promise.all([
    sample || fetchDemoJob(env.JOBTREAD_GRANT_KEY, jobId, fetchImpl),
    fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    loadKids(DB).catch(() => []),
    listPeople(DB),
  ]);
  // As it will go out, even before Set Start Date is checked off
  const plan = planDemo(job, staff, { kids, people, organizer, now, config, sent: true });
  if (plan.action !== 'upsert') return { action: 'skip', reason: plan.reason };
  const event = {
    ...plan.event,
    id: eventId,
    summary: `TEST · ${plan.event.summary}`,
    description: `Test of the demo day invite. Only you received it; the real one goes to: ${plan.guests.join(', ') || '(no guests yet)'}\n\n${plan.event.description}`,
    attendees: [{ email: testEmail }],
  };
  const { created } = await upsertEvent(token, organizer, event, { fetchImpl });
  return { action: created ? 'created' : 'updated', eventId, wouldInvite: plan.guests };
}

/**
 * For the admin: every open job whose demo day is ahead, with the exact
 * invite it gets (or would get), guests named, and what its invite has done.
 */
export async function listDemos(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const grantKey = env.JOBTREAD_GRANT_KEY;
  const [config, inviteConfig, jobs, staff, kids, people, rowsRes] = await Promise.all([
    readConfig(DB), readInviteConfig(DB),
    openJobs(grantKey, fetchImpl),
    fetchStaff(grantKey, fetchImpl),
    loadKids(DB).catch(() => []),
    listPeople(DB),
    DB.prepare('SELECT * FROM demo_invites').all(),
  ]);
  const organizer = inviteConfig.organizer || DEFAULT_ORGANIZER;
  const rows = Object.fromEntries((rowsRes.results || []).map((r) => [r.job_id, r]));
  const today = todayEastern(now);
  const ahead = jobs.filter((j) => {
    if (j.id === SANDBOX_JOB_ID) return false;
    const { demo, startSet } = demoTasks(j);
    return demo?.startDate ? demo.startDate >= today && (demo.progress ?? 0) < 1 : startSet && !rows[j.id]?.event_id;
  });
  const full = await Promise.all(ahead.map((j) => fetchDemoJob(grantKey, j.id, fetchImpl).catch(() => null)));
  const ids = ahead.map((j) => j.id);
  const logRes = ids.length
    ? await DB.prepare(`SELECT job_id, action, guests, demo_date, created_at FROM demo_invite_log WHERE job_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`).bind(...ids).all()
    : { results: [] };
  const logs = {};
  for (const l of logRes.results || []) (logs[l.job_id] ||= []).push({ action: l.action, guests: l.guests, date: l.demo_date, at: l.created_at });

  // Google, for an invite sent by hand (shown before sending is on) and for everyone's answers
  let token = null;
  const google = async () => (token ||= await accessToken(env, organizer, { fetchImpl, now }));
  const findHand = async (job, plan) => {
    try { return await findSentByHand(await google(), organizer, { date: plan.date, name: plan.name, jobName: job.name }, { fetchImpl }); } catch { return null; }
  };
  const staffNames = Object.fromEntries(staff.map((x) => [x.email, { name: x.name }]));
  const demos = [];
  for (const [i, brief] of ahead.entries()) {
    const job = full[i];
    if (!job) continue;
    const { demo, startSet } = demoTasks(job);
    const values = fieldValues(job.customFieldValues?.nodes);
    const who = displayName(job, kids);
    const test = job.id === SANDBOX_JOB_ID || isTestJob(job);
    // As it will go out, even before Set Start Date is checked off
    const plan = planDemo(job, staff, { kids, people, organizer, now, config, sent: true, onlyGuests: test ? (inviteConfig.testGuests || DEFAULT_TEST_GUESTS) : null });
    const row = rows[job.id];
    const sponsor = String(values[FIELD_MONETARY_SPONSOR] || '').trim() || null;
    const canLook = !!env.GOOGLE_CALENDAR_KEY && plan.action === 'upsert';
    // An invite sent by hand: before ours would go (shown before sending is on), or already found
    const handEvent = canLook && !test && ((!row?.state && startSet) || row?.state === 'by-hand') ? await findHand(job, plan) : null;
    const byHand = handEvent && !row?.state ? { title: String(handEvent.summary || '').slice(0, 120), date: handEvent.start?.date || easternParts(handEvent.start?.dateTime || '')?.date || null } : null;
    // Who's coming, from Google: on our invite once it's out, or on the one sent by hand
    let answers = null;
    if (canLook && row?.state === 'sent' && row.event_id) {
      const ev = await google().then((t) => getEvent(t, organizer, row.event_id, { fetchImpl })).catch(() => null);
      if (ev) answers = { from: 'ours', ...answersOf(ev.attendees, { ...staffNames, ...plan.people }) };
    } else if (handEvent) {
      answers = { from: 'by-hand', ...answersOf(handEvent.attendees, { ...staffNames, ...plan.people }) };
    }
    demos.push({
      jobId: job.id,
      jobName: job.name,
      name: who.name,
      slug: who.slug,
      ...(test ? { test: true } : {}),
      jobUrl: `https://app.jobtread.com/jobs/${job.id}`,
      scheduleUrl: scheduleUrl(job.id, demo?.id),
      date: demo?.startDate || null,
      time: hhmm(demo?.startTime),
      startSet,
      space: values[FIELD_MAKEOVER_TYPE] || null,
      sponsor,
      // Who from the sponsor is on the job in JobTread (the Sponsor role), named; [] flags a sponsor with nobody on it
      sponsorOnJob: guestGroups(job, [], []).confirmed.filter((p) => p.kind === 'sponsor').map((p) => p.name || p.email),
      status: values[FIELD_STATUS] || null,
      // On hold in JobTread (closed, denied, awaiting funding); a missing Demo date shows as its own state
      hold: plan.action === 'hold' && !plan.waiting && demo?.startDate ? plan.reason : null,
      preview: plan.action === 'upsert' ? {
        title: plan.event.summary,
        start: plan.event.start,
        end: plan.event.end,
        location: plan.event.location || null,
        description: plan.event.description,
        guests: plan.guests.map((email) => ({ email, ...plan.people[email] })),
      } : null,
      invite: row ? {
        state: row.state, lastAction: row.last_action, error: row.error, updatedAt: row.updated_at,
        guests: row.guests ? JSON.parse(row.guests).length : 0,
        log: logs[job.id] || [],
      } : null,
      ...(byHand ? { handSent: byHand } : {}),
      ...(answers ? { answers } : {}),
    });
  }
  demos.sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
  return {
    organizer,
    organizerName: staff.find((s) => s.email === organizer)?.name || null,
    staff: staff.filter((s) => s.email !== organizer).map(({ name, email }) => ({ name, email })),
    people,
    demos,
  };
}

/**
 * Guests' answers on a Google event, by name: { yes, no, maybe, waiting }.
 * The organizer and rooms aren't guests. `known` names people by email.
 */
export function answersOf(attendees, known = {}) {
  const out = { yes: [], no: [], maybe: [], waiting: [] };
  for (const a of attendees || []) {
    if (a.organizer || a.self || a.resource) continue;
    const email = normEmail(a.email);
    const name = known[email]?.name || a.displayName || a.email;
    out[{ accepted: 'yes', declined: 'no', tentative: 'maybe' }[a.responseStatus] || 'waiting'].push(name);
  }
  return out;
}

/** For Site → Automations: the switch, the last 5-minute check, and counts only (never names or emails) */
export async function demoFacts(DB) {
  await ensureSchema(DB);
  const [config, check, rows, last] = await Promise.all([
    readConfig(DB),
    DB.prepare('SELECT updated_at FROM site_config WHERE key = ?').bind(CHECK_KEY).first('updated_at'),
    DB.prepare("SELECT SUM(state = 'sent') AS sent, SUM(state = 'by-hand') AS byHand, SUM(error IS NOT NULL) AS errors FROM demo_invites").first(),
    DB.prepare("SELECT MAX(created_at) AS at FROM demo_invite_log WHERE action = 'created'").first('at'),
  ]);
  return { enabled: !!config.enabled, lastCheckAt: check || null, sent: rows?.sent || 0, byHand: rows?.byHand || 0, errors: rows?.errors || 0, lastSentAt: last || null };
}
