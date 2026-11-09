/**
 * Mercury's "needs a receipt" emails wait while the site finds the receipt
 * ===========================================================================
 * SOARD's receipt policy in Mercury asks for a receipt on every card charge of
 * $75 or more, and Mercury emails the cardholder ("$567.73 at SDZ Supply needs
 * a receipt") the second the card is used: minutes before the site has found
 * the receipt in SOARD's email and put it on the charge (_mail-sweep.js, card
 * charges first). Peter, Nov 9 2026: a reminder only when a receipt is really
 * missing, on every SOARD inbox.
 *
 *   - Every inbox in SOARD's Google gets one Gmail filter: Mercury's "needs a
 *     receipt" emails skip the inbox, so nobody's phone buzzes for them. Making
 *     it needs gmail.settings.basic on the site's domain-wide delegation; until
 *     Google allows it, Automations says so and the site moves each one out of
 *     the inbox itself when it reads it.
 *   - The sweep reads every new email anyway (scanBox), so it sees each one.
 *     Once the charge has its receipt (put on by the site, or by hand in
 *     Mercury) the email stays out of the inbox, or comes out if it's there.
 *   - A day with no receipt (or no charge the site knows of): back in the inbox.
 *     Only one the filter or the site took out; one a person archived stays
 *     where they put it.
 *
 * Nothing is deleted or marked read: only the Inbox label moves.
 */
import { accessToken, GMAIL_MODIFY_SCOPE } from './_google-calendar.js';
import { gmail, header } from './_mailbox.js';

export const SETTINGS_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
export const SHOW_AFTER_MS = DAY_MS;
// A reminder is followed this long (a receipt added by hand weeks later still takes it out), and an inbox's first look reaches back as far
const FOLLOW_MS = 30 * DAY_MS;
// Mercury's reminder comes the second the card is used; one it sends again later can be weeks after the charge
const CHARGE_BEFORE_MS = 30 * DAY_MS;
// Inboxes given their filter (or their first look) in one sweep: the heartbeat has a limit on calls out
const BOXES_AT_ONCE = 3;
const MOVES_AT_ONCE = 20;
// What the filter matches. The site's own check (isReminder) is looser, so nothing the filter takes out goes unseen
export const FILTER = { criteria: { from: 'mercury.com', subject: 'needs a receipt' }, action: { removeLabelIds: ['INBOX'] } };
export const isReminder = (from, subject) => /mercury\.com/i.test(String(from || '')) && /needs a receipt/i.test(String(subject || ''));
const isOurFilter = (f) => String(f?.criteria?.from || '').toLowerCase().includes('mercury.com')
  && String(f?.criteria?.subject || '').toLowerCase().includes('needs a receipt')
  && (f?.action?.removeLabelIds || []).includes('INBOX');
const noMailbox = (err) => /Mail service not enabled|failedPrecondition/i.test(err.message);
export const FILTERS_REFUSED = 'Google hasn’t let the site make Gmail filters yet, so Mercury’s “needs a receipt” emails still reach the inbox (the site moves each one out a few minutes later): Google Admin → Security → API controls → Domain-wide delegation, add https://www.googleapis.com/auth/gmail.settings.basic to the site’s client';

export const REMINDER_SCHEMA = [
  // Each of Mercury's "needs a receipt" emails, in whichever inbox: 'waiting' for its charge's receipt, 'shown' (back in
  // the inbox: none after a day), 'cleared' (the receipt is on: out of the inbox), 'done' (followed a month), 'gone'
  // (deleted). ours = the filter or the site took it out of the inbox, so it's the only kind ever put back
  `CREATE TABLE IF NOT EXISTS receipt_reminders (
    mailbox TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, cents INTEGER, vendor TEXT, charge TEXT, state TEXT NOT NULL,
    in_inbox INTEGER, ours INTEGER, updated_at TEXT, PRIMARY KEY (mailbox, id))`,
  'CREATE INDEX IF NOT EXISTS idx_receipt_reminders_state ON receipt_reminders(state, at)',
];

/** "$1,234.56 at SDZ Supply needs a receipt" → { cents, vendor }, nulls when the words aren't Mercury's usual ones */
export function reminderCharge(subject) {
  const m = /\$\s?([\d,]+\.\d{2})\s+at\s+(.+?)\s+needs a receipt/i.exec(String(subject || ''));
  return m ? { cents: Math.round(Number(m[1].replace(/,/g, '')) * 100), vendor: m[2].trim() } : { cents: null, vendor: null };
}

/**
 * An email the sweep read → noted when it's one of Mercury's reminders (→ true). `fresh`: just in (the sweep's new
 * mail), so out of the inbox means the filter took it out; an older one found by an inbox's first look may have been
 * archived by a person, and is never put back
 */
export async function noteReminder(DB, mailbox, msg, now, { fresh = true } = {}) {
  const h = msg.payload?.headers;
  const subject = header(h, 'Subject');
  if (!isReminder(header(h, 'From'), subject)) return false;
  const inInbox = (msg.labelIds || []).includes('INBOX');
  const { cents, vendor } = reminderCharge(subject);
  await DB.prepare(`INSERT OR IGNORE INTO receipt_reminders (mailbox, id, at, cents, vendor, state, in_inbox, ours, updated_at)
      VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`)
    .bind(mailbox, msg.id, new Date(Number(msg.internalDate) || now).toISOString(), cents, vendor, inInbox ? 1 : 0, !inInbox && fresh ? 1 : 0, new Date(now).toISOString()).run();
  return true;
}

/** Each inbox's filter, a few inboxes a sweep → the reason Automations shows | null */
async function makeFilters(env, ctx, r, skip) {
  r.filters ||= {};
  // Google said no: asked again hourly, and it goes on by itself once the scope is added
  if (r.refusedAt && ctx.now - r.refusedAt < HOUR_MS) return FILTERS_REFUSED;
  let tried = 0;
  for (const mailbox of ctx.inboxes) {
    if (r.filters[mailbox] || skip(mailbox)) continue;
    if (tried++ >= BOXES_AT_ONCE) break;
    let token;
    try {
      token = await accessToken(env, mailbox, { fetchImpl: ctx.fetchImpl, now: ctx.now, scope: SETTINGS_SCOPE });
    } catch (err) {
      if (/unauthorized_client|access_denied/i.test(err.message)) { r.refusedAt = ctx.now; return FILTERS_REFUSED; }
      throw err;
    }
    try {
      // One already there (made by hand, or before) isn't made twice
      const same = ((await gmail(token, '/settings/filters', ctx.fetchImpl)).filter || []).find(isOurFilter);
      if (same) { r.filters[mailbox] = same.id || 'there'; continue; }
      const res = await ctx.fetchImpl(`${GMAIL_API}/settings/filters`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(FILTER), signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && !/exists/i.test(body?.error?.message || '')) throw new Error(`Gmail answered ${res.status}: ${body?.error?.message || ''}`.trim());
      r.filters[mailbox] = body.id || 'there';
    } catch (err) {
      if (noMailbox(err)) continue; // an account with no Gmail (the sweep skips it too)
      throw new Error(`making the Mercury receipt filter in ${mailbox.split('@')[0]}’s Gmail: ${err.message}`);
    }
  }
  r.refusedAt = null;
  return null;
}

/** An inbox's first look: Mercury's reminders of the last month, from before the sweep read its new mail for them */
async function firstLooks(env, ctx, r, skip) {
  r.looked ||= {};
  let n = 0;
  for (const mailbox of ctx.inboxes) {
    if (r.looked[mailbox] || skip(mailbox)) continue;
    if (n++ >= BOXES_AT_ONCE) break;
    try {
      const { token } = await ctx.open(mailbox);
      const q = `from:mercury.com subject:"needs a receipt" after:${Math.floor((ctx.now - FOLLOW_MS) / 1000)} -in:drafts`;
      const list = await gmail(token, `/messages?maxResults=50&q=${encodeURIComponent(q)}`, ctx.fetchImpl);
      for (const { id } of list.messages || []) {
        const msg = await gmail(token, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, ctx.fetchImpl);
        await noteReminder(env.DB, mailbox, msg, ctx.now, { fresh: false });
      }
    } catch (err) {
      if (!noMailbox(err)) throw new Error(`looking for Mercury’s “needs a receipt” emails in ${mailbox.split('@')[0]}’s Gmail: ${err.message}`);
    }
    r.looked[mailbox] = ctx.now;
  }
}

/** The Mercury card charge a reminder is for: its exact amount, made by the time it came; the cardholder's own, then the nearest */
function chargeOf(x, charges) {
  if (!x.cents) return null;
  const at = Date.parse(x.at);
  const fits = charges.filter((c) => c.cents === x.cents && Date.parse(c.charged_at) <= at + HOUR_MS && Date.parse(c.charged_at) >= at - CHARGE_BEFORE_MS);
  fits.sort((a, b) => (b.mailbox === x.mailbox) - (a.mailbox === x.mailbox) || Math.abs(Date.parse(a.charged_at) - at) - Math.abs(Date.parse(b.charged_at) - at));
  return fits[0] || null;
}

/** Each reminder followed: where it belongs now, and its Inbox label moved to match → the reason Automations shows | null */
async function follow(env, ctx, until) {
  const DB = env.DB;
  const open = (await DB.prepare("SELECT * FROM receipt_reminders WHERE state IN ('waiting', 'shown') ORDER BY at LIMIT 300").all()).results || [];
  if (!open.length) return null;
  const since = Math.min(...open.map((x) => Date.parse(x.at))) - CHARGE_BEFORE_MS;
  const charges = (await DB.prepare("SELECT charge, mailbox, cents, charged_at, state FROM card_receipts WHERE card = 'mercury' AND charged_at >= ?")
    .bind(new Date(since).toISOString()).all()).results || [];
  const iso = new Date(ctx.now).toISOString();
  let moves = 0;
  for (const x of open) {
    const age = ctx.now - Date.parse(x.at);
    const c = chargeOf(x, charges);
    let next = null;
    // The receipt is on (the site's, or one added by hand in Mercury): out of the inbox for good
    if (c && (c.state === 'attached' || c.state === 'had')) next = { state: 'cleared', remove: Boolean(x.in_inbox), in_inbox: 0, ours: x.ours };
    // A day and none: back in the inbox, if it was the filter or the site that took it out
    else if (x.state === 'waiting' && age >= SHOW_AFTER_MS) next = { state: 'shown', add: Boolean(x.ours && !x.in_inbox), in_inbox: x.ours ? 1 : x.in_inbox, ours: x.ours };
    // In the inbox (no filter there yet): out until the receipt is found or the day is up
    else if (x.state === 'waiting' && x.in_inbox) next = { state: 'waiting', remove: true, in_inbox: 0, ours: 1 };
    else if (age >= FOLLOW_MS) next = { state: 'done', in_inbox: x.in_inbox, ours: x.ours };
    if (!next) continue;
    if (next.add || next.remove) {
      if (moves >= MOVES_AT_ONCE || Date.now() > until) break;
      moves++;
      try {
        const token = await accessToken(env, x.mailbox, { fetchImpl: ctx.fetchImpl, now: ctx.now, scope: GMAIL_MODIFY_SCOPE });
        const res = await ctx.fetchImpl(`${GMAIL_API}/messages/${encodeURIComponent(x.id)}/modify`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(next.add ? { addLabelIds: ['INBOX'] } : { removeLabelIds: ['INBOX'] }), signal: AbortSignal.timeout(15000),
        });
        // Deleted by hand: nothing left to move
        if (res.status === 404) next = { state: 'gone', in_inbox: 0, ours: x.ours };
        else if (!res.ok) throw new Error(`Gmail answered ${res.status}`);
      } catch (err) {
        return `moving Mercury’s “needs a receipt” email in ${x.mailbox.split('@')[0]}’s Gmail: ${err.message}`;
      }
    }
    await DB.prepare('UPDATE receipt_reminders SET state = ?, charge = ?, in_inbox = ?, ours = ?, updated_at = ? WHERE mailbox = ? AND id = ?')
      .bind(next.state, c?.charge || x.charge || null, next.in_inbox ? 1 : 0, next.ours ? 1 : 0, iso, x.mailbox, x.id).run();
  }
  return null;
}

/**
 * Each sweep (not while it only watches): the filters, a first look in each inbox, then every reminder followed.
 * `skip`: an inbox with no Gmail. → the reasons for Automations | null
 */
export async function settleReminders(env, ctx, st, { skip = () => false, until = Infinity } = {}) {
  const r = st.reminders ||= {};
  const errors = [];
  for (const step of [() => makeFilters(env, ctx, r, skip), () => firstLooks(env, ctx, r, skip), () => follow(env, ctx, until)]) {
    try {
      const why = await step();
      if (why) errors.push(why);
    } catch (err) { errors.push(err.message); }
  }
  return errors.length ? errors.join(' · ') : null;
}

/** For Automations: how many inboxes have the filter, and the week's reminders by where they ended up */
export async function reminderStatus(DB, st, since) {
  const rows = (await DB.prepare('SELECT state, COUNT(*) AS n FROM receipt_reminders WHERE updated_at >= ? GROUP BY state').bind(since).all()).results || [];
  return { filters: Object.values(st.reminders?.filters || {}).filter(Boolean).length, ...Object.fromEntries(rows.map((x) => [x.state, x.n])) };
}
