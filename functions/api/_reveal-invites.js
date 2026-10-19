/**
 * Reveal calendar invites for staff and the makeover family
 * ===========================================================================
 * One Google Calendar event per JobTread job, on the organizer's calendar
 * (Clareece by default), so the invite comes from her and Google handles
 * updates and cancellations.
 *
 *   Construction started          → "Tentative: Max's Reveal Day" (all day,
 *   (Demo done, or 2 tasks under    or timed once the task has a time)
 *   Construction done)
 *   Reveal task moves             → the same event moves; guests get an update
 *   Reveal Date Confirmed = Yes   → the same event becomes "Max's Reveal Day"
 *   Job closed / denied / awaiting funding, or no Reveal date
 *                                 → a future event is cancelled
 * A reveal that has happened is never touched again: its day is past, its
 * start time today has passed (all day: the whole day counts), or its Reveal
 * task is marked complete. Closing the job afterwards cancels nothing.
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
 * Both invites carry the link to watch the reveal live.
 * A person's JobTread role decides their stage, so a sponsor who is also a
 * contact on the family's account still waits for the confirmed invite.
 *
 * Triggered by SOARD JobTread workflows posting { jobId } to
 * /api/reveal-invites. The post is only a wake-up call: everything is
 * re-read from JobTread with JOBTREAD_GRANT_KEY, so a forged post can only
 * make the calendar match what JobTread already says. JobTread has no
 * workflow trigger for job access, so every 5 minutes the guest check
 * (maybeCheckGuests) re-reads each reveal with an invite out: a vendor given
 * access after the invite went out is added within minutes.
 *
 * Sending is off until enabled from /api/reveal-invites-admin (site_config
 * "reveal-invites"). While off, each wake-up records what it would have done.
 */

import { JT_URL, SOARD_ORG_ID, FIELD_REVEAL_CONFIRMED, todayEastern, easternParts, matchKid, parseJobName, loadKids } from './_reveals.js';
import { accessToken, eventIdFor, upsertEvent, cancelEvent } from './_google-calendar.js';
import { sendEmails, slackAlert, emailConfigured } from './_broadcast-notify.js';

export const REVEAL_TASK_TYPE = '22NZSbkR5rZw';
export const FIELD_STATUS = '22P52qfFub9b';
export const FIELD_INVITE_DETAILS = '22PgGhdabNcJ';
export const FIELD_CONTACT_EMAIL = '22NJw43QvHeJ';
export const DEFAULT_ORGANIZER = 'ccunningham@soardcharity.com';
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
async function borrowRealAddress(grantKey, job, fetchImpl, openJobs = null) {
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
// People given access to the job who join once the reveal is confirmed, by JobTread role
const CONFIRMED_ROLES = { Vendor: 'vendor', Sponsor: 'sponsor', Photographer: 'photographer', 'Design Partner': 'design partner' };
const BOARD_ROLE = 'Board Member';
export const BOARD_ROLE_ID = '22PgGdtxTATR';
// Logins with staff roles that aren't people: the Qualification Committee and the DATAx integration
const NOT_STAFF = new Set(['selection@soardcharity.com', 'hello@contractorcto.com']);
// JobTread logins that aren't where that person wants reveal invites
const EMAIL_ALIASES = { 'peter@ranneyblair.com': 'peter@soardcharity.com' };
const STAFF_DOMAIN = '@soardcharity.com';
const INACTIVE_STATUSES = new Set(['Denied', 'Awaiting Funding']);
const SITE = 'https://sunshineonaranneyday.com';
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
];
const _schemaReady = new WeakSet();
export async function ensureSchema(DB) {
  if (_schemaReady.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _schemaReady.add(DB);
}

/**
 * Invite wording, editable in admin (Reveals → Invites). Placeholders:
 * {name} kid's first name, {date} "Tuesday, October 27", {time} "4:00 PM"
 * (or "time to come"), {when} the date with the time when there is one.
 * The reveal's own notes (JobTread "Reveal Invite Details"), the link to watch
 * live and a link to the kid's page are added under the message.
 */
export const DEFAULT_TEMPLATE = {
  tentativeTitle: "Tentative: {name}'s Reveal Day",
  tentativeMessage: "This is a tentative date for {name}'s reveal while the build wraps up.\nThis invite updates automatically if the date moves, and the time is added once the reveal is confirmed.",
  confirmedTitle: "{name}'s Reveal Day",
  confirmedMessage: "{name}'s reveal is confirmed for {when}.",
};
export const TEMPLATE_LIMITS = { tentativeTitle: 150, confirmedTitle: 150, tentativeMessage: 2000, confirmedMessage: 2000 };

export async function readConfig(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(CONFIG_KEY).first();
  let data = {};
  try { data = row ? JSON.parse(row.data) : {}; } catch { /* default */ }
  return { enabled: false, organizer: DEFAULT_ORGANIZER, ...data, template: { ...DEFAULT_TEMPLATE, ...(data.template || {}) } };
}

function clock(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Fill {name} {date} {time} {when}; unknown placeholders are left as typed */
export function renderTemplate(text, { name, date, time }) {
  const day = longDate(date);
  const values = { name, date: day, time: time ? clock(time) : 'time to come', when: time ? `${day} at ${clock(time)}` : `${day} (time to come)` };
  return String(text || '').replace(/\{(name|date|time|when)\}/g, (_, k) => values[k]);
}

export async function writeConfig(DB, patch) {
  const next = { ...(await readConfig(DB)), ...patch };
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(CONFIG_KEY, JSON.stringify(next), new Date().toISOString()).run();
  return next;
}

async function pave(grantKey, query, fetchImpl) {
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
export const JOB_ACCESS = { $: { size: 50 }, nodes: { membership: { isInternal: {}, role: { name: {} }, user: { name: {}, emailAddress: {} } } } };

const normEmail = (e) => {
  const x = String(e || '').trim().toLowerCase();
  return EMAIL_ALIASES[x] || x;
};
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

/**
 * The website's board (People → Board) with each member's private reveal email:
 * [{ slug, name, title, email, memorial }]. A memorial entry ("In memoriam, …")
 * is listed but never invited.
 */
export async function boardRoster(DB) {
  await ensureSchema(DB);
  let rows = [];
  try { rows = (await DB.prepare('SELECT slug, data FROM team').all()).results || []; } catch { return []; }
  const emails = Object.fromEntries(((await DB.prepare('SELECT slug, email FROM reveal_board_emails').all()).results || []).map((r) => [r.slug, r.email]));
  const out = [];
  for (const row of rows) {
    let d = {};
    try { d = JSON.parse(row.data || '{}'); } catch { continue; }
    if (d.group !== 'board') continue;
    out.push({ slug: row.slug, name: d.name, title: d.title || '', order: Number(d.order) || 0, email: emails[row.slug] || null, memorial: /^\s*in memoriam/i.test(d.name || '') });
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
 * The board, for every invite: the website's board members with a private
 * reveal email, plus anyone with the Board Member role in JobTread. Memorial
 * entries never. Never throws.
 */
export async function fetchBoard(env, fetchImpl = fetch) {
  const out = [];
  try {
    for (const m of await boardRoster(env.DB)) if (!m.memorial && isEmail(m.email)) out.push({ name: m.name, email: m.email, from: 'website' });
  } catch { /* no website board */ }
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
  const person = (m, kind) => ({ email: normEmail(m.user.emailAddress), name: m.user.name, kind });
  const partners = access.filter((m) => CONFIRMED_ROLES[m.role?.name]).map((m) => person(m, CONFIRMED_ROLES[m.role.name]));
  const later = new Set(partners.map((p) => p.email));
  const contacts = (job?.location?.account?.contacts?.nodes || [])
    .map((c) => ({ email: normEmail(fieldValues(c.customFieldValues?.nodes)[FIELD_CONTACT_EMAIL]), name: c.name, kind: 'family' }));
  const familyUsers = access.filter((m) => m.role?.name === FAMILY_ROLE).map((m) => person(m, 'family'));
  return {
    family: [...contacts, ...familyUsers].filter((p) => isEmail(p.email) && !later.has(p.email)),
    staff: staff.map((p) => ({ ...p, kind: 'staff' })),
    board: [...board, ...access.filter((m) => m.role?.name === BOARD_ROLE).map((m) => person(m, 'board'))].map((p) => ({ ...p, kind: 'board' })),
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

const fieldValues = (nodes) => Object.fromEntries((nodes || []).map(v => [v.customField?.id, v.value]));
const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

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

/** First name for the title: the matched kid's site name, else the job name's first word */
function displayName(job, kids) {
  const kid = matchKid(job.name, kids);
  if (kid) return { name: kid.name, slug: kid.slug };
  const base = String(job.name || '').replace(/\(\d{4}\)\s*$/, '').trim();
  return { name: base.split(/\s+/)[0] || 'The', slug: null };
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
 * { action: 'upsert', event, guests } | { action: 'cancel', reason } | { action: 'skip', reason }
 */
export function planInvite(job, staff, { kids = [], board = [], organizer = DEFAULT_ORGANIZER, now = Date.now(), onlyGuests = null, template = DEFAULT_TEMPLATE } = {}) {
  if (!job) return { action: 'skip', reason: 'job not found' };
  if (job.organization?.id && job.organization.id !== SOARD_ORG_ID) return { action: 'skip', reason: 'not a SOARD job' };

  const tasks = job.tasks?.nodes || [];
  const reveals = tasks.filter(t => t.taskType?.id === REVEAL_TASK_TYPE);
  const reveal = reveals.find(t => (t.progress ?? 0) < 1) || reveals[0];
  if (revealHappened(reveal, now)) return { action: 'skip', reason: 'the reveal has already happened' };

  const values = fieldValues(job.customFieldValues?.nodes);
  if (job.closedOn) return { action: 'cancel', reason: 'job closed' };
  if (INACTIVE_STATUSES.has(values[FIELD_STATUS])) return { action: 'cancel', reason: `status is ${values[FIELD_STATUS]}` };
  if (!reveal?.startDate) return { action: 'cancel', reason: 'no Reveal task date' };

  const confirmed = String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes');
  if (!confirmed && !constructionStarted(job)) return { action: 'cancel', reason: 'construction not started yet' };

  const who = displayName(job, kids);
  const date = reveal.startDate;
  const start = hhmm(reveal.startTime);
  const end = start ? (hhmm(reveal.endTime) && hhmm(reveal.endTime) > start && (reveal.endDate || date) === date ? hhmm(reveal.endTime) : addHour(start)) : null;

  const t = { ...DEFAULT_TEMPLATE, ...template };
  const fill = (text) => renderTemplate(text, { name: who.name, date, time: start });
  const lines = [fill(confirmed ? t.confirmedMessage : t.tentativeMessage).trim()];
  const details = String(values[FIELD_INVITE_DETAILS] || '').trim();
  if (details) lines.push('', details);
  // The kid's own live page; before the kid is on the site, /live/ (it follows the current reveal)
  lines.push('', `Watch live: ${SITE}/live/${who.slug ? `${who.slug}/` : ''}`);
  if (who.slug) lines.push('', `${SITE}/kids/${who.slug}/`);

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
    location: job.location?.address || undefined,
    description: lines.join('\n'),
    start: start ? { dateTime: `${date}T${start}:00`, timeZone: TZ } : { date },
    end: start ? { dateTime: `${date}T${end}:00`, timeZone: TZ } : { date: nextDay(date) },
    attendees: guests.map(email => ({ email })),
    guestsCanSeeOtherGuests: false,
    guestsCanInviteOthers: false,
    transparency: 'opaque',
  };
  return { action: 'upsert', event, guests, people, addsOnConfirm, confirmed, date };
}

async function hashOf(value) {
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
async function alertProblem(env, config, { jobId, name, error, taskId }) {
  const to = [...new Set([
    ...(config.alertEmails || DEFAULT_ALERT_EMAILS), config.organizer,
    ...String(env.ALERT_EMAILS || '').split(',').map(s => s.trim()),
  ].filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '')))];
  const title = `Reveal invite problem${name ? `: ${name}` : ''}`;
  const detail = `The calendar invite for ${name || `job ${jobId}`} couldn't be updated. Google or JobTread said: ${error}`;
  const fix = /unauthorized_client|GOOGLE_CALENDAR_KEY|sign-in/i.test(error)
    ? 'The Google key or its domain-wide delegation needs attention (Cloudflare GOOGLE_CALENDAR_KEY, Workspace Admin → Domain-wide delegation).'
    : 'Open Reveals in the admin, open this reveal under Upcoming reveals and press Retry. If it keeps failing, check the job in JobTread.';
  await Promise.allSettled([
    slackAlert(env, `🟡 ${title}: ${detail} Fix: ${fix} ${ADMIN_URL}`),
    emailConfigured(env) && to.length ? sendEmails(env, {
      to,
      subject: `[SOARD] ${title}`,
      html: `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(detail)}</p><p><strong>Fix:</strong> ${escapeHtml(fix)}</p><p><a href="${ADMIN_URL}">Open Reveals in the admin</a></p><p><a href="${scheduleUrl(jobId, taskId)}">Open the schedule in JobTread</a></p>`,
      text: `${title}\n\n${detail}\n\nFix: ${fix}\n\nAdmin: ${ADMIN_URL}\nJobTread schedule: ${scheduleUrl(jobId, taskId)}`,
      tags: [{ name: 'category', value: 'reveal-invite-alert' }],
    }) : null,
  ]);
}

function escapeHtml(s) {
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
async function lockJob(DB, jobId, wait) {
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

const unlockJob = (DB, jobId) => DB.prepare('DELETE FROM reveal_invite_locks WHERE job_id = ?').bind(jobId).run().catch(() => {});

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

async function reconcileLocked(env, jobId, { fetchImpl = fetch, now = Date.now(), force = false, dryRun = false, preloaded = null } = {}) {
  const { DB } = env;
  const config = await readConfig(DB);

  const [job, staff, kids, board] = await Promise.all([
    fetchJob(env.JOBTREAD_GRANT_KEY, jobId, fetchImpl),
    preloaded?.staff || fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    preloaded?.kids || loadKids(DB).catch(() => []),
    preloaded?.board || fetchBoard(env, fetchImpl),
  ]);
  const failed = async (row, err) => {
    await writeRow(DB, { ...(row || { job_id: jobId }), error: err.message });
    const revealTask = (job?.tasks?.nodes || []).filter(t => t.taskType?.id === REVEAL_TASK_TYPE).find(t => (t.progress ?? 0) < 1);
    if (err.message !== row?.error) await alertProblem(env, config, { jobId, name: job ? displayName(job, kids).name : null, error: err.message, taskId: revealTask?.id }).catch(() => {});
    return { jobId, action: 'error', error: err.message };
  };
  const sandbox = jobId === SANDBOX_JOB_ID || isTestJob(job);
  const plan = planInvite(job, staff, { kids, board, organizer: config.organizer, now, onlyGuests: sandbox ? (config.testGuests || DEFAULT_TEST_GUESTS) : null, template: config.template });
  if (sandbox && plan.event) plan.event.summary = `TEST · ${plan.event.summary}`;
  const row = await readRow(DB, jobId);
  const live = !dryRun && (config.enabled || force || sandbox);

  if (plan.action === 'skip') return { jobId, action: 'skip', reason: plan.reason };

  if (plan.action === 'cancel') {
    if (!row || row.state === 'cancelled' || !row.event_id) return { jobId, action: 'skip', reason: plan.reason };
    if (!live) return { jobId, action: 'would-cancel', reason: plan.reason };
    try {
      const token = await accessToken(env, config.organizer, { fetchImpl, now });
      await cancelEvent(token, config.organizer, row.event_id, { fetchImpl });
      await writeRow(DB, { ...row, state: 'cancelled', hash: null, last_action: `cancelled: ${plan.reason}`, error: null });
      await logInvite(DB, { jobId, action: 'cancelled', state: 'cancelled', guests: row.guests ? JSON.parse(row.guests).length : null, revealDate: row.reveal_date });
      return { jobId, action: 'cancelled', reason: plan.reason };
    } catch (err) {
      return failed(row, err);
    }
  }

  const hash = await hashOf(plan.event);
  if (row?.hash === hash && row?.state !== 'cancelled') return { jobId, action: 'unchanged', eventId: plan.event.id };
  if (!live) return { jobId, action: row ? 'would-update' : 'would-create', event: plan.event };

  // Only the staff on the guest list changed (someone joined, left, or changed
  // address)? Update quietly: Workspace calendars sync on their own, and the
  // family isn't emailed about a guest list they can't see.
  let sendUpdates = 'all';
  if (row?.hash && row.state !== 'cancelled' && row.guests) {
    const before = JSON.parse(row.guests);
    const sameDetails = (await hashOf({ ...plan.event, attendees: before.map(email => ({ email })) })) === row.hash;
    const added = plan.guests.filter(g => !before.includes(g));
    const removed = before.filter(g => !plan.guests.includes(g));
    if (sameDetails && [...added, ...removed].every(g => g.endsWith(STAFF_DOMAIN) || EMAIL_ALIASES[g])) sendUpdates = 'none';
  }

  try {
    const token = await accessToken(env, config.organizer, { fetchImpl, now });
    const { created } = await upsertEvent(token, config.organizer, plan.event, { fetchImpl, sendUpdates });
    const action = created ? 'created' : sendUpdates === 'none' ? 'updated quietly' : 'updated';
    await writeRow(DB, {
      job_id: jobId, event_id: plan.event.id, state: plan.event.status, hash, reveal_date: plan.date,
      guests: JSON.stringify(plan.guests), last_action: sendUpdates === 'none' ? 'updated quietly (staff guest list only)' : action, error: null,
    });
    await logInvite(DB, { jobId, action, state: plan.event.status, guests: plan.guests.length, revealDate: plan.date });
    return { jobId, action, eventId: plan.event.id, status: plan.event.status, guests: plan.guests.length };
  } catch (err) {
    return failed(row, err);
  }
}

/** Every open SOARD job, reconciled one at a time (go-live catch-up and the safety sweep) */
export async function reconcileAll(env, { fetchImpl = fetch, now = Date.now(), dryRun = false } = {}) {
  const [body, staff, kids, board] = await Promise.all([
    pave(env.JOBTREAD_GRANT_KEY, {
      organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, where: ['closedOn', '=', null] }, nodes: { id: {} } } },
    }, fetchImpl),
    fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    loadKids(env.DB).catch(() => []),
    fetchBoard(env, fetchImpl),
  ]);
  const results = [];
  for (const { id } of body?.organization?.jobs?.nodes || []) {
    if (id === SANDBOX_JOB_ID) continue;
    results.push(await reconcileJob(env, id, { fetchImpl, now, dryRun, wait: false, preloaded: { staff, kids, board } }));
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
    const results = await reconcileAll(env, { fetchImpl, now });
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
 * Never throws.
 */
export async function maybeCheckGuests(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const { DB } = env;
    if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(DB);
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
      loadKids(DB).catch(() => []),
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
export async function sendTestInvite(env, jobId, testEmail, { date, time, cancel = false, fetchImpl = fetch, now = Date.now() } = {}) {
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
    loadKids(DB).catch(() => []),
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
    loadKids(DB).catch(() => []),
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
      ...(isTestJob(job) ? { test: true } : {}),
      kidUrl: who.slug ? `/kids/${who.slug}/` : null,
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
