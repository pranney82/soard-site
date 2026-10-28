/**
 * Job costs from Mercury and JobTread, as it happens (replaces Ramp)
 * ===========================================================================
 * The path of one dollar:
 *
 *  1. A card is swiped (or a bill paid). Mercury's webhook (POST
 *     /api/mercury-webhook, signed, registered by the site itself) says so
 *     at authorization. The charge is kept in D1 spend_charges and placed on
 *     a job at once (./_spend-match.js guessJob: the cardholder's one active
 *     job, or the one job in Build), coded by the vendor rules when they
 *     know the vendor. Its job's ledger is rebuilt in seconds: the money
 *     shows as "pending" on that job.
 *  2. The receipt goes to ap@soardcharity.com, forwarded to the DataX
 *     Receipt Processor agent. It reads the receipt and makes the JobTread
 *     vendor bill: one line per cost code, matched to the job's budget, the
 *     receipt attached, paid. It asks this site for the vendor rules
 *     (/api/spend-rules) and the job the charge was placed on (/api/spend-hint).
 *  3. Every 2 minutes the heartbeat reads new JobTread vendor bills and
 *     pairs each with its charge (same total to the cent, vendor and date
 *     close). The bill's job and codes replace the guess; "pending" becomes
 *     "billed". The charge's note in Mercury gets the job and the bill, for
 *     Mercury Books.
 *
 * Also on the heartbeat: a catch-up read of Mercury (anything the webhook
 * missed), a rebuild of every active job's ledger every 15 minutes, one
 * Slack card each morning listing charges with no receipt after 2 days and
 * charges no job could be found for, and (when switched on in the admin)
 * each card's monthly limit kept at what its holder's jobs have left.
 *
 * Nothing here needs a person. Admin → Job Costs shows all of it; a person
 * can place or code a charge there, and that answer becomes a rule.
 *
 * Env: MERCURY_API_TOKEN, JOBTREAD_GRANT_KEY, SLACK_BOT_TOKEN (alerts).
 */

import { SOARD_ORG_ID, pave, TZ } from './_reveals.js';
import { slackIssue, slackPost, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import {
  mercuryConfigured, readState, writeState, getTransaction, listTransactions, updateTransaction,
  cardholders, setCardLimit, ensureWebhook, webhookSecret, verifySignature, listCategories, WEBHOOK_KEY,
} from './_mercury.js';
import { chargeOf, guessJob, bucketOf, ruleFor, pairBills, vendorKey, dollars, LIVE_STATUSES, BUCKETS } from './_spend-match.js';
import {
  computeLedger, thresholds, activeJobs, jobCostSources, costCodes, readLedgers, writeLedger, dropLedgersExcept,
} from './_job-ledger.js';
import { findRampBills } from './_jobtread-bills.js';
import { mirrorTransaction } from './_mercury-txns.js';
import { maybeRunBillPay } from './_bill-pay.js';
import { maybeRunReceipts } from './_spend-receipts.js';
import { checkOdd } from './_spend-odd.js';
import { maybeRunCloseouts } from './_job-closeout.js';
import { syncJobFields } from './_job-costs-sync.js';

const MIN = 60 * 1000;
const CATCH_UP_EVERY_MS = 2 * MIN;
const REBUILD_EVERY_MS = 15 * MIN;
const CARDS_EVERY_MS = 60 * MIN;
const CAPS_EVERY_MS = 6 * 60 * MIN;
const WEBHOOK_CHECK_EVERY_MS = 60 * MIN;
const RECEIPT_GRACE_MS = 48 * 60 * MIN;
const FIRST_LOOK_BACK_MS = 30 * 24 * 60 * MIN;
const BILL_LOOK_BACK_DAYS = 45;
const MAX_BODY = 256 * 1024;
const CAP_HEADROOM_CENTS = 50000;    // $500 over what the jobs have left
const CAP_FLOOR_CENTS = 100000;      // never below $1,000 a month
const CAP_CHANGE_MIN_CENTS = 25000;  // don't touch a limit for less than $250
export const ADMIN_URL = `${SITE_ORIGIN}/admin/#job-costs`;
const CONFIG_KEY = 'job-costs';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spend_charges (
    id TEXT PRIMARY KEY, kind TEXT, status TEXT, cents INTEGER NOT NULL, vendor TEXT, card_id TEXT, email TEXT,
    created_at TEXT, posted_at TEXT, account_id TEXT, bucket TEXT, job_id TEXT, job_how TEXT, code_id TEXT, code_how TEXT,
    bill_id TEXT, has_receipt INTEGER, link TEXT, note_at TEXT, note_error TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS spend_charges_job ON spend_charges (job_id)',
  'CREATE INDEX IF NOT EXISTS spend_charges_created ON spend_charges (created_at)',
  `CREATE TABLE IF NOT EXISTS spend_bills (
    id TEXT PRIMARY KEY, job_id TEXT, vendor TEXT, cents INTEGER, date TEXT, created_at TEXT, status TEXT,
    number TEXT, lines TEXT, charge_id TEXT, seen_at TEXT, account_id TEXT, paid INTEGER, balance INTEGER)`,
  'CREATE INDEX IF NOT EXISTS spend_bills_charge ON spend_bills (charge_id)',
  `CREATE TABLE IF NOT EXISTS spend_rules (
    vendor TEXT PRIMARY KEY, name TEXT, kind TEXT NOT NULL, code_id TEXT, source TEXT, by TEXT, hits INTEGER DEFAULT 0, updated_at TEXT)`,
  'CREATE TABLE IF NOT EXISTS spend_events (id TEXT PRIMARY KEY, at TEXT)',
];

/**
 * Rules SOARD starts with: vendors whose trade is plain from the name (the
 * subs and services on recent jobs). Staff answers add to these and win.
 */
export const SEED_RULES = [
  { name: 'TKO Plumbing', codeId: '22NJw43SdZLW' },                     // 19 PLUMBING
  { name: 'Power Up Electrical Contractors', codeId: '22NJw43SjAnp' },  // 20 ELECTRICAL
  { name: 'True Loo Waste Services', codeId: '22NJw43TsEZM' },          // 34 DUMPSTER, PORTALET & SITE CLEANS
  { name: 'Bin There Dump That', codeId: '22NJw43TsEZM' },
  { name: 'City of Sandy Springs', codeId: '22P3ueXJprxd' },            // 02 BUILDING PERMIT
  { name: 'DeKalb County', codeId: '22P3ueXJprxd' },
];

const _ready = new WeakSet();
export async function ensureSpendSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  // Bills kept before payments were read: add the columns (already there → SQLite says so, fine)
  for (const col of ['account_id TEXT', 'paid INTEGER', 'balance INTEGER']) {
    await DB.prepare(`ALTER TABLE spend_bills ADD COLUMN ${col}`).run().catch(() => {});
  }
  const n = await DB.prepare('SELECT COUNT(*) AS n FROM spend_rules').first();
  if (!n?.n) {
    const now = new Date().toISOString();
    await DB.batch(SEED_RULES.map((r) => DB.prepare('INSERT OR IGNORE INTO spend_rules (vendor, name, kind, code_id, source, by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(vendorKey(r.name), r.name, 'code', r.codeId, 'seed', null, now)));
  }
  _ready.add(DB);
}

export const readConfig = (DB) => readState(DB, CONFIG_KEY);
export const writeConfig = (DB, patch) => writeState(DB, CONFIG_KEY, patch);

// ─── Rules ──────────────────────────────────────────────────────────

/**
 * [{ vendor, name, kind, costCodeId, source, by, hits, updatedAt }]
 * kind: 'code' (a makeover vendor, with its cost code), 'store' (Sunny &
 * Ranney) or 'operating' (running SOARD)
 */
export const RULE_KINDS = ['code', 'store', 'operating'];
export async function readRules(DB) {
  await ensureSpendSchema(DB);
  const r = await DB.prepare('SELECT * FROM spend_rules ORDER BY name').all();
  return (r.results || []).map((x) => ({ vendor: x.vendor, name: x.name, kind: x.kind, costCodeId: x.code_id, source: x.source, by: x.by, hits: x.hits || 0, updatedAt: x.updated_at }));
}

export async function saveRule(DB, { name, kind = 'code', costCodeId = null, by = null, source = 'staff' }) {
  await ensureSpendSchema(DB);
  const vendor = vendorKey(name);
  if (!vendor) throw new Error('A vendor name is needed');
  if (!RULE_KINDS.includes(kind)) throw new Error('Pick job, store or operating');
  if (kind === 'code' && !costCodeId) throw new Error('Pick a cost code');
  await DB.prepare(`INSERT INTO spend_rules (vendor, name, kind, code_id, source, by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vendor) DO UPDATE SET name = excluded.name, kind = excluded.kind, code_id = excluded.code_id, source = excluded.source, by = excluded.by, updated_at = excluded.updated_at`)
    .bind(vendor, String(name).trim().slice(0, 120), kind, kind === 'code' ? costCodeId : null, source, by, new Date().toISOString()).run();
  return vendor;
}

export async function deleteRule(DB, vendor) {
  await ensureSpendSchema(DB);
  await DB.prepare('DELETE FROM spend_rules WHERE vendor = ?').bind(vendor).run();
}

// ─── Charges ────────────────────────────────────────────────────────

const rowToCharge = (r) => ({
  id: r.id, kind: r.kind, status: r.status, cents: r.cents, vendor: r.vendor, cardId: r.card_id, email: r.email,
  createdAt: r.created_at, postedAt: r.posted_at, accountId: r.account_id, bucket: r.bucket, jobId: r.job_id, jobHow: r.job_how, costCodeId: r.code_id, codeHow: r.code_how,
  billId: r.bill_id, hasReceipt: !!r.has_receipt, link: r.link, noteAt: r.note_at, noteError: r.note_error, updatedAt: r.updated_at,
});

export async function readCharges(DB, { sinceIso = null, jobId = null, limit = 500 } = {}) {
  await ensureSpendSchema(DB);
  const where = [];
  const args = [];
  if (sinceIso) { where.push('created_at >= ?'); args.push(sinceIso); }
  if (jobId) { where.push('job_id = ?'); args.push(jobId); }
  const r = await DB.prepare(`SELECT * FROM spend_charges ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).bind(...args, limit).all();
  return (r.results || []).map(rowToCharge);
}

async function readCharge(DB, id) {
  const r = await DB.prepare('SELECT * FROM spend_charges WHERE id = ?').bind(id).first();
  return r ? rowToCharge(r) : null;
}

/**
 * Keep one Mercury transaction. What a person picked, or a bill's job,
 * stays; otherwise the bucket and job are worked out again with what's
 * known now. → { charge, jobsTouched: [ids] } (null charge when it isn't spending)
 */
export async function keepTransaction(env, txn, { jobs = null, cards = null, rules = null, cfg = null, now = Date.now() } = {}) {
  await ensureSpendSchema(env.DB);
  // Money in and out, as Mercury sent it, for the P&L, cash and vendors
  await mirrorTransaction(env.DB, txn, { now });
  const holder = cards?.get?.(txn.cardId) || null;
  const c = chargeOf(txn, { cardEmail: holder?.email });
  if (!c) return { charge: null, jobsTouched: [] };
  const before = await readCharge(env.DB, c.id);
  const keepPlaced = before && (before.jobHow === 'staff' || before.jobHow === 'bill' || before.billId);
  rules ||= await readRules(env.DB);
  cfg ||= await readConfig(env.DB);
  const rule = ruleFor(c.vendor, rules);
  let bucket = before?.bucket ?? null;
  let jobId = before?.jobId ?? null;
  let jobHow = before?.jobHow ?? null;
  if (!keepPlaced) {
    const b = bucketOf(c, { cardBuckets: cfg.cardBuckets || {}, accountBuckets: cfg.accountBuckets || {}, rule });
    bucket = b.bucket;
    jobId = null;
    jobHow = null;
    if (!bucket || bucket === 'job') {
      jobs ||= await cachedJobs(env);
      const g = guessJob(c, jobs);
      jobId = g.jobId;
      jobHow = g.how;
      if (jobId || rule?.kind === 'code') bucket = 'job';
    }
  }
  let codeId = before?.costCodeId ?? null;
  let codeHow = before?.codeHow ?? null;
  if (!(codeHow === 'staff' || codeHow === 'bill') && bucket === 'job' && rule?.kind === 'code') { codeId = rule.costCodeId; codeHow = 'rule'; }
  const iso = new Date(now).toISOString();
  // A store or operating charge gets its Mercury note now (no bill is coming); a moved one gets it again
  const noteAt = before && before.bucket === bucket && before.jobId === jobId ? before.noteAt : null;
  await env.DB.prepare(`INSERT OR REPLACE INTO spend_charges
      (id, kind, status, cents, vendor, card_id, email, created_at, posted_at, account_id, bucket, job_id, job_how, code_id, code_how, bill_id, has_receipt, link, note_at, note_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(c.id, c.kind, c.status, c.cents, c.vendor, c.cardId, c.email, c.createdAt || iso, c.postedAt, c.accountId, bucket, jobId, jobHow, codeId, codeHow,
      before?.billId || null, c.hasReceipt ? 1 : 0, c.link, noteAt || null, noteAt ? before?.noteError || null : null, iso).run();
  const touched = new Set([before?.jobId, jobId].filter(Boolean));
  // Only a change the ledger would show needs a rebuild
  const same = before && before.jobId === jobId && before.costCodeId === codeId && before.cents === c.cents && before.status === c.status;
  return { charge: { ...c, bucket, jobId, jobHow, costCodeId: codeId, codeHow }, jobsTouched: same ? [] : [...touched] };
}

/**
 * A person sorted a charge: bucket 'job' (with jobId and maybe costCodeId),
 * 'store' or 'operating'. `remember` makes it the rule for that vendor.
 */
export async function placeCharge(env, id, { bucket, jobId, costCodeId, remember = false, by = null }) {
  await ensureSpendSchema(env.DB);
  const before = await readCharge(env.DB, id);
  if (!before) throw new Error('That charge isn’t here');
  if (before.billId && bucket && bucket !== 'job') throw new Error('This charge has a JobTread bill, so it belongs to that job');
  const sets = [];
  const args = [];
  if (bucket !== undefined) {
    if (bucket !== null && !BUCKETS.includes(bucket)) throw new Error('Pick job, store or operating');
    if (bucket === 'job' && !jobId) throw new Error('Pick the job');
    sets.push('bucket = ?', 'job_id = ?', 'job_how = ?', 'note_at = NULL', 'note_error = NULL');
    args.push(bucket, bucket === 'job' ? jobId : null, bucket ? 'staff' : null);
    if (bucket !== 'job') { sets.push('code_id = NULL', 'code_how = NULL'); }
  }
  if (costCodeId !== undefined) { sets.push('code_id = ?', 'code_how = ?'); args.push(costCodeId || null, costCodeId ? 'staff' : null); }
  if (!sets.length) return before;
  await env.DB.prepare(`UPDATE spend_charges SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args, new Date().toISOString(), id).run();
  if (remember && before.vendor) {
    if (bucket === 'store' || bucket === 'operating') await saveRule(env.DB, { name: before.vendor, kind: bucket, by });
    else if (costCodeId) await saveRule(env.DB, { name: before.vendor, kind: 'code', costCodeId, by });
  }
  const after = await readCharge(env.DB, id);
  await Promise.all([...new Set([before.jobId, after.jobId].filter(Boolean))].map((j) => rebuildJob(env, j).catch(() => null)));
  return after;
}

// ─── The webhook ────────────────────────────────────────────────────

/**
 * POST /api/mercury-webhook. 2xx once the event is handled (Mercury stops
 * retrying); 400 for a bad signature (not retried); 503 while there's no
 * secret yet; 500 when Mercury or D1 failed, so Mercury tries again.
 * `after` runs the job rebuild once the answer is out (Mercury waits 5 s).
 */
export async function handleWebhook(env, request, { now = Date.now(), after = (p) => p } = {}) {
  if (!env.DB) return Response.json({ ok: false, error: 'D1 binding missing' }, { status: 503 });
  const secret = await webhookSecret(env).catch(() => null);
  if (!secret) return Response.json({ ok: false, error: 'not set up yet' }, { status: 503 });
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_BODY) return Response.json({ ok: false, error: 'too large' }, { status: 413 });
  const sig = await verifySignature(secret, request.headers.get('Mercury-Signature'), raw, now / 1000);
  if (!sig.ok) return Response.json({ ok: false, error: sig.why }, { status: 400 });
  let ev;
  try { ev = JSON.parse(new TextDecoder().decode(raw)); } catch { return Response.json({ ok: false, error: 'not JSON' }, { status: 400 }); }
  await ensureSpendSchema(env.DB);
  const iso = new Date(now).toISOString();
  await writeState(env.DB, WEBHOOK_KEY, { lastEventAt: iso });
  if (ev?.resourceType !== 'transaction' || !ev.resourceId) return Response.json({ ok: true, ignored: ev?.resourceType || 'unknown' });
  if (ev.id) {
    const fresh = await env.DB.prepare('INSERT OR IGNORE INTO spend_events (id, at) VALUES (?, ?)').bind(String(ev.id), iso).run();
    if (!fresh.meta?.changes) return Response.json({ ok: true, duplicate: true });
  }
  try {
    const txn = await getTransaction(env, ev.resourceId);
    const cards = await cachedCards(env).catch(() => null);
    const { charge, jobsTouched } = await keepTransaction(env, txn, { cards, now });
    if (jobsTouched.length) after(Promise.all(jobsTouched.map((j) => rebuildJob(env, j).catch(() => null))));
    return Response.json({ ok: true, kept: !!charge });
  } catch (e) {
    // Let Mercury retry this event: forget we saw it
    if (ev.id) await env.DB.prepare('DELETE FROM spend_events WHERE id = ?').bind(String(ev.id)).run().catch(() => {});
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// ─── Caches: jobs and cardholders change slowly ─────────────────────

let _jobs = null;
export async function cachedJobs(env, { now = Date.now(), fresh = false } = {}) {
  if (!fresh && _jobs && now - _jobs.at < 5 * MIN) return _jobs.list;
  const list = await activeJobs(env);
  _jobs = { at: now, list };
  return list;
}

async function cachedCards(env, { now = Date.now() } = {}) {
  const st = await readState(env.DB, 'mercury-cards');
  if (st.at && now - Date.parse(st.at) < CARDS_EVERY_MS && Array.isArray(st.cards)) return new Map(st.cards.map((c) => [c.id, c]));
  const map = await cardholders(env);
  await writeState(env.DB, 'mercury-cards', { at: new Date(now).toISOString(), cards: [...map.values()] });
  return map;
}

// ─── JobTread bills ─────────────────────────────────────────────────

const cents = (n) => Math.round(Number(n || 0) * 100);

/** Vendor bills JobTread has for SOARD made in the last BILL_LOOK_BACK_DAYS, kept in D1 → count */
export async function syncBills(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensureSpendSchema(env.DB);
  const since = new Date(now - BILL_LOOK_BACK_DAYS * 24 * 60 * MIN).toISOString().slice(0, 10);
  let page = null;
  let n = 0;
  const iso = new Date(now).toISOString();
  for (let i = 0; i < 20; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        documents: {
          $: { size: 25, where: { and: [['type', '=', 'vendorBill'], ['createdAt', '>=', since]] }, sortBy: [{ field: 'createdAt', order: 'desc' }], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, status: {}, cost: {}, issueDate: {}, createdAt: {}, number: {}, amountPaid: {}, balance: {},
            account: { id: {}, name: {} }, job: { id: {} },
            costItems: { $: { size: 25 }, nodes: { cost: {}, costCode: { id: {} } } },
          },
        },
      },
    }, fetchImpl);
    const conn = data?.organization?.documents;
    const stmts = [];
    for (const d of conn?.nodes || []) {
      const lines = (d.costItems?.nodes || []).map((c) => ({ costCodeId: c.costCode?.id || null, cents: cents(c.cost) }));
      stmts.push(env.DB.prepare(`INSERT INTO spend_bills (id, job_id, vendor, cents, date, created_at, status, number, lines, charge_id, seen_at, account_id, paid, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, vendor = excluded.vendor, cents = excluded.cents, date = excluded.date, status = excluded.status, number = excluded.number, lines = excluded.lines, seen_at = excluded.seen_at,
            account_id = excluded.account_id, paid = excluded.paid, balance = excluded.balance`)
        .bind(d.id, d.job?.id || null, d.account?.name || '', cents(d.cost), d.issueDate || d.createdAt, d.createdAt, d.status, d.number || null, JSON.stringify(lines), iso,
          d.account?.id || null, d.amountPaid == null ? null : cents(d.amountPaid), d.balance == null ? null : cents(d.balance)));
      n++;
    }
    if (stmts.length) await env.DB.batch(stmts);
    page = conn?.nextPage;
    if (!page) break;
  }
  return n;
}

/**
 * Bills ↔ charges. A pair takes the bill's job and its main cost code (the
 * largest line); the ledger then counts the bill as billed and drops the
 * charge from pending. → [jobIds touched]
 */
export async function pairAll(env, { now = Date.now() } = {}) {
  await ensureSpendSchema(env.DB);
  const since = new Date(now - BILL_LOOK_BACK_DAYS * 24 * 60 * MIN).toISOString();
  const bills = ((await env.DB.prepare("SELECT * FROM spend_bills WHERE charge_id IS NULL AND status != 'denied' AND created_at >= ?").bind(since).all()).results || [])
    .map((b) => ({ id: b.id, jobId: b.job_id, vendor: b.vendor, cents: b.cents, date: b.date, lines: JSON.parse(b.lines || '[]') }));
  const charges = (await readCharges(env.DB, { sinceIso: since, limit: 2000 })).filter((c) => !c.billId && LIVE_STATUSES.has(c.status));
  const pairs = pairBills(bills, charges);
  const touched = new Set();
  const iso = new Date(now).toISOString();
  for (const p of pairs) {
    const bill = bills.find((b) => b.id === p.billId);
    const charge = charges.find((c) => c.id === p.chargeId);
    const main = [...bill.lines].sort((a, b) => b.cents - a.cents)[0]?.costCodeId || null;
    await env.DB.batch([
      env.DB.prepare('UPDATE spend_bills SET charge_id = ? WHERE id = ?').bind(charge.id, bill.id),
      env.DB.prepare("UPDATE spend_charges SET bill_id = ?, bucket = 'job', job_id = ?, job_how = 'bill', code_id = ?, code_how = 'bill', note_at = NULL, note_error = NULL, updated_at = ? WHERE id = ?")
        .bind(bill.id, bill.jobId, main, iso, charge.id),
    ]);
    if (charge.jobId) touched.add(charge.jobId);
    if (bill.jobId) touched.add(bill.jobId);
  }
  return [...touched];
}

/** The Mercury note for a sorted charge */
export function noteFor({ bucket, jobName = null, billNumber = null, billId = null }) {
  if (bucket === 'store') return 'Sunny & Ranney (store)';
  if (bucket === 'operating') return 'SOARD operating';
  return `JobTread: ${jobName || 'job'}${billNumber ? ` · bill #${billNumber}` : ''}${billId ? ` · https://app.jobtread.com/documents/${billId}` : ''}`;
}

/**
 * Sorted charges get a note in Mercury, for Mercury Books and anyone
 * looking at the charge there: a makeover's once its JobTread bill turns up
 * (job, bill number, link), the store's and operating's right away. Each
 * bucket's Mercury category goes on too when one is picked in the admin
 * (categories: { job, store, operating }). A refused write (the relay's key,
 * or the token's IP allow-list) is kept and shown in the admin.
 */
export async function writeNotes(env, { now = Date.now(), limit = 20 } = {}) {
  const cfg = await readConfig(env.DB);
  const rows = (await env.DB.prepare(`SELECT c.id, c.bucket, c.job_id, b.number, b.id AS bill_id FROM spend_charges c LEFT JOIN spend_bills b ON b.id = c.bill_id
      WHERE c.note_at IS NULL AND c.status IN ('pending', 'sent') AND (c.bill_id IS NOT NULL OR c.bucket IN ('store', 'operating'))
        AND (c.note_error IS NULL OR c.updated_at < ?) LIMIT ?`).bind(new Date(now - 60 * MIN).toISOString(), limit).all()).results || [];
  if (!rows.length) return { written: 0 };
  const jobs = new Map((await cachedJobs(env).catch(() => [])).map((j) => [j.id, j]));
  let written = 0;
  let error = null;
  for (const r of rows) {
    const bucket = r.bill_id ? 'job' : r.bucket;
    const note = noteFor({ bucket, jobName: jobs.get(r.job_id)?.name, billNumber: r.number, billId: r.bill_id });
    const categoryId = cfg.categories?.[bucket] || null;
    try {
      await updateTransaction(env, r.id, { note, ...(categoryId ? { categoryId } : {}) });
      await env.DB.prepare('UPDATE spend_charges SET note_at = ?, note_error = NULL WHERE id = ?').bind(new Date(now).toISOString(), r.id).run();
      written++;
    } catch (e) {
      error = e.relay ? e.message
        : e.status === 403 || e.status === 401 ? `Mercury refused the write (${e.message}). The token needs write access with the relay's IP on its allow-list.` : e.message;
      await env.DB.prepare('UPDATE spend_charges SET note_error = ?, updated_at = ? WHERE id = ?').bind(String(error).slice(0, 300), new Date(now).toISOString(), r.id).run();
      if (e.status === 403 || e.status === 401) break;
    }
  }
  await writeConfig(env.DB, error ? { lastWriteError: { at: new Date(now).toISOString(), error } } : { lastWriteOkAt: new Date(now).toISOString(), lastWriteError: null });
  return { written, error };
}

// ─── Ledgers ────────────────────────────────────────────────────────

/** Rebuild one job's ledger from JobTread and D1, and say in Slack what crossed a line */
export async function rebuildJob(env, jobOrId, { now = Date.now(), alerts = true } = {}) {
  await ensureSpendSchema(env.DB);
  const job = typeof jobOrId === 'string' ? (await cachedJobs(env)).find((j) => j.id === jobOrId) : jobOrId;
  if (!job) return null;
  const [{ budget, docs }, chargeRows] = await Promise.all([
    jobCostSources(env, job.id),
    env.DB.prepare("SELECT id, cents, code_id FROM spend_charges WHERE job_id = ? AND bill_id IS NULL AND status IN ('pending', 'sent')").bind(job.id).all(),
  ]);
  const pending = (chargeRows.results || []).map((c) => ({ id: c.id, cents: c.cents, costCodeId: c.code_id }));
  const ledger = computeLedger({ budget, docs, pending });
  const prior = (await readLedgers(env.DB)).find((l) => l.jobId === job.id);
  let alerted = prior?.alerted || {};
  if (alerts && env.SLACK_BOT_TOKEN) {
    const codes = await costCodes(env).catch(() => []);
    const codeName = (id) => codes.find((c) => c.id === id)?.name || 'A cost code';
    const t = thresholds(ledger, alerted, { name: job.name, codeName });
    for (const p of t.posts) {
      const card = slackCard({
        icon: p.level === 100 ? '🟠' : p.level === 'code' ? '🟡' : '📈',
        title: p.title, lead: p.lead,
        buttons: [{ label: 'Open job costs', url: `${ADMIN_URL}/${encodeURIComponent(job.id)}` }],
      });
      await slackIssue(env, `jobcost:${job.id}`, card, { title: `${job.name} budget`, kind: 'attention', area: 'finance' }).catch(() => null);
    }
    alerted = t.alerted;
  }
  await writeLedger(env.DB, job, { ...ledger, address: job.address, number: job.number, staff: job.staff }, alerted, now);
  // The same numbers on the job in JobTread, when they moved
  await syncJobFields(env, job.id, ledger.totals);
  return ledger;
}

export async function rebuildAll(env, { now = Date.now() } = {}) {
  const jobs = await cachedJobs(env, { fresh: true });
  let done = 0;
  for (const j of jobs) {
    try { await rebuildJob(env, j, { now }); done++; } catch { /* the next rebuild tries again */ }
  }
  await dropLedgersExcept(env.DB, jobs.map((j) => j.id));
  return { jobs: jobs.length, done };
}

// ─── The morning card ───────────────────────────────────────────────

/**
 * One Slack card a weekday morning, only when there's something: makeover
 * charges 2+ days old with no JobTread bill yet (the receipt never reached
 * ap@), store and operating card charges with no receipt in Mercury, and
 * charges nobody has sorted.
 */
export async function morningCard(env, { now = Date.now() } = {}) {
  const since = new Date(now - 30 * 24 * 60 * MIN).toISOString();
  const all = (await readCharges(env.DB, { sinceIso: since, limit: 2000 })).filter((c) => LIVE_STATUSES.has(c.status) && c.cents > 0);
  const old = (c) => now - Date.parse(c.createdAt) > RECEIPT_GRACE_MS;
  const noReceipt = all.filter((c) => /Card/.test(c.kind || '') && old(c)
    && (c.bucket === 'job' ? !c.billId : (c.bucket === 'store' || c.bucket === 'operating') && !c.hasReceipt));
  const noJob = all.filter((c) => !c.bucket && !c.billId);
  if (!noReceipt.length && !noJob.length) return null;
  const line = (c) => `${dollars(c.cents)} · ${c.vendor} · ${new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ })}${c.email ? ` · ${c.email.split('@')[0]}` : ''}`;
  const lead = [
    noReceipt.length ? `*No receipt yet* (makeovers: forward it to ap@soardcharity.com · store and operating: add it to the charge in Mercury):\n${noReceipt.slice(0, 8).map(line).join('\n')}${noReceipt.length > 8 ? `\n…and ${noReceipt.length - 8} more` : ''}` : null,
    noJob.length ? `*Not sorted* (a job, the store or operating? Pick in the admin):\n${noJob.slice(0, 8).map(line).join('\n')}${noJob.length > 8 ? `\n…and ${noJob.length - 8} more` : ''}` : null,
  ].filter(Boolean).join('\n\n');
  const card = slackCard({ icon: '🧾', title: `Receipts and charges to sort (${noReceipt.length + noJob.length})`, lead, buttons: [{ label: 'Open job costs', url: `${ADMIN_URL}/charges` }] });
  return slackPost(env, card, { kind: 'attention', area: 'finance' });
}

// ─── Card limits ────────────────────────────────────────────────────

/**
 * What each card's monthly limit would be: what its holder's active jobs
 * have left (budget minus forecast), plus $500, never under $1,000. Cards
 * whose holder isn't on a job are left as they are.
 * → [{ cardId, name, lastFour, nowCents, wantCents, jobs: [names] }]
 */
export async function proposeCaps(env) {
  const [cards, jobs, ledgers, cfg] = await Promise.all([cachedCards(env), cachedJobs(env), readLedgers(env.DB), readConfig(env.DB)]);
  const left = new Map(ledgers.map((l) => [l.jobId, Math.max(0, (l.totals?.budget || 0) - (l.totals?.forecast || 0))]));
  const out = [];
  for (const card of cards.values()) {
    if (card.status !== 'active' || !card.email) continue;
    // A card set aside for the store or operating isn't limited by makeover budgets
    if (cfg.cardBuckets?.[card.id] && cfg.cardBuckets[card.id] !== 'job') continue;
    const mine = jobs.filter((j) => (j.staff || []).includes(card.email));
    if (!mine.length) continue;
    const room = mine.reduce((n, j) => n + (left.get(j.id) || 0), 0);
    const want = Math.max(CAP_FLOOR_CENTS, Math.ceil((room + CAP_HEADROOM_CENTS) / 10000) * 10000);
    out.push({ cardId: card.id, name: card.name, lastFour: card.lastFour, nowCents: card.limitCents, interval: card.interval, wantCents: want, jobs: mine.map((j) => j.name) });
  }
  return out;
}

export async function applyCaps(env, { now = Date.now() } = {}) {
  const caps = await proposeCaps(env);
  let set = 0;
  let error = null;
  for (const c of caps) {
    if (c.nowCents != null && c.interval === 'monthly' && Math.abs(c.nowCents - c.wantCents) < CAP_CHANGE_MIN_CENTS) continue;
    try { await setCardLimit(env, c.cardId, c.wantCents); set++; } catch (e) { error = e.message; break; }
  }
  await writeConfig(env.DB, { lastCaps: { at: new Date(now).toISOString(), set, error } });
  if (set) await writeState(env.DB, 'mercury-cards', { at: null });
  return { set, error };
}

// ─── The heartbeat ──────────────────────────────────────────────────

/** Read Mercury since the last look (with an hour's overlap), keep what's new → { read, kept, jobs } */
export async function catchUp(env, { now = Date.now() } = {}) {
  const cfg = await readConfig(env.DB);
  const start = cfg.caughtUpTo ? new Date(Date.parse(cfg.caughtUpTo) - 60 * MIN).toISOString() : new Date(now - FIRST_LOOK_BACK_MS).toISOString();
  const txns = await listTransactions(env, { start });
  const [cards, jobs, rules] = await Promise.all([cachedCards(env).catch(() => null), cachedJobs(env), readRules(env.DB)]);
  const touched = new Set();
  let kept = 0;
  for (const t of txns) {
    const r = await keepTransaction(env, t, { cards, jobs, rules, cfg, now });
    if (r.charge) kept++;
    r.jobsTouched.forEach((j) => touched.add(j));
  }
  await writeConfig(env.DB, { caughtUpTo: new Date(now).toISOString(), lastCatchUp: { at: new Date(now).toISOString(), read: txns.length, kept } });
  return { read: txns.length, kept, jobs: [...touched] };
}

const easternHour = (now) => Number(new Date(now).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: TZ }));
const easternDay = (now) => new Date(now).toLocaleDateString('en-CA', { timeZone: TZ });

/** The heartbeat's wake-up. Each part keeps its own clock; never throws. */
export async function maybeRunSpend(env, { now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSpendSchema(env.DB);
    const cfg = await readConfig(env.DB);
    if (now - Date.parse(cfg.lastRunAt || 0) < CATCH_UP_EVERY_MS) return null;
    // Claim the slot first so overlapping wake-ups don't double up
    await writeConfig(env.DB, { lastRunAt: new Date(now).toISOString() });
    const report = { at: new Date(now).toISOString() };
    const touched = new Set();

    if (mercuryConfigured(env)) {
      if (now - Date.parse(cfg.webhookCheckedAt || 0) > WEBHOOK_CHECK_EVERY_MS) {
        try {
          const w = await ensureWebhook(env);
          await writeConfig(env.DB, { webhookCheckedAt: new Date(now).toISOString(), webhookError: null, ...(w.created ? { webhookCreatedAt: new Date(now).toISOString() } : {}) });
        } catch (e) {
          await writeConfig(env.DB, { webhookCheckedAt: new Date(now).toISOString(), webhookError: e.message });
        }
      }
      try {
        const c = await catchUp(env, { now });
        c.jobs.forEach((j) => touched.add(j));
        report.mercury = { read: c.read, kept: c.kept };
      } catch (e) {
        report.mercuryError = e.message;
        await writeConfig(env.DB, { lastCatchUpError: { at: new Date(now).toISOString(), error: e.message } });
      }
    }

    try {
      report.bills = await syncBills(env, { now });
      (await pairAll(env, { now })).forEach((j) => touched.add(j));
    } catch (e) {
      report.billsError = e.message;
    }
    if (mercuryConfigured(env)) report.notes = await writeNotes(env, { now }).catch((e) => ({ error: e.message }));
    // Approved bills paid from Mercury; Mercury's payments recorded on their JobTread bills
    report.billPay = await maybeRunBillPay(env, { now });
    // Receipt photos from Mercury's app → ap@; bills' receipts → Mercury
    report.receipts = await maybeRunReceipts(env, { jobs: await cachedJobs(env).catch(() => []), now }).catch((e) => ({ error: e.message }));

    if (now - Date.parse(cfg.lastRebuildAt || 0) > REBUILD_EVERY_MS) {
      await writeConfig(env.DB, { lastRebuildAt: new Date(now).toISOString() });
      // Odd charges first: a refund it places back on a job is in this rebuild
      report.odd = await checkOdd(env, { now }).catch((e) => ({ error: e.message }));
      report.rebuild = await rebuildAll(env, { now }).catch((e) => ({ error: e.message }));
      report.closeouts = await maybeRunCloseouts(env, { now });
      // Ramp-era bills still on one "Makeover COGS" line, for Job Costs → Ramp bills (twice a day)
      if (now - Date.parse(cfg.rampLookAt || 0) > 12 * 60 * MIN) {
        await writeConfig(env.DB, { rampLookAt: new Date(now).toISOString() });
        report.rampFound = await findRampBills(env, { rules: await readRules(env.DB) }).catch((e) => ({ error: e.message }));
      }
    } else {
      for (const j of touched) await rebuildJob(env, j, { now }).catch(() => null);
    }

    // Weekdays at 8 AM Eastern, once
    const day = easternDay(now);
    const wd = new Date(now).toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ });
    if (easternHour(now) >= 8 && cfg.morningDay !== day && !['Sat', 'Sun'].includes(wd)) {
      await writeConfig(env.DB, { morningDay: day });
      if (env.SLACK_BOT_TOKEN) await morningCard(env, { now }).catch(() => null);
    }

    if (mercuryConfigured(env) && cfg.caps === 'on' && now - Date.parse(cfg.lastCaps?.at || 0) > CAPS_EVERY_MS) {
      report.caps = await applyCaps(env, { now }).catch((e) => ({ error: e.message }));
    }
    await writeConfig(env.DB, { lastRun: report });
    return report;
  } catch {
    return null;
  }
}

/** Mercury's own categories, for the admin's "category for job spending" picker */
export async function mercuryCategories(env) {
  if (!mercuryConfigured(env)) return [];
  return (await listCategories(env)).map((c) => ({ id: c.id, name: c.name }));
}
