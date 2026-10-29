/**
 * Bills: approved by email, paid from Mercury, marked paid in JobTread
 * ===========================================================================
 * A sub's bill lands in JobTread (the Receipt Processor makes it from what
 * reaches ap@). Peter's flow:
 *
 *   1. A DataX agent emails the approver (Holly) about each bill waiting:
 *      vendor, amount, job, and where the job stands against its budget. It
 *      reads that list from GET /api/bill-approvals.
 *   2. She replies approved or not. The agent reads the reply and tells the
 *      site (POST /api/bill-approvals { action: 'decide' }). Staff can also
 *      decide in Admin → Job Costs → Bills.
 *   3. An approved bill is paid from Mercury, the way Setup says:
 *        'request'  Mercury holds the payment for an approver to tap in
 *                   Mercury (request-send-money). Nothing leaves without it.
 *        'send'     the site sends it (ACH or check to the vendor's Mercury
 *                   recipient). Needs the relay's fixed IP on the token.
 *        'off'      (the start) nobody's money moves from here; someone pays
 *                   in Mercury by hand.
 *   4. However it was paid, when Mercury's payment goes out the site records
 *      it on the bill in JobTread (a payment applied to the bill), so the bill
 *      shows paid. Card charges paired with a bill are recorded the same way
 *      when the bill still shows a balance.
 *
 * Guards on paying: the decision must come from a listed approver; a bill at
 * or over the second-approval amount needs a second listed approver; the
 * vendor's W-9 and insurance must be current in JobTread (./_vendors.js),
 * or the bill is held: approved, not paid, said so on the bill in JobTread
 * (a pinned note), in Job Costs → Bills and in the Finance channel, and the
 * vendor is emailed; it pays itself once their documents check out; the
 * amount paid is the bill's balance, never more; a day's payments stop at
 * the daily cap; one payment per bill (Mercury's idempotency key is the
 * bill's id); the vendor's Mercury recipient must be the only one matching
 * its name, or linked by a person.
 *
 * Approver emails live in spend_state 'bill-pay' (set in the admin), never
 * in code: the repo is public.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import { slackIssue, slackResolved, slackPost, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { mercury, mercuryConfigured, readState, writeState } from './_mercury.js';
import { readTxns } from './_mercury-txns.js';
import { vendorLikeness, dollars } from './_spend-match.js';
import { readLedgers, costCodes } from './_job-ledger.js';
import { billDocs, askForBill } from './_vendors.js';
import { releaseRampHolds } from './_ramp.js';

export const KEY = 'bill-pay';
export const PAY_MODES = ['off', 'request', 'send'];
const DAY = 86400e3;
const RECIPIENTS_EVERY_MS = 60 * 60 * 1000;
const REASK_AFTER_MS = 3 * DAY;       // no answer in 3 days: the agent asks again
const RECORD_LOOK_BACK_DAYS = 60;
const ADMIN = `${SITE_ORIGIN}/admin/#job-costs/bills`;

export const DEFAULTS = { approvers: [], bigBillCents: 1000000, bigApprovers: [], payMode: 'off', payFromAccountId: null, dailyCapCents: 2500000, startsOn: null };
const TZ = 'America/New_York';
const today = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });

/**
 * Mercury pays bills only from the day SOARD switches (Ramp pays them until
 * then; both paying would pay a sub twice). Pure. → true when it's that day or later
 */
export function payingStarted(cfg, now = Date.now()) {
  return !!cfg.startsOn && today(now) >= cfg.startsOn;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bill_approvals (
    bill_id TEXT PRIMARY KEY, state TEXT NOT NULL, asked_at TEXT, asked_count INTEGER DEFAULT 0, asked_ref TEXT,
    approvals TEXT, decided_by TEXT, decided_at TEXT, note TEXT, recipient_id TEXT,
    pay_state TEXT, pay_ref TEXT, pay_cents INTEGER, pay_error TEXT, paid_at TEXT, updated_at TEXT, pay_started_at TEXT, hold TEXT)`,
  `CREATE TABLE IF NOT EXISTS spend_payments (
    txn_id TEXT PRIMARY KEY, bill_id TEXT, cents INTEGER, jt_payment_id TEXT, how TEXT, error TEXT, at TEXT)`,
  'CREATE INDEX IF NOT EXISTS spend_payments_bill ON spend_payments (bill_id)',
];
const _ready = new WeakSet();
export async function ensureBillPaySchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  try { await DB.prepare('ALTER TABLE bill_approvals ADD COLUMN hold TEXT').run(); } catch { /* already there */ }
  _ready.add(DB);
}

const lower = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

export async function readBillPayConfig(DB) {
  const c = await readState(DB, KEY);
  return { ...DEFAULTS, ...c, approvers: (c.approvers || []).map(lower), bigApprovers: (c.bigApprovers || []).map(lower) };
}

export async function saveBillPayConfig(DB, patch) {
  const next = {};
  if (patch.approvers !== undefined) next.approvers = [...new Set((patch.approvers || []).map(lower).filter(isEmail))].slice(0, 10);
  if (patch.bigApprovers !== undefined) next.bigApprovers = [...new Set((patch.bigApprovers || []).map(lower).filter(isEmail))].slice(0, 10);
  if (patch.bigBillCents !== undefined) next.bigBillCents = Math.max(0, Math.round(Number(patch.bigBillCents) || 0));
  if (patch.dailyCapCents !== undefined) next.dailyCapCents = Math.max(0, Math.round(Number(patch.dailyCapCents) || 0));
  if (patch.payMode !== undefined) {
    if (!PAY_MODES.includes(patch.payMode)) throw new Error('Pick off, request or send');
    next.payMode = patch.payMode;
  }
  if (patch.startsOn !== undefined) {
    if (patch.startsOn && !/^\d{4}-\d{2}-\d{2}$/.test(patch.startsOn)) throw new Error('Pick the day bills start paying from Mercury');
    next.startsOn = patch.startsOn || null;
  }
  if (patch.payFromAccountId !== undefined) next.payFromAccountId = patch.payFromAccountId && /^[\w-]{6,64}$/.test(patch.payFromAccountId) ? patch.payFromAccountId : null;
  return writeState(DB, KEY, next);
}

// ─── Pure parts (tested) ────────────────────────────────────────────

/** A bill a person has to say yes to: a vendor bill waiting, not paid, not a card purchase (those are paid already) */
export function needsApproval(bill) {
  if (!bill || bill.status !== 'pending' || bill.chargeId) return false;
  const owed = bill.balance ?? (bill.cents - (bill.paid || 0));
  return owed > 0;
}

/**
 * Where a bill stands after `approvals` ([{ by, decision, at }]) given the
 * config → 'waiting' | 'approved' | 'rejected' | 'second' (one yes, a second is needed)
 */
export function approvalState(bill, approvals, cfg) {
  const valid = approvals.filter((a) => cfg.approvers.includes(a.by) || cfg.bigApprovers.includes(a.by));
  if (valid.some((a) => a.decision === 'rejected')) return 'rejected';
  const yes = new Set(valid.filter((a) => a.decision === 'approved').map((a) => a.by));
  if (!yes.size) return 'waiting';
  const big = cfg.bigBillCents > 0 && bill.cents >= cfg.bigBillCents;
  if (!big) return 'approved';
  // A big bill: two different people, at least one of them a second-approval person (or two approvers when none is listed)
  const second = cfg.bigApprovers.length ? [...yes].some((e) => cfg.bigApprovers.includes(e)) : true;
  return yes.size >= 2 && second ? 'approved' : 'second';
}

/**
 * The most a bill may be paid without asking again: the smallest amount any
 * yes was given for. A bill that grew after the yes goes back for a new one. Pure.
 */
export function approvedCents(approvals) {
  const yes = approvals.filter((a) => a.decision === 'approved' && Number.isFinite(a.cents));
  return yes.length ? Math.min(...yes.map((a) => a.cents)) : null;
}

/** The Mercury recipient for a vendor: a person's link, else the only active one whose name matches */
export function recipientFor(vendor, recipients, linkedId = null) {
  if (linkedId) return recipients.find((r) => r.id === linkedId) || null;
  const hits = recipients.filter((r) => r.status !== 'deleted' && (vendorLikeness(vendor, r.name) === 1 || (r.nickname && vendorLikeness(vendor, r.nickname) === 1)));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The open bill a Mercury payment paid: the bill it was sent for, else the
 * one open bill from a vendor of that name whose balance (or total) is the
 * amount, issued before the payment. → bill or null
 */
export function billForPayment(txn, bills, { paidFor = null } = {}) {
  const cents = Math.abs(txn.cents);
  if (paidFor) return bills.find((b) => b.id === paidFor) || null;
  const t = Date.parse(txn.posted_at || txn.created_at);
  const fits = bills.filter((b) => {
    const owed = b.balance ?? (b.cents - (b.paid || 0));
    if (!(owed > 0) || b.status === 'denied') return false;
    if (owed !== cents && b.cents !== cents) return false;
    if (Number.isFinite(t) && Date.parse(b.date || b.createdAt) > t + 3 * DAY) return false;
    return vendorLikeness(b.vendor, txn.counterparty) >= 0.99;
  });
  return fits.length === 1 ? fits[0] : null;
}

// ─── D1 reads ───────────────────────────────────────────────────────

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const billRow = (r) => ({
  id: r.id, jobId: r.job_id, vendor: r.vendor, cents: r.cents, date: r.date, createdAt: r.created_at, status: r.status,
  number: r.number, lines: parse(r.lines, []), chargeId: r.charge_id, accountId: r.account_id, paid: r.paid, balance: r.balance,
});
const approvalRow = (r) => r && ({
  billId: r.bill_id, state: r.state, askedAt: r.asked_at, askedCount: r.asked_count || 0, approvals: parse(r.approvals, []),
  decidedBy: r.decided_by, decidedAt: r.decided_at, note: r.note, recipientId: r.recipient_id,
  payState: r.pay_state, payRef: r.pay_ref, payCents: r.pay_cents, payError: r.pay_error, paidAt: r.paid_at, payStartedAt: r.pay_started_at,
  hold: parse(r.hold, null),
});

async function readBills(DB, { sinceIso = null } = {}) {
  const rows = (await DB.prepare(`SELECT * FROM spend_bills ${sinceIso ? 'WHERE created_at >= ?' : ''} ORDER BY created_at DESC LIMIT 2000`).bind(...(sinceIso ? [sinceIso] : [])).all()).results || [];
  return rows.map(billRow);
}

async function readApproval(DB, billId) {
  return approvalRow(await DB.prepare('SELECT * FROM bill_approvals WHERE bill_id = ?').bind(billId).first());
}

async function upsertApproval(DB, billId, patch) {
  const before = (await readApproval(DB, billId)) || { billId, state: 'waiting', askedCount: 0, approvals: [] };
  const a = { ...before, ...patch };
  await DB.prepare(`INSERT OR REPLACE INTO bill_approvals (bill_id, state, asked_at, asked_count, asked_ref, approvals, decided_by, decided_at, note, recipient_id,
      pay_state, pay_ref, pay_cents, pay_error, paid_at, updated_at, pay_started_at, hold) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(billId, a.state, a.askedAt || null, a.askedCount || 0, a.askedRef || null, JSON.stringify(a.approvals || []), a.decidedBy || null, a.decidedAt || null,
      a.note || null, a.recipientId || null, a.payState || null, a.payRef || null, a.payCents ?? null, a.payError || null, a.paidAt || null, new Date().toISOString(), a.payStartedAt || null,
      a.hold ? JSON.stringify(a.hold) : null).run();
  return a;
}

/** Mercury's recipients, cached for an hour → [{ id, name, nickname, status, emails, defaultPaymentMethod, hasBank, hasW9 }] */
export async function cachedRecipients(env, { now = Date.now(), fresh = false } = {}) {
  const st = await readState(env.DB, 'mercury-recipients');
  if (!fresh && st.list && now - Date.parse(st.at || 0) < RECIPIENTS_EVERY_MS) return st.list;
  const d = await mercury(env, '/recipients', { query: { limit: 1000 } });
  const list = (d?.recipients || []).map((r) => ({
    id: r.id, name: r.name, nickname: r.nickname || null, status: r.status, emails: r.emails || [],
    defaultPaymentMethod: r.defaultPaymentMethod || null,
    hasBank: !!(r.electronicRoutingInfo || r.domesticWireRoutingInfo || r.realTimePaymentRoutingInfo),
    hasCheckAddress: !!(r.checkInfo || r.address),
    hasW9: (r.attachments || []).some((a) => a.formType === 'w9'),
  }));
  await writeState(env.DB, 'mercury-recipients', { list, at: new Date(now).toISOString() });
  return list;
}

/**
 * The bills waiting for a decision, and the ones decided lately, with what
 * an approver needs to say yes: the job, where it stands, the bill's codes.
 */
export async function billQueue(env, { now = Date.now() } = {}) {
  await ensureBillPaySchema(env.DB);
  const [bills, ledgers, codes, approvals, cfg] = await Promise.all([
    readBills(env.DB, { sinceIso: new Date(now - 120 * DAY).toISOString() }),
    readLedgers(env.DB),
    costCodes(env).catch(() => []),
    env.DB.prepare('SELECT * FROM bill_approvals').all().then((r) => (r.results || []).map(approvalRow)),
    readBillPayConfig(env.DB),
  ]);
  const byBill = new Map(approvals.map((a) => [a.billId, a]));
  // Where each vendor's W-9 and insurance stood when last read from JobTread (./_vendors.js)
  const docs = new Map(await env.DB.prepare('SELECT jt_id, state, asked_at FROM vendor_asks').all()
    .then((r) => (r.results || []).map((x) => [x.jt_id, { ...parse(x.state, {}), askedAt: x.asked_at }]), () => []));
  const codeName = (id) => codes.find((c) => c.id === id)?.name || 'Uncoded';
  const out = [];
  for (const b of bills) {
    const a = byBill.get(b.id);
    if (!needsApproval(b) && !a) continue;
    const ledger = ledgers.find((l) => l.jobId === b.jobId);
    const codesOnBill = [...new Set(b.lines.map((l) => l.costCodeId).filter(Boolean))];
    out.push({
      ...b,
      owed: b.balance ?? (b.cents - (b.paid || 0)),
      jobName: ledger?.name || null,
      job: ledger ? { budget: ledger.totals?.budget || 0, forecast: ledger.totals?.forecast || 0 } : null,
      codes: codesOnBill.map((id) => {
        const r = ledger?.rows?.find((x) => x.codeId === id);
        return { id, name: codeName(id), budget: r?.budget || 0, forecast: r?.forecast || 0 };
      }),
      big: cfg.bigBillCents > 0 && b.cents >= cfg.bigBillCents,
      documents: (b.accountId && docs.get(b.accountId)) || null,
      vendorLink: b.accountId ? `https://app.jobtread.com/vendors/${b.accountId}` : null,
      approval: a || { state: 'waiting', askedCount: 0, approvals: [] },
      link: `https://app.jobtread.com/documents/${b.id}`,
    });
  }
  return out;
}

// ─── Deciding ───────────────────────────────────────────────────────

/**
 * Someone said yes or no. `from` is who (the agent passes the reply's
 * sender; the admin passes the signed-in person). → { ok, state, error? }
 */
export async function decideBill(env, billId, { decision, from, note = null, via = 'email', now = Date.now() }) {
  await ensureBillPaySchema(env.DB);
  if (!['approved', 'rejected'].includes(decision)) return { ok: false, error: 'decision must be approved or rejected' };
  const cfg = await readBillPayConfig(env.DB);
  const by = lower(from);
  if (!cfg.approvers.includes(by) && !cfg.bigApprovers.includes(by)) return { ok: false, error: `${by || 'That person'} isn’t an approver (Job Costs → Bills → Settings)` };
  const raw = await env.DB.prepare('SELECT * FROM spend_bills WHERE id = ?').bind(billId).first();
  if (!raw) return { ok: false, error: 'That bill isn’t here yet' };
  const bill = billRow(raw);
  const before = (await readApproval(env.DB, billId)) || { state: 'waiting', approvals: [] };
  if (before.state === 'approved' && decision === 'approved') return { ok: true, state: 'approved', already: true };
  if (['requested', 'sent', 'paid'].includes(before.payState)) return { ok: false, error: 'This bill is already being paid; change it in Mercury' };
  const owedNow = bill.balance ?? (bill.cents - (bill.paid || 0));
  const approvals = [...(before.approvals || []).filter((a) => a.by !== by), { by, decision, cents: owedNow, at: new Date(now).toISOString(), via, ...(note ? { note: String(note).slice(0, 500) } : {}) }];
  const state = approvalState(bill, approvals, cfg);
  await upsertApproval(env.DB, billId, { state, approvals, decidedBy: by, decidedAt: new Date(now).toISOString(), note: note ? String(note).slice(0, 500) : before.note });
  const key = `bill:${billId}`;
  const title = `${bill.vendor} bill${bill.number ? ` #${bill.number}` : ''}`;
  if (state === 'rejected') {
    await slackIssue(env, key, slackCard({
      icon: '✋', title: `${title} not approved`,
      lead: `${by} said no${note ? `: “${String(note).slice(0, 300)}”` : '.'} It stays unpaid in JobTread until someone sorts it out with ${bill.vendor}.`,
      facts: [['Amount', dollars(bill.cents)]],
      buttons: [{ label: 'Open bills', url: ADMIN }, { label: 'Open in JobTread', url: `https://app.jobtread.com/documents/${billId}` }],
    }), { title, kind: 'attention', area: 'finance' }).catch(() => null);
  }
  if (state === 'approved') {
    // JobTread shows the bill approved too, so nobody asks about it again there
    await pave(env.JOBTREAD_GRANT_KEY, { updateDocument: { $: { id: billId, status: 'approved' } } }).catch(() => null);
    const pay = await payBill(env, billId, { now }).catch(() => null);
    if (pay?.state === 'held') return { ok: true, state, held: true, reason: pay.reason };
  }
  return { ok: true, state };
}

export async function markAsked(env, billId, { ref = null, now = Date.now() } = {}) {
  await ensureBillPaySchema(env.DB);
  const before = (await readApproval(env.DB, billId)) || { state: 'waiting', askedCount: 0, approvals: [] };
  return upsertApproval(env.DB, billId, { askedAt: new Date(now).toISOString(), askedCount: (before.askedCount || 0) + 1, askedRef: ref ? String(ref).slice(0, 200) : before.askedRef });
}

/** What the agent should email about now: waiting bills never asked, or asked 3+ days ago with no answer */
export async function billsToAsk(env, { now = Date.now() } = {}) {
  const q = await billQueue(env, { now });
  return q.filter((b) => needsApproval(b) && ['waiting', 'second'].includes(b.approval.state)
    && (!b.approval.askedAt || now - Date.parse(b.approval.askedAt) > REASK_AFTER_MS) && (b.approval.askedCount || 0) < 5);
}

// ─── Paying ─────────────────────────────────────────────────────────

/** Pay one approved bill the way Setup says. → { ok, state, error? } */
export async function payBill(env, billId, { now = Date.now() } = {}) {
  await ensureBillPaySchema(env.DB);
  const cfg = await readBillPayConfig(env.DB);
  let a = await readApproval(env.DB, billId);
  if (!a || a.state !== 'approved') return { ok: false, error: 'not approved' };
  if (['requested', 'sent', 'paid'].includes(a.payState)) return { ok: true, state: a.payState };
  // The vendor's W-9 and insurance, fresh from JobTread, whatever the paying mode: a held bill tells
  // whoever pays by hand not to, too
  const raw = await env.DB.prepare('SELECT * FROM spend_bills WHERE id = ?').bind(billId).first();
  if (raw?.account_id) {
    const docs = await billDocs(env, raw.account_id, { now }).catch((e) => ({ ok: false, error: e.message }));
    if (!docs.ok) return holdBill(env, billRow(raw), a, docs, { now });
    if (a.payState === 'held') a = await releaseHold(env, billRow(raw), a, { now });
  }
  if (cfg.payMode === 'off') return { ok: true, state: 'by-hand' };
  if (!payingStarted(cfg, now)) return { ok: true, state: 'not-yet' };   // paid once the switch day comes (payApproved)
  const fail = async (error) => {
    await upsertApproval(env.DB, billId, { payState: 'failed', payError: error });
    await slackIssue(env, `bill:${billId}`, slackCard({
      icon: '⚠️', title: 'An approved bill wasn’t paid', lead: error,
      buttons: [{ label: 'Open bills', url: ADMIN }],
    }), { title: 'Bill payment', kind: 'attention', area: 'finance' }).catch(() => null);
    return { ok: false, error };
  };
  if (!mercuryConfigured(env)) return fail('Mercury isn’t connected');
  if (!cfg.payFromAccountId) return fail('Pick the account bills are paid from (Job Costs → Bills → Settings)');
  const bill = billRow(raw);
  // What JobTread says is owed right now, never the copy (someone may have paid part of it by hand)
  const fresh = await billBalance(env, billId).catch(() => null);
  if (!fresh) return fail('JobTread didn’t answer, so the bill’s balance couldn’t be checked. It tries again within the hour.');
  if (fresh.status === 'denied') return fail('The bill was denied in JobTread, so it wasn’t paid');
  const owed = fresh.balance;
  const allowed = approvedCents(a.approvals) ?? bill.cents;
  if (owed > allowed) {
    await upsertApproval(env.DB, billId, { state: 'waiting', approvals: [], askedAt: null, askedCount: 0, note: `Went from ${dollars(allowed)} to ${dollars(owed)} after it was approved` });
    await slackIssue(env, `bill:${billId}`, slackCard({
      icon: '✋', title: `${bill.vendor} bill changed after it was approved`,
      lead: `It was approved at ${dollars(allowed)} and now says ${dollars(owed)}. Nothing was paid; the approver gets asked again.`,
      buttons: [{ label: 'Open bills', url: ADMIN }, { label: 'Open in JobTread', url: `https://app.jobtread.com/documents/${billId}` }],
    }), { title: 'Bill changed', kind: 'attention', area: 'finance' }).catch(() => null);
    return { ok: false, error: 'amount changed after approval' };
  }
  if (!(owed > 0)) return upsertApproval(env.DB, billId, { payState: 'paid', paidAt: new Date(now).toISOString() }).then(() => ({ ok: true, state: 'paid' }));
  const recipients = await cachedRecipients(env, { now });
  const r = recipientFor(bill.vendor, recipients, a.recipientId);
  if (!r) return fail(`No single Mercury recipient matches ${bill.vendor}. Link one in Job Costs → Bills.`);
  const method = ['ach', 'check'].includes(r.defaultPaymentMethod) ? r.defaultPaymentMethod : r.hasBank ? 'ach' : r.hasCheckAddress ? 'check' : null;
  if (!method) return fail(`${r.name} has no bank account or mailing address in Mercury yet`);
  // The day's payments so far, so one bad day can't empty the account
  const day = new Date(now).toISOString().slice(0, 10);
  const sent = await env.DB.prepare("SELECT COALESCE(SUM(pay_cents), 0) AS n FROM bill_approvals WHERE pay_state IN ('requested', 'sent', 'paid') AND substr(pay_started_at, 1, 10) = ?").bind(day).first();
  if (cfg.dailyCapCents > 0 && (sent?.n || 0) + owed > cfg.dailyCapCents) return fail(`Paying ${dollars(owed)} would pass today’s cap of ${dollars(cfg.dailyCapCents)}. It goes tomorrow, or raise the cap.`);
  const body = {
    recipientId: r.id, amount: owed / 100, paymentMethod: method, idempotencyKey: `soard-bill-${billId}`,
    note: `JobTread bill${bill.number ? ` #${bill.number}` : ''} · approved by ${a.decidedBy}`,
    externalMemo: `Sunshine on a Ranney Day${bill.number ? ` · bill ${bill.number}` : ''}`,
  };
  try {
    if (cfg.payMode === 'request') {
      const d = await mercury(env, `/account/${encodeURIComponent(cfg.payFromAccountId)}/request-send-money`, { method: 'POST', body });
      await upsertApproval(env.DB, billId, { payState: 'requested', payRef: d?.requestId || null, payCents: owed, payError: null, recipientId: r.id, payStartedAt: new Date(now).toISOString() });
      await slackPost(env, slackCard({
        icon: '💸', title: `${bill.vendor}: ${dollars(owed)} waiting for approval in Mercury`,
        lead: `${a.decidedBy} approved the bill. Mercury is holding the payment until an approver taps Approve in Mercury.`,
        buttons: [{ label: 'Open Mercury', url: 'https://app.mercury.com/' }, { label: 'Open bills', url: ADMIN }],
      }), { kind: 'news', area: 'finance' }).catch(() => null);
      return { ok: true, state: 'requested' };
    }
    const d = await mercury(env, `/account/${encodeURIComponent(cfg.payFromAccountId)}/transactions`, { method: 'POST', body });
    await upsertApproval(env.DB, billId, { payState: 'sent', payRef: d?.id || null, payCents: owed, payError: null, recipientId: r.id, payStartedAt: new Date(now).toISOString() });
    await slackResolved(env, `bill:${billId}`, slackCard({ icon: '✅', title: `${bill.vendor} paid ${dollars(owed)}` }), { summary: `Paid by ${method.toUpperCase()}` }).catch(() => null);
    return { ok: true, state: 'sent' };
  } catch (e) {
    // 409: Mercury already has this payment (the idempotency key) — it went
    if (e.status === 409) {
      const state = cfg.payMode === 'request' ? 'requested' : 'sent';
      await upsertApproval(env.DB, billId, { payState: state, payCents: owed, payError: null, recipientId: r.id, payStartedAt: a.payStartedAt || new Date(now).toISOString() });
      return { ok: true, state };
    }
    return fail(`Mercury said: ${String(e.message).slice(0, 200)}`);
  }
}

// ─── Held for the vendor's documents ────────────────────────────────

const shortDay = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });

/** A note on the bill in JobTread, for staff only → its id */
async function billNote(env, billId, { name, message, pinned = false }) {
  const d = await pave(env.JOBTREAD_GRANT_KEY, {
    createComment: {
      $: { targetType: 'document', targetId: billId, name, message, isPinned: pinned, isVisibleToAll: false, isVisibleToInternalRoles: true, isVisibleToVendorRoles: false, isVisibleToCustomerRoles: false },
      createdComment: { id: {} },
    },
  });
  return d?.createComment?.createdComment?.id || null;
}

/**
 * An approved bill whose vendor's W-9 or insurance isn't current: not paid,
 * and said so in JobTread (a pinned note, once), Job Costs and the Finance
 * channel; the vendor is emailed (./_vendors.js). → { ok: false, state: 'held', reason }
 */
async function holdBill(env, bill, a, docs, { now = Date.now() } = {}) {
  const iso = new Date(now).toISOString();
  const first = a.payState !== 'held';
  const hold = { ...(a.hold || {}), since: a.hold?.since || iso };
  let reason;
  if (docs.error) {
    reason = `JobTread didn’t answer, so ${bill.vendor}’s W-9 and insurance couldn’t be checked. It checks again within 15 minutes.`;
  } else {
    reason = `Not paid until ${bill.vendor} sends ${docs.state.send || 'a W-9 and a current certificate of insurance'}${docs.state.detail ? ` (${docs.state.detail})` : ''}.`;
    const asked = await askForBill(env, docs.vendor, docs.state, { number: bill.number, cents: bill.balance ?? (bill.cents - (bill.paid || 0)) }, { now })
      .catch((e) => ({ ok: false, error: e.message }));
    if (asked.ok && !asked.skipped) hold.askedAt = iso;
    hold.noEmail = !!asked.noEmail;
  }
  if (first && !docs.error) {
    hold.noteId = await billNote(env, bill.id, {
      name: 'Approved, not paid yet', pinned: true,
      message: `Approved by ${a.decidedBy || 'an approver'} on ${shortDay(Date.parse(a.decidedAt || iso))}, and not paid yet: ${bill.vendor} needs to send ${docs.state.send}${docs.state.detail ? ` (${docs.state.detail})` : ''}. `
        + (hold.noEmail ? 'There’s no email for them in JobTread, so add one to their contact and they’re asked within 15 minutes. ' : 'They were emailed for it with their own upload link. ')
        + 'This bill pays itself once their documents check out. (SOARD website, Job Costs → Bills)',
    }).catch(() => null);
  }
  await upsertApproval(env.DB, bill.id, { payState: 'held', payError: reason, hold: { ...hold, reason } });
  if (first) {
    await slackIssue(env, `bill:${bill.id}`, slackCard({
      icon: '⏸️', title: `${bill.vendor} bill approved, not paid yet`,
      lead: `${reason}${hold.askedAt ? ' They were emailed for it; it pays itself once it checks out.' : hold.noEmail ? ' There’s no email for them in JobTread, so nobody could ask: add one to their contact.' : ''}`,
      facts: [['Amount', dollars(bill.balance ?? bill.cents)]],
      buttons: [{ label: 'Open bills', url: ADMIN }, { label: 'Vendor in JobTread', url: `https://app.jobtread.com/vendors/${bill.accountId}` }],
    }), { title: `${bill.vendor} bill`, kind: 'attention', area: 'finance' }).catch(() => null);
  }
  return { ok: false, state: 'held', reason };
}

/** The documents came in: the note comes off the top of the bill and it's free to pay → the approval */
async function releaseHold(env, bill, a, { now = Date.now() } = {}) {
  if (a.hold?.noteId) await pave(env.JOBTREAD_GRANT_KEY, { updateComment: { $: { id: a.hold.noteId, isPinned: false } } }).catch(() => null);
  await billNote(env, bill.id, { name: 'Documents in', message: `${bill.vendor}’s W-9 and insurance checked out on ${shortDay(now)}, so this bill is cleared to pay.` }).catch(() => null);
  await slackResolved(env, `bill:${bill.id}`, slackCard({ icon: '✅', title: `${bill.vendor}: documents in` }), { summary: 'Their W-9 and insurance are current, so the bill is cleared to pay.' }).catch(() => null);
  return upsertApproval(env.DB, bill.id, { payState: null, payError: null, hold: null });
}

/** A vendor's documents checked out: each of their held bills goes on to be paid, here and in Ramp → how many */
export async function releaseVendorHolds(env, accountId, { now = Date.now() } = {}) {
  await ensureBillPaySchema(env.DB);
  const rows = (await env.DB.prepare("SELECT a.bill_id FROM bill_approvals a JOIN spend_bills b ON b.id = a.bill_id WHERE a.pay_state = 'held' AND b.account_id = ?").bind(accountId).all()).results || [];
  let n = 0;
  for (const r of rows) {
    const p = await payBill(env, r.bill_id, { now }).catch(() => null);
    if (p && p.state !== 'held') n++;
  }
  return n + await releaseRampHolds(env, accountId, { now }).catch(() => 0);
}

/** Pay approved bills that haven't gone yet (payment turned on later, a failed day, tomorrow's cap) */
export async function payApproved(env, { now = Date.now() } = {}) {
  await ensureBillPaySchema(env.DB);
  const cfg = await readBillPayConfig(env.DB);
  if (cfg.payMode === 'off' || !payingStarted(cfg, now)) return 0;
  const rows = (await env.DB.prepare("SELECT bill_id, pay_error, updated_at FROM bill_approvals WHERE state = 'approved' AND (pay_state IS NULL OR pay_state = 'failed')").all()).results || [];
  let n = 0;
  for (const r of rows) {
    // A failure waits an hour before the next try
    if (r.pay_error && now - Date.parse(r.updated_at) < 60 * 60 * 1000) continue;
    const p = await payBill(env, r.bill_id, { now }).catch(() => ({ ok: false }));
    if (p.ok) n++;
  }
  return n;
}

// ─── Mercury → JobTread ─────────────────────────────────────────────

async function billBalance(env, billId, fetchImpl = fetch) {
  const d = await pave(env.JOBTREAD_GRANT_KEY, { document: { $: { id: billId }, status: {}, balance: {}, amountPaid: {}, account: { id: {} } } }, fetchImpl);
  if (!d?.document) throw new Error('JobTread has no such bill');
  return { balance: Math.round(Number(d.document.balance ?? 0) * 100), status: d.document.status, accountId: d.document.account?.id || null };
}

/** Record one Mercury payment on its JobTread bill → JobTread's payment id */
export async function recordOnBill(env, bill, { txnId, cents, paidAt, how }, { fetchImpl = fetch } = {}) {
  const fresh = await billBalance(env, bill.id, fetchImpl);
  if (!(fresh.balance > 0)) return { already: true };
  const amount = Math.min(cents, fresh.balance) / 100;
  const made = await pave(env.JOBTREAD_GRANT_KEY, {
    createPayment: {
      $: {
        organizationId: SOARD_ORG_ID, accountId: fresh.accountId || bill.accountId, amount, paidAt, type: 'debit',
        externalId: `mercury:${txnId}`.slice(0, 128), source: 'Mercury', description: how === 'card' ? 'Paid by SOARD card (Mercury)' : 'Paid from Mercury',
      },
      createdPayment: { id: {} },
    },
  }, fetchImpl);
  const paymentId = made?.createPayment?.createdPayment?.id;
  if (!paymentId) throw new Error('JobTread made no payment');
  await pave(env.JOBTREAD_GRANT_KEY, { createDocumentPayment: { $: { amount, documentId: bill.id, paymentId }, createdDocumentPayment: { id: {} } } }, fetchImpl);
  return { paymentId, amount };
}

/**
 * Every Mercury payment out (ACH, check, wire) and every card charge paired
 * with a bill, recorded on its JobTread bill once. A payment that matches a
 * bill also takes the bill's job, so it isn't counted twice (once billed,
 * once waiting for a receipt). → { recorded, skipped, errors }
 */
export async function recordPayments(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensureBillPaySchema(env.DB);
  const since = new Date(now - RECORD_LOOK_BACK_DAYS * DAY).toISOString();
  const [txns, bills, done, approvals, cardPairs] = await Promise.all([
    readTxns(env.DB, { from: since, kinds: ['outgoingPayment'] }),
    readBills(env.DB, { sinceIso: new Date(now - 180 * DAY).toISOString() }),
    env.DB.prepare('SELECT txn_id FROM spend_payments').all().then((r) => new Set((r.results || []).map((x) => x.txn_id))),
    env.DB.prepare("SELECT bill_id, pay_ref, pay_state, recipient_id, pay_cents FROM bill_approvals WHERE pay_state IN ('requested', 'sent')").all().then((r) => r.results || []),
    env.DB.prepare("SELECT id, bill_id, cents, posted_at, created_at FROM spend_charges WHERE bill_id IS NOT NULL AND status = 'sent' AND kind LIKE '%Card%' AND created_at >= ?").bind(since).all().then((r) => r.results || []),
  ]);
  const paidFor = new Map(approvals.filter((a) => a.pay_ref).map((a) => [a.pay_ref, a.bill_id]));
  // A payment Mercury held for approval comes back with a new id: match it by recipient and amount
  const heldFor = (t) => {
    const hits = approvals.filter((a) => a.pay_state === 'requested' && a.recipient_id && a.recipient_id === t.counterparty_id && a.pay_cents === Math.abs(t.cents));
    return hits.length === 1 ? hits[0].bill_id : null;
  };
  const out = { recorded: 0, skipped: 0, errors: 0 };
  const iso = new Date(now).toISOString();
  const keep = (txnId, billId, cents, how, extra = {}) => env.DB.prepare('INSERT OR REPLACE INTO spend_payments (txn_id, bill_id, cents, jt_payment_id, how, error, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(txnId, billId, cents, extra.paymentId || null, how, extra.error || null, iso).run();

  const work = [
    ...txns.filter((t) => t.status === 'sent' && t.cents < 0 && !done.has(t.id)).map((t) => ({ t, how: 'payment' })),
    ...cardPairs.filter((c) => !done.has(c.id)).map((c) => ({ t: { id: c.id, cents: -c.cents, posted_at: c.posted_at, created_at: c.created_at }, how: 'card', billId: c.bill_id })),
  ];
  let tries = 0;
  for (const { t, how, billId } of work) {
    const bill = billForPayment(t, bills, { paidFor: billId || paidFor.get(t.id) || heldFor(t) || null });
    if (!bill) { out.skipped++; continue; }
    if (++tries > 25) break;   // JobTread work per run; payroll and rent never count against it
    try {
      const r = await recordOnBill(env, bill, { txnId: t.id, cents: Math.abs(t.cents), paidAt: t.posted_at || t.created_at || iso, how }, { fetchImpl });
      await keep(t.id, bill.id, Math.abs(t.cents), how, { paymentId: r.paymentId });
      if (how === 'payment') {
        // The payment is this bill's money: on its job, and no longer "waiting for a receipt"
        await env.DB.prepare("UPDATE spend_charges SET bill_id = ?, bucket = 'job', job_id = COALESCE(?, job_id), job_how = 'bill', updated_at = ? WHERE id = ?")
          .bind(bill.id, bill.jobId, iso, t.id).run();
        await env.DB.prepare('UPDATE spend_bills SET charge_id = COALESCE(charge_id, ?) WHERE id = ?').bind(t.id, bill.id).run();
      }
      const a = await readApproval(env.DB, bill.id);
      if (a) await upsertApproval(env.DB, bill.id, { payState: 'paid', paidAt: iso, payError: null, hold: null });
      // Paid by hand while it was held: the note comes off the top of the bill
      if (a?.hold?.noteId) await pave(env.JOBTREAD_GRANT_KEY, { updateComment: { $: { id: a.hold.noteId, isPinned: false } } }, fetchImpl).catch(() => null);
      if (a && ['requested', 'sent'].includes(a.payState)) {
        await slackResolved(env, `bill:${bill.id}`, slackCard({ icon: '✅', title: `${bill.vendor} paid ${dollars(Math.abs(t.cents))}`, lead: 'Recorded on the bill in JobTread.' }), { summary: 'Paid and recorded in JobTread' }).catch(() => null);
      }
      if (!r.already) out.recorded++;
    } catch (e) {
      out.errors++;
      await keep(t.id, bill.id, Math.abs(t.cents), how, { error: String(e.message).slice(0, 300) });
    }
  }
  return out;
}

/** The heartbeat part: pay what's approved and waiting, record what Mercury paid. Never throws. */
export async function maybeRunBillPay(env, { now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    const st = await readState(env.DB, 'bill-pay-runs');
    if (now - Date.parse(st.lastAt || 0) < 5 * 60 * 1000) return null;
    await writeState(env.DB, 'bill-pay-runs', { lastAt: new Date(now).toISOString() });
    const paid = mercuryConfigured(env) ? await payApproved(env, { now }).catch(() => 0) : 0;
    const recorded = await recordPayments(env, { now });
    await writeState(env.DB, 'bill-pay-runs', { last: { paid, ...recorded }, error: null });
    return { paid, ...recorded };
  } catch (e) {
    await writeState(env.DB, 'bill-pay-runs', { error: String(e.message).slice(0, 300) }).catch(() => {});
    return null;
  }
}
