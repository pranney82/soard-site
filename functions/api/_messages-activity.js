/**
 * What went out, and what goes next (Site → Emails & invites → What went out)
 * ==========================================================================
 * The admin's timeline of every message, read from where each one is
 * already recorded:
 *  - emails the site sent through Resend, one row per person, with Resend's
 *    report (email_log, _email-log.js);
 *  - JobTread status emails and staff notes (applicant_comms, applicant_activity);
 *  - reveal calendar invites (reveal_invite_log);
 *  - reveal reminders' browser alerts and Kit's "we're live" (broadcast_sends);
 *  - the applications-open email through Kit (waitlist_openings, with Kit's numbers);
 *  - newsletter drafts pushed to Kit (audit_log), and the last staff text.
 * On the first page, Kit's own numbers for its latest "we're live" emails,
 * and for the invites out now, how guests answered (Google Calendar; counts only).
 * And what's coming up: family status emails waiting out their quiet time,
 * application reminders, reveal reminders for the next reveal, the
 * applications-open email.
 *
 * Plus whether mail can land: SPF, DKIM and DMARC on each sending domain
 * (public DNS over HTTPS, no key), and bounce and spam rates from email_log.
 *
 * Addresses and names are in here (it's for staff, behind Access); the map's
 * facts (messages-admin GET) stay counts only.
 */

import { ensureEmailLog, entryFor, trackingState, fixFor } from './_email-log.js';
import { readState, readConfig, kitLiveWanted } from './_broadcast.js';
import { readAlertTexts } from './_broadcast-notify.js';
import { formFor } from './_application-forms.js';
import { SANDBOX_JOB_ID, readConfig as readInviteConfig } from './_reveal-invites.js';
import { accessToken, getEvent } from './_google-calendar.js';
import { kitBroadcastStats } from './_kit.js';

const MIN = 60e3;
const DAY = 864e5;
const iso = (t) => new Date(t).toISOString();
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
// SQLite datetime() stamps are UTC without a zone
const isoOf = (t) => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? `${t.replace(' ', 'T')}Z` : t || null);
const rows = async (stmt) => (await stmt.all().catch(() => null))?.results || [];
// The same query with the applicants mirror for names, or without it before that table exists
const rowsNamed = async (DB, sql, plain, ...binds) => {
  const named = await DB.prepare(sql).bind(...binds).all().catch(() => null);
  return named?.results || rows(DB.prepare(plain).bind(...binds));
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lower = (s) => String(s || '').trim().toLowerCase();
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const possessive = (name) => (name ? `${name}${/s$/i.test(name) ? '’' : '’s'}` : '');

const COMMS_ENTRY = { welcome: 'app-welcome', inReview: 'app-in-review', approved: 'app-approved', denied: 'app-denied', medical: 'staff-medical' };
const NOTIFY_ENTRY = { welcome: 'app-welcome', inReview: 'app-in-review', approved: 'app-approved', denied: 'app-denied' };
const REMINDER_ENTRY = { scheduled: 'rem-scheduled', moved: 'rem-moved', day: 'rem-day', hour: 'rem-hour', live: 'rem-live', replay: 'rem-replay' };
const FINAL_BAD = new Set(['bounced', 'complained', 'failed', 'suppressed']);

// ─── Names for addresses (families and staff the site knows) ────────
async function namesFor(DB, addrs) {
  const out = new Map();
  const list = [...new Set(addrs.map(lower).filter(Boolean))].slice(0, 200);
  if (!list.length) return out;
  const marks = list.map(() => '?').join(',');
  for (const r of await rows(DB.prepare(`SELECT lower(parent_email) AS e, parent_name, child_name FROM applications WHERE lower(parent_email) IN (${marks}) ORDER BY submitted_at DESC`).bind(...list))) {
    if (!out.has(r.e)) out.set(r.e, r.child_name ? `${r.parent_name || 'The family'} (${possessive(first(r.child_name))} family)` : r.parent_name || null);
  }
  for (const r of await rows(DB.prepare(`SELECT lower(contact_email) AS e, contact_name, name FROM applicants WHERE lower(contact_email) IN (${marks})`).bind(...list))) {
    if (!out.has(r.e)) out.set(r.e, r.contact_name ? `${r.contact_name}${r.name ? ` (${r.name})` : ''}` : r.name || null);
  }
  return out;
}

// ─── The timeline ───────────────────────────────────────────────────

/**
 * The newest messages first, before `before` (ISO), up to `limit`.
 * q finds a person (address or name) or a subject. → { items, more }
 */
export async function activity(env, { before = null, limit = 150, q = '', now = Date.now(), fetchImpl = fetch } = {}) {
  const DB = env.DB;
  await ensureEmailLog(DB).catch(() => {});
  const until = before || iso(now + MIN);
  const since = iso(now - 120 * DAY);
  const needle = lower(q).slice(0, 80);
  const take = Math.min(400, Math.max(20, Number(limit) || 150));
  const items = [];

  // Emails from the site, each person's own
  const emailRows = await rows(needle
    ? DB.prepare(`SELECT * FROM email_log WHERE sent_at < ? AND sent_at >= ? AND (instr(lower(to_addr), ?) > 0 OR instr(lower(subject), ?) > 0) ORDER BY sent_at DESC LIMIT ?`).bind(until, since, needle, needle, take)
    : DB.prepare('SELECT * FROM email_log WHERE sent_at < ? AND sent_at >= ? ORDER BY sent_at DESC LIMIT ?').bind(until, since, take));
  const names = await namesFor(DB, emailRows.map((r) => r.to_addr));
  for (const r of emailRows) {
    const entry = entryFor(r.type, r.subject);
    items.push({
      key: `e:${r.id}`, at: r.sent_at, entry, channel: 'email', sender: 'resend',
      to: r.to_addr, who: names.get(lower(r.to_addr)) || null, subject: r.subject,
      status: r.status, statusAt: r.status_at, detail: r.detail, bounceType: r.bounce_type || null,
      opened: r.opened_at || null, clicked: r.clicked_at || null, emailId: r.id,
      fix: FINAL_BAD.has(r.status) || r.status === 'delayed' ? fixFor(entry, r.status, r.bounce_type) : null,
    });
  }
  const trackedSince = (await DB.prepare('SELECT min(sent_at) AS at FROM email_log').first('at').catch(() => null)) || null;

  // JobTread: status emails to families and the medical note for staff
  const comms = await rowsNamed(DB, `SELECT c.account_id, c.kind, c.state, c.detail, c.updated_at, a.name, a.contact_name, a.contact_email
    FROM applicant_comms c LEFT JOIN applicants a ON a.account_id = c.account_id
    WHERE c.state IN ('sent', 'failed') AND c.updated_at < ? AND c.updated_at >= ? ORDER BY c.updated_at DESC LIMIT ?`,
  `SELECT account_id, kind, state, detail, updated_at FROM applicant_comms WHERE state IN ('sent', 'failed') AND updated_at < ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`, until, since, take);
  for (const r of comms) {
    const staffNote = r.kind === 'medical';
    items.push({
      key: `c:${r.account_id}:${r.kind}`, at: r.updated_at, entry: COMMS_ENTRY[r.kind] || null, channel: 'jobtread', sender: 'jobtread',
      who: staffNote ? `Staff, on ${possessive(r.name) || 'the family’s'} JobTread page` : (r.contact_name || r.name ? `${r.contact_name || 'The family'}${r.name && r.contact_name ? ` (${r.name})` : r.name ? ` (${r.name})` : ''}` : 'The family'),
      to: staffNote ? null : r.contact_email || null,
      status: r.state === 'sent' ? (staffNote ? 'noted' : 'posted') : 'failed', detail: r.state === 'failed' ? String(r.detail || '').slice(0, 200) : null,
      link: `#applications/applicants/${encodeURIComponent(r.account_id)}`, name: r.name || null,
    });
  }
  // Corrections and notes staff sent from Applicants
  const acts = await rowsNamed(DB, `SELECT v.id, v.account_id, v.at, v.kind, v.by_name, v.title, a.name, a.contact_name
    FROM applicant_activity v LEFT JOIN applicants a ON a.account_id = v.account_id
    WHERE ((v.kind = 'notify' AND v.title = 'Correction sent to the family') OR v.kind = 'sent') AND v.at < ? AND v.at >= ? ORDER BY v.at DESC LIMIT ?`,
  `SELECT id, account_id, at, kind, by_name, title FROM applicant_activity WHERE ((kind = 'notify' AND title = 'Correction sent to the family') OR kind = 'sent') AND at < ? AND at >= ? ORDER BY at DESC LIMIT ?`, until, since, take);
  for (const r of acts) {
    items.push({
      key: `a:${r.id}`, at: r.at, entry: r.kind === 'sent' ? 'app-note' : 'app-correction', channel: 'jobtread', sender: 'jobtread',
      who: r.contact_name || r.name ? `${r.contact_name || 'The family'}${r.name ? ` (${r.name})` : ''}` : 'The family',
      status: 'posted', by: r.by_name || null, link: `#applications/applicants/${encodeURIComponent(r.account_id)}`, name: r.name || null,
    });
  }

  // Reveal invites. Google sends the invitation and the updates, and who hears depends on what
  // changed: a new guest gets the invite and nobody else is emailed; a new date or new details go
  // to everyone. A quiet update (staff guests only) and the site's own notes send nothing.
  const invites = await rowsNamed(DB, `SELECT l.id, l.job_id, l.action, l.state, l.guests, l.reveal_date, l.created_at,
      (SELECT name FROM applicants WHERE job_id = l.job_id LIMIT 1) AS name
    FROM reveal_invite_log l WHERE l.created_at >= ? ORDER BY l.created_at`,
  'SELECT id, job_id, action, state, guests, reveal_date, created_at FROM reveal_invite_log WHERE created_at >= ? ORDER BY created_at', iso(now - 150 * DAY));
  const kidNames = new Map((await rows(DB.prepare("SELECT json_extract(data, '$.jobtreadJobId') AS job, json_extract(data, '$.name') AS name FROM kids WHERE json_extract(data, '$.jobtreadJobId') IS NOT NULL")))
    .map((r) => [String(r.job), r.name]));
  const lastOf = new Map();
  const dayOf = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : null);
  const inviteRows = [];
  const runOf = new Map(); // job → its last "guests added" row, so a burst of additions reads as one
  for (const r of invites) {
    const prev = lastOf.get(r.job_id);
    lastOf.set(r.job_id, r);
    const act = String(r.action || '');
    if (act === 'updated quietly' || act.startsWith('kept')) continue;
    if (r.created_at >= until || r.created_at < since) continue;
    const test = String(r.job_id) === String(SANDBOX_JOB_ID);
    const kid = kidNames.get(String(r.job_id)) || (r.name ? first(r.name) : null);
    const g = Number(r.guests) || 0;
    const subject = kid ? `${possessive(kid)} Reveal Day${r.state === 'tentative' ? ' (tentative)' : ''}` : null;
    const base = { key: `i:${r.id}`, at: r.created_at, channel: 'invite', sender: 'google', subject, count: r.guests ?? null, revealDate: r.reveal_date || null, test };
    if (act === 'cancelled') { inviteRows.push({ ...base, entry: 'invite-cancel', who: test ? 'You (a TEST invite on the office sandbox job)' : plural(g, 'guest'), status: 'cancelled' }); continue; }
    if (act.startsWith('cancelled in Google')) { inviteRows.push({ ...base, entry: null, subject: `${subject || 'A reveal invite'}, cancelled in Google Calendar`, who: plural(g, 'guest'), status: 'cancelled', note: 'Staff cancelled it in Google Calendar, and Google told the guests.' }); continue; }
    if (test) { inviteRows.push({ ...base, entry: 'preview', who: 'You (a TEST invite on the office sandbox job)', status: 'sent' }); continue; }
    if (act === 'created') { inviteRows.push({ ...base, entry: r.state === 'confirmed' ? 'invite-confirmed' : 'invite-tentative', who: `${plural(g, 'guest')}${kid ? ` for ${possessive(kid)} reveal` : ''}`, status: 'sent', note: 'Google sent the invitation to every guest.' }); continue; }
    // Updated: what changed decides who Google emailed
    const moved = prev && prev.reveal_date && r.reveal_date && prev.reveal_date !== r.reveal_date;
    const confirmed = prev && prev.state !== 'confirmed' && r.state === 'confirmed';
    const added = prev && !moved && !confirmed && g > (Number(prev.guests) || 0) ? g - (Number(prev.guests) || 0) : 0;
    const run = runOf.get(r.job_id);
    if (added && run && Date.parse(r.created_at) - Date.parse(run.at) <= 30 * MIN) {
      run.added += added;
      run.at = r.created_at;
      run.key = `i:${r.id}`;
      run.count = r.guests ?? run.count;
      run.who = `${plural(run.added, 'new guest')}${kid ? ` on ${possessive(kid)} invite` : ''}`;
      run.note = `Added ${new Date(run.from).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} to ${new Date(r.created_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}. Google emailed only the new guests; everyone else’s calendar updated quietly.`;
      continue;
    }
    runOf.delete(r.job_id);
    inviteRows.push({
      ...base, entry: confirmed ? 'invite-confirmed' : 'invite-update', status: 'sent',
      who: added ? `${plural(added, 'new guest')}${kid ? ` on ${possessive(kid)} invite` : ''}` : `${plural(g, 'guest')}${kid ? ` for ${possessive(kid)} reveal` : ''}`,
      note: moved ? `Moved to ${dayOf(r.reveal_date)}: Google emailed every guest the new date.`
        : confirmed ? 'Confirmed with a time: Google emailed every guest.'
        : added ? `Google emailed only the ${added === 1 ? 'new guest' : 'new guests'}; everyone else’s calendar updated quietly.`
        : 'Google emailed every guest the new details.',
      ...(added ? { added, from: r.created_at } : {}),
    });
    if (added) runOf.set(r.job_id, inviteRows[inviteRows.length - 1]);
  }
  items.push(...inviteRows);

  // Reveal reminders' browser alerts and Kit's "we're live" (emails are in the log once it began)
  const sends = await rowsNamed(DB, `SELECT s.id, s.broadcast_id, s.kind, s.channel, s.recipients, s.sent, s.failed, s.error, s.created_at, b.kid_name
    FROM broadcast_sends s LEFT JOIN broadcasts b ON b.id = s.broadcast_id
    WHERE s.created_at < ? AND s.created_at >= ? AND (s.sent > 0 OR s.failed > 0) ORDER BY s.created_at DESC LIMIT ?`,
  'SELECT id, broadcast_id, kind, channel, recipients, sent, failed, error, created_at FROM broadcast_sends WHERE created_at < ? AND created_at >= ? AND (sent > 0 OR failed > 0) ORDER BY created_at DESC LIMIT ?', until, since, take);
  for (const r of sends) {
    if (r.channel === 'email' && trackedSince && r.created_at >= trackedSince) continue;
    const kit = r.channel === 'kit';
    items.push({
      key: `b:${r.id}`, at: r.created_at, entry: kit ? 'kit-live' : REMINDER_ENTRY[r.kind] || null, channel: kit ? 'kit' : r.channel === 'push' ? 'push' : 'email',
      sender: kit ? 'kit' : r.channel === 'push' ? 'push' : 'resend',
      who: kit ? 'The newsletter list in Kit' : `${plural(r.sent || 0, 'person', 'people')}${r.kid_name ? ` watching for ${possessive(r.kid_name)} reveal` : ''}`,
      count: kit ? null : r.sent || 0, failedCount: r.failed || 0,
      status: r.failed && !r.sent ? 'failed' : kit ? 'handed' : 'sent', detail: r.failed ? `${r.failed} didn’t go${r.error ? `: ${String(r.error).slice(0, 140)}` : ''}.` : null,
      broadcastId: kit ? r.broadcast_id : null,
    });
  }
  // Kit's numbers for its three latest "we're live" emails (the first page only)
  if (!before && env.KIT_API_KEY) {
    await Promise.all(items.filter((x) => x.broadcastId).slice(0, 3).map(async (x) => {
      const data = parse(await DB.prepare('SELECT data FROM broadcasts WHERE id = ?').bind(x.broadcastId).first('data').catch(() => null), {}) || {};
      const id = data.kit?.live?.id;
      if (!id) return;
      const st = await kitBroadcastStats(env, id).catch(() => null);
      if (st?.ok && st.recipients != null) x.kit = { recipients: st.recipients, opened: st.opened || 0, openRate: st.openRate != null ? Math.round(st.openRate) : (st.recipients ? Math.round(((st.opened || 0) / st.recipients) * 100) : null) };
    }));
  }

  // The applications-open email (Kit sends it; the site emails families Kit can't reach)
  for (const r of await rows(DB.prepare("SELECT * FROM waitlist_openings WHERE state IN ('sending', 'sent') AND COALESCE(sent_at, opened_at) < ? ORDER BY opened_at DESC LIMIT 10").bind(until))) {
    const b = parse(r.broadcasts, {}) || {};
    const stats = Object.values(b).map((x) => x?.stats).filter(Boolean);
    const recipients = stats.reduce((n, s) => n + (s.recipients || 0), 0);
    const opened = stats.reduce((n, s) => n + (s.opened || 0), 0);
    items.push({
      key: `w:${r.id}`, at: r.sent_at || r.opened_at, entry: 'waitlist-open', channel: 'kit', sender: 'kit',
      who: `${plural(r.total || recipients || 0, 'family', 'families')} on the waitlist`, count: r.total || recipients || 0,
      status: r.state === 'sent' ? 'handed' : 'sending',
      kit: stats.length ? { recipients, opened, openRate: recipients ? Math.round((opened / recipients) * 100) : null } : null,
    });
  }

  // Newsletter drafts pushed to Kit
  for (const r of await rows(DB.prepare("SELECT id, user_email, entity_name, created_at FROM audit_log WHERE entity_type = 'email-broadcast' AND created_at < ? ORDER BY created_at DESC LIMIT 20").bind(until.replace('T', ' ').slice(0, 19)))) {
    items.push({
      key: `n:${r.id}`, at: isoOf(r.created_at), entry: 'newsletter', channel: 'kit', sender: 'kit',
      who: 'A draft in Kit, for staff to send', subject: r.entity_name || null, status: 'draft', by: r.user_email ? String(r.user_email).split('@')[0] : null,
    });
  }

  // The last staff text, and whether each phone got it
  const texts = await readAlertTexts(DB).catch(() => ({}));
  if (texts?.last?.at && texts.last.at < until) {
    const nums = Object.entries(texts.numbers || {}).filter(([, v]) => v?.at && v.at >= texts.last.at);
    const missed = nums.filter(([, v]) => v.status !== 'delivered');
    items.push({
      key: `t:${texts.last.at}`, at: texts.last.at, entry: textEntry(texts.last.title), channel: 'text', sender: 'twilio',
      who: plural((texts.last.sent || 0) + (texts.last.failed || 0), 'staff phone'), subject: texts.last.title, count: texts.last.sent || 0,
      status: missed.length ? 'failed' : nums.length ? 'delivered' : texts.last.sent ? 'sent' : 'failed',
      detail: missed.length ? `${plural(missed.length, 'phone')} didn’t get it${missed[0][1].error ? `: ${missed[0][1].error}` : ''}.` : texts.last.error || null,
    });
  }

  let list = items.filter((x) => x.at && x.at < until);
  if (needle) list = list.filter((x) => [x.to, x.who, x.subject, x.name].some((v) => lower(v).includes(needle)));
  list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const more = list.length > take;
  return { items: list.slice(0, take), more, trackedSince };
}

/** Which staff text it was, from its title */
export function textEntry(title = '') {
  const t = String(title);
  if (/^(Go|Live now|All green|No-go)\b/.test(t)) return 'staff-reveal-texts';
  return 'staff-problem-texts';
}

// ─── Invites out now, and how guests answered ───────────────────────

const INVITE_CACHE = new Map(); // event id → { at, answers }
/**
 * The reveals with an invite on calendars now, soonest first, and for each
 * how many guests said yes, no or maybe, or haven't answered (Google
 * Calendar, cached 10 minutes). Counts only, never who.
 */
export async function invitesOut(env, { now = Date.now(), fetchImpl = fetch, max = 6 } = {}) {
  const DB = env.DB;
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const list = (await rowsNamed(DB, `SELECT r.job_id, r.event_id, r.state, r.reveal_date, r.guests, (SELECT name FROM applicants WHERE job_id = r.job_id LIMIT 1) AS name
      FROM reveal_invites r WHERE r.state IN ('tentative', 'confirmed') AND r.reveal_date >= ? ORDER BY r.reveal_date LIMIT ?`,
    "SELECT job_id, event_id, state, reveal_date, guests FROM reveal_invites WHERE state IN ('tentative', 'confirmed') AND reveal_date >= ? ORDER BY reveal_date LIMIT ?", today, max + 1))
    .filter((r) => String(r.job_id) !== String(SANDBOX_JOB_ID)).slice(0, max);
  if (!list.length) return [];
  const kidNames = new Map((await rows(DB.prepare("SELECT json_extract(data, '$.jobtreadJobId') AS job, json_extract(data, '$.name') AS name FROM kids WHERE json_extract(data, '$.jobtreadJobId') IS NOT NULL")))
    .map((r) => [String(r.job), r.name]));
  const cfg = await readInviteConfig(DB).catch(() => ({}));
  let token = null;
  if (env.GOOGLE_CALENDAR_KEY && cfg.organizer) token = await accessToken(env, cfg.organizer, { fetchImpl, now }).catch(() => null);
  return Promise.all(list.map(async (r) => {
    let guests = null;
    try { guests = JSON.parse(r.guests || 'null')?.length ?? null; } catch { /* unknown */ }
    let answers = null;
    const hit = INVITE_CACHE.get(r.event_id);
    if (hit && now - hit.at < 10 * MIN) answers = hit.answers;
    else if (token && r.event_id) {
      const ev = await getEvent(token, cfg.organizer, r.event_id, { fetchImpl }).catch(() => null);
      const people = (ev?.attendees || []).filter((a) => !a.organizer && !a.self && !a.resource);
      if (ev) {
        answers = { yes: 0, no: 0, maybe: 0, waiting: 0 };
        for (const a of people) answers[{ accepted: 'yes', declined: 'no', tentative: 'maybe' }[a.responseStatus] || 'waiting'] += 1;
        guests = people.length || guests;
        INVITE_CACHE.set(r.event_id, { at: now, answers });
      }
    }
    const kid = kidNames.get(String(r.job_id)) || (r.name ? first(r.name) : null);
    return { jobId: String(r.job_id), kid, date: r.reveal_date, state: r.state, guests, answers };
  }));
}

// ─── Coming up ──────────────────────────────────────────────────────

/** What goes out next, soonest first, within `days`. → [{ at, entry, who, count, note, held }] */
export async function comingUp(env, { now = Date.now(), days = 14 } = {}) {
  const DB = env.DB;
  const horizon = now + days * DAY;
  const out = [];

  // Family status emails waiting out their quiet time (or held by a pause)
  for (const r of await rows(DB.prepare('SELECT account_id, name, kind, due_at, hold, status FROM applicant_notify WHERE kind IS NOT NULL AND due_at IS NOT NULL ORDER BY due_at LIMIT 60'))) {
    if (!NOTIFY_ENTRY[r.kind]) continue;
    out.push({
      key: `n:${r.account_id}`, at: iso(Math.max(now, Number(r.due_at))), entry: NOTIFY_ENTRY[r.kind], channel: 'jobtread',
      who: r.name ? `${possessive(r.name)} family` : 'A family', held: !!r.hold,
      note: r.hold ? 'Held by the pause: it goes only if someone sends it.' : `Status ${r.status || ''} has to stay put until then.`.replace('  ', ' '),
      link: `#applications/applicants/${encodeURIComponent(r.account_id)}`,
    });
  }

  // "Your application is waiting": the same rule sendReminders (_applications.js) follows
  try {
    const live = await formFor(DB, { year: String(new Date(now).getUTCFullYear() + 1) });
    const ds = live.reminders?.enabled ? live.reminders.days || [] : [];
    if (ds.length && env.RESEND_API_KEY) {
      for (const r of await rows(DB.prepare(`SELECT * FROM application_drafts WHERE submitted_id IS NULL AND email IS NOT NULL AND verified = 1
          AND COALESCE(reminders_sent, 0) < ? ORDER BY updated_at LIMIT 200`).bind(ds.length))) {
        if (r.cleared_at || r.test_by || Number(r.reminders_off) || r.stop_key) continue;
        const n = Number(r.reminders_sent) || 0;
        const due = Math.max(Date.parse(r.updated_at) + ds[n] * DAY, r.last_reminder_at ? Date.parse(r.last_reminder_at) + DAY : 0);
        if (!Number.isFinite(due) || due > horizon) continue;
        const a = parse(r.answers, {}) || {};
        const parent = [a.parentName?.first, a.parentName?.last].filter(Boolean).join(' ');
        out.push({
          key: `d:${r.id}`, at: iso(Math.max(now, due)), entry: 'app-reminder', channel: 'email', to: r.email,
          who: parent || r.email, note: `Reminder ${n + 1} of ${ds.length}. It stops the moment they finish or tap “Stop these reminders”.`,
        });
      }
    }
  } catch { /* no drafts table yet */ }

  // The next reveal's reminders
  try {
    const [state, config] = await Promise.all([readState(DB), readConfig(DB)]);
    const at = Date.parse(state?.scheduledAt || '');
    if (state?.phase === 'scheduled' && Number.isFinite(at) && at > now && at <= horizon) {
      const kid = state.kidName || null;
      const whose = kid ? `${possessive(kid)} reveal` : 'the reveal';
      const subs = await DB.prepare("SELECT count(*) AS n FROM broadcast_reminders WHERE unsubscribed_at IS NULL AND (kid_slug IS NULL OR kid_slug = '' OR kid_slug = ?)").bind(state.kidSlug || '').first('n').catch(() => 0);
      const done = await rows(DB.prepare('SELECT kind, channel FROM broadcast_sends WHERE broadcast_id = ?').bind(state.broadcastId || ''));
      const sent = new Set(done.map((r) => (r.channel === 'kit' ? `${r.kind}:kit` : r.kind)));
      const on = !!config.reminders?.enabled;
      const hours = config.reminders?.hoursBefore || [24, 1];
      const who = `${plural(Number(subs) || 0, 'person', 'people')} signed up for ${whose}`;
      const add = (kind, t, note) => { if (t > now && !sent.has(kind)) out.push({ key: `r:${kind}`, at: iso(t), entry: REMINDER_ENTRY[kind], channel: 'email', who, count: Number(subs) || 0, note, off: !on }); };
      if (hours.includes(24)) add('day', at - DAY, on ? null : 'Reminders are switched off in Reveals → Settings, so this won’t go.');
      if (hours.includes(1)) add('hour', at - 3600e3, on ? null : 'Reminders are switched off in Reveals → Settings, so this won’t go.');
      add('live', at, on ? 'When the stream goes live, so about this time.' : 'Reminders are switched off in Reveals → Settings, so this won’t go.');
      if (env.KIT_API_KEY && kitLiveWanted(state, config) && !sent.has('live:kit')) {
        out.push({ key: 'r:kit', at: iso(at + 3 * MIN), entry: 'kit-live', channel: 'kit', who: 'The newsletter list in Kit', note: 'Three minutes into a steady stream, once the kid is known.' });
      }
    }
  } catch { /* no broadcast yet */ }

  // The applications-open email
  try {
    const op = await DB.prepare("SELECT * FROM waitlist_openings WHERE state IN ('countdown', 'preparing', 'held') ORDER BY opened_at DESC LIMIT 1").first();
    const waiting = await DB.prepare("SELECT count(*) AS n FROM waitlist_signups WHERE opening_id IS NULL AND removed_at IS NULL").first('n').catch(() => 0);
    if (op?.send_at) {
      out.push({ key: `w:${op.id}`, at: iso(Math.max(now, Number(op.send_at))), entry: 'waitlist-open', channel: 'kit', who: plural(op.total || 0, 'family', 'families'), count: op.total || 0, held: op.state === 'held', note: op.state === 'held' ? 'On hold in Applications → Settings.' : 'Turned on by mistake? Turning applications off before then stops it.' });
    } else {
      const s = parse((await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first('data').catch(() => null)), {}) || {};
      const opens = Date.parse(s.application?.opensAt || '');
      if (!s.application?.open && Number.isFinite(opens) && opens > now && opens <= horizon && Number(waiting) > 0) {
        out.push({ key: 'w:scheduled', at: iso(opens), entry: 'waitlist-open', channel: 'kit', who: `${plural(Number(waiting), 'family', 'families')} on the waitlist`, count: Number(waiting), note: 'Applications are set to open then; the email goes at once.' });
      }
    }
  } catch { /* no waitlist yet */ }

  return out.filter((x) => Date.parse(x.at) <= horizon).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// ─── Delivery numbers for the map (counts only) ─────────────────────

// sent: every email; the rest by where each one is now (waiting: sent, no report yet)
const blank = () => ({ sent: 0, waiting: 0, delivered: 0, bounced: 0, complained: 0, delayed: 0, failed: 0, suppressed: 0, scheduled: 0, canceled: 0, opened: 0, last: null });

/** Per map entry over 30 days, the overall rates, and the tracking's state. Never an address. */
export async function deliveryFacts(env, { now = Date.now() } = {}) {
  const DB = env.DB;
  await ensureEmailLog(DB);
  const since = iso(now - 30 * DAY);
  const byEntry = {};
  const all = blank();
  for (const r of await rows(DB.prepare(`SELECT type, subject, status, count(*) AS n, sum(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened, max(sent_at) AS last
    FROM email_log WHERE sent_at >= ? GROUP BY type, subject, status`).bind(since))) {
    const e = entryFor(r.type, r.subject) || 'other';
    const b = (byEntry[e] ||= blank());
    for (const t of e === 'preview' ? [b] : [b, all]) {
      t.sent += r.n;
      const at = r.status === 'sent' ? 'waiting' : r.status;
      if (t[at] != null) t[at] += r.n;
      t.opened += r.opened || 0;
      if (!t.last || r.last > t.last) t.last = r.last;
    }
  }
  return { tracking: await trackingState(env), byEntry, all };
}

// ─── Will it land? ──────────────────────────────────────────────────

const DNS_CACHE = { at: 0, value: null };
async function txt(name, type = 'TXT', fetchImpl = fetch) {
  const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`DNS ${res.status}`);
  const body = await res.json();
  return (body.Answer || []).map((a) => String(a.data || '').replace(/^"|"$/g, '').replace(/" "/g, ''));
}
const dmarcPolicy = (recs) => {
  const r = recs.find((x) => /^v=DMARC1/i.test(x));
  if (!r) return null;
  return { p: (r.match(/;\s*p=(\w+)/i) || [])[1] || 'none', rua: (r.match(/rua=([^;]+)/i) || [])[1] || '' };
};

/**
 * SPF, DKIM and DMARC for the domains mail goes out from (public DNS, cached
 * 30 minutes), and the 30-day bounce and spam rates. Each check: { label, ok, note }.
 */
export async function deliverability(env, { now = Date.now(), fetchImpl = fetch, rates = null } = {}) {
  let domains = DNS_CACHE.value;
  if (!domains || now - DNS_CACHE.at > 30 * MIN) {
    const look = (n, t) => txt(n, t, fetchImpl).catch(() => null);
    const [spfR, mxR, dkimR, dmarcSub, dmarcRoot, spfS, dkimG, kitC, kitP, dmarcS] = await Promise.all([
      look('send.comms.sunshineonaranneyday.com'), look('send.comms.sunshineonaranneyday.com', 'MX'), look('resend._domainkey.comms.sunshineonaranneyday.com'),
      look('_dmarc.comms.sunshineonaranneyday.com'), look('_dmarc.sunshineonaranneyday.com'),
      look('soardcharity.com'), look('google._domainkey.soardcharity.com'), look('cka._domainkey.soardcharity.com', 'CNAME'), look('ckespa.soardcharity.com', 'CNAME'), look('_dmarc.soardcharity.com'),
    ]);
    const unknown = (v) => v === null;
    const dm = (sub, root) => {
      const own = sub && dmarcPolicy(sub);
      const p = own || (root && dmarcPolicy(root));
      if (!p) return { label: 'DMARC', ok: unknown(sub) && unknown(root) ? null : false, note: unknown(sub) && unknown(root) ? 'Couldn’t look it up.' : 'No DMARC record, so receivers can’t check the mail is really yours.' };
      const watching = p.p === 'none';
      const toCf = /cloudflare\.net/i.test(p.rua);
      return {
        label: 'DMARC', ok: true,
        note: `${watching ? 'Watching only (p=none): receivers report, nothing is blocked yet.' : `p=${p.p}: mail that fails is ${p.p === 'reject' ? 'refused' : 'sent to spam'}.`}${own && !toCf ? ' This subdomain has its own record, and its reports go only to the address in it, not to Cloudflare’s DMARC dashboard.' : ''}`,
        policy: p.p, ownRecord: !!own, reportsToCloudflare: toCf,
      };
    };
    const has = (recs, re) => (recs === null ? null : recs.some((r) => re.test(r)));
    domains = [
      {
        name: 'comms.sunshineonaranneyday.com', for: 'Resend: every email the site sends itself',
        checks: [
          { label: 'SPF', ok: has(spfR, /include:amazonses\.com/i), note: has(spfR, /include:amazonses\.com/i) ? 'Amazon SES (Resend) may send for it.' : 'Resend isn’t listed as a sender.' },
          { label: 'DKIM', ok: has(dkimR, /p=[A-Za-z0-9+/]{40,}/), note: has(dkimR, /p=[A-Za-z0-9+/]{40,}/) ? 'Every email is signed.' : 'Resend’s signing key isn’t published.' },
          { label: 'Bounces', ok: has(mxR, /amazonses\.com/i), note: has(mxR, /amazonses\.com/i) ? 'Bounces come back to Resend, which reports them here.' : 'Bounces have nowhere to go.' },
          dm(dmarcSub, dmarcRoot),
        ],
      },
      {
        name: 'soardcharity.com', for: 'Kit (the newsletter and waitlist), and Google Calendar invites',
        checks: [
          { label: 'SPF', ok: has(spfS, /include:_spf\.google\.com/i), note: has(spfS, /include:_spf\.google\.com/i) ? 'Google may send for it.' : 'Google isn’t listed as a sender.' },
          { label: 'DKIM (Google)', ok: has(dkimG, /p=[A-Za-z0-9+/]{40,}/), note: has(dkimG, /p=[A-Za-z0-9+/]{40,}/) ? 'Calendar invites and staff email are signed.' : 'Google’s signing key isn’t published.' },
          { label: 'DKIM (Kit)', ok: has(kitC, /convertkit\.com|kit\.com/i), note: has(kitC, /convertkit\.com|kit\.com/i) ? 'Kit signs as soardcharity.com.' : 'Kit isn’t set up to sign as soardcharity.com.' },
          { label: 'Kit’s return path', ok: has(kitP, /convertkit\.com|kit\.com/i), note: has(kitP, /convertkit\.com|kit\.com/i) ? 'Kit’s bounces come back under soardcharity.com, so SPF lines up.' : 'Kit’s return path isn’t set up, so SPF won’t line up for Kit’s mail.' },
          dm(dmarcS, null),
        ],
      },
    ];
    if (domains.some((d) => d.checks.some((c) => c.ok !== null))) { DNS_CACHE.at = now; DNS_CACHE.value = domains; }
  }
  // Out of the emails Resend has reported on (one still waiting is neither good nor bad yet).
  // Resend asks for bounces under 4% and spam reports under 0.08%.
  const r = { ...blank(), ...(rates || (await deliveryFacts(env, { now }).catch(() => null))?.all || {}) };
  const arrived = r.delivered + r.complained;
  const lost = r.bounced + r.failed + r.suppressed;
  const reported = arrived + lost;
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return {
    domains,
    rates: {
      sent: r.sent - r.scheduled - r.canceled, reported, delivered: arrived, bounced: r.bounced, complained: r.complained, failed: r.failed + r.suppressed, waiting: r.waiting + r.delayed,
      deliveredPct: pct(arrived, reported), bouncePct: pct(r.bounced, reported), spamPct: pct(r.complained, arrived),
      bounceOk: reported < 20 || r.bounced / reported < 0.04, spamOk: r.complained === 0 || r.complained / Math.max(1, arrived) < 0.0008,
    },
  };
}

// ─── One email, exactly as it went ──────────────────────────────────

/** The log row, every report Resend sent, and the email itself while Resend still has it */
export async function emailDetail(env, id, { fetchImpl = fetch } = {}) {
  const DB = env.DB;
  await ensureEmailLog(DB);
  const row = await DB.prepare('SELECT * FROM email_log WHERE id = ?').bind(String(id)).first();
  if (!row) return null;
  const events = await rows(DB.prepare('SELECT type, at, detail FROM email_events WHERE email_id = ? ORDER BY at').bind(row.id));
  let html = null, text = null, why = null;
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetchImpl(`https://api.resend.com/emails/${encodeURIComponent(row.id)}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(10000) });
      const b = await res.json().catch(() => ({}));
      if (res.ok) { html = b.html || null; text = b.text || null; if (!html && !text) why = 'Resend no longer has this email’s words.'; }
      else if ((res.status === 401 || res.status === 403) && /restricted/i.test(`${b.name} ${b.message}`)) why = 'The site’s Resend key can only send, so it can’t read the email back.';
      else if (res.status === 404) why = 'Resend no longer keeps this email.';
      else why = `Resend answered ${res.status}.`;
    } catch (e) { why = `Resend didn’t answer (${e.message}).`; }
  }
  return {
    id: row.id, entry: entryFor(row.type, row.subject), to: row.to_addr, subject: row.subject, sentAt: row.sent_at,
    status: row.status, statusAt: row.status_at, detail: row.detail, opened: row.opened_at, clicked: row.clicked_at,
    events: [{ type: row.status === 'scheduled' ? 'scheduled' : 'sent', at: row.sent_at, detail: null }, ...events.filter((e) => e.type !== 'sent' && e.type !== 'scheduled')],
    html, text, why,
  };
}
