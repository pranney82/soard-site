/**
 * What a monetary sponsor pledged toward a kid's makeover, and what's come in
 * ===========================================================================
 * Peter, Nov 4 2026: "yes i like the pledged thing too!" Entered on the kid's
 * Monetary sponsor card (Admin → Kids, /api/sponsors-admin), one row per kid
 * and sponsor. The board page's waiting families take it off what their
 * makeover is likely to cost (./_makeover-costs.js).
 *
 * D1 only (sponsor_pledges), never the kid record: kid records reach the
 * public repo, and what one sponsor gives is between SOARD and them.
 */

const SCHEMA = 'CREATE TABLE IF NOT EXISTS sponsor_pledges (kid TEXT NOT NULL, partner TEXT NOT NULL, pledged REAL, received REAL, updated_at TEXT NOT NULL, by TEXT, PRIMARY KEY (kid, partner))';
const ready = new WeakSet();
async function ensure(DB) {
  if (ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  ready.add(DB);
}

/** Whole dollars and cents, never below nothing or past $10M; '' or null is none */
export function cleanAmount(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw Object.assign(new Error('An amount is dollars, from $0 to $10,000,000'), { status: 400 });
  return Math.round(n * 100) / 100;
}

/** { [kid]: { [partner]: { pledged, received, updatedAt, by } } } for those kids (every kid without a list) */
export async function pledgesFor(DB, kids = null) {
  await ensure(DB);
  const list = kids ? [...new Set(kids)].filter(Boolean) : null;
  if (list && !list.length) return {};
  const sql = `SELECT kid, partner, pledged, received, updated_at, by FROM sponsor_pledges${list ? ` WHERE kid IN (${list.map(() => '?').join(',')})` : ''}`;
  const rows = (await DB.prepare(sql).bind(...(list || [])).all()).results || [];
  const out = {};
  for (const r of rows) (out[r.kid] ||= {})[r.partner] = { pledged: r.pledged ?? 0, received: r.received ?? 0, updatedAt: r.updated_at, by: r.by || null };
  return out;
}

/** One sponsor's amounts for one kid (both empty: the row goes) → the saved { pledged, received, updatedAt, by } or null */
export async function savePledge(DB, { kid, partner, pledged, received }, { by = null, now = Date.now() } = {}) {
  await ensure(DB);
  const p = cleanAmount(pledged);
  const r = cleanAmount(received);
  if (p == null && r == null) {
    await DB.prepare('DELETE FROM sponsor_pledges WHERE kid = ? AND partner = ?').bind(kid, partner).run();
    return null;
  }
  const at = new Date(now).toISOString();
  await DB.prepare(`INSERT INTO sponsor_pledges (kid, partner, pledged, received, updated_at, by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kid, partner) DO UPDATE SET pledged = excluded.pledged, received = excluded.received, updated_at = excluded.updated_at, by = excluded.by`)
    .bind(kid, partner, p ?? 0, r ?? 0, at, by).run();
  return { pledged: p ?? 0, received: r ?? 0, updatedAt: at, by };
}
