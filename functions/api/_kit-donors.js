/**
 * Donors join the newsletter (Kit)
 * ===========================================================================
 * Everyone who gives through Zeffy is added to SOARD's newsletter list in Kit
 * and tagged "Donors", so they hear how the kids' rooms turn out and staff can
 * write to donors on their own too.
 *
 * Which gifts: the same ones Slack announces (./_zeffy.js screenPayment), so
 * never an imported payment, a website test, a $0 registration or a fully
 * refunded gift. Also left out: a gift with no email, and SOARD's own
 * addresses, which covers staff and the nomail.soardcharity.com address the
 * checks automation parks on a donor's contact for a moment (./_check-gifts.js).
 *
 * Never re-subscribes anyone. Kit is asked about each address first:
 *  - unsubscribed, bounced or marked as spam: left exactly as they are, no tag;
 *  - already on the list (or waiting to confirm a signup): tagged, nothing else,
 *    so a name they gave Kit is never overwritten;
 *  - an address Kit has never seen: added, subscribed, with their first name.
 * Adding through the API starts nothing in Kit (its automations start from a
 * form or a tag, and "Donors" is the site's own tag), so this never emails
 * anyone by itself: donors get the newsletter staff send.
 *
 * When: every 15 minutes on the live hub's heartbeat. Zeffy is asked for the
 * last 60 days of gifts (a check entered late carries its earlier date) and
 * each payment is handled once. The first runs catch up from START, the week
 * before Zeffy's contacts were uploaded to Kit on September 8, 2026, at most
 * MAX_PEOPLE people a run (Kit allows 120 calls a minute per key, shared with
 * signups, the waitlist and the quiet-subscriber check).
 *
 * D1 kit_donors keeps each payment id's outcome and when, never an email or a
 * name. site_config "kit-donors" keeps the last run and running totals of
 * people for Site → Automations. Kit or Zeffy refusing for an hour tells staff
 * (Slack and email, through the heartbeat's `alert`), and the all-clear when
 * it works again. maybeSyncDonors never throws.
 */

import { listPayments, screenPayment } from './_zeffy.js';
import { kitConfigured, kitFindSubscribers, kitUpsertSubscriber, kitTagId, kitTagSubscriberId } from './_kit.js';
import { isEmail, SITE_ORIGIN } from './_broadcast-notify.js';

export const DONOR_TAG = 'Donors';
export const START = '2026-09-01T04:00:00Z'; // September 1, 2026, midnight Eastern
export const MAX_PEOPLE = 20;
export const LOOKBACK_DAYS = 60;
const MIN = 60 * 1000;
const EVERY_MS = 15 * MIN;
const GRACE_S = 10 * 60; // a gift this new may still be settling in Zeffy
const PAGES = 10; // 100 payments a page
const GIVE_UP = 12; // tries for one person (three hours of runs) before a person is asked to look
const ALERT_AFTER_MS = 60 * MIN;
const CONFIG_KEY = 'kit-donors';
const ISSUE = 'kit-donors';
const AUTOMATIONS_URL = `${SITE_ORIGIN}/admin/#automations`;
const PAYMENT_ID = /^[A-Za-z0-9_-]{6,64}$/;
// Kit states that mean "don't email": never tagged, never touched
const LEFT_OUT = new Set(['cancelled', 'bounced', 'complained']);
// SOARD's own domains and any address under them (nomail.soardcharity.com included)
const OWN = /(^|\.)(soardcharity\.com|sunshineonaranneyday\.com)$/i;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ─── Storage ────────────────────────────────────────────────────────

const _ready = new WeakSet();
async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(`CREATE TABLE IF NOT EXISTS kit_donors (
    payment_id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, paid_at INTEGER, updated_at TEXT NOT NULL)`).run();
  _ready.add(DB);
}

export async function readDonorConfig(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(CONFIG_KEY).first();
  try { return row ? JSON.parse(row.data) : {}; } catch { return {}; }
}

async function writeDonorConfig(DB, patch) {
  const next = { ...(await readDonorConfig(DB)), ...patch };
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(CONFIG_KEY, JSON.stringify(next), new Date().toISOString()).run();
  return next;
}

// ─── Who ────────────────────────────────────────────────────────────

/** The giver's email, lowercased, or null */
export function donorEmail(p) {
  const e = clean(p?.buyer?.email).toLowerCase();
  return isEmail(e) ? e : null;
}

/** Why a payment's giver isn't added, or null when they should be */
export function whyLeftOut(p) {
  const skip = screenPayment(p);
  if (skip) return skip;
  if (p?.metadata?.soardSelfTest === true) return 'website test';
  const email = donorEmail(p);
  if (!email) return 'no email';
  if (OWN.test(email.split('@')[1])) return 'SOARD address';
  return null;
}

/** A first name for Kit's "Hi {first name}", or null when the box holds a company's name. "RANDOLPH" or "jane" reads as a name */
export function donorFirstName(buyer) {
  let first = clean(buyer?.first_name);
  if (!first || /[\d@]/.test(first)) return null;
  const same = (x) => clean(x).toLowerCase() === first.toLowerCase();
  if (same(buyer?.last_name) || (buyer?.is_corporate && same(buyer?.company_name))) return null;
  if (first === first.toUpperCase() || first === first.toLowerCase()) first = first.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return first.slice(0, 60);
}

/** An error worth keeping: never with an email address in it */
const scrub = (msg) => String(msg || 'failed').replace(/[^\s@,;:"'<>()]+@[^\s@,;:"'<>()]+/g, '(an address)').slice(0, 300);

// ─── The run ────────────────────────────────────────────────────────

const row = (DB, p, state, reason, attempts, iso) => DB.prepare(`INSERT INTO kit_donors (payment_id, state, reason, attempts, paid_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(payment_id) DO UPDATE SET state = excluded.state, reason = excluded.reason,
    attempts = excluded.attempts, updated_at = excluded.updated_at`)
  .bind(String(p.id), state, reason, attempts, Number.isFinite(Number(p.created)) ? Math.floor(Number(p.created)) : null, iso);

async function batched(DB, statements) {
  for (let i = 0; i < statements.length; i += 50) await DB.batch(statements.slice(i, i + 50));
}

/**
 * One pass: Zeffy's gifts in the window, each new giver handled once.
 * → { at, checked, added, tagged, leftOut, skipped, failed, gaveUp, waiting, error }. Never throws.
 */
export async function runDonorSync(env, { now = Date.now(), fetchImpl = fetch, alert = null } = {}) {
  const iso = new Date(now).toISOString();
  const run = { at: iso, checked: 0, added: 0, tagged: 0, leftOut: 0, skipped: 0, failed: 0, gaveUp: 0, waiting: 0, error: null };
  const DB = env.DB;
  let cfg = {};
  let failedFrom = null;
  const gaveUpIds = []; // Zeffy payment ids, for the staff note (never an email)
  try {
    await ensureSchema(DB);
    cfg = await readDonorConfig(DB);
    const nowS = Math.floor(now / 1000);
    const startS = Math.floor(Date.parse(START) / 1000);
    const from = cfg.caughtUp ? Math.max(startS, nowS - LOOKBACK_DAYS * 86400) : startS;
    const to = nowS - GRACE_S;

    let payments;
    try {
      payments = (await listPayments(env, { from, to, pages: PAGES }, fetchImpl))
        .filter((p) => PAYMENT_ID.test(String(p?.id || '')))
        .sort((a, b) => Number(a.created) - Number(b.created));
    } catch (e) {
      failedFrom = 'zeffy';
      throw new Error(e.status === 401 ? 'Zeffy refused ZEFFY_API_KEY' : `Zeffy: ${e.message}`);
    }
    run.checked = payments.length;

    // Done before: anything but a person Kit refused last time
    const seen = new Map();
    for (let i = 0; i < payments.length; i += 50) {
      const ids = payments.slice(i, i + 50).map((p) => String(p.id));
      const rows = await DB.prepare(`SELECT payment_id, state, attempts FROM kit_donors WHERE payment_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
      for (const r of rows.results || []) seen.set(r.payment_id, r);
    }
    const todo = payments.filter((p) => { const r = seen.get(String(p.id)); return !r || r.state === 'failed'; });

    // Screened, then grouped by person (two gifts from one giver: one person)
    const writes = [];
    const people = new Map();
    for (const p of todo) {
      const why = whyLeftOut(p);
      if (why) { writes.push(row(DB, p, 'skipped', why, 0, iso)); run.skipped++; continue; }
      const email = donorEmail(p);
      if (!people.has(email)) {
        if (people.size >= MAX_PEOPLE) { run.waiting++; continue; }
        people.set(email, { payments: [], firstName: null, tries: 0 });
      }
      const who = people.get(email);
      who.payments.push(p);
      who.firstName ||= donorFirstName(p.buyer);
      who.tries = Math.max(who.tries, Number(seen.get(String(p.id))?.attempts || 0));
    }
    await batched(DB, writes);

    if (people.size) {
      failedFrom = 'kit';
      const found = await kitFindSubscribers(env, [...people.keys()]);
      if (!found.ok) throw new Error(found.error);
      const tagId = await kitTagId(env, DONOR_TAG, { create: true });
      if (!tagId) throw new Error(`Kit wouldn’t find or make the “${DONOR_TAG}” tag`);
      failedFrom = null;
      const done = [];
      for (const [email, who] of people) {
        const record = (state, reason, attempts = 0) => { for (const p of who.payments) done.push(row(DB, p, state, reason, attempts, iso)); };
        const k = found.byEmail.get(email);
        if (k && LEFT_OUT.has(k.state)) { record('left-out', k.state); run.leftOut++; continue; }
        let id = k?.id;
        let made = false;
        if (!id) {
          const up = await kitUpsertSubscriber(env, email, { firstName: who.firstName });
          // Kit had them after all (the lookup missed them): never touch someone who said no
          if (up.ok && !up.created && LEFT_OUT.has(up.state)) { record('left-out', up.state); run.leftOut++; continue; }
          if (up.ok) { id = up.id; made = up.created; }
        }
        if (id && await kitTagSubscriberId(env, tagId, id)) {
          record(made ? 'added' : 'tagged', null);
          if (made) run.added++; else run.tagged++;
          continue;
        }
        // Kit refused this one person: tried again next run, then left for a person to look at
        const tries = who.tries + 1;
        if (tries >= GIVE_UP) {
          record('gave-up', 'Kit kept refusing', tries);
          run.gaveUp++;
          gaveUpIds.push(...who.payments.map((p) => String(p.id)));
        } else { record('failed', 'Kit refused', tries); run.failed++; }
      }
      await batched(DB, done);
    }

    // Caught up once a run over the whole catch-up window left nobody behind
    const caughtUp = !!cfg.caughtUp || (run.checked < PAGES * 100 && !run.waiting && !run.failed);
    const totals = { added: 0, tagged: 0, leftOut: 0, ...(cfg.totals || {}) };
    totals.added += run.added; totals.tagged += run.tagged; totals.leftOut += run.leftOut;
    cfg = await writeDonorConfig(DB, {
      lastRun: run, caughtUp, totals, failingSince: null,
      ...(run.added ? { lastAddedAt: iso } : {}),
      ...(caughtUp && !cfg.caughtUp ? { caughtUpAt: iso } : {}),
    });
  } catch (e) {
    run.error = scrub(e.message);
    const failingSince = cfg.failingSince || iso;
    try { cfg = await writeDonorConfig(DB, { lastRun: run, failingSince }); } catch { /* the next run tries again */ }
  }
  await tellStaff(env, cfg, run, failedFrom, now, alert, gaveUpIds);
  return run;
}

/**
 * Kit or Zeffy refusing for an hour: staff told once (Slack and email); the
 * all-clear when it works again. A giver Kit kept refusing: told once, with
 * the Zeffy payment to look up.
 */
async function tellStaff(env, cfg, run, failedFrom, now, alert, gaveUpIds = []) {
  if (!alert) return;
  try {
    if (gaveUpIds.length) {
      await alert(env, {
        level: 'warn', icon: '⚠️', title: 'Kit wouldn’t add a donor to the newsletter',
        detail: `Kit refused the giver of Zeffy ${gaveUpIds.length === 1 ? 'payment' : 'payments'} ${gaveUpIds.join(', ')} ${GIVE_UP} times in a row, so the website stopped trying. Usually the email on the gift is mistyped.`,
        fix: 'Find the payment in Zeffy → Payments, fix the email there if it’s wrong, and add the giver in Kit by hand with the Donors tag.',
        url: 'https://www.zeffy.com/en-US/o/all-payments', urlLabel: 'Open Zeffy payments',
      });
    }
    const since = Date.parse(cfg.failingSince);
    if (run.error) {
      if (cfg.alertedAt || !Number.isFinite(since) || now - since < ALERT_AFTER_MS) return;
      const fix = failedFrom === 'zeffy'
        ? 'Check ZEFFY_API_KEY in Cloudflare: make a new key in Zeffy → Settings → Integrations if it was replaced.'
        : 'Check KIT_API_KEY in Cloudflare: make a new key in Kit → Settings → Developer if it was replaced.';
      await alert(env, {
        level: 'warn', icon: '⚠️', title: 'New donors aren’t reaching the newsletter',
        detail: `Adding Zeffy donors to Kit has been failing since ${new Date(cfg.failingSince).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}: ${run.error}. Nobody is lost: each gift is picked up once it works again.`,
        fix, url: AUTOMATIONS_URL, urlLabel: 'Open Automations', issue: ISSUE,
      });
      await writeDonorConfig(env.DB, { alertedAt: new Date(now).toISOString() });
    } else if (cfg.alertedAt) {
      await alert(env, {
        level: 'info', title: 'New donors are reaching the newsletter again',
        detail: 'Zeffy donors are being added to Kit again, including the ones who gave while it was failing.',
        resolves: ISSUE,
      });
      await writeDonorConfig(env.DB, { alertedAt: null });
    }
  } catch { /* told next run */ }
}

/** The heartbeat's wake-up: every 15 minutes once Zeffy and Kit are both connected. Never throws. */
export async function maybeSyncDonors(env, { now = Date.now(), fetchImpl = fetch, alert = null } = {}) {
  try {
    if (!env.DB || !env.ZEFFY_API_KEY || !kitConfigured(env)) return null;
    const cfg = await readDonorConfig(env.DB);
    if (now - Date.parse(cfg.lastRunAt || 0) < EVERY_MS) return null;
    // Claim the slot first so overlapping wake-ups don't double up
    await writeDonorConfig(env.DB, { lastRunAt: new Date(now).toISOString() });
    return await runDonorSync(env, { now, fetchImpl, alert });
  } catch {
    return null;
  }
}

/** For Site → Automations: times and counts of people only, never an email, a name or an amount */
export async function donorsStatus(DB) {
  const cfg = await readDonorConfig(DB);
  let gaveUp = 0;
  // The table appears with the first run
  try { gaveUp = await DB.prepare("SELECT count(*) AS n FROM kit_donors WHERE state = 'gave-up'").first('n'); } catch { /* none yet */ }
  const r = cfg.lastRun || {};
  return {
    lastRunAt: r.at || null,
    error: r.error || null,
    failingSince: cfg.failingSince || null,
    caughtUp: !!cfg.caughtUp,
    caughtUpAt: cfg.caughtUpAt || null,
    waiting: r.waiting || 0,
    added: cfg.totals?.added || 0,
    tagged: cfg.totals?.tagged || 0,
    leftOut: cfg.totals?.leftOut || 0,
    gaveUp: Number(gaveUp) || 0,
    lastAddedAt: cfg.lastAddedAt || null,
  };
}
