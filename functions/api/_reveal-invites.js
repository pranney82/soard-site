/**
 * Reveal calendar invites for staff and the makeover family
 * ===========================================================================
 * One Google Calendar event per JobTread job, on the organizer's calendar
 * (Clareece by default), so the invite comes from her and Google handles
 * updates and cancellations.
 *
 *   Build Schedule task complete  → "Tentative: Max's Reveal Day" (all day,
 *                                   or timed once the task has a time)
 *   Reveal task moves             → the same event moves; guests get an update
 *   Reveal Date Confirmed = Yes   → the same event becomes "Max's Reveal Day"
 *   Job closed / denied / awaiting funding, or no Reveal date
 *                                 → a future event is cancelled
 * Reveals already in the past are never touched.
 *
 * Guests: internal JobTread users with the Admin or Designer role, plus the
 * job's customer contacts with an email. The organizer is never a guest.
 *
 * Triggered by SOARD JobTread workflows posting { jobId } to
 * /api/reveal-invites. The post is only a wake-up call: everything is
 * re-read from JobTread with JOBTREAD_GRANT_KEY, so a forged post can only
 * make the calendar match what JobTread already says.
 *
 * Sending is off until enabled from /api/reveal-invites-admin (site_config
 * "reveal-invites"). While off, each wake-up records what it would have done.
 */

import { JT_URL, SOARD_ORG_ID, FIELD_REVEAL_CONFIRMED, todayEastern, matchKid, loadKids } from './_reveals.js';
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
const STAFF_ROLES = new Set(['Admin', 'Designer']);
const NOT_STAFF = new Set(['selection@soardcharity.com']); // Qualification Committee login
// JobTread logins that aren't where that person wants reveal invites
const EMAIL_ALIASES = { 'peter@ranneyblair.com': 'peter@soardcharity.com' };
const STAFF_DOMAIN = '@soardcharity.com';
const INACTIVE_STATUSES = new Set(['Denied', 'Awaiting Funding']);
const SITE = 'https://sunshineonaranneyday.com';
const ADMIN_URL = `${SITE}/admin/#broadcast/invites`;
const CONFIG_KEY = 'reveal-invites';
const TZ = 'America/New_York';
// Problems email these people plus the organizer (and ALERT_EMAILS, Slack if set)
const DEFAULT_ALERT_EMAILS = ['peter@soardcharity.com'];
// The safety sweep re-checks every open job at most this often, in case a
// JobTread webhook was ever missed
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reveal_invites (
    job_id TEXT PRIMARY KEY, event_id TEXT, state TEXT, hash TEXT, reveal_date TEXT,
    guests TEXT, last_action TEXT, error TEXT, updated_at TEXT)`,
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
 * The reveal's own notes (JobTread "Reveal Invite Details") and a link to the
 * kid's page are added under the message.
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
        $: { size: 100, where: { or: [[['taskType', 'id'], '=', REVEAL_TASK_TYPE], ['name', '=', 'Build Schedule']] } },
        nodes: { id: {}, name: {}, startDate: {}, startTime: {}, endDate: {}, endTime: {}, progress: {}, taskType: { id: {} } },
      },
    },
  }, fetchImpl);
  return body?.job || null;
}

export async function fetchStaff(grantKey, fetchImpl = fetch) {
  const body = await pave(grantKey, {
    organization: {
      $: { id: SOARD_ORG_ID },
      memberships: { $: { size: 100 }, nodes: { isInternal: {}, role: { name: {} }, user: { name: {}, emailAddress: {} } } },
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
 * What the calendar should look like for this job:
 * { action: 'upsert', event, guests } | { action: 'cancel', reason } | { action: 'skip', reason }
 */
export function planInvite(job, staff, { kids = [], organizer = DEFAULT_ORGANIZER, now = Date.now(), onlyGuests = null, template = DEFAULT_TEMPLATE } = {}) {
  if (!job) return { action: 'skip', reason: 'job not found' };
  if (job.organization?.id && job.organization.id !== SOARD_ORG_ID) return { action: 'skip', reason: 'not a SOARD job' };

  const tasks = job.tasks?.nodes || [];
  const reveals = tasks.filter(t => t.taskType?.id === REVEAL_TASK_TYPE);
  const reveal = reveals.find(t => (t.progress ?? 0) < 1) || reveals[0];
  if (reveal?.startDate && reveal.startDate < todayEastern(now)) return { action: 'skip', reason: 'reveal date has passed' };

  const values = fieldValues(job.customFieldValues?.nodes);
  if (job.closedOn) return { action: 'cancel', reason: 'job closed' };
  if (INACTIVE_STATUSES.has(values[FIELD_STATUS])) return { action: 'cancel', reason: `status is ${values[FIELD_STATUS]}` };
  if (!reveal?.startDate) return { action: 'cancel', reason: 'no Reveal task date' };

  const confirmed = String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes');
  const scheduleBuilt = tasks.some(t => t.name === 'Build Schedule' && t.progress === 1);
  if (!confirmed && !scheduleBuilt) return { action: 'cancel', reason: 'Build Schedule not complete yet' };

  const who = displayName(job, kids);
  const date = reveal.startDate;
  const start = hhmm(reveal.startTime);
  const end = start ? (hhmm(reveal.endTime) && hhmm(reveal.endTime) > start && (reveal.endDate || date) === date ? hhmm(reveal.endTime) : addHour(start)) : null;

  const t = { ...DEFAULT_TEMPLATE, ...template };
  const fill = (text) => renderTemplate(text, { name: who.name, date, time: start });
  const lines = [fill(confirmed ? t.confirmedMessage : t.tentativeMessage).trim()];
  const details = String(values[FIELD_INVITE_DETAILS] || '').trim();
  if (details) lines.push('', details);
  if (who.slug) lines.push('', `${SITE}/kids/${who.slug}/`);

  const guests = [];
  const seen = new Set([organizer.toLowerCase()]);
  const add = (email) => {
    const e = String(email || '').trim().toLowerCase();
    if (!e || !e.includes('@') || seen.has(e)) return;
    seen.add(e);
    guests.push(e);
  };
  if (onlyGuests) {
    onlyGuests.forEach(add);
  } else {
    for (const c of job.location?.account?.contacts?.nodes || []) add(fieldValues(c.customFieldValues?.nodes)[FIELD_CONTACT_EMAIL]);
    for (const s of staff) add(s.email);
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
  return { action: 'upsert', event, guests, confirmed, date };
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

/**
 * Make the calendar match JobTread for one job. Sends nothing unless the
 * invite is enabled (or `force` is set by an admin), and nothing when the
 * event already matches. Returns what happened.
 */
/**
 * Tell people when an invite can't be sent: email the alert list and the
 * organizer, plus Slack when configured. Only called for a new problem, so a
 * stuck job doesn't email on every JobTread change.
 */
async function alertProblem(env, config, { jobId, name, error }) {
  const to = [...new Set([
    ...(config.alertEmails || DEFAULT_ALERT_EMAILS), config.organizer,
    ...String(env.ALERT_EMAILS || '').split(',').map(s => s.trim()),
  ].filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '')))];
  const title = `Reveal invite problem${name ? `: ${name}` : ''}`;
  const detail = `The calendar invite for ${name || `job ${jobId}`} couldn't be updated. Google or JobTread said: ${error}`;
  const fix = /unauthorized_client|GOOGLE_CALENDAR_KEY|sign-in/i.test(error)
    ? 'The Google key or its domain-wide delegation needs attention (Cloudflare GOOGLE_CALENDAR_KEY, Workspace Admin → Domain-wide delegation).'
    : 'Open Reveals → Invites in the admin and press Retry. If it keeps failing, check the job in JobTread.';
  await Promise.allSettled([
    slackAlert(env, `🟡 ${title}: ${detail} Fix: ${fix} ${ADMIN_URL}`),
    emailConfigured(env) && to.length ? sendEmails(env, {
      to,
      subject: `[SOARD] ${title}`,
      html: `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(detail)}</p><p><strong>Fix:</strong> ${escapeHtml(fix)}</p><p><a href="${ADMIN_URL}">Open Reveals → Invites in the admin</a></p>`,
      text: `${title}\n\n${detail}\n\nFix: ${fix}\n\n${ADMIN_URL}`,
      tags: [{ name: 'category', value: 'reveal-invite-alert' }],
    }) : null,
  ]);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function reconcileJob(env, jobId, { fetchImpl = fetch, now = Date.now(), force = false, dryRun = false, preloaded = null } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const config = await readConfig(DB);
  if (!env.JOBTREAD_GRANT_KEY) return { jobId, action: 'skip', reason: 'JOBTREAD_GRANT_KEY is not set' };

  const [job, staff, kids] = await Promise.all([
    fetchJob(env.JOBTREAD_GRANT_KEY, jobId, fetchImpl),
    preloaded?.staff || fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    preloaded?.kids || loadKids(DB).catch(() => []),
  ]);
  const failed = async (row, err) => {
    await writeRow(DB, { ...(row || { job_id: jobId }), error: err.message });
    if (err.message !== row?.error) await alertProblem(env, config, { jobId, name: job ? displayName(job, kids).name : null, error: err.message }).catch(() => {});
    return { jobId, action: 'error', error: err.message };
  };
  const sandbox = jobId === SANDBOX_JOB_ID;
  const plan = planInvite(job, staff, { kids, organizer: config.organizer, now, onlyGuests: sandbox ? (config.testGuests || DEFAULT_TEST_GUESTS) : null, template: config.template });
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
    return { jobId, action, eventId: plan.event.id, status: plan.event.status, guests: plan.guests.length };
  } catch (err) {
    return failed(row, err);
  }
}

/** Every open SOARD job, reconciled one at a time (go-live catch-up and the safety sweep) */
export async function reconcileAll(env, { fetchImpl = fetch, now = Date.now(), dryRun = false } = {}) {
  const [body, staff, kids] = await Promise.all([
    pave(env.JOBTREAD_GRANT_KEY, {
      organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, where: ['closedOn', '=', null] }, nodes: { id: {} } } },
    }, fetchImpl),
    fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    loadKids(env.DB).catch(() => []),
  ]);
  const results = [];
  for (const { id } of body?.organization?.jobs?.nodes || []) {
    if (id === SANDBOX_JOB_ID) continue;
    results.push(await reconcileJob(env, id, { fetchImpl, now, dryRun, preloaded: { staff, kids } }));
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
  // Pretend the schedule is built so the test always produces an invite
  if (job) job.tasks.nodes.push({ name: 'Build Schedule', progress: 1 });
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
  const [body, staff, kids, rowsRes, config] = await Promise.all([
    pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        jobs: {
          $: { size: 100, where: ['closedOn', '=', null] },
          nodes: {
            id: {}, name: {}, closedOn: {}, organization: { id: {} },
            location: { address: {}, account: { contacts: { $: { size: 50 }, nodes: { name: {}, customFieldValues: cf } } } },
            customFieldValues: cf,
            tasks: {
              $: { size: 20, where: { or: [[['taskType', 'id'], '=', REVEAL_TASK_TYPE], ['name', '=', 'Build Schedule']] } },
              nodes: { name: {}, startDate: {}, startTime: {}, endDate: {}, endTime: {}, progress: {}, taskType: { id: {} } },
            },
          },
        },
      },
    }, fetchImpl),
    fetchStaff(env.JOBTREAD_GRANT_KEY, fetchImpl),
    loadKids(DB).catch(() => []),
    DB.prepare('SELECT * FROM reveal_invites').all(),
    readConfig(DB),
  ]);
  const rows = Object.fromEntries((rowsRes.results || []).map(r => [r.job_id, r]));
  const staffNames = Object.fromEntries(staff.map(s => [s.email, s.name]));
  const today = todayEastern(now);
  const out = [];
  for (const job of body?.organization?.jobs?.nodes || []) {
    if (job.id === SANDBOX_JOB_ID) continue;
    const tasks = job.tasks?.nodes || [];
    const reveal = tasks.filter(t => t.taskType?.id === REVEAL_TASK_TYPE).find(t => (t.progress ?? 0) < 1);
    if (!reveal?.startDate || reveal.startDate < today) continue;
    const values = fieldValues(job.customFieldValues?.nodes);
    const row = rows[job.id];
    const who = displayName(job, kids);

    // The invite exactly as it would go out right now, with guests named
    const familyNames = {};
    for (const c of job.location?.account?.contacts?.nodes || []) {
      const email = String(fieldValues(c.customFieldValues?.nodes)[FIELD_CONTACT_EMAIL] || '').trim().toLowerCase();
      if (email) familyNames[email] = c.name;
    }
    // Preview as it will look once it goes out, even before Build Schedule is done
    const plan = planInvite({ ...job, tasks: { nodes: [...tasks, { name: 'Build Schedule', progress: 1 }] } },
      staff, { kids, organizer: config.organizer, now, template: config.template });
    const preview = plan.action === 'upsert' ? {
      title: plan.event.summary,
      status: plan.event.status,
      start: plan.event.start,
      end: plan.event.end,
      location: plan.event.location || null,
      description: plan.event.description,
      guests: plan.guests.map(email => ({
        email,
        name: familyNames[email] || staffNames[email] || null,
        kind: familyNames[email] ? 'family' : 'staff',
      })),
    } : null;

    out.push({
      jobId: job.id,
      jobName: job.name,
      name: who.name,
      kidUrl: who.slug ? `/kids/${who.slug}/` : null,
      jobUrl: `https://app.jobtread.com/jobs/${job.id}`,
      date: reveal.startDate,
      time: hhmm(reveal.startTime),
      confirmed: String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes'),
      scheduleBuilt: tasks.some(t => t.name === 'Build Schedule' && t.progress === 1),
      status: values[FIELD_STATUS] || null,
      details: String(values[FIELD_INVITE_DETAILS] || ''),
      preview,
      invite: row ? {
        state: row.state, lastAction: row.last_action, error: row.error, updatedAt: row.updated_at,
        guests: row.guests ? JSON.parse(row.guests).length : 0,
      } : null,
    });
  }
  const organizerName = staffNames[config.organizer] || null;
  return {
    organizerName,
    reveals: out.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))),
  };
}
