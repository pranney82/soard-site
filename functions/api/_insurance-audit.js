/**
 * The insurance audits: what SOARD paid its subcontractors in a policy term,
 * and the insurance that covered each payment
 * ===========================================================================
 * Two policies are audited once a year, each on its own term (POLICIES):
 * workers' compensation (April 11 to April 11) and the general liability in
 * the package policy (November 21 to November 21). Each premium auditor asks
 * for the vendor payments and a certificate for every subcontractor paid in
 * the term. A sub paid while they had no workers' comp is added to SOARD's
 * payroll and charged for (the 2025-26 audit: one uninsured sub, every dollar
 * paid to them counted); work by a sub with no liability insurance of their
 * own can be charged to SOARD's liability policy the same way. This puts
 * each audit together:
 *
 *  1. Payments in the term, each counted once: JobTread vendor bills and the
 *     payments recorded on them, Ramp's paid bills (one with a JobTread copy
 *     is that bill, ./_ramp.js matchRampBill) and Mercury payments to
 *     recipients (one ./_bill-pay.js recorded on a bill is that bill; one to
 *     the same vendor for the same amount within days of a payment already
 *     counted is that payment).
 *  2. Subcontractor or supplier, with the reason (isSubcontractor): a
 *     person's call here (works off site, one person with no employees,
 *     sells materials), JobTread's Documents and Materials only fields and
 *     Trades, how the bill was coded, a certificate SOARD already has, a
 *     store's name, paid only by card. "One person, no employees" leaves a
 *     sub out of the workers' comp audit only: liability still counts them.
 *  3. Coverage on each payment's date, the audit's own kind of insurance:
 *     the certificates found (D1 coi_coverage, ./_coi-backfill.js) and
 *     JobTread's Liability Expires and Workers' Comp Expires (with no start
 *     date the policy is taken to begin a year before it ends, and says so).
 *  4. Admin → Job Costs → Insurance audit shows either audit; its spreadsheet
 *     and its auditor's packet (a summary, then each certificate) download
 *     there.
 *  5. Nothing to press: every day each policy's current term is read again,
 *     and a sub paid on days no certificate covers is emailed once for the
 *     certificate that covered that work (their insurance agent when the
 *     trade-partner page has one): one email for both audits, never twice for
 *     the same months. Replies go to info@, in Peter's and Holly's inboxes,
 *     which the certificate search reads. Each ask is noted on the vendor in
 *     JobTread; with no email on file the sub is only listed. Asking waits
 *     until the certificate search has had a few days, so nobody is asked for
 *     a certificate SOARD already has.
 *
 * The payments read from JobTread, Ramp and Mercury are kept per term in D1
 * (insurance_audit_runs) so the page opens at once; coverage, the calls and
 * the asks are read fresh every time.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pave, SOARD_ORG_ID, TZ } from './_reveals.js';
import { sendEmails } from './_broadcast-notify.js';
import { emailShell, paragraphs } from './_email-shell.js';
import { mercuryConfigured, listTransactions, readState } from './_mercury.js';
import { txnRow, readTxns } from './_mercury-txns.js';
import { ramp, rampConfigured, matchRampBill } from './_ramp.js';
import { vendorKey, vendorLikeness, dollars } from './_spend-match.js';
import { vendorNote, STATE_KEY as VENDORS_KEY } from './_vendors.js';

const DAY = 86400e3;
/** The two audited policies, each renewing on its own day. plain: words for the spreadsheet; file: for the download's name */
export const POLICIES = {
  wc: { id: 'wc', starts: { month: 4, day: 11 }, name: 'workers’ compensation', title: 'Workers’ compensation', tab: 'Workers’ comp', plain: 'workers comp', file: 'workers comp' },
  gl: { id: 'gl', starts: { month: 11, day: 21 }, name: 'general liability', title: 'General liability', tab: 'Liability', plain: 'general liability', file: 'liability' },
};
export const TERMS_SHOWN = 3;                       // each policy's term now and the two before it
const CURRENT_EVERY_MS = 20 * 60 * 60 * 1000;       // the current term's payments, read again
const PAST_EVERY_MS = 7 * DAY;                      // a past term's
const RUN_VERSION = 2;                              // a run kept by older code (other payee links) is read again
const FAILED_EVERY_MS = 3 * 60 * 60 * 1000;         // a read where JobTread, Ramp or Mercury didn't answer, tried again
const SAME_PAYMENT_DAYS = 10;                       // a Mercury payment this close to one already counted, same vendor and amount, is that one
const ASK_AFTER_DAYS = 7;                           // a payment this old with no certificate covering it is asked about
const RENEWED_ASK_DAYS = 45;                        // a term that just ended is still asked about this long, so its last week isn't missed
const SEARCH_GRACE_DAYS = 3;                        // the certificate search runs this long before anyone is asked
const ASKS_PER_RUN = 5;
export const REPLY_TO = 'info@soardcharity.com';
const MONEY_TOOLS = /\b(ramp|mercury|american express|amex|chase|capital one|wells fargo|bank of america|irs|internal revenue|department of revenue|dept of revenue|gusto|adp|paychex|intuit|quickbooks|stripe|paypal|venmo|zelle|bill\.com|payroll|sunshine on a ranney day|soard)\b/i;
// The accounts a bill is coded to in Ramp: overhead is never subcontracted work; job costs and repairs can be
const OVERHEAD = /\b(store cogs|rent|utilities|advertising|marketing|vehicle|office expense|legal|professional|consulting|accounting|fundraising expense|gala|insurance expense|bank fees?|merchant|payroll|dues|subscriptions?|software|travel|meals|postage|printing)\b/i;
const JOB_WORK = /\b(makeover cogs|repairs? and maintenance|cost of goods sold|subcontract\w*|labou?r|install\w*)\b/i;
/** A payee's payments by how they were coded → { overheadCents, jobCents, overhead: [account names, most paid first] } */
export function codedAs(payments) {
  const out = { overheadCents: 0, jobCents: 0, overhead: [] };
  const by = new Map();
  for (const p of payments) {
    const cats = p.categories || [];
    if (cats.some((c) => JOB_WORK.test(c))) { out.jobCents += p.cents; continue; }
    const o = cats.find((c) => OVERHEAD.test(c));
    if (o) { out.overheadCents += p.cents; by.set(o, (by.get(o) || 0) + p.cents); }
  }
  out.overhead = [...by].sort((a, b) => b[1] - a[1]).map(([name]) => name.split(':').at(-1).trim());
  return out;
}
const STORES = /\b(home depot|lowe'?s|amazon|wayfair|target|ikea|walmart|costco|sam'?s club|ferguson|floor (and|&) decor|sherwin[- ]williams|pottery barn|west elm|crate (and|&) barrel|cb2|best buy|hobby lobby|home ?goods|kirkland'?s|michaels|overstock|menards|ace hardware|lumber|supply|supplies|wholesale|etsy|walgreens|cvs|spoonflower|wallsauce|ashley|blinds|hardware|lighting|shelf|store|shop|outlet|boutique|market|furniture|furnishings?|upholstery|mattress(es)?|rugs?|decor|tools?|fabrics?|paint store|goods|toys?|canvas)\b|\.com\b/i;
// Services that aren't construction work: rentals, deliveries, permits, IT, media
const SERVICES = /\b(dumpsters?|dump that|waste|loo|portable|rentals?|courier|delivery|movers?|moving|permit\w*|i\.?t\.? solutions|computers?|media|studios?|photograph\w*|video|printing|signs?|catering|florist|bakery|cleaning|pest|bagels?|pizza|cafe|coffee|grill|restaurant|zaxby'?s|chick-fil-a)\b/i;
// A city or county: a fee, not work
const GOVERNMENT = /\b(city|county|state|town) of\b|^[a-z .]+,\s*(ga|georgia)$|\bdept\.? of\b|\bdepartment of\b/i;

/** A person's call on a payee, from the row's menu: whether they count, and the words for why (only: the one audit it decides) */
export const CALLS = {
  'off-site': { sub: false, label: 'Works off site' },
  'no-employees': { sub: false, label: 'One person, no employees', only: 'wc' },
  materials: { sub: false, label: 'Sells materials only' },
  sub: { sub: true, label: 'A subcontractor' },
};

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS insurance_audit_runs (term TEXT PRIMARY KEY, built_at TEXT NOT NULL, data TEXT NOT NULL, error TEXT)',
  'CREATE TABLE IF NOT EXISTS insurance_audit_calls (vendor_key TEXT PRIMARY KEY, jt_id TEXT, name TEXT, sub INTEGER NOT NULL, reason TEXT NOT NULL, by TEXT, at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS insurance_audit_asks (key TEXT PRIMARY KEY, term TEXT NOT NULL, jt_id TEXT NOT NULL, months TEXT NOT NULL, to_email TEXT NOT NULL, to_kind TEXT NOT NULL, sent_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
export async function ensureAuditSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

const parseJson = (s, d = null) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const centsOf = (n) => Math.round(Math.abs(Number(n || 0)) * 100);
const sum = (list, f) => list.reduce((s, x) => s + (f(x) || 0), 0);

// ─── Days and terms ─────────────────────────────────────────────────

export const todayEastern = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: TZ });
/** A date or a moment → its day in Atlanta (YYYY-MM-DD) */
export function easternDay(s) {
  if (!s) return null;
  const t = String(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? todayEastern(ms) : null;
}
export const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const yearBefore = (day) => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;
export const longDay = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }) : '');
const shortDay = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }) : '');
const monthName = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });

/** "March 2026", "March and April 2026", "December 2025 and January 2026" */
export function monthsText(months) {
  const list = [...new Set(months)].sort();
  if (!list.length) return '';
  const years = new Set(list.map((m) => m.slice(0, 4)));
  const words = list.map((m) => (years.size === 1 ? new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long' }) : monthName(m)));
  const joined = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return years.size === 1 ? `${joined} ${[...years][0]}` : joined;
}

const pad = (n) => String(n).padStart(2, '0');
const startOf = (policy, year) => `${year}-${pad(POLICIES[policy].starts.month)}-${pad(POLICIES[policy].starts.day)}`;
/**
 * One policy term: from its start day up to (not including) the next term's.
 * id: 'wc-2026' (workers' comp from April 11, 2026), 'gl-2025' (liability
 * from November 21, 2025); a bare year is workers' comp. → null for anything else
 */
export function term(id, policy = 'wc') {
  const m = /^(?:(wc|gl)-)?(\d{4})$/.exec(String(id ?? ''));
  if (!m) return null;
  const p = m[1] || policy;
  const y = Number(m[2]);
  const start = startOf(p, y);
  const end = startOf(p, y + 1);
  const mon = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
  return { id: `${p}-${y}`, policy: p, year: y, name: POLICIES[p].name, start, end, label: `${longDay(start)} to ${longDay(end)}`, short: `${mon(start)} to ${mon(end)}` };
}
/** The policy's term a day falls in */
export const termOf = (day, policy = 'wc') => { const y = Number(day.slice(0, 4)); return term(day >= startOf(policy, y) ? y : y - 1, policy); };
/** Each policy's current term and the two before it, workers' comp first; or one policy's */
export function termsShown(now = Date.now(), policy = null) {
  return (policy ? [policy] : Object.keys(POLICIES)).flatMap((p) => { const cur = termOf(todayEastern(now), p).year; return Array.from({ length: TERMS_SHOWN }, (_, i) => term(cur - i, p)); });
}
/** Does a month (YYYY-MM) fall in the term? The month it starts and the one it ends both do */
const monthIn = (ym, t) => ym >= t.start.slice(0, 7) && ym <= addDays(t.end, -1).slice(0, 7);

// ─── Subcontractor or supplier ──────────────────────────────────────

/**
 * Does this payee count for the audit of that policy ('wc' | 'gl'), and why,
 * in words a person (or the auditor) can check. company: { name, docs
 * (JobTread's Documents field), materials, trades, call ({ reason }), paidBy
 * ['card' | 'ach' | 'check' | 'wire' | 'bill'], categories (Ramp's coding),
 * costTypes (JobTread's), hasCertificate } → { sub, why, sure }
 */
export function isSubcontractor(company = {}, policy = 'wc') {
  const c = company;
  const call = c.call && CALLS[c.call.reason];
  if (call && (!call.only || call.only === policy)) return { sub: call.sub, why: `${call.label}${c.call.by ? ` (${String(c.call.by).split('@')[0]})` : ''}`, sure: true };
  // A call for the other audit only ("one person, no employees" is workers' comp's): the rest decides, and says so
  if (call) { const rest = isSubcontractor({ ...c, call: null }, policy); return rest.sub ? { ...rest, why: `${rest.why} · ${call.label.toLowerCase()}, still counted for ${POLICIES[policy].name}` } : rest; }
  if (c.docs === 'Not needed') return { sub: false, why: 'Marked “Not needed” in JobTread', sure: true };
  if (c.materials || c.docs === 'W-9 only') return { sub: false, why: 'Sells materials only (JobTread)', sure: true };
  const trades = (c.trades || []).filter((t) => t && t !== 'Materials and supplies');
  if (trades.length) return { sub: true, why: `Does ${trades.join(', ').toLowerCase()} (JobTread’s Trades)`, sure: true };
  if ((c.trades || []).includes('Materials and supplies')) return { sub: false, why: 'Sells materials (JobTread’s Trades)', sure: true };
  const labor = [...(c.costTypes || []), ...(c.categories || [])].find((t) => /subcontract|labor|labour|install/i.test(t));
  if (labor) return { sub: true, why: `Billed as “${labor}”`, sure: true };
  // Coded in Ramp to overhead (the store's goods, rent, an event, marketing): not work subcontracted
  const coded = c.coded;
  if (coded?.overheadCents > 0 && !coded.jobCents) return { sub: false, why: `Billed to ${coded.overhead.slice(0, 2).join(' and ')} (Ramp)`, sure: true };
  if (coded?.overheadCents >= 2 * coded?.jobCents && coded?.jobCents > 0) return { sub: false, why: `Mostly billed to ${coded.overhead.slice(0, 2).join(' and ')} (Ramp)`, sure: false };
  if (c.hasCertificate) return { sub: true, why: 'SOARD has their certificate of insurance', sure: true };
  if (STORES.test(String(c.name || ''))) return { sub: false, why: 'A store or supplier, by its name', sure: false };
  if (SERVICES.test(String(c.name || ''))) return { sub: false, why: 'A service, not construction work, by its name', sure: false };
  if (GOVERNMENT.test(String(c.name || '').trim())) return { sub: false, why: 'A government office, by its name', sure: false };
  const paidBy = c.paidBy || [];
  if (paidBy.length && paidBy.every((m) => m === 'card')) return { sub: false, why: 'Paid by card only, like a store', sure: false };
  const types = [...(c.costTypes || []), ...(c.categories || [])];
  if (types.length && types.every((t) => /material|supplies|furniture|decor|inventory|equipment/i.test(t))) return { sub: false, why: `Billed as “${types[0]}”`, sure: false };
  return { sub: true, why: 'Paid by bill, and nothing marks them as a supplier', sure: false };
}

// ─── Coverage on a day ──────────────────────────────────────────────

/** A coi_coverage row (or JobTread's end date) as this reads it */
const coverOf = (r) => ({
  kind: r.kind, effective: r.effective || null, expires: r.expires || null, insurer: r.insurer || null, policyNo: r.policy_no || r.policyNo || null,
  exempt: !!r.exempt || r.kind === 'exemption', source: r.source || 'certificate', jtFileId: r.jt_file_id || r.jtFileId || null, fileHash: r.file_hash || r.fileHash || null,
  eachCents: r.each_cents ?? null, aggregateCents: r.aggregate_cents ?? null,
});

/** Is this certificate of that kind ('wc' | 'gl')? An exemption counts for workers' comp */
const ofKind = (c, kind) => (kind === 'wc' ? c.kind === 'wc' || c.exempt : c.kind === 'gl');

/** The certificates (and JobTread's end dates) that are this payee's: by JobTread vendor, or by the insured's name when the certificate has no vendor */
export function coverageFor({ jtId, name, fields }, rows) {
  const mine = rows.filter((r) => (jtId && r.jt_id === jtId) || (!r.jt_id && vendorLikeness(r.insured, name) === 1)).map(coverOf);
  for (const kind of ['gl', 'wc']) {
    const end = fields?.[kind];
    if (end && !mine.some((c) => c.kind === kind && c.expires === end)) mine.push({ kind, effective: null, expires: end, insurer: null, policyNo: null, exempt: false, source: 'jobtread', jtFileId: null, fileHash: null });
  }
  return mine;
}

/**
 * Was this kind of insurance ('wc' | 'gl') in force on that day? An exemption
 * counts for workers' comp. → { ok, exempt?, assumed?, insurer, policyNo, effective, expires, source }
 */
export function coverageOn(certs, day, kind) {
  const fits = certs.filter((c) => ofKind(c, kind)).map((c) => {
    const from = c.effective || (c.expires ? yearBefore(c.expires) : null);
    const covers = (from || c.expires || c.exempt) && (!from || from <= day) && (!c.expires || day <= c.expires);
    return covers ? { ...c, from } : null;
  }).filter(Boolean);
  // A certificate beats JobTread's date alone; one with its own start date beats one assumed
  fits.sort((a, b) => (a.source === 'jobtread') - (b.source === 'jobtread') || !a.effective - !b.effective || String(b.expires).localeCompare(String(a.expires)));
  const c = fits[0];
  if (!c) return { ok: false };
  return { ok: true, exempt: c.exempt, assumed: !c.effective && !!c.expires, insurer: c.insurer, policyNo: c.policyNo, effective: c.from, expires: c.expires, source: c.source, jtFileId: c.jtFileId };
}

// ─── Payments, each counted once ────────────────────────────────────

const methodOf = (m) => {
  const s = String(m || '').toUpperCase();
  if (/CARD/.test(s)) return 'card';
  if (/CHECK/.test(s)) return 'check';
  if (/WIRE|SWIFT|INTERNATIONAL/.test(s)) return 'wire';
  if (/ACH|RTP|FED_NOW|LOCAL_BANK|DIRECT_DEBIT/.test(s)) return 'ach';
  return 'bill';
};

/** A JobTread vendor bill as read → { id, accountId, vendor, number, date, cents, paidCents, status, costTypes, codes } */
export const jtBillOf = (d) => ({
  id: d.id, accountId: d.account?.id || null, vendor: d.account?.name || '', number: d.number || null, date: easternDay(d.issueDate || d.createdAt),
  cents: centsOf(d.cost), paidCents: d.amountPaid == null ? 0 : centsOf(d.amountPaid), status: d.status || null,
  costTypes: [...new Set((d.costItems?.nodes || []).map((c) => c.costType?.name).filter(Boolean))],
  codes: [...new Set((d.costItems?.nodes || []).map((c) => c.costCode?.name).filter(Boolean))],
});
/** A JobTread payment as read → { id, date, cents, accountId, accountName, accountType, bills: [{ billId, cents }] } */
export const jtPaymentOf = (p) => ({
  id: p.id, date: easternDay(p.paidAt || p.createdAt), cents: centsOf(p.amount), accountId: p.account?.id || null, accountName: p.account?.name || '', accountType: p.account?.type || null,
  bills: (p.documentPayments?.nodes || []).filter((x) => x.document?.id && (!x.document.type || x.document.type === 'vendorBill')).map((x) => ({ billId: x.document.id, cents: centsOf(x.amount) })),
});
/** A paid Ramp bill → { id, vendor, cents, invoice, date, method, categories } */
export function rampPaymentOf(b) {
  const rate = Number(b.amount?.minor_unit_conversion_rate) || 100;
  const lines = [...(b.line_items || []), ...(b.inventory_line_items || [])];
  return {
    id: b.id, vendor: b.vendor?.name || b.vendor?.remote_name || '', cents: b.amount?.amount == null ? 0 : Math.round((Number(b.amount.amount) / rate) * 100),
    invoice: b.invoice_number || null, date: easternDay(b.payment?.payment_date || b.paid_at), method: methodOf(b.payment?.payment_method),
    categories: [...new Set(lines.flatMap((l) => (l.accounting_field_selections || []).map((s) => s.name)).filter(Boolean))],
  };
}
/** A Mercury payment out to a recipient (txnRow) → { id, payee, cents, date, method } or null */
export function mercuryPaymentOf(r) {
  if (!r || r.kind !== 'outgoingPayment' || !(r.cents < 0) || ['failed', 'cancelled', 'canceled', 'reversed'].includes(String(r.status || '').toLowerCase())) return null;
  return { id: r.id, payee: r.counterparty || '', cents: -r.cents, date: easternDay(r.posted_at || r.created_at), method: r.check_number ? 'check' : 'ach' };
}

/**
 * Every payment in the term, once. jtBills/jtPayments/rampBills/mercury: as
 * read (the *Of shapes above); txnBills: Mercury transaction id → the JobTread
 * bill ./_bill-pay.js recorded it on; vendors: [{ jtId, name }] (the cache);
 * rampWrote: the JobTread bills Ramp wrote (D1 spend_recode), which are its
 * card buys unless Ramp's bill pay paid them (only said when Ramp's bills
 * could be read: rampOk).
 * → [{ key, source, ref, billId, jtId, payee, cents, date, dateFrom ('paid' | 'bill'), method, categories, costTypes }]
 */
export function combinePayments({ term, jtBills = [], jtPayments = [], rampBills = [], mercury = [], txnBills = new Map(), vendors = [], rampWrote = new Set(), rampOk = false }) {
  const inTerm = (d) => !!d && d >= term.start && d < term.end;
  const bills = new Map(jtBills.map((b) => [b.id, b]));
  const out = [];
  const paidInJt = new Set();
  const counted = new Set();
  const row = (p) => { out.push(p); if (p.billId) counted.add(p.billId); };
  const fromBill = (b) => ({ billId: b?.id || null, jtId: b?.accountId || null, payee: b?.vendor || '', costTypes: b?.costTypes || [], ref: b?.number ? `Bill ${b.number}` : null });
  // Each Ramp bill's JobTread copy (./_ramp.js matchRampBill), so a payment on either is known as the same one
  const jtList = jtBills.map((b) => ({ id: b.id, vendor: b.vendor, cents: b.cents, number: b.number, date: b.date, accountId: b.accountId }));
  const vendorList = vendors.map((v) => ({ jtId: v.jtId, name: v.name }));
  // The JobTread vendor of a payee's name: the very name first (JobTread has near-twins, like “Sample” and “Sample Electric”), else the one alike
  const same = (x) => String(x || '').trim().toLowerCase();
  const named = (payee) => {
    const exact = vendors.filter((v) => same(v.name) === same(payee));
    if (exact.length === 1) return exact[0].jtId;
    const n = vendors.filter((v) => vendorLikeness(v.name, payee) === 1);
    return n.length === 1 ? n[0].jtId : null;
  };
  const rampFor = new Map();
  const ramps = rampBills.map((r) => {
    const m = matchRampBill(r, jtList, vendorList);
    if (m?.jtBillId && !rampFor.has(m.jtBillId)) rampFor.set(m.jtBillId, r);
    return { r, m };
  });
  // 1. Payments JobTread has on vendor bills (what ./_bill-pay.js records, and what a person enters)
  for (const p of jtPayments) for (const a of p.bills) paidInJt.add(a.billId);
  for (const p of jtPayments) {
    if (!inTerm(p.date)) continue;
    if (p.bills.length) {
      for (const a of p.bills) row({ key: `jt:${p.id}:${a.billId}`, source: 'jobtread', ...fromBill(bills.get(a.billId) || { id: a.billId, accountId: p.accountId, vendor: p.accountName }), cents: a.cents || p.cents, date: p.date, dateFrom: 'paid', method: rampFor.get(a.billId)?.method || 'bill', categories: rampFor.get(a.billId)?.categories || [] });
    } else if (p.accountType === 'vendor') {
      row({ key: `jt:${p.id}`, source: 'jobtread', billId: null, jtId: p.accountId, payee: p.accountName, ref: null, cents: p.cents, date: p.date, dateFrom: 'paid', method: 'bill', categories: [], costTypes: [] });
    }
  }
  // 2. Ramp's paid bills: the JobTread copy's payment, when JobTread has one, is this one
  for (const { r, m } of ramps) {
    if (!inTerm(r.date)) continue;
    if (m?.jtBillId && (paidInJt.has(m.jtBillId) || counted.has(m.jtBillId))) continue;
    const b = m?.jtBillId ? bills.get(m.jtBillId) : null;
    row({ key: b ? `bill:${b.id}` : `ramp:${r.id}`, source: 'ramp', ...(b ? fromBill(b) : { billId: null, jtId: m?.accountId || named(r.vendor), payee: r.vendor, costTypes: [], ref: null }), payee: b?.vendor || r.vendor,
      ref: r.invoice ? `Invoice ${r.invoice}` : b?.number ? `Bill ${b.number}` : null, cents: r.cents, date: r.date, dateFrom: 'paid', method: r.method, categories: r.categories || [] });
  }
  // 3. Mercury payments ./_bill-pay.js recorded on a bill: that bill, paid that day
  const mercuryRow = (t, b) => row({ key: b ? `bill:${b.id}` : `mercury:${t.id}`, source: 'mercury', ...(b ? fromBill(b) : { billId: null, costTypes: [], ref: null }),
    jtId: b?.accountId || named(t.payee), payee: b?.vendor || t.payee, cents: t.cents, date: t.date, dateFrom: 'paid', method: t.method, categories: [] });
  for (const t of mercury) {
    const billId = t && txnBills.get(t.id);
    if (!billId || !inTerm(t.date) || counted.has(billId) || paidInJt.has(billId)) continue;
    mercuryRow(t, bills.get(billId) || { id: billId, accountId: null, vendor: t.payee });
  }
  // 4. A JobTread bill marked paid with no payment anywhere: dated by the bill
  for (const b of jtBills) {
    if (!(b.paidCents > 0) || b.status === 'denied' || paidInJt.has(b.id) || counted.has(b.id) || !inTerm(b.date)) continue;
    row({ key: `bill:${b.id}`, source: 'jobtread', ...fromBill(b), cents: b.paidCents, date: b.date, dateFrom: 'bill', method: 'bill', categories: [] });
  }
  // 5. Mercury's other payments to recipients: a payment of its own, unless it's one already counted (same vendor and amount, days apart)
  const sameVendor = (a, jtId, payee) => (jtId && a.jtId === jtId) || vendorLikeness(a.payee, payee) === 1;
  for (const t of mercury) {
    if (!t || txnBills.has(t.id) || !inTerm(t.date) || MONEY_TOOLS.test(t.payee)) continue;
    const jtId = named(t.payee);
    if (out.some((a) => sameVendor(a, jtId, t.payee) && a.cents === t.cents && Math.abs(Date.parse(a.date) - Date.parse(t.date)) <= SAME_PAYMENT_DAYS * DAY)) continue;
    mercuryRow(t, null);
  }
  // A bill Ramp wrote that its bill pay never paid was bought on a Ramp card (a store, most often)
  if (rampOk) for (const p of out) if (p.source !== 'mercury' && p.billId && rampWrote.has(p.billId) && !rampFor.has(p.billId)) p.method = 'card';
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

// ─── The audit ──────────────────────────────────────────────────────

const groupKey = (p) => (p.jtId ? `jt:${p.jtId}` : `name:${vendorKey(p.payee) || String(p.payee || '').toLowerCase()}`);

/**
 * The term's subcontractors, their payments and coverage, for its policy's
 * audit (the headline, the order and the totals are that policy's; each
 * payment says both kinds, for the asks). payments: from combinePayments;
 * vendors: [{ jtId, name, email, emails, fields }]; coverage: coi_coverage
 * rows; calls: Map(key → { reason, by, at }); asks: [{ jtId, months,
 * toEmail, toKind, sentAt }]
 */
export function auditFrom({ term, payments = [], vendors = [], coverage = [], calls = new Map(), asks = [], agents = new Map(), sources = {}, builtAt = null, today }) {
  const k = term.policy || 'wc';
  const byJt = new Map(vendors.map((v) => [v.jtId, v]));
  const groups = new Map();
  for (const p of payments) {
    const k = groupKey(p);
    if (!groups.has(k)) groups.set(k, { key: k, jtId: p.jtId || null, payee: p.payee, list: [] });
    groups.get(k).list.push(p);
  }
  const rows = [];
  for (const g of groups.values()) {
    const v = g.jtId ? byJt.get(g.jtId) : null;
    const name = v?.name || g.payee || 'A payee with no name';
    const certs = coverageFor({ jtId: g.jtId, name, fields: v?.fields }, coverage);
    const call = calls.get(g.key) || null;
    const cls = isSubcontractor({
      name, docs: v?.fields?.docs, materials: v?.fields?.materials, trades: v?.fields?.trades, call,
      paidBy: [...new Set(g.list.map((p) => p.method || 'bill'))], categories: [...new Set(g.list.flatMap((p) => p.categories || []))],
      costTypes: [...new Set(g.list.flatMap((p) => p.costTypes || []))], coded: codedAs(g.list), hasCertificate: certs.some((c) => c.source !== 'jobtread' || c.expires),
    }, k);
    const pays = g.list.map((p) => ({ key: p.key, date: p.date, cents: p.cents, source: p.source, ref: p.ref, dateFrom: p.dateFrom, wc: coverageOn(certs, p.date, 'wc'), gl: coverageOn(certs, p.date, 'gl') }));
    const gap = (kind) => {
      const off = pays.filter((p) => !p[kind].ok);
      return { cents: sum(off, (p) => p.cents), months: [...new Set(off.map((p) => p.date.slice(0, 7)))].sort(), exempt: kind === 'wc' && pays.some((p) => p.wc.exempt), assumed: pays.some((p) => p[kind].assumed) };
    };
    const latest = pays.at(-1);
    const shown = (kind) => (latest?.[kind]?.ok ? latest[kind] : [...certs].filter((c) => ofKind(c, kind)).sort((a, b) => String(b.expires).localeCompare(String(a.expires)))[0] || null);
    // This audit's certificates, each file once
    const files = [...new Map(certs.filter((c) => c.jtFileId && ofKind(c, k)).map((c) => [c.fileHash || c.jtFileId, c])).values()];
    const myAsks = g.jtId ? asks.filter((a) => a.jtId === g.jtId && a.months.some((m) => monthIn(m, term))) : [];
    const agent = g.jtId ? agents.get(g.jtId) : null;
    rows.push({
      key: g.key, jtId: g.jtId, name, inJobTread: !!v, sub: cls.sub, why: cls.why, sure: cls.sure, call: call ? { reason: call.reason, label: CALLS[call.reason]?.label || call.reason, by: call.by, at: call.at } : null,
      trades: (v?.fields?.trades || []).filter(Boolean), paidCents: sum(pays, (p) => p.cents), count: pays.length, first: pays[0]?.date || null, last: latest?.date || null,
      payments: pays, wc: { ...gap('wc'), shown: shown('wc') }, gl: { ...gap('gl'), shown: shown('gl') }, files,
      email: v?.email || v?.emails?.[0] || null, agentEmail: isEmail(agent?.email) ? agent.email : null,
      asked: myAsks.sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0] || null,
    });
  }
  rows.sort((a, b) => (b.sub - a.sub) || (b[k].cents - a[k].cents) || (b.paidCents - a.paidCents) || a.name.localeCompare(b.name));
  const subs = rows.filter((r) => r.sub);
  const out = rows.filter((r) => !r.sub);
  return {
    term, policy: { ...POLICIES[k] }, today, builtAt, sources,
    // uninsured: paid on days without this audit's kind of insurance
    totals: {
      subs: subs.length, paidToSubs: sum(subs, (r) => r.paidCents),
      uninsuredCents: sum(subs, (r) => r[k].cents), uninsuredSubs: subs.filter((r) => r[k].cents > 0).length,
      insuredCents: sum(subs, (r) => r.paidCents - r[k].cents), insuredSubs: subs.filter((r) => r[k].cents < r.paidCents).length,
      leftOut: out.length, leftOutCents: sum(out, (r) => r.paidCents), notInJobTread: rows.filter((r) => !r.inJobTread).length,
      asked: subs.filter((r) => r.asked).length, payments: payments.length,
    },
    rows,
  };
}

// ─── Reading the term ───────────────────────────────────────────────

async function pages(read, max) {
  const out = [];
  let page = null;
  for (let i = 0; i < max; i++) {
    const { nodes, next } = await read(page);
    out.push(...nodes);
    if (!next) break;
    page = next;
  }
  return out;
}
const jtRead = async (env, q, fetchImpl) => {
  const d = await pave(env.JOBTREAD_GRANT_KEY, q, fetchImpl);
  if (d?.errors?.length) throw new Error(`JobTread: ${d.errors[0].message || 'refused the question'}`);
  return d;
};

/** JobTread's vendor bills that could have been paid in the term (made up to 6 months before it) */
export async function readJtBills(env, t, { fetchImpl = fetch } = {}) {
  const since = addDays(t.start, -183);
  return (await pages(async (page) => {
    const d = await jtRead(env, {
      organization: {
        $: { id: SOARD_ORG_ID },
        documents: {
          // JobTread sizes a question by its most it could answer (bills × their cost lines): 25 × 25 is refused (413), 20 × 10 isn't
          $: { size: 20, where: { and: [['type', '=', 'vendorBill'], ['createdAt', '>=', since], ['createdAt', '<', t.end]] }, sortBy: [{ field: 'createdAt', order: 'asc' }], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, status: {}, cost: {}, issueDate: {}, createdAt: {}, number: {}, amountPaid: {}, account: { id: {}, name: {} },
            costItems: { $: { size: 10 }, nodes: { costType: { name: {} }, costCode: { name: {} } } },
          },
        },
      },
    }, fetchImpl);
    return { nodes: d?.organization?.documents?.nodes || [], next: d?.organization?.documents?.nextPage || null };
  }, 100)).map(jtBillOf);
}

/** JobTread's payments in the term, with the bills each was applied to */
export async function readJtPayments(env, t, { fetchImpl = fetch } = {}) {
  return (await pages(async (page) => {
    const d = await jtRead(env, {
      organization: {
        $: { id: SOARD_ORG_ID },
        payments: {
          $: { size: 25, where: { and: [['paidAt', '>=', t.start], ['paidAt', '<', t.end]] }, ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, amount: {}, paidAt: {}, createdAt: {}, account: { id: {}, name: {}, type: {} },
            documentPayments: { $: { size: 10 }, nodes: { amount: {}, document: { id: {}, type: {} } } },
          },
        },
      },
    }, fetchImpl);
    return { nodes: d?.organization?.payments?.nodes || [], next: d?.organization?.payments?.nextPage || null };
  }, 80)).map(jtPaymentOf);
}

/** Ramp's bills paid in the term */
export async function readRampPaid(env, t, { fetchImpl = fetch } = {}) {
  const out = [];
  let next = '/bills';
  let query = { payment_status: 'PAID', from_paid_at: `${addDays(t.start, -1)}T00:00:00Z`, to_paid_at: `${addDays(t.end, 1)}T00:00:00Z`, page_size: 100 };
  for (let i = 0; i < 40 && next; i++) {
    const d = await ramp(env, next, { query, fetchImpl });
    out.push(...(d?.data || []));
    next = d?.page?.next || null;
    query = null;   // page.next carries them
  }
  return out.filter((b) => !b.archived_at).map(rampPaymentOf);
}

/** Mercury's payments to recipients in the term: from Mercury itself, or the copy D1 keeps when Mercury isn't connected */
export async function readMercuryPaid(env, t, { fetchImpl = fetch } = {}) {
  const rows = mercuryConfigured(env)
    ? (await listTransactions(env, { start: `${addDays(t.start, -1)}T00:00:00Z`, maxPages: 40, fetchImpl })).map((x) => txnRow(x))
    : await readTxns(env.DB, { from: `${addDays(t.start, -1)}T00:00:00Z`, to: `${addDays(t.end, 1)}T00:00:00Z`, kinds: ['outgoingPayment'] });
  return rows.map(mercuryPaymentOf).filter(Boolean);
}

/** The vendors cache (./_vendors.js refreshCache) → [{ jtId, name, email, emails, fields }] */
export async function readVendors(DB) {
  const rows = await DB.prepare('SELECT jt_id, name, email, facts FROM vendors WHERE jt_id IS NOT NULL').all().then((r) => r.results || [], () => []);
  return rows.map((r) => { const f = parseJson(r.facts, {}); return { jtId: r.jt_id, name: r.name, email: r.email || null, emails: f.emails || [], fields: f.fields || null }; });
}

/** The certificates found (./_coi-backfill.js); none until that table exists */
export async function readCoverage(DB) {
  return DB.prepare('SELECT * FROM coi_coverage').all().then((r) => r.results || [], () => []);
}

/** Read the term's payments from every source that answers, and keep them → the run */
export async function buildRun(env, t, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensureAuditSchema(env.DB);
  const sources = {};
  const get = async (name, ok, read) => {
    if (!ok) { sources[name] = { ok: false, connected: false }; return []; }
    try { const list = await read(); sources[name] = { ok: true, connected: true, count: list.length }; return list; } catch (e) {
      console.error('[insurance-audit]', name, e.message);
      sources[name] = { ok: false, connected: true, error: String(e.message).slice(0, 200) };
      return [];
    }
  };
  const jtOk = !!env.JOBTREAD_GRANT_KEY;
  const jtBills = await get('jobtread', jtOk, () => readJtBills(env, t, { fetchImpl }));
  const jtPayments = await get('jobtreadPayments', jtOk, () => readJtPayments(env, t, { fetchImpl }));
  const rampBills = await get('ramp', rampConfigured(env), () => readRampPaid(env, t, { fetchImpl }));
  const mercury = await get('mercury', true, () => readMercuryPaid(env, t, { fetchImpl }));
  if (!mercuryConfigured(env) && sources.mercury.ok) sources.mercury = { ...sources.mercury, connected: false, kept: true };
  const txnBills = new Map(await env.DB.prepare('SELECT txn_id, bill_id FROM spend_payments WHERE bill_id IS NOT NULL').all().then((r) => (r.results || []).map((x) => [x.txn_id, x.bill_id]), () => []));
  const rampWrote = new Set(await env.DB.prepare('SELECT bill_id FROM spend_recode').all().then((r) => (r.results || []).map((x) => x.bill_id), () => []));
  const vendors = await readVendors(env.DB);
  const payments = combinePayments({ term: t, jtBills, jtPayments, rampBills, mercury, txnBills, vendors, rampWrote, rampOk: !!sources.ramp?.ok });
  const builtAt = new Date(now).toISOString();
  const data = { payments, sources, version: RUN_VERSION };
  await env.DB.prepare('INSERT OR REPLACE INTO insurance_audit_runs (term, built_at, data, error) VALUES (?, ?, ?, NULL)').bind(t.id, builtAt, JSON.stringify(data)).run();
  return { term: t.id, builtAt, ...data };
}

export async function readRun(DB, termId) {
  await ensureAuditSchema(DB);
  const r = await DB.prepare('SELECT * FROM insurance_audit_runs WHERE term = ?').bind(String(termId)).first();
  return r ? { term: r.term, builtAt: r.built_at, ...parseJson(r.data, { payments: [], sources: {} }) } : null;
}
export const runIsStale = (run, t, now = Date.now()) => !run || run.version !== RUN_VERSION || now - Date.parse(run.builtAt) > (Object.values(run.sources || {}).some((x) => x.connected && !x.ok) ? FAILED_EVERY_MS
  : t.id === termOf(todayEastern(now), t.policy).id ? CURRENT_EVERY_MS : PAST_EVERY_MS);

export async function readCalls(DB) {
  await ensureAuditSchema(DB);
  const rows = (await DB.prepare('SELECT * FROM insurance_audit_calls').all()).results || [];
  return new Map(rows.map((r) => [r.vendor_key, { reason: r.reason, by: r.by, at: r.at, sub: !!r.sub }]));
}
export async function readAsks(DB) {
  await ensureAuditSchema(DB);
  return ((await DB.prepare('SELECT * FROM insurance_audit_asks').all()).results || []).map((r) => ({ key: r.key, term: r.term, jtId: r.jt_id, months: parseJson(r.months, []), toEmail: r.to_email, toKind: r.to_kind, sentAt: r.sent_at }));
}
/** Insurance agents named on the trade-partner page → Map(jtId → { name, email }) */
async function readAgents(DB) {
  const rows = await DB.prepare('SELECT jt_id, agent FROM vendor_profiles WHERE agent IS NOT NULL').all().then((r) => r.results || [], () => []);
  return new Map(rows.map((r) => [r.jt_id, parseJson(r.agent, {})]));
}

/** One term's audit, from its kept run (read now when there's none) → audit; a stale run is read again after (waitUntil) */
export async function auditFor(env, termId, { now = Date.now(), fetchImpl = fetch, waitUntil = null } = {}) {
  const t = term(termId);
  if (!t) throw Object.assign(new Error('Pick one of the terms shown'), { status: 400 });
  let run = await readRun(env.DB, t.id);
  if (!run) run = await buildRun(env, t, { now, fetchImpl });
  else if (runIsStale(run, t, now) && waitUntil) waitUntil(buildRun(env, t, { now, fetchImpl }).catch((e) => console.error('[insurance-audit] refresh', e.message)));
  const [vendors, coverage, calls, asks, agents] = await Promise.all([readVendors(env.DB), readCoverage(env.DB), readCalls(env.DB), readAsks(env.DB), readAgents(env.DB)]);
  return auditFrom({ term: t, payments: run.payments, vendors, coverage, calls, asks, agents, sources: run.sources, builtAt: run.builtAt, today: todayEastern(now) });
}

/** A person's call on a payee (Admin → Job Costs → Insurance audit): one of CALLS, or 'clear' */
export async function saveCall(DB, { key, jtId = null, name = '', reason, by }) {
  await ensureAuditSchema(DB);
  if (!/^(jt|name):.{1,160}$/.test(String(key || ''))) throw Object.assign(new Error('That isn’t a payee'), { status: 400 });
  if (reason === 'clear') { await DB.prepare('DELETE FROM insurance_audit_calls WHERE vendor_key = ?').bind(key).run(); return; }
  if (!CALLS[reason]) throw Object.assign(new Error('Pick why'), { status: 400 });
  await DB.prepare('INSERT OR REPLACE INTO insurance_audit_calls (vendor_key, jt_id, name, sub, reason, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(key, jtId, String(name).slice(0, 160), CALLS[reason].sub ? 1 : 0, reason, by || null, new Date().toISOString()).run();
}

// ─── Asking for the certificate that covered past work ──────────────

const kindsWord = (kinds) => (kinds.length === 2 ? 'workers’ compensation and general liability' : kinds[0] === 'wc' ? 'workers’ compensation' : 'general liability');

/** The email → { subject, html, text }. It names no policy term: one email asks for both audits */
export function askEmail({ vendorName, months, kinds, agent = false }) {
  const when = monthsText(months);
  const what = kindsWord(kinds);
  const subject = agent ? `The certificate of insurance that covered ${vendorName}’s work in ${when}` : `The certificate of insurance that covered your work in ${when}`;
  const lead = agent
    ? `${vendorName} named you as their insurance agent. Sunshine on a Ranney Day, a nonprofit that builds bedrooms and bathrooms for children with disabilities, paid them for work in ${when}, and our insurance audit asks for the certificate that covered that work.`
    : `Thank you for your work with Sunshine on a Ranney Day. Our insurance companies audit what we pay subcontractors each year, and we don’t have a certificate of insurance on file that covered your work in ${when}.`;
  const ask = agent
    ? `Could you reply to this email with the certificate (${what}) that was in force then, with Sunshine on a Ranney Day as certificate holder?`
    : `Could you reply to this email with the certificate (${what}) that was in force then? One from your insurance agent is perfect.${kinds.includes('wc') ? ' If you had no employees and no workers’ compensation policy, just reply and say so.' : ''}`;
  const html = emailShell({ preheader: `The certificate that covered the work in ${when}`, heading: 'A certificate of insurance, please', bodyHtml: paragraphs(lead) + paragraphs(ask) + paragraphs('Thank you for helping us keep our records complete.') });
  return { subject, html, text: [lead, '', ask, '', 'Thank you for helping us keep our records complete.', '', 'Sunshine on a Ranney Day'].join('\n') };
}

/**
 * The current terms' subs paid on days no certificate covers (audits: each
 * policy's audit, or one): one email per sub for whatever both audits are
 * missing, never twice for the same months, a note on their JobTread vendor.
 * → { asked, waiting? }
 */
export async function askForGaps(env, audits, { now = Date.now(), fetchImpl = fetch } = {}) {
  const out = { asked: 0 };
  // The certificate search first: nobody is asked for a certificate SOARD already has in an inbox
  const first = await env.DB.prepare('SELECT MIN(found_at) AS first FROM coi_coverage').first().catch(() => null);
  if (!first?.first || now - Date.parse(first.first) < SEARCH_GRACE_DAYS * DAY) return { ...out, waiting: 'the certificate search' };
  const asked = new Map();   // jtId → the months already asked about, by either audit
  for (const a of await readAsks(env.DB)) { if (!asked.has(a.jtId)) asked.set(a.jtId, new Set()); for (const m of a.months) asked.get(a.jtId).add(m); }
  const recent = new Map(await env.DB.prepare('SELECT jt_id, open, asked_at FROM vendor_asks').all().then((r) => (r.results || []).map((x) => [x.jt_id, x]), () => []));
  const cutoff = addDays(todayEastern(now), -ASK_AFTER_DAYS);
  // Each sub's payments some audit has no certificate for: a payment both audits share is one, missing both kinds
  const subs = new Map();
  for (const audit of [].concat(audits)) {
    const k = audit.term.policy || 'wc';
    for (const r of audit.rows) {
      if (!r.sub || !r.jtId) continue;
      if (!subs.has(r.jtId)) subs.set(r.jtId, { row: r, off: new Map() });
      const s = subs.get(r.jtId);
      for (const p of r.payments) {
        if (p.date > cutoff || p[k].ok || asked.get(r.jtId)?.has(p.date.slice(0, 7))) continue;
        const e = s.off.get(p.key || `${p.date}:${p.cents}`) || { ...p, kinds: new Set(), terms: new Map() };
        e.kinds.add(k);
        e.terms.set(audit.term.id, audit.term);
        s.off.set(p.key || `${p.date}:${p.cents}`, e);
      }
    }
  }
  for (const [jtId, { row: r, off: offMap }] of subs) {
    if (out.asked >= ASKS_PER_RUN) break;
    const off = [...offMap.values()];
    if (!off.length) continue;
    const months = [...new Set(off.map((p) => p.date.slice(0, 7)))].sort();
    const kinds = ['wc', 'gl'].filter((k) => off.some((p) => p.kinds.has(k)));
    const order = Object.keys(POLICIES);
    const terms = [...new Map(off.flatMap((p) => [...p.terms])).values()].sort((a, b) => order.indexOf(a.policy) - order.indexOf(b.policy));
    // Already being asked for their papers this week by the documents sweep (./_vendors.js): this waits
    const v = recent.get(jtId);
    if (v?.open && v.asked_at && now - Date.parse(v.asked_at) < 7 * DAY) continue;
    const to = r.agentEmail || (isEmail(r.email) ? r.email : null);
    if (!to) continue;   // no one to ask: it stays on the list
    const toKind = r.agentEmail ? 'agent' : 'vendor';
    const mail = askEmail({ vendorName: r.name, months, kinds, agent: toKind === 'agent' });
    const sent = await sendEmails(env, { to: [to], subject: mail.subject, html: mail.html, text: mail.text, replyTo: REPLY_TO, tags: [{ name: 'type', value: 'insurance-audit' }] }).catch(() => ({ sent: 0 }));
    if (!sent?.sent) continue;
    const at = new Date(now).toISOString();
    await env.DB.prepare('INSERT OR REPLACE INTO insurance_audit_asks (key, term, jt_id, months, to_email, to_kind, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(`${jtId}:${months.join(',')}`, terms.map((t) => t.id).join(','), jtId, JSON.stringify(months), to, toKind, at).run();
    const gapCents = sum(off, (p) => p.cents);
    const audited = terms.map((t) => `${t.name} audit (policy term ${t.label})`).join(' and ');
    await vendorNote(env, jtId, 'Asked for a past certificate of insurance',
      `SOARD emailed ${toKind === 'agent' ? 'their insurance agent ' : ''}${to} on ${longDay(todayEastern(now))} for the certificate that covered ${r.name}’s work in ${monthsText(months)}: ${dollars(gapCents)} was paid to them then with no ${kindsWord(kinds)} on file, for SOARD’s ${audited}. Replies go to ${REPLY_TO}.`, fetchImpl);
    out.asked++;
  }
  return out;
}

/**
 * The heartbeat: each policy's current term read again about daily (one per
 * heartbeat, so one call never reads everything twice), then one ask pass
 * over both audits once both have been read. Never throws.
 */
export async function maybeRunInsuranceAudit(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    const terms = Object.keys(POLICIES).map((p) => termOf(todayEastern(now), p));
    const runs = await Promise.all(terms.map((t) => readRun(env.DB, t.id)));
    const i = terms.findIndex((t, n) => runIsStale(runs[n], t, now));
    if (i < 0) return null;
    await buildRun(env, terms[i], { now, fetchImpl });
    const read = { term: terms[i].id };
    if (runs.some((r, n) => n !== i && !r)) return { ...read, waiting: 'the other audit’s payments' };
    const audits = [];
    for (const t of terms) audits.push(await auditFor(env, t.id, { now, fetchImpl }));
    // A policy that just renewed: the old term's last week only became old enough to ask about after it ended
    for (const t of terms) {
      const before = term(t.year - 1, t.policy);
      if (todayEastern(now) < addDays(t.start, RENEWED_ASK_DAYS) && (await readRun(env.DB, before.id))) audits.push(await auditFor(env, before.id, { now, fetchImpl }));
    }
    return { ...read, payments: audits[i].totals.payments, ...(await askForGaps(env, audits, { now, fetchImpl })) };
  } catch (e) {
    console.error('[insurance-audit]', e.message);
    return null;
  }
}

// ─── The spreadsheet ────────────────────────────────────────────────

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const coverText = (c) => (!c ? 'None on file' : `${c.exempt ? 'Exempt' : c.insurer || 'Insurer not read'}${c.policyNo ? `, policy ${c.policyNo}` : ''}${c.effective ? `, ${c.effective}` : ''}${c.expires ? ` to ${c.expires}` : ''}${c.source === 'jobtread' ? ' (end date from JobTread)' : ''}`);

/** One row per payee: whether they count for this audit, why, what was paid and what covered it (this audit's kind) → CSV text */
export function auditCsv(audit) {
  const k = audit.term.policy || 'wc';
  const w = POLICIES[k].plain;
  const head = ['Payee', 'In JobTread', 'Counts for the audit', 'Why', 'Work', 'Paid in the term', 'Payments', 'First paid', 'Last paid',
    `Paid without ${w}`, `Months without ${w}`, `${w[0].toUpperCase()}${w.slice(1)} on file`, 'Asked for the certificate', 'Each payment'];
  const money = (c) => (c / 100).toFixed(2);
  const lines = audit.rows.map((r) => [
    r.name, r.inJobTread ? 'Yes' : 'No', r.sub ? 'Yes' : 'No', r.why, r.trades.join('; '), money(r.paidCents), r.count, r.first, r.last,
    money(r[k].cents), r[k].months.map(monthName).join('; '), coverText(r[k].shown), r.asked ? `${r.asked.sentAt.slice(0, 10)} to ${r.asked.toEmail}` : '',
    r.payments.map((p) => `${p.date} ${money(p.cents)}${p[k].ok ? '' : ` no ${w}`}`).join('; '),
  ]);
  return [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ─── The auditor's packet ───────────────────────────────────────────

const PAGE = [612, 792];
const M = 48;
const INK = rgb(0.1, 0.1, 0.12);
const MUTE = rgb(0.38, 0.38, 0.42);
const LINE = rgb(0.85, 0.85, 0.87);
// Helvetica (WinAnsi) can't draw every character a name might hold
const plain = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E·‘’“”]/g, '');

function wrap(font, text, size, width) {
  const words = plain(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** A certificate's bytes as a PDF or a picture → 'pdf' | 'jpg' | 'png' | null */
const fileKind = (b) => (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 ? 'pdf' : b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b[0] === 0x89 && b[1] === 0x50 ? 'png' : null);

/** The certificates to put in the packet for one sub: the files the search found, else their JobTread files tagged COI */
async function certificateFiles(env, row, coiTag, fetchImpl) {
  const files = [];
  for (const f of row.files.slice(0, 4)) {
    const d = await jtRead(env, { file: { $: { id: f.jtFileId }, id: {}, name: {}, url: {} } }, fetchImpl).catch(() => null);
    if (d?.file?.url) files.push({ name: d.file.name, url: d.file.url });
  }
  if (!files.length && row.jtId && coiTag) {
    const d = await jtRead(env, { account: { $: { id: row.jtId }, files: { $: { size: 30, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: { id: {}, name: {}, url: {}, fileTags: { $: { size: 5 }, nodes: { id: {} } } } } } }, fetchImpl).catch(() => null);
    files.push(...(d?.account?.files?.nodes || []).filter((f) => f.url && (f.fileTags?.nodes || []).some((x) => x.id === coiTag)).slice(0, 2).map((f) => ({ name: f.name, url: f.url })));
  }
  const out = [];
  for (const f of files) {
    const res = await fetchImpl(f.url, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (!res?.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 12 * 1024 * 1024 || !fileKind(bytes)) continue;
    out.push({ name: f.name, bytes, kind: fileKind(bytes) });
  }
  return out;
}

/**
 * The packet for that policy's premium auditor: the term's summary and every
 * subcontractor (paid, covered or not), then each one's certificates. → PDF bytes
 */
export async function auditPacket(env, audit, { fetchImpl = fetch, now = Date.now() } = {}) {
  const k = audit.term.policy || 'wc';
  const P = POLICIES[k];
  const coiTag = (await readState(env.DB, VENDORS_KEY).catch(() => ({})))?.jt?.tags?.coi || null;
  const subs = audit.rows.filter((r) => r.sub);
  // The certificates first, so the summary can say on which page each one starts
  const attach = [];
  for (const r of subs) {
    if (attach.length >= 60) break;
    const files = env.JOBTREAD_GRANT_KEY ? await certificateFiles(env, r, coiTag, fetchImpl).catch(() => []) : [];
    const docs = [];
    for (const f of files) {
      if (f.kind !== 'pdf') { docs.push({ ...f, pages: 1 }); continue; }
      const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true }).catch(() => null);
      if (src) docs.push({ ...f, src, pages: src.getPageCount() });
    }
    if (docs.length) attach.push({ row: r, docs });
  }

  const doc = await PDFDocument.create();
  doc.setTitle(`${P.title} audit: subcontractors and their insurance, ${audit.term.short}`);
  doc.setAuthor('Sunshine on a Ranney Day');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const width = PAGE[0] - 2 * M;

  // Lay the summary out once to count its pages, then draw it with the page numbers
  const t = audit.totals;
  const cols = [{ h: 'Subcontractor', w: 160 }, { h: 'Paid in the term', w: 86, right: true }, { h: P.title, w: 190 }, { h: 'Certificate', w: width - 436 }];
  const cover = (c) => (c.cents === 0 ? (c.shown ? `Covered: ${coverText(c.shown)}` : 'Covered') : `Not covered: ${dollars(c.cents)} in ${monthsText(c.months)}`);
  const layout = (startPages) => {
    const ops = [];
    let page = 0;
    let y = PAGE[1] - M;
    const need = (h) => { if (y - h < M + 20) { page++; y = PAGE[1] - M; return true; } return false; };
    const text = (s, { size = 10, f = font, x = M, color = INK, gap = 4 } = {}) => {
      for (const line of wrap(f, s, size, width - (x - M))) { need(size + gap); ops.push({ page, kind: 'text', s: line, x, y: y - size, size, f, color }); y -= size + gap; }
    };
    text(`${P.title} audit: subcontractors and their insurance`, { size: 18, f: bold, gap: 8 });
    text(`Sunshine on a Ranney Day · ${P.name} policy term ${audit.term.label}`, { size: 11, color: MUTE });
    text(`Prepared ${longDay(todayEastern(now))} from SOARD’s payments (JobTread bills, Ramp and Mercury) and the certificates on file.`, { size: 9, color: MUTE, gap: 14 });
    text(`Subcontractors paid: ${t.subs}, ${dollars(t.paidToSubs)} in all.`, { size: 11 });
    text(`Paid to subcontractors with ${P.name}: ${dollars(t.insuredCents)}.`, { size: 11 });
    text(`Paid to subcontractors without ${P.name}: ${dollars(t.uninsuredCents)}${t.uninsuredSubs ? ` (${subs.filter((r) => r[k].cents).map((r) => r.name).join(', ')})` : ''}.`, { size: 11, f: t.uninsuredCents ? bold : font, gap: 14 });
    const table = (rows, colsList, cells) => {
      const head = () => { need(16); let x = M; for (const c of colsList) { ops.push({ page, kind: 'text', s: c.h, x, y: y - 8, size: 8, f: bold, color: MUTE }); x += c.w; } y -= 14; ops.push({ page, kind: 'line', y }); };
      head();
      for (const r of rows) {
        const cellLines = cells(r).map((s, i) => wrap(font, s, 8.5, colsList[i].w - 8));
        const h = Math.max(...cellLines.map((l) => l.length)) * 11 + 6;
        if (need(h)) head();
        let x = M;
        cellLines.forEach((lines, i) => {
          lines.forEach((line, j) => ops.push({ page, kind: 'text', s: line, x: colsList[i].right ? x + colsList[i].w - 10 - font.widthOfTextAtSize(line, 8.5) : x, y: y - 9 - j * 11, size: 8.5, f: i === 0 ? bold : font, color: INK }));
          x += colsList[i].w;
        });
        y -= h;
        ops.push({ page, kind: 'line', y });
      }
      y -= 12;
    };
    const at = new Map();
    let p = startPages + 1;
    for (const a of attach) { at.set(a.row.key, p); p += a.docs.reduce((n, d) => n + d.pages, 0); }
    if (subs.length) table(subs, cols, (r) => [r.name, dollars(r.paidCents), cover(r[k]), at.has(r.key) ? `Page ${at.get(r.key)}` : 'None on file']);
    const out = audit.rows.filter((r) => !r.sub);
    if (out.length) {
      text('Paid, and not counted as subcontractors', { size: 12, f: bold, gap: 8 });
      table(out, [{ h: 'Payee', w: 190 }, { h: 'Paid in the term', w: 90, right: true }, { h: 'Why', w: width - 280 }], (r) => [r.name, dollars(r.paidCents), r.why]);
    }
    return { ops, pages: page + 1 };
  };
  let n = 1;
  for (let i = 0; i < 3; i++) { const l = layout(n); if (l.pages === n) break; n = l.pages; }
  const { ops, pages } = layout(n);
  const coverPages = Array.from({ length: pages }, () => doc.addPage(PAGE));
  for (const o of ops) {
    const pg = coverPages[o.page];
    if (o.kind === 'line') pg.drawLine({ start: { x: M, y: o.y }, end: { x: PAGE[0] - M, y: o.y }, thickness: 0.5, color: LINE });
    else pg.drawText(o.s, { x: o.x, y: o.y, size: o.size, font: o.f, color: o.color });
  }
  coverPages.forEach((pg, i) => pg.drawText(plain(`Sunshine on a Ranney Day · ${P.name} · ${audit.term.short} · page ${i + 1}`), { x: M, y: M - 20, size: 7.5, font, color: MUTE }));
  // Then each certificate, as it is
  for (const a of attach) {
    for (const d of a.docs) {
      if (d.src) {
        for (const pg of await doc.copyPages(d.src, d.src.getPageIndices())) doc.addPage(pg);
        continue;
      }
      const img = d.kind === 'png' ? await doc.embedPng(d.bytes).catch(() => null) : await doc.embedJpg(d.bytes).catch(() => null);
      const pg = doc.addPage(PAGE);
      if (!img) { pg.drawText(plain(`${a.row.name}: ${d.name} could not be added; it is in JobTread.`), { x: M, y: PAGE[1] - M, size: 10, font }); continue; }
      const s = Math.min((PAGE[0] - 2 * M) / img.width, (PAGE[1] - 2 * M) / img.height, 1);
      pg.drawImage(img, { x: (PAGE[0] - img.width * s) / 2, y: (PAGE[1] - img.height * s) / 2, width: img.width * s, height: img.height * s });
    }
  }
  return doc.save();
}
