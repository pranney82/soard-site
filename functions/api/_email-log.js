/**
 * Did the email arrive? (Site → Emails & invites → What went out)
 * ======================================================================
 * Every email the site sends through Resend (_broadcast-notify.js sendEmails
 * and sendEmailItems) is written to email_log with Resend's id, which message
 * it is (its tag) and the one address it went to. Resend then reports on each
 * one at /api/resend-webhook: delivered, bounced and why, marked as spam,
 * delayed, failed, opened, clicked. Each report is kept in email_events, so
 * the admin can show an email's whole day ("Sent 3:02 PM · Delivered 3:02 PM").
 *
 * No setup. The heartbeat (maybeTrackEmails) registers the webhook with
 * Resend itself and keeps its signing secret in email_tracking, a runtime
 * table (never site_config: site_config rows are written into builds and the
 * repo is public). RESEND_WEBHOOK_SECRET in Cloudflare, when set, is used
 * instead and nothing is registered. Every 30 minutes the same check reads
 * Resend's list of recent emails and fills in any report the webhook missed.
 * A Resend key that can only send ("Sending access") can do neither: the
 * admin says so in plain words, and sending carries on as before.
 *
 * Proof, once: when the webhook is first registered, the site emails Resend's
 * two test addresses (delivered@resend.dev, bounced@resend.dev: simulated,
 * never a real inbox, no harm to the sender's standing) and checks that both
 * reports came back through the webhook. The Automations map shows the result.
 *
 * Follow-ups, once per address a week:
 *  - a reveal reminder address that hard-bounces or reports spam is unsubscribed;
 *  - a family's or staff email that can't be delivered tells staff (Slack and
 *    email), with what to do.
 *
 * Rows older than 180 days are deleted.
 */

import { limit } from './_rate-limit.js';

const RESEND_API = 'https://api.resend.com';
export const WEBHOOK_PATH = '/api/resend-webhook';
const SITE = 'https://sunshineonaranneyday.com';
const MIN = 60e3;
const DAY = 864e5;
const CHECK_EVERY_MS = 30 * MIN;
const SEND_ONLY_RECHECK_MS = DAY;
const KEEP_MS = 180 * DAY;
const EVENTS = ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed', 'email.opened', 'email.clicked', 'email.scheduled'];
const iso = (t) => new Date(t).toISOString();

// ─── Schema ─────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS email_log (
    id TEXT PRIMARY KEY, type TEXT, to_addr TEXT, subject TEXT, sent_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent', status_at TEXT, detail TEXT, bounce_type TEXT,
    opened_at TEXT, clicked_at TEXT, source TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_email_log_sent ON email_log(sent_at)',
  'CREATE INDEX IF NOT EXISTS idx_email_log_to ON email_log(to_addr)',
  'CREATE INDEX IF NOT EXISTS idx_email_log_status ON email_log(status, sent_at)',
  `CREATE TABLE IF NOT EXISTS email_events (
    email_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, detail TEXT,
    PRIMARY KEY (email_id, type, at))`,
  // Runtime only: the webhook (with its signing secret) and the last check
  'CREATE TABLE IF NOT EXISTS email_tracking (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
export async function ensureEmailLog(DB) {
  if (!DB || _ready.has(DB)) return;
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  _ready.add(DB);
}

async function readKey(DB, key) {
  try {
    const v = await DB.prepare('SELECT value FROM email_tracking WHERE key = ?').bind(key).first('value');
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}
async function writeKey(DB, key, value, now = Date.now()) {
  await DB.prepare('INSERT INTO email_tracking (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), iso(now)).run();
}

// ─── Which message an email is ──────────────────────────────────────

/** A send's tag value, whatever the tag is called (type, category, kind) */
export function tagOf(tags) {
  if (!tags) return null;
  if (Array.isArray(tags)) return tags.find((t) => ['type', 'category', 'kind'].includes(t?.name))?.value || tags[0]?.value || null;
  if (typeof tags === 'object') return tags.type || tags.category || tags.kind || Object.values(tags)[0] || null;
  return null;
}

const BY_TAG = {
  'application-resume': 'app-resume',
  'application-reminder': 'app-reminder',
  application: 'staff-new-app',
  'application-stuck': 'staff-stuck',
  'applicant-status-summary': 'staff-summary',
  'applicant-status-pause': 'staff-pause-ended',
  'applicant-reply': 'staff-family-reply',
  'application-waitlist': 'waitlist-confirm',
  'application-waitlist-staff': 'staff-waitlist',
  'application-open': 'waitlist-open',
  'application-limit': 'staff-app-limit',
  'alert-hello': 'staff-alert-hello',
  'live-alert': 'staff-live-alert',
  'kid-status': 'staff-kid-hidden',
  'partner-logo': 'staff-partner-logo',
  'zeffy-alerts': 'staff-gift-problem',
  'reminder-confirm': 'rem-confirm',
  'reveal-scheduled': 'rem-scheduled',
  'reveal-moved': 'rem-moved',
  'reveal-day': 'rem-day',
  'reveal-hour': 'rem-hour',
  'reveal-live': 'rem-live',
  'reveal-replay': 'rem-replay',
  'advisory-application': 'advisory-thanks',
  'advisory-application-staff': 'advisory-staff',
  'board-packet': 'board-packet',
  'board-packet-preview': 'preview',
  'board-welcome': 'board-welcome',
  'board-welcome-preview': 'preview',
  'board-reminder': 'board-reminder',
  'board-reminder-preview': 'preview',
  'board-minutes': 'board-minutes',
  'board-minutes-preview': 'preview',
  'admin-preview': 'preview',
  'email-self-test': 'preview',
  'email-test': 'preview',
  'application-waitlist-test': 'preview',
};

/**
 * The map entry (its preview id, or its key) an email belongs to, from its tag
 * and, where one tag covers two messages, its subject. 'preview' is a copy
 * staff sent themselves. null: not one the map knows.
 */
export function entryFor(type, subject = '') {
  const s = String(subject || '');
  if (/^\[(preview|test|test run|rehearsal)\]\s|^TEST · |^\[SOARD Live\] TEST · |^\[SOARD\] TEST · /i.test(s)) return 'preview';
  if (type === 'reveal-invite-alert') return /still out/i.test(s) ? 'staff-invite-held' : 'staff-invite-problem';
  if (type === 'demo-invite-alert') return /still out|is waiting/i.test(s) ? 'staff-demo-heads-up' : 'staff-demo-problem';
  // Every staff alert (alertAdmins) shares one tag: its title says which it is
  if (type === 'live-alert' || /^\[SOARD Live\] /.test(s)) return alertEntry(s.replace(/^\[SOARD Live\] /, ''));
  if (type === 'application-waitlist' && /^(Applications are open|The applications-open email|Waitlist|Kit)/i.test(s)) return 'staff-waitlist';
  if (type === 'application' && /is stuck$/i.test(s)) return 'staff-stuck';
  if (type === 'application' && /^New community project application/i.test(s)) return 'staff-new-org';
  if (type && /^reveal-[a-z]+-test$/.test(type)) return 'preview';
  if (type && BY_TAG[type]) return BY_TAG[type];
  // Sent before the tag existed, or seen only in Resend's list: the subject is all there is
  if (/^Your SOARD application: pick up|^Su solicitud de SOARD: contin/i.test(s)) return 'app-resume';
  if (/^Your SOARD application is waiting|le está esperando/i.test(s)) return 'app-reminder';
  if (/^New makeover application/i.test(s)) return 'staff-new-app';
  if (/^New community project application/i.test(s)) return 'staff-new-org';
  if (/^You’re on the list|^You're on the list|^Ya está en la lista/i.test(s)) return 'waitlist-confirm';
  if (/^Application for .+ is stuck$/i.test(s)) return 'staff-stuck';
  // A status change summary about a TEST family is a test; any other is the real thing
  if (/ moved to .+ · family emails? (at|from)|^\d+ families moved · | was added as an applicant · /.test(s)) return /^TEST /.test(s) ? 'preview' : 'staff-summary';
  if (/^Family emails are back on\./.test(s)) return 'staff-pause-ended';
  if (/^You’ll get live reveal alerts|^You'll get live reveal alerts/.test(s)) return 'staff-alert-hello';
  if (/^\d[\d,]* of \d[\d,]* applications are in for |^Applications are closed for \d{4}: the limit|^Applications didn’t open on schedule/.test(s)) return 'staff-app-limit';
  if (/^Applications are open: apply|^Ya abrimos las solicitudes/.test(s)) return 'waitlist-open';
  if (/^We have your Advisory Board application/.test(s)) return 'advisory-thanks';
  if (/^New Advisory Board application: /.test(s)) return 'advisory-staff';
  if (/^\[SOARD\] Reveal invite problem: /.test(s)) return 'staff-invite-problem';
  if (/^\[SOARD\] .+ reveal invite is still out$/.test(s)) return 'staff-invite-held';
  if (/^\[SOARD\] .+ profile is hidden$/.test(s)) return 'staff-kid-hidden';
  const rem = s.match(/^(Save the date|New date|Tomorrow|Today|One hour to go|We’re live|We're live|Watch the replay): /);
  if (rem) return { 'Save the date': 'rem-scheduled', 'New date': 'rem-moved', Tomorrow: 'rem-day', Today: 'rem-day', 'One hour to go': 'rem-hour', 'We’re live': 'rem-live', "We're live": 'rem-live', 'Watch the replay': 'rem-replay' }[rem[1]];
  if (/^Confirm your (reveal )?reminders/i.test(s)) return 'rem-confirm';
  return null;
}

/** Which kind of staff alert a title is (they all go through alertAdmins) */
export function alertEntry(title = '') {
  const t = String(title).replace(/^(Still|Resolved|TEST · ): ?/i, '');
  if (/^Test alert/i.test(t)) return 'preview';
  if (/staff text didn.t arrive/i.test(t)) return 'staff-text-missed';
  if (/^(Countdown|Reveal moved|No countdown)/i.test(t)) return 'staff-countdown';
  if (/Kit .*(email|“we’re live”|"we're live")|Kit email/i.test(t)) return 'staff-kit-live';
  if (/Instagram Reel|replay saved/i.test(t)) return 'staff-replay';
  if (/^(Live now|Ended|All green|Go\b|Go,)/i.test(t) && !/which kid/i.test(t)) return 'staff-good-news';
  return 'staff-live-alert';
}

// Messages whose reader is a family (their address may be mistyped) or staff (a list address may be wrong)
const FAMILY = new Set(['app-resume', 'app-reminder', 'waitlist-confirm', 'waitlist-open', 'advisory-thanks']);
const WATCHERS = new Set(['rem-confirm', 'rem-scheduled', 'rem-moved', 'rem-day', 'rem-hour', 'rem-live', 'rem-replay']);
export const audienceOf = (entry) => (FAMILY.has(entry) ? 'family' : WATCHERS.has(entry) ? 'watcher' : entry === 'preview' ? 'you' : entry ? 'staff' : null);

// ─── Writing ────────────────────────────────────────────────────────

/**
 * After a Resend send: one row per email. rows: [{ id, to, subject }].
 * Never throws (a log write must never cost a send).
 */
export async function logSent(env, rows, { tags = null, now = Date.now() } = {}) {
  const DB = env?.DB;
  const list = (rows || []).filter((r) => r?.id && r.to);
  if (!DB || !list.length) return 0;
  try {
    await ensureEmailLog(DB);
    const type = tagOf(tags);
    const at = iso(now);
    await DB.batch(list.map((r) => DB.prepare(`INSERT OR IGNORE INTO email_log (id, type, to_addr, subject, sent_at, status, status_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'site')`).bind(String(r.id), type, String(r.to).trim().toLowerCase(), String(r.subject || '').slice(0, 300), at, r.scheduled ? 'scheduled' : 'sent', at)));
    return list.length;
  } catch {
    return 0;
  }
}

/** Resend's batch answer → the ids in the order they were sent */
export function batchIds(body) {
  const data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return data.map((d) => d?.id || null);
}

// How far along an email is; a report never moves it backwards
const RANK = { scheduled: 0, sent: 1, delayed: 2, delivered: 3, failed: 4, suppressed: 4, bounced: 5, complained: 6, canceled: 7 };
const STATUS_OF = {
  'email.scheduled': 'scheduled', 'email.sent': 'sent', 'email.delivery_delayed': 'delayed', 'email.delivered': 'delivered',
  'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed', 'email.suppressed': 'suppressed', 'email.canceled': 'canceled',
};
// Resend's list says last_event; the same words, mostly
const STATUS_OF_LAST = {
  scheduled: 'scheduled', queued: 'sent', sent: 'sent', delivery_delayed: 'delayed', delivered: 'delivered', opened: 'delivered', clicked: 'delivered',
  bounced: 'bounced', complained: 'complained', failed: 'failed', suppressed: 'suppressed', canceled: 'canceled',
};

/** Why, in a staff member's words, from Resend's report */
export function reasonOf(type, data = {}) {
  if (type === 'email.bounced') {
    const b = data.bounce || {};
    const sub = String(b.subType || '');
    if (/suppress/i.test(sub)) return 'Resend won’t email this address any more: it bounced before.';
    if (/NoEmail|General/i.test(sub) && b.type === 'Permanent') return 'The address doesn’t exist (the mail server said no such mailbox).';
    if (/MailboxFull/i.test(sub)) return 'Their mailbox is full.';
    if (/MessageTooLarge/i.test(sub)) return 'The email was too large for their mail server.';
    if (/ContentRejected/i.test(sub)) return 'Their mail server turned the email away for its content.';
    if (b.type === 'Transient') return `Their mail server turned it away for now${b.message ? ` (${String(b.message).slice(0, 160)})` : ''}.`;
    return b.message ? String(b.message).slice(0, 240) : 'Their mail server turned it away.';
  }
  if (type === 'email.complained') return 'They marked it as spam.';
  if (type === 'email.failed') {
    const r = String(data.failed?.reason || '');
    if (/quota/i.test(r)) return 'Resend’s sending limit for the day was reached, so it wasn’t sent.';
    return r ? `Resend couldn’t send it (${r.replace(/_/g, ' ')}).` : 'Resend couldn’t send it.';
  }
  if (type === 'email.suppressed') return 'Resend didn’t send it: the address bounced or reported spam before.';
  if (type === 'email.delivery_delayed') return 'Their mail server is slow to accept it; Resend keeps trying.';
  return null;
}

/**
 * A report from Resend (webhook payload: { type, created_at, data }).
 * → { id, status, changed, entry, to, row } or null when it isn't an email report.
 */
export async function recordEvent(DB, ev, { now = Date.now() } = {}) {
  const type = String(ev?.type || '');
  const d = ev?.data || {};
  const id = String(d.email_id || d.id || '');
  if (!DB || !type.startsWith('email.') || !id) return null;
  await ensureEmailLog(DB);
  const at = ev.created_at ? iso(Date.parse(ev.created_at) || now) : iso(now);
  const detail = reasonOf(type, d);
  const to = Array.isArray(d.to) ? d.to[0] : d.to;
  // An email this log didn't see go (sent before tracking, or another path): add it from the report
  await DB.prepare(`INSERT OR IGNORE INTO email_log (id, type, to_addr, subject, sent_at, status, status_at, source) VALUES (?, ?, ?, ?, ?, 'sent', ?, 'resend')`)
    .bind(id, tagOf(d.tags), to ? String(to).trim().toLowerCase() : null, String(d.subject || '').slice(0, 300), d.created_at ? iso(Date.parse(d.created_at) || now) : at, at).run();
  const row = await DB.prepare('SELECT * FROM email_log WHERE id = ?').bind(id).first();
  if (!row) return null;
  let changed = false;
  if (type === 'email.opened' || type === 'email.clicked') {
    const col = type === 'email.opened' ? 'opened_at' : 'clicked_at';
    if (!row[col]) { await DB.prepare(`UPDATE email_log SET ${col} = ? WHERE id = ?`).bind(at, id).run(); changed = true; }
    // An open is proof it arrived
    if ((RANK[row.status] ?? 0) < RANK.delivered) { await DB.prepare("UPDATE email_log SET status = 'delivered', status_at = ? WHERE id = ?").bind(at, id).run(); changed = true; }
  } else {
    const status = STATUS_OF[type];
    if (status && (RANK[status] ?? 0) >= (RANK[row.status] ?? 0) && status !== row.status) {
      await DB.prepare('UPDATE email_log SET status = ?, status_at = ?, detail = ?, bounce_type = ? WHERE id = ?')
        .bind(status, at, detail, type === 'email.bounced' ? (d.bounce?.type || null) : null, id).run();
      changed = true;
    }
  }
  // The email's day, for the admin: only what moved it (a late "delayed" after delivered is noise)
  if (changed) await DB.prepare('INSERT OR IGNORE INTO email_events (email_id, type, at, detail) VALUES (?, ?, ?, ?)').bind(id, type.slice(6), at, detail).run();
  const out = await DB.prepare('SELECT * FROM email_log WHERE id = ?').bind(id).first();
  return { id, status: out?.status, changed, entry: entryFor(out?.type, out?.subject), to: out?.to_addr, row: out };
}

/** A scheduled email taken back before it went (the waitlist's "Don't send this time") */
export async function markCanceled(env, id, { now = Date.now() } = {}) {
  if (!env?.DB || !id) return;
  try {
    await ensureEmailLog(env.DB);
    await env.DB.prepare("UPDATE email_log SET status = 'canceled', status_at = ?, detail = ? WHERE id = ?").bind(iso(now), 'Taken back before it went.', String(id)).run();
    await env.DB.prepare('INSERT OR IGNORE INTO email_events (email_id, type, at, detail) VALUES (?, ?, ?, ?)').bind(String(id), 'canceled', iso(now), null).run();
  } catch { /* the log is a record, never a reason to fail */ }
}

// ─── Follow-ups ─────────────────────────────────────────────────────

const LIST_FIX = {
  'staff-new-app': 'Check the staff list in Applications → Settings.',
  'staff-new-org': 'Check the community project list in Applications → Settings → Community projects.',
  'staff-family-reply': 'Check the staff list in Applications → Settings.',
  'staff-summary': 'Check that person’s address in JobTread, or the staff list in Applications → Settings.',
  'staff-waitlist': 'Check the staff list in Applications → Settings.',
  'staff-app-limit': 'Check the staff list in Applications → Settings.',
  'staff-live-alert': 'Check the alert list in Reveals → Settings → Alerts.',
  'staff-alert-hello': 'Check the alert list in Reveals → Settings → Alerts.',
  'staff-invite-problem': 'Check the invite alert list in Reveals → Invites.',
  'staff-invite-held': 'Check the invite alert list in Reveals → Invites.',
  'advisory-staff': 'Check the staff list for advisory applications.',
};
const FAMILY_FIX = {
  'app-resume': 'The family typed this address on the application. Their answers are saved; reach them another way for a working address.',
  'app-reminder': 'The family typed this address on the application. Their answers are saved; reach them another way for a working address.',
  'waitlist-confirm': 'They typed this address to hear when applications open. If you know the family, ask for a working one.',
  'waitlist-open': 'They typed this address to hear when applications open. If you know the family, ask for a working one.',
  'advisory-thanks': 'They typed this address on the advisory application. Reach them another way for a working one.',
};

/** What staff can do about an email that didn't arrive (the alert and the admin say the same) */
export function fixFor(entry, status, bounceType = null) {
  if (status === 'delayed') return 'Nothing yet: Resend keeps trying for a while.';
  if (status === 'failed') return 'Resend says why in its log; the site sends the next one as usual.';
  if (status === 'bounced' && bounceType === 'Transient') return 'Usually it sorts itself out: the next one may get through. If it keeps happening, ask for another address.';
  const who = audienceOf(entry);
  if (who === 'watcher') return 'Nothing: the address was unsubscribed by itself, so nothing more goes there.';
  if (who === 'family') return FAMILY_FIX[entry] || 'Reach them another way for a working address.';
  if (who === 'staff') return LIST_FIX[entry] || 'Check where this address is set in the admin.';
  return null;
}

/**
 * What a report means for people: a lost reveal-reminder address is
 * unsubscribed; a family's or staff email that can't land tells staff.
 * alert(env, card) is injected (alertAdmins in production). Never throws.
 */
export async function followUp(env, rec, { alert = null, now = Date.now() } = {}) {
  try {
    if (!rec?.changed || !rec.to) return null;
    const lost = rec.status === 'complained' || rec.status === 'suppressed' || (rec.status === 'bounced' && rec.row?.bounce_type !== 'Transient');
    if (!lost && rec.status !== 'failed') return null;
    const who = audienceOf(rec.entry);
    if (who === 'watcher' && lost) {
      const r = await env.DB.prepare("UPDATE broadcast_reminders SET unsubscribed_at = ? WHERE channel = 'email' AND lower(address) = ? AND unsubscribed_at IS NULL")
        .bind(iso(now), rec.to).run().catch(() => null);
      return { unsubscribed: r?.meta?.changes ?? 0 };
    }
    if ((who !== 'family' && who !== 'staff') || !alert) return null;
    if (!(await limit(env.DB, `email-lost:${rec.to}`, 1, 7 * 86400)).ok) return { alerted: false };
    const fix = fixFor(rec.entry, rec.status, rec.row?.bounce_type);
    await alert(env, {
      level: 'warn', icon: '📭',
      title: `An email didn’t reach ${rec.to}`,
      detail: `${rec.row?.subject ? `“${rec.row.subject}”. ` : ''}${rec.row?.detail || 'It couldn’t be delivered.'}`,
      fix,
      url: `${SITE}/admin/#messages/sent`, urlLabel: 'What went out',
    });
    return { alerted: true };
  } catch {
    return null;
  }
}

// ─── Resend: the webhook and the catch-up ───────────────────────────

async function resend(env, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${RESEND_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// A key made with "Sending access" answers everything but sending with restricted_api_key
const sendOnly = (r) => (r.status === 401 || r.status === 403) && /restricted/i.test(`${r.json?.name || ''} ${r.json?.message || ''}`);
const errorOf = (r) => `Resend ${r.status}${r.json?.message ? `: ${String(r.json.message).slice(0, 160)}` : ''}`;

/** The signing secret the webhook route checks: Cloudflare's, else the one the site registered */
export async function webhookSecret(env) {
  if (env.RESEND_WEBHOOK_SECRET) return env.RESEND_WEBHOOK_SECRET;
  await ensureEmailLog(env.DB);
  return (await readKey(env.DB, 'webhook'))?.secret || null;
}

/**
 * Make sure Resend reports to /api/resend-webhook. Adopts a webhook already
 * pointed here (Resend hands its secret back), turns a disabled one back on,
 * and makes one when there's none. → { state: 'on' | 'env' | 'send-only' | 'error', … }
 */
export async function ensureWebhook(env, { now = Date.now(), fetchImpl = fetch, origin = SITE } = {}) {
  if (env.RESEND_WEBHOOK_SECRET) return { state: 'env' };
  await ensureEmailLog(env.DB);
  const endpoint = `${origin}${WEBHOOK_PATH}`;
  const saved = await readKey(env.DB, 'webhook');
  if (saved?.id && saved.secret && saved.endpoint === endpoint) {
    const r = await resend(env, `/webhooks/${encodeURIComponent(saved.id)}`, { fetchImpl });
    if (r.ok) {
      if (r.json?.status && r.json.status !== 'enabled') {
        const u = await resend(env, `/webhooks/${encodeURIComponent(saved.id)}`, { method: 'PATCH', body: { status: 'enabled' }, fetchImpl });
        if (!u.ok) return { state: 'error', error: `The webhook is ${r.json.status} and couldn’t be turned back on (${errorOf(u)})` };
        return { state: 'on', id: saved.id, reenabled: true };
      }
      return { state: 'on', id: saved.id };
    }
    if (sendOnly(r)) return { state: 'send-only' };
    if (r.status !== 404) return { state: 'error', error: errorOf(r) };
    // Deleted in Resend: make it again below
  }
  const list = await resend(env, '/webhooks', { fetchImpl });
  if (sendOnly(list)) return { state: 'send-only' };
  if (!list.ok) return { state: 'error', error: errorOf(list) };
  const mine = (list.json?.data || []).find((w) => w?.endpoint === endpoint);
  if (mine?.id) {
    const one = await resend(env, `/webhooks/${encodeURIComponent(mine.id)}`, { fetchImpl });
    if (one.ok && one.json?.signing_secret) {
      await writeKey(env.DB, 'webhook', { id: mine.id, secret: one.json.signing_secret, endpoint, at: iso(now), adopted: true }, now);
      return { state: 'on', id: mine.id, adopted: true };
    }
  }
  const made = await resend(env, '/webhooks', { method: 'POST', body: { endpoint, events: EVENTS }, fetchImpl });
  if (sendOnly(made)) return { state: 'send-only' };
  if (!made.ok || !made.json?.id || !made.json?.signing_secret) return { state: 'error', error: made.ok ? 'Resend made the webhook but sent no secret' : errorOf(made) };
  await writeKey(env.DB, 'webhook', { id: made.json.id, secret: made.json.signing_secret, endpoint, at: iso(now) }, now);
  return { state: 'on', id: made.json.id, created: true };
}

/**
 * Read Resend's most recent emails and settle any the webhook didn't
 * report (or reported before tracking began). pages: 100 emails each.
 * → { state, seen, updated, added } or { state: 'send-only' | 'error' }
 */
export async function catchUp(env, { pages = 1, fetchImpl = fetch, now = Date.now(), alert = null } = {}) {
  await ensureEmailLog(env.DB);
  let after = null;
  let seen = 0, updated = 0, added = 0;
  for (let p = 0; p < pages; p++) {
    const r = await resend(env, `/emails?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`, { fetchImpl });
    if (sendOnly(r)) return { state: 'send-only' };
    if (!r.ok) return { state: 'error', error: errorOf(r) };
    const data = r.json?.data || [];
    for (const e of data) {
      if (!e?.id) continue;
      seen++;
      const status = STATUS_OF_LAST[e.last_event];
      const row = await env.DB.prepare('SELECT status FROM email_log WHERE id = ?').bind(e.id).first();
      if (!row) {
        const sentAt = e.created_at ? iso(Date.parse(String(e.created_at).replace(' ', 'T').replace(/\+00$/, 'Z')) || now) : iso(now);
        await env.DB.prepare(`INSERT OR IGNORE INTO email_log (id, type, to_addr, subject, sent_at, status, status_at, source) VALUES (?, NULL, ?, ?, ?, ?, ?, 'resend')`)
          .bind(e.id, Array.isArray(e.to) && e.to[0] ? String(e.to[0]).toLowerCase() : null, String(e.subject || '').slice(0, 300), sentAt, status || 'sent', sentAt).run();
        added++;
        continue;
      }
      if (status && (RANK[status] ?? 0) > (RANK[row.status] ?? 0)) {
        // The list carries no reason, so a report is written as Resend's own word for it
        const rec = await recordEvent(env.DB, { type: `email.${e.last_event === 'opened' || e.last_event === 'clicked' ? e.last_event : ({ delayed: 'delivery_delayed' }[status] || status)}`, created_at: null, data: { email_id: e.id } }, { now });
        if (rec?.changed) { updated++; await followUp(env, rec, { alert, now }); }
      }
    }
    if (!r.json?.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  const tagged = await fillTags(env, { fetchImpl });
  return { state: 'on', seen, updated, added, tagged };
}

// ─── The one-time proof ─────────────────────────────────────────────

const FROM = 'Sunshine on a Ranney Day <sunshine@comms.sunshineonaranneyday.com>';
const SELF_TEST = [['delivered', 'delivered@resend.dev'], ['bounced', 'bounced@resend.dev']];
const SELF_TEST_WAIT_MS = 2 * 3600e3;

/** The webhook says it was reached (the self-test needs a report that came that way) */
export async function noteWebhookSeen(DB, now = Date.now()) {
  try { await writeKey(DB, 'webhook-seen', { at: iso(now) }, now); } catch { /* only a note */ }
}

/**
 * Send Resend's two test addresses an email once, then on later turns check
 * that "delivered" and "bounced" both came back through the webhook.
 * → { state: 'sent' | 'passed' | 'failed', … } or null when it isn't time.
 */
export async function selfTest(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const DB = env.DB;
  const st = await readKey(DB, 'self-test');
  if (st?.result === 'passed') return { state: 'passed', ...st };
  if (st?.result === 'failed') {
    // Fixed since (a report has come through the webhook after the check failed): that's the proof
    const later = await readKey(DB, 'webhook-seen');
    if (!(later?.at && later.at > st.checkedAt)) return { state: 'failed', ...st };
    const out = { ...st, result: 'passed', why: null, late: true, checkedAt: iso(now) };
    await writeKey(DB, 'self-test', out, now);
    return { state: 'passed', ...out };
  }
  if (!st?.sentAt) {
    const items = SELF_TEST.map(([, to]) => ({
      from: FROM, to: [to], subject: '[Test] Delivery reports check',
      text: 'An automatic check from sunshineonaranneyday.com that Resend reports back on each email. Resend’s test address; nobody reads it.',
      tags: [{ name: 'type', value: 'email-self-test' }],
    }));
    const res = await fetchImpl(`${RESEND_API}/emails/batch`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(items), signal: AbortSignal.timeout(15000),
    });
    const ids = batchIds(await res.json().catch(() => null));
    if (!res.ok || ids.length !== 2 || !ids.every(Boolean)) {
      const out = { sentAt: null, error: `Resend ${res.status}`, triedAt: iso(now) };
      await writeKey(DB, 'self-test', out, now);
      return { state: 'error', ...out };
    }
    await logSent(env, SELF_TEST.map(([, to], i) => ({ id: ids[i], to, subject: items[i].subject })), { tags: items[0].tags, now });
    const out = { sentAt: iso(now), ids: { delivered: ids[0], bounced: ids[1] } };
    await writeKey(DB, 'self-test', out, now);
    return { state: 'sent', ...out };
  }
  const got = Object.fromEntries(((await DB.prepare('SELECT id, status FROM email_log WHERE id IN (?, ?)').bind(st.ids.delivered, st.ids.bounced).all())?.results || []).map((r) => [r.id, r.status]));
  const seen = await readKey(DB, 'webhook-seen');
  const viaWebhook = !!(seen?.at && seen.at >= st.sentAt);
  const ok = got[st.ids.delivered] === 'delivered' && got[st.ids.bounced] === 'bounced';
  if (ok && viaWebhook) {
    const out = { ...st, result: 'passed', checkedAt: iso(now) };
    await writeKey(DB, 'self-test', out, now);
    return { state: 'passed', ...out };
  }
  if (now - Date.parse(st.sentAt) > SELF_TEST_WAIT_MS) {
    const why = !viaWebhook ? 'Resend never reached /api/resend-webhook' : `the reports said ${got[st.ids.delivered] || 'nothing'} and ${got[st.ids.bounced] || 'nothing'}`;
    const out = { ...st, result: 'failed', why, checkedAt: iso(now) };
    await writeKey(DB, 'self-test', out, now);
    return { state: 'failed', ...out };
  }
  return { state: 'sent', ...st };
}

/**
 * Emails added from Resend's list (sent before tracking, or by a path that
 * doesn't log) have no tag yet: read each one's tags from Resend, up to
 * `max` a turn. type '' means Resend had none, so the subject decides.
 */
export async function fillTags(env, { fetchImpl = fetch, max = 25 } = {}) {
  const ids = ((await env.DB.prepare("SELECT id FROM email_log WHERE type IS NULL AND source = 'resend' ORDER BY sent_at DESC LIMIT ?").bind(max).all())?.results || []).map((r) => r.id);
  let n = 0;
  for (const id of ids) {
    const r = await resend(env, `/emails/${encodeURIComponent(id)}`, { fetchImpl }).catch(() => null);
    if (!r?.ok && r?.status !== 404) break; // Resend is down or the key can't read: try again next turn
    await env.DB.prepare('UPDATE email_log SET type = ? WHERE id = ?').bind(tagOf(r?.json?.tags) || '', id).run();
    n++;
  }
  return n;
}

/** The tracking's state for the admin (never the secret) */
export async function trackingState(env) {
  if (!env.RESEND_API_KEY) return { state: 'off' };
  await ensureEmailLog(env.DB);
  const s = await readKey(env.DB, 'status');
  const hook = await readKey(env.DB, 'webhook');
  const lastEvent = await env.DB.prepare('SELECT max(at) AS at FROM email_events').first('at').catch(() => null);
  const since = await env.DB.prepare('SELECT min(sent_at) AS at FROM email_log').first('at').catch(() => null);
  const proof = await readKey(env.DB, 'self-test');
  const seen = await readKey(env.DB, 'webhook-seen');
  return {
    state: env.RESEND_WEBHOOK_SECRET ? (s?.state === 'send-only' ? 'send-only' : 'on') : s?.state || 'waiting',
    checkedAt: s?.checkedAt || null,
    lastWebhookAt: seen?.at || null,
    selfTest: proof ? { result: proof.result || (proof.sentAt ? 'waiting' : 'error'), at: proof.checkedAt || proof.sentAt || proof.triedAt || null, why: proof.why || proof.error || null } : null,
    error: s?.error || null,
    webhookSince: hook?.at || null,
    lastReportAt: lastEvent || null,
    since: since || null,
  };
}

/**
 * The heartbeat's turn (every 30 minutes; once a day while the key can only
 * send): register the webhook, catch up from Resend's list, prune old rows.
 * Never throws.
 */
export async function maybeTrackEmails(env, { now = Date.now(), fetchImpl = fetch, alert = null, origin = SITE } = {}) {
  try {
    if (!env.DB || !env.RESEND_API_KEY) return null;
    await ensureEmailLog(env.DB);
    const prev = await readKey(env.DB, 'status');
    const every = prev?.state === 'send-only' ? SEND_ONLY_RECHECK_MS : CHECK_EVERY_MS;
    if (prev?.checkedAt && now - Date.parse(prev.checkedAt) < every) return null;
    // Claim the slot first so overlapping wake-ups don't double up
    await writeKey(env.DB, 'status', { ...(prev || {}), checkedAt: iso(now) }, now);
    const hook = await ensureWebhook(env, { now, fetchImpl, origin });
    const caught = hook.state === 'send-only' ? hook : await catchUp(env, { pages: prev?.state === 'on' ? 1 : 3, fetchImpl, now, alert });
    // The one-time proof that reports come back (Resend's test addresses), once the webhook is there
    const proof = hook.state === 'on' || hook.state === 'env' ? await selfTest(env, { now, fetchImpl }).catch(() => null) : null;
    await env.DB.prepare('DELETE FROM email_log WHERE sent_at < ?').bind(iso(now - KEEP_MS)).run();
    await env.DB.prepare('DELETE FROM email_events WHERE at < ?').bind(iso(now - KEEP_MS)).run();
    const state = hook.state === 'send-only' || caught.state === 'send-only' ? 'send-only'
      : hook.state === 'error' || caught.state === 'error' ? 'error' : 'on';
    const next = { state: state === 'on' && proof?.state === 'failed' ? 'error' : state, checkedAt: iso(now), error: hook.error || caught.error || (proof?.state === 'failed' ? `The delivery check failed: ${proof.why}` : null), ...(caught.seen != null ? { seen: caught.seen, updated: caught.updated, added: caught.added, tagged: caught.tagged } : {}) };
    await writeKey(env.DB, 'status', next, now);
    return next;
  } catch (e) {
    try { await writeKey(env.DB, 'status', { state: 'error', checkedAt: iso(now), error: e.message }, now); } catch { /* the next turn tries again */ }
    return null;
  }
}

// ─── Svix signatures (how Resend signs its webhooks) ────────────────

const enc = new TextEncoder();
function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** base64(HMAC-SHA256(secret bytes, `${id}.${timestamp}.${body}`)) */
export async function svixSignature(secret, id, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', b64decode(String(secret).replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`)));
  return btoa(String.fromCharCode(...sig));
}
/** True when one of the header's "v1,<sig>" entries matches and the time is within 5 minutes */
export async function verifySvix(secret, headers, body, { now = Date.now(), toleranceSec = 300 } = {}) {
  const get = (n) => headers.get(`svix-${n}`) || headers.get(`webhook-${n}`) || '';
  const id = get('id'), ts = get('timestamp'), sigs = get('signature');
  if (!secret || !id || !ts || !sigs) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
  let expected;
  try { expected = await svixSignature(secret, id, ts, body); } catch { return false; }
  return sigs.split(' ').some((part) => {
    const [v, sig] = part.split(',');
    if (v !== 'v1' || !sig || sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}
