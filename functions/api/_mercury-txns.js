/**
 * Every Mercury transaction, kept as Mercury sent it (money in and out)
 * ===========================================================================
 * Job Costs keeps only spending (spend_charges). The P&L, the cash forecast,
 * the month-end close and the vendors' 1099 totals need everything: gifts
 * arriving, store payouts, payments to subs, transfers. This is that copy,
 * one row per transaction, refreshed every time Mercury sends it again.
 *
 * cents is signed the way Mercury signs amount: money in > 0, money out < 0.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mercury_txns (
    id TEXT PRIMARY KEY, account_id TEXT, kind TEXT, status TEXT, cents INTEGER NOT NULL,
    counterparty TEXT, counterparty_id TEXT, card_id TEXT, created_at TEXT, posted_at TEXT,
    mercury_category TEXT, category_id TEXT, category_name TEXT, note TEXT, bank_description TEXT,
    accounting_status TEXT, gl TEXT, attachments TEXT, check_number TEXT, link TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS mercury_txns_posted ON mercury_txns (posted_at)',
  'CREATE INDEX IF NOT EXISTS mercury_txns_created ON mercury_txns (created_at)',
  'CREATE INDEX IF NOT EXISTS mercury_txns_counterparty ON mercury_txns (counterparty_id)',
];

const _ready = new WeakSet();
export async function ensureTxnSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

const toCents = (amount) => Math.round(Number(amount || 0) * 100);

/** One Mercury transaction → the row kept (or null when it has no id) */
export function txnRow(t, now = Date.now()) {
  if (!t?.id) return null;
  return {
    id: String(t.id),
    account_id: t.accountId || null,
    kind: t.kind || null,
    status: t.status || null,
    cents: toCents(t.amount),
    counterparty: String(t.counterpartyNickname || t.counterpartyName || t.bankDescription || '').slice(0, 160) || null,
    counterparty_id: t.counterpartyId || null,
    card_id: t.cardId || t.details?.creditCardInfo?.id || t.details?.debitCardInfo?.id || null,
    created_at: t.createdAt || null,
    posted_at: t.postedAt || null,
    mercury_category: t.mercuryCategory || null,
    category_id: t.categoryData?.id || null,
    category_name: t.categoryData?.name || null,
    note: t.note || null,
    bank_description: t.bankDescription || null,
    accounting_status: t.accountingStatus?.status || null,
    gl: Array.isArray(t.glAllocations) && t.glAllocations.length ? JSON.stringify(t.glAllocations) : null,
    // The receipt photos people add in Mercury's app, and check images (urls expire: fetch the transaction again to read one)
    attachments: Array.isArray(t.attachments) && t.attachments.length
      ? JSON.stringify(t.attachments.map((a) => ({ fileName: a.fileName || null, type: a.attachmentType || null })))
      : null,
    check_number: t.checkNumber || null,
    link: t.dashboardLink || null,
    updated_at: new Date(now).toISOString(),
  };
}

const COLS = ['id', 'account_id', 'kind', 'status', 'cents', 'counterparty', 'counterparty_id', 'card_id', 'created_at', 'posted_at',
  'mercury_category', 'category_id', 'category_name', 'note', 'bank_description', 'accounting_status', 'gl', 'attachments', 'check_number', 'link', 'updated_at'];

/** Keep one transaction as Mercury sent it */
export async function mirrorTransaction(DB, t, { now = Date.now() } = {}) {
  const row = txnRow(t, now);
  if (!row) return null;
  await ensureTxnSchema(DB);
  await DB.prepare(`INSERT OR REPLACE INTO mercury_txns (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`)
    .bind(...COLS.map((c) => row[c])).run();
  return row;
}

/** Rows between two dates (by posted date, else created) → [row] with attachments/gl parsed */
export async function readTxns(DB, { from = null, to = null, kinds = null, counterpartyId = null, limit = 20000 } = {}) {
  await ensureTxnSchema(DB);
  const where = [];
  const args = [];
  if (from) { where.push('COALESCE(posted_at, created_at) >= ?'); args.push(from); }
  if (to) { where.push('COALESCE(posted_at, created_at) < ?'); args.push(to); }
  if (kinds?.length) { where.push(`kind IN (${kinds.map(() => '?').join(', ')})`); args.push(...kinds); }
  if (counterpartyId) { where.push('counterparty_id = ?'); args.push(counterpartyId); }
  const sql = `SELECT * FROM mercury_txns ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(posted_at, created_at) LIMIT ?`;
  const rows = (await DB.prepare(sql).bind(...args, limit).all()).results || [];
  const parse = (s) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
  return rows.map((r) => ({ ...r, attachments: parse(r.attachments), gl: parse(r.gl) }));
}
