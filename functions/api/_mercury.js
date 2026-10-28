/**
 * Mercury (SOARD's bank and cards): the API, the webhook's signature, and
 * the webhook that registers itself
 * ===========================================================================
 * Env: MERCURY_API_TOKEN (Mercury → Settings → API tokens) and
 * MERCURY_RELAY_KEY (the relay's key). Nothing else: the webhook is created
 * through the API on the first heartbeat after the keys are in Cloudflare,
 * and Mercury's signing secret is kept in D1 spend_state "mercury-webhook"
 * (never site_config, which the admin reads).
 *
 * This file never calls Mercury's money-moving endpoints (send money,
 * transfers, recipients). The writes are: a transaction's note and category,
 * a card's spending limit, and the webhook itself.
 *
 * Mercury asks for an IP allow-list on tokens that can write, and Cloudflare
 * has no fixed address, so every call goes through SOARD's relay (a small
 * server with one fixed IP, the one on the token's allow-list). The relay
 * passes the call to api.mercury.com unchanged, paths and all, once the
 * X-Relay-Key header matches. A refused write is still remembered
 * (lastWriteError) and the admin says so.
 */

import { SITE_ORIGIN } from './_broadcast-notify.js';

export const MERCURY_BASE = 'https://mercury-relay.sunshineonaranneyday.com';
export const MERCURY_API = `${MERCURY_BASE}/api/v1`;
export const WEBHOOK_PATH = '/api/mercury-webhook';
export const WEBHOOK_EVENTS = ['transaction.created', 'transaction.updated'];
const SIGNATURE_TOLERANCE_S = 5 * 60;

const STATE_SCHEMA = 'CREATE TABLE IF NOT EXISTS spend_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)';
const _ready = new WeakSet();

export async function readState(DB, key) {
  if (!_ready.has(DB)) { await DB.prepare(STATE_SCHEMA).run(); _ready.add(DB); }
  const row = await DB.prepare('SELECT data FROM spend_state WHERE key = ?').bind(key).first();
  try { return row ? JSON.parse(row.data) || {} : {}; } catch { return {}; }
}

export async function writeState(DB, key, patch) {
  const next = { ...(await readState(DB, key)), ...patch };
  await DB.prepare('INSERT OR REPLACE INTO spend_state (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(key, JSON.stringify(next), new Date().toISOString()).run();
  return next;
}

// ─── The API ────────────────────────────────────────────────────────

export function mercuryConfigured(env) {
  return !!String(env.MERCURY_API_TOKEN || '').trim();
}

/** One Mercury call, through the relay. Throws an Error with .status on a non-2xx answer (.relay when the relay itself said no). */
export async function mercury(env, path, { method = 'GET', query = null, body = null, fetchImpl = fetch } = {}) {
  const token = String(env.MERCURY_API_TOKEN || '').trim();
  if (!token) throw Object.assign(new Error('MERCURY_API_TOKEN is not set'), { status: 0 });
  const relayKey = String(env.MERCURY_RELAY_KEY || '').trim();
  if (!relayKey) throw Object.assign(new Error('MERCURY_RELAY_KEY is not set'), { status: 0, relay: true });
  const url = new URL(`${MERCURY_API}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null) continue;
    for (const one of [].concat(v)) url.searchParams.append(k, String(one));
  }
  // A FormData body (a file upload) goes as multipart, with the boundary fetch picks
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetchImpl(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Relay-Key': relayKey, Accept: 'application/json', ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(form ? 60000 : 15000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  // The relay's own refusal is a bare "Forbidden"; Mercury's answers are JSON
  if (res.status === 403 && !json && text.trim() === 'Forbidden') {
    throw Object.assign(new Error('The Mercury relay refused the call: MERCURY_RELAY_KEY is missing or wrong'), { status: 403, relay: true });
  }
  if (!res.ok) {
    const msg = json?.errors?.message || json?.message || json?.error || text.slice(0, 200) || `Mercury answered ${res.status}`;
    throw Object.assign(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)), { status: res.status });
  }
  return json;
}

export const getTransaction = (env, id, o) => mercury(env, `/transaction/${encodeURIComponent(id)}`, o);

/** Transactions created since `start` (ISO), newest pages followed up to `maxPages` */
export async function listTransactions(env, { start, maxPages = 5, fetchImpl = fetch } = {}) {
  const out = [];
  let after = null;
  for (let i = 0; i < maxPages; i++) {
    const r = await mercury(env, '/transactions', { query: { start, limit: 500, order: 'asc', start_after: after }, fetchImpl });
    out.push(...(r?.transactions || []));
    after = r?.page?.nextPage || null;
    if (!after) break;
  }
  return out;
}

/** Note and/or category on a transaction (omit a field to leave it) */
export async function updateTransaction(env, id, { note, categoryId } = {}, o = {}) {
  const body = {};
  if (note !== undefined) body.note = note;
  if (categoryId !== undefined) body.categoryId = categoryId;
  return mercury(env, `/transaction/${encodeURIComponent(id)}`, { ...o, method: 'PATCH', body });
}

export async function listCards(env, o = {}) {
  const r = await mercury(env, '/cards', { ...o, query: { limit: 500 } });
  return r?.cards || [];
}

export async function listUsers(env, o = {}) {
  const r = await mercury(env, '/users', o);
  return r?.users || [];
}

/** SOARD's Mercury accounts: [{ id, name, kind, lastFour, status }] (checking, savings and credit) */
export async function listAccounts(env, o = {}) {
  const [dep, credit] = await Promise.all([
    mercury(env, '/accounts', o).then((r) => r?.accounts || []),
    mercury(env, '/credit', o).then((r) => r?.accounts || []).catch(() => []),
  ]);
  return [...dep, ...credit].map((a) => ({ id: a.id, name: a.nickname || a.name || (a.kind ? 'Account' : 'Mercury Credit'), kind: a.kind || 'credit', lastFour: a.lastFour || null, status: a.status }));
}

export async function listCategories(env, o = {}) {
  const r = await mercury(env, '/categories', o);
  return r?.categories || [];
}

/** A card's monthly limit, in cents */
export async function setCardLimit(env, cardId, amountCents, o = {}) {
  return mercury(env, `/cards/${encodeURIComponent(cardId)}`, { ...o, method: 'POST', body: { spendLimit: { amountCents: Math.round(amountCents), interval: 'monthly' } } });
}

/** card id → { email, name, limitCents, interval, status } */
export async function cardholders(env, o = {}) {
  const [cards, users] = await Promise.all([listCards(env, o), listUsers(env, o).catch(() => [])]);
  const byUser = new Map(users.map((u) => [u.userId, u]));
  const map = new Map();
  for (const c of cards) {
    const u = byUser.get(c.userId);
    map.set(c.id, {
      id: c.id, email: (u?.email || '').toLowerCase() || null,
      name: [u?.firstName, u?.lastName].filter(Boolean).join(' ') || c.nameOnCard || null,
      lastFour: c.lastFour || null, nickname: c.nickname || null, kind: c.kind, type: c.type, status: c.status,
      limitCents: c.spendLimit?.amountCents ?? null, interval: c.spendLimit?.interval || null,
    });
  }
  return map;
}

// ─── The signature ──────────────────────────────────────────────────

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signBody(secret, t, raw) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${typeof raw === 'string' ? raw : new TextDecoder().decode(raw)}`)));
}

/**
 * Mercury-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "{t}.{raw body}">.
 * → { ok } | { ok: false, why }
 */
export async function verifySignature(secret, header, raw, nowS = Date.now() / 1000) {
  if (!header) return { ok: false, why: 'no Mercury-Signature header' };
  let t = null;
  const sigs = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v.toLowerCase());
  }
  if (!t || !/^\d+$/.test(t) || !sigs.length) return { ok: false, why: 'malformed Mercury-Signature header' };
  if (Math.abs(nowS - Number(t)) > SIGNATURE_TOLERANCE_S) return { ok: false, why: 'signature timestamp outside 5 minutes' };
  const expected = await signBody(secret, t, raw);
  return sigs.some((s) => sameText(s, expected)) ? { ok: true } : { ok: false, why: 'signature does not match' };
}

// ─── The webhook, registered by the site itself ─────────────────────

export const WEBHOOK_KEY = 'mercury-webhook';

/**
 * Make sure Mercury sends transaction events to this site, with a secret we
 * hold. Adopts nothing it can't verify: a webhook to our address whose
 * secret was lost is deleted and made again. A disabled one (too many failed
 * deliveries) is switched back on. → { ok, id?, created?, error? }
 */
export async function ensureWebhook(env, { origin = SITE_ORIGIN, fetchImpl = fetch } = {}) {
  const url = `${origin}${WEBHOOK_PATH}`;
  const mine = await readState(env.DB, WEBHOOK_KEY);
  const list = (await mercury(env, '/webhooks', { fetchImpl }))?.webhooks || [];
  const ours = list.filter((w) => w.url === url);
  const known = ours.find((w) => w.id === mine.id && mine.secret);
  if (known) {
    if (known.status !== 'active') {
      await mercury(env, `/webhooks/${known.id}`, { method: 'POST', body: { status: 'active' }, fetchImpl });
      await writeState(env.DB, WEBHOOK_KEY, { reactivatedAt: new Date().toISOString() });
    }
    return { ok: true, id: known.id, created: false };
  }
  for (const w of ours) await mercury(env, `/webhooks/${w.id}`, { method: 'DELETE', fetchImpl }).catch(() => {});
  const made = await mercury(env, '/webhooks', { method: 'POST', body: { url, eventTypes: WEBHOOK_EVENTS }, fetchImpl });
  if (!made?.id || !made?.secret) throw new Error('Mercury made the webhook but sent no signing secret');
  await writeState(env.DB, WEBHOOK_KEY, { id: made.id, secret: made.secret, url, at: new Date().toISOString() });
  return { ok: true, id: made.id, created: true };
}

export async function webhookSecret(env) {
  return (await readState(env.DB, WEBHOOK_KEY)).secret || null;
}

// ─── Vendors: recipients, their tax forms, and invites (./_vendors.js) ─
// None of these move money. An invite asks a vendor, through Mercury's own
// email, for their bank details and tax form (a W-9); a recipient attachment
// is that form. Paying anyone stays a person's job in Mercury.

/** Every recipient (paged by Mercury's cursor) */
export async function listRecipients(env, { maxPages = 10, ...o } = {}) {
  const out = [];
  let after = null;
  for (let i = 0; i < maxPages; i++) {
    const r = await mercury(env, '/recipients', { ...o, query: { limit: 1000, order: 'asc', start_after: after } });
    out.push(...(r?.recipients || []));
    after = r?.page?.nextPage || null;
    if (!after) break;
  }
  return out;
}

export const getRecipient = (env, id, o = {}) => mercury(env, `/recipient/${encodeURIComponent(id)}`, o);

/** Every recipient's tax forms: [{ id, recipientId, fileName, url (12 h), uploadedAt, formType }] */
export async function listRecipientAttachments(env, { maxPages = 10, ...o } = {}) {
  const out = [];
  let after = null;
  for (let i = 0; i < maxPages; i++) {
    const r = await mercury(env, '/recipients/attachments', { ...o, query: { limit: 1000, order: 'asc', start_after: after } });
    out.push(...(r?.attachments || []));
    after = r?.page?.nextPage || null;
    if (!after) break;
  }
  return out;
}

/** Every invite: [{ id, onboardingUrl, status: created|completed|expired|declined, name, contactEmail, recipientId, createdAt, expiresAt }] */
export async function listRecipientInvites(env, { maxPages = 10, ...o } = {}) {
  const out = [];
  let after = null;
  for (let i = 0; i < maxPages; i++) {
    const r = await mercury(env, '/recipients/invites', { ...o, query: { limit: 1000, order: 'asc', start_after: after } });
    out.push(...(r?.invites || []));
    after = r?.page?.nextPage || null;
    if (!after) break;
  }
  return out;
}

/**
 * Ask a vendor for their bank details and tax form. Mercury emails them
 * (sendEmail) a page of its own; the W-9 they upload lands on the recipient.
 */
export function createRecipientInvite(env, { contactEmail, name = null, recipientId = null, notes = null, sendEmail = true, requireTaxDocument = true }, o = {}) {
  return mercury(env, '/recipients/invites', {
    ...o,
    method: 'POST',
    body: {
      contactEmail, ...(recipientId ? { recipientId } : { name }),
      paymentMethods: ['ach'], requireTaxDocument, sendEmail,
      notes, organizationNameOnRequest: 'Sunshine on a Ranney Day',
    },
  });
}

/** A tax form a vendor sent us another way, onto their Mercury recipient (multipart "file") */
export async function uploadRecipientAttachment(env, recipientId, { bytes, fileName, type = 'application/pdf' }, { fetchImpl = fetch } = {}) {
  const token = String(env.MERCURY_API_TOKEN || '').trim();
  const relayKey = String(env.MERCURY_RELAY_KEY || '').trim();
  if (!token) throw Object.assign(new Error('MERCURY_API_TOKEN is not set'), { status: 0 });
  if (!relayKey) throw Object.assign(new Error('MERCURY_RELAY_KEY is not set'), { status: 0, relay: true });
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), fileName);
  const res = await fetchImpl(`${MERCURY_API}/recipient/${encodeURIComponent(recipientId)}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Relay-Key': relayKey, Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Mercury answered ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}
