/**
 * Donors: everyone who gives, from Zeffy (Admin → Donors & Partners, public/admin/donors.js; /api/donors-admin)
 * ===========================================================================
 * Peter, Nov 11 2026: "i want a donor crm, similar to how kids is built today". Zeffy stays where every gift is
 * taken, receipted and changed. The site keeps a read-only list of Zeffy's successful payments (donor_payments),
 * never edited here, and draws each donor from it. How the list stays right:
 *   - Every 15 minutes the last WINDOW_DAYS are read again. Only a read that reached Zeffy's last page (has_more
 *     false) settles that window: it removes rows dated inside the range it read that were there before it began and
 *     that it didn't see (a payment deleted, failed or moved in Zeffy). A read cut short removes nothing.
 *   - Every night (from 2 AM Eastern) all of Zeffy's history is read the same way, in chunks across runs, resuming
 *     where it stopped; only once it reached the end does it remove rows nothing has seen since it began.
 *   - The gift webhook puts a new payment in at once (noteDonorPayment); the next read settles it.
 * Zeffy allows 100 requests a minute for the whole organization. These reads stop when Zeffy says fewer than
 * RESERVE are left (_zeffy.js zeffyQuota) and carry on next run, so Checks, gift alerts and Kit donors are never
 * crowded out; nothing else waits on them.
 * What keeps a strange answer from emptying the list: a read counts as finished only when Zeffy says has_more: false
 * on a real list (anything else stops it with an error, removing nothing); a read that would take out more than a
 * tenth of what it covers holds them and takes them out only if the next whole read agrees; a gift first seen in the
 * last half hour (from the webhook, ahead of Zeffy's list) is never taken out; one run at a time (an atomic claim);
 * and a run stops reading after RUN_MS, carrying on where it stopped.
 *
 * What counts as giving (one rule, givingOf): money received, net of refunds, including imported history (the old
 * Kindful gifts set first gift and years in a row). Donations, and tickets whose rate is a sponsorship (golf
 * sponsorships share a link with foursomes, so it's the rate, not the form). Tickets, auction items and shop orders
 * aren't giving; gifts in kind are counted apart. A donor is the Zeffy contact who paid; a payment with no contact is
 * its buyer's email, else name. Which gifts count for an organization, and which people are one, is the site's own
 * knowledge (./_donor-crm.js passes it in as `crm`); without it a gift for a company is the payer's, "for Acme". A gift
 * from a donor-advised fund is the donor's, "through" the fund.
 *
 * Gift names: a campaign named for a child reads "Makeovers" (the board's campaignOf), so no donor ties to a kid.
 * The site's own test records (Checks' write test, the gift alerts' self-test) never enter the list.
 */
import { zeffyGet, zeffyQuota, givenName, recurringLabel, WRITE_TEST_NAME, WRITE_TEST_ONE_WORD } from './_zeffy.js';
import { joinCharges, campaignOf, kidNames } from './_board-gifts.js';
import { isTag } from '../../public/admin/checks-shared.js';
import { todayEastern } from './_reveals.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
export const WINDOW_DAYS = 120;
const READ_EVERY_MS = 15 * MIN;
// Pages a run may read: the window is a few pages for SOARD; the nightly read takes its history in chunks
const WINDOW_PAGES = 15;
const FILL_PAGES = 8;
// Leave Zeffy this many requests in the minute for everything else
export const RESERVE = 35;
const FILL_HOUR_ET = 2;
// A run that died keeps its claim this long before another may start
const CLAIM_MS = 5 * MIN;
// A run's reading time (the heartbeat gives about 30 seconds to everything on it)
const RUN_MS = 12 * 1000;
// Never taken out: a gift first seen this recently (the webhook can be ahead of Zeffy's list)
const GRACE_MS = 30 * MIN;
// More than HOLD_MIN gone in one read (and, for the window, more than HOLD_SHARE of it) is held until a whole read of
// the same kind within HOLD_AGREE_MS agrees; a held nightly read is read again after REFILL_MS to settle it
const HOLD_SHARE = 0.1;
const HOLD_MIN = 25;
const HOLD_AGREE_MS = 3 * 60 * MIN;
const REFILL_MS = 60 * MIN;
// The nightly read starts over after this many errors in a row (a cursor Zeffy no longer knows)
const FILL_TRIES = 3;
const FILL_EVERY_MS = 2 * MIN;
export const NEW_MS = 365 * DAY;
export const LAPSED_MS = 548 * DAY; // 18 months
const KEY = 'donors';
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lower = (s) => clean(s).toLowerCase();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS donor_payments (
    id TEXT PRIMARY KEY, contact TEXT, at INTEGER NOT NULL, cents INTEGER NOT NULL, net INTEGER NOT NULL,
    giving INTEGER NOT NULL, in_kind INTEGER NOT NULL DEFAULT 0, type TEXT, method TEXT,
    corporate INTEGER NOT NULL DEFAULT 0, company TEXT, first TEXT, last TEXT, email TEXT,
    campaign_id TEXT, campaign TEXT, category TEXT, every TEXT, sub TEXT, anonymous INTEGER NOT NULL DEFAULT 0,
    refund TEXT, first_seen TEXT NOT NULL, checked_at TEXT NOT NULL, was_contact TEXT)`,
  'CREATE INDEX IF NOT EXISTS donor_payments_contact ON donor_payments(contact)',
  'CREATE INDEX IF NOT EXISTS donor_payments_at ON donor_payments(at)',
  'CREATE INDEX IF NOT EXISTS donor_payments_checked ON donor_payments(checked_at)',
  // A monthly gift's first time (./_donor-thanks.js), and gifts first seen since a time (the thank-you run's question)
  'CREATE INDEX IF NOT EXISTS donor_payments_sub ON donor_payments(sub)',
  'CREATE INDEX IF NOT EXISTS donor_payments_seen ON donor_payments(first_seen)',
  // A giver known by email: whose contact it is now (./_donor-crm.js followMerges, every whole read)
  'CREATE INDEX IF NOT EXISTS donor_payments_email ON donor_payments(email)',
  'CREATE TABLE IF NOT EXISTS donor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  // When the site first saw each payment, kept after one leaves the list (a read that left it out): back in it, it's
  // the gift it always was, never new (an old check To thank as if it came today)
  'CREATE TABLE IF NOT EXISTS donor_seen (id TEXT PRIMARY KEY, first_seen TEXT NOT NULL)',
];
const ready = new WeakSet();
export async function ensureDonors(DB) {
  if (ready.has(DB)) return;
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  // A table made before was_contact (local and preview databases): the column added once
  try { await DB.prepare('ALTER TABLE donor_payments ADD COLUMN was_contact TEXT').run(); } catch (e) { if (!/duplicate column/i.test(String(e?.message || e))) throw e; }
  ready.add(DB);
}
export async function readDonorState(DB) {
  await ensureDonors(DB);
  const row = await DB.prepare('SELECT value FROM donor_state WHERE key = ?').bind(KEY).first();
  try { return JSON.parse(row?.value || '{}'); } catch { return {}; }
}
async function writeDonorState(DB, patch) {
  const next = { ...(await readDonorState(DB)), ...patch };
  await DB.prepare('INSERT INTO donor_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(KEY, JSON.stringify(next)).run();
  return next;
}

// ─── One payment ────────────────────────────────────────────────────

/** The site's own test records (_check-gifts.js's write test, the gift alerts' self-test) */
export function isSiteTest(p) {
  const last = clean(p?.buyer?.last_name);
  return last === WRITE_TEST_NAME.last_name || last === WRITE_TEST_ONE_WORD || p?.metadata?.soardSelfTest === true;
}
/** A form question asking to give anonymously, answered yes (as the board reads it) */
export const anonymousOf = (p) => (p?.buyer_questions || []).some((q) => /anonym/i.test(String(q?.question || '')) && (q.answer === true || /^(yes|true|oui|s[ií])$/i.test(clean(q.answer))));
const SPONSOR = /sponsor|underwrit|presenting/i;
const GIFT_ITEMS = new Set(['donation', 'additional_donation']);
const NOT_GIVING = new Set(['shop', 'auction', 'raffle', 'sweepstakes']);
/** Money received, after refunds that went through */
// Refunded in full is nothing given, whether or not Zeffy listed the refund itself
export const netOf = (p) => (String(p?.dispute?.status || '').toLowerCase() === 'lost' || String(p?.refund_status || '').toLowerCase() === 'full' ? 0
  : Math.max(0, Number(p?.amount || 0) - (p?.refunds || []).filter((r) => r?.status === 'succeeded').reduce((t, r) => t + (Number(r.amount) || 0), 0)));
/**
 * How much of a payment is giving: its donation items and sponsorship tickets, after refunds. Zeffy doesn't say what
 * a refund was for, so it comes off what was bought first (a foursome refunded, the hole sponsorship stands). A payment
 * with no items (a check, a hand entry, an import) is giving unless its form sells something
 */
export function givingOf(p, net = netOf(p)) {
  if (String(p?.payment_method?.type || '').toLowerCase() === 'in_kind') return 0;
  const items = Array.isArray(p?.items) ? p.items : [];
  if (!items.length) return NOT_GIVING.has(String(p?.campaign_category || '').toLowerCase()) ? 0 : net;
  const total = items.reduce((t, it) => t + (Number(it?.amount) || 0), 0);
  const gift = items.filter((it) => GIFT_ITEMS.has(it?.type) || (it?.type === 'ticket' && SPONSOR.test(`${it.rate_title || ''} ${it.parent_rate_title || ''}`)))
    .reduce((t, it) => t + (Number(it?.amount) || 0), 0);
  if (!(total > 0)) return net;
  return Math.min(gift, net);
}
/** Who a payment is from, as the list keys them: the Zeffy contact who paid, else their email, else name */
export function donorKey(p) {
  if (p.contact) return `c:${p.contact}`;
  if (clean(p.email)) return `e:${lower(p.email)}`;
  const name = lower(`${clean(p.first)} ${clean(p.last)}`) || lower(p.company);
  return name ? `n:${name}` : `x:${p.id}`;
}

/** A Zeffy payment as a row of the list, or null for what never enters it */
export function rowFromPayment(p, nowIso) {
  const id = String(p?.id || '');
  if (!id || isSiteTest(p)) return null;
  if (p.status && String(p.status).toLowerCase() !== 'succeeded') return null;
  const b = p.buyer || {};
  const net = netOf(p);
  const method = String(p.payment_method?.type || '').toLowerCase() || null;
  return {
    id, contact: p.contact ? String(p.contact) : null, at: Math.floor(Number(p.created) || 0), cents: Number(p.amount) || 0, net,
    giving: givingOf(p, net), in_kind: method === 'in_kind' ? net : 0, type: p.type || null, method,
    corporate: b.is_corporate ? 1 : 0, company: clean(b.company_name) || null,
    // The address Checks parks on a contact for a moment (check-…@nomail.soardcharity.com) is nobody's email
    first: clean(b.first_name) || null, last: clean(b.last_name) || null, email: lower(b.email) && !isTag(b.email) ? lower(b.email) : null,
    campaign_id: p.campaign_id ? String(p.campaign_id) : null, campaign: clean(p.description) || null, category: p.campaign_category || null,
    every: recurringLabel(p) || null, sub: p.recurring?.subscription_id ? String(p.recurring.subscription_id) : (p.recurring?.id ? String(p.recurring.id) : null),
    anonymous: anonymousOf(p) ? 1 : 0, refund: p.refund_status || null, first_seen: nowIso, checked_at: nowIso,
  };
}
const COLS = ['id', 'contact', 'at', 'cents', 'net', 'giving', 'in_kind', 'type', 'method', 'corporate', 'company', 'first', 'last', 'email', 'campaign_id', 'campaign', 'category', 'every', 'sub', 'anonymous', 'refund', 'first_seen', 'checked_at'];
// Read back with the contact a payment had before Zeffy moved it (a merge of two contacts): the site follows it
export const READ_COLS = [...COLS, 'was_contact'];
// first_seen keeps the first time any read saw it; everything else is what Zeffy says now. A payment whose contact
// changed keeps the one it had (SET reads the row as it was)
const UPSERT = `INSERT INTO donor_payments (${COLS.join(', ')}) VALUES (${COLS.map((c) => (c === 'first_seen' ? 'COALESCE((SELECT s.first_seen FROM donor_seen s WHERE s.id = ?), ?)' : '?')).join(', ')})
  ON CONFLICT(id) DO UPDATE SET ${COLS.filter((c) => !['id', 'first_seen', 'checked_at'].includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')},
    checked_at = MAX(donor_payments.checked_at, excluded.checked_at),
    was_contact = CASE WHEN donor_payments.contact IS NOT NULL AND donor_payments.contact IS NOT excluded.contact THEN donor_payments.contact ELSE donor_payments.was_contact END`;
async function putRows(DB, rows) {
  await ensureDonors(DB);
  for (let i = 0; i < rows.length; i += 50) await DB.batch(rows.slice(i, i + 50).map((r) => DB.prepare(UPSERT).bind(...COLS.flatMap((c) => (c === 'first_seen' ? [r.id, r[c] ?? null] : [r[c] ?? null])))));
}

/** A payment the gift webhook just delivered: in the list at once, and To thank at once if it needs a thank-you */
export async function noteDonorPayment(env, p, { now = Date.now(), thanks = true } = {}) {
  if (!env?.DB) return false;
  await ensureDonors(env.DB);
  const row = rowFromPayment(p, new Date(now).toISOString());
  if (!row) return false;
  const before = await env.DB.prepare('SELECT contact FROM donor_payments WHERE id = ?').bind(row.id).first().catch(() => null);
  await putRows(env.DB, [row]);
  if (before?.contact && row.contact && before.contact !== row.contact) {
    try { await (await import('./_donor-crm.js')).followMerges(env.DB, { now }); } catch (e) { console.error('[donors] merges', e.message); }
  }
  // A giver known by email whose gift brings a Zeffy contact: what was said about them goes to it now, not in 15 minutes
  if (row.contact && row.email) { try { await (await import('./_donor-crm.js')).followEmail(env.DB, row.email); } catch (e) { console.error('[donors] email', e.message); } }
  if (thanks) await (await import('./_donor-thanks.js')).syncThanks(env, { now, ask: false });
  return true;
}

// ─── Reading Zeffy ──────────────────────────────────────────────────

/** Is Zeffy's minute too full for a bulk read? (only what Zeffy itself said in the last minute counts) */
const quotaLow = (now) => zeffyQuota.remaining != null && now - zeffyQuota.at < MIN && zeffyQuota.remaining < RESERVE;

/**
 * Pages of successful payments in a range, from a cursor. Stops at the last page (done), at `pages`, or when
 * Zeffy's minute runs low; says which, and where to start next
 */
async function readPages(env, { from, to, after = null, pages, now, fetchImpl, deadline = Infinity }) {
  const rows = [];
  const iso = new Date(now).toISOString();
  let cursor = after;
  for (let i = 0; i < pages; i++) {
    if (quotaLow(Date.now())) return { rows, done: false, cursor, stopped: 'quota' };
    if (Date.now() > deadline) return { rows, done: false, cursor, stopped: 'time' };
    const r = await zeffyGet(env, '/payments', { status: 'succeeded', 'created[gte]': from, 'created[lte]': to, limit: 100, starting_after: cursor }, fetchImpl);
    if (!r || typeof r !== 'object' || !Array.isArray(r.data)) throw new Error('Zeffy’s answer wasn’t a list of payments');
    for (const p of r.data) { const row = rowFromPayment(p, iso); if (row) rows.push(row); }
    if (r.has_more === false) return { rows, done: true, cursor: null };
    if (r.has_more !== true || !r.next_cursor) throw new Error('Zeffy’s list didn’t say where it went on');
    cursor = r.next_cursor;
  }
  return { rows, done: false, cursor, stopped: 'pages' };
}

/**
 * Rows dated in [from, to] that no read has seen since `since` (and first seen before the grace): Zeffy no longer
 * lists them. More than a tenth of the range at once is held: taken out only when the last whole read of the same
 * kind held about as many (`held`), so one odd answer never empties the list
 */
async function dropUnseen(DB, { from = 0, to = Number.MAX_SAFE_INTEGER, since, now, kind, held = null }) {
  await ensureDonors(DB);
  const grace = new Date(now - GRACE_MS).toISOString();
  const where = 'at >= ? AND at <= ? AND checked_at < ? AND first_seen < ?';
  const total = Number((await DB.prepare('SELECT COUNT(*) AS n FROM donor_payments WHERE at >= ? AND at <= ?').bind(from, to).first())?.n) || 0;
  const gone = Number((await DB.prepare(`SELECT COUNT(*) AS n FROM donor_payments WHERE ${where}`).bind(from, to, since, grace).first())?.n) || 0;
  if (!gone) return { dropped: 0, held: null };
  // The whole history is many times one night's change: there any shrink past HOLD_MIN waits for a second read
  const big = gone > HOLD_MIN && (kind === 'fill' || gone > total * HOLD_SHARE);
  const agreed = held?.kind === kind && now - Date.parse(held.at) <= HOLD_AGREE_MS && Math.abs(held.count - gone) <= Math.max(2, held.count * 0.05);
  if (big && !agreed) return { dropped: 0, held: { kind, count: gone, of: total, at: new Date(now).toISOString() } };
  // (when each was first seen, kept: one listed again is the gift it was)
  const [, r] = await DB.batch([
    DB.prepare(`INSERT OR IGNORE INTO donor_seen (id, first_seen) SELECT id, first_seen FROM donor_payments WHERE ${where}`).bind(from, to, since, grace),
    DB.prepare(`DELETE FROM donor_payments WHERE ${where}`).bind(from, to, since, grace),
  ]);
  return { dropped: r?.meta?.changes || 0, held: null };
}

/** The last WINDOW_DAYS, read whole: settles that window only when it reached Zeffy's last page */
export async function readWindow(env, { now = Date.now(), fetchImpl = fetch, deadline = Infinity, held = null } = {}) {
  const began = new Date(now).toISOString();
  const from = Math.floor((now - WINDOW_DAYS * DAY) / 1000);
  const to = Math.floor(now / 1000);
  const r = await readPages(env, { from, to, pages: WINDOW_PAGES, now, fetchImpl, deadline });
  await putRows(env.DB, r.rows);
  const d = r.done ? await dropUnseen(env.DB, { from, to, since: began, now, kind: 'window', held }) : { dropped: 0, held };
  return { done: r.done, read: r.rows.length, dropped: d.dropped, held: d.held, stopped: r.stopped || null };
}

/**
 * The nightly read of all of Zeffy's history, a chunk a run. `fill` in the state: { began, cursor } while it's going.
 * Ends by removing what nothing has seen since it began
 */
export async function readFill(env, state, { now = Date.now(), fetchImpl = fetch, deadline = Infinity } = {}) {
  const fill = state.fill?.began ? state.fill : { began: new Date(now).toISOString(), cursor: null };
  const r = await readPages(env, { from: 0, to: Math.floor(Date.parse(fill.began) / 1000) + 3600, after: fill.cursor, pages: FILL_PAGES, now, fetchImpl, deadline });
  await putRows(env.DB, r.rows);
  if (!r.done) return { fill: { ...fill, cursor: r.cursor }, read: r.rows.length, done: false };
  // Only payments dated before the read began: anything newer the window and the webhook keep
  const d = await dropUnseen(env.DB, { to: Math.floor(Date.parse(fill.began) / 1000), since: fill.began, now, kind: 'fill', held: state.heldFill || null });
  return { fill: null, read: r.rows.length, done: true, dropped: d.dropped, held: d.held };
}

/** One run at a time: an atomic claim (a run that died lets go after CLAIM_MS) */
async function takeClaim(DB, now) {
  await ensureDonors(DB);
  const iso = new Date(now).toISOString();
  const r = await DB.prepare("INSERT INTO donor_state (key, value) VALUES ('claim', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE donor_state.value < ?")
    .bind(iso, new Date(now - CLAIM_MS).toISOString()).run();
  return r.meta?.changes ? iso : null;
}
const letGo = (DB, claim) => DB.prepare("UPDATE donor_state SET value = '0' WHERE key = 'claim' AND value = ?").bind(claim).run();

const etHour = (now) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));

/** On the heartbeat: the window every 15 minutes, and the nightly history read while it's going. Never throws */
const STOPPED = { quota: 'Zeffy was busy', time: 'Zeffy was slow to answer', pages: 'More payments than one read takes' };
const errorWords = (e) => (e.status === 401 ? 'Zeffy refused ZEFFY_API_KEY' : e.status === 429 ? 'Zeffy was busy' : String(e.message || 'Zeffy didn’t answer').slice(0, 200));

/**
 * On the heartbeat: the window every 15 minutes (tried, finished or not), and the nightly history read every couple
 * of minutes while it's going. Never throws
 */
export async function maybeReadDonors(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!env?.DB || !String(env.ZEFFY_API_KEY || '').trim()) return null;
  let claim = null;
  try {
    const s = await readDonorState(env.DB);
    const windowDue = !s.windowTriedAt || now - Date.parse(s.windowTriedAt) >= READ_EVERY_MS;
    const today = todayEastern(now);
    // The nightly read; or, when the last one held a shrink, a second read an hour on to settle it
    const refill = !s.fill?.began && !!s.heldFill?.at && now - Date.parse(s.heldFill.at) >= REFILL_MS;
    const fillDue = (!!s.fill?.began || refill || (s.filledOn !== today && etHour(now) >= FILL_HOUR_ET)) && (!s.fillTriedAt || now - Date.parse(s.fillTriedAt) >= (s.fillError ? READ_EVERY_MS : FILL_EVERY_MS));
    if (!windowDue && !fillDue) return null;
    claim = await takeClaim(env.DB, now);
    if (!claim) return null;
    const deadline = Date.now() + RUN_MS;
    const patch = {};
    let failed = null;
    if (windowDue) {
      patch.windowTriedAt = claim;
      try {
        const w = await readWindow(env, { now, fetchImpl, deadline, held: s.heldWindow || null });
        patch.heldWindow = w.held;
        if (w.done) { patch.windowAt = claim; patch.windowError = null; } else patch.windowError = STOPPED[w.stopped] || 'The read stopped';
      } catch (e) {
        patch.windowError = failed = errorWords(e);
      }
    }
    if (fillDue && Date.now() < deadline) {
      patch.fillTriedAt = claim;
      try {
        const f = await readFill(env, s, { now, fetchImpl, deadline });
        patch.fill = f.fill;
        patch.fillErrors = 0;
        patch.fillError = null;
        if (f.done) { patch.filledOn = today; patch.filledAt = claim; patch.heldFill = f.held; }
      } catch (e) {
        // A cursor Zeffy no longer knows (its payment deleted between runs) would stop it for good: start over
        const tries = (Number(s.fillErrors) || 0) + 1;
        patch.fillErrors = tries >= FILL_TRIES ? 0 : tries;
        if (tries >= FILL_TRIES) patch.fill = null;
        patch.fillError = errorWords(e);
      }
    }
    // An error (not a read cut short by Zeffy's minute or the time): shown until a read goes through
    patch.error = failed || patch.fillError || null;
    if (patch.error) patch.errorAt = claim;
    // After a whole read: what the site knows about a contact Zeffy merged away goes with its gifts (./_donor-crm.js)
    if (patch.windowAt === claim || patch.filledAt === claim) {
      try { await (await import('./_donor-crm.js')).followMerges(env.DB, { now }); } catch (e) { console.error('[donors] merges', e.message); }
    }
    // Gifts that need a thank-you from SOARD (./_donor-thanks.js), after each whole read
    if (patch.windowAt === claim || patch.filledAt === claim) await (await import('./_donor-thanks.js')).syncThanks(env, { now, fetchImpl });
    // Kept organizations' names, written down as they are now (a rename in the Partners editor keeps the old one hidden)
    try { const m = await import('./_donor-crm.js'); const crm = await m.loadCrm(env.DB, { now }); if (crm.anyKeptAnonymous) await m.rememberKeptNames(env.DB, crm, { now }); } catch (e) { console.error('[donors] kept names', e.message); }
    return await writeDonorState(env.DB, patch);
  } catch (e) {
    console.error('[donors]', e.message);
    return null;
  } finally {
    if (claim) await letGo(env.DB, claim).catch(() => null);
  }
}

// ─── Donors, from the list ──────────────────────────────────────────

// The year in Eastern time: New Year falls in standard time (UTC−5) every year, so no time-zone lookup per gift
const yearOf = (atS) => new Date((Number(atS) - 5 * 3600) * 1000).getUTCFullYear();
/** The charges of one donor as gifts (a gift Zeffy split into charges is one), newest first */
export function giftsFrom(rows, kids = []) {
  // A gift in kind carries its value as its cents (never joined with money: the key says which), and never counts as giving
  return joinCharges(rows.map((r) => ({
    id: r.id, at: r.at, cents: r.method === 'in_kind' ? r.in_kind : r.giving, anonymous: !!r.anonymous, name: '', company: r.company || '',
    campaign: campaignOf(r.campaign, kids), every: r.every || '', inKind: r.method === 'in_kind', method: r.method, type: r.type,
    key: r.every || (!r.giving && !r.in_kind) ? `id\n${r.id}` : [donorKey(r), r.campaign || '', r.method === 'in_kind'].join('\n'),
  })), { ids: true });
}

/** One donor from their rows: who, how much, since when, and their stage */
export function donorOf(key, rows, { now = Date.now(), kids = [] } = {}) {
  const nowS = Math.floor(now / 1000);
  const gifts = giftsFrom(rows, kids);
  const given = gifts.filter((g) => !g.inKind && g.cents > 0);
  const inKind = gifts.filter((g) => g.inKind).reduce((t, g) => t + g.cents, 0);
  const byYear = new Map();
  for (const g of given) byYear.set(yearOf(g.at), (byYear.get(yearOf(g.at)) || 0) + g.cents);
  const thisYear = yearOf(nowS);
  // Years in a row, counting back from this year (or last year, while this year has nothing yet)
  let streak = 0;
  for (let y = byYear.has(thisYear) ? thisYear : thisYear - 1; byYear.has(y); y--) streak++;
  // Named as their own Zeffy records name them, the newest (one joined from several: the name they gave under last),
  // never by a gift that only shares their email
  const own = String(key).startsWith('c:') ? rows.filter((r) => r.contact) : [];
  const newest = [...(own.length ? own : rows)].sort((a, b) => b.at - a.at);
  const named = newest.find((r) => clean(r.first) || clean(r.last)) || newest[0] || {};
  // As the board and Slack say it: a name typed in both boxes ("Pella" / "Pella") once
  const person = givenName({ first_name: named.first, last_name: named.last });
  const companies = [...new Set(rows.filter((r) => r.corporate && r.company && r.method !== 'daf').map((r) => r.company))];
  const funds = [...new Set(rows.filter((r) => r.method === 'daf' && r.company).map((r) => r.company))];
  const first = given.length ? given.reduce((a, g) => (g.at < a.at ? g : a)) : null;
  const latest = given[0] || null;
  const largest = given.length ? given.reduce((a, g) => (g.cents > a.cents ? g : a)) : null;
  const total = given.reduce((t, g) => t + g.cents, 0);
  // (a gift in kind Zeffy has no value for is a gift all the same)
  const gaveInKind = inKind > 0 || rows.some((r) => r.method === 'in_kind' && String(r.refund || '') !== 'full');
  const stage = !latest ? (gaveInKind ? 'inkind' : 'none') : nowS - first.at < NEW_MS / 1000 ? 'new' : nowS - latest.at <= LAPSED_MS / 1000 ? 'active' : 'lapsed';
  return {
    key,
    contact: rows.find((r) => r.contact)?.contact || null,
    name: person || named.company || named.email || 'No name',
    email: newest.find((r) => r.email)?.email || null,
    companies, funds,
    anonymous: rows.some((r) => r.anonymous),
    total, thisYear: byYear.get(thisYear) || 0, lastYear: byYear.get(thisYear - 1) || 0,
    inKind,
    gifts: given.length,
    first: first && { at: first.at, cents: first.cents },
    latest: latest && { at: latest.at, cents: latest.cents },
    largest: largest && { at: largest.at, cents: largest.cents },
    streak, stage,
    years: [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, cents]) => ({ year, cents })),
  };
}

export async function allRows(DB) {
  await ensureDonors(DB);
  return (await DB.prepare(`SELECT ${READ_COLS.join(', ')} FROM donor_payments`).all()).results || [];
}
const inList = (n) => Array.from({ length: n }, () => '?').join(', ');
/**
 * The rows one donor's page needs: their contacts' (every key a person said is them: `keys`), payments with no contact
 * under those contacts' emails or theirs, and the other holders of those emails (keyIn decides whose a loose one is)
 */
export async function rowsFor(DB, keys) {
  const list = [].concat(keys);
  if (list.some((k) => !/^[ce]:/.test(String(k)))) return allRows(DB);
  await ensureDonors(DB);
  // D1 takes 100 bound values a query: every list is read in chunks, none cut short
  const read = async (where, vals) => {
    const out = [];
    for (let i = 0; i < vals.length; i += 80) {
      const part = vals.slice(i, i + 80);
      out.push(...((await DB.prepare(`SELECT ${READ_COLS.join(', ')} FROM donor_payments WHERE ${where} (${inList(part.length)})`).bind(...part).all()).results || []));
    }
    return out;
  };
  const own = await read('contact IN', list.filter((k) => k.startsWith('c:')).map((k) => k.slice(2)));
  const emails = [...new Set([...own.map((r) => r.email), ...list.filter((k) => k.startsWith('e:')).map((k) => k.slice(2))].filter(Boolean))];
  if (!emails.length) return own;
  const seen = new Set(own.map((r) => r.id));
  const loose = await read('contact IS NULL AND email IN', emails);
  // The other holders of those emails: keyIn decides whose a loose one is
  const others = (await read('contact IS NOT NULL AND email IN', emails)).filter((r) => !seen.has(r.id));
  return [...own, ...loose, ...others];
}
/**
 * Rows by donor. A payment Zeffy has no contact for, under an email a contact has, is that contact's, so one person
 * isn't two donors. An email several contacts share (a household): the one whose name it gives, else the newest
 */
const nameOfRow = (r) => clean(`${clean(r.first)} ${clean(r.last)}`).toLowerCase();
const contactsByEmail = (rows) => {
  const m = new Map();
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    if (!r.contact || !r.email) continue;
    const list = m.get(r.email) || [];
    const key = `c:${r.contact}`;
    const had = list.find((x) => x.key === key);
    if (had) { had.at = r.at; if (nameOfRow(r)) had.names.add(nameOfRow(r)); } else list.push({ key, at: r.at, names: new Set(nameOfRow(r) ? [nameOfRow(r)] : []) });
    m.set(r.email, list);
  }
  return m;
};
const keyIn = (r, byEmail) => {
  const list = !r.contact && r.email ? byEmail.get(r.email) : null;
  if (!list?.length) return donorKey(r);
  if (list.length === 1) return list[0].key;
  const named = list.filter((x) => nameOfRow(r) && x.names.has(nameOfRow(r)));
  return (named.length ? named : list).reduce((a, b) => (b.at > a.at ? b : a)).key;
};
/**
 * Who each row counts for: { person: who paid, owner: who it counts for }. Without the site's own knowledge (`crm`,
 * ./_donor-crm.js: organizations and "the same person") both are the person who paid
 */
export function placer(rows, crm = null) {
  if (crm) return crm.placer(rows);
  const keyOf = personKeys(rows);
  return (r) => { const k = keyOf(r); return { person: k, owner: k }; };
}
/** Who paid each row, as the list keys people (a loose payment under a contact's email is that contact's) */
export const personKeys = (rows) => { const byEmail = contactsByEmail(rows); return (r) => keyIn(r, byEmail); };
export const isOrgKey = (k) => /^[po]:/.test(String(k));

/** Every donor, for the list: people and (with `crm`) organizations, compact, newest gift first */
export async function donorsView(env, { now = Date.now(), crm = null, rows: given = null } = {}) {
  const [rows, kids, state] = await Promise.all([given || allRows(env.DB), kidNames(env.DB), readDonorState(env.DB)]);
  const place = placer(rows, crm);
  const by = new Map();
  for (const r of rows) { const { owner } = place(r); by.set(owner, [...(by.get(owner) || []), r]); }
  const people = [];
  for (const [key, list] of by) {
    const d = donorOf(key, list, { now, kids });
    // Only tickets, purchases or refunded gifts: not a donor (an organization staff keep here is listed whatever it gave)
    if (d.stage === 'none' && !(crm && String(key).startsWith('o:') && crm.isOrg(key))) continue;
    const { years, ...rest } = d;
    if (crm && crm.isOrg(key)) {
      // An organization: its name as the site has it, and where it is on the website. Who gave for it (their names and
      // emails) is searched too: a person whose every gift counts for it is found by their own name, at its row
      const givers = new Map();
      for (const r of list) {
        const p = place(r).person;
        const g = givers.get(p) || { name: givenName({ first_name: r.first, last_name: r.last }) || '', emails: new Set() };
        if (r.email) g.emails.add(String(r.email).toLowerCase());
        givers.set(p, g);
      }
      people.push({ ...rest, ...crm.orgFacts(key), key, ref: key, type: 'org', owner: crm.lookedAfterBy(key),
        givers: [...givers.values()].slice(0, 40).map((g) => ({ name: g.name, emails: [...g.emails].slice(0, 3) })) });
      continue;
    }
    // Its address in admin: the Zeffy contact, or one of its gifts (never an email or a name in a link)
    const newest = list.reduce((a, r) => (r.at > a.at ? r : a));
    people.push({ ...rest, ref: d.contact ? d.contact : `g:${newest.id}`, type: 'person', keepAnonymous: crm ? place.kept(key) : false, owner: crm ? crm.lookedAfterBy(key) : null });
  }
  // Organizations staff keep here with nothing counted for them yet: listed, so they can be found and linked
  if (crm) {
    const listed = new Set(people.map((p) => p.key));
    for (const o of crm.org.values()) {
      if (!o.key.startsWith('o:') || listed.has(o.key)) continue;
      const { years, ...rest } = donorOf(o.key, [], { now, kids });
      people.push({ ...rest, ...crm.orgFacts(o.key), key: o.key, ref: o.key, type: 'org', owner: crm.lookedAfterBy(o.key) });
    }
  }
  people.sort((a, b) => (b.latest?.at || 0) - (a.latest?.at || 0));
  return {
    people,
    payments: rows.length,
    windowAt: state.windowAt || null, windowTriedAt: state.windowTriedAt || null, filledAt: state.filledAt || null, filling: !!state.fill?.began,
    error: state.error || null, windowError: state.windowError || null, held: !!(state.heldWindow || state.heldFill),
    newDays: NEW_MS / DAY, lapsedMonths: 18,
  };
}

const HOW = { cheque: 'Check', check: 'Check', daf: 'Donor-advised fund', in_kind: 'In kind', card: 'Card', ach: 'Bank transfer', manual: 'By hand', cash: 'Cash', other: 'Other' };
/** How a gift came, in words */
export function howOf(g) {
  // (an earlier system's history, or a gala's gifts from its auction platform)
  if (g.type === 'imported') return 'Imported into Zeffy';
  const m = String(g.method || '').toLowerCase();
  return HOW[m] || (g.type === 'manual' ? 'Entered by hand' : m ? m[0].toUpperCase() + m.slice(1).replace(/_/g, ' ') : 'Online');
}

/**
 * One donor, with every gift and how it came; a check's own Mercury link where Checks has it. `soft`: what they gave
 * that counts for an organization ("gave for"), by organization
 */
export async function donorView(env, key, { now = Date.now(), crm = null } = {}) {
  const [rows, kids] = await Promise.all([rowsFor(env.DB, crm ? crm.keysOf(key) : key), kidNames(env.DB)]);
  const place = placer(rows, crm);
  const mine = [];
  const soft = new Map();
  for (const r of rows) {
    const { person, owner } = place(r);
    if (owner === key) mine.push(r);
    else if (person === key) soft.set(owner, [...(soft.get(owner) || []), r]);
  }
  if (!mine.length && !soft.size) return null;
  const d = donorOf(key, mine.length ? mine : [...soft.values()].flat(), { now, kids });
  if (!mine.length) Object.assign(d, { total: 0, thisYear: 0, lastYear: 0, inKind: 0, gifts: 0, first: null, latest: null, largest: null, streak: 0, stage: 'none', years: [] });
  const gaveFor = [...soft].map(([org, list]) => {
    const g = giftsFrom(list, kids).filter((x) => !x.inKind && x.cents > 0);
    return { key: org, ...(crm ? crm.orgFacts(org) : { name: org }), cents: g.reduce((t, x) => t + x.cents, 0), gifts: g.length, latest: g[0]?.at || null };
  }).filter((x) => x.gifts).sort((a, b) => b.cents - a.cents);
  return { ...(await giftsView(env, d, mine, kids)), gaveFor };
}

/** A donor (person or organization) and their gifts as the page shows them; `by` names who paid each, for an organization */
export async function giftsView(env, d, mine, kids = [], { by = false } = {}) {
  const gifts = giftsFrom(mine, kids);
  // Checks deposited in Mercury that are these gifts (Checks keeps the Zeffy record each became)
  const ids = gifts.flatMap((g) => g.ids || [g.id]);
  const checks = new Map();
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      const r = await env.DB.prepare(`SELECT zeffy_id, link FROM check_gifts WHERE zeffy_id IN (${part.map(() => '?').join(', ')})`).bind(...part).all();
      for (const c of r.results || []) if (c.link) checks.set(String(c.zeffy_id), c.link);
    }
  } catch { /* no Checks table yet */ }
  const byId = new Map(mine.map((r) => [r.id, r]));
  return {
    donor: d,
    gifts: gifts.map((g) => {
      const charges = g.ids || [g.id];
      const r = byId.get(g.id) || {};
      const refunded = charges.every((id) => { const x = byId.get(id); return x && x.cents > 0 && !x.net; });
      // (part of it refunded: how much, so the gift's line says why it's less than was given)
      const refundedPart = refunded ? 0 : charges.reduce((t, id) => { const x = byId.get(id); return t + (x && Number(x.cents) > Number(x.net) ? Number(x.cents) - Number(x.net || 0) : 0); }, 0);
      return {
        id: g.id, ids: charges, at: g.at, cents: g.inKind ? 0 : g.cents, inKind: g.inKind ? g.cents : 0, kind: !!g.inKind,
        // (a gift in charges that came different ways says each: "Card and Check")
        campaign: g.campaign || '', how: [...new Set(charges.map((id) => byId.get(id)).filter(Boolean).map((x) => howOf(x)))].join(' and ') || howOf(g), every: g.every || '', parts: g.parts || 1, anonymous: g.anonymous,
        forCompany: r.corporate && r.company && r.method !== 'daf' ? r.company : null, through: r.method === 'daf' ? r.company || null : null,
        refunded: refunded || undefined,
        refundedPart: refundedPart > 0 ? refundedPart : undefined,
        sold: !refunded && !g.inKind && !g.cents ? true : undefined,
        mercury: charges.map((id) => checks.get(id)).find(Boolean) || null,
        ...(by ? { by: givenName({ first_name: r.first, last_name: r.last }) || r.email || '' } : {}),
      };
    }),
  };
}

/** A donor's address in admin as their key: a Zeffy contact id, or g:<one of their payments> */
export async function keyOfRef(env, ref) {
  const r = String(ref || '');
  if (r.startsWith('g:')) return donorOfPayment(env, r.slice(2));
  return r ? `c:${r.replace(/^c:/, '')}` : null;
}
/** A donor's address from their key and one payment of theirs */
export const refOfKey = (key, paymentId) => (String(key).startsWith('c:') ? String(key).slice(2) : `g:${paymentId}`);

/** Which donor a payment is (the Slack link to a gift): from the list, else null. With `crm`, who it counts for */
export async function donorOfPayment(env, id, { crm = null } = {}) {
  await ensureDonors(env.DB);
  const r = await env.DB.prepare(`SELECT ${READ_COLS.join(', ')} FROM donor_payments WHERE id = ?`).bind(String(id)).first();
  if (!r) return null;
  if (crm) {
    // As the list places it: with every record a person said is the same giver (a joined record's organization)
    const own = r.contact ? `c:${r.contact}` : r.email ? `e:${r.email}` : donorKey(r);
    const keys = crm.keysOf(crm.canon(own));
    const rows = await rowsFor(env.DB, keys.includes(own) ? keys : [...keys, own]);
    return placer(rows.some((x) => x.id === r.id) ? rows : [...rows, r], crm)(r).owner;
  }
  // As groupRows has it: no contact, but an email a contact has, is that contact's
  if (!r.contact && r.email) {
    const cs = (await env.DB.prepare('SELECT contact, first, last, at FROM donor_payments WHERE contact IS NOT NULL AND email = ? ORDER BY at DESC LIMIT 50').bind(r.email).all()).results || [];
    const c = cs.find((x) => nameOfRow(r) && nameOfRow(x) === nameOfRow(r)) || cs[0];
    if (c?.contact) return `c:${c.contact}`;
  }
  return donorKey(r);
}

/** For the Automations map: times and counts only, never a donor */
export async function donorListStatus(DB) {
  const s = await readDonorState(DB);
  const n = await DB.prepare('SELECT COUNT(*) AS n FROM donor_payments').first().catch(() => null);
  return {
    windowAt: s.windowAt || null, windowTriedAt: s.windowTriedAt || null, windowError: s.windowError || null, filledAt: s.filledAt || null,
    filling: !!s.fill?.began, fillError: s.fillError || null, error: s.error || null, errorAt: s.errorAt || null, payments: Number(n?.n) || 0,
    held: s.heldWindow || s.heldFill ? { count: (s.heldWindow || s.heldFill).count, at: (s.heldWindow || s.heldFill).at } : null,
  };
}
