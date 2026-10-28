/**
 * Recoding the Ramp-era bills (Admin → Job Costs → Ramp bills)
 * ===========================================================================
 * Ramp wrote every bill as one line, "Makeover COGS", under 01 DESIGN &
 * ENGINEERING. Those bills get real cost codes:
 *
 *  1. find: every SOARD vendor bill since August 1 that is still one line
 *     under 01 DESIGN & ENGINEERING. Each is kept with a copy of its line as
 *     it is now (D1 spend_recode, state 'waiting').
 *  2. propose: the DataX Receipt Processor, in recode mode, reads each
 *     bill's attached receipt and sends the split by cost code
 *     (POST /api/spend-recode). The lines must add up to the bill, to the cent.
 *     A vendor rule (TKO → PLUMBING) proposes on its own, no receipt needed.
 *  3. apply: only when a person presses Apply in the admin. The first line
 *     takes the first code and amount; each other code becomes a new line on
 *     the same bill. The bill's total doesn't change, so its payment doesn't.
 *  4. undo: the line goes back to exactly what it was; the added lines go.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import { ruleFor } from './_spend-match.js';

export const RAMP_CODE_ID = '22P3ueZ4K5Pt'; // 01 DESIGN & ENGINEERING
export const RAMP_SINCE = '2026-08-01';

const SCHEMA = `CREATE TABLE IF NOT EXISTS spend_recode (
  bill_id TEXT PRIMARY KEY, job_id TEXT, job_name TEXT, vendor TEXT, cents INTEGER, date TEXT, before TEXT NOT NULL,
  proposal TEXT, proposed_by TEXT, state TEXT NOT NULL, added TEXT, error TEXT, updated_at TEXT, by TEXT)`;
const _ready = new WeakSet();
async function ensure(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  _ready.add(DB);
}

const cents = (n) => Math.round(Number(n || 0) * 100);

const rowOf = (r) => ({
  billId: r.bill_id, jobId: r.job_id, jobName: r.job_name, vendor: r.vendor, cents: r.cents, date: r.date,
  before: JSON.parse(r.before || 'null'), proposal: r.proposal ? JSON.parse(r.proposal) : null, proposedBy: r.proposed_by,
  state: r.state, error: r.error, updatedAt: r.updated_at, by: r.by,
});

export async function readRecode(DB) {
  await ensure(DB);
  const r = await DB.prepare('SELECT * FROM spend_recode ORDER BY date DESC').all();
  return (r.results || []).map(rowOf);
}

/** Step 1 (and again on each heartbeat rebuild, to catch new ones): → how many are new */
export async function findRampBills(env, { rules = [], fetchImpl = fetch } = {}) {
  await ensure(env.DB);
  let page = null;
  let added = 0;
  for (let i = 0; i < 20; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        documents: {
          $: { size: 25, where: { and: [['type', '=', 'vendorBill'], ['createdAt', '>=', RAMP_SINCE]] }, ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, cost: {}, issueDate: {}, createdAt: {}, status: {},
            account: { name: {} }, job: { id: {}, name: {} },
            costItems: { $: { size: 3 }, nodes: { id: {}, name: {}, quantity: {}, unitCost: {}, unitPrice: {}, cost: {}, costCode: { id: {} } } },
          },
        },
      },
    }, fetchImpl);
    const conn = data?.organization?.documents;
    for (const d of conn?.nodes || []) {
      const lines = d.costItems?.nodes || [];
      if (d.status === 'denied' || lines.length !== 1 || lines[0].costCode?.id !== RAMP_CODE_ID) continue;
      const l = lines[0];
      const before = { id: l.id, name: l.name, quantity: l.quantity, unitCost: l.unitCost, unitPrice: l.unitPrice, costCodeId: RAMP_CODE_ID, cents: cents(l.cost) };
      const rule = ruleFor(d.account?.name, rules);
      const proposal = rule?.kind === 'code' ? [{ costCodeId: rule.costCodeId, cents: cents(d.cost), name: l.name }] : null;
      const ins = await env.DB.prepare(`INSERT OR IGNORE INTO spend_recode (bill_id, job_id, job_name, vendor, cents, date, before, proposal, proposed_by, state, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(d.id, d.job?.id || null, d.job?.name || null, d.account?.name || '', cents(d.cost), d.issueDate || d.createdAt, JSON.stringify(before),
          proposal ? JSON.stringify(proposal) : null, proposal ? 'rule' : null, proposal ? 'proposed' : 'waiting', new Date().toISOString()).run();
      if (ins.meta?.changes) added++;
    }
    page = conn?.nextPage;
    if (!page) break;
  }
  return added;
}

/**
 * Step 2: a split for one bill. lines: [{ costCodeId, cents | amount, name? }]
 * → { ok } | { ok: false, error }
 */
export async function proposeSplit(DB, billId, lines, { by = 'datax', codes = [] } = {}) {
  await ensure(DB);
  const r = await DB.prepare('SELECT * FROM spend_recode WHERE bill_id = ?').bind(billId).first();
  if (!r) return { ok: false, error: 'not a Ramp bill waiting for codes' };
  if (r.state === 'applied') return { ok: false, error: 'already recoded; undo it first' };
  const known = new Set(codes.map((c) => c.id));
  const clean = (Array.isArray(lines) ? lines : []).map((l) => ({
    costCodeId: String(l.costCodeId || ''),
    cents: l.cents != null ? Math.round(Number(l.cents)) : cents(l.amount),
    name: String(l.name || '').trim().slice(0, 120) || null,
  })).filter((l) => l.costCodeId && l.cents);
  if (!clean.length) return { ok: false, error: 'no lines' };
  if (known.size && clean.some((l) => !known.has(l.costCodeId))) return { ok: false, error: 'a cost code isn’t one of SOARD’s' };
  // Merge lines on the same code: one line per code on the bill
  const merged = [...clean.reduce((m, l) => {
    const x = m.get(l.costCodeId) || { costCodeId: l.costCodeId, cents: 0, names: [] };
    x.cents += l.cents;
    if (l.name) x.names.push(l.name);
    return m.set(l.costCodeId, x);
  }, new Map()).values()].map((x) => ({ costCodeId: x.costCodeId, cents: x.cents, name: x.names.slice(0, 3).join(', ').slice(0, 120) || null }));
  const sum = merged.reduce((n, l) => n + l.cents, 0);
  if (Math.abs(sum - r.cents) > 1) return { ok: false, error: `lines add up to ${(sum / 100).toFixed(2)}, the bill is ${(r.cents / 100).toFixed(2)}` };
  // Pennies of rounding go on the biggest line
  merged.sort((a, b) => b.cents - a.cents);
  merged[0].cents += r.cents - sum;
  await DB.prepare("UPDATE spend_recode SET proposal = ?, proposed_by = ?, state = 'proposed', error = NULL, updated_at = ? WHERE bill_id = ?")
    .bind(JSON.stringify(merged), by, new Date().toISOString(), billId).run();
  return { ok: true };
}

/** Step 3: write the proposal to JobTread. → { ok, error? } */
export async function applySplit(env, billId, { by = null, fetchImpl = fetch } = {}) {
  await ensure(env.DB);
  const r = rowOf(await env.DB.prepare('SELECT * FROM spend_recode WHERE bill_id = ?').bind(billId).first() || {});
  if (!r.billId || r.state !== 'proposed' || !r.proposal?.length) return { ok: false, error: 'nothing proposed for that bill' };
  const [first, ...rest] = r.proposal;
  const added = [];
  try {
    await pave(env.JOBTREAD_GRANT_KEY, {
      updateCostItem: { $: { id: r.before.id, costCodeId: first.costCodeId, quantity: 1, unitCost: first.cents / 100, ...(first.name ? { name: first.name } : {}) } },
    }, fetchImpl);
    for (const l of rest) {
      const made = await pave(env.JOBTREAD_GRANT_KEY, {
        createCostItem: {
          $: { documentId: billId, name: l.name || r.before.name || 'Materials', costCodeId: l.costCodeId, quantity: 1, unitCost: l.cents / 100, unitPrice: l.cents / 100 },
          createdCostItem: { id: {} },
        },
      }, fetchImpl);
      const id = made?.createCostItem?.createdCostItem?.id;
      if (!id) throw new Error('JobTread made no line');
      added.push(id);
    }
    await env.DB.prepare("UPDATE spend_recode SET state = 'applied', added = ?, error = NULL, by = ?, updated_at = ? WHERE bill_id = ?")
      .bind(JSON.stringify(added), by, new Date().toISOString(), billId).run();
    return { ok: true };
  } catch (e) {
    // Leave the bill as it was: put the line back and take off what was added
    await restore(env, r.before, added, fetchImpl).catch(() => {});
    await env.DB.prepare('UPDATE spend_recode SET error = ?, updated_at = ? WHERE bill_id = ?').bind(String(e.message).slice(0, 300), new Date().toISOString(), billId).run();
    return { ok: false, error: e.message };
  }
}

async function restore(env, before, added, fetchImpl) {
  await pave(env.JOBTREAD_GRANT_KEY, {
    updateCostItem: { $: { id: before.id, costCodeId: before.costCodeId, name: before.name, quantity: before.quantity, unitCost: before.unitCost } },
  }, fetchImpl);
  for (const id of added) await pave(env.JOBTREAD_GRANT_KEY, { deleteCostItem: { $: { id } } }, fetchImpl);
}

/** Step 4 */
export async function undoSplit(env, billId, { by = null, fetchImpl = fetch } = {}) {
  await ensure(env.DB);
  const raw = await env.DB.prepare('SELECT * FROM spend_recode WHERE bill_id = ?').bind(billId).first();
  if (!raw || raw.state !== 'applied') return { ok: false, error: 'that bill wasn’t recoded' };
  try {
    await restore(env, JSON.parse(raw.before), JSON.parse(raw.added || '[]'), fetchImpl);
    await env.DB.prepare("UPDATE spend_recode SET state = 'proposed', added = NULL, error = NULL, by = ?, updated_at = ? WHERE bill_id = ?").bind(by, new Date().toISOString(), billId).run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
