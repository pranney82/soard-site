/**
 * Real-time job costing: every active job, by cost code
 * ===========================================================================
 * For each job and each cost code:
 *
 *   budget     the job's JobTread budget lines
 *   committed  approved purchase orders, less what each vendor has billed on
 *              that code since (only the part still to come)
 *   billed     vendor bills (draft, pending or approved; never denied)
 *   pending    Mercury charges placed on the job that no bill covers yet:
 *              money that already left, waiting for its receipt
 *   forecast   billed + pending + committed
 *
 * Built from JobTread (one job at a time, so no query is big enough for
 * JobTread's 413) plus the charges in D1 (./_spend.js). Kept in D1
 * job_ledger, one row per job, so the admin reads it instantly. A Mercury
 * charge or a new bill rebuilds just its job within seconds; the heartbeat
 * rebuilds every active job every 15 minutes in case anything slipped by.
 *
 * Crossing 80% and 100% of a job's budget, or a cost code going over its
 * own budget line, posts once to Slack (threaded per job). See thresholds().
 */

import { pave, SOARD_ORG_ID, FIELD_JOB_STATUS, isRehearsalJob } from './_reveals.js';
import { vendorKey, dollars } from './_spend-match.js';

export const UNCODED = 'uncoded';
const DOC_PAGE = 20;      // documents per page; each with up to DOC_LINES lines (JobTread sizes the worst case)
const DOC_LINES = 25;
const BUDGET_PAGE = 100;
const CODE_OVER_MIN_CENTS = 10000; // a cost code over its line by less than $100 isn't worth a post

export const LEDGER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS job_ledger (
    job_id TEXT PRIMARY KEY, name TEXT, status TEXT, data TEXT NOT NULL, alerted TEXT, updated_at TEXT)`,
];

// ─── The math ───────────────────────────────────────────────────────

const cents = (n) => Math.round(Number(n || 0) * 100);

/**
 * The ledger for one job.
 *  budget:   [{ costCodeId, cents }]
 *  docs:     [{ id, type: 'vendorBill'|'vendorOrder', status, vendor, cents, lines: [{ costCodeId, cents }] }]
 *  pending:  [{ id, cents, costCodeId|null }]  (charges on this job with no bill)
 * → { rows: [{ codeId, budget, committed, billed, pending, forecast }], totals }
 */
export function computeLedger({ budget = [], docs = [], pending = [] }) {
  const rows = new Map();
  const row = (codeId) => {
    const k = codeId || UNCODED;
    if (!rows.has(k)) rows.set(k, { codeId: k, budget: 0, committed: 0, billed: 0, pending: 0 });
    return rows.get(k);
  };
  for (const b of budget) row(b.costCodeId).budget += b.cents;

  // What each vendor has billed and ordered on each code: an order's open part is what's still to come
  const billedBy = new Map();
  const orderedBy = new Map();
  for (const d of docs) {
    if (d.status === 'denied') continue;
    const bill = d.type === 'vendorBill';
    if (!bill && !(d.type === 'vendorOrder' && d.status === 'approved')) continue;
    const lines = d.lines?.length ? [...d.lines] : [];
    // Lines past the page (or a bill with none) still count, uncoded
    const rest = d.cents - lines.reduce((n, l) => n + l.cents, 0);
    if (Math.abs(rest) > 0) lines.push({ costCodeId: null, cents: rest });
    for (const l of lines) {
      const key = `${vendorKey(d.vendor)}|${l.costCodeId || UNCODED}`;
      const into = bill ? billedBy : orderedBy;
      into.set(key, (into.get(key) || 0) + l.cents);
      if (bill) row(l.costCodeId).billed += l.cents;
    }
  }
  for (const [key, ordered] of orderedBy) {
    const open = Math.max(0, ordered - (billedBy.get(key) || 0));
    if (open) row(key.split('|')[1]).committed += open;
  }
  for (const p of pending) row(p.costCodeId).pending += p.cents;

  const list = [...rows.values()]
    .map((r) => ({ ...r, forecast: r.billed + r.pending + r.committed }))
    .filter((r) => r.budget || r.committed || r.billed || r.pending)
    .sort((a, b) => (a.codeId === UNCODED) - (b.codeId === UNCODED) || String(a.codeId).localeCompare(String(b.codeId)));
  const totals = list.reduce((t, r) => {
    for (const k of ['budget', 'committed', 'billed', 'pending', 'forecast']) t[k] += r[k];
    return t;
  }, { budget: 0, committed: 0, billed: 0, pending: 0, forecast: 0 });
  return { rows: list, totals };
}

/**
 * What's worth saying in Slack, given what was said before.
 * alerted: { job: 80|100, codes: { codeId: true } } → { posts: [{ key, level, title, lead }], alerted }
 */
export function thresholds(ledger, alerted = {}, { name = 'This job', codeName = (id) => id } = {}) {
  const posts = [];
  const next = { job: alerted.job || 0, codes: { ...(alerted.codes || {}) } };
  const t = ledger.totals;
  if (t.budget > 0) {
    const share = t.forecast / t.budget;
    const level = share >= 1 ? 100 : share >= 0.8 ? 80 : 0;
    if (level > next.job) {
      posts.push({
        key: 'job', level,
        title: level === 100 ? `${name} is over budget` : `${name} is at ${Math.floor(share * 100)}% of its budget`,
        lead: `Forecast ${dollars(t.forecast)} against a budget of ${dollars(t.budget)}: ${dollars(t.billed)} billed, ${dollars(t.pending)} spent waiting for receipts, ${dollars(t.committed)} still to come on approved orders.`,
      });
      next.job = level;
    } else if (level < next.job && share < 0.75) {
      next.job = 0; // back under (a budget raised): a new crossing posts again
    }
  }
  for (const r of ledger.rows) {
    if (r.codeId === UNCODED || r.budget <= 0) continue;
    const over = r.forecast - r.budget;
    const isOver = over > CODE_OVER_MIN_CENTS && over > r.budget * 0.1;
    if (isOver && !next.codes[r.codeId]) {
      posts.push({ key: `code:${r.codeId}`, level: 'code', title: `${name}: ${codeName(r.codeId)} is over its budget line`, lead: `Forecast ${dollars(r.forecast)} against ${dollars(r.budget)} budgeted (${dollars(over)} over).` });
      next.codes[r.codeId] = true;
    } else if (!isOver && next.codes[r.codeId] && over < 0) {
      delete next.codes[r.codeId];
    }
  }
  return { posts, alerted: next };
}

// ─── JobTread ───────────────────────────────────────────────────────

let _codes = null; // { at, list }

/** The organization's cost codes: [{ id, name, number }] (cached ten minutes) */
export async function costCodes(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (_codes && now - _codes.at < 10 * 60 * 1000) return _codes.list;
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    organization: { $: { id: SOARD_ORG_ID }, costCodes: { $: { size: 100 }, nodes: { id: {}, name: {}, number: {} } } },
  }, fetchImpl);
  const list = (data?.organization?.costCodes?.nodes || [])
    .map((c) => ({ id: c.id, name: String(c.name || '').trim(), number: c.number || null }))
    .sort((a, b) => String(a.number || a.name).localeCompare(String(b.number || b.name), undefined, { numeric: true }));
  _codes = { at: now, list };
  return list;
}

/**
 * Open jobs that are buying or about to: { id, name, status, address, staff: [emails] }.
 * Staff = internal members with access to the job (the cardholder signal).
 */
export async function activeJobs(env, { fetchImpl = fetch } = {}) {
  const out = [];
  let page = null;
  for (let i = 0; i < 40; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        jobs: {
          // 10 a page: JobTread sizes the worst case, and 25 jobs × 20 people each is refused (413)
          $: { size: 10, where: ['closedOn', '=', null], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, name: {}, number: {}, createdAt: {},
            location: { address: {} },
            customFieldValues: { $: { size: 5, where: [['customField', 'id'], '=', FIELD_JOB_STATUS] }, nodes: { value: {} } },
            aces: { $: { size: 20 }, nodes: { membership: { isInternal: {}, user: { emailAddress: {} } } } },
          },
        },
      },
    }, fetchImpl);
    const conn = data?.organization?.jobs;
    for (const j of conn?.nodes || []) {
      if (isRehearsalJob(j)) continue;
      out.push({
        id: j.id, name: j.name, number: j.number || null, createdAt: j.createdAt || null,
        status: j.customFieldValues?.nodes?.[0]?.value || null,
        address: j.location?.address || null,
        staff: (j.aces?.nodes || []).map((a) => a.membership).filter((m) => m?.isInternal && m.user?.emailAddress).map((m) => m.user.emailAddress.toLowerCase()),
      });
    }
    page = conn?.nextPage;
    if (!page) break;
  }
  return out;
}

/** One job's budget lines and vendor documents, paged small enough for JobTread */
export async function jobCostSources(env, jobId, { fetchImpl = fetch } = {}) {
  const budget = [];
  let page = null;
  for (let i = 0; i < 20; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      job: {
        $: { id: jobId },
        costItems: {
          $: { size: BUDGET_PAGE, where: [['document', 'id'], '=', null], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: { cost: {}, costCode: { id: {} } },
        },
      },
    }, fetchImpl);
    const conn = data?.job?.costItems;
    for (const c of conn?.nodes || []) budget.push({ costCodeId: c.costCode?.id || null, cents: cents(c.cost) });
    page = conn?.nextPage;
    if (!page) break;
  }

  const docs = [];
  page = null;
  for (let i = 0; i < 30; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      job: {
        $: { id: jobId },
        documents: {
          $: { size: DOC_PAGE, where: ['type', 'in', ['vendorBill', 'vendorOrder']], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, type: {}, status: {}, cost: {}, issueDate: {}, createdAt: {}, number: {},
            account: { name: {} },
            costItems: { $: { size: DOC_LINES }, nodes: { id: {}, name: {}, cost: {}, costCode: { id: {} } } },
          },
        },
      },
    }, fetchImpl);
    const conn = data?.job?.documents;
    for (const d of conn?.nodes || []) {
      docs.push({
        id: d.id, type: d.type, status: d.status, number: d.number || null,
        vendor: d.account?.name || '', cents: cents(d.cost),
        date: d.issueDate || d.createdAt || null, createdAt: d.createdAt || null,
        lines: (d.costItems?.nodes || []).map((c) => ({ id: c.id, name: c.name, costCodeId: c.costCode?.id || null, cents: cents(c.cost) })),
      });
    }
    page = conn?.nextPage;
    if (!page) break;
  }
  return { budget, docs };
}

// ─── D1 ─────────────────────────────────────────────────────────────

const _ready = new WeakSet();
export async function ensureLedgerSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(LEDGER_SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

export async function readLedgers(DB) {
  await ensureLedgerSchema(DB);
  const rows = await DB.prepare('SELECT job_id, name, status, data, alerted, updated_at FROM job_ledger ORDER BY name').all();
  return (rows.results || []).map((r) => {
    let data = {};
    let alerted = {};
    try { data = JSON.parse(r.data) || {}; } catch { /* blank */ }
    try { alerted = JSON.parse(r.alerted || '{}') || {}; } catch { /* blank */ }
    return { jobId: r.job_id, name: r.name, status: r.status, ...data, alerted, updatedAt: r.updated_at };
  });
}

export async function writeLedger(DB, job, ledger, alerted, now = Date.now()) {
  await ensureLedgerSchema(DB);
  await DB.prepare('INSERT OR REPLACE INTO job_ledger (job_id, name, status, data, alerted, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(job.id, job.name, job.status || null, JSON.stringify(ledger), JSON.stringify(alerted || {}), new Date(now).toISOString()).run();
}

/** Jobs that closed or left the list: their rows go, so the admin shows open jobs only */
export async function dropLedgersExcept(DB, jobIds) {
  await ensureLedgerSchema(DB);
  const keep = new Set(jobIds);
  const rows = await DB.prepare('SELECT job_id FROM job_ledger').all();
  const gone = (rows.results || []).map((r) => r.job_id).filter((id) => !keep.has(id));
  for (const id of gone) await DB.prepare('DELETE FROM job_ledger WHERE job_id = ?').bind(id).run();
  return gone.length;
}
