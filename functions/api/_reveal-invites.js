/**
 * Reveal calendar invites for staff and the makeover family
 * ===========================================================================
 * One Google Calendar event per JobTread job, on the organizer's calendar
 * (Clareece by default), so the invite comes from her and Google handles
 * updates and cancellations.
 *
 *   Construction started          → "Max's Reveal Day (tentative)": all day,
 *   (Demo done, or 2 tasks under    shown as free, so a date that may move
 *   Construction done)              blocks no one
 *   Reveal task moves             → the same event moves; guests get an update
 *   Reveal Date Confirmed = Yes   → the same event becomes "Max's Reveal Day":
 *                                   timed once the task has a time (then busy)
 * Both carry the full address.
 * The site never cancels an invite. Calling a reveal off is done by hand:
 * someone deletes the event in Google Calendar (Google emails the guests), and
 * the site then leaves it alone for good (an admin's Retry sends it again).
 * Un-checking a task changes nothing once the invite is out; a job closed,
 * denied or awaiting funding, or a Reveal task with no date, keeps its invite
 * as it is, and staff get one email in case the reveal is off. TEST jobs are
 * the exception: closing one clears its event, which only test guests have.
 * A reveal that has happened is never touched again: its day is past, its
 * start time today has passed (all day: the whole day counts), or its Reveal
 * task is marked complete.
 *
 * Guests, in two stages (the organizer is never a guest):
 *   Tentative  staff (internal Admin and Designer users), the family (the job's
 *              customer contacts with an email, and Makeover Family users given
 *              access to the job) and the board: the website's board members
 *              with a private reveal email (People → Board) and any JobTread
 *              Board Member users
 *   Confirmed  the same event, plus everyone else given access to the job in
 *              JobTread for the room itself (Vendor, Sponsor, Photographer and
 *              Design Partner users). Un-confirming takes them back off.
 * Both invites carry the kid's page, the link to watch live and who to ask.
 * An invite that is out changes only when its facts do (date, time, address,
 * confirmation, the JobTread notes, or who's invited). New wording waits for
 * that, unless an admin pushes it to every invite already out.
 * A person's JobTread role decides their stage, so a sponsor who is also a
 * contact on the family's account still waits for the confirmed invite.
 *
 * Triggered by SOARD JobTread workflows posting { jobId } to
 * /api/reveal-invites. The post is only a wake-up call: everything is
 * re-read from JobTread with JOBTREAD_GRANT_KEY, so a forged post can only
 * make the calendar match what JobTread already says. A wake-up counts only
 * for a change JobTread logged on that job (verifiedJobEvent), so junk is
 * never counted against the limits. Each job then takes a few wake-ups a
 * minute (admitWake); one past that (or past the site-wide limit), or one that
 * finds the invite busy, leaves the job owed a look, which the next heartbeat
 * gives it (runOwedWakes), so a burst of task check-offs can't hold an
 * invite's lock or spend JobTread's request budget, and no change is lost.
 * JobTread has no workflow trigger for job access, so every 5 minutes the
 * guest check (maybeCheckGuests) re-reads each reveal with an invite out: a
 * vendor given access after the invite went out is added within minutes.
 *
 * Sending is off until enabled from /api/reveal-invites-admin (site_config
 * "reveal-invites"). While off, each wake-up records what it would have done.
 */

import { JT_URL, SOARD_ORG_ID, FIELD_REVEAL_CONFIRMED, todayEastern, easternParts, matchProject, isProject, parseJobName, loadKidsAndProjects } from './_reveals.js';
import { accessToken, eventIdFor, upsertEvent, cancelEvent, getEvent } from './_google-calendar.js';
import { sendEmails, slackPost, slackIssue, slackResolved, emailConfigured } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { personStatus, personName } from './_team.js';
import { limit } from './_rate-limit.js';
import { syncKidStatuses } from './_kid-status.js';
import { LEVEL_ROLES, TRADE_ROLE } from './_partner-roles.js';

export const REVEAL_TASK_TYPE = '22NZSbkR5rZw';
export const FIELD_STATUS = '22P52qfFub9b';
export const FIELD_INVITE_DETAILS = '22PgGhdabNcJ';
export const FIELD_CONTACT_EMAIL = '22NJw43QvHeJ';
export const FIELD_MAKEOVER_TYPE = '22P3SQTcgurh'; // Bedroom, Bathroom, Therapy Room, Ramp
export const DEFAULT_ORGANIZER = 'ccunningham@soardcharity.com';

/**
 * Whose calendar an invite may come from. The site acts as the organizer
 * through Google domain-wide delegation, so this is a short list rather than
 * anyone at soardcharity.com: the default organizer, plus any in
 * REVEAL_INVITE_ORGANIZERS (comma-separated, soardcharity.com addresses only).
 */
export function allowedOrganizers(env) {
  const list = [DEFAULT_ORGANIZER, ...String(env?.REVEAL_INVITE_ORGANIZERS || '').split(',')];
  return [...new Set(list.map(e => e.trim().toLowerCase()).filter(e => /^[^\s@]+@soardcharity\.com$/.test(e)))];
}

// The internal office job is a sandbox: both JobTread workflows skip it, so only
// deliberate tests reach it. Its invites always send (even with sending off), go
// only to the test guests, and are marked TEST.
export const SANDBOX_JOB_ID = '22P3HTX9cXn4';
export const DEFAULT_TEST_GUESTS = ['peter@soardcharity.com'];
// Any job named "TEST …" is a sandbox too, for end-to-end rehearsals the
// workflows don't skip: name it after a kid ("TEST Isla Example (2026)") and its
// invites, live countdown and reminders all run for real, but invites and
// reminders reach only the test guests and the countdown never shows publicly.
export const isTestJob = (job) => /^\s*TEST\b/.test(String(job?.name || ''));
export const isSandboxJob = (job) => job?.id === SANDBOX_JOB_ID || isTestJob(job);

// Construction has started once Demo is done or two tasks under the Construction
// group are. By then the reveal date is real. Read as counts, not task lists,
// so the job query stays small.
export const CONSTRUCTION_GROUP = 'Construction';
const CONSTRUCTION_STARTED_AT = 2;
export const CONSTRUCTION_PROGRESS = {
  constructionDone: { _: 'tasks', $: { where: { and: [[['parentTask', 'name'], '=', CONSTRUCTION_GROUP], ['isGroup', '=', false], ['progress', '=', 1]] } }, count: {} },
  demoDone: { _: 'tasks', $: { where: { and: [['name', '=', 'Demo'], ['isGroup', '=', false], ['progress', '=', 1]] } }, count: {} },
};
export const constructionStarted = (job) => (job?.demoDone?.count || 0) > 0 || (job?.constructionDone?.count || 0) >= CONSTRUCTION_STARTED_AT;

/**
 * The kid's real job for a rehearsal: "TEST Isla Example (2026)" → the one
 * other open job of the same year whose name holds every word after TEST.
 * Null when there isn't exactly one.
 */
export function realJobFor(testJob, jobs) {
  const { year, tokens } = parseJobName(String(testJob?.name || '').replace(/^\s*TEST\b/, ''));
  if (!year || !tokens.size) return null;
  const hits = (jobs || []).filter((j) => {
    if (j.id === testJob.id || isSandboxJob(j)) return false;
    const p = parseJobName(j.name);
    return p.year === year && [...tokens].every((t) => p.tokens.has(t));
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A rehearsal job sits on the office account, so its own address is the
 * office. Its invite borrows the address from the kid's real job instead, so
 * the rehearsal shows what the family's invite will. `openJobs` (id, name,
 * location.address) saves a read when the caller has them. Never throws:
 * without a match the job keeps its own address.
 */
export async function borrowRealAddress(grantKey, job, fetchImpl, openJobs = null) {
  if (!isTestJob(job)) return;
  try {
    const jobs = openJobs || (await pave(grantKey, {
      organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, where: ['closedOn', '=', null] }, nodes: { id: {}, name: {}, location: { address: {} } } } },
    }, fetchImpl))?.organization?.jobs?.nodes;
    const address = realJobFor(job, jobs)?.location?.address;
    if (address) job.location = { ...job.location, address };
  } catch { /* keep the job's own address */ }
}

/** Who gets sandbox and rehearsal emails (Reveals → Invites test guests) */
export async function testGuests(DB) {
  const row = await DB.prepare("SELECT data FROM site_config WHERE key = 'reveal-invites'").first();
  let data = {};
  try { data = row ? JSON.parse(row.data) : {}; } catch { /* default */ }
  const list = Array.isArray(data.testGuests) && data.testGuests.length ? data.testGuests : DEFAULT_TEST_GUESTS;
  return list.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || ''));
}
const STAFF_ROLES = new Set(['Admin', 'Designer']);
const FAMILY_ROLE = 'Makeover Family';
// People given access to the job who join once the reveal is confirmed, by JobTread role: partners
// by their level (./_partner-roles.js), trade partners, and the roles from before levels
const CONFIRMED_ROLES = {
  ...Object.fromEntries(LEVEL_ROLES.map((r) => [r, 'partner'])), [TRADE_ROLE]: 'trade partner',
  Vendor: 'vendor', 'Monetary Sponsor': 'sponsor', Sponsor: 'sponsor', Photographer: 'photographer', 'Design Partner': 'design partner',
};
const BOARD_ROLE = 'Board Member';
export const BOARD_ROLE_ID = '22PgGdtxTATR';
// Logins with staff roles that aren't people: the Qualification Committee and the DATAx integration
export const NOT_STAFF = new Set(['selection@soardcharity.com', 'hello@contractorcto.com']);
// JobTread logins that aren't where that person wants reveal invites
export const EMAIL_ALIASES = { 'peter@ranneyblair.com': 'peter@soardcharity.com' };
export const STAFF_DOMAIN = '@soardcharity.com';
export const INACTIVE_STATUSES = new Set(['Denied', 'Awaiting Funding']);
const SITE = 'https://sunshineonaranneyday.com';
// How an invite deleted by hand in Google Calendar is recorded (last_action and the log)
export const BY_HAND = 'cancelled in Google Calendar';
/** The job's schedule in JobTread, opened on the Reveal task when we know it */
export const scheduleUrl = (jobId, taskId) => `https://app.jobtread.com/jobs/${jobId}/schedule${taskId ? `?taskId=${taskId}` : ''}`;
const ADMIN_URL = `${SITE}/admin/#broadcast`; // Reveals → Now, where each reveal's Retry is
const CONFIG_KEY = 'reveal-invites';
const TZ = 'America/New_York';
// Problems email these people plus the organizer (and ALERT_EMAILS, Slack if set)
const DEFAULT_ALERT_EMAILS = ['peter@soardcharity.com'];
// The safety sweep re-checks every open job at most this often, in case a
// JobTread webhook was ever missed
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
// The guest check re-reads every reveal with an invite out at most this often:
// JobTread has no webhook for someone given access to a job (a new vendor) or a
// family contact's email, so this is how they reach an invite already sent
const GUEST_CHECK_EVERY_MS = 5 * 60 * 1000;
const GUEST_CHECK_KEY = 'reveal-invites-guest-check';
// A crashed update frees its job's lock after this; a JobTread wake-up waits up
// to LOCK_TRIES × LOCK_RETRY_MS for its turn
const LOCK_MS = 60 * 1000;
const LOCK_TRIES = 8;
const LOCK_RETRY_MS = 2500;
// Verified JobTread wake-ups: a few a minute per job (one change can fire two
// workflows) and WAKE_ALL a minute across every job; past either, the job is
// owed one look after the minute is out.
const WAKE_PER_JOB = 3;
const WAKE_ALL = 120;
const WAKE_WINDOW_S = 60;
const OWED_PER_RUN = 10;
// A wake-up counts only for a change JobTread logged this recently (a little clock skew allowed)
const EVENT_FRESH_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reveal_invites (
    job_id TEXT PRIMARY KEY, event_id TEXT, state TEXT, hash TEXT, reveal_date TEXT,
    guests TEXT, last_action TEXT, error TEXT, updated_at TEXT)`,
  // Every invite that went out (sent, updated, cancelled), for the admin's per-reveal tracker
  `CREATE TABLE IF NOT EXISTS reveal_invite_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, action TEXT, state TEXT,
    guests INTEGER, reveal_date TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_reveal_invite_log_job ON reveal_invite_log(job_id)`,
  // Board members' reveal emails, by their website slug. Its own table on purpose:
  // site content and site_config are committed to GitHub and written into builds.
  `CREATE TABLE IF NOT EXISTS reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)`,
  // One update per invite at a time (see lockJob); a row holds its expiry in ms
  `CREATE TABLE IF NOT EXISTS reveal_invite_locks (job_id TEXT PRIMARY KEY, until INTEGER NOT NULL)`,
  // Jobs owed a look after a wake-up was turned away (see admitWake); due is in ms
  `CREATE TABLE IF NOT EXISTS reveal_invite_owed (job_id TEXT PRIMARY KEY, due INTEGER NOT NULL)`,
];
const _schemaReady = new WeakSet();
export async function ensureSchema(DB) {
  if (_schemaReady.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _schemaReady.add(DB);
}

/**
 * Invite wording, editable in admin (Reveals → Invites). Placeholders:
 * {name} kid's first name, {space} what was built ("bathroom", from the job's
 * Makeover Type; "room" when it's blank), {date} "Tuesday, October 27",
 * {time} "4:00 PM" (or "time to come"), {when} the date with the time when
 * there is one.
 * The reveal's own notes (JobTread "Reveal Invite Details"), the kid's page,
 * the link to watch live and who to ask are added under the message.
 * The title leads with the name so a month view or phone widget shows whose
 * reveal it is, and the message leads with the date so a phone shows it first.
 */
export const DEFAULT_TEMPLATE = {
  tentativeTitle: "{name}'s Reveal Day (tentative)",
  tentativeMessage: "Save the date: {name}'s {space} reveal is penciled in for {date}.\n\nIt's the moment {name} sees the new {space} for the first time.\n\nIf the build schedule shifts, this invite moves with it. The time comes once the date is confirmed, so there's no need to reply until then.",
  confirmedTitle: "{name}'s Reveal Day",
  confirmedMessage: "{name}'s {space} reveal is confirmed for {when}.\n\nIt's the moment {name} sees the new {space} for the first time. Please accept or decline so we know who to expect.",
};
export const TEMPLATE_LIMITS = { tentativeTitle: 150, confirmedTitle: 150, tentativeMessage: 2000, confirmedMessage: 2000 };
// Earlier defaults. Admin saves all four fields, so a saved field still word for
// word an old default was never chosen by anyone: it follows today's default.
const RETIRED_DEFAULTS = {
  tentativeTitle: ["Tentative: {name}'s Reveal Day"],
  tentativeMessage: [
    "This is a tentative date for {name}'s reveal while the build wraps up.\nThis invite updates automatically if the date moves, and the time is added once the reveal is confirmed.",
    "Save the date: {name}'s {space} reveal is penciled in for {date}.\n\nIt's the moment {name} sees the new {space} for the first time.\n\nIf the build schedule shifts, this invite moves with it. The time and address come once the date is confirmed, so there's no need to reply until then.",
  ],
  confirmedMessage: [
    "{name}'s reveal is confirmed for {when}.",
    "{name}'s {space} reveal is confirmed for {when}.\n\nIt's the moment {name} sees the new {space} for the first time. Please reply so we know who to expect.",
  ],
};

export async function readConfig(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(CONFIG_KEY).first();
  let data = {};
  try { data = row ? JSON.parse(row.data) : {}; } catch { /* default */ }
  const saved = Object.fromEntries(Object.entries(data.template || {}).filter(([k, v]) => !RETIRED_DEFAULTS[k]?.includes(v)));
  return { enabled: false, organizer: DEFAULT_ORGANIZER, ...data, template: { ...DEFAULT_TEMPLATE, ...saved } };
}

function clock(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Fill {name} {space} {date} {time} {when}; unknown placeholders are left as typed */
export function renderTemplate(text, { name, space, date, time }) {
  const day = longDate(date);
  const values = { name, space: String(space || '').trim().toLowerCase() || 'room', date: day, time: time ? clock(time) : 'time to come', when: time ? `${day} at ${clock(time)}` : `${day} (time to come)` };
  return String(text || '').replace(/\{(name|space|date|time|when)\}/g, (_, k) => values[k]);
}

export async function writeConfig(DB, patch) {
  const next = { ...(await readConfig(DB)), ...patch };
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(CONFIG_KEY, JSON.stringify(next), new Date().toISOString()).run();
  return next;
}

export async function pave(grantKey, query, fetchImpl) {
  const res = await fetchImpl(JT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { $: { grantKey }, ...query } }),
  });
  if (!res.ok) throw new Error(`JobTread returned ${res.status}`);
  return res.json();
}

export async function fetchJob(grantKey, jobId, fetchImpl = fetch) {
  const cf = { nodes: { value: {}, customField: { id: {} } } };
  const body = await pave(grantKey, {
    job: {
      $: { id: jobId },
      id: {}, name: {}, closedOn: {},
      organization: { id: {} },
      location: { address: {}, account: { contacts: { $: { size: 50 }, nodes: { name: {}, customFieldValues: cf } } } },
      customFieldValues: { $: { size: 50 }, ...cf },
      tasks: {
        $: { size: 100, where: [['taskType', 'id'], '=', REVEAL_TASK_TYPE] },
        nodes: { id: {}, name: {}, startDate: {}, startTime: {}, endDate: {}, endTime: {}, progress: {}, taskType: { id: {} } },
      },
      aces: JOB_ACCESS,
      ...CONSTRUCTION_PROGRESS,
    },
  }, fetchImpl);
  const job = body?.job || null;
  await borrowRealAddress(grantKey, job, fetchImpl);
  return job;
}

/** Who has been given access to a job in JobTread (family, vendors, sponsors…), for the guest list */
export const JOB_ACCESS = { $: { size: 50 }, nodes: { membership: { isInternal: {}, role: { name: {} }, account: { name: {} }, user: { name: {}, emailAddress: {} } } } };

export const normEmail = (e) => {
  const x = String(e || '').trim().toLowerCase();
  return EMAIL_ALIASES[x] || x;
};
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

/**
 * The website's board (People → Board) with each member's private reveal email:
 * [{ slug, name, title, email, memorial, active }]. Only active members are
 * invited: alumni and memorial entries are listed but never invited.
 * group 'advisory': the Advisory Board (People → Advisory), kept and invited
 * the same way.
 */
export async function boardRoster(DB, group = 'board') {
  await ensureSchema(DB);
  let rows = [];
  try { rows = (await DB.prepare('SELECT slug, data FROM team').all()).results || []; } catch { return []; }
  const emails = Object.fromEntries(((await DB.prepare('SELECT slug, email FROM reveal_board_emails').all()).results || []).map((r) => [r.slug, r.email]));
  const out = [];
  for (const row of rows) {
    let d = {};
    try { d = JSON.parse(row.data || '{}'); } catch { continue; }
    if (d.group !== group) continue;
    const status = personStatus(d);
    out.push({ slug: row.slug, name: personName(d), title: d.title || '', order: Number(d.order) || 0, email: emails[row.slug] || null, memorial: status === 'memorial', active: status === 'active' });
  }
  return out.sort((a, b) => a.order - b.order || String(a.name).localeCompare(String(b.name)));
}

/** Save (or clear, with an empty email) a board member's private reveal email */
export async function setBoardEmail(DB, slug, email) {
  await ensureSchema(DB);
  const e = normEmail(email);
  if (!e) return DB.prepare('DELETE FROM reveal_board_emails WHERE slug = ?').bind(slug).run();
  if (!isEmail(e)) throw new Error('That email doesn\'t look right');
  return DB.prepare('INSERT OR REPLACE INTO reveal_board_emails (slug, email, updated_at) VALUES (?, ?, ?)').bind(slug, e, new Date().toISOString()).run();
}

/**
 * The board, for every invite: the website's active board and Advisory Board
 * members with a private reveal email, plus anyone with the Board Member role
 * in JobTread. Alumni and memorial entries never. Never throws.
 */
export async function fetchBoard(env, fetchImpl = fetch) {
  const out = [];
  for (const group of ['board', 'advisory']) {
    try {
      for (const m of await boardRoster(env.DB, group)) {
        if (m.active && isEmail(m.email)) out.push({ name: m.name, email: m.email, from: 'website', ...(group === 'advisory' ? { advisory: true } : {}) });
      }
    } catch { /* no website board */ }
  }
  if (env.JOBTREAD_GRANT_KEY) {
    try {
      const body = await pave(env.JOBTREAD_GRANT_KEY, {
        organization: { $: { id: SOARD_ORG_ID }, memberships: { $: { size: 100, where: [['role', 'id'], '=', BOARD_ROLE_ID] }, nodes: { user: { name: {}, emailAddress: {} } } } },
      }, fetchImpl);
      for (const m of body?.organization?.memberships?.nodes || []) {
        const email = normEmail(m.user?.emailAddress);
        if (isEmail(email)) out.push({ name: m.user.name, email, from: 'jobtread' });
      }
    } catch { /* JobTread unreachable: the website's board still counts */ }
  }
  return out;
}

/**
 * The guest list by stage: family, staff and the board from the tentative
 * invite on; the people given access to the job for the room itself once
 * confirmed. Each person appears once, in the first group they belong to.
 */
export function guestGroups(job, staff = [], board = []) {
  const access = (job?.aces?.nodes || []).map((a) => a.membership).filter((m) => m && !m.isInternal && m.user?.emailAddress);
  const person = (m, kind) => ({ email: normEmail(m.user.emailAddress), name: m.user.name, kind, ...(m.account?.name ? { company: m.account.name } : {}), ...(m.role?.name ? { role: m.role.name } : {}) });
  const partners = access.filter((m) => CONFIRMED_ROLES[m.role?.name]).map((m) => person(m, CONFIRMED_ROLES[m.role.name]));
  const later = new Set(partners.map((p) => p.email));
  const contacts = (job?.location?.account?.contacts?.nodes || [])
    .map((c) => ({ email: normEmail(fieldValues(c.customFieldValues?.nodes)[FIELD_CONTACT_EMAIL]), name: c.name, kind: 'family' }));
  const familyUsers = access.filter((m) => m.role?.name === FAMILY_ROLE).map((m) => person(m, 'family'));
  return {
    family: [...contacts, ...familyUsers].filter((p) => isEmail(p.email) && !later.has(p.email)),
    staff: staff.map((p) => ({ ...p, kind: 'staff' })),
    // Advisors ride with the board; their kind names them in the admin's preview
    board: [...board, ...access.filter((m) => m.role?.name === BOARD_ROLE).map((m) => person(m, 'board'))].map(({ advisory, ...p }) => ({ ...p, kind: advisory ? 'advisory board' : 'board' })),
    confirmed: partners,
  };
}

export async function fetchStaff(grantKey, fetchImpl = fetch) {
  const body = await pave(grantKey, {
    organization: {
      $: { id: SOARD_ORG_ID },
      // Staff only: families and vendors are members too (138 and growing), and a page of
      // everyone would push staff added later past its end, silently off every invite
      memberships: { $: { size: 100, where: ['isInternal', '=', true] }, nodes: { isInternal: {}, role: { name: {} }, user: { name: {}, emailAddress: {} } } },
    },
  }, fetchImpl);
  return (body?.organization?.memberships?.nodes || [])
    .filter(m => m.isInternal && STAFF_ROLES.has(m.role?.name) && m.user?.emailAddress)
    .map(m => {
      const email = m.user.emailAddress.trim().toLowerCase();
      return { name: m.user.name, email: EMAIL_ALIASES[email] || email };
    })
    .filter(s => !NOT_STAFF.has(s.email));
}

export const fieldValues = (nodes) => Object.fromEntries((nodes || []).map(v => [v.customField?.id, v.value]));
export const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

function addHour(time) {
  const [h, m] = time.split(':').map(Number);
  return `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function nextDay(date) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
function longDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The name for the title: the matched kid's site name, an organization's
 * community project name ("The Lionheart School"), else the job name's first
 * word. slug: the kid's (their live page); url: their public page, if any.
 * `kids` may hold community projects too (loadKidsAndProjects).
 */
export function displayName(job, kids) {
  const hit = matchProject(job.name, kids, job.id);
  if (isProject(hit)) return { name: hit.name, slug: null, url: hit.page || null };
  if (hit) return { name: hit.name, slug: hit.slug, url: `/kids/${hit.slug}/` };
  const base = String(job.name || '').replace(/\(\d{4}\)\s*$/, '').trim();
  // A kid's job starts with their first name; "The …" is an organization's whole name
  return { name: (/^the\s/i.test(base) ? base : base.split(/\s+/)[0]) || 'The', slug: null, url: null };
}

/**
 * The reveal is over or under way, so its invite is left as it is: the day is
 * past, today's start time has passed (an all-day reveal counts all day), or
 * the Reveal task is marked complete. Comparing dates alone let a job closed
 * the afternoon of a morning reveal cancel the invite for a reveal that had
 * already happened.
 */
export function revealHappened(reveal, now = Date.now()) {
  if (!reveal?.startDate) return false;
  if (reveal.progress === 1) return true;
  const nowParts = easternParts(new Date(now).toISOString());
  if (reveal.startDate !== nowParts.date) return reveal.startDate < nowParts.date;
  const start = hhmm(reveal.startTime);
  return !start || start <= (nowParts.time || '00:00');
}

/**
 * What the calendar should look like for this job:
 * { action: 'upsert', event, guests } | { action: 'hold', reason } | { action: 'skip', reason }
 * 'hold': leave an invite that's out as it is. `sent`: this job's invite is out.
 */
export function planInvite(job, staff, { kids = [], board = [], organizer = DEFAULT_ORGANIZER, now = Date.now(), onlyGuests = null, template = DEFAULT_TEMPLATE, sent = false } = {}) {
  if (!job) return { action: 'skip', reason: 'job not found' };
  // Strict: a job that doesn't say it's SOARD's (organization missing) never gets an invite
  if (job.organization?.id !== SOARD_ORG_ID) return { action: 'skip', reason: 'not a SOARD job' };

  const tasks = job.tasks?.nodes || [];
  const reveals = tasks.filter(t => t.taskType?.id === REVEAL_TASK_TYPE);
  const reveal = reveals.find(t => (t.progress ?? 0) < 1) || reveals[0];
  if (revealHappened(reveal, now)) return { action: 'skip', reason: 'the reveal has already happened' };

  const values = fieldValues(job.customFieldValues?.nodes);
  if (job.closedOn) return { action: 'hold', reason: 'job closed' };
  if (INACTIVE_STATUSES.has(values[FIELD_STATUS])) return { action: 'hold', reason: `status is ${values[FIELD_STATUS]}` };
  if (!reveal?.startDate) return { action: 'hold', reason: 'no Reveal task date' };

  const confirmed = String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes');
  // Construction starting sends the first invite. Once it's out it follows the
  // reveal, so a task un-checked by mistake never takes it back.
  if (!confirmed && !sent && !constructionStarted(job)) return { action: 'skip', reason: 'construction not started yet' };

  const who = displayName(job, kids);
  const date = reveal.startDate;
  // Until it's confirmed the date is a save-the-date: no time, even when the task has one
  const start = confirmed ? hhmm(reveal.startTime) : null;
  const end = start ? (hhmm(reveal.endTime) && hhmm(reveal.endTime) > start && (reveal.endDate || date) === date ? hhmm(reveal.endTime) : addHour(start)) : null;

  const address = job.location?.address || null;
  const t = { ...DEFAULT_TEMPLATE, ...template };
  const fill = (text) => renderTemplate(text, { name: who.name, space: values[FIELD_MAKEOVER_TYPE], date, time: start });
  const lines = [fill(confirmed ? t.confirmedMessage : t.tentativeMessage).trim()];
  const details = String(values[FIELD_INVITE_DETAILS] || '').trim();
  if (details) lines.push('', details);
  // Labeled links as plain text, which reads the same in Gmail, Apple Calendar
  // and Outlook (HTML descriptions arrive as raw tags in some). The kid's live
  // page; before the kid is on the site, /live/ (it follows the current reveal).
  lines.push('');
  if (who.url) lines.push(`Meet ${who.name}: ${SITE}${who.url}`);
  lines.push(`Watch live from anywhere: ${SITE}/live/${who.slug ? `${who.slug}/` : ''}`);
  // Who to ask, by name when the organizer is on the staff list, and who it's from
  const host = (staff || []).find((s) => s.email === organizer)?.name;
  lines.push('', `Questions? Email ${host ? `${host} at ` : ''}${organizer}.`, 'Sunshine on a Ranney Day');

  const guests = [];
  const people = {}; // email → { name, kind } for the admin's preview
  const seen = new Set([organizer.toLowerCase(), ...NOT_STAFF]);
  const add = (p) => {
    const e = String(p.email || '').trim().toLowerCase();
    if (!isEmail(e) || seen.has(e)) return false;
    seen.add(e);
    guests.push(e);
    people[e] = { name: p.name || null, kind: p.kind };
    return true;
  };
  // Who the confirmed invite adds, for a tentative one's preview
  let addsOnConfirm = [];
  if (onlyGuests) {
    onlyGuests.forEach((email) => add({ email, kind: 'test' }));
  } else {
    const g = guestGroups(job, staff, board);
    g.family.forEach(add);
    g.staff.forEach(add);
    g.board.forEach(add);
    if (confirmed) g.confirmed.forEach(add);
    else {
      const later = new Set();
      addsOnConfirm = g.confirmed
        .filter((p) => isEmail(p.email) && !seen.has(p.email) && !later.has(p.email) && later.add(p.email))
        .map(({ email, name, kind }) => ({ email, name, kind }));
    }
  }

  const event = {
    id: eventIdFor('soardreveal', job.id),
    summary: fill(confirmed ? t.confirmedTitle : t.tentativeTitle).trim() || `${who.name}'s Reveal Day`,
    status: confirmed ? 'confirmed' : 'tentative',
    location: address || undefined,
    description: lines.join('\n'),
    start: start ? { dateTime: `${date}T${start}:00`, timeZone: TZ } : { date },
    end: start ? { dateTime: `${date}T${end}:00`, timeZone: TZ } : { date: nextDay(date) },
    attendees: guests.map(email => ({ email })),
    guestsCanSeeOtherGuests: false,
    guestsCanInviteOthers: false,
    // Free until there's a confirmed time, so a date that may move blocks no one's day
    transparency: start ? 'opaque' : 'transparent',
  };
  // What guests act on. Guests are emailed when these change, not the wording.
  const facts = { date, start, end, confirmed, address, details };
  return { action: 'upsert', event, guests, people, addsOnConfirm, confirmed, date, facts };
}

/** Does an event on the calendar already say what the plan says (guests aside)? */
function hasFacts(ev, plan) {
  const same = (a, b) => (b.date ? a?.date === b.date : String(a?.dateTime || '').slice(0, 16) === b.dateTime.slice(0, 16));
  const { start, end, status } = plan.event;
  return ev.status === status && same(ev.start, start) && same(ev.end, end)
    && (ev.location || null) === plan.facts.address
    && (!plan.facts.details || String(ev.description || '').includes(plan.facts.details));
}

export async function hashOf(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function readRow(DB, jobId) {
  return DB.prepare('SELECT * FROM reveal_invites WHERE job_id = ?').bind(jobId).first();
}

async function writeRow(DB, row) {
  await DB.prepare(`INSERT OR REPLACE INTO reveal_invites (job_id, event_id, state, hash, reveal_date, guests, last_action, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.job_id, row.event_id ?? null, row.state ?? null, row.hash ?? null, row.reveal_date ?? null,
      row.guests ?? null, row.last_action ?? null, row.error ?? null, new Date().toISOString()).run();
}

async function logInvite(DB, { jobId, action, state, guests, revealDate }) {
  await DB.prepare('INSERT INTO reveal_invite_log (job_id, action, state, guests, reveal_date, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(jobId, action, state ?? null, guests ?? null, revealDate ?? null, new Date().toISOString()).run().catch(() => {});
}

/**
 * Tell people when an invite can't be sent: email the alert list and the
 * organizer, plus Slack when configured. Only called for a new problem, so a
 * stuck job doesn't email on every JobTread change.
 */
export const alertList = (env, config) => [...new Set([
  ...(config.alertEmails || DEFAULT_ALERT_EMAILS), config.organizer,
  ...String(env.ALERT_EMAILS || '').split(',').map(s => s.trim()),
].filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '')))];

/**
 * What staff are told about an invite: 'problem' (it couldn't be updated) or
 * 'held' (JobTread says the reveal may be off). The words for Slack, and the email.
 */
export function inviteAlert(kind, { jobId, name, error, reason, taskId }) {
  if (kind === 'held') {
    const who = name ? `${name}'s` : 'A';
    const title = `${who} reveal invite is still out`;
    const detail = `JobTread says: ${reason}. The calendar invite hasn't been cancelled; the site never cancels one on its own.`;
    const fix = 'If the reveal is off, delete the event in the organizer\'s Google Calendar and choose to email the guests. If the reveal is still on, there is nothing to do.';
    return {
      title, detail, fix,
      subject: `[SOARD] ${title}`,
      html: `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(detail)}</p><p>${escapeHtml(fix)}</p><p><a href="${ADMIN_URL}">Open Reveals in the admin</a></p><p><a href="${scheduleUrl(jobId, taskId)}">Open the schedule in JobTread</a></p>`,
      text: `${title}\n\n${detail}\n\n${fix}\n\nAdmin: ${ADMIN_URL}\nJobTread schedule: ${scheduleUrl(jobId, taskId)}`,
    };
  }
  const title = `Reveal invite problem${name ? `: ${name}` : ''}`;
  const detail = `The calendar invite for ${name || `job ${jobId}`} couldn't be updated. Google or JobTread said: ${error}`;
  const fix = /unauthorized_client|GOOGLE_CALENDAR_KEY|sign-in/i.test(error)
    ? 'The Google key or its domain-wide delegation needs attention (Cloudflare GOOGLE_CALENDAR_KEY, Workspace Admin → Domain-wide delegation).'
    : 'Open Reveals in the admin, open this reveal under Upcoming reveals and press Retry. If it keeps failing, check the job in JobTread.';
  return {
    title, detail, fix,
    subject: `[SOARD] ${title}`,
    html: `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(detail)}</p><p><strong>Fix:</strong> ${escapeHtml(fix)}</p><p><a href="${ADMIN_URL}">Open Reveals in the admin</a></p><p><a href="${scheduleUrl(jobId, taskId)}">Open the schedule in JobTread</a></p>`,
    text: `${title}\n\n${detail}\n\nFix: ${fix}\n\nAdmin: ${ADMIN_URL}\nJobTread schedule: ${scheduleUrl(jobId, taskId)}`,
  };
}

async function alertProblem(env, config, { jobId, name, error, taskId }) {
  const to = alertList(env, config);
  const { title, detail, fix, subject, html, text } = inviteAlert('problem', { jobId, name, error, taskId });
  await Promise.allSettled([
    // One thread per job: a new problem replies under the first, and a good sync turns it ✅
    slackIssue(env, `invite:${jobId}`, slackCard({
      icon: '⚠️', title, lead: detail, fix,
      buttons: [{ label: 'Open Reveals', url: ADMIN_URL }, { label: 'JobTread schedule', url: scheduleUrl(jobId, taskId) }],
      footer: 'Reveal calendar invites',
    }), { title }),
    emailConfigured(env) && to.length ? sendEmails(env, {
      to, subject, html, text,
      tags: [{ name: 'category', value: 'reveal-invite-alert' }],
    }) : null,
  ]);
}

/**
 * The site never cancels an invite, so when JobTread says a reveal may be off
 * (job closed, denied, awaiting funding, no Reveal date) staff hear it once:
 * the invite is still on everyone's calendar until someone deletes it.
 */
async function alertHeld(env, config, { jobId, name, reason, taskId }) {
  const to = alertList(env, config);
  const { title, detail, fix, subject, html, text } = inviteAlert('held', { jobId, name, reason, taskId });
  await Promise.allSettled([
    slackPost(env, slackCard({
      icon: '📅', title, lead: detail, fix,
      buttons: [{ label: 'Open Reveals', url: ADMIN_URL }, { label: 'JobTread schedule', url: scheduleUrl(jobId, taskId) }],
      footer: 'Reveal calendar invites',
    })),
    emailConfigured(env) && to.length ? sendEmails(env, {
      to, subject, html, text,
      tags: [{ name: 'category', value: 'reveal-invite-alert' }],
    }) : null,
  ]);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * One update per invite at a time. Two at once (a JobTread wake-up during the
 * guest check, or Confirmed and the notes changed together) would each see the
 * old invite and each email every guest. A row holding its expiry is the lock,
 * so a crashed update frees it within LOCK_MS. `wait`: a JobTread wake-up waits
 * its turn (it may carry the newer change, and re-reads JobTread once it has
 * the lock); the checks just skip a busy job and catch it next time.
 */
export async function lockJob(DB, jobId, wait) {
  for (let i = 0; i < (wait ? LOCK_TRIES : 1); i++) {
    if (i) await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    const t = Date.now();
    const ins = await DB.prepare('INSERT OR IGNORE INTO reveal_invite_locks (job_id, until) VALUES (?, ?)').bind(jobId, t + LOCK_MS).run();
    if (ins?.meta?.changes > 0) return true;
    const upd = await DB.prepare('UPDATE reveal_invite_locks SET until = ? WHERE job_id = ? AND until < ?').bind(t + LOCK_MS, jobId, t).run();
    if (upd?.meta?.changes > 0) return true;
  }
  return false;
}

export const unlockJob = (DB, jobId) => DB.prepare('DELETE FROM reveal_invite_locks WHERE job_id = ?').bind(jobId).run().catch(() => {});

/**
 * Make the calendar match JobTread for one job. Sends nothing unless the
 * invite is enabled (or `force` is set by an admin), and nothing when the
 * event already matches. Returns what happened; { action: 'busy' } when
 * another update to the same invite holds the lock.
 */
export async function reconcileJob(env, jobId, opts = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  if (!env.JOBTREAD_GRANT_KEY) return { jobId, action: 'skip', reason: 'JOBTREAD_GRANT_KEY is not set' };
  if (opts.dryRun) return reconcileLocked(env, jobId, opts);
  if (!(await lockJob(DB, jobId, opts.wait ?? true))) return { jobId, action: 'busy', reason: 'another update to this invite is running' };
  try {
    return await reconcileLocked(env, jobId, opts);
  } finally {
    await unlockJob(DB, jobId);
  }
}

async function reconcileLocked(env, jobId, { fetchImpl = fetch, now = Date.now(), force = false, rewrite = false, dryRun = false, verify = false, preloaded = null } = {}) {
  const { DB } = env;
  const config = await readConfig(DB);

  const [job, staff, kids, board] = await Promise.all([
    fetchJob(env.JOBTREAD_GRANT_KEY, jobId, fetchImpl),
    preloaded?.staff || fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    preloaded?.kids || loadKidsAndProjects(DB).catch(() => []),
    preloaded?.board || fetchBoard(env, fetchImpl),
  ]);
  const failed = async (row, err) => {
    await writeRow(DB, { ...(row || { job_id: jobId }), error: err.message });
    const revealTask = (job?.tasks?.nodes || []).filter(t => t.taskType?.id === REVEAL_TASK_TYPE).find(t => (t.progress ?? 0) < 1);
    if (err.message !== row?.error) await alertProblem(env, config, { jobId, name: job ? displayName(job, kids).name : null, error: err.message, taskId: revealTask?.id }).catch(() => {});
    return { jobId, action: 'error', error: err.message };
  };
  const sandbox = jobId === SANDBOX_JOB_ID || isTestJob(job);
  const row = await readRow(DB, jobId);
  // The invite is out: sent, and not deleted in Google Calendar since
  const sent = !!(row?.event_id && row.state !== 'cancelled');
  const plan = planInvite(job, staff, { kids, board, organizer: config.organizer, now, onlyGuests: sandbox ? (config.testGuests || DEFAULT_TEST_GUESTS) : null, template: config.template, sent });
  if (sandbox && plan.event) plan.event.summary = `TEST · ${plan.event.summary}`;
  const live = !dryRun && (config.enabled || force || sandbox);
  const guestCount = () => (row?.guests ? JSON.parse(row.guests).length : null);

  if (plan.action === 'skip') return { jobId, action: 'skip', reason: plan.reason };

  // Deleted by hand in Google Calendar: never sent again, unless an admin presses Retry
  if (row?.state === 'cancelled' && row.last_action === BY_HAND && !force) return { jobId, action: 'skip', reason: BY_HAND };

  // Calling a reveal off is done by deleting its event in Google Calendar. Once
  // that's happened the invite is only recorded as cancelled, never written to:
  // an update would put it back on every guest's calendar.
  const handCancelled = async () => {
    const token = await accessToken(env, config.organizer, { fetchImpl, now });
    const onCalendar = await getEvent(token, config.organizer, row.event_id, { fetchImpl });
    if (onCalendar && onCalendar.status !== 'cancelled') return null;
    await writeRow(DB, { ...row, state: 'cancelled', last_action: BY_HAND, error: null });
    await logInvite(DB, { jobId, action: BY_HAND, state: 'cancelled', guests: guestCount(), revealDate: row.reveal_date });
    return { jobId, action: 'skip', reason: BY_HAND };
  };

  // JobTread says the reveal may be off. The invite stays as it is (cancelling
  // is done by hand) and staff are told once. A TEST job clears its own event.
  if (plan.action === 'hold') {
    if (!sent) return { jobId, action: 'skip', reason: plan.reason };
    if (!live) return { jobId, action: 'would-hold', reason: plan.reason };
    try {
      if (verify && !force) {
        const gone = await handCancelled();
        if (gone) return gone;
      }
      if (sandbox) {
        const token = await accessToken(env, config.organizer, { fetchImpl, now });
        await cancelEvent(token, config.organizer, row.event_id, { fetchImpl });
        await writeRow(DB, { ...row, state: 'cancelled', hash: null, last_action: `cancelled: ${plan.reason}`, error: null });
        await logInvite(DB, { jobId, action: 'cancelled', state: 'cancelled', guests: guestCount(), revealDate: row.reveal_date });
        return { jobId, action: 'cancelled', reason: plan.reason };
      }
      const note = `kept: ${plan.reason}`;
      if (row.last_action !== note) {
        await writeRow(DB, { ...row, last_action: note, error: null });
        await logInvite(DB, { jobId, action: note, state: row.state, guests: guestCount(), revealDate: row.reveal_date });
        const revealTask = (job?.tasks?.nodes || []).filter(t => t.taskType?.id === REVEAL_TASK_TYPE).find(t => (t.progress ?? 0) < 1);
        await alertHeld(env, config, { jobId, name: job ? displayName(job, kids).name : null, reason: plan.reason, taskId: revealTask?.id }).catch(() => {});
      }
      return { jobId, action: 'held', reason: plan.reason };
    } catch (err) {
      return failed(row, err);
    }
  }

  // Kept as "<facts>:<event>". An invite that is out changes when its facts do
  // (date, time, address, confirmation, notes, guests). New wording alone waits
  // for that, or for an admin's rewrite, so a reworded sentence never emails
  // every family.
  const factsHash = await hashOf({ ...plan.facts, guests: plan.guests });
  const eventHash = await hashOf(plan.event);
  const hash = `${factsHash}:${eventHash}`;
  const out = row?.hash && row.state !== 'cancelled' ? row : null;
  let [oldFacts, oldEvent] = String(out?.hash || '').split(':');
  // Sent before invites kept their facts (one hash for the whole event): the
  // event on the calendar shows what guests have. When it already has what
  // JobTread says now, it's taken as it is (new wording reaches it like any
  // other invite); when it doesn't, guests get the update.
  if (out && !out.hash.includes(':') && live) {
    try {
      const token = await accessToken(env, config.organizer, { fetchImpl, now });
      const sent = await getEvent(token, config.organizer, plan.event.id, { fetchImpl });
      if (sent && hasFacts(sent, plan)) {
        oldEvent = out.hash;
        oldFacts = await hashOf({ ...plan.facts, guests: JSON.parse(out.guests || '[]') });
      }
    } catch (err) {
      return failed(row, err);
    }
  }
  // The sweep also looks for an invite deleted by hand, so the admin shows it
  if (out && verify && live && !force) {
    try {
      const gone = await handCancelled();
      if (gone) return gone;
    } catch (err) {
      return failed(row, err);
    }
  }
  if (out && oldFacts === factsHash && (!rewrite || oldEvent === eventHash)) {
    if (!dryRun && out.hash !== `${oldFacts}:${oldEvent}`) await DB.prepare('UPDATE reveal_invites SET hash = ? WHERE job_id = ?').bind(`${oldFacts}:${oldEvent}`, jobId).run();
    // Held, and JobTread is back to normal (reopened, status back, date back): clear the note
    if (!dryRun && /^kept: /.test(out.last_action || '')) await DB.prepare('UPDATE reveal_invites SET last_action = ? WHERE job_id = ?').bind('back on in JobTread', jobId).run();
    return { jobId, action: 'unchanged', eventId: plan.event.id };
  }
  if (!live) return { jobId, action: row ? 'would-update' : 'would-create', event: plan.event };

  // Only the staff on the guest list changed (someone joined, left, or changed
  // address)? Update quietly: Workspace calendars sync on their own, and the
  // family isn't emailed about a guest list they can't see.
  let sendUpdates = 'all';
  if (out?.guests) {
    const before = JSON.parse(out.guests);
    const sameFacts = (await hashOf({ ...plan.facts, guests: before })) === oldFacts;
    const reworded = rewrite && (await hashOf({ ...plan.event, attendees: before.map(email => ({ email })) })) !== oldEvent;
    const added = plan.guests.filter(g => !before.includes(g));
    const removed = before.filter(g => !plan.guests.includes(g));
    if (sameFacts && !reworded && [...added, ...removed].every(g => g.endsWith(STAFF_DOMAIN) || EMAIL_ALIASES[g])) sendUpdates = 'none';
  }

  try {
    // Never write over an invite someone deleted by hand: that would send it again
    if (out && !force) {
      const gone = await handCancelled();
      if (gone) return gone;
    }
    const token = await accessToken(env, config.organizer, { fetchImpl, now });
    const { created } = await upsertEvent(token, config.organizer, plan.event, { fetchImpl, sendUpdates });
    const action = created ? 'created' : sendUpdates === 'none' ? 'updated quietly' : 'updated';
    await writeRow(DB, {
      job_id: jobId, event_id: plan.event.id, state: plan.event.status, hash, reveal_date: plan.date,
      guests: JSON.stringify(plan.guests), last_action: sendUpdates === 'none' ? 'updated quietly (staff guest list only)' : action, error: null,
    });
    await logInvite(DB, { jobId, action, state: plan.event.status, guests: plan.guests.length, revealDate: plan.date });
    if (row?.error) {
      const who = displayName(job, kids).name;
      const summary = `${who ? `${who}'s invite` : 'The invite'} went out after all (${action}).`;
      await slackResolved(env, `invite:${jobId}`, slackCard({ icon: '✅', title: `Invite fixed${who ? `: ${who}` : ''}`, lead: summary }), { summary }).catch(() => null);
    }
    return { jobId, action, eventId: plan.event.id, status: plan.event.status, guests: plan.guests.length };
  } catch (err) {
    return failed(row, err);
  }
}

/** This job gets a look once the current minute is out (the earliest note stands) */
export async function oweWake(DB, jobId, now = Date.now()) {
  await ensureSchema(DB);
  await DB.prepare('INSERT OR IGNORE INTO reveal_invite_owed (job_id, due) VALUES (?, ?)').bind(jobId, now + WAKE_WINDOW_S * 1000).run();
}

/**
 * Is `eventId` a change JobTread logged on this SOARD job in the last 15
 * minutes? Every invite workflow sends its event's id (a task moved, checked
 * off or deleted, or the job's own fields). Throws when JobTread can't be read.
 */
export async function verifiedJobEvent(grantKey, { jobId, eventId }, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9]{6,32}$/.test(String(eventId || ''))) return false;
  const ev = (await pave(grantKey, {
    event: { $: { id: eventId }, id: {}, createdAt: {}, organization: { id: {} }, job: { _on_job: { id: {} } } },
  }, fetchImpl))?.event;
  const t = Date.parse(ev?.createdAt || '');
  return !!ev && ev.organization?.id === SOARD_ORG_ID && ev.job?.id === jobId && t > now - EVENT_FRESH_MS && t <= now + CLOCK_SKEW_MS;
}

/**
 * May this verified wake-up for `jobId` do its work now? 'run', or 'later':
 * the job has had its few this minute, or every job together has had
 * WAKE_ALL, so it's owed a look on the next heartbeat instead. Only call it
 * for a change that checked out (verifiedJobEvent): junk mustn't use up
 * either limit and crowd out a real change.
 */
export async function admitWake(DB, jobId, { now = Date.now() } = {}) {
  await ensureSchema(DB);
  const job = await limit(DB, `reveal-invites:job:${jobId}`, WAKE_PER_JOB, WAKE_WINDOW_S, { now });
  if (job.ok && (await limit(DB, 'reveal-invites:all', WAKE_ALL, WAKE_WINDOW_S, { now })).ok) return 'run';
  await oweWake(DB, jobId, now);
  return 'later';
}

/**
 * The looks owed from turned-away or busy wake-ups, once due: the kid's
 * status and the invite, exactly what the wake-up would have done (both
 * re-read JobTread). A few per run; each claimed with one conditional delete,
 * so overlapping heartbeats don't double up. Never throws.
 */
export async function runOwedWakes(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const { DB } = env;
    if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(DB);
    const { results } = await DB.prepare('SELECT job_id, due FROM reveal_invite_owed WHERE due <= ? ORDER BY due LIMIT ?').bind(now, OWED_PER_RUN).all();
    const out = [];
    for (const { job_id, due } of results || []) {
      const mine = await DB.prepare('DELETE FROM reveal_invite_owed WHERE job_id = ? AND due = ?').bind(job_id, due).run();
      if (!(mine?.meta?.changes > 0)) continue;
      await syncKidStatuses(env, { jobId: job_id, fetchImpl, now });
      const r = await reconcileJob(env, job_id, { fetchImpl, now, wait: false })
        .catch((err) => ({ jobId: job_id, action: 'error', error: err.message }));
      if (r.action === 'busy') await oweWake(DB, job_id, now);
      out.push(r);
    }
    return out;
  } catch {
    return null;
  }
}

/** Every open SOARD job, reconciled one at a time (go-live catch-up and the safety sweep) */
export async function reconcileAll(env, { fetchImpl = fetch, now = Date.now(), dryRun = false, rewrite = false, verify = false } = {}) {
  const [body, staff, kids, board] = await Promise.all([
    pave(env.JOBTREAD_GRANT_KEY, {
      organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, where: ['closedOn', '=', null] }, nodes: { id: {} } } },
    }, fetchImpl),
    fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    loadKidsAndProjects(env.DB).catch(() => []),
    fetchBoard(env, fetchImpl),
  ]);
  const results = [];
  for (const { id } of body?.organization?.jobs?.nodes || []) {
    if (id === SANDBOX_JOB_ID) continue;
    results.push(await reconcileJob(env, id, { fetchImpl, now, dryRun, rewrite, verify, wait: false, preloaded: { staff, kids, board } }));
  }
  return results;
}

/**
 * Safety sweep, piggybacked on public traffic (called from /api/reveals with
 * waitUntil): at most every SWEEP_EVERY_MS, re-check every open job so a
 * missed JobTread webhook is caught within hours. Claims the slot before
 * running so overlapping requests don't double up. Never throws.
 */
export async function maybeSweep(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(env.DB);
    const config = await readConfig(env.DB);
    if (!config.enabled) return null;
    if (now - Date.parse(config.lastSweep?.at || 0) < SWEEP_EVERY_MS) return null;
    await writeConfig(env.DB, { lastSweep: { ...(config.lastSweep || {}), at: new Date(now).toISOString(), running: true } });
    const results = await reconcileAll(env, { fetchImpl, now, verify: true });
    const changed = results.filter(r => ['created', 'updated', 'updated quietly', 'cancelled'].includes(r.action)).length;
    const errors = results.filter(r => r.action === 'error').length;
    const summary = { at: new Date(now).toISOString(), checked: results.length, changed, errors };
    await writeConfig(env.DB, { lastSweep: summary });
    return summary;
  } catch {
    return null;
  }
}

/**
 * Guest check, between sweeps (called from the hub heartbeat, /api/reveals and
 * admin loads): at most every GUEST_CHECK_EVERY_MS, re-read each upcoming reveal
 * whose invite is out, so a vendor given access to a confirmed reveal's job (or
 * a family contact added) gets the invite within minutes. An invite that hasn't
 * changed is left alone. The slot is claimed with one conditional write (its
 * row holds when the next check is due), so overlapping wake-ups run it once.
 * Every call first gives owed wake-ups their look (runOwedWakes). Never throws.
 */
export async function maybeCheckGuests(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const { DB } = env;
    if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(DB);
    // Wake-ups turned away earlier get their look first (kid status too, so even with sending off)
    await runOwedWakes(env, { fetchImpl, now });
    if (!(await readConfig(DB)).enabled) return null;
    const next = String(now + GUEST_CHECK_EVERY_MS);
    const at = new Date(now).toISOString();
    const ins = await DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(GUEST_CHECK_KEY, next, at).run();
    if (!(ins?.meta?.changes > 0)) {
      const upd = await DB.prepare('UPDATE site_config SET data = ?, updated_at = ? WHERE key = ? AND CAST(data AS INTEGER) <= ?').bind(next, at, GUEST_CHECK_KEY, now).run();
      if (!(upd?.meta?.changes > 0)) return null;
    }
    const { results } = await DB.prepare("SELECT job_id FROM reveal_invites WHERE state IN ('tentative', 'confirmed') AND reveal_date >= ? AND job_id != ?")
      .bind(todayEastern(now), SANDBOX_JOB_ID).all();
    if (!results?.length) return [];
    const [staff, kids, board] = await Promise.all([
      fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
      loadKidsAndProjects(DB).catch(() => []),
      fetchBoard(env, fetchImpl),
    ]);
    const out = [];
    for (const { job_id } of results) {
      // One job JobTread can't read doesn't hold up the rest
      out.push(await reconcileJob(env, job_id, { fetchImpl, now, wait: false, preloaded: { staff, kids, board } })
        .catch((err) => ({ jobId: job_id, action: 'error', error: err.message })));
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Admin test: the same invite the job would get, sent only to `testEmail`,
 * as a separate "TEST" event so nobody else is involved. `date`/`time`
 * override the Reveal task to try a move.
 */
export async function sendTestInvite(env, jobId, testEmail, { date, time, stage = null, cancel = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const config = await readConfig(DB);
  const token = await accessToken(env, config.organizer, { fetchImpl, now });
  const eventId = eventIdFor('soardrevealtest', jobId);
  if (cancel) {
    await cancelEvent(token, config.organizer, eventId, { fetchImpl });
    return { action: 'cancelled', eventId };
  }
  const [job, staff, kids] = await Promise.all([
    fetchJob(env.JOBTREAD_GRANT_KEY, jobId, fetchImpl),
    fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    loadKidsAndProjects(DB).catch(() => []),
  ]);
  if (job && (date || time !== undefined)) {
    for (const t of job.tasks?.nodes || []) {
      if (t.taskType?.id !== REVEAL_TASK_TYPE) continue;
      if (date) { t.startDate = date; t.endDate = date; }
      if (time !== undefined) { t.startTime = time || null; t.endTime = null; }
    }
  }
  // Pretend construction has started so the test always produces an invite
  if (job) job.demoDone = { count: 1 };
  // The confirmed (or tentative) version of this reveal, whatever JobTread says today
  if (job && stage) {
    const others = (job.customFieldValues?.nodes || []).filter(v => v.customField?.id !== FIELD_REVEAL_CONFIRMED);
    job.customFieldValues = { nodes: stage === 'confirmed' ? [...others, { value: 'Yes', customField: { id: FIELD_REVEAL_CONFIRMED } }] : others };
  }
  const plan = planInvite(job, staff, { kids, organizer: config.organizer, now, template: config.template });
  if (plan.action !== 'upsert') return { action: 'skip', reason: plan.reason };
  const event = {
    ...plan.event,
    id: eventId,
    summary: `TEST · ${plan.event.summary}`,
    description: `Test invite from the reveal invite system. Only you received it; the real one would go to: ${plan.guests.join(', ') || '(no guests yet)'}\n\n${plan.event.description}`,
    attendees: [{ email: testEmail }],
  };
  const { created } = await upsertEvent(token, config.organizer, event, { fetchImpl });
  return { action: created ? 'created' : 'updated', eventId, wouldInvite: plan.guests, event };
}

/**
 * Upcoming reveals for the admin Invites page: every open job with a Reveal
 * date from today on, its notes, what its invite has done so far, and the
 * exact invite it would send now (title, when, where, message, guests by name).
 */
export async function listUpcoming(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const cf = { $: { size: 50 }, nodes: { value: {}, customField: { id: {} } } };
  // JobTread refuses (413) a query whose worst case is too big: page size times
  // every nested list. So open jobs come 25 at a time without their contacts,
  // and contacts are read below for upcoming reveals only.
  async function openJobs() {
    const jobs = [];
    let page = null;
    for (let i = 0; i < 10; i++) {
      const body = await pave(env.JOBTREAD_GRANT_KEY, {
        organization: {
          $: { id: SOARD_ORG_ID },
          jobs: {
            $: { size: 25, where: ['closedOn', '=', null], ...(page ? { page } : {}) },
            nextPage: {},
            nodes: {
              id: {}, name: {}, closedOn: {}, organization: { id: {} },
              location: { address: {} },
              customFieldValues: cf,
              tasks: {
                $: { size: 20, where: [['taskType', 'id'], '=', REVEAL_TASK_TYPE] },
                nodes: { id: {}, name: {}, startDate: {}, startTime: {}, endDate: {}, endTime: {}, progress: {}, taskType: { id: {} } },
              },
            },
          },
        },
      }, fetchImpl);
      jobs.push(...(body?.organization?.jobs?.nodes || []));
      page = body?.organization?.jobs?.nextPage || null;
      if (!page) break;
    }
    return jobs;
  }
  const config = await readConfig(DB);
  const [jobs, staff, kids, rowsRes, board] = await Promise.all([
    openJobs(),
    fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    loadKidsAndProjects(DB).catch(() => []),
    DB.prepare('SELECT * FROM reveal_invites').all(),
    fetchBoard(env, fetchImpl),
  ]);
  const rows = Object.fromEntries((rowsRes.results || []).map(r => [r.job_id, r]));
  const staffNames = Object.fromEntries(staff.map(s => [s.email, s.name]));
  const today = todayEastern(now);
  const upcoming = [];
  for (const job of jobs) {
    if (job.id === SANDBOX_JOB_ID) continue;
    const tasks = job.tasks?.nodes || [];
    const reveal = tasks.filter(t => t.taskType?.id === REVEAL_TASK_TYPE).find(t => (t.progress ?? 0) < 1);
    if (reveal?.startDate && reveal.startDate >= today) upcoming.push({ job, tasks, reveal });
  }
  await Promise.all(upcoming.map(async ({ job }) => {
    const res = await pave(env.JOBTREAD_GRANT_KEY, {
      job: { $: { id: job.id }, location: { account: { contacts: { $: { size: 50 }, nodes: { name: {}, customFieldValues: cf } } } }, aces: JOB_ACCESS, ...CONSTRUCTION_PROGRESS },
    }, fetchImpl);
    job.location = { ...job.location, account: res?.job?.location?.account || null };
    job.aces = res?.job?.aces || null;
    job.constructionDone = res?.job?.constructionDone || null;
    job.demoDone = res?.job?.demoDone || null;
    await borrowRealAddress(env.JOBTREAD_GRANT_KEY, job, fetchImpl, jobs);
  }));
  // What went out for each, oldest first (the tracker shows when each invite was first sent)
  const ids = upcoming.map(({ job }) => job.id);
  const logRes = ids.length
    ? await DB.prepare(`SELECT job_id, action, state, guests, reveal_date, created_at FROM reveal_invite_log WHERE job_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`).bind(...ids).all()
    : { results: [] };
  const logs = {};
  for (const l of logRes.results || []) (logs[l.job_id] ||= []).push({ action: l.action, state: l.state, guests: l.guests, date: l.reveal_date, at: l.created_at });
  const out = [];
  for (const { job, tasks, reveal } of upcoming) {
    const values = fieldValues(job.customFieldValues?.nodes);
    const row = rows[job.id];
    const who = displayName(job, kids);

    // Preview as it will look once it goes out, even before construction starts, guests named
    const plan = planInvite({ ...job, demoDone: { count: 1 } },
      staff, { kids, board, organizer: config.organizer, now, template: config.template });
    const preview = plan.action === 'upsert' ? {
      title: plan.event.summary,
      status: plan.event.status,
      start: plan.event.start,
      end: plan.event.end,
      location: plan.event.location || null,
      description: plan.event.description,
      guests: plan.guests.map(email => ({ email, name: plan.people[email]?.name || staffNames[email] || null, kind: plan.people[email]?.kind || 'staff' })),
      // Who confirming the reveal adds (vendors, sponsors, photographers…)
      addsOnConfirm: plan.addsOnConfirm,
    } : null;

    out.push({
      jobId: job.id,
      jobName: job.name,
      name: who.name,
      slug: who.slug,
      space: values[FIELD_MAKEOVER_TYPE] || null,
      ...(isTestJob(job) ? { test: true } : {}),
      kidUrl: who.url,
      jobUrl: `https://app.jobtread.com/jobs/${job.id}`,
      scheduleUrl: scheduleUrl(job.id, reveal.id),
      date: reveal.startDate,
      time: hhmm(reveal.startTime),
      confirmed: String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes'),
      constructionStarted: constructionStarted(job),
      status: values[FIELD_STATUS] || null,
      details: String(values[FIELD_INVITE_DETAILS] || ''),
      preview,
      invite: row ? {
        state: row.state, lastAction: row.last_action, error: row.error, updatedAt: row.updated_at,
        guests: row.guests ? JSON.parse(row.guests).length : 0,
        log: logs[job.id] || [],
      } : null,
    });
  }
  const organizerName = staffNames[config.organizer] || null;
  return {
    organizerName,
    reveals: out.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))),
  };
}

/**
 * The board changed on the website (a member added, removed, or their email
 * set): bring every open reveal's invite up to date now, so every invite
 * gains or loses them right away. Never throws.
 */
export async function refreshForBoardChange(env) {
  try {
    if (!env.JOBTREAD_GRANT_KEY || !(await readConfig(env.DB)).enabled) return null;
    return await reconcileAll(env);
  } catch { return null; }
}
