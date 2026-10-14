/**
 * _live-messages.js — messages for the family on the live reveal page
 * ====================================================================
 * Viewers post a first name and a short note. Every note is screened before
 * anyone else sees it:
 *
 *   1. Local rules: length, links, emails, phone numbers, a short word list.
 *   2. Workers AI reads it with the context (a child's room reveal) and
 *      approves only kind, supportive or neutral notes.
 *
 * Statuses: shown (visible), blocked (screening said no), held (screening was
 * unavailable, so a person approves it in the admin), hidden (an admin took
 * it down). Shown notes are pushed to everyone on a live page through the
 * real-time hub; the admin can hide or show any note at any time, and the
 * whole set becomes a keepsake for the family after the reveal.
 *
 * Messages are open while a reveal is scheduled, live or on replay, unless
 * the admin switches them off (config.messages.enabled).
 */

import { ensureSchema, readConfig, readState, recordEvent } from './_broadcast.js';

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const OPEN_PHASES = new Set(['scheduled', 'armed', 'live', 'ending', 'replay']);
export const STATUSES = ['shown', 'hidden', 'blocked', 'held'];

export const LIMITS = {
  nameMax: 40,
  bodyMin: 2,
  bodyMax: 280,
  perClientPerMinute: 3,
  perClientPerBroadcast: 20,
  // A whole family on the house wifi shares one address, so this is generous
  perIpPerMinute: 30,
};

const nowIso = () => new Date(Date.now()).toISOString();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS broadcast_messages (
    id TEXT PRIMARY KEY,
    broadcast_id TEXT NOT NULL,
    kid_slug TEXT,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    client_id TEXT,
    ip_hash TEXT,
    created_at TEXT,
    moderated_by TEXT,
    moderated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bmessages ON broadcast_messages(broadcast_id, status, created_at)`,
];

let _ready = false;
export async function ensureMessagesSchema(DB) {
  if (_ready) return;
  await ensureSchema(DB);
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _ready = true;
}

// ─── Cleaning and screening ─────────────────────────────────────────

export function clean(text, max) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ly|me|app|xyz|info|biz|link|click|gg|tv)\b)/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
const HANDLE_RE = /(^|\s)@[a-z0-9_.]{3,}/i;
// Short on purpose: the AI pass does the real judging. These never belong on
// a children's page, so they skip the model entirely. Whole words only, so
// names and ordinary words that contain them still get through.
const WORD_RE = /\b(\w*fuck\w*|\w*shit\w*|bitch\w*|cunts?|whores?|sluts?|retard\w*|nigg\w*|fags?|faggots?|porn\w*|onlyfans|crypto|bitcoin|telegram)\b/i;
const hasPhone = (text) => (text.match(PHONE_RE) || []).some(m => m.replace(/\D/g, '').length >= 10);

/** Fast checks that need no model. Returns { ok, reason }. */
export function screenLocal(name, body) {
  if (!name) return { ok: false, reason: 'missing name', user: 'Add your first name.' };
  if (body.length < LIMITS.bodyMin) return { ok: false, reason: 'too short', user: 'Write a little more.' };
  const both = `${name} ${body}`;
  if (LINK_RE.test(both)) return { ok: false, reason: 'link', user: 'Please leave out links.' };
  if (EMAIL_RE.test(both)) return { ok: false, reason: 'email address', user: 'Please leave out email addresses.' };
  if (hasPhone(both)) return { ok: false, reason: 'phone number', user: 'Please leave out phone numbers.' };
  if (HANDLE_RE.test(both)) return { ok: false, reason: 'social handle', user: 'Please leave out social handles.' };
  if (WORD_RE.test(both)) return { ok: false, reason: 'word list' };
  if (/(.)\1{9,}/.test(body)) return { ok: false, reason: 'repeated characters' };
  return { ok: true };
}

const SYSTEM_PROMPT = `You screen messages that strangers post on a live video page run by a children's charity. The charity builds bedrooms for children with special needs, and the page streams the moment a family sees the finished room. Messages appear publicly next to the video and are later printed as a keepsake for the family.

Approve messages that are kind, encouraging, celebratory, grateful, or neutral (for example "So happy for you!", "Hi from Ohio", "Great job team", "Beautiful room", a simple emoji or prayer).

Reject anything that is rude, mocking, sarcastic at the family's expense, about the child's disability or appearance in a negative or pitying-insulting way, sexual, violent, hateful, political, religious preaching aimed at others, a complaint, an advertisement or fundraising for something else, a request for money or contact, personal information about anyone, gibberish, or anything you are unsure about.

Reply with JSON only: {"ok": true} or {"ok": false, "reason": "<three to six words>"}.`;

/** Ask the model. Returns { ok, reason } or null when the model is unavailable. Never throws. */
export async function screenAi(env, name, body, kidName) {
  if (!env.AI) return null;
  try {
    const out = await Promise.race([
      env.AI.run(AI_MODEL, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Child: ${kidName || 'unknown'}\nPosted by: ${name}\nMessage: ${body}` },
        ],
        max_tokens: 40,
        temperature: 0,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    const text = typeof out === 'string' ? out : (out?.response ?? JSON.stringify(out));
    const m = String(text).match(/\{[^}]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (typeof j.ok !== 'boolean') return null;
    return j.ok ? { ok: true } : { ok: false, reason: clean(j.reason || 'model said no', 80) };
  } catch {
    return null;
  }
}

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
}

function newId() {
  const rand = [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, '0')).join('');
  return `m-${Date.now().toString(36)}-${rand}`;
}

export function publicMessage(row) {
  return { id: row.id, name: row.name, body: row.body, at: row.created_at };
}

// ─── Hub relay ──────────────────────────────────────────────────────

/** Push a message event to everyone on a live page. Best effort. */
export async function relay(env, payload) {
  if (!env.LIVE_HUB) return { ok: false, skipped: true };
  try {
    const stub = env.LIVE_HUB.get(env.LIVE_HUB.idFromName('main'));
    const res = await stub.fetch('https://hub/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export function messagesOpen(state, config) {
  return config?.messages?.enabled !== false && !!state?.broadcastId && OPEN_PHASES.has(state.phase);
}

/** Shown messages for the current (or given) reveal, oldest first. */
export async function listShown(env, { broadcastId = null, limit = 100 } = {}) {
  const { DB } = env;
  await ensureMessagesSchema(DB);
  const [state, config] = await Promise.all([readState(DB), readConfig(DB)]);
  const id = broadcastId || state.broadcastId;
  const open = messagesOpen(state, config) && id === state.broadcastId;
  if (!id) return { ok: true, open: false, enabled: config.messages?.enabled !== false, broadcastId: null, messages: [] };
  const rows = await DB.prepare(`SELECT id, name, body, created_at FROM broadcast_messages WHERE broadcast_id = ? AND status = 'shown' ORDER BY created_at DESC LIMIT ?`)
    .bind(id, Math.min(200, Math.max(1, limit))).all();
  return { ok: true, open, enabled: config.messages?.enabled !== false, broadcastId: id, messages: (rows.results || []).reverse().map(publicMessage) };
}

/**
 * Post a message. Returns { ok, status?, message?, error?, httpStatus }.
 * `ip` is only ever stored hashed with the broadcast id.
 */
export async function postMessage(env, { name, body, clientId, hp, ip }) {
  const { DB } = env;
  await ensureMessagesSchema(DB);
  if (hp) return { ok: true, status: 'held', httpStatus: 200 }; // honeypot: look successful, store nothing
  const [state, config] = await Promise.all([readState(DB), readConfig(DB)]);
  if (!messagesOpen(state, config)) return { ok: false, error: 'Messages are closed for this reveal.', code: 'closed', httpStatus: 409 };

  const cleanName = clean(name, LIMITS.nameMax);
  const cleanBody = clean(body, LIMITS.bodyMax);
  const client = clean(clientId, 64).replace(/[^a-zA-Z0-9-]/g, '') || null;
  const ipHash = ip ? await sha(`${ip}|${state.broadcastId}`) : null;

  // Rate limits (D1, so they hold across isolates)
  const minuteAgo = new Date(Date.now() - 60e3).toISOString();
  const [byClientMinute, byClientTotal, byIpMinute, dup] = await Promise.all([
    client ? DB.prepare(`SELECT COUNT(*) AS n FROM broadcast_messages WHERE broadcast_id = ? AND client_id = ? AND created_at > ?`).bind(state.broadcastId, client, minuteAgo).first('n') : 0,
    client ? DB.prepare(`SELECT COUNT(*) AS n FROM broadcast_messages WHERE broadcast_id = ? AND client_id = ?`).bind(state.broadcastId, client).first('n') : 0,
    ipHash ? DB.prepare(`SELECT COUNT(*) AS n FROM broadcast_messages WHERE broadcast_id = ? AND ip_hash = ? AND created_at > ?`).bind(state.broadcastId, ipHash, minuteAgo).first('n') : 0,
    DB.prepare(`SELECT id FROM broadcast_messages WHERE broadcast_id = ? AND body = ? AND (client_id = ? OR ip_hash = ?) LIMIT 1`).bind(state.broadcastId, cleanBody, client, ipHash).first(),
  ]);
  if (Number(byClientMinute) >= LIMITS.perClientPerMinute || Number(byIpMinute) >= LIMITS.perIpPerMinute) {
    return { ok: false, error: 'One moment. You can post again in a minute.', code: 'rate', httpStatus: 429 };
  }
  if (Number(byClientTotal) >= LIMITS.perClientPerBroadcast) {
    return { ok: false, error: 'Thank you for all the love! That is the limit for this reveal.', code: 'rate', httpStatus: 429 };
  }
  if (dup) return { ok: false, error: 'You already posted that one.', code: 'duplicate', httpStatus: 409 };

  let status = 'shown';
  let reason = null;
  let userError = null;
  const local = screenLocal(cleanName, cleanBody);
  if (!local.ok) {
    status = 'blocked'; reason = local.reason; userError = local.user || null;
  } else {
    const ai = await screenAi(env, cleanName, cleanBody, state.kidName);
    if (!ai) { status = 'held'; reason = 'screening unavailable'; }
    else if (!ai.ok) { status = 'blocked'; reason = `ai: ${ai.reason}`; }
  }

  const row = {
    id: newId(), broadcast_id: state.broadcastId, kid_slug: state.kidSlug || null,
    name: cleanName || 'A friend', body: cleanBody, status, reason, client_id: client, ip_hash: ipHash, created_at: nowIso(),
  };
  if (cleanBody.length >= LIMITS.bodyMin) {
    await DB.prepare(`INSERT INTO broadcast_messages (id, broadcast_id, kid_slug, name, body, status, reason, client_id, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.broadcast_id, row.kid_slug, row.name, row.body, row.status, row.reason, row.client_id, row.ip_hash, row.created_at).run();
    await recordEvent(DB, state.broadcastId, 'message', { status });
  }

  if (status === 'shown') {
    const message = publicMessage(row);
    await relay(env, { type: 'msg', message });
    return { ok: true, status, message, httpStatus: 200 };
  }
  if (status === 'held') return { ok: true, status, httpStatus: 202 };
  return { ok: false, status, code: 'blocked', error: userError || "We couldn't post that one. Please keep it kind and leave out links and contact details.", httpStatus: 422 };
}

// ─── Admin ──────────────────────────────────────────────────────────

export async function adminList(env, broadcastId) {
  const { DB } = env;
  await ensureMessagesSchema(DB);
  const [state, config] = await Promise.all([readState(DB), readConfig(DB)]);
  const id = broadcastId || state.broadcastId;
  let meta = { kidSlug: state.kidSlug, kidName: state.kidName, title: state.title };
  if (id && id !== state.broadcastId) {
    const b = await DB.prepare('SELECT kid_slug, kid_name, title FROM broadcasts WHERE id = ?').bind(id).first();
    meta = { kidSlug: b?.kid_slug || null, kidName: b?.kid_name || null, title: b?.title || null };
  }
  const rows = id
    ? (await DB.prepare(`SELECT id, name, body, status, reason, created_at, moderated_by, moderated_at FROM broadcast_messages WHERE broadcast_id = ? ORDER BY created_at DESC LIMIT 500`).bind(id).all()).results || []
    : [];
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return {
    success: true, broadcastId: id || null, ...meta,
    enabled: config.messages?.enabled !== false,
    counts,
    messages: rows.map(r => ({ id: r.id, name: r.name, body: r.body, status: r.status, reason: r.reason, createdAt: r.created_at, moderatedBy: r.moderated_by, moderatedAt: r.moderated_at })),
  };
}

export async function moderate(env, id, status, by) {
  const { DB } = env;
  await ensureMessagesSchema(DB);
  if (!['shown', 'hidden'].includes(status)) return { success: false, error: 'status must be shown or hidden', status: 400 };
  const row = await DB.prepare('SELECT * FROM broadcast_messages WHERE id = ?').bind(String(id || '')).first();
  if (!row) return { success: false, error: 'Message not found', status: 404 };
  const at = nowIso();
  await DB.prepare('UPDATE broadcast_messages SET status = ?, moderated_by = ?, moderated_at = ? WHERE id = ?').bind(status, by || 'admin', at, row.id).run();
  const updated = { ...row, status, moderated_by: by || 'admin', moderated_at: at };
  const state = await readState(DB);
  if (row.broadcast_id === state.broadcastId) {
    await relay(env, status === 'shown' ? { type: 'msg', message: publicMessage(updated) } : { type: 'msg-hide', id: row.id });
  }
  return { success: true, message: { id: row.id, name: row.name, body: row.body, status, reason: row.reason, createdAt: row.created_at, moderatedBy: updated.moderated_by, moderatedAt: at } };
}

/** Shown-message counts per broadcast, for the admin History tab. */
export async function shownCounts(DB, ids) {
  if (!ids.length) return {};
  await ensureMessagesSchema(DB);
  const rows = (await DB.prepare(`SELECT broadcast_id, COUNT(*) AS n FROM broadcast_messages WHERE status = 'shown' AND broadcast_id IN (${ids.map(() => '?').join(',')}) GROUP BY broadcast_id`).bind(...ids).all()).results || [];
  return Object.fromEntries(rows.map(r => [r.broadcast_id, r.n]));
}
