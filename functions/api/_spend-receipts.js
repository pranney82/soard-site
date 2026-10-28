/**
 * Receipts, both ways
 * ===========================================================================
 * Mercury → the Receipt Processor: after a swipe, Mercury's app asks the
 * cardholder for a photo of the receipt. When a makeover charge has that
 * photo and no JobTread bill yet, the site emails the photo to the receipt
 * inbox (ap@, which forwards to the DataX Receipt Processor), with the job
 * and charge in the subject. Nobody has to email anything.
 *
 * JobTread → Mercury: when a card charge is paired with a JobTread bill and
 * Mercury has no receipt on it (it came to ap@ by email), the bill's file is
 * uploaded to the Mercury transaction, so Mercury Books sees a receipt on
 * every charge and nobody gets Mercury's "missing receipt" nudges.
 *
 * Each charge is handled once either way (spend_receipts). Mercury's file
 * links last 12 hours, so the transaction is read again right before.
 */

import { pave } from './_reveals.js';
import { EMAIL_FROM, emailConfigured } from './_broadcast-notify.js';
import { getTransaction, mercury, mercuryConfigured } from './_mercury.js';
import { readConfig } from './_spend.js';
import { dollars } from './_spend-match.js';

export const DEFAULT_RECEIPT_INBOX = 'ap@soardcharity.com';
const PER_RUN = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const LOOK_BACK_DAYS = 30;

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

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function download(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`file answered ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('file over 10 MB');
  return { buf, type: res.headers.get('content-type') || 'application/octet-stream' };
}

/** The email's subject: what the Receipt Processor reads first (job name, then the facts) */
export function receiptSubject(c, jobName) {
  const day = String(c.createdAt || '').slice(0, 10);
  return `Receipt${jobName ? ` for ${jobName}` : ''}: ${c.vendor} ${dollars(c.cents)} on ${day} (Mercury charge ${c.id})`;
}

/** Photos from Mercury's app → the receipt inbox. → { sent, failed } */
export async function forwardMercuryReceipts(env, { jobs = [], now = Date.now(), fetchImpl = fetch } = {}) {
  await ensure(env.DB);
  const out = { sent: 0, failed: 0 };
  if (!emailConfigured(env)) return out;
  const cfg = await readConfig(env.DB);
  const inbox = cfg.receiptInbox || DEFAULT_RECEIPT_INBOX;
  const rows = (await env.DB.prepare(`SELECT c.id, c.vendor, c.cents, c.created_at, c.job_id, c.email FROM spend_charges c
      JOIN mercury_txns t ON t.id = c.id
      LEFT JOIN spend_receipts r ON r.charge_id = c.id AND r.way = 'to-ap'
      WHERE c.bucket = 'job' AND c.bill_id IS NULL AND c.status IN ('pending', 'sent') AND c.created_at >= ?
        AND t.attachments LIKE '%"receipt"%' AND r.charge_id IS NULL
      ORDER BY c.created_at LIMIT ?`).bind(new Date(now - LOOK_BACK_DAYS * 86400e3).toISOString(), PER_RUN).all()).results || [];
  for (const r of rows) {
    const c = { id: r.id, vendor: r.vendor, cents: r.cents, createdAt: r.created_at };
    try {
      const txn = await getTransaction(env, r.id, { fetchImpl });
      const files = (txn?.attachments || []).filter((a) => a.attachmentType === 'receipt' && a.url).slice(0, 3);
      if (!files.length) { await keep(env.DB, r.id, 'to-ap', 'none'); continue; }
      const attachments = [];
      for (const f of files) {
        const { buf } = await download(f.url, fetchImpl);
        attachments.push({ filename: f.fileName || 'receipt.jpg', content: toBase64(buf) });
      }
      const jobName = jobs.find((j) => j.id === r.job_id)?.name || null;
      const text = [
        `A receipt photo added in Mercury's app.`,
        `Vendor: ${r.vendor}`, `Amount: ${dollars(r.cents)}`, `Date: ${String(r.created_at).slice(0, 10)}`,
        `Job: ${jobName || 'not placed yet'}`, `Mercury charge: ${r.id}`,
      ].join('\n');
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: EMAIL_FROM, to: [inbox], subject: receiptSubject(c, jobName), text, attachments, tags: [{ name: 'kind', value: 'receipt-forward' }] }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 120)}`);
      await keep(env.DB, r.id, 'to-ap', 'sent', inbox);
      out.sent++;
    } catch (e) {
      await keep(env.DB, r.id, 'to-ap', 'failed', e.message);
      out.failed++;
    }
  }
  return out;
}

/** A bill's first receipt-looking file in JobTread → { name, url } or null */
async function billFile(env, billId, fetchImpl) {
  const d = await pave(env.JOBTREAD_GRANT_KEY, { document: { $: { id: billId }, files: { $: { size: 10 }, nodes: { id: {}, name: {}, url: {}, type: {} } } } }, fetchImpl);
  const files = d?.document?.files?.nodes || [];
  return files.find((f) => /pdf|image/i.test(f.type || '') || /\.(pdf|png|jpe?g|gif|heic)$/i.test(f.name || '')) || null;
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
      const form = new FormData();
      form.append('file', new Blob([buf], { type }), String(f.name || 'receipt.pdf').slice(0, 200));
      form.append('attachmentType', 'receipt');
      await mercury(env, `/transaction/${encodeURIComponent(r.id)}/attachments`, { method: 'POST', body: form, fetchImpl });
      await keep(env.DB, r.id, 'to-mercury', 'sent', f.name);
      out.uploaded++;
    } catch (e) {
      await keep(env.DB, r.id, 'to-mercury', 'failed', e.message);
      out.failed++;
    }
  }
  return out;
}

/** The heartbeat part. Never throws. */
export async function maybeRunReceipts(env, { jobs = [], now = Date.now() } = {}) {
  if (!env.DB || !mercuryConfigured(env)) return null;
  const [toAp, toMercury] = await Promise.all([
    forwardMercuryReceipts(env, { jobs, now }).catch((e) => ({ error: e.message })),
    env.JOBTREAD_GRANT_KEY ? uploadBillReceipts(env, { now }).catch((e) => ({ error: e.message })) : null,
  ]);
  return { toAp, toMercury };
}
