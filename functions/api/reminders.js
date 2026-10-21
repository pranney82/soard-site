/**
 * /api/reminders — "remind me when the reveal goes live"
 * =======================================================
 * Nobody gets a reminder until the address proves it's theirs: an email
 * signup is held until the link we email is confirmed, a phone number until
 * the 6-digit code we text is typed back. People already on the list stay on
 * it. Signing up again never undoes an unsubscribe or changes which reveal an
 * address hears about; only the confirmation does.
 *
 * POST (public; same-site pages only; Turnstile when it's on; D1 limits per
 * caller, per address, and for texts per day site-wide)
 *   { channel: 'email', email, kidSlug?, turnstileToken?, hp }  → { ok, channel, pending }  link emailed
 *   { channel: 'sms',   phone, kidSlug?, turnstileToken?, hp }  → { ok, channel, pending, codeSent }  code texted
 *   { channel: 'sms',   phone, code }                           → { ok, channel, confirmed }
 *   { channel: 'push',  subscription: PushSubscription JSON, kidSlug? } → { ok, channel }
 * POST ?confirm=<token>       confirm an email signup (the button on the confirm page)
 * POST ?unsubscribe=<token>   stop reminders (the button on the stop page, and mail
 *                             apps' one-click List-Unsubscribe, RFC 8058)
 * GET  ?confirm=<token>       a page with a "Yes, remind me" button
 * GET  ?unsubscribe=<token>   a page with a "Stop reminders" button
 *                             (GETs never change anything: mail scanners open every link)
 * GET  ?config=1              { turnstile: site key or null } for the form
 * GET  ?check=1               the Turnstile widget, in a frame with its own CSP
 * GET  ?ics=1                 calendar file for the scheduled reveal
 * GET  ?key=1                 VAPID public key for push subscriptions
 *
 * kidSlug scopes reminders to one reveal; omitted = every reveal.
 */

import { ensureSchema, readConfig, readState, visibleState, liveUrlFor, recordEvent } from './_broadcast.js';
import * as notify from './_broadcast-notify.js';
import { crossSiteChange } from './_origin-guard.js';
import { clientIp, turnstileOn, turnstileSiteKey, verifyTurnstile, safeEqual } from './_secure.js';
import { limit, limitAll, tooMany } from './_rate-limit.js';

const SITE = notify.SITE_ORIGIN;
const NO_STORE = { 'Cache-Control': 'no-store' };
// Token pages: never cached or indexed, and the token never leaves in a Referer
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE, 'Content-Security-Policy': PAGE_CSP, 'Referrer-Policy': 'strict-origin', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' };

export const CONFIRM_TTL_MS = 3 * 24 * 3600e3;
export const CODE_TTL_MS = 10 * 60e3;
export const CODE_TRIES = 5;
export const LIMITS = {
  ipPerHour: 10, ipPerDay: 30,  // sign-ups from one address (IPv6 counts per /64)
  perTargetPerDay: 3,           // confirm emails or codes to one email or number
  smsIpPerDay: 5,               // codes texted from one address
  smsPerDay: 200,               // codes texted site-wide; past this, staff hear about it once
  verifyIpPerHour: 30,          // code guesses from one address
};

function page(title, body, { status = 200, button = null } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${notify.escapeHtml(title)} | Sunshine on a Ranney Day</title>
<style>body{margin:0;font-family:Outfit,Helvetica,Arial,sans-serif;background:#FEFCF5;color:#2D2E33;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:480px;text-align:center}h1{font-family:'Libre Baskerville',Georgia,serif;font-size:1.75rem}.btn{display:inline-block;margin-top:16px;background:#FFDA24;color:#2D2E33;font:inherit;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px;border:0;cursor:pointer}.btn:focus-visible{outline:3px solid #2D2E33;outline-offset:2px}.quiet{display:block;margin-top:20px;color:#6B6C72;font-size:14px}p{line-height:1.6}</style></head>
<body><main><h1>${notify.escapeHtml(title)}</h1>${body}${button
    ? `<form method="post" action="${notify.escapeHtml(button.action)}"><button class="btn" type="submit">${notify.escapeHtml(button.label)}</button></form><a class="quiet" href="${SITE}/">Back to the site</a>`
    : `<a class="btn" href="${SITE}/">Back to the site</a>`}</main></body></html>`;
  return new Response(html, { status, headers: HTML_HEADERS });
}

function token(bytes = 18) {
  return notify.b64u.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Six random digits, without the small bias a plain modulo would add */
export function newCode() {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4294000000) return String(buf[0] % 1e6).padStart(6, '0');
  }
}

// ─── Waiting sign-ups ───────────────────────────────────────────────
// One row per emailed link or texted code, keyed by the SHA-256 of the
// secret (the link's token, or "<row id>:<code>"), so a copy of the table
// can't confirm anyone. A row becomes a real reminder only when confirmed.

const PENDING_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS broadcast_reminder_pending (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    kid_slug TEXT,
    source TEXT,
    secret_hash TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reminder_pending_addr ON broadcast_reminder_pending(channel, address)`,
  `CREATE INDEX IF NOT EXISTS idx_reminder_pending_secret ON broadcast_reminder_pending(secret_hash)`,
];
const _pendingReady = new WeakSet();
export async function ensurePendingSchema(DB) {
  if (_pendingReady.has(DB)) return;
  await ensureSchema(DB);
  await DB.batch(PENDING_SCHEMA.map(sql => DB.prepare(sql)));
  _pendingReady.add(DB);
}

const nowIso = () => new Date(Date.now()).toISOString();

/** A kid the site knows → { slug, name }; anything else means every reveal */
async function knownKid(DB, slug) {
  const s = slug ? String(slug).replace(/[^a-z0-9-]/gi, '').slice(0, 80) : '';
  if (!s) return null;
  const row = await DB.prepare('SELECT slug, name FROM kids WHERE slug = ?').bind(s).first().catch(() => null);
  return row?.slug ? { slug: row.slug, name: row.name || null } : null;
}

async function pendingByToken(DB, t) {
  if (!t || t.length > 128) return null;
  const row = await DB.prepare(`SELECT * FROM broadcast_reminder_pending WHERE secret_hash = ? AND channel = 'email'`).bind(await notify.sha256Hex(t)).first();
  return row && row.expires_at > nowIso() ? row : null;
}

/**
 * The address proved it's theirs: on the list (again), for the reveal the
 * confirmed request named. A confirmation is the one thing that may undo an
 * unsubscribe. Existing rows keep their token, so older emails' stop links work.
 */
export async function activate(DB, { channel, address, kid_slug, source }) {
  await DB.prepare(`INSERT INTO broadcast_reminders (id, channel, address, subscription, kid_slug, token, source, created_at, unsubscribed_at, last_sent_at, fails)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, 0)
    ON CONFLICT(channel, address) DO UPDATE SET
      last_sent_at = CASE WHEN broadcast_reminders.unsubscribed_at IS NULL THEN broadcast_reminders.last_sent_at ELSE NULL END,
      unsubscribed_at = NULL, kid_slug = excluded.kid_slug, source = excluded.source, fails = 0`)
    .bind(crypto.randomUUID(), channel, address, kid_slug || null, token(), source || null, nowIso()).run();
  await DB.prepare('DELETE FROM broadcast_reminder_pending WHERE channel = ? AND address = ?').bind(channel, address).run();
}

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  try {
    if (url.searchParams.has('check')) return checkPage(env);
    if (url.searchParams.get('config') === '1') {
      return Response.json({ ok: true, turnstile: turnstileOn(env) ? turnstileSiteKey(env) : null }, { headers: NO_STORE });
    }

    await ensurePendingSchema(env.DB);

    // Both pages only ask: link scanners open every link in an email, so nothing changes until the button
    if (url.searchParams.has('unsubscribe')) {
      const t = String(url.searchParams.get('unsubscribe') || '').slice(0, 64);
      const row = t ? await env.DB.prepare('SELECT id, unsubscribed_at FROM broadcast_reminders WHERE token = ?').bind(t).first() : null;
      if (!row) return page('That link has already been used', '<p>You are not on the reminder list, or this link expired.</p>', { status: 404 });
      if (row.unsubscribed_at) return page("You're off the list", '<p>You will not get any more reveal reminders. You can sign up again any time from a reveal page.</p>');
      return page('Stop reveal reminders?', '<p>Tap the button and we will stop sending you reminders about live room reveals.</p>', { button: { action: `/api/reminders?unsubscribe=${encodeURIComponent(t)}`, label: 'Stop reminders' } });
    }

    if (url.searchParams.has('confirm')) {
      const t = String(url.searchParams.get('confirm') || '');
      const row = await pendingByToken(env.DB, t);
      if (!row) return expiredPage();
      const kid = await knownKid(env.DB, row.kid_slug);
      return page('Confirm your reminders', `<p>Tap the button and we'll email <strong>${notify.escapeHtml(row.address)}</strong> ${kid?.name
        ? `about ${notify.escapeHtml(kid.name)}'s room reveal: when it gets a date, the day before, an hour before, when we go live, and when the replay is up.`
        : 'when a reveal gets its date, then the day before, an hour before, when we go live, and when the replay is up.'}</p>`,
        { button: { action: `/api/reminders?confirm=${encodeURIComponent(t)}`, label: 'Yes, remind me' } });
    }

    if (url.searchParams.get('key') === '1') {
      const config = await readConfig(env.DB);
      return Response.json({ ok: true, publicKey: config.vapid?.publicKey || null, enabled: !!(config.reminders?.push && config.vapid?.publicKey) }, { headers: { 'Cache-Control': 'public, max-age=300' } });
    }

    if (url.searchParams.get('ics') === '1') {
      const [config, state] = await Promise.all([readConfig(env.DB), readState(env.DB).then(visibleState)]);
      if (!state.scheduledAt || !['scheduled', 'armed'].includes(state.phase)) {
        return page('Nothing scheduled yet', '<p>There is no reveal on the calendar right now. Check back soon.</p>', { status: 404 });
      }
      const ics = notify.buildIcs({
        uid: state.broadcastId,
        title: state.title || 'Live room reveal',
        description: `${state.message || 'Watch the reveal live.'}\nWatch: ${liveUrlFor(state)}`,
        start: state.scheduledAt,
        durationMin: 60,
        url: liveUrlFor(state),
      });
      return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="soard-reveal.ics"`, 'Cache-Control': 'no-store' } });
    }

    return Response.json({ ok: true, endpoint: 'reminders' });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

function expiredPage() {
  return page('This link has expired', '<p>Confirmation links work for 3 days. Sign up again from any reveal page and we will send a fresh one.</p>', { status: 410 });
}

/**
 * The Turnstile widget, in a frame the reminder form puts under itself. The
 * live page's CSP doesn't load challenges.cloudflare.com, so the widget runs
 * here under a policy of its own and hands its token to the page with
 * postMessage, to this origin only.
 */
function checkPage(env) {
  if (!turnstileOn(env)) return new Response(null, { status: 204, headers: NO_STORE });
  const nonce = token(16);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quick check</title>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
<script nonce="${nonce}">
const up = (m) => parent.postMessage(Object.assign({ type: 'soard-check' }, m), location.origin);
let id = null;
window.onSoardCheck = () => {
  id = turnstile.render('#check', {
    sitekey: ${JSON.stringify(turnstileSiteKey(env))}, action: 'reminders', theme: 'light', size: 'flexible', appearance: 'interaction-only',
    callback: (t) => up({ token: t }),
    'expired-callback': () => up({ expired: true }),
    'error-callback': () => { up({ error: true }); },
    // Out of sight unless Cloudflare wants a click
    'before-interactive-callback': () => up({ show: true }),
  });
};
addEventListener('message', (e) => {
  if (e.origin === location.origin && e.source === parent && e.data && e.data.type === 'soard-check-reset' && id !== null) turnstile.reset(id);
});
</script>
<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onSoardCheck&render=explicit" async defer></script>
</head><body><div id="check"></div></body></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8', ...NO_STORE,
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff',
    },
  });
}

const json = (obj, status = 200) => Response.json(obj, { status, headers: NO_STORE });
const later = (context, p) => { const q = Promise.resolve(p).catch(() => {}); if (context.waitUntil) context.waitUntil(q); return q; };

/** A confirmed sign-up, for the reveal's numbers in the admin */
async function signedUp(env, channel, row) {
  const state = await readState(env.DB);
  await recordEvent(env.DB, state.broadcastId, 'reminder_signup', { channel, kidSlug: row.kid_slug || null, source: row.source || null });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  // A link's token is its own proof, and mail apps' one-click stops come from their servers with no Origin
  if (url.searchParams.has('unsubscribe')) return unsubscribe(env, url);
  if (url.searchParams.has('confirm')) return confirm(context, url);

  // Sign-ups only from our own pages: a form on another site can't enroll its visitors' addresses
  if (crossSiteChange(request, [SITE])) return json({ ok: false, error: 'Please sign up from a reveal page on our site.' }, 403);

  let body = {};
  const ct = request.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) body = await request.json();
    else { const f = await request.formData(); body = Object.fromEntries(f.entries()); }
  } catch { /* empty */ }
  if (!body || typeof body !== 'object') body = {};
  const channel = String(body.channel || 'email').toLowerCase();

  // Honeypot: bots fill hidden fields; pretend it worked
  if (body.hp || body.website) return json({ ok: true, channel, ...(channel === 'push' ? {} : { pending: true }) });

  try {
    await ensurePendingSchema(env.DB);
    const config = await readConfig(env.DB);
    const ip = clientIp(request);
    if (channel === 'sms' && body.code != null && body.code !== '') return await verifyCode(context, body, ip);

    let address, subscription = null;
    if (channel === 'email') {
      address = String(body.email || '').trim().toLowerCase();
      if (!notify.isEmail(address) || address.length > 254) return json({ ok: false, error: 'Enter a valid email address' }, 400);
      if (!notify.emailConfigured(env)) return json({ ok: false, error: 'Email reminders are not available right now' }, 503);
    } else if (channel === 'sms') {
      address = notify.normalizePhone(body.phone);
      if (!address) return json({ ok: false, error: 'Enter a US or Canadian mobile number' }, 400);
      if (!(config.reminders?.sms && notify.smsConfigured(env))) return json({ ok: false, error: 'Text reminders are not available right now' }, 503);
    } else if (channel === 'push') {
      let sub = body.subscription;
      if (typeof sub === 'string') { try { sub = JSON.parse(sub); } catch { sub = null; } }
      const endpoint = String(sub?.endpoint || '');
      const p256dh = String(sub?.keys?.p256dh || '');
      const auth = String(sub?.keys?.auth || '');
      if (endpoint.length > 1000 || !notify.pushEndpointOk(endpoint) || !/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}={0,2}$/.test(auth)) {
        return json({ ok: false, error: 'Invalid push subscription' }, 400);
      }
      if (!(config.reminders?.push && config.vapid?.publicKey)) return json({ ok: false, error: 'Push reminders are not available right now' }, 503);
      address = endpoint;
      subscription = JSON.stringify({ endpoint, keys: { p256dh, auth } });
    } else {
      return json({ ok: false, error: 'Unknown channel' }, 400);
    }

    const byIp = await limitAll(env.DB, [[`reminders:ip:${ip}`, LIMITS.ipPerHour, 3600], [`reminders:ip-day:${ip}`, LIMITS.ipPerDay, 86400]]);
    if (!byIp.ok) return tooMany(byIp.retryAfter, 'Too many sign-ups from here. Please try again later.');

    const kid = await knownKid(env.DB, body.kidSlug);
    const source = String(body.source || 'live-page').replace(/[^\w-]/g, '').slice(0, 40) || 'live-page';
    if (channel === 'push') return await pushSignup(context, { address, subscription, kid, source });

    if (turnstileOn(env) && !(await verifyTurnstile(env, body.turnstileToken, request.headers.get('CF-Connecting-IP') || ''))) {
      return json({ ok: false, code: 'turnstile', error: 'Please finish the quick check, then try again.' }, 403);
    }
    // Per address, hashed so the limits table never holds anyone's email or number
    const perTarget = await limit(env.DB, `reminders:to:${(await notify.sha256Hex(`${channel}:${address}`)).slice(0, 32)}`, LIMITS.perTargetPerDay, 86400);
    if (!perTarget.ok) {
      return tooMany(perTarget.retryAfter, channel === 'sms'
        ? 'We already texted this number a few codes today. Use the newest one, or try again tomorrow.'
        : 'We already sent this address a few links today. Look for the newest one in your inbox or spam folder.');
    }
    // Links and codes nobody used
    await env.DB.prepare('DELETE FROM broadcast_reminder_pending WHERE expires_at < ?').bind(nowIso()).run();
    return channel === 'email'
      ? await emailSignup(context, { address, kid, source })
      : await sendCode(context, config, { address, kid, source, ip });
  } catch (err) {
    return json({ ok: false, error: 'Something went wrong. Please try again.', detail: err.message }, 500);
  }
}

/** Email: hold the sign-up and send the link that confirms it */
async function emailSignup(context, { address, kid, source }) {
  const { env } = context;
  const t = token(32);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO broadcast_reminder_pending (id, channel, address, kid_slug, source, secret_hash, attempts, expires_at, created_at) VALUES (?, 'email', ?, ?, ?, ?, 0, ?, ?)`)
    .bind(id, address, kid?.slug || null, source, await notify.sha256Hex(t), new Date(Date.now() + CONFIRM_TTL_MS).toISOString(), nowIso()).run();
  const mail = notify.confirmEmail({ confirmUrl: `${SITE}/api/reminders?confirm=${t}`, kidName: kid?.name || null });
  const sent = await notify.sendEmailItems(env, [{ to: address, ...mail }], { tags: [{ name: 'category', value: 'reminder-confirm' }] });
  if (!sent.sent) {
    await env.DB.prepare('DELETE FROM broadcast_reminder_pending WHERE id = ?').bind(id).run();
    return json({ ok: false, error: "We couldn't send the email just now. Please try again in a minute." }, 500);
  }
  return json({ ok: true, channel: 'email', pending: true });
}

/** Text: a 6-digit code the visitor types back. The newest code for a number replaces older ones. */
async function sendCode(context, config, { address, kid, source, ip }) {
  const { env } = context;
  const byIp = await limit(env.DB, `reminders:sms-ip:${ip}`, LIMITS.smsIpPerDay, 86400);
  if (!byIp.ok) return tooMany(byIp.retryAfter, 'Too many text codes from here today. Please try again tomorrow, or use email.');
  const site = await limit(env.DB, `reminders:sms-day:${nowIso().slice(0, 10)}`, LIMITS.smsPerDay, 86400);
  if (!site.ok) {
    // Exactly one request sees the count step past the cap, so staff hear about it once a day
    if (site.count === LIMITS.smsPerDay + 1) {
      later(context, notify.alertAdmins(env, config, {
        level: 'warn', icon: '📵', title: 'Text sign-ups paused for today',
        detail: `More than ${LIMITS.smsPerDay} sign-up codes went out by text today, far more than a normal day. New text sign-ups are paused until tomorrow so nobody can run up the Twilio bill. Email sign-ups and everyone already on the list are not affected.`,
        fix: 'If a real crowd is signing up, nothing to do: it opens again tomorrow. If not, look in Twilio for texts to numbers nobody here recognizes.',
        url: `${SITE}/admin/#broadcast`,
      }));
    }
    return json({ ok: false, code: 'sms-paused', error: 'Text sign-ups are paused for today. Please use email, or try again tomorrow.' }, 503);
  }
  const id = crypto.randomUUID();
  const code = newCode();
  await env.DB.prepare(`DELETE FROM broadcast_reminder_pending WHERE channel = 'sms' AND address = ?`).bind(address).run();
  await env.DB.prepare(`INSERT INTO broadcast_reminder_pending (id, channel, address, kid_slug, source, secret_hash, attempts, expires_at, created_at) VALUES (?, 'sms', ?, ?, ?, ?, 0, ?, ?)`)
    .bind(id, address, kid?.slug || null, source, await notify.sha256Hex(`${id}:${code}`), new Date(Date.now() + CODE_TTL_MS).toISOString(), nowIso()).run();
  const r = await notify.sendSms(env, { to: [address], body: notify.smsCodeText(code) });
  if (!r.sent) {
    await env.DB.prepare('DELETE FROM broadcast_reminder_pending WHERE id = ?').bind(id).run();
    if (r.optedOut.length) {
      return json({ ok: false, code: 'opted-out', error: `This number asked us to stop texting it. Text START to ${env.TWILIO_FROM ? notify.formatPhone(env.TWILIO_FROM) : 'our number'} first, then try again.` }, 409);
    }
    return json({ ok: false, error: "We couldn't send a text just now. Please try again in a minute." }, 500);
  }
  return json({ ok: true, channel: 'sms', pending: true, codeSent: true, expiresIn: CODE_TTL_MS / 1000 });
}

/** The code typed back. Five tries per code; each try is counted before it's checked. */
async function verifyCode(context, body, ip) {
  const { env } = context;
  const address = notify.normalizePhone(body.phone);
  const code = String(body.code ?? '').replace(/\D/g, '');
  if (!address || code.length !== 6) return json({ ok: false, code: 'bad-code', error: 'Enter the 6-digit code from the text.' }, 400);
  const byIp = await limit(env.DB, `reminders:verify-ip:${ip}`, LIMITS.verifyIpPerHour, 3600);
  if (!byIp.ok) return tooMany(byIp.retryAfter, 'Too many tries. Please wait a little and try again.');

  const row = await env.DB.prepare(`SELECT * FROM broadcast_reminder_pending WHERE channel = 'sms' AND address = ? ORDER BY created_at DESC LIMIT 1`).bind(address).first();
  const gone = (error) => json({ ok: false, code: 'expired', error }, 410);
  if (!row || row.expires_at <= nowIso()) return gone('That code expired. Tap "Send a new code" and we will text another.');
  const counted = await env.DB.prepare('UPDATE broadcast_reminder_pending SET attempts = attempts + 1 WHERE id = ? AND attempts < ?').bind(row.id, CODE_TRIES).run();
  const drop = () => env.DB.prepare('DELETE FROM broadcast_reminder_pending WHERE id = ?').bind(row.id).run();
  if (!(counted?.meta?.changes > 0)) { await drop(); return gone('That code had too many tries. Tap "Send a new code" and we will text another.'); }
  if (!safeEqual(await notify.sha256Hex(`${row.id}:${code}`), row.secret_hash)) {
    const left = CODE_TRIES - (Number(row.attempts || 0) + 1);
    if (left <= 0) { await drop(); return gone('That code is not right, and that was the last try. Tap "Send a new code" and we will text another.'); }
    return json({ ok: false, code: 'wrong-code', error: `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` }, 400);
  }

  await activate(env.DB, row);
  later(context, notify.sendSms(env, { to: [address], body: notify.SMS_WELCOME }));
  later(context, signedUp(env, 'sms', row));
  return json({ ok: true, channel: 'sms', confirmed: true });
}

/**
 * Browser alerts. The endpoint is an unguessable address only the subscribing
 * browser holds, and the browser asked its person first, so presenting it is
 * the confirmation: it may turn alerts back on for that browser.
 */
async function pushSignup(context, { address, subscription, kid, source }) {
  const { env } = context;
  await env.DB.prepare(`INSERT INTO broadcast_reminders (id, channel, address, subscription, kid_slug, token, source, created_at, unsubscribed_at, last_sent_at, fails)
    VALUES (?, 'push', ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
    ON CONFLICT(channel, address) DO UPDATE SET unsubscribed_at = NULL, kid_slug = excluded.kid_slug, subscription = excluded.subscription, source = excluded.source, fails = 0`)
    .bind(crypto.randomUUID(), address, subscription, kid?.slug || null, token(), source, nowIso()).run();
  later(context, signedUp(env, 'push', { kid_slug: kid?.slug || null, source }));
  return json({ ok: true, channel: 'push' });
}

/** The confirm page's button */
async function confirm(context, url) {
  const { env } = context;
  try {
    await ensurePendingSchema(env.DB);
    const t = String(url.searchParams.get('confirm') || '');
    const row = await pendingByToken(env.DB, t);
    if (!row) return expiredPage();
    await activate(env.DB, row);
    later(context, signedUp(env, 'email', row));
    const kid = await knownKid(env.DB, row.kid_slug);
    return page("You're on the list", kid?.name
      ? `<p>We'll email you about ${notify.escapeHtml(kid.name)}'s room reveal: when it gets a date, the day before, an hour before, when we go live, and when the replay is up. Nothing else, ever.</p>`
      : "<p>We'll email you when a reveal gets its date, then the day before, an hour before, when we go live, and when the replay is up. Nothing else, ever.</p>");
  } catch {
    return page('Something went wrong', '<p>Please open the link from your email again in a minute.</p>', { status: 500 });
  }
}

/** The stop page's button, and mail apps' one-click unsubscribe (any body; the token is the proof) */
async function unsubscribe(env, url) {
  try {
    await ensureSchema(env.DB);
    const t = String(url.searchParams.get('unsubscribe') || '').slice(0, 64);
    const row = t ? await env.DB.prepare('SELECT id, unsubscribed_at FROM broadcast_reminders WHERE token = ?').bind(t).first() : null;
    if (!row) return page('That link has already been used', '<p>You are not on the reminder list, or this link expired.</p>', { status: 404 });
    if (!row.unsubscribed_at) await env.DB.prepare('UPDATE broadcast_reminders SET unsubscribed_at = ? WHERE id = ?').bind(nowIso(), row.id).run();
    return page('Reminders stopped', '<p>You will not get any more reveal reminders. You can sign up again any time from a reveal page.</p>');
  } catch {
    return page('Something went wrong', '<p>Please try the link again in a minute.</p>', { status: 500 });
  }
}
