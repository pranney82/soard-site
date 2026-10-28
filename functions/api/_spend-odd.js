/**
 * Odd charges
 * ===========================================================================
 * Things worth a second look, each said once in the Finance channel and
 * listed in Job Costs → Charges → Odd until someone says it's fine:
 *
 *   duplicate     the same vendor and amount twice within a day
 *   outlier       far more than this vendor usually charges (3× its median, $300+ more)
 *   subscription  a vendor that started charging about monthly
 *   category      a merchant type a charity card shouldn't see (bars, gambling, political)
 *
 * Refunds are fixed rather than flagged: a refund that nobody placed goes
 * back on the job (and cost code) of the vendor's charge it most likely
 * refunds, so the job's spending comes down by itself.
 */

import { slackIssue, slackResolved, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { vendorKey, dollars, LIVE_STATUSES } from './_spend-match.js';

const DAY = 86400e3;
const LOOK_BACK_DAYS = 120;
const RISKY = new Set(['AlcoholAndBars', 'Gambling', 'Political']);
const ADMIN = `${SITE_ORIGIN}/admin/#job-costs/charges`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spend_odd (
    key TEXT PRIMARY KEY, kind TEXT NOT NULL, charge_ids TEXT NOT NULL, vendor TEXT, cents INTEGER, detail TEXT,
    found_at TEXT, cleared_by TEXT, cleared_at TEXT)`,
];
const _ready = new WeakSet();
async function ensure(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * What's odd in a list of charges ({ id, vendor, cents, status, createdAt,
 * category }) → [{ key, kind, chargeIds, vendor, cents, detail }]. Pure.
 */
export function findOdd(charges, { now = Date.now() } = {}) {
  const live = charges.filter((c) => LIVE_STATUSES.has(c.status) && c.cents > 0)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const byVendor = new Map();
  for (const c of live) {
    const k = vendorKey(c.vendor) || c.vendor;
    if (!byVendor.has(k)) byVendor.set(k, []);
    byVendor.get(k).push(c);
  }
  const out = [];
  for (const [k, list] of byVendor) {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const t = Date.parse(c.createdAt);
      // Twice, same amount, within a day
      const twin = list.slice(i + 1).find((d) => d.cents === c.cents && Date.parse(d.createdAt) - t < DAY);
      if (twin) out.push({ key: `duplicate:${c.id}:${twin.id}`, kind: 'duplicate', chargeIds: [c.id, twin.id], vendor: c.vendor, cents: c.cents, detail: `${dollars(c.cents)} twice within a day` });
      // Far over this vendor's usual, with enough history to know the usual
      const prior = list.slice(0, i).map((p) => p.cents);
      if (prior.length >= 3) {
        const usual = median(prior);
        if (c.cents >= usual * 3 && c.cents - usual >= 30000) out.push({ key: `outlier:${c.id}`, kind: 'outlier', chargeIds: [c.id], vendor: c.vendor, cents: c.cents, detail: `Usually about ${dollars(usual)}` });
      }
      if (c.category && RISKY.has(c.category)) out.push({ key: `category:${c.id}`, kind: 'category', chargeIds: [c.id], vendor: c.vendor, cents: c.cents, detail: `Mercury calls this merchant ${c.category.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}` });
    }
    // Started charging about monthly: the last three charges 25-35 days apart, the first of them recent
    if (list.length >= 2) {
      const last = list.slice(-3);
      const gaps = last.slice(1).map((c, j) => (Date.parse(c.createdAt) - Date.parse(last[j].createdAt)) / DAY);
      const monthly = gaps.length && gaps.every((g) => g >= 25 && g <= 35);
      const fresh = now - Date.parse(list[0].createdAt) < 75 * DAY;
      if (monthly && fresh) out.push({ key: `subscription:${k}`, kind: 'subscription', chargeIds: last.map((c) => c.id), vendor: list[0].vendor, cents: last.at(-1).cents, detail: `${dollars(last.at(-1).cents)} about every month since ${String(list[0].createdAt).slice(0, 10)}` });
    }
  }
  return out;
}

/**
 * The charge a refund most likely gives back: the same vendor, at least as
 * much, before it, the latest such. Pure. → charge or null
 */
export function refundTarget(refund, charges) {
  const k = vendorKey(refund.vendor);
  const t = Date.parse(refund.createdAt);
  return charges
    .filter((c) => c.cents >= -refund.cents && c.id !== refund.id && vendorKey(c.vendor) === k && Date.parse(c.createdAt) <= t && t - Date.parse(c.createdAt) < 90 * DAY && c.bucket)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
}

const TITLES = {
  duplicate: (o) => `Charged twice? ${o.vendor}`,
  outlier: (o) => `Bigger than usual: ${o.vendor} ${dollars(o.cents)}`,
  subscription: (o) => `New monthly charge: ${o.vendor}`,
  category: (o) => `A charge to check: ${o.vendor}`,
};

/** Look, post what's new, place refunds. → { found, posted, refunds, jobs: [touched job ids] } */
export async function checkOdd(env, { now = Date.now() } = {}) {
  await ensure(env.DB);
  const since = new Date(now - LOOK_BACK_DAYS * DAY).toISOString();
  const rows = (await env.DB.prepare(`SELECT c.*, t.mercury_category FROM spend_charges c LEFT JOIN mercury_txns t ON t.id = c.id WHERE c.created_at >= ?`).bind(since).all()).results || [];
  const charges = rows.map((r) => ({
    id: r.id, vendor: r.vendor, cents: r.cents, status: r.status, createdAt: r.created_at, category: r.mercury_category,
    bucket: r.bucket, jobId: r.job_id, jobHow: r.job_how, costCodeId: r.code_id,
  }));
  const jobs = new Set();
  let refunds = 0;
  // Refunds nobody placed go where the money went
  for (const r of charges.filter((c) => c.cents < 0 && LIVE_STATUSES.has(c.status) && c.jobHow !== 'staff' && c.jobHow !== 'refund')) {
    const target = refundTarget(r, charges);
    if (!target || (r.bucket === target.bucket && r.jobId === target.jobId)) continue;
    await env.DB.prepare("UPDATE spend_charges SET bucket = ?, job_id = ?, job_how = 'refund', code_id = ?, code_how = CASE WHEN ? IS NULL THEN NULL ELSE 'refund' END, note_at = NULL, updated_at = ? WHERE id = ?")
      .bind(target.bucket, target.jobId || null, target.costCodeId || null, target.costCodeId || null, new Date(now).toISOString(), r.id).run();
    [r.jobId, target.jobId].filter(Boolean).forEach((j) => jobs.add(j));
    refunds++;
  }
  const found = findOdd(charges, { now });
  const known = new Set(((await env.DB.prepare('SELECT key FROM spend_odd').all()).results || []).map((r) => r.key));
  let posted = 0;
  for (const o of found) {
    if (known.has(o.key)) continue;
    await env.DB.prepare('INSERT OR IGNORE INTO spend_odd (key, kind, charge_ids, vendor, cents, detail, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(o.key, o.kind, JSON.stringify(o.chargeIds), o.vendor, o.cents, o.detail, new Date(now).toISOString()).run();
    const r = await slackIssue(env, `odd:${o.key}`, slackCard({
      icon: o.kind === 'category' ? '🔎' : o.kind === 'subscription' ? '🔁' : '👀',
      title: TITLES[o.kind](o), lead: `${o.detail}. If it’s fine, say so in Job Costs and it won’t come up again.`,
      buttons: [{ label: 'Open odd charges', url: `${ADMIN}?odd=1` }],
    }), { title: TITLES[o.kind](o), kind: 'attention', area: 'finance' }).catch(() => null);
    if (r?.ok) posted++;
  }
  return { found: found.length, posted, refunds, jobs: [...jobs] };
}

export async function readOdd(DB) {
  await ensure(DB);
  const rows = (await DB.prepare('SELECT * FROM spend_odd WHERE cleared_at IS NULL ORDER BY found_at DESC LIMIT 200').all()).results || [];
  return rows.map((r) => ({ key: r.key, kind: r.kind, chargeIds: JSON.parse(r.charge_ids || '[]'), vendor: r.vendor, cents: r.cents, detail: r.detail, foundAt: r.found_at }));
}

/** A person looked: it's fine. The Slack post turns ✅. */
export async function clearOdd(env, key, { by = null } = {}) {
  await ensure(env.DB);
  const row = await env.DB.prepare('SELECT * FROM spend_odd WHERE key = ?').bind(key).first();
  if (!row) throw new Error('That isn’t on the list');
  await env.DB.prepare('UPDATE spend_odd SET cleared_by = ?, cleared_at = ? WHERE key = ?').bind(by, new Date().toISOString(), key).run();
  await slackResolved(env, `odd:${key}`, slackCard({ icon: '✅', title: `${row.vendor}: checked`, lead: `${by || 'Someone'} looked and it’s fine.` }), { summary: `Checked by ${by || 'staff'}` }).catch(() => null);
}
