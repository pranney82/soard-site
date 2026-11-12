/**
 * Receipts onto Mercury's card charges
 * ===========================================================================
 * JobTread → Mercury: when a card charge is paired with a JobTread bill and
 * Mercury has no receipt on it, the bill's file is uploaded to the Mercury
 * transaction, so Mercury Books sees a receipt on every charge and nobody gets
 * Mercury's "missing receipt" nudges. The email sweep puts receipts it finds
 * on charges the same way (attachToCharge).
 *
 * Nothing here emails the receipt inbox (ap@). Mercury's receipt photos used to
 * be sent there for the DataX Receipt Processor, which never ran for SOARD, and
 * Ramp's bill inbox reads ap@ and makes a bill of whatever reaches it. Removed
 * Nov 12 2026 before it ever sent one.
 *
 * Each charge is handled once (spend_receipts). Mercury's file links last 12
 * hours, so the transaction is read again right before.
 */

import { pave } from './_reveals.js';
import { mercury, mercuryConfigured } from './_mercury.js';

export const DEFAULT_RECEIPT_INBOX = 'ap@soardcharity.com';
const PER_RUN = 5;
const MAX_BYTES = 10 * 1024 * 1024;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spend_receipts (
    charge_id TEXT NOT NULL, way TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, at TEXT, PRIMARY KEY (charge_id, way))`,
];
const _ready = new WeakSet();
async function ensure(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

const keep = (DB, chargeId, way, state, detail = null) => DB.prepare('INSERT OR REPLACE INTO spend_receipts (charge_id, way, state, detail, at) VALUES (?, ?, ?, ?, ?)')
  .bind(chargeId, way, state, detail ? String(detail).slice(0, 300) : null, new Date().toISOString()).run();

async function download(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`file answered ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('file over 10 MB');
  return { buf, type: res.headers.get('content-type') || 'application/octet-stream' };
}

/** A bill's first receipt-looking file in JobTread → { name, url } or null */
async function billFile(env, billId, fetchImpl) {
  const d = await pave(env.JOBTREAD_GRANT_KEY, { document: { $: { id: billId }, files: { $: { size: 10 }, nodes: { id: {}, name: {}, url: {}, type: {} } } } }, fetchImpl);
  const files = d?.document?.files?.nodes || [];
  return files.find((f) => /pdf|image/i.test(f.type || '') || /\.(pdf|png|jpe?g|gif|heic)$/i.test(f.name || '')) || null;
}

/** A receipt file onto a Mercury card charge, remembered so a bill's file doesn't follow it (the inbox sweep uses it too) */
export async function attachToCharge(env, chargeId, { bytes, type, name }, fetchImpl = fetch) {
  await ensure(env.DB);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: type || 'application/pdf' }), String(name || 'receipt.pdf').slice(0, 200));
  form.append('attachmentType', 'receipt');
  await mercury(env, `/transaction/${encodeURIComponent(chargeId)}/attachments`, { method: 'POST', body: form, fetchImpl });
  await keep(env.DB, chargeId, 'to-mercury', 'sent', name);
}

/** Bills' files → the card charges they paid, in Mercury. → { uploaded, failed } */
export async function uploadBillReceipts(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensure(env.DB);
  const out = { uploaded: 0, failed: 0 };
  const rows = (await env.DB.prepare(`SELECT c.id, c.bill_id FROM spend_charges c
      JOIN mercury_txns t ON t.id = c.id
      LEFT JOIN spend_receipts r ON r.charge_id = c.id AND r.way = 'to-mercury'
      WHERE c.bill_id IS NOT NULL AND c.kind LIKE '%Card%' AND c.created_at >= ?
        AND (t.attachments IS NULL OR t.attachments NOT LIKE '%"receipt"%') AND r.charge_id IS NULL
      ORDER BY c.created_at LIMIT ?`).bind(new Date(now - 60 * 86400e3).toISOString(), PER_RUN).all()).results || [];
  for (const r of rows) {
    try {
      const f = await billFile(env, r.bill_id, fetchImpl);
      if (!f?.url) { await keep(env.DB, r.id, 'to-mercury', 'none'); continue; }
      const { buf, type } = await download(f.url, fetchImpl);
      await attachToCharge(env, r.id, { bytes: buf, type, name: f.name }, fetchImpl);
      out.uploaded++;
    } catch (e) {
      await keep(env.DB, r.id, 'to-mercury', 'failed', e.message);
      out.failed++;
    }
  }
  return out;
}

/** The heartbeat part. Never throws. */
export async function maybeRunReceipts(env, { now = Date.now() } = {}) {
  if (!env.DB || !mercuryConfigured(env)) return null;
  const toMercury = env.JOBTREAD_GRANT_KEY ? await uploadBillReceipts(env, { now }).catch((e) => ({ error: e.message })) : null;
  return { toMercury };
}
