/**
 * Finance: the monthly P&L, a 13-week cash forecast and the month-end close
 * ===========================================================================
 * Everything here is read from Mercury's own record of the money
 * (mercury_txns, ./_mercury-txns.js) plus where Job Costs sorted each charge
 * (spend_charges: a makeover, the Sunny & Ranney store, or operating). Nobody
 * has to type numbers in: the admin (Admin → Finance) and the board portal
 * (boardFinance) read the same functions.
 *
 *   P&L         income and spending per month, in three columns: Makeovers,
 *               Sunny & Ranney store, Operating. Gifts aren't tied to one
 *               makeover, so donations sit under Operating; the Makeovers
 *               column is what the makeovers cost. Spending nobody has
 *               sorted yet is its own line, never hidden.
 *   Cash        13 weeks ahead from today's Mercury balances. A nonprofit's
 *               cash is lumpy (year-end giving, the gala), so it shows a
 *               likely line between a low and a high one, and the low line
 *               is what's checked against the cash floor.
 *   Close       the month that just ended: every charge sorted, receipts in,
 *               categories set, Mercury Books synced, statement out. When it
 *               all passes the Finance channel hears once and the CPA gets
 *               the month's P&L (when an address is saved in Finance → Setup).
 *
 * State: spend_state "finance" (settings, the history backfill, what was
 * already posted) and D1 finance_closes (a closed month's P&L, frozen).
 */

import { readState, writeState, mercury, mercuryConfigured, listTransactions } from './_mercury.js';
import { mirrorTransaction, readTxns, ensureTxnSchema } from './_mercury-txns.js';
import { readConfig, ensureSpendSchema } from './_spend.js';
import { readLedgers } from './_job-ledger.js';
import { slackIssue, slackResolved, slackPost, SITE_ORIGIN, EMAIL_FROM, emailConfigured, isEmail } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { logSent } from './_email-log.js';
import { emailShell, esc as escHtml } from './_email-shell.js';
import { TZ } from './_reveals.js';

export const STATE_KEY = 'finance';
export const ADMIN_URL = `${SITE_ORIGIN}/admin/#finance`;
export const COLUMNS = ['job', 'store', 'operating'];
export const COLUMN_NAMES = { job: 'Makeovers', store: 'Sunny & Ranney store', operating: 'Operating' };
export const INCOME_KINDS = ['donations', 'store', 'other', 'interest'];
export const INCOME_NAMES = { donations: 'Donations', store: 'Store sales', other: 'Other income', interest: 'Interest' };
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const WEEK = 7 * DAY;
const RUN_EVERY_MS = 15 * MIN;
const BALANCE_EVERY_MS = 60 * MIN;
const BACKFILL_PAGES_PER_RUN = 4;      // 2,000 transactions a wake-up, so one run stays short
const DEFAULT_FLOOR_CENTS = 2500000;   // $25,000 until someone sets one
const FORECAST_WEEKS = 13;

const CLOSES_SCHEMA = `CREATE TABLE IF NOT EXISTS finance_closes (
  month TEXT PRIMARY KEY, closed_at TEXT NOT NULL, closed_by TEXT, snapshot TEXT NOT NULL)`;
const _ready = new WeakSet();
async function ensureFinanceSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(CLOSES_SCHEMA).run();
  _ready.add(DB);
}

export const readFinance = (DB) => readState(DB, STATE_KEY);
export const writeFinance = (DB, patch) => writeState(DB, STATE_KEY, patch);

// ─── Dates ──────────────────────────────────────────────────────────

/** 'YYYY-MM' for a time, in Eastern (SOARD's books follow its own calendar) */
export const monthOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);
export const dayOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** A month's first day and the next month's first day, 'YYYY-MM-DD' */
export const monthRange = (month) => ({ from: `${month}-01`, to: `${addMonths(month, 1)}-01` });
export const monthLabel = (month) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** When a row happened: posted if it has, else created, as 'YYYY-MM-DD' Eastern */
const whenOf = (r) => { const t = Date.parse(r.posted_at || r.created_at || ''); return Number.isFinite(t) ? dayOf(t) : ''; };
const inRange = (r, from, to) => { const d = whenOf(r); return d >= from && d < to; };

// ─── Which money is what ────────────────────────────────────────────

const DEAD = new Set(['cancelled', 'failed', 'reversed', 'blocked']);
// Moving money between SOARD's own accounts is never income or spending
const MOVES = new Set(['internalTransfer', 'treasuryTransfer']);
const CARD_REFUNDS = new Set(['creditCardCredit', 'debitCardCredit']);
const FEES = new Set(['wireFee', 'personalBankingSubscriptionFee', 'billingEngineSubscriptionFee', 'cardInternationalTransactionFee',
  'cardInternationalTransactionFeeReversal', 'cardInternationalTransactionFeeRebate', 'cardInternationalTransactionFeeRebateReversal']);
// Paying off the Mercury IO card from checking: the card's charges were already counted
const CARD_PAYOFF = /\bmercury\b.*\b(io|credit|card)\b|\b(io|credit card)\b.*\bpayment\b|\bautopay\b/i;

const DONATION_SOURCES = /zeffy|givebutter|benevity|network for good|fidelity charitable|schwab charitable|vanguard charitable|daf\b|donor.?advised|donorbox|give ?lively|cybergrants|yourcause|blackbaud|paypal giving|facebook payments|meta payments|united way|foundation|charitable|ameriprise|grant/i;
const STORE_SOURCES = /shopify|square|stripe|etsy|faire|clover|toast|sumup/i;

/** A counterparty's name, the way the income map keys it */
export const sourceKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);

/** Money in → 'donations' | 'store' | 'other' | 'interest'. incomeMap (key → kind) is what a person picked and always wins. */
export function incomeKind(row, incomeMap = {}) {
  if (row.kind === 'interestPayment') return 'interest';
  const picked = incomeMap[sourceKey(row.counterparty)];
  if (INCOME_KINDS.includes(picked)) return picked;
  const name = `${row.counterparty || ''} ${row.bank_description || ''}`;
  if (STORE_SOURCES.test(name)) return 'store';
  if (DONATION_SOURCES.test(name)) return 'donations';
  // Paper checks into a charity are almost always gifts
  if (row.kind === 'checkDeposit') return 'donations';
  return 'other';
}

/**
 * One Mercury row → what the P&L does with it:
 *   { type: 'skip' } | { type: 'income', kind, column, cents } |
 *   { type: 'expense', column (null = unsorted), category, jobId, cents }
 * cents is always positive for income and for spending; a refund is negative spending.
 * charge: its spend_charges row (bucket, job_id) or null. accountBuckets: { accountId: bucket }.
 */
export function classify(row, { charge = null, accountBuckets = {}, incomeMap = {} } = {}) {
  if (!row || DEAD.has(row.status) || !row.cents) return { type: 'skip' };
  if (MOVES.has(row.kind)) return { type: 'skip' };
  const category = row.category_name || prettyCategory(row.mercury_category) || (FEES.has(row.kind) ? 'Bank fees' : 'Uncategorized');
  const sortedAs = (fallback) => {
    if (charge?.bucket && COLUMNS.includes(charge.bucket)) return { column: charge.bucket, jobId: charge.bucket === 'job' ? charge.job_id || null : null };
    const acct = accountBuckets[row.account_id];
    if (COLUMNS.includes(acct)) return { column: acct, jobId: null };
    return { column: fallback, jobId: null };
  };
  // A card refund lowers spending where the charge was
  if (CARD_REFUNDS.has(row.kind)) {
    const s = sortedAs(null);
    return { type: 'expense', column: s.column, jobId: s.jobId, category, cents: -Math.abs(row.cents) };
  }
  if (row.cents > 0) {
    if (CARD_PAYOFF.test(`${row.counterparty || ''} ${row.bank_description || ''}`) && row.kind !== 'checkDeposit') return { type: 'skip' };
    const kind = incomeKind(row, incomeMap);
    const acct = accountBuckets[row.account_id];
    // Store sales are the store's; a store account's deposits are too. Everything else is SOARD's general money.
    const column = kind === 'store' || acct === 'store' ? 'store' : 'operating';
    return { type: 'income', kind: kind === 'other' && acct === 'store' ? 'store' : kind, column, cents: row.cents };
  }
  if (CARD_PAYOFF.test(`${row.counterparty || ''} ${row.bank_description || ''}`) && !String(row.kind || '').includes('Card')) return { type: 'skip' };
  const s = sortedAs(FEES.has(row.kind) ? 'operating' : null);
  return { type: 'expense', column: s.column, jobId: s.jobId, category, cents: -row.cents };
}

/** Mercury's merchant types read as words: "FuelAndGas" → "Fuel and gas" */
export function prettyCategory(c) {
  if (!c) return null;
  const words = String(c).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/And/g, 'and').toLowerCase();
  return words[0].toUpperCase() + words.slice(1);
}

const zero = () => ({ job: 0, store: 0, operating: 0, total: 0 });

/**
 * The P&L for rows already narrowed to a period.
 * → { income: [{ key, label, cents: {job,store,operating,total} }], incomeTotal,
 *     expenses: [{ category, cents }], unsorted: { cents, count }, expenseTotal (with .unsorted),
 *     net, jobs: [{ jobId, cents }], count }
 */
export function pnl(rows, { charges = new Map(), accountBuckets = {}, incomeMap = {} } = {}) {
  const income = new Map(INCOME_KINDS.map((k) => [k, zero()]));
  const expenses = new Map();
  const jobs = new Map();
  const unsorted = { cents: 0, count: 0 };
  let count = 0;
  for (const r of rows) {
    const c = classify(r, { charge: charges.get(r.id) || null, accountBuckets, incomeMap });
    if (c.type === 'skip') continue;
    count++;
    if (c.type === 'income') {
      const line = income.get(c.kind);
      line[c.column] += c.cents;
      line.total += c.cents;
      continue;
    }
    if (!c.column) { unsorted.cents += c.cents; unsorted.count++; continue; }
    if (!expenses.has(c.category)) expenses.set(c.category, zero());
    const line = expenses.get(c.category);
    line[c.column] += c.cents;
    line.total += c.cents;
    if (c.column === 'job') {
      const k = c.jobId || 'none';
      jobs.set(k, (jobs.get(k) || 0) + c.cents);
    }
  }
  const sum = (lines) => lines.reduce((t, l) => { for (const k of ['job', 'store', 'operating', 'total']) t[k] += l.cents[k]; return t; }, zero());
  const incomeLines = INCOME_KINDS.map((key) => ({ key, label: INCOME_NAMES[key], cents: income.get(key) })).filter((l) => l.cents.total);
  const expenseLines = [...expenses].map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents.total - a.cents.total);
  const incomeTotal = sum(incomeLines);
  const spent = sum(expenseLines);
  const expenseTotal = { ...spent, unsorted: unsorted.cents, total: spent.total + unsorted.cents };
  const net = {
    job: incomeTotal.job - spent.job,
    store: incomeTotal.store - spent.store,
    operating: incomeTotal.operating - spent.operating,
    total: incomeTotal.total - expenseTotal.total,
  };
  return {
    income: incomeLines,
    incomeTotal,
    expenses: expenseLines,
    unsorted,
    expenseTotal,
    net,
    jobs: [...jobs].map(([jobId, cents]) => ({ jobId: jobId === 'none' ? null : jobId, cents })).sort((a, b) => b.cents - a.cents),
    count,
  };
}

// ─── Reading it all ─────────────────────────────────────────────────

async function chargeMap(DB) {
  await ensureSpendSchema(DB);
  const rows = (await DB.prepare('SELECT id, bucket, job_id, has_receipt, bill_id, cents, status, created_at FROM spend_charges').all()).results || [];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Everything a P&L needs from D1, from `from` (inclusive) on */
async function ledgerInputs(env, { from = null, to = null } = {}) {
  // D1 keeps UTC times and the books follow Eastern days: read a day either side, then narrow by Eastern day
  const pad = (d, n) => new Date(Date.parse(`${d.slice(0, 10)}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  const [all, charges, cfg, fin] = await Promise.all([
    readTxns(env.DB, { from: from && pad(from, -1), to: to && pad(to, 1) }),
    chargeMap(env.DB),
    readConfig(env.DB),
    readFinance(env.DB),
  ]);
  const rows = all.filter((r) => inRange(r, from || '0000', to || '9999'));
  return { rows, charges, accountBuckets: cfg.accountBuckets || {}, incomeMap: fin.incomeMap || {}, fin };
}

/** Job ids → names: open jobs' ledgers, plus every name seen before (closed jobs keep theirs) */
async function jobNames(env, fin) {
  const names = { ...(fin.jobNames || {}) };
  const ledgers = await readLedgers(env.DB).catch(() => []);
  let changed = false;
  for (const l of ledgers) if (l.name && names[l.jobId] !== l.name) { names[l.jobId] = l.name; changed = true; }
  if (changed) await writeFinance(env.DB, { jobNames: names });
  return { names, ledgers };
}

/** Finished makeovers: their spending, from close-outs when Job Costs keeps them, else Mercury */
async function finishedMakeovers(env, rows, charges, ledgers, names, { year }) {
  const open = new Set(ledgers.map((l) => l.jobId));
  // Job Costs' close-outs (_job-closeout.js), when that table exists: the final numbers from JobTread
  let closeouts = [];
  try {
    const r = await env.DB.prepare('SELECT * FROM job_closeouts').all();
    closeouts = (r.results || []).map((c) => {
      // _job-closeout.js: actual (cents, billed + waiting for receipts) and closed_on (JobTread's close date)
      const cents = Number(c.actual || 0);
      const when = String(c.closed_on || '');
      return { jobId: c.job_id, name: c.name || names[c.job_id] || 'A makeover', cents, when };
    }).filter((c) => c.cents > 0 && c.when.startsWith(String(year)));
  } catch { /* no close-outs yet */ }
  if (closeouts.length) return { from: 'closeouts', list: closeouts };
  const perJob = new Map();
  for (const r of rows) {
    const ch = charges.get(r.id);
    if (!ch?.job_id || ch.bucket !== 'job' || open.has(ch.job_id) || DEAD.has(r.status)) continue;
    if (!whenOf(r).startsWith(String(year))) continue;
    perJob.set(ch.job_id, (perJob.get(ch.job_id) || 0) - r.cents);
  }
  const list = [...perJob].filter(([, c]) => c > 0).map(([jobId, cents]) => ({ jobId, name: names[jobId] || 'A makeover', cents }));
  return { from: 'mercury', list };
}

/**
 * The P&L screen: one month, the same month last year, year to date and
 * last year to the same month. → { month, label, months: [...], periods: {...}, jobs, perMakeover, sources, closed }
 */
export async function monthReport(env, month, { now = Date.now() } = {}) {
  const thisYear = Number(month.slice(0, 4));
  const lastYearMonth = `${thisYear - 1}${month.slice(4)}`;
  const { to } = monthRange(month);
  const inputs = await ledgerInputs(env, { from: `${thisYear - 1}-01-01`, to });
  const { rows, charges, accountBuckets, incomeMap, fin } = inputs;
  const { names, ledgers } = await jobNames(env, fin);
  const opts = { charges, accountBuckets, incomeMap };
  const slice = (from, until) => rows.filter((r) => inRange(r, from, until));
  const ly = monthRange(lastYearMonth);
  const periods = {
    month: pnl(slice(`${month}-01`, to), opts),
    lastYearMonth: pnl(slice(ly.from, ly.to), opts),
    ytd: pnl(slice(`${thisYear}-01-01`, to), opts),
    lastYtd: pnl(slice(`${thisYear - 1}-01-01`, ly.to), opts),
  };
  const finished = await finishedMakeovers(env, rows, charges, ledgers, names, { year: thisYear });
  const perMakeover = finished.list.length
    ? { count: finished.list.length, averageCents: Math.round(finished.list.reduce((t, j) => t + j.cents, 0) / finished.list.length), from: finished.from, jobs: finished.list.sort((a, b) => b.cents - a.cents) }
    : null;
  await ensureFinanceSchema(env.DB);
  const closedRow = await env.DB.prepare('SELECT month, closed_at, closed_by, snapshot FROM finance_closes WHERE month = ?').bind(month).first();
  let closed = null;
  if (closedRow) {
    try { closed = { at: closedRow.closed_at, by: closedRow.closed_by, snapshot: JSON.parse(closedRow.snapshot) }; } catch { closed = { at: closedRow.closed_at, by: closedRow.closed_by, snapshot: null }; }
  }
  // Who sent money in, for the income map (top sources in the last 12 months)
  const sources = new Map();
  for (const r of slice(`${addMonths(month, -11)}-01`, to)) {
    const c = classify(r, { charge: charges.get(r.id) || null, accountBuckets, incomeMap });
    if (c.type !== 'income' || c.kind === 'interest') continue;
    const key = sourceKey(r.counterparty);
    if (!key) continue;
    const s = sources.get(key) || { key, name: r.counterparty, kind: c.kind, picked: !!incomeMap[key], cents: 0, count: 0 };
    s.cents += c.cents;
    s.count++;
    sources.set(key, s);
  }
  return {
    month,
    label: monthLabel(month),
    lastYearMonth,
    periods,
    jobNames: Object.fromEntries(periods.month.jobs.concat(periods.ytd.jobs).filter((j) => j.jobId).map((j) => [j.jobId, names[j.jobId] || 'A makeover'])),
    perMakeover,
    sources: [...sources.values()].sort((a, b) => b.cents - a.cents).slice(0, 40),
    closed,
    history: historyState(fin),
    now: new Date(now).toISOString(),
  };
}

function historyState(fin) {
  const b = fin.backfill || {};
  return { since: b.since || null, doneAt: b.doneAt || null, reachedTo: b.reachedTo || null, read: b.read || 0, error: b.error || null };
}

/** The months a P&L can be shown for: from the history's start to this month, newest first */
export function monthsAvailable(fin, now) {
  const last = monthOf(now);
  const first = (fin.backfill?.since || `${Number(last.slice(0, 4)) - 1}-01-01`).slice(0, 7);
  const out = [];
  for (let m = last; m >= first && out.length < 36; m = addMonths(m, -1)) out.push(m);
  return out;
}

// ─── CSV for the CPA ────────────────────────────────────────────────

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvMoney = (cents) => (Number(cents || 0) / 100).toFixed(2);

/** A month's P&L as CSV: the summary by column, then every transaction under it */
export async function monthCsv(env, month) {
  const { from, to } = monthRange(month);
  const { rows, charges, accountBuckets, incomeMap, fin } = await ledgerInputs(env, { from, to });
  const { names } = await jobNames(env, fin);
  const p = pnl(rows, { charges, accountBuckets, incomeMap });
  const lines = [[`SOARD P&L, ${monthLabel(month)}`], [], ['Line', 'Makeovers', 'Sunny & Ranney store', 'Operating', 'Total']];
  const row = (label, c) => lines.push([label, csvMoney(c.job), csvMoney(c.store), csvMoney(c.operating), csvMoney(c.total)]);
  lines.push(['INCOME']);
  p.income.forEach((l) => row(l.label, l.cents));
  row('Total income', p.incomeTotal);
  lines.push(['SPENDING']);
  p.expenses.forEach((l) => row(l.category, l.cents));
  if (p.unsorted.cents) lines.push([`Not sorted yet (${p.unsorted.count})`, '', '', '', csvMoney(p.unsorted.cents)]);
  row('Total spending', p.expenseTotal);
  row('Net', p.net);
  lines.push([], ['TRANSACTIONS'], ['Date', 'Who', 'Kind', 'Column', 'Job', 'Category', 'Amount', 'Mercury Books', 'Mercury link']);
  for (const r of rows) {
    const c = classify(r, { charge: charges.get(r.id) || null, accountBuckets, incomeMap });
    if (c.type === 'skip') continue;
    const column = c.type === 'income' ? INCOME_NAMES[c.kind] : c.column ? COLUMN_NAMES[c.column] : 'Not sorted yet';
    lines.push([whenOf(r), r.counterparty || '', r.kind || '', column, c.jobId ? names[c.jobId] || c.jobId : '', c.type === 'expense' ? c.category : '', csvMoney(r.cents), r.accounting_status || '', r.link || '']);
  }
  return lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n';
}

// ─── Cash: 13 weeks ahead ───────────────────────────────────────────

export const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
export const percentile = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

/** Today's Mercury money → { cashCents, owedCents, accounts: [{ name, kind, cents }], at } (null without Mercury) */
export async function balancesNow(env, { fetchImpl = fetch } = {}) {
  if (!mercuryConfigured(env)) return null;
  const [dep, credit, treasury] = await Promise.all([
    mercury(env, '/accounts', { fetchImpl }).then((r) => r?.accounts || []),
    mercury(env, '/credit', { fetchImpl }).then((r) => r?.accounts || []).catch(() => []),
    mercury(env, '/treasury', { fetchImpl }).then((r) => r?.accounts || []).catch(() => []),
  ]);
  const accounts = [];
  for (const a of dep) {
    if (a.type === 'external' || a.status === 'deleted' || a.status === 'archived') continue;
    accounts.push({ id: a.id, name: a.nickname || a.name || 'Account', kind: a.kind || 'checking', cents: Math.round(Number(a.currentBalance ?? a.availableBalance ?? 0) * 100) });
  }
  for (const t of treasury) accounts.push({ id: t.id, name: t.nickname || t.name || 'Treasury', kind: 'treasury', cents: Math.round(Number(t.currentBalance ?? t.availableBalance ?? 0) * 100) });
  // The IO card: what's owed on it now is cash that leaves at its next payment
  let owedCents = 0;
  for (const c of credit) {
    if (c.status === 'deleted' || c.status === 'archived') continue;
    const owed = Math.abs(Math.round(Number(c.currentBalance ?? 0) * 100));
    owedCents += owed;
    accounts.push({ id: c.id, name: c.nickname || c.name || 'Mercury IO card', kind: 'credit', cents: -owed });
  }
  const cashCents = accounts.filter((a) => a.kind !== 'credit').reduce((t, a) => t + a.cents, 0);
  return { cashCents, owedCents, accounts: accounts.map(({ id, ...rest }) => rest), at: new Date().toISOString() };
}

const RAMP_WEEKS = { Build: 3, Mobilization: 6, Approval: 10 };

/**
 * The forecast itself, pure. Inputs:
 *   startCents       cash today (checking + savings + treasury)
 *   owedCents        on the IO card today (leaves in week 2)
 *   weeklyIncome     [{ weekStart: 'YYYY-MM-DD', cents }] for the last 2 years (all income, oldest first)
 *   monthlySpend     { operating: [cents per month, last 3 full months], store: [...] }
 *   jobs             [{ name, status, remainingCents }] open makeovers (budget or forecast still to spend)
 *   unbudgeted       [{ name, status }] approved makeovers with no budget yet
 *   averageMakeoverCents  what a makeover costs, for the unbudgeted ones
 *   today            'YYYY-MM-DD'
 * → { weeks: [{ start, inLikely, inLow, inHigh, out, outLow, outHigh, likely, low, high, parts }], lowest, end, sources }
 */
export function forecast({ startCents = 0, owedCents = 0, weeklyIncome = [], monthlySpend = {}, jobs = [], unbudgeted = [], averageMakeoverCents = 0, today, weeks = FORECAST_WEEKS, floorCents = DEFAULT_FLOOR_CENTS }) {
  // Weeks run Monday to Sunday, this week first
  const t0 = Date.parse(`${weekStart(today)}T12:00:00Z`);
  const byWeek = new Map(weeklyIncome.map((w) => [w.weekStart, w.cents]));
  const recent = weeklyIncome.filter((w) => Date.parse(`${w.weekStart}T12:00:00Z`) >= t0 - 26 * WEEK).map((w) => w.cents);
  // Weeks with no gift at all count too: they're the lumpiness
  while (recent.length < 26 && weeklyIncome.length) recent.push(0);
  const base = median(recent);
  const low = percentile(recent, 25);
  const high = percentile(recent, 75);
  const weekKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  // The same week a year ago and two years ago (to the nearest week): year-end giving, the gala
  const seasonal = (ms) => {
    const years = [1, 2].map((y) => {
      const back = ms - y * 52 * WEEK;
      const k = weekStart(weekKey(back));
      return byWeek.has(k) ? byWeek.get(k) : null;
    }).filter((x) => x !== null);
    return years.length ? Math.round(years.reduce((a, b) => a + b, 0) / years.length) : null;
  };
  const weekly = (monthly) => Math.round((median(monthly || []) * 12) / 52);
  const opWeekly = weekly(monthlySpend.operating);
  const storeWeekly = weekly(monthlySpend.store);
  const out = [];
  let likely = startCents;
  let lo = startCents;
  let hi = startCents;
  const jobPlan = jobs.map((j) => ({ ...j, spread: RAMP_WEEKS[j.status] || 8 }));
  const newPlan = unbudgeted.map((j) => ({ ...j, startWeek: j.status === 'Mobilization' ? 1 : 3, spread: RAMP_WEEKS[j.status] || 8 }));
  for (let i = 0; i < weeks; i++) {
    const start = t0 + i * WEEK;
    const s = seasonal(start);
    const inLikely = s === null ? base : Math.round((base + s) / 2);
    const inLow = Math.min(low, s === null ? low : s);
    const inHigh = Math.max(high, s === null ? high : s);
    const parts = { operating: opWeekly, store: storeWeekly, makeovers: 0, newMakeovers: 0, card: i === 1 ? owedCents : 0 };
    for (const j of jobPlan) if (i < j.spread) parts.makeovers += Math.round(j.remainingCents / j.spread);
    for (const j of newPlan) if (i >= j.startWeek && i < j.startWeek + j.spread) parts.newMakeovers += Math.round(averageMakeoverCents / j.spread);
    const spend = parts.operating + parts.store + parts.makeovers + parts.newMakeovers + parts.card;
    // Costs run over more often than under: the low line spends 10% more, the high 10% less
    const outLow = Math.round(spend * 1.1);
    const outHigh = Math.round(spend * 0.9);
    likely += inLikely - spend;
    lo += inLow - outLow;
    hi += inHigh - outHigh;
    out.push({ start: weekKey(start), inLikely, inLow, inHigh, out: spend, outLow, outHigh, likely, low: lo, high: hi, parts });
  }
  const minBy = (k) => out.reduce((m, w) => (w[k] < m[k] ? w : m), out[0] || { [k]: startCents, start: today });
  const lowest = { likely: { cents: minBy('likely').likely, week: minBy('likely').start }, low: { cents: minBy('low').low, week: minBy('low').start } };
  const firstUnder = out.find((w) => w.low < floorCents) || null;
  return {
    today,
    startCents,
    owedCents,
    floorCents,
    weeks: out,
    lowest,
    end: out.length ? { likely: out.at(-1).likely, low: out.at(-1).low, high: out.at(-1).high } : { likely: startCents, low: startCents, high: startCents },
    belowFloor: firstUnder ? { week: firstUnder.start, cents: firstUnder.low } : null,
    sources: {
      incomeWeekly: { likely: base, low, high, weeksOfHistory: weeklyIncome.length },
      operatingWeekly: opWeekly,
      storeWeekly,
      makeoversCents: jobs.reduce((t, j) => t + j.remainingCents, 0),
      makeoverCount: jobs.length,
      unbudgetedCount: unbudgeted.length,
      averageMakeoverCents,
    },
  };
}

/** Monday on or before a day, 'YYYY-MM-DD' (weeks start on Mondays) */
export function weekStart(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

/** Everything the forecast reads, from D1 and Mercury → forecast(...) plus the balances */
export async function cashForecast(env, { now = Date.now(), fresh = false } = {}) {
  const fin = await readFinance(env.DB);
  let bal = fin.balances || null;
  if (mercuryConfigured(env) && (fresh || !bal?.at || now - Date.parse(bal.at) > BALANCE_EVERY_MS)) {
    try {
      bal = await balancesNow(env);
      await writeFinance(env.DB, { balances: bal, balancesError: null });
    } catch (e) {
      await writeFinance(env.DB, { balancesError: { at: new Date(now).toISOString(), error: e.message } });
    }
  }
  const today = dayOf(now);
  const thisMonth = monthOf(now);
  const { rows, charges, accountBuckets, incomeMap } = await ledgerInputs(env, { from: `${Number(today.slice(0, 4)) - 2}-01-01` });
  const opts = { charges, accountBuckets, incomeMap };
  // Income by week (Mondays), with the empty weeks in between
  const weeks = new Map();
  let firstDay = null;
  for (const r of rows) {
    const c = classify(r, { charge: charges.get(r.id) || null, ...opts });
    if (c.type !== 'income' || c.kind === 'interest') continue;
    const d = whenOf(r);
    if (!firstDay || d < firstDay) firstDay = d;
    const w = weekStart(d);
    weeks.set(w, (weeks.get(w) || 0) + c.cents);
  }
  const weeklyIncome = [];
  if (firstDay) {
    for (let t = Date.parse(`${weekStart(firstDay)}T12:00:00Z`); t < Date.parse(`${weekStart(today)}T12:00:00Z`); t += WEEK) {
      const k = new Date(t).toISOString().slice(0, 10);
      weeklyIncome.push({ weekStart: k, cents: weeks.get(k) || 0 });
    }
  }
  // Operating and store spending: the last 3 full months
  const monthlySpend = { operating: [], store: [] };
  for (let i = 1; i <= 3; i++) {
    const m = addMonths(thisMonth, -i);
    const { from, to } = monthRange(m);
    const p = pnl(rows.filter((r) => inRange(r, from, to)), opts);
    monthlySpend.operating.push(p.expenseTotal.operating + p.unsorted.cents);
    monthlySpend.store.push(p.expenseTotal.store);
  }
  const ledgers = await readLedgers(env.DB).catch(() => []);
  const jobs = [];
  const unbudgeted = [];
  for (const l of ledgers) {
    const t = l.totals || {};
    if (!t.budget) { if (['Approval', 'Mobilization'].includes(l.status)) unbudgeted.push({ name: l.name, status: l.status }); continue; }
    const remaining = Math.max(0, Math.max(t.budget, t.forecast || 0) - (t.billed || 0) - (t.pending || 0));
    if (remaining) jobs.push({ name: l.name, status: l.status, remainingCents: remaining });
  }
  const { names } = await jobNames(env, fin);
  const year = Number(today.slice(0, 4));
  let finished = await finishedMakeovers(env, rows, charges, ledgers, names, { year });
  if (!finished.list.length) finished = await finishedMakeovers(env, rows, charges, ledgers, names, { year: year - 1 });
  const budgets = ledgers.map((l) => l.totals?.budget || 0).filter(Boolean);
  const averageMakeoverCents = finished.list.length
    ? Math.round(finished.list.reduce((t, j) => t + j.cents, 0) / finished.list.length)
    : budgets.length ? Math.round(budgets.reduce((a, b) => a + b, 0) / budgets.length) : 0;
  const f = forecast({
    startCents: bal?.cashCents || 0, owedCents: bal?.owedCents || 0, weeklyIncome, monthlySpend, jobs, unbudgeted, averageMakeoverCents, today,
    floorCents: Number.isFinite(fin.floorCents) ? fin.floorCents : DEFAULT_FLOOR_CENTS,
  });
  return { ...f, balances: bal, balancesError: fin.balancesError || null, jobs, unbudgeted, averageFrom: finished.list.length ? finished.from : budgets.length ? 'budgets' : null };
}

/** Post once when the low line dips under the floor; say so when it's back above */
export async function cashAlert(env, f, { now = Date.now() } = {}) {
  const fin = await readFinance(env.DB);
  const usd = (c) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
  const weekName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (!f.balances) return null;
  if (f.belowFloor && !fin.cashLowOpen) {
    const card = slackCard({
      icon: '📉', title: 'Cash could dip below the floor',
      lead: `On the cautious line, SOARD's cash reaches ${usd(f.belowFloor.cents)} the week of ${weekName(f.belowFloor.week)}, under the ${usd(f.floorCents)} floor. The likely line's lowest is ${usd(f.lowest.likely.cents)} the week of ${weekName(f.lowest.likely.week)}.`,
      facts: [['Cash today', usd(f.startCents)], ['Owed on the card', usd(f.owedCents)], ['Makeover spending still to come', usd(f.sources.makeoversCents)]],
      buttons: [{ label: 'Open the forecast', url: `${ADMIN_URL}/cash` }],
      footer: 'It says so here again once the forecast is back above the floor.',
    });
    const r = await slackIssue(env, 'finance:cash-low', card, { title: 'Cash forecast', kind: 'attention', area: 'finance' }).catch((e) => ({ ok: false, error: e.message }));
    await writeFinance(env.DB, { cashLowOpen: { at: new Date(now).toISOString(), posted: !!r?.ok } });
    return { posted: !!r?.ok };
  }
  if (!f.belowFloor && fin.cashLowOpen) {
    await slackResolved(env, 'finance:cash-low', slackCard({
      icon: '✅', title: 'Cash forecast is back above the floor',
      lead: `The cautious line's lowest is now ${usd(f.lowest.low.cents)} (floor ${usd(f.floorCents)}).`,
      buttons: [{ label: 'Open the forecast', url: `${ADMIN_URL}/cash` }],
    }), { summary: 'Back above the cash floor' }).catch(() => null);
    await writeFinance(env.DB, { cashLowOpen: null });
    return { resolved: true };
  }
  return null;
}

// ─── The month-end close ────────────────────────────────────────────

const BOOKS_DONE = new Set(['synced', 'reviewed', 'excluded']);

/** The statement for each Mercury account covering a month → { ok, missing: [names], error } */
async function statementsFor(env, month) {
  if (!mercuryConfigured(env)) return { na: true };
  const { from, to } = monthRange(month);
  try {
    const accounts = ((await mercury(env, '/accounts'))?.accounts || []).filter((a) => a.type !== 'external' && a.status !== 'deleted' && a.status !== 'archived');
    const missing = [];
    for (const a of accounts) {
      const r = await mercury(env, `/account/${encodeURIComponent(a.id)}/statements`, { query: { start: from, end: to } });
      const list = r?.statements || r?.accountStatements || [];
      const covers = list.some((s) => String(s.endDate || s.end || s.periodEnd || '').slice(0, 7) === month || String(s.startDate || s.start || '').slice(0, 7) === month);
      if (!covers) missing.push(a.nickname || a.name || 'An account');
    }
    return { ok: !missing.length, missing };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * The checklist for one month → { month, label, checks: [{ key, label, state, count, detail, link }], ready, closed }
 * state: 'ok' | 'todo' | 'na' (doesn't apply yet) | 'unknown' (couldn't check)
 */
export async function closeCheck(env, month, { now = Date.now(), statements = true } = {}) {
  await ensureSpendSchema(env.DB);
  await ensureFinanceSchema(env.DB);
  const { from, to } = monthRange(month);
  const { rows, charges, accountBuckets, incomeMap } = await ledgerInputs(env, { from, to });
  const live = (c) => c.cents > 0 && !DEAD.has(c.status);
  const monthCharges = [...charges.values()].filter((c) => { const d = Date.parse(c.created_at || ''); return Number.isFinite(d) && dayOf(d) >= from && dayOf(d) < to && live(c); });
  const unsorted = monthCharges.filter((c) => !c.bucket && !c.bill_id);
  const noReceipt = monthCharges.filter((c) => c.bucket === 'job' && !c.has_receipt && !c.bill_id);
  const counted = rows.filter((r) => classify(r, { charge: charges.get(r.id) || null, accountBuckets, incomeMap }).type !== 'skip');
  const uncategorized = counted.filter((r) => r.cents < 0 && !r.category_id && !(r.gl && r.gl.length));
  const withBooks = counted.filter((r) => r.accounting_status);
  const booksOpen = withBooks.filter((r) => !BOOKS_DONE.has(r.accounting_status));
  const booksErr = withBooks.filter((r) => r.accounting_status === 'errored');
  const unpairedBills = ((await env.DB.prepare('SELECT id FROM spend_bills WHERE charge_id IS NULL AND date >= ? AND date < ?').bind(from, to).all().catch(() => ({ results: [] }))).results || []);
  const st = statements ? await statementsFor(env, month) : { na: true };
  const jc = `${SITE_ORIGIN}/admin/#job-costs`;
  const checks = [
    { key: 'sorted', label: 'Every charge sorted into a makeover, the store or operating', state: unsorted.length ? 'todo' : 'ok', count: unsorted.length, detail: unsorted.length ? `${unsorted.length} charge${unsorted.length === 1 ? '' : 's'} still to sort` : `${monthCharges.length} charges, all sorted`, link: `${jc}/charges` },
    { key: 'receipts', label: 'Every makeover charge has its receipt or JobTread bill', state: noReceipt.length ? 'todo' : 'ok', count: noReceipt.length, detail: noReceipt.length ? `${noReceipt.length} without a receipt yet` : 'All in', link: `${jc}/charges` },
    { key: 'categories', label: 'Every payment has a Mercury category', state: !counted.length ? 'na' : uncategorized.length ? 'todo' : 'ok', count: uncategorized.length, detail: uncategorized.length ? `${uncategorized.length} without a category` : counted.length ? 'All categorized' : 'Nothing this month', link: `${ADMIN_URL}/close` },
    {
      key: 'books', label: 'Mercury Books has every transaction synced',
      state: !withBooks.length ? 'na' : booksOpen.length ? 'todo' : 'ok', count: booksOpen.length,
      detail: !withBooks.length ? 'Mercury Books isn’t connected to the API yet, so this is checked in Mercury' : booksErr.length ? `${booksErr.length} errored in Books, ${booksOpen.length - booksErr.length} still to review` : booksOpen.length ? `${booksOpen.length} still to review in Books` : 'All synced',
      link: 'https://app.mercury.com/accounting',
    },
    { key: 'bills', label: 'Every JobTread bill matched to its Mercury payment', state: unpairedBills.length ? 'todo' : 'ok', count: unpairedBills.length, detail: unpairedBills.length ? `${unpairedBills.length} bill${unpairedBills.length === 1 ? '' : 's'} with no Mercury payment found` : 'All matched', link: jc },
    {
      key: 'statement', label: 'Mercury’s statement for the month is out',
      state: st.na ? 'na' : st.error ? 'unknown' : st.ok ? 'ok' : 'todo', count: st.missing?.length || 0,
      detail: st.na ? 'Mercury isn’t connected yet' : st.error ? `Couldn’t ask Mercury: ${st.error}` : st.ok ? 'Ready in Mercury' : `Not out yet for ${st.missing.join(', ')}`,
      link: 'https://app.mercury.com/statements',
    },
  ];
  const closedRow = await env.DB.prepare('SELECT closed_at, closed_by FROM finance_closes WHERE month = ?').bind(month).first();
  const ended = now >= Date.parse(`${to}T05:00:00Z`);
  return {
    month,
    label: monthLabel(month),
    ended,
    checks,
    ready: ended && checks.every((c) => c.state === 'ok' || c.state === 'na'),
    closed: closedRow ? { at: closedRow.closed_at, by: closedRow.closed_by } : null,
  };
}

/** Last month and up to two earlier months nobody has closed → [closeCheck] */
export async function openMonths(env, { now = Date.now(), statements = true } = {}) {
  await ensureFinanceSchema(env.DB);
  const fin = await readFinance(env.DB);
  const last = addMonths(monthOf(now), -1);
  const first = fin.closeFrom || last;
  const closed = new Set(((await env.DB.prepare('SELECT month FROM finance_closes').all()).results || []).map((r) => r.month));
  const out = [];
  for (let m = last; m >= first && out.length < 3; m = addMonths(m, -1)) {
    if (closed.has(m) && m !== last) continue;
    out.push(await closeCheck(env, m, { now, statements }));
  }
  return out;
}

/** A person closes a month: its P&L is frozen as it is now */
export async function closeMonth(env, month, { by = null, now = Date.now() } = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Pick a month');
  if (month >= monthOf(now)) throw new Error('A month can be closed once it has ended');
  await ensureFinanceSchema(env.DB);
  const { from, to } = monthRange(month);
  const { rows, charges, accountBuckets, incomeMap } = await ledgerInputs(env, { from, to });
  const snapshot = pnl(rows, { charges, accountBuckets, incomeMap });
  await env.DB.prepare('INSERT OR REPLACE INTO finance_closes (month, closed_at, closed_by, snapshot) VALUES (?, ?, ?, ?)')
    .bind(month, new Date(now).toISOString(), by, JSON.stringify(snapshot)).run();
  return snapshot;
}

export async function reopenMonth(env, month) {
  await ensureFinanceSchema(env.DB);
  await env.DB.prepare('DELETE FROM finance_closes WHERE month = ?').bind(month).run();
}

/** The close packet: the month's P&L in the email, the CSV attached */
export async function closeEmail(env, month, { to, preview = false, by = null }) {
  if (!isEmail(to)) throw new Error('That isn’t an email address');
  if (!emailConfigured(env)) throw new Error('Email isn’t set up (RESEND_API_KEY)');
  const { from, to: until } = monthRange(month);
  const { rows, charges, accountBuckets, incomeMap } = await ledgerInputs(env, { from, to: until });
  const p = pnl(rows, { charges, accountBuckets, incomeMap });
  const csv = await monthCsv(env, month);
  const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const cell = 'padding:6px 8px;border-bottom:1px solid #E4E4E0;text-align:right;font-variant-numeric:tabular-nums;';
  const head = (label) => `<tr><td colspan="5" style="padding:14px 8px 4px;font-weight:700;">${escHtml(label)}</td></tr>`;
  const line = (label, c, bold = false) => `<tr${bold ? ' style="font-weight:700"' : ''}><td style="${cell}text-align:left;">${escHtml(label)}</td><td style="${cell}">${money(c.job)}</td><td style="${cell}">${money(c.store)}</td><td style="${cell}">${money(c.operating)}</td><td style="${cell}">${money(c.total)}</td></tr>`;
  const table = `<table role="presentation" width="100%" style="font-size:13px;border-collapse:collapse;" class="ink">
    <tr><td></td><td style="${cell}font-weight:600;">Makeovers</td><td style="${cell}font-weight:600;">Store</td><td style="${cell}font-weight:600;">Operating</td><td style="${cell}font-weight:600;">Total</td></tr>
    ${head('Income')}${p.income.map((l) => line(l.label, l.cents)).join('')}${line('Total income', p.incomeTotal, true)}
    ${head('Spending')}${p.expenses.map((l) => line(l.category, l.cents)).join('')}
    ${p.unsorted.cents ? line(`Not sorted yet (${p.unsorted.count})`, { job: 0, store: 0, operating: 0, total: p.unsorted.cents }) : ''}
    ${line('Total spending', p.expenseTotal, true)}${line('Net', p.net, true)}
  </table>`;
  const label = monthLabel(month);
  const subject = `${preview ? 'Preview: ' : ''}SOARD's books for ${label} are ready`;
  const htmlBody = emailShell({
    preheader: `${label}: income ${money(p.incomeTotal.total)}, spending ${money(p.expenseTotal.total)}.`,
    heading: `${label} is ready to close`,
    intro: `Every charge is sorted, receipts are in and Mercury's statement is out. The P&L is below, and the attached CSV lists each transaction with its column, job and category.`,
    bodyHtml: table,
    footerHtml: preview ? 'This is a preview sent only to you. The CPA gets the same email once the month passes every check.' : 'Sent by the SOARD website when the month passed every close check.',
  });
  const text = `${label} is ready to close.\n\nIncome ${money(p.incomeTotal.total)}\nSpending ${money(p.expenseTotal.total)}\nNet ${money(p.net.total)}\n\nThe attached CSV has the P&L and every transaction.`;
  const bytes = new TextEncoder().encode(csv);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const fin = await readFinance(env.DB);
  const replyTo = [fin.replyTo, by].find((e) => isEmail(e)) || null;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: EMAIL_FROM, to: [to], subject, html: htmlBody, text,
      ...(replyTo ? { reply_to: replyTo } : {}),
      tags: [{ name: 'type', value: preview ? 'preview' : 'finance-close' }],
      attachments: [{ filename: `SOARD-PL-${month}.csv`, content: btoa(bin) }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json().catch(() => ({}));
  await logSent(env, [{ id: d.id, to, subject }], { tags: [{ name: 'type', value: preview ? 'preview' : 'finance-close' }] });
  return { sent: true, id: d.id || null };
}

/** Once per month: the Finance channel hears it's ready, and the CPA gets the packet */
export async function announceReady(env, check, { now = Date.now() } = {}) {
  if (!check.ready || check.closed) return null;
  const fin = await readFinance(env.DB);
  const posted = { ...(fin.readyPosted || {}) };
  const sent = { ...(fin.cpaSent || {}) };
  const out = {};
  if (!posted[check.month]) {
    const r = await slackPost(env, slackCard({
      icon: '📗', title: `${check.label} is ready to close`,
      lead: 'Every charge is sorted, receipts are in, and Mercury’s statement is out.',
      facts: check.checks.filter((c) => c.state === 'na').map((c) => [c.label, c.detail]),
      buttons: [{ label: 'Open the close', url: `${ADMIN_URL}/close` }],
      footer: isEmail(fin.cpaEmail) ? `The P&L went to ${fin.cpaEmail}.` : 'Add the CPA’s email in Finance → Setup and the P&L goes to them automatically.',
    }), { kind: 'news', area: 'finance' }).catch((e) => ({ ok: false, error: e.message }));
    posted[check.month] = new Date(now).toISOString();
    out.posted = !!r?.ok;
  }
  if (isEmail(fin.cpaEmail) && !sent[check.month]) {
    try {
      await closeEmail(env, check.month, { to: fin.cpaEmail });
      sent[check.month] = new Date(now).toISOString();
      out.emailed = true;
    } catch (e) {
      out.emailError = e.message;
      await writeFinance(env.DB, { cpaError: { at: new Date(now).toISOString(), month: check.month, error: e.message } });
    }
  }
  await writeFinance(env.DB, { readyPosted: posted, cpaSent: sent, ...(out.emailed ? { cpaError: null } : {}) });
  return out;
}

// ─── History: read Mercury back to January last year, once ─────────

/** One step of the backfill (resumable). → { done, read } */
export async function backfillStep(env, { now = Date.now(), pages = BACKFILL_PAGES_PER_RUN } = {}) {
  const fin = await readFinance(env.DB);
  const b = fin.backfill || {};
  if (b.doneAt) return { done: true, read: 0 };
  const since = b.since || `${Number(dayOf(now).slice(0, 4)) - 1}-01-01T00:00:00Z`;
  const start = b.cursor || since;
  await ensureTxnSchema(env.DB);
  let txns;
  try {
    txns = await listTransactions(env, { start, maxPages: pages });
  } catch (e) {
    await writeFinance(env.DB, { backfill: { ...b, since, error: e.message, errorAt: new Date(now).toISOString() } });
    return { done: false, read: 0, error: e.message };
  }
  for (const t of txns) await mirrorTransaction(env.DB, t, { now });
  // Mercury pages by created date, oldest first: carry on from the newest seen. A short read means the end.
  const newest = txns.reduce((m, t) => (t.createdAt && t.createdAt > m ? t.createdAt : m), start);
  const done = txns.length < pages * 500 || newest === start;
  await writeFinance(env.DB, {
    backfill: { since, cursor: newest, reachedTo: newest, read: (b.read || 0) + txns.length, doneAt: done ? new Date(now).toISOString() : null, error: null },
    ...(fin.closeFrom ? {} : { closeFrom: addMonths(monthOf(now), -1) }),
  });
  return { done, read: txns.length };
}

/** The heartbeat's wake-up: history, balances and forecast, the close. Never throws. */
export async function maybeRunFinance(env, { now = Date.now() } = {}) {
  try {
    if (!env.DB) return null;
    const fin = await readFinance(env.DB);
    if (now - Date.parse(fin.lastRunAt || 0) < RUN_EVERY_MS) return null;
    await writeFinance(env.DB, { lastRunAt: new Date(now).toISOString() });
    const report = { at: new Date(now).toISOString() };
    if (mercuryConfigured(env) && !fin.backfill?.doneAt) report.backfill = await backfillStep(env, { now }).catch((e) => ({ error: e.message }));
    if (mercuryConfigured(env)) {
      try {
        const f = await cashForecast(env, { now });
        await writeFinance(env.DB, { lastForecast: { at: new Date(now).toISOString(), lowest: f.lowest, end: f.end, startCents: f.startCents, belowFloor: f.belowFloor, floorCents: f.floorCents } });
        report.cash = await cashAlert(env, f, { now });
      } catch (e) { report.cashError = e.message; }
    }
    // The close: from the 2nd of the month, hourly is plenty
    if (now - Date.parse(fin.lastCloseAt || 0) > 60 * MIN) {
      await writeFinance(env.DB, { lastCloseAt: new Date(now).toISOString() });
      const months = await openMonths(env, { now }).catch(() => []);
      for (const m of months) if (m.ready) report.ready = await announceReady(env, m, { now }).catch((e) => ({ error: e.message }));
    }
    await writeFinance(env.DB, { lastRun: report });
    return report;
  } catch {
    return null;
  }
}

// ─── The board portal ───────────────────────────────────────────────

/**
 * Board-safe finance totals for the board portal. Totals only: no vendor
 * names, cardholders, jobs or single transactions.
 *
 * @returns {Promise<null | {
 *   at: string,                      // when this was worked out (ISO)
 *   months: Array<{ month: string,   // 'YYYY-MM', oldest first, last 12 full months
 *     income: number, makeovers: number, store: number, operating: number,  // dollars (spending positive)
 *     storeSales: number, net: number }>,
 *   ytd: { year: number, through: string, income: number, makeovers: number, store: number, operating: number, net: number },
 *   lastYtd: { year: number, through: string, income: number, makeovers: number, store: number, operating: number, net: number },
 *   cash: null | { today: number, lowest: { dollars: number, week: string }, cautiousLowest: { dollars: number, week: string },
 *                  in13Weeks: number, floor: number, belowFloor: boolean },
 *   close: { month: string, label: string, state: 'closed' | 'ready' | 'open', closedAt: string | null },
 *   perMakeover: null | { count: number, average: number },
 * }>}  null when there's no Mercury history yet
 */
export async function boardFinance(env, { now = Date.now() } = {}) {
  if (!env.DB) return null;
  const thisMonth = monthOf(now);
  const year = Number(thisMonth.slice(0, 4));
  const { rows, charges, accountBuckets, incomeMap, fin } = await ledgerInputs(env, { from: `${year - 1}-01-01` });
  if (!rows.length) return null;
  const opts = { charges, accountBuckets, incomeMap };
  const d = (c) => Math.round(c / 100);
  const summary = (p) => ({ income: d(p.incomeTotal.total), makeovers: d(p.expenseTotal.job), store: d(p.expenseTotal.store), operating: d(p.expenseTotal.operating + p.unsorted.cents), net: d(p.net.total) });
  const months = [];
  for (let i = 12; i >= 1; i--) {
    const m = addMonths(thisMonth, -i);
    const { from, to } = monthRange(m);
    const p = pnl(rows.filter((r) => inRange(r, from, to)), opts);
    months.push({ month: m, ...summary(p), storeSales: d(p.incomeTotal.store) });
  }
  const today = dayOf(now);
  const lastYearToday = `${year - 1}${today.slice(4)}`;
  const ytd = { year, through: today, ...summary(pnl(rows.filter((r) => inRange(r, `${year}-01-01`, `${today}~`)), opts)) };
  const lastYtd = { year: year - 1, through: lastYearToday, ...summary(pnl(rows.filter((r) => inRange(r, `${year - 1}-01-01`, `${lastYearToday}~`)), opts)) };
  let cash = null;
  const lf = fin.lastForecast;
  if (lf?.lowest) {
    cash = {
      today: d(lf.startCents), lowest: { dollars: d(lf.lowest.likely.cents), week: lf.lowest.likely.week },
      cautiousLowest: { dollars: d(lf.lowest.low.cents), week: lf.lowest.low.week },
      in13Weeks: d(lf.end.likely), floor: d(lf.floorCents), belowFloor: !!lf.belowFloor,
    };
  }
  const last = addMonths(thisMonth, -1);
  await ensureFinanceSchema(env.DB);
  const closedRow = await env.DB.prepare('SELECT closed_at FROM finance_closes WHERE month = ?').bind(last).first();
  const close = { month: last, label: monthLabel(last), state: closedRow ? 'closed' : fin.readyPosted?.[last] ? 'ready' : 'open', closedAt: closedRow?.closed_at || null };
  const { names, ledgers } = await jobNames(env, fin);
  const finished = await finishedMakeovers(env, rows, charges, ledgers, names, { year });
  const perMakeover = finished.list.length ? { count: finished.list.length, average: d(finished.list.reduce((t, j) => t + j.cents, 0) / finished.list.length) } : null;
  return { at: new Date(now).toISOString(), months, ytd, lastYtd, cash, close, perMakeover };
}

// The board portal reads boardFinance through a hook (Board never imports this file)
import { provideBoardFinance } from './_board.js';
provideBoardFinance(boardFinance);
