/**
 * Gifts during a reveal — Zeffy donations counted for the live page
 * =================================================================
 * Zeffy calls /api/zeffy-webhook for every completed payment. A gift made
 * while a reveal is on (from the starting-soon window to an hour after it
 * ends) is stored against that broadcast, and the live page shows the
 * running total: "$1,240 given during this reveal · 18 gifts". No names, no
 * amounts per person, no animated counter.
 *
 * Honest numbers: monthly gifts are left out, because a renewal that happens
 * to land during a reveal looks exactly like a new monthly gift, and the
 * total should never claim money nobody gave during the reveal. One-time
 * gifts only, each payment counted once however often Zeffy retries.
 *
 * Setup (once): Zeffy → Settings → Integrations → webhook to
 * https://sunshineonaranneyday.com/api/zeffy-webhook, event payment.completed;
 * its signing secret (whsec_…) goes in Admin → Broadcast → Settings, which
 * stores it as config.zeffy.webhookSecret. Until then nothing shows.
 */

import { relay } from './_live-messages.js';

const META_KEY = 'live-gifts';
/** Before the start (the starting-soon screen is up) and after the end (replay viewers give too) */
export const BEFORE_MS = 30 * 60 * 1000;
export const AFTER_MS = 60 * 60 * 1000;
/** Signatures older than this are refused, so a captured request can't be replayed later */
const TOLERANCE_S = 5 * 60;

export async function ensureGiftsSchema(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS live_gifts (
      id TEXT PRIMARY KEY, broadcast_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      currency TEXT, created_at TEXT NOT NULL, received_at TEXT NOT NULL)`),
    DB.prepare('CREATE INDEX IF NOT EXISTS live_gifts_broadcast ON live_gifts (broadcast_id)'),
  ]);
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
}
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Zeffy-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">.
 * The key is the whsec_ secret as given; the bare part after the prefix is
 * accepted too, in case Zeffy signs with that.
 */
export async function verifyZeffySignature(header, body, secret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  const t = Number(parts.t);
  const sigs = String(header).split(',').map((p) => p.trim()).filter((p) => p.startsWith('v1=')).map((p) => p.slice(3).toLowerCase());
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > TOLERANCE_S) return false;
  const keys = secret.startsWith('whsec_') ? [secret, secret.slice(6)] : [secret];
  for (const key of keys) {
    const want = await hmac(key, `${t}.${body}`);
    if (sigs.some((s) => sameHex(s, want))) return true;
  }
  return false;
}

/** The broadcast a gift made at `atMs` belongs to, or null. */
export function broadcastFor(state, atMs) {
  if (!state?.broadcastId) return null;
  const start = Date.parse(state.liveAt || state.scheduledAt || '');
  if (!Number.isFinite(start) || atMs < start - BEFORE_MS) return null;
  if (['scheduled', 'armed', 'live', 'ending'].includes(state.phase)) return state.broadcastId;
  if (state.phase === 'replay') {
    const end = Date.parse(state.endedAt || '');
    return Number.isFinite(end) && atMs <= end + AFTER_MS ? state.broadcastId : null;
  }
  return null;
}

/** A Zeffy Payment as a gift: { id, cents, currency, atMs } or null when it doesn't count. */
export function giftFrom(payment) {
  if (!payment || typeof payment !== 'object' || !payment.id) return null;
  if (payment.recurring) return null; // see "Honest numbers" above
  const cents = Math.round(Number(payment.amount));
  if (!Number.isFinite(cents) || cents <= 0) return null;
  const created = Number(payment.created);
  return {
    id: String(payment.id).slice(0, 80),
    cents,
    currency: String(payment.currency || 'usd').toLowerCase().slice(0, 8),
    atMs: Number.isFinite(created) && created > 0 ? (created < 1e12 ? created * 1000 : created) : Date.now(),
  };
}

export async function totalsFor(DB, broadcastId) {
  if (!broadcastId) return { cents: 0, count: 0 };
  try {
    const row = await DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM live_gifts WHERE broadcast_id = ? AND currency = 'usd'`).bind(broadcastId).first();
    return { cents: Number(row?.cents) || 0, count: Number(row?.n) || 0 };
  } catch { return { cents: 0, count: 0 }; } // table not created yet: no gifts
}

export async function readMeta(DB) {
  try {
    const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(META_KEY).first();
    return row?.data ? JSON.parse(row.data) : {};
  } catch { return {}; }
}
async function writeMeta(DB, meta) {
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(META_KEY, JSON.stringify(meta), new Date().toISOString()).run();
}

/**
 * Store a verified payment.completed. Returns { counted, broadcastId, totals }.
 * Safe to call again with the same payment (Zeffy retries): it counts once.
 */
export async function recordGift(env, state, payment) {
  const DB = env.DB;
  await writeMeta(DB, { ...(await readMeta(DB)), lastEventAt: new Date().toISOString() });
  const gift = giftFrom(payment);
  const broadcastId = gift ? broadcastFor(state, gift.atMs) : null;
  if (!gift || !broadcastId) return { counted: false, broadcastId, totals: null };
  await ensureGiftsSchema(DB);
  const res = await DB.prepare('INSERT OR IGNORE INTO live_gifts (id, broadcast_id, amount_cents, currency, created_at, received_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(gift.id, broadcastId, gift.cents, gift.currency, new Date(gift.atMs).toISOString(), new Date().toISOString()).run();
  const counted = (res?.meta?.changes ?? 1) > 0;
  const totals = await totalsFor(DB, broadcastId);
  // Everyone watching sees the new total at once (with a hub that relays gifts; pages poll otherwise)
  if (counted) await relay(env, { type: 'gifts', broadcastId, ...totals });
  return { counted, broadcastId, totals };
}
