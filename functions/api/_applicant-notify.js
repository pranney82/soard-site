/**
 * When families are emailed about their status
 * ===========================================================================
 * Built from how staff actually change statuses (JobTread's history, 2025-26):
 *   - screening sessions move 20-25 families in a few minutes, and Applied
 *     straight to Denied is common, so batches and skipped stages are normal;
 *   - real accidents are quick flip-flops (one family went Denied → In
 *     Review → Denied → In Review → Denied in five minutes);
 *   - data cleanup once bounced ~30 families through a temporary status and
 *     back.
 *
 * So the rule is: email the status a family should know, once it has settled.
 *   - `told` is the last status the family was emailed about (or already knew
 *     when the site started keeping track).
 *   - A status further along than `told` (or a different decision), unchanged
 *     for the wait (10 min; 30 for Approved/Denied) and outside quiet hours
 *     (8 PM-8 AM Eastern), sends that status's message once. A flip-flop sends
 *     one email for where it lands, or none.
 *   - Cleared or unknown statuses never email anyone. Moving below what the
 *     family was told leaves a staff note once it settles, and the site offers
 *     a correction.
 *   - Whoever changed statuses in JobTread gets one summary per working
 *     session, with Move back / Don't email / Send now links (no sign-in; a
 *     one-time token per change).
 *   - "Pause family emails" (for cleanup, 2 hours at most): nothing that
 *     changes while paused is sent unless someone chooses to send it.
 *
 * Wait times, quiet hours and the summary are form settings (definition.notify,
 * Admin → Applications → Messages). The welcome from the site's own form isn't
 * timed here: the family just submitted and expects it (./_applications.js).
 *
 * Woken by: the JobTread workflow (/api/applicant-sync → handleWorkflowCall),
 * site status changes (./_applicants.js), the event-log sync as a backup, and
 * the application sweep (runNotifications, every 2 minutes; the admin runs it
 * too when it opens, in case the sweep stalls).
 */

import { pave, SOARD_ORG_ID, easternParts, easternToUtcIso } from './_reveals.js';
import {
  readApplicant, sendStatusMessage, sentKinds, madeByForm, postAccountComment, handleApplicantEvent, applicationLang,
  familyMessage, COMMENT_NAMES, COMMENT_NAMES_ES,
  SITE_GRANT_ID, STATUS_RANK, INTAKE_SINCE, FIELD_STATUS,
} from './_applicant-comms.js';
import { getLiveForm } from './_application-forms.js';
import { resolveForm, notifySettings, renderMessage, DEFAULT_MESSAGES } from './_application-form.js';
import { sendEmails, SITE_ORIGIN } from './_broadcast-notify.js';
import { emailShell, panel, pill, button, link, esc, MUTED, SANS } from './_email-shell.js';

const KIND = { Applied: 'welcome', 'In Review': 'inReview', Approved: 'approved', Denied: 'denied' };
const STATUS_OF = Object.fromEntries(Object.entries(KIND).map(([s, k]) => [k, s]));
export const PAUSE_MAX_MIN = 120;
const SUMMARY_IDLE_MS = 3 * 60 * 1000;   // a session has ended after 3 quiet minutes
const SUMMARY_MAX_MS = 12 * 60 * 1000;   // long sessions still get a summary by now
const AFTER_SUMMARY_MS = 5 * 60 * 1000;  // time to act on the summary before emails go
const NOTE_WAIT_MS = 10 * 60 * 1000;     // a move back settles this long before the staff note
const RETRY_MS = 5 * 60 * 1000;

const iso = (t = Date.now()) => new Date(t).toISOString();
const rank = (s) => STATUS_RANK[s || ''];
const known = (s) => rank(s) !== undefined;
const token = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

/** Does a family that was told `told` need an email now that the status is `status`? */
export function needsEmail(status, told) {
  if (!KIND[status]) return false;
  const r = rank(status);
  const t = rank(told) ?? 0;
  return r > t || (r === 3 && t === 3 && status !== told);
}

/** The status a family's sent messages say they know (ties between decisions go to `prefer`) */
export function toldFromSent(sent, prefer = '') {
  const statuses = [...sent].map(k => STATUS_OF[k]).filter(Boolean);
  if (!statuses.length) return '';
  const top = Math.max(...statuses.map(s => rank(s)));
  const best = statuses.filter(s => rank(s) === top);
  return best.includes(prefer) ? prefer : best.sort()[0];
}

// ─── Timing ─────────────────────────────────────────────────────────

const waitFor = (kind, s) => (kind === 'approved' || kind === 'denied' ? s.waits.decision : kind === 'welcome' ? s.waits.welcome : s.waits.inReview) * 60 * 1000;

/** `ts`, or the end of quiet hours (Eastern) if it falls inside them */
export function outsideQuiet(ts, quiet) {
  const { start, end } = quiet || {};
  if (start == null || end == null || start === end) return ts;
  const p = easternParts(iso(ts));
  const h = p.time ? Number(p.time.slice(0, 2)) : 0;
  const inQuiet = start > end ? (h >= start || h < end) : (h >= start && h < end);
  if (!inQuiet) return ts;
  let date = p.date;
  if (start > end && h >= start) date = new Date(Date.parse(`${p.date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return Date.parse(easternToUtcIso(date, `${String(end).padStart(2, '0')}:00`));
}

/** "2:45 PM" (today), or "Tue 8:00 AM" further out, Eastern */
export function sendTimeText(ts, now = Date.now()) {
  const opts = { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' };
  const sameDay = easternParts(iso(ts))?.date === easternParts(iso(now))?.date;
  return new Date(ts).toLocaleString('en-US', sameDay ? opts : { ...opts, weekday: 'short' });
}

async function settings(env) {
  try {
    const live = await getLiveForm(env.DB);
    return notifySettings(live.definition?.notify);
  } catch {
    return notifySettings(null);
  }
}

/** When a status email for `status` would go if it changed now (for previews) */
export async function whenWouldSend(env, status, now = Date.now()) {
  const kind = KIND[status];
  if (!kind) return null;
  const s = await settings(env);
  return outsideQuiet(now + waitFor(kind, s), s.quiet);
}

// ─── D1 ─────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS applicant_notify (
    account_id TEXT PRIMARY KEY, name TEXT, told TEXT, told_at TEXT,
    status TEXT, since TEXT, previous TEXT,
    kind TEXT, due_at INTEGER, hold TEXT,
    by_name TEXT, by_email TEXT, via TEXT, summary_at INTEGER, token TEXT,
    note_due INTEGER, updated_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_applicant_notify_due ON applicant_notify(kind, due_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_applicant_notify_token ON applicant_notify(token)',
  'CREATE TABLE IF NOT EXISTS applicant_notify_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
  // Shared with ./_applicants.js (same shape), so history shows what happened to each email
  `CREATE TABLE IF NOT EXISTS applicant_activity (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
    by_name TEXT, source TEXT, title TEXT, body TEXT, data TEXT)`,
];
const _ready = new WeakSet();
export async function ensureNotifySchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _ready.add(DB);
}

const COLS = ['account_id', 'name', 'told', 'told_at', 'status', 'since', 'previous', 'kind', 'due_at', 'hold', 'by_name', 'by_email', 'via', 'summary_at', 'token', 'note_due', 'updated_at'];
async function getRow(DB, id) {
  return DB.prepare('SELECT * FROM applicant_notify WHERE account_id = ?').bind(id).first();
}
async function putRow(DB, row, now) {
  const r = { ...row, updated_at: iso(now) };
  await DB.prepare(`INSERT INTO applicant_notify (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})
    ON CONFLICT(account_id) DO UPDATE SET ${COLS.slice(1).map(c => `${c} = excluded.${c}`).join(', ')}`).bind(...COLS.map(c => r[c] ?? null)).run();
  return r;
}

async function log(DB, accountId, { title, body = null, by = null, source = 'website', data = null }, now) {
  await DB.prepare('INSERT OR IGNORE INTO applicant_activity (id, account_id, at, kind, by_name, source, title, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`notify:${now}:${Math.random().toString(36).slice(2, 8)}`, accountId, iso(now), 'notify', by, source, title, body, data ? JSON.stringify(data) : null).run();
}

async function getState(DB, key) {
  const r = await DB.prepare('SELECT value FROM applicant_notify_state WHERE key = ?').bind(key).first();
  try { return r?.value ? JSON.parse(r.value) : null; } catch { return null; }
}
async function setState(DB, key, value, now) {
  if (value == null) { await DB.prepare('DELETE FROM applicant_notify_state WHERE key = ?').bind(key).run(); return; }
  await DB.prepare('INSERT INTO applicant_notify_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), iso(now)).run();
}

// ─── A status changed ───────────────────────────────────────────────

const LABEL = { welcome: 'Application Status (welcome)', inReview: 'In Review', approved: 'Approved', denied: 'Denied' };

/**
 * Record that `applicant` (fresh from JobTread) is now at its status, and
 * work out what (if anything) the family should hear and when.
 *   previous: the status before this change, if known (sets the starting
 *             point the first time the site sees this family)
 *   at:       when the change happened (JobTread's event time)
 *   by:       { name, email } of whoever made it; via: 'jobtread' | 'website' | 'integration'
 * Returns { kind, dueAt, cancelled, unchanged }.
 */
export async function noteStatus(env, applicant, { previous = null, at = null, by = null, via = 'jobtread', fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureNotifySchema(DB);
  const s = await settings(env);
  const status = applicant.status || '';
  const row = await getRow(DB, applicant.id);
  if (row && row.status === status) return { unchanged: true, kind: row.kind, dueAt: row.due_at };

  const sent = await sentKinds(DB, applicant);
  let told = row ? row.told || '' : '';
  if (!row) {
    // First time the site tracks this family: they know whatever they were
    // emailed, or the status before this change (never email the past)
    const fromSent = toldFromSent(sent, previous || status);
    const start = known(previous) ? previous : (previous == null ? status : '');
    told = (rank(fromSent) ?? 0) >= (rank(start) ?? 0) ? fromSent : start;
  }
  let kind = needsEmail(status, told) ? KIND[status] : null;
  if (kind === 'welcome' && (await madeByForm(DB, applicant.id) || String(applicant.createdAt || '') < INTAKE_SINCE)) kind = null;
  if (kind && sent.has(kind)) { told = status; kind = null; } // they had this one already
  const changeAt = Math.min(Date.parse(at || '') || now, now);
  const backward = known(status) && status !== '' && rank(status) < (rank(told) ?? 0);
  const pause = await pauseState(DB, now);
  const next = {
    account_id: applicant.id, name: applicant.name, told, told_at: row?.told_at || null,
    status, since: iso(changeAt), previous: row ? row.status : (previous ?? null),
    kind, due_at: kind ? outsideQuiet(changeAt + waitFor(kind, s), s.quiet) : null,
    hold: kind && pause.active ? 'paused' : null,
    by_name: by?.name || null, by_email: by?.email || null, via,
    // Changes made on the site were already confirmed with a preview: no summary for those
    summary_at: kind && (via === 'website' || !s.summary) ? now : null,
    token: kind || backward ? token() : null,
    note_due: backward ? changeAt + NOTE_WAIT_MS : null,
  };
  await putRow(DB, next, now);

  const who = by?.name || null;
  const source = via === 'website' ? 'website' : via === 'integration' ? 'integration' : 'jobtread';
  let cancelled = null;
  if (row?.kind && row.kind !== kind) {
    cancelled = row.kind;
    await log(DB, applicant.id, { title: `Not emailed: ${LABEL[row.kind]}`, body: `The status changed to ${status || 'blank'} before it went out, so the family wasn't emailed.`, by: who, source }, now);
  }
  if (kind) {
    await log(DB, applicant.id, {
      title: next.hold ? `Held: ${LABEL[kind]} email` : `Email scheduled: ${LABEL[kind]}`,
      body: next.hold ? 'Family emails are paused, so this waits for someone to send it or not.' : `Goes to the family at ${sendTimeText(next.due_at, now)} unless the status changes back first.`,
      by: who, source, data: { kind, dueAt: next.due_at },
    }, now);
  }
  return { kind, dueAt: next.due_at, hold: next.hold, cancelled };
}

// ─── The JobTread workflow ──────────────────────────────────────────

/** Who made a JobTread change and when, from its event (the workflow sends the id) */
export async function changeInfo(env, { eventId = null, accountId }, { fetchImpl = fetch, now = Date.now() } = {}) {
  const pick = (ev) => {
    if (!ev) return null;
    const grant = String(ev.createdByGrantName || '');
    const via = ev.createdByGrantId === SITE_GRANT_ID ? 'website'
      : /zapier|datax/i.test(grant) || ev.createdByUser?.name === 'JobTread' ? 'integration' : 'jobtread';
    return { at: ev.createdAt, via, by: ev.createdByUser ? { name: ev.createdByUser.name || null, email: ev.createdByUser.emailAddress || null } : null };
  };
  const EV = { id: {}, createdAt: {}, createdByGrantId: {}, createdByGrantName: {}, createdByUser: { name: {}, emailAddress: {} }, account: { _on_account: { id: {} } }, data: {} };
  try {
    if (/^[A-Za-z0-9]{6,32}$/.test(String(eventId || ''))) {
      const ev = (await pave(env.JOBTREAD_GRANT_KEY, { event: { $: { id: eventId }, ...EV } }, fetchImpl))?.event;
      if (ev?.account?.id === accountId) return pick(ev);
    }
    // No usable id: the latest Status change on this account in the last 15 minutes
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: { $: { id: SOARD_ORG_ID }, events: { $: { size: 100, where: { and: [['createdAt', '>', iso(now - 15 * 60 * 1000)], ['type', '=', 'accountUpdated']] }, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: EV } },
    }, fetchImpl);
    const ev = (data?.organization?.events?.nodes || []).find(e => e.account?.id === accountId && e.data?.next?.custom && 'Status' in e.data.next.custom);
    return pick(ev) || { at: iso(now), via: 'jobtread', by: null };
  } catch {
    return { at: iso(now), via: 'jobtread', by: null };
  }
}

/**
 * One call from JobTread's workflow (/api/applicant-sync): the medical note
 * goes now; the welcome and status emails are scheduled here.
 */
export async function handleWorkflowCall(env, payload, { fetchImpl = fetch, now = Date.now() } = {}) {
  return handleApplicantEvent(env, payload, {
    fetchImpl, now,
    onStatus: async (applicant, { previous }) => {
      const info = await changeInfo(env, { eventId: payload?.eventId, accountId: applicant.id }, { fetchImpl, now });
      const out = await noteStatus(env, applicant, { previous, at: info.at, by: info.by, via: info.via, fetchImpl, now });
      const actions = {};
      if (out.kind) actions[out.kind] = out.hold ? 'held: paused' : `scheduled for ${iso(out.dueAt)}`;
      if (out.cancelled) actions.cancelled = out.cancelled;
      return actions;
    },
  });
}

// ─── Sending (the sweep) ────────────────────────────────────────────

async function sendRow(env, row, { fetchImpl, now }) {
  const { DB } = env;
  const applicant = await readApplicant(env, row.account_id, fetchImpl);
  if (!applicant) {
    await putRow(DB, { ...row, kind: null, due_at: null, token: null }, now);
    return 'gone';
  }
  // Someone changed it again and the change hasn't reached us yet: start over from what's there
  if ((applicant.status || '') !== row.status) {
    await noteStatus(env, applicant, { at: iso(now), via: 'jobtread', fetchImpl, now });
    return 'changed';
  }
  const result = await sendStatusMessage(env, applicant, row.kind, { fetchImpl, now });
  if (result === 'sent' || result === 'already') {
    await putRow(DB, { ...row, told: row.status, told_at: result === 'sent' ? iso(now) : row.told_at, kind: null, due_at: null, hold: null, token: null }, now);
    await log(DB, row.account_id, { title: result === 'sent' ? `Emailed the family: ${LABEL[row.kind]}` : `Not emailed again: ${LABEL[row.kind]}`, body: result === 'sent' ? `To ${applicant.primary?.name || 'the main contact'}${applicant.primary?.email ? ` (${applicant.primary.email})` : ''}, from the Qualification Committee.` : 'The family already had this message.', source: 'website' }, now);
    return result;
  }
  if (String(result).startsWith('skipped')) {
    await putRow(DB, { ...row, kind: null, due_at: null, token: null }, now);
    await log(DB, row.account_id, { title: `Couldn't email the family: ${LABEL[row.kind]}`, body: 'There is no email address for the main contact in JobTread. Add one there, then send it from the family’s page.', source: 'website' }, now);
    return result;
  }
  await putRow(DB, { ...row, due_at: now + RETRY_MS }, now); // busy or failed: try again shortly
  return result;
}

/** Families whose summary is out (or not needed) and whose wait is over */
async function dueRows(DB, now, limit) {
  const { results } = await DB.prepare(`SELECT * FROM applicant_notify WHERE kind IS NOT NULL AND hold IS NULL AND due_at <= ?
    AND (summary_at IS NOT NULL AND summary_at <= ? OR due_at <= ?) ORDER BY due_at LIMIT ?`).bind(now, now - AFTER_SUMMARY_MS, now - 60 * 60 * 1000, limit).all();
  return results || [];
}

/**
 * Everything time-based, safe to call any number of times: summaries to
 * staff, due family emails, staff notes for moves back, and the end of a
 * pause. Never throws.
 */
export async function runNotifications(env, { fetchImpl = fetch, now = Date.now(), limit = 10 } = {}) {
  const { DB } = env;
  if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
  const out = { summaries: 0, sent: [], notes: 0 };
  try {
    await ensureNotifySchema(DB);
    await endPauseIfDue(env, now);
    out.summaries = await sendSummaries(env, { now, fetchImpl });
    for (const row of await dueRows(DB, now, limit)) out.sent.push({ id: row.account_id, kind: row.kind, result: await sendRow(env, row, { fetchImpl, now }) });
    out.notes = await postMoveBackNotes(env, { fetchImpl, now });
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** A move below what the family was told, still there after it settled: one staff note */
async function postMoveBackNotes(env, { fetchImpl, now }) {
  const { DB } = env;
  const { results } = await DB.prepare('SELECT * FROM applicant_notify WHERE note_due IS NOT NULL AND note_due <= ? LIMIT 10').bind(now).all();
  let n = 0;
  for (const row of results || []) {
    await putRow(DB, { ...row, note_due: null }, now);
    if (!(known(row.status) && rank(row.status) < (rank(row.told) ?? 0))) continue;
    const emailed = row.told_at ? ` The family was emailed the ${row.told} message on ${new Date(row.told_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}; if that was a mistake, send them a correction from the site.` : '';
    try {
      await postAccountComment(env, { accountId: row.account_id, message: `Moved back to ${row.status}.${emailed}`, grant: env.JOBTREAD_GRANT_KEY }, fetchImpl);
      n++;
    } catch { /* the note is a courtesy */ }
  }
  return n;
}

// ─── The summary to whoever made the changes ────────────────────────

const actionUrl = (tok, act) => `${SITE_ORIGIN}/api/applicant-email-action?t=${tok}&do=${act}`;
const adminUrl = (id) => `${SITE_ORIGIN}/admin/#applications/applicants/${id}`;

/**
 * What a family would read, for the summary: { to, title, snippet }. The
 * greeting line is dropped and *bold* markers too, so the preview reads as
 * prose. Never throws (the summary still goes without it).
 */
async function familyPreview(env, row, fetchImpl) {
  try {
    const applicant = await readApplicant(env, row.account_id, fetchImpl);
    if (!applicant) return null;
    const lang = (await applicationLang(env.DB, row.account_id)) || applicant.lang || 'en';
    const text = await familyMessage(env, row.kind, { parent: applicant.primary?.name || 'Hello', child: applicant.name, lang });
    const body = String(text).split('\n').slice(1).join(' ').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    const snippet = body.length > 190 ? `${body.slice(0, 190).replace(/\s+\S*$/, '')}…` : body;
    const titles = lang === 'es' ? COMMENT_NAMES_ES : COMMENT_NAMES;
    return { to: applicant.primary?.name || null, title: titles[row.kind] || COMMENT_NAMES[row.kind], snippet, lang };
  } catch {
    return null;
  }
}

/** One email per person per working session, listing each family and what's about to go */
async function sendSummaries(env, { now, fetchImpl = fetch }) {
  const { DB } = env;
  const { results } = await DB.prepare("SELECT * FROM applicant_notify WHERE kind IS NOT NULL AND hold IS NULL AND summary_at IS NULL AND via != 'website'").all();
  const groups = new Map();
  for (const r of results || []) {
    const key = r.via === 'jobtread' && r.by_email ? r.by_email.toLowerCase() : 'staff';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let sent = 0;
  for (const [key, rows] of groups) {
    const times = rows.map(r => Date.parse(r.since));
    if (now - Math.max(...times) < SUMMARY_IDLE_MS && now - Math.min(...times) < SUMMARY_MAX_MS) continue;
    let to = [key];
    if (key === 'staff') {
      try { to = resolveForm((await getLiveForm(DB)).definition).staffEmails; } catch { to = ['selection@soardcharity.com']; }
    }
    const previews = {};
    for (const r of rows.slice(0, 30)) previews[r.account_id] = await familyPreview(env, r, fetchImpl);
    const msg = summaryEmail(rows, { now, staff: key === 'staff', previews, quiet: (await settings(env)).quiet });
    const res = await sendEmails(env, { to, ...msg, tags: [{ name: 'type', value: 'applicant-status-summary' }] });
    // Even if the email failed, the families' emails must not wait forever
    for (const r of rows) await putRow(DB, { ...r, summary_at: now }, now);
    if (res.sent) sent++;
  }
  return sent;
}

/** "2:45 PM", with how long that is from now ("in 30 minutes", "tomorrow, after quiet hours") */
function whenText(ts, now) {
  const time = sendTimeText(ts, now);
  const mins = Math.round((ts - now) / 60000);
  const sameDay = easternParts(iso(ts))?.date === easternParts(iso(now))?.date;
  if (!sameDay) return { time, rel: 'after quiet hours' };
  if (mins <= 1) return { time, rel: 'in about a minute' };
  return { time, rel: mins < 60 ? `in ${mins} minutes` : `in about ${Math.round(mins / 60)} ${Math.round(mins / 60) === 1 ? 'hour' : 'hours'}` };
}

/**
 * The summary email (subject, html, text). rows: applicant_notify rows;
 * previews: { accountId: familyPreview() }; staff: an integration made the
 * change, so it goes to the staff list and says who.
 */
export function summaryEmail(rows, { now = Date.now(), staff = false, previews = {}, quiet = { start: 20, end: 8 } } = {}) {
  const sorted = [...rows].sort((a, b) => a.due_at - b.due_at);
  const first = sorted[0];
  const one = sorted.length === 1;
  const firstWhen = whenText(first.due_at, now);
  const added = (r) => !r.previous && r.kind === 'welcome';
  const headline = one
    ? (added(first) ? `${first.name} was added as an applicant` : `${first.name} moved to ${first.status}`)
    : `${sorted.length} families moved`;
  const subject = one
    ? `${headline} · family email at ${firstWhen.time}`
    : `${headline} · family emails from ${firstWhen.time}`;
  const who = staff ? (first.by_name ? `${first.by_name}, through an integration,` : 'An integration') : 'You';
  const intro = `${esc(who)} changed ${one ? 'this' : 'these'} in JobTread. Nothing to do if ${one ? 'it’s' : 'they’re'} right. If ${one ? 'it' : 'one'} was a mistake, tap <strong>Move back</strong> before the email goes and the family never hears about it.`;
  const hour = (h) => `${h % 12 || 12}&nbsp;${h < 12 ? 'AM' : 'PM'}`;
  const quietLine = quiet && quiet.start !== quiet.end ? `Families are never emailed between ${hour(quiet.start)} and ${hour(quiet.end)} Eastern, and a` : 'A';

  const cards = sorted.map(r => {
    const p = previews[r.account_id] || null;
    const when = whenText(r.due_at, now);
    const firstName = String(r.name || '').split(/\s+/)[0] || 'this family';
    const change = r.previous && known(r.previous)
      ? `${pill(r.previous)}<span class="muted" style="padding:0 6px;color:${MUTED};">&rarr;</span>${pill(r.status)}`
      : pill(r.status);
    const quote = p?.snippet
      ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;margin:12px 0 4px;"><tr><td class="quote muted" style="padding:12px 14px;background:#F5F4F0;border-radius:8px;font-family:${SANS};font-size:13px;line-height:1.55;color:${MUTED};">`
        + `<div class="ink" style="font-weight:700;color:#2D2E33;margin-bottom:3px;">${esc(p.title)}${p.lang === 'es' ? ' <span class="muted" style="font-weight:400;color:' + MUTED + ';">(in Spanish)</span>' : ''}</div>${esc(p.snippet)}</td></tr></table>`
      : '';
    const actions = [
      r.previous && known(r.previous) && r.previous !== r.status ? button(`Move back to ${r.previous}`, actionUrl(r.token, 'back'), 'dark') : '',
      button('Don’t email', actionUrl(r.token, 'skip'), 'outline'),
      button('Send now', actionUrl(r.token, 'send'), 'outline'),
    ].join('');
    return panel(`${one ? '' : `<div class="ink" style="font-family:${SANS};font-size:17px;font-weight:700;line-height:1.3;color:#2D2E33;margin-bottom:9px;">${esc(r.name || 'A family')}</div>`}
<div style="margin:0 0 10px;line-height:26px;">${change}</div>
<div class="muted" style="font-family:${SANS};font-size:14px;line-height:1.5;color:${MUTED};">${esc(p?.to || 'The family')} is emailed at <strong class="ink" style="color:#2D2E33;">${esc(when.time)}</strong>, ${esc(when.rel)}.</div>
${quote}
<div style="margin-top:12px;">${actions}</div>
<div style="font-family:${SANS};font-size:13px;margin-top:2px;">${link(`Open ${firstName} in the admin`, adminUrl(r.account_id))}</div>`);
  }).join('');

  const html = emailShell({
    preheader: one
      ? `${p0(previews, first)} is emailed at ${firstWhen.time}. Nothing to do if that’s right.`
      : `${sorted.length} families are emailed from ${firstWhen.time}. Nothing to do if they’re right.`,
    eyebrow: 'Applicants · Status emails',
    heading: headline,
    intro,
    bodyHtml: cards,
    footerHtml: `You’re getting this because ${staff ? 'statuses were changed in JobTread by an integration' : 'you changed statuses in JobTread'}. ${quietLine} status that’s changed back before its email goes sends nothing. ${link('Email timing', `${SITE_ORIGIN}/admin/#applications/settings`)}`,
  });
  const text = `${headline}\n\n${staff ? `${who} changed ${one ? 'this' : 'these'} in JobTread.` : `You changed ${one ? 'this' : 'these'} in JobTread.`} Nothing to do if ${one ? 'it is' : 'they are'} right.\n\n${sorted.map(r => {
    const when = whenText(r.due_at, now);
    return `${r.name}: ${r.previous ? `${r.previous} -> ` : ''}${r.status}. Emailed at ${when.time}, ${when.rel}.\n  Move back: ${actionUrl(r.token, 'back')}\n  Don't email: ${actionUrl(r.token, 'skip')}\n  Send now: ${actionUrl(r.token, 'send')}`;
  }).join('\n\n')}`;
  return { subject, html, text };
}
const p0 = (previews, row) => previews[row.account_id]?.to || 'The family';

// ─── Staff actions (admin and the summary's links) ─────────────────

/** Send the pending email now (the wait and quiet hours skipped) */
export async function sendNow(env, accountId, { user = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureNotifySchema(DB);
  const row = await getRow(DB, accountId);
  if (!row?.kind) return { ok: false, error: 'Nothing is waiting to send for this family.' };
  await log(DB, accountId, { title: `Send now: ${LABEL[row.kind]}`, by: user, source: 'website' }, now);
  const result = await sendRow(env, { ...row, hold: null, due_at: now, summary_at: row.summary_at ?? now }, { fetchImpl, now });
  return { ok: result === 'sent' || result === 'already', result };
}

/** Don't send it: the family is treated as knowing this status (staff told them another way) */
export async function dontSend(env, accountId, { user = null, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureNotifySchema(DB);
  const row = await getRow(DB, accountId);
  if (!row?.kind) return { ok: false, error: 'Nothing is waiting to send for this family.' };
  await putRow(DB, { ...row, told: row.status, kind: null, due_at: null, hold: null, token: null }, now);
  await log(DB, accountId, { title: `Not emailed: ${LABEL[row.kind]}`, body: `${user || 'Staff'} chose not to email the family about this.`, by: user, source: 'website' }, now);
  return { ok: true };
}

/** Put the status back to what it was (in JobTread), which cancels the email */
export async function moveBack(env, accountId, { user = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureNotifySchema(DB);
  const row = await getRow(DB, accountId);
  if (!row || !known(row.previous) || !row.previous) return { ok: false, error: 'There’s no earlier status to go back to.' };
  await pave(env.JOBTREAD_GRANT_KEY, { updateAccount: { $: { id: accountId, customFieldValues: { [FIELD_STATUS]: row.previous } } } }, fetchImpl);
  const applicant = await readApplicant(env, accountId, fetchImpl);
  const out = applicant ? await noteStatus(env, applicant, { at: iso(now), by: { name: user }, via: 'website', fetchImpl, now }) : {};
  await log(DB, accountId, { title: `Moved back to ${row.previous}`, body: 'From the status summary email. Nothing was sent to the family.', by: user, source: 'website' }, now);
  return { ok: true, status: row.previous, ...out };
}

/** One of the summary's links: 'back' | 'skip' | 'send'. Single use (a new change gets a new token). */
export async function linkAction(env, tok, act, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureNotifySchema(DB);
  if (!/^[0-9a-f]{32}$/.test(String(tok || ''))) return { ok: false, error: 'This link isn’t valid.' };
  const row = await DB.prepare('SELECT * FROM applicant_notify WHERE token = ?').bind(tok).first();
  if (!row) return { ok: false, gone: true, error: 'This change was already handled, or the status has changed again since.' };
  const who = row.by_name || 'Staff';
  if (act === 'back') return { ...(await moveBack(env, row.account_id, { user: who, fetchImpl, now })), name: row.name };
  if (act === 'skip') return { ...(await dontSend(env, row.account_id, { user: who, now })), name: row.name, status: row.status };
  if (act === 'send') return { ...(await sendNow(env, row.account_id, { user: who, fetchImpl, now })), name: row.name, status: row.status };
  return { ok: false, error: 'Unknown action.' };
}

/** What a link would do, for its confirmation page (no change made) */
export async function linkPreview(env, tok) {
  await ensureNotifySchema(env.DB);
  if (!/^[0-9a-f]{32}$/.test(String(tok || ''))) return null;
  const row = await env.DB.prepare('SELECT account_id, name, status, previous, kind, due_at, hold FROM applicant_notify WHERE token = ?').bind(tok).first();
  return row ? { ...row, label: row.kind ? LABEL[row.kind] : null } : null;
}

// ─── Pause ──────────────────────────────────────────────────────────

export async function pauseState(DB, now = Date.now()) {
  await ensureNotifySchema(DB);
  const p = await getState(DB, 'pause');
  const { results } = await DB.prepare("SELECT account_id, name, status, kind FROM applicant_notify WHERE hold = 'paused' AND kind IS NOT NULL ORDER BY since").all();
  return { active: !!(p && p.until > now), until: p?.until || null, by: p?.by || null, held: results || [] };
}

export async function pauseEmails(DB, { minutes = PAUSE_MAX_MIN, user = null, now = Date.now() } = {}) {
  await ensureNotifySchema(DB);
  const until = now + Math.max(5, Math.min(PAUSE_MAX_MIN, Number(minutes) || PAUSE_MAX_MIN)) * 60 * 1000;
  await setState(DB, 'pause', { until, by: user, from: now, email: /@/.test(user || '') ? user : null }, now);
  return pauseState(DB, now);
}

export async function resumeEmails(DB, { now = Date.now() } = {}) {
  await ensureNotifySchema(DB);
  await setState(DB, 'pause', null, now);
  return pauseState(DB, now);
}

/** When a pause runs out: tell whoever started it what's being held */
async function endPauseIfDue(env, now) {
  const p = await getState(env.DB, 'pause');
  if (!p || p.until > now) return;
  await setState(env.DB, 'pause', null, now);
  const { held } = await pauseState(env.DB, now);
  if (p.email && held.length) {
    const n = held.length;
    const rows = held.map(h => panel(`<div class="ink" style="font-family:${SANS};font-size:16px;font-weight:700;color:#2D2E33;">${esc(h.name || 'A family')}</div><div style="margin-top:8px;line-height:26px;">${pill(h.status)}</div>`)).join('');
    await sendEmails(env, {
      to: [p.email],
      subject: `Family emails are back on. ${n} ${n === 1 ? 'email is' : 'emails are'} held from the pause`,
      html: emailShell({
        preheader: `${n} status ${n === 1 ? 'email was' : 'emails were'} held while family emails were paused. They only go if someone sends them.`,
        eyebrow: 'Applicants · Status emails',
        heading: 'Family emails are back on',
        intro: `The pause you started has ended. While it was on, these ${n === 1 ? 'status change was' : `${n} status changes were`} held, and ${n === 1 ? 'it won’t' : 'they won’t'} be emailed unless someone sends ${n === 1 ? 'it' : 'them'}.`,
        bodyHtml: `${rows}<div style="margin-top:6px;">${button('Decide in the admin', `${SITE_ORIGIN}/admin/#applications/applicants`)}</div>`,
        footerHtml: 'You’re getting this because you paused family emails from the admin.',
      }),
      text: `The pause ended. Held: ${held.map(h => `${h.name} (${h.status})`).join(', ')}. Decide in the admin: ${SITE_ORIGIN}/admin/#applications/applicants`,
      tags: [{ name: 'type', value: 'applicant-status-pause' }],
    }).catch(() => {});
  }
}

/** The emails held during a pause: send them all, or treat the families as told */
export async function resolveHeld(env, { send, user = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const { results } = await DB.prepare("SELECT * FROM applicant_notify WHERE hold = 'paused' AND kind IS NOT NULL").all();
  let n = 0;
  for (const row of results || []) {
    if (send) {
      // Someone chose to send these: no wait, no summary first
      await putRow(DB, { ...row, hold: null, due_at: Math.min(row.due_at || now, now), summary_at: now - AFTER_SUMMARY_MS }, now);
      await log(DB, row.account_id, { title: `Released: ${LABEL[row.kind]} email`, body: 'Held during a pause; sending now.', by: user, source: 'website' }, now);
    } else {
      await putRow(DB, { ...row, told: row.status, kind: null, due_at: null, hold: null, token: null }, now);
      await log(DB, row.account_id, { title: `Not emailed: ${LABEL[row.kind]}`, body: 'Held during a pause, then dismissed.', by: user, source: 'website' }, now);
    }
    n++;
  }
  if (send) await runNotifications(env, { fetchImpl, now, limit: 50 });
  return { count: n };
}

// ─── Corrections ────────────────────────────────────────────────────

const WHERE_IT_STANDS = {
  en: {
    '': 'We will be in touch soon with an update on your application.',
    Applied: 'Your application is still being reviewed, and we will be in touch.',
    'In Review': 'Your application is moving forward to the on-site visit, and we will contact you to schedule it.',
    Approved: "Your application has been approved, and your child's makeover is on our waitlist. We will be in touch with next steps.",
    Denied: 'We will be in touch soon with an update on your application.',
  },
  es: {
    '': 'Pronto nos comunicaremos con usted con una actualización sobre su solicitud.',
    Applied: 'Su solicitud todavía está en revisión y nos comunicaremos con usted.',
    'In Review': 'Su solicitud avanza a la visita en persona y le contactaremos para programarla.',
    Approved: 'Su solicitud fue aprobada y la remodelación de su hijo o hija está en nuestra lista de espera. Nos comunicaremos con usted para los siguientes pasos.',
    Denied: 'Pronto nos comunicaremos con usted con una actualización sobre su solicitud.',
  },
};

/** Was this family emailed a status that isn't where things stand now (and no email will fix it)? */
export function correctionNeeded(row) {
  if (!row?.told || !row.told_at || !known(row.status)) return false;
  return row.status !== row.told && !needsEmail(row.status, row.told);
}

/** A ready-to-edit correction in the family's language */
export async function correctionDraft(env, accountId, { fetchImpl = fetch } = {}) {
  const applicant = await readApplicant(env, accountId, fetchImpl);
  if (!applicant) throw new Error('That account isn’t a SOARD customer in JobTread');
  const lang = (await applicationLang(env.DB, accountId)) || applicant.lang || 'en';
  const live = await getLiveForm(env.DB);
  const template = resolveForm(live.definition, { lang }).messages?.correction || DEFAULT_MESSAGES.correction;
  return {
    lang,
    to: applicant.primary?.email ? { name: applicant.primary.name, email: applicant.primary.email } : null,
    subject: lang === 'es' ? 'Una actualización sobre su solicitud' : 'An update on your application',
    message: renderMessage(template, { parent: applicant.primary?.name || 'Hello', child: applicant.name, status: WHERE_IT_STANDS[lang]?.[applicant.status || ''] || WHERE_IT_STANDS.en[''] }),
  };
}

/** Send a correction (staff wrote or approved it); the family now knows the current status */
export async function sendCorrection(env, accountId, { subject, message, user = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureNotifySchema(DB);
  const applicant = await readApplicant(env, accountId, fetchImpl);
  if (!applicant) throw new Error('That account isn’t a SOARD customer in JobTread');
  if (!applicant.primary?.email) throw new Error('This family has no email address in JobTread');
  const text = String(message || '').trim();
  if (!text) throw new Error('Write the correction first');
  const commentId = await postAccountComment(env, {
    accountId, name: String(subject || '').trim().slice(0, 128) || 'An update on your application', message: text,
    assignTo: { name: applicant.primary.name, email: applicant.primary.email },
  }, fetchImpl);
  const row = await getRow(DB, accountId);
  await putRow(DB, { ...(row || { account_id: accountId, name: applicant.name, since: iso(now) }), status: applicant.status || '', told: applicant.status || '', told_at: iso(now), kind: null, due_at: null, hold: null, token: null, note_due: null }, now);
  await log(DB, accountId, { title: 'Correction sent to the family', body: text.slice(0, 2000), by: user, source: 'website', data: { commentId } }, now);
  return { commentId, to: { name: applicant.primary.name, email: applicant.primary.email } };
}

// ─── For the admin ──────────────────────────────────────────────────

/** Every family with something pending or needing a correction: { id: { kind, dueAt, hold, told, correction } } */
export async function notifyMap(DB) {
  await ensureNotifySchema(DB);
  const { results } = await DB.prepare('SELECT * FROM applicant_notify WHERE kind IS NOT NULL OR told_at IS NOT NULL').all();
  const out = {};
  for (const r of results || []) {
    const correction = correctionNeeded(r);
    if (!r.kind && !correction) continue;
    out[r.account_id] = { kind: r.kind, label: r.kind ? LABEL[r.kind] : null, dueAt: r.due_at, hold: r.hold, told: r.told, toldAt: r.told_at, status: r.status, previous: r.previous, correction, by: r.by_name, via: r.via };
  }
  return out;
}

export async function notifyFor(DB, id) {
  await ensureNotifySchema(DB);
  const r = await getRow(DB, id);
  if (!r) return null;
  return { kind: r.kind, label: r.kind ? LABEL[r.kind] : null, dueAt: r.due_at, hold: r.hold, told: r.told, toldAt: r.told_at, status: r.status, previous: r.previous, correction: correctionNeeded(r), by: r.by_name, via: r.via };
}

/** Anything overdue by 10 minutes means the sweep isn't running */
export async function overdueCount(DB, now = Date.now()) {
  await ensureNotifySchema(DB);
  const r = await DB.prepare('SELECT COUNT(*) AS n FROM applicant_notify WHERE kind IS NOT NULL AND hold IS NULL AND due_at < ?').bind(now - 10 * 60 * 1000 - AFTER_SUMMARY_MS).first();
  return r?.n || 0;
}
