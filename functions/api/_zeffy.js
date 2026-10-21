/**
 * Gift alerts in Slack (replaces the DataX "donation alert" agent)
 * ===========================================================================
 * Each completed Zeffy payment becomes one post in Slack #team-everyone:
 *
 *   🎉 New donation - $50.00
 *   From: Jane Doe
 *   Campaign: Help Build a Brighter Home
 *   Received: October 20, 2026
 *
 * $1,000 and up starts with "🚨 MAJOR GIFT" instead. A line whose field is
 * missing is left out, never posted empty or guessed. No email address or
 * other contact details, and no totals (the reveal belongs to the family).
 * Not posted: imported payments (a bulk import would flood the channel),
 * $0 registrations, failed or fully refunded payments.
 *
 * Two ways in, one post per payment:
 *  1. Zeffy's webhook, POST /api/zeffy-webhook (payment.completed), signed
 *     with ZEFFY_WEBHOOK_SECRET. Zeffy retries any non-2xx for 3 days.
 *  2. A catch-up check every 15 minutes on the live hub's heartbeat: asks
 *     Zeffy's API (ZEFFY_API_KEY) for the last 2 days' successful payments,
 *     posts any the webhook never delivered (after 10 minutes' grace), and
 *     retries posts Slack refused.
 * D1 zeffy_gifts claims each payment id before posting, so a Zeffy retry, a
 * duplicate delivery or both paths at once never post twice. It keeps no
 * amounts or names: the post's text waits there only until Slack takes it.
 *
 * Problems (Slack refusing posts, the API key refused, the webhook missing
 * gifts or failing its signature) email peter@soardcharity.com and
 * ALERT_EMAILS once a day each. Gifts themselves only ever go to Slack.
 *
 * Env: ZEFFY_WEBHOOK_SECRET (whsec_…), ZEFFY_API_KEY (the catch-up check),
 * SLACK_BOT_TOKEN (the site's Slack app; chat:write.public lets it post in
 * #team-everyone without joining). Posts go by channel id, so a rename
 * doesn't break them.
 */

import { slackAlert, slackPost, readSlackConfig, sendEmails, emailConfigured, escapeHtml, isEmail, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';

export const ZEFFY_API = 'https://api.zeffy.com/api/v1';
export const MAJOR_GIFT_CENTS = 100000; // $1,000
export const GIFT_CHANNEL = 'C04NJ4W4QG6'; // #team-everyone
const SIGNATURE_TOLERANCE_S = 5 * 60; // Zeffy's recommendation
const MIN = 60 * 1000;
const SWEEP_EVERY_MS = 15 * MIN;
const SWEEP_WINDOW_S = 2 * 24 * 60 * 60;
const SWEEP_GRACE_S = 10 * 60; // the webhook's head start
const SWEEP_MAX_PAGES = 5;
const CLAIM_STALE_MS = 5 * MIN; // a claim this old means its worker died mid-post
const GIVE_UP_MS = 3 * 24 * 60 * MIN; // as long as Zeffy itself retries
const ALERT_EVERY_MS = 24 * 60 * MIN;
const FAILING_ALERT_AFTER_MS = 30 * MIN;
const MAX_BODY = 512 * 1024;
const CONFIG_KEY = 'zeffy-alerts';
const DEFAULT_ALERT_EMAILS = ['peter@soardcharity.com'];
const ADMIN_URL = `${SITE_ORIGIN}/admin/#automations`;
const PAYMENT_ID = /^[A-Za-z0-9_-]{6,64}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS zeffy_gifts (
    payment_id TEXT PRIMARY KEY, state TEXT NOT NULL, via TEXT, reason TEXT, pending TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, paid_at INTEGER, created_at TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS zeffy_gifts_state ON zeffy_gifts (state)',
];
const _schemaReady = new WeakSet();
export async function ensureSchema(DB) {
  if (_schemaReady.has(DB)) return;
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  _schemaReady.add(DB);
}

export async function readZeffyConfig(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(CONFIG_KEY).first();
  let data = {};
  try { data = row ? JSON.parse(row.data) : {}; } catch { /* default */ }
  return data;
}

export async function writeZeffyConfig(DB, patch) {
  const next = { ...(await readZeffyConfig(DB)), ...patch };
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(CONFIG_KEY, JSON.stringify(next), new Date().toISOString()).run();
  return next;
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

/**
 * Zeffy-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "{t}.{raw body}">,
 * keyed with the whole whsec_… secret. `raw` is the body's bytes, untouched.
 * → { ok } | { ok: false, why }
 */
export async function verifySignature(secret, header, raw, nowS = Date.now() / 1000) {
  if (!header) return { ok: false, why: 'no Zeffy-Signature header' };
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
  if (!t || !/^\d+$/.test(t) || !sigs.length) return { ok: false, why: 'malformed Zeffy-Signature header' };
  if (Math.abs(nowS - Number(t)) > SIGNATURE_TOLERANCE_S) return { ok: false, why: 'signature timestamp outside 5 minutes' };
  const bytes = typeof raw === 'string' ? enc.encode(raw) : new Uint8Array(raw);
  const prefix = enc.encode(`${t}.`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret).trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = toHex(await crypto.subtle.sign('HMAC', key, signed));
  return sigs.some((s) => sameText(s, expected)) ? { ok: true } : { ok: false, why: 'signature does not match ZEFFY_WEBHOOK_SECRET' };
}

// ─── The post ───────────────────────────────────────────────────────

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function money(cents, currency) {
  const code = /^[a-z]{3}$/i.test(currency || '') ? currency.toUpperCase() : 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function donor(buyer) {
  const name = clean(`${clean(buyer?.first_name)} ${clean(buyer?.last_name)}`);
  const company = buyer?.is_corporate ? clean(buyer?.company_name) : '';
  if (company && name) return `${company} (${name})`;
  return company || name || null;
}

const INTERVALS = [[/month/i, 'monthly'], [/year|annual/i, 'yearly'], [/week/i, 'weekly'], [/quarter/i, 'quarterly']];
function recurringLabel(p) {
  const raw = p?.recurring?.interval || (p?.items || []).map((i) => i?.recurrence_interval).find(Boolean);
  if (!raw) return null;
  const hit = INTERVALS.find(([re]) => re.test(raw));
  return hit ? hit[1] : clean(raw).toLowerCase();
}

/** The day the payment was made, as Zeffy dates it, in Eastern time */
function receivedOn(created) {
  const s = Number(created);
  if (!Number.isFinite(s) || s <= 0) return null;
  return new Date(s * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

/**
 * The Slack card for one Zeffy payment (the shape GET /payments/:id returns):
 * "💛 $50.00 gift from Jane Doe", or "🌟 Major gift: …" from $1,000. Only the
 * amount, the giver's name, the campaign and the day: never an email,
 * address or phone, and a missing one is left out.
 */
export function giftMessage(p) {
  const cents = Number(p?.amount);
  const has = Number.isFinite(cents) && p?.amount != null;
  const major = has && cents >= MAJOR_GIFT_CENTS;
  const every = recurringLabel(p);
  const amount = has ? money(cents, p.currency) : null;
  const from = donor(p?.buyer);
  const kind = every ? `${every} gift` : 'gift';
  const title = major
    ? `Major gift: ${amount}${every ? ` ${every}` : ''}${from ? ` from ${from}` : ''}`
    : `${amount ? `${amount} ${kind}` : `New ${kind}`}${from ? ` from ${from}` : ''}`;
  // The site's own self-test (below), never a real gift
  const test = p?.metadata?.soardSelfTest === true;
  return slackCard({
    icon: major ? '🌟' : '💛',
    title,
    test: test ? 'Test from the website · no gift was made' : null,
    lead: test ? 'Gift alerts are connected. Real gifts look just like this.' : null,
    facts: [['Campaign', clean(p?.description) || null], ['Received', receivedOn(p?.created)]],
  });
}

/** Why a payment isn't posted, or null when it should be */
export function screenPayment(p) {
  if (!p || typeof p !== 'object' || !PAYMENT_ID.test(String(p.id || ''))) return 'not a payment';
  if (p.status && String(p.status).toLowerCase() !== 'succeeded') return `status ${p.status}`;
  if (p.type === 'imported') return 'imported';
  if (p.amount != null && !(Number(p.amount) > 0)) return 'no amount';
  if (p.refund_status === 'full') return 'refunded';
  return null;
}

/**
 * `pending` holds the card as JSON; a row saved before cards is plain text.
 * Gifts go to the Good news channel picked in the admin, #team-everyone until one is.
 */
async function postToSlack(env, pending) {
  if (!env.SLACK_BOT_TOKEN) return { ok: false, error: 'SLACK_BOT_TOKEN is not set' };
  let card = null;
  try { card = JSON.parse(pending); } catch { /* plain text */ }
  const channel = (await readSlackConfig(env.DB).catch(() => ({}))).channel?.id || GIFT_CHANNEL;
  const r = card?.blocks
    ? await slackPost(env, card, { channel })
    : await slackAlert(env, String(pending), null, { channel });
  return r.ok ? { ok: true } : { ok: false, error: r.error || `Slack answered ${r.status}` };
}

/** Post a claimed payment and record how it went */
async function postClaimed(env, id, text, now) {
  const r = await postToSlack(env, text);
  const iso = new Date(now).toISOString();
  if (r.ok) {
    await env.DB.prepare("UPDATE zeffy_gifts SET state = 'posted', pending = NULL, reason = NULL, attempts = attempts + 1, updated_at = ? WHERE payment_id = ?").bind(iso, id).run();
    await writeZeffyConfig(env.DB, { lastPostAt: iso });
    return { result: 'posted' };
  }
  await env.DB.prepare("UPDATE zeffy_gifts SET state = 'failed', reason = ?, attempts = attempts + 1, updated_at = ? WHERE payment_id = ?").bind(String(r.error).slice(0, 300), iso, id).run();
  return { result: 'failed', error: r.error };
}

/**
 * One payment, from either path. Claims it first, so it posts once.
 * → { result: 'posted' | 'failed' | 'skipped' | 'duplicate' | 'invalid', reason?, error? }
 */
export async function handlePayment(env, p, { via = 'webhook', now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const id = String(p?.id || '');
  if (!PAYMENT_ID.test(id)) return { result: 'invalid', reason: 'not a payment' };
  const skip = screenPayment(p);
  const text = skip ? null : JSON.stringify(giftMessage(p));
  const iso = new Date(now).toISOString();
  const paidAt = Number.isFinite(Number(p.created)) ? Math.floor(Number(p.created)) : null;
  const ins = await env.DB.prepare(`INSERT OR IGNORE INTO zeffy_gifts
      (payment_id, state, via, reason, pending, attempts, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .bind(id, skip ? 'skipped' : 'posting', via, skip, text, paidAt, iso, iso).run();
  if (skip) return ins.meta?.changes ? { result: 'skipped', reason: skip } : { result: 'duplicate' };
  if (!ins.meta?.changes) {
    // Seen before: only a failed post (or a claim whose worker died) is tried again
    const stale = new Date(now - CLAIM_STALE_MS).toISOString();
    const re = await env.DB.prepare(`UPDATE zeffy_gifts SET state = 'posting', pending = COALESCE(?, pending), updated_at = ?
        WHERE payment_id = ? AND (state = 'failed' OR (state = 'posting' AND updated_at < ?))`).bind(text, iso, id, stale).run();
    if (!re.meta?.changes) return { result: 'duplicate' };
  }
  return postClaimed(env, id, text, now);
}

// ─── The webhook ────────────────────────────────────────────────────

/**
 * POST /api/zeffy-webhook. Answers 2xx once the gift is handled, so Zeffy
 * stops; 500 when the post failed, so Zeffy tries again (the catch-up check
 * retries too, and the claim keeps it to one post); 400 for a bad signature;
 * 503 while ZEFFY_WEBHOOK_SECRET isn't set (Zeffy keeps the gift for 3 days).
 */
export async function handleWebhook(env, request, { now = Date.now(), selfTest = false } = {}) {
  if (!env.DB) return Response.json({ ok: false, error: 'D1 binding missing' }, { status: 503 });
  if (!env.ZEFFY_WEBHOOK_SECRET) return Response.json({ ok: false, error: 'ZEFFY_WEBHOOK_SECRET is not set' }, { status: 503 });
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_BODY) return Response.json({ ok: false, error: 'too large' }, { status: 413 });
  const sig = await verifySignature(env.ZEFFY_WEBHOOK_SECRET, request.headers.get('Zeffy-Signature'), raw, now / 1000);
  if (!sig.ok) {
    // Remembered so the admin (and the next catch-up check) can say why
    if (request.headers.get('Zeffy-Signature')) {
      await writeZeffyConfig(env.DB, { lastRejected: { at: new Date(now).toISOString(), why: sig.why } }).catch(() => {});
    }
    return Response.json({ ok: false, error: sig.why }, { status: 400 });
  }
  let event;
  try { event = JSON.parse(new TextDecoder().decode(raw)); } catch { return Response.json({ ok: false, error: 'not JSON' }, { status: 400 }); }
  if (event?.type !== 'payment.completed') return Response.json({ ok: true, ignored: event?.type || 'unknown event' });
  const iso = new Date(now).toISOString();
  const cfg = await readZeffyConfig(env.DB);
  await writeZeffyConfig(env.DB, selfTest ? { since: cfg.since || iso } : { lastWebhookAt: iso, since: cfg.since || iso });
  const r = await handlePayment(env, event.data, { via: 'webhook', now });
  if (r.result === 'invalid') return Response.json({ ok: false, error: 'no payment in the event' }, { status: 400 });
  // 500, not 502: Cloudflare replaces 502 bodies with its own error page
  if (r.result === 'failed') return Response.json({ ok: false, error: r.error }, { status: 500 });
  return Response.json({ ok: true, ...r });
}

// ─── The catch-up check ─────────────────────────────────────────────

async function zeffyGet(env, path, params = {}, fetchImpl = fetch) {
  const url = new URL(`${ZEFFY_API}${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${String(env.ZEFFY_API_KEY).trim()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `Zeffy answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Zeffy's successful payments made between two Unix times, oldest pages first */
export async function listPayments(env, { from, to }, fetchImpl = fetch) {
  const out = [];
  let after = null;
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const r = await zeffyGet(env, '/payments', { status: 'succeeded', 'created[gte]': from, 'created[lte]': to, limit: 100, starting_after: after }, fetchImpl);
    out.push(...(r?.data || []));
    if (!r?.has_more || !r.next_cursor) break;
    after = r.next_cursor;
  }
  return out;
}

/** A gift-alert problem, as the email the people who look after this get */
export function zeffyAlertEmail({ title, detail, fix }) {
  return {
    subject: `[SOARD] ${title}`,
    html: `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(detail)}</p><p><strong>Fix:</strong> ${escapeHtml(fix)}</p><p><a href="${ADMIN_URL}">Open Automations in the admin</a></p>`,
    text: `${title}\n\n${detail}\n\nFix: ${fix}\n\n${ADMIN_URL}`,
  };
}

/** Email the people who look after this, once a day per problem */
async function alertOnce(env, cfg, key, { title, detail, fix }, now) {
  const last = Date.parse(cfg.alerted?.[key] || 0);
  if (now - last < ALERT_EVERY_MS) return false;
  cfg.alerted = { ...(cfg.alerted || {}), [key]: new Date(now).toISOString() };
  const to = [...new Set([...DEFAULT_ALERT_EMAILS, ...String(env.ALERT_EMAILS || '').split(',').map((s) => s.trim())])].filter(isEmail);
  if (!emailConfigured(env) || !to.length) return false;
  await sendEmails(env, {
    to,
    ...zeffyAlertEmail({ title, detail, fix }),
    tags: [{ name: 'category', value: 'zeffy-alerts' }],
  });
  return true;
}

/**
 * Post what the webhook missed, retry what Slack refused, and say so when
 * something needs a person. → summary. Never throws.
 */
export async function runSweep(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const iso = new Date(now).toISOString();
  const summary = { at: iso, checked: 0, missed: 0, posted: 0, retried: 0, failed: 0, gaveUp: 0, error: null };
  try {
    await ensureSchema(env.DB);
    const cfg = await readZeffyConfig(env.DB);
    // The site takes over from the first webhook or the first check; earlier gifts were someone else's job
    const since = cfg.since || iso;
    const sinceS = Math.floor(Date.parse(since) / 1000);
    const nowS = Math.floor(now / 1000);

    if (env.ZEFFY_API_KEY) {
      const from = Math.max(sinceS, nowS - SWEEP_WINDOW_S);
      const to = nowS - SWEEP_GRACE_S;
      if (to > from) {
        try {
          const payments = await listPayments(env, { from, to }, fetchImpl);
          summary.checked = payments.length;
          const known = new Set();
          for (let i = 0; i < payments.length; i += 50) {
            const ids = payments.slice(i, i + 50).map((p) => String(p.id || '')).filter((id) => PAYMENT_ID.test(id));
            if (!ids.length) continue;
            const rows = await env.DB.prepare(`SELECT payment_id FROM zeffy_gifts WHERE payment_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
            for (const r of rows.results || []) known.add(r.payment_id);
          }
          for (const p of payments) {
            if (known.has(String(p.id))) continue;
            const r = await handlePayment(env, p, { via: 'sweep', now });
            if (r.result === 'posted' || r.result === 'failed') summary.missed++;
            if (r.result === 'posted') summary.posted++;
            if (r.result === 'failed') summary.failed++;
          }
        } catch (e) {
          summary.error = e.status === 401 ? 'Zeffy refused ZEFFY_API_KEY' : e.message;
        }
      }
    }

    // Posts Slack refused: try again until Zeffy's own 3 days are up
    const stale = new Date(now - CLAIM_STALE_MS).toISOString();
    const waiting = await env.DB.prepare(`SELECT payment_id, pending, attempts, paid_at, created_at, reason FROM zeffy_gifts
        WHERE state = 'failed' OR (state = 'posting' AND updated_at < ?) ORDER BY created_at LIMIT 25`).bind(stale).all();
    let oldestFailing = null;
    let lastError = null;
    for (const row of waiting.results || []) {
      if (now - Date.parse(row.created_at) > GIVE_UP_MS || !row.pending) {
        await env.DB.prepare("UPDATE zeffy_gifts SET state = 'gave-up', pending = NULL, updated_at = ? WHERE payment_id = ?").bind(iso, row.payment_id).run();
        summary.gaveUp++;
        continue;
      }
      const claim = await env.DB.prepare(`UPDATE zeffy_gifts SET state = 'posting', updated_at = ?
          WHERE payment_id = ? AND (state = 'failed' OR (state = 'posting' AND updated_at < ?))`).bind(iso, row.payment_id, stale).run();
      if (!claim.meta?.changes) continue;
      summary.retried++;
      const r = await postClaimed(env, row.payment_id, row.pending, now);
      if (r.result === 'posted') summary.posted++;
      else {
        summary.failed++;
        lastError = r.error;
        if (!oldestFailing || row.created_at < oldestFailing) oldestFailing = row.created_at;
      }
    }

    // Problems a person has to fix
    const next = await readZeffyConfig(env.DB);
    if (summary.error) {
      await alertOnce(env, next, 'api', {
        title: 'Gift alerts can’t check Zeffy',
        detail: `The 15-minute catch-up check for missed gifts failed: ${summary.error}.`,
        fix: 'Create a new API key in Zeffy → Settings → Integrations and put it in Cloudflare as ZEFFY_API_KEY.',
      }, now);
    }
    if (summary.missed && env.ZEFFY_WEBHOOK_SECRET) {
      await alertOnce(env, next, 'missed', {
        title: 'Zeffy’s webhook missed a gift',
        detail: `The catch-up check found ${summary.missed} gift${summary.missed === 1 ? '' : 's'} Zeffy never sent to the website and posted ${summary.missed === 1 ? 'it' : 'them'} to Slack itself.`,
        fix: 'In Zeffy → Settings → Integrations, check the webhook points to https://sunshineonaranneyday.com/api/zeffy-webhook with “payment.completed” ticked.',
      }, now);
    }
    if (oldestFailing && now - Date.parse(oldestFailing) > FAILING_ALERT_AFTER_MS) {
      await alertOnce(env, next, 'slack', {
        title: 'Gifts aren’t reaching Slack',
        detail: `Slack refused the post for a Zeffy gift: ${lastError}. The website keeps trying for 3 days.`,
        fix: 'Check the site’s Slack app: SLACK_BOT_TOKEN in Cloudflare is current, the app is still installed, and #team-everyone is a public channel (or the app is in it).',
      }, now);
    }
    if (summary.gaveUp) {
      await alertOnce(env, next, 'gave-up', {
        title: 'A gift was never posted to Slack',
        detail: `Slack refused ${summary.gaveUp === 1 ? 'a gift’s post' : `${summary.gaveUp} gifts’ posts`} for 3 days, so the website stopped trying. Zeffy has the gift itself.`,
        fix: 'Check the site’s Slack app and SLACK_BOT_TOKEN in Cloudflare, then look the gift up in Zeffy.',
      }, now);
    }
    const rejected = next.lastRejected;
    if (rejected && now - Date.parse(rejected.at) < SWEEP_EVERY_MS * 2 && !(Date.parse(next.lastWebhookAt || 0) > Date.parse(rejected.at))) {
      await alertOnce(env, next, 'signature', {
        title: 'Zeffy’s webhook is being refused',
        detail: `A delivery from Zeffy was turned away: ${rejected.why}.`,
        fix: 'Copy the signing secret from Zeffy → Settings → Integrations → Webhook into Cloudflare as ZEFFY_WEBHOOK_SECRET.',
      }, now);
    }
    await writeZeffyConfig(env.DB, {
      since, alerted: next.alerted || {}, lastSweep: summary,
      ...(summary.missed ? { lastMissed: { at: iso, count: summary.missed } } : {}),
    });
  } catch (e) {
    summary.error = e.message;
    try { await writeZeffyConfig(env.DB, { lastSweep: summary }); } catch { /* nothing more to do */ }
  }
  return summary;
}

// ─── The self-test ──────────────────────────────────────────────────

/**
 * Change this to make production prove the whole path once more: on the next
 * heartbeat the site signs a test gift with its own ZEFFY_WEBHOOK_SECRET and
 * runs it through the webhook handler (signature, claim, Slack app), which
 * posts one message in #team-everyone marked as a test. The claim on its
 * payment id keeps it to one post; the result is kept in site_config
 * "zeffy-alerts".selfTest. No admin button: nobody has to press anything.
 */
export const SELF_TEST = '2026-10-20';

export async function maybeSelfTest(env, { now = Date.now() } = {}) {
  if (!env.DB || !env.ZEFFY_WEBHOOK_SECRET || !env.SLACK_BOT_TOKEN) return null;
  const cfg = await readZeffyConfig(env.DB);
  if (cfg.selfTest?.id === SELF_TEST) return null;
  const iso = new Date(now).toISOString();
  await writeZeffyConfig(env.DB, { selfTest: { id: SELF_TEST, at: iso, result: 'running' } });
  const t = Math.floor(now / 1000);
  const raw = JSON.stringify({
    id: `evt_selftest_${SELF_TEST}`, type: 'payment.completed', version: 1, dispatchedAt: iso,
    data: {
      id: `selftest-${SELF_TEST}`, object: 'payment', created: t, amount: 5000, currency: 'usd', status: 'succeeded', type: 'online',
      refund_status: 'none', refunds: [], description: 'Website test', buyer: { first_name: 'Test', last_name: 'Donor' },
      items: [], recurring: null, metadata: { soardSelfTest: true },
    },
  });
  const key = await crypto.subtle.importKey('raw', enc.encode(String(env.ZEFFY_WEBHOOK_SECRET).trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const v1 = toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`)));
  const request = new Request(`${SITE_ORIGIN}/api/zeffy-webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Zeffy-Signature': `t=${t},v1=${v1}` }, body: raw });
  const res = await handleWebhook(env, request, { now, selfTest: true });
  const body = await res.json().catch(() => ({}));
  const selfTest = { id: SELF_TEST, at: iso, status: res.status, result: body.result || null, error: body.error || null };
  await writeZeffyConfig(env.DB, { selfTest });
  return selfTest;
}

/** The heartbeat's wake-up: the self-test once, then every 15 minutes once Zeffy is connected. Never throws. */
export async function maybeSweepZeffy(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!env.DB || !(env.ZEFFY_API_KEY || env.ZEFFY_WEBHOOK_SECRET)) return null;
    await maybeSelfTest(env, { now }).catch(() => null);
    const cfg = await readZeffyConfig(env.DB);
    if (now - Date.parse(cfg.lastSweepAt || 0) < SWEEP_EVERY_MS) return null;
    // Claim the slot first so overlapping wake-ups don't double up
    await writeZeffyConfig(env.DB, { lastSweepAt: new Date(now).toISOString() });
    return await runSweep(env, { now, fetchImpl });
  } catch {
    return null;
  }
}
