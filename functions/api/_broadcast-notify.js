/**
 * Broadcast notifications
 * =======================
 * Everything that leaves the site when a reveal is scheduled, goes live, or
 * has a replay: reminder emails (Resend), browser push (Web Push with VAPID,
 * no library), calendar files, and admin alerts (Slack + email, and texts to
 * the staff numbers through Twilio). The public is never texted. Every sender is best-effort and never throws;
 * callers get counts and error strings to record.
 *
 * Env vars (all optional except RESEND_API_KEY for email):
 *   RESEND_API_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (a restricted key
 *     with only Messaging > Messages: Create) or TWILIO_AUTH_TOKEN,
 *     TWILIO_FROM (E.164) or TWILIO_MESSAGING_SERVICE_SID
 *   SLACK_BOT_TOKEN (a Slack app; channel picked in the admin) or SLACK_WEBHOOK_URL
 *   ALERT_EMAILS  (comma-separated; falls back to the admin's audit email list)
 *
 * VAPID keys are generated once by the admin and stored in D1
 * (broadcast-config.vapid) so the site never needs a new env var for push.
 */

import { slackCard } from './_slack-cards.js';
import { logSent, batchIds } from './_email-log.js';

const RESEND_API = 'https://api.resend.com';
export const EMAIL_FROM = 'Sunshine on a Ranney Day <sunshine@comms.sunshineonaranneyday.com>';
export const SITE_ORIGIN = 'https://sunshineonaranneyday.com';

// ─── Small utils ────────────────────────────────────────────────────

export const b64u = {
  encode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function utf8(s) {
  return new TextEncoder().encode(s);
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
}

// +1 area codes that aren't the US or Canada (the Caribbean and Bermuda, where
// texts cost international rates and SMS pumping fraud lives), toll-free
// numbers (they can't get texts) and 900 (premium rate).
const NOT_US_CA = new Set([
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784',
  '809', '829', '849', '868', '869', '876',
  '800', '833', '844', '855', '866', '877', '888', '900',
]);

/**
 * A US or Canadian number in E.164 (+1NXXNXXXXXX); null for anything else.
 * Reminder texts only go to North America: an international number is how
 * SMS pumping bills a sender for texts nobody asked for.
 */
export function normalizePhone(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  // A + or an international dialing prefix must lead to +1
  if (/^(\+|00|011)/.test(raw) && !/^(\+|00|011)\s*\(?1/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '').replace(/^(011|00)/, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  // NANP: area code and exchange both start 2-9; N11 codes are services, not areas
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits) || /^\d11/.test(digits)) return null;
  if (NOT_US_CA.has(digits.slice(0, 3))) return null;
  return `+1${digits}`;
}

/** (404) 555-0123 for a +1 number, for people to read */
export function formatPhone(e164) {
  const d = String(e164 || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(e164 || '');
}

/** SHA-256 of a string, as hex. Sign-up tokens and codes are stored only this way. */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', utf8(String(text)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Browsers' push services. A subscription anywhere else would have the site
// POST to a host someone picked, so it is refused (and never sent to).
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

/** A Web Push endpoint on a real browser push service (https, default port, no credentials) */
export function pushEndpointOk(endpoint) {
  let u;
  try { u = new URL(String(endpoint || '')); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some(s => host.endsWith(s) && host.length > s.length);
}

/**
 * Headers that let mail apps show their own "Unsubscribe" button and stop the
 * reminders in one click (RFC 2369 + RFC 8058): the app POSTs
 * "List-Unsubscribe=One-Click" to the same link the email's footer has.
 */
export function listUnsubscribeHeaders(url) {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

export function formatWhen(iso, tz = 'America/New_York') {
  if (!iso) return '';
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(d);
  return `${date} at ${time}`;
}

/** The reveal is later today (in the broadcast's time zone): the "day before" reminder says today, not tomorrow */
export function isRevealToday(iso, tz = 'America/New_York', now = Date.now()) {
  if (!iso) return false;
  const day = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  return day(iso) === day(now);
}

// ─── Email (Resend) ─────────────────────────────────────────────────

export function emailConfigured(env) {
  return !!env.RESEND_API_KEY;
}

/** replyTo (one address or a list) → Resend's reply_to, valid addresses only; null when there's none */
const replyToOf = (r) => {
  const list = (Array.isArray(r) ? r : r ? [r] : []).map((x) => String(x).trim()).filter(isEmail);
  return list.length ? (list.length === 1 ? list[0] : list) : null;
};

/**
 * Send one message to many recipients, each as its own email (no one sees
 * anyone else's address). Batches of 100 per Resend call. replyTo: where a
 * reply goes, since the sending address is no one's inbox.
 * @returns {{sent:number, failed:number, errors:string[]}}
 */
export async function sendEmails(env, { to, subject, html, text, from = EMAIL_FROM, tags = [], replyTo = null }) {
  const reply = replyToOf(replyTo);
  const out = { sent: 0, failed: 0, errors: [] };
  const list = (to || []).filter(isEmail);
  if (!list.length) return out;
  if (!emailConfigured(env)) { out.failed = list.length; out.errors.push('RESEND_API_KEY not set'); return out; }
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    try {
      const res = await fetch(`${RESEND_API}/emails/batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(addr => ({ from, to: [addr], subject, html, text, tags, ...(reply ? { reply_to: reply } : {}) }))),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        out.sent += chunk.length;
        // Resend's ids, so its delivery reports find each email (Site → Emails & invites → What went out)
        const ids = batchIds(await res.json().catch(() => null));
        await logSent(env, chunk.map((addr, j) => ({ id: ids[j], to: addr, subject })), { tags });
      } else { out.failed += chunk.length; out.errors.push(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`); }
    } catch (e) {
      out.failed += chunk.length;
      out.errors.push(e.message);
    }
  }
  return out;
}

/**
 * Send pre-built messages (each with its own html, e.g. a personal
 * unsubscribe link, and its own `headers`, e.g. List-Unsubscribe), 100 per
 * Resend call.
 * @param {{to:string, subject:string, html:string, text?:string, headers?:Record<string,string>}[]} items
 */
export async function sendEmailItems(env, items, { from = EMAIL_FROM, tags = [], replyTo = null } = {}) {
  const reply = replyToOf(replyTo);
  const out = { sent: 0, failed: 0, errors: [] };
  const list = (items || []).filter(i => isEmail(i.to));
  if (!list.length) return out;
  if (!emailConfigured(env)) { out.failed = list.length; out.errors.push('RESEND_API_KEY not set'); return out; }
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    try {
      const res = await fetch(`${RESEND_API}/emails/batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(m => ({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, tags, ...(reply ? { reply_to: reply } : {}), ...(m.headers ? { headers: m.headers } : {}) }))),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        out.sent += chunk.length;
        const ids = batchIds(await res.json().catch(() => null));
        await logSent(env, chunk.map((m, j) => ({ id: ids[j], to: m.to, subject: m.subject })), { tags });
      } else { out.failed += chunk.length; out.errors.push(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`); }
    } catch (e) {
      out.failed += chunk.length;
      out.errors.push(e.message);
    }
  }
  return out;
}

// ─── SMS (Twilio) ───────────────────────────────────────────────────

// Basic-auth user:password. A restricted API key is preferred (it can only send
// messages); the account Auth Token still works. The URL always uses the Account SID.
function twilioCredentials(env) {
  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) return `${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`;
  if (env.TWILIO_AUTH_TOKEN) return `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`;
  return null;
}

export function smsConfigured(env) {
  return !!(env.TWILIO_ACCOUNT_SID && twilioCredentials(env) && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID));
}

/**
 * Twilio accepting a text isn't the phone getting it: with TWILIO_AUTH_TOKEN set, each
 * text asks Twilio to report delivery to /api/twilio-status (see recordTextStatus).
 * @returns {{sent:number, failed:number, errors:string[], optedOut:string[], accepted:string[]}}
 */
export async function sendSms(env, { to, body, mediaUrl = null }) {
  const out = { sent: 0, failed: 0, errors: [], optedOut: [], accepted: [] };
  const list = (to || []).map(normalizePhone).filter(Boolean);
  if (!list.length) return out;
  if (!smsConfigured(env)) { out.failed = list.length; out.errors.push('Twilio not configured'); return out; }
  const auth = 'Basic ' + btoa(twilioCredentials(env));
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  // Twilio is per-message; keep it to a bounded parallelism
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const num = queue.shift();
      const form = new URLSearchParams({ To: num, Body: body });
      if (mediaUrl) form.set('MediaUrl', mediaUrl); // a picture message: the contact card
      if (env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
      else form.set('From', env.TWILIO_FROM);
      if (env.TWILIO_AUTH_TOKEN) form.set('StatusCallback', TEXT_STATUS_URL);
      try {
        const res = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15000) });
        if (res.ok) { out.sent++; out.accepted.push(num); continue; }
        const err = await res.json().catch(() => ({}));
        // 21610 = the number replied STOP, so Twilio refuses to text it
        if (err.code === 21610) out.optedOut.push(num);
        out.failed++;
        if (out.errors.length < 5) out.errors.push(`${num.slice(0, 5)}…: ${err.message || res.status}`);
      } catch (e) {
        out.failed++;
        if (out.errors.length < 5) out.errors.push(e.message);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

// ─── Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) ─────────────────

export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  delete priv.key_ops; delete priv.ext;
  return { publicKey: b64u.encode(pub), privateJwk: priv, createdAt: new Date().toISOString() };
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function vapidAuthorization(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u.encode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u.encode(utf8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${payload}`));
  return `vapid t=${header}.${payload}.${b64u.encode(sig)}, k=${vapid.publicKey}`;
}

/** Encrypt a payload for one subscription (RFC 8291, aes128gcm). Exported for tests. */
export async function encryptPushPayload(subscription, plaintext) {
  const uaPublic = b64u.decode(subscription.keys.p256dh);
  const authSecret = b64u.decode(subscription.keys.auth);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const data = concat(typeof plaintext === 'string' ? utf8(plaintext) : plaintext, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, data));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/**
 * Deliver one push message. Returns { ok, status, gone } where gone=true
 * means the subscription is dead (404/410) and should be deleted.
 */
export async function sendWebPush(subscription, payload, vapid, { ttl = 3600, urgency = 'high', topic, subject = 'mailto:sunshine@sunshineonaranneyday.com' } = {}) {
  // Only ever POST to a browser's push service; an older row pointing anywhere else is dropped
  if (!pushEndpointOk(subscription?.endpoint)) return { ok: false, status: 0, gone: true, error: 'not a push service' };
  try {
    const body = await encryptPushPayload(subscription, typeof payload === 'string' ? payload : JSON.stringify(payload));
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: await vapidAuthorization(subscription.endpoint, vapid, subject),
    };
    if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    const res = await fetch(subscription.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: e.message };
  }
}

/** @returns {{sent:number, failed:number, gone:string[]}} gone = subscription ids to delete */
export async function sendPushBatch(subs, payload, vapid, opts) {
  const out = { sent: 0, failed: 0, gone: [] };
  if (!vapid?.privateJwk || !subs?.length) return out;
  const queue = [...subs];
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      const r = await sendWebPush(s.subscription, payload, vapid, opts);
      if (r.ok) out.sent++; else { out.failed++; if (r.gone) out.gone.push(s.id); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// ─── Calendar file ──────────────────────────────────────────────────

function icsDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsEscape(s) {
  // Every line break (\r\n, \n or a bare \r) becomes \n: a raw one would end the property and start a new one
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

export function buildIcs({ uid, title, description, start, durationMin = 60, url, location = 'Online' }) {
  const startIso = start;
  const endIso = new Date(Date.parse(start) + durationMin * 60000).toISOString();
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sunshine on a Ranney Day//Live Reveal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsEscape(uid)}@sunshineonaranneyday.com`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(startIso)}`,
    `DTEND:${icsDate(endIso)}`,
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `URL:${icsEscape(url)}`,
    `LOCATION:${icsEscape(location)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(title)} starts in one hour`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  // RFC 5545 line folding at 75 octets
  return lines.map(l => {
    const chunks = [];
    let s = l;
    while (s.length > 73) { chunks.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
    chunks.push(s);
    return chunks.join('\r\n');
  }).join('\r\n') + '\r\n';
}

// ─── Reminder copy ──────────────────────────────────────────────────

const Y = '#FFDA24';
const D = '#2D2E33';
const CREAM = '#FEFCF5';

function emailShell({ preheader, heading, body, cta, ctaUrl, image, unsubscribeUrl, list = false, footer = null }) {
  const img = image
    ? `<tr><td style="padding:0;"><img src="${escapeHtml(image)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border-radius:16px 16px 0 0;" /></td></tr>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#F5F4F0;font-family:Outfit,Helvetica,Arial,sans-serif;color:${D};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || '')}</div>
<center style="width:100%;background:#F5F4F0;padding:32px 0;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin:0 auto;max-width:600px;background:${CREAM};border-radius:16px;overflow:hidden;">
${img}
<tr><td style="padding:32px 32px 8px;">
  <div style="font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#8A7200;">Sunshine on a Ranney Day</div>
  <h1 style="font-family:'Libre Baskerville',Georgia,serif;font-size:28px;line-height:1.2;margin:12px 0 16px;">${escapeHtml(heading)}</h1>
  <div style="font-size:16px;line-height:1.6;">${body}</div>
</td></tr>
<tr><td style="padding:8px 32px 32px;">
  <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${Y};color:${D};font-weight:700;text-decoration:none;padding:14px 24px;border-radius:10px;font-size:16px;">${escapeHtml(cta)}</a>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#6B6C72;border-top:1px solid #E5E4E0;">
  ${footer != null ? footer : list
    ? `You're getting this because you subscribed to updates from Sunshine on a Ranney Day. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6B6C72;">Unsubscribe</a>.`
    : `You asked us to remind you about live room reveals. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6B6C72;">Stop these reminders</a>.`}
</td></tr>
</table></center></body></html>`;
}

/**
 * kind: 'scheduled' | 'moved' | 'day' | 'hour' | 'live' | 'replay'
 * list: true for newsletter-list sends (Kit), which get list footer copy
 *       instead of "you asked for reminders".
 */
export function reminderEmail({ kind, kidName, scheduledAt, liveUrl, replayUrl, image, unsubscribeUrl, tz, list = false }) {
  const who = kidName ? `${kidName}'s` : 'the next';
  const when = formatWhen(scheduledAt, tz);
  // A countdown that goes up on the day itself sends its "day before" reminder the same day
  const today = isRevealToday(scheduledAt, tz);
  const map = {
    scheduled: {
      subject: `Save the date: ${who} room reveal`,
      preheader: `We go live ${when}.`,
      heading: `${who.charAt(0).toUpperCase() + who.slice(1)} reveal is coming`,
      body: `<p>We're building something wonderful, and you're invited to watch the moment it's unveiled.</p><p><strong>${escapeHtml(when)}</strong></p><p>We'll remind you the day before and again an hour before we go live. The stream plays right on our site, and on Facebook.</p>`,
      cta: 'See the reveal page', ctaUrl: liveUrl,
    },
    moved: {
      subject: `New date: ${who} room reveal`,
      preheader: `We now go live ${when}.`,
      heading: `${who.charAt(0).toUpperCase() + who.slice(1)} reveal has a new date`,
      body: `<p>The reveal moved. Here's the new time:</p><p><strong>${escapeHtml(when)}</strong></p><p>We'll remind you the day before and again an hour before we go live.</p>`,
      cta: 'See the reveal page', ctaUrl: liveUrl,
    },
    day: {
      subject: `${today ? 'Today' : 'Tomorrow'}: ${who} room reveal, live`,
      preheader: `We go live ${when}.`,
      heading: `${today ? 'Today' : 'Tomorrow'} is reveal day`,
      body: `<p>${escapeHtml(who.charAt(0).toUpperCase() + who.slice(1))} reveal streams live <strong>${escapeHtml(when)}</strong>.</p><p>Bookmark the page below. It flips to the live video the moment we start.</p>`,
      cta: 'Open the reveal page', ctaUrl: liveUrl,
    },
    hour: {
      subject: `One hour to go: ${who} reveal`,
      preheader: `Live at ${when}.`,
      heading: `We go live in about an hour`,
      body: `<p>${escapeHtml(who.charAt(0).toUpperCase() + who.slice(1))} reveal starts <strong>${escapeHtml(when)}</strong>. Get comfortable and keep this page open.</p>`,
      cta: 'Watch when we go live', ctaUrl: liveUrl,
    },
    live: {
      subject: `We're live: ${who} room reveal`,
      preheader: 'Watch the reveal happening right now.',
      heading: `We're live right now`,
      body: `<p>${escapeHtml(who.charAt(0).toUpperCase() + who.slice(1))} reveal is happening this minute. Come watch.</p>`,
      cta: 'Watch live', ctaUrl: liveUrl,
    },
    replay: {
      subject: `Watch the replay: ${who} room reveal`,
      preheader: 'Missed it live? The full reveal is ready to watch.',
      heading: `The reveal, ready to watch`,
      body: `<p>Thank you for cheering along. The full recording of ${escapeHtml(who)} reveal is up now.</p><p>If it moved you, the fastest way to help the next family is a gift toward the next room.</p>`,
      cta: 'Watch the replay', ctaUrl: replayUrl || liveUrl,
    },
  };
  const t = map[kind] || map.live;
  const html = emailShell({ ...t, image, unsubscribeUrl, list });
  const text = `${t.heading}\n\n${t.body.replace(/<[^>]+>/g, '')}\n\n${t.cta}: ${t.ctaUrl}\n\nStop these reminders: ${unsubscribeUrl}`;
  return { subject: t.subject, html, text };
}

export function reminderPush({ kind, kidName, scheduledAt, tz, liveUrl, replayUrl, image }) {
  const who = kidName ? `${kidName}'s` : 'the next';
  const today = isRevealToday(scheduledAt, tz);
  const map = {
    scheduled: { title: 'Reveal scheduled', body: `${who} room reveal has a date. Tap for details.`, url: liveUrl },
    moved: { title: 'New reveal date', body: `${who} room reveal moved. Tap for the new time.`, url: liveUrl },
    day: today
      ? { title: 'Today is reveal day', body: `${who} reveal streams live today.`, url: liveUrl }
      : { title: 'Tomorrow is reveal day', body: `${who} reveal streams live tomorrow.`, url: liveUrl },
    hour: { title: 'One hour to go', body: `${who} reveal goes live in about an hour.`, url: liveUrl },
    live: { title: "We're live", body: `${who} room reveal is happening right now.`, url: liveUrl },
    replay: { title: 'Replay is ready', body: `Watch ${who} reveal any time.`, url: replayUrl || liveUrl },
  };
  const m = map[kind] || map.live;
  return { ...m, icon: '/apple-touch-icon.png', image: image || undefined, tag: `reveal-${kind}` };
}

// ─── Sign-up confirmations ──────────────────────────────────────────

/** The one email a new address gets before any reminder: a link that confirms it */
export function confirmEmail({ confirmUrl, kidName }) {
  const what = kidName ? `${kidName}'s room reveal` : 'our live room reveals';
  const t = {
    subject: kidName ? `Confirm your reminders for ${kidName}'s reveal` : 'Confirm your reveal reminders',
    preheader: "One tap and you're on the list.",
    heading: 'One tap to confirm',
    body: `<p>Someone asked us to email this address about ${escapeHtml(what)}. If that was you, tap the button and you're on the list.</p><p>If it wasn't you, ignore this email. We won't send anything else.</p>`,
    cta: 'Yes, remind me', ctaUrl: confirmUrl,
  };
  const footer = 'You got this one email because someone entered this address on a reveal page at sunshineonaranneyday.com. The link works for 3 days.';
  const html = emailShell({ ...t, footer: escapeHtml(footer) });
  const text = `${t.heading}\n\nSomeone asked us to email this address about ${what}. If that was you, open this link and you're on the list:\n${confirmUrl}\n\nIf it wasn't you, ignore this email. We won't send anything else.`;
  return { subject: t.subject, html, text };
}

// ─── Staff alert texts ──────────────────────────────────────────────
// The public is never texted. Texts go only to the staff numbers in
// Reveals → Settings → Alerts, and only for the reveal alerts that ask for
// one (alertAdmins' `text`): problems while live and when they clear, the
// go / no-go check before a reveal, "Live now" and "All green". Each text
// opens with a picture and what it is ("🚨 SOARD ALERT:", "✅ SOARD FIXED:",
// "🟢 SOARD:") so a lock screen says it at a glance, and Twilio reports
// whether it arrived. The hello text stays plain: it's the consent message.

export const ALERT_TEXTS_KEY = 'alert-texts';

/** The staff numbers on the alert list, as +1 numbers */
export function alertPhones(config) {
  return [...new Set((config?.alerts?.phones || []).map(normalizePhone).filter(Boolean))];
}

// Plain GSM characters keep a text at 160 characters a segment: one curly
// quote or emoji would switch the whole text to 70
const SMS_SWAPS = [[/[\u2018\u2019\u201A\u2032]/g, "'"], [/[\u201C\u201D\u201E\u2033]/g, '"'], [/[\u2013\u2014]/g, '-'], [/\u2026/g, '...'], [/[\u2022\u00B7]/g, '-'], [/\u2192/g, '>'], [/\u00A0/g, ' ']];
export function smsSafe(s) {
  let out = String(s ?? '');
  for (const [re, to] of SMS_SWAPS) out = out.replace(re, to);
  return out.replace(/[^\n\x20-\x7E]/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n+ */g, '\n').trim();
}

const TEXT_MAX = 306; // two segments

// The control room is behind the sign-in, so a phone can't preview it: texts link to
// /control-room/ instead, which shows previewers a card and sends people straight on
export const TEXT_LINK = `${SITE_ORIGIN}/control-room/`;
/** The contact card for the alert number (functions/alert-contact.js), sent with the hello text */
export const ALERT_CONTACT_URL = `${SITE_ORIGIN}/alert-contact`;
const textLink = (url) => (url && url.startsWith(`${SITE_ORIGIN}/admin/`) ? TEXT_LINK : url);

// What a lock screen shows first: a picture, then a problem, a fix, or news.
// Any emoji makes the whole text Unicode (70 characters a segment, not 160):
// a few cents more per text for a handful of staff, worth reading at a glance.
const TONE = { alert: 'SOARD ALERT', fixed: 'SOARD FIXED', info: 'SOARD' };
/** The tone an alertAdmins call reads as: clearing a problem, a problem (warn or error), or news */
export function toneFor({ level = 'warn', resolves = null } = {}) {
  return resolves ? 'fixed' : level === 'error' || level === 'warn' ? 'alert' : 'info';
}
/** The picture for a text: the alert's own (📡 live, 🟢 all green, ⏰ missed), else 🚨 serious, ⚠️ a problem, ✅ fixed */
export function textIcon({ level = 'warn', resolves = null, icon = null } = {}) {
  if (resolves) return '✅';
  if (icon) return icon;
  return level === 'error' ? '🚨' : level === 'warn' ? '⚠️' : null;
}

/** A staff alert as a text: a picture, "SOARD ALERT:" / "SOARD FIXED:" / "SOARD:", the headline, then the fix (or the first line of what happened), then the link */
export function alertText({ title, detail, fix, url, tone = 'info', icon = undefined }) {
  const pic = icon === undefined ? { alert: '🚨', fixed: '✅' }[tone] : icon;
  const head = `${pic ? `${pic} ` : ''}${TONE[tone] || TONE.info}: ${smsSafe(title)}`;
  const more = fix ? `Fix: ${smsSafe(fix)}` : smsSafe(String(detail || '').split('\n')[0]);
  const link = url ? `\n${textLink(url)}` : '';
  const room = TEXT_MAX - head.length - link.length - 1;
  const body = more && room > 24 ? `\n${more.length > room ? `${more.slice(0, room - 3).trimEnd()}...` : more}` : '';
  return `${head}${body}${link}`;
}

/** "Live now": only what's known the second the phone connects; the feed monitor's "All green" follows */
export function liveNowText({ title, url }) {
  return alertText({ title: `Live now: ${title || 'the reveal'}`, detail: 'Checking sound, picture, Facebook and YouTube. "All green" follows in about a minute.', url, icon: '📡' });
}

/** The first text a new number on the alert list gets: proof texts reach it, and how to stop */
export function alertHelloText({ by = null } = {}) {
  return `SOARD: ${by ? `${smsSafe(by)} added you to` : "You're on"} the live reveal alert texts. You'll get a text when a reveal has a problem, when the go/no-go check runs before it, and when it goes live. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.`;
}

export const TEXT_STATUS_URL = `${SITE_ORIGIN}/api/twilio-status`;
const TEXT_STATUS_PREFIX = 'alert-text-status:';

/** Twilio's delivery error codes, in words staff can act on */
export const TEXT_ERRORS = {
  21610: 'the number replied STOP',
  30003: 'the phone was off or out of service',
  30004: 'the carrier or the phone blocked it',
  30005: 'the number doesn’t exist',
  30006: 'it’s a landline or can’t get texts',
  30007: 'the carrier filtered it as spam',
  30008: 'the carrier gave no reason',
  30032: 'the toll-free number isn’t verified',
  30034: 'the number’s A2P campaign isn’t approved',
};

/** The last send, the numbers that replied STOP, and each number's last delivery report */
export async function readAlertTexts(DB) {
  try {
    const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(ALERT_TEXTS_KEY).first();
    const rec = row?.data ? JSON.parse(row.data) : {};
    const rows = (await DB.prepare("SELECT key, data FROM site_config WHERE key LIKE 'alert-text-status:%'").all())?.results || [];
    rec.numbers = Object.fromEntries(rows.map((r) => { try { return [r.key.slice(TEXT_STATUS_PREFIX.length), JSON.parse(r.data)]; } catch { return null; } }).filter(Boolean));
    return rec;
  } catch { return {}; }
}

/**
 * A delivery report from Twilio (/api/twilio-status): delivered, or why not.
 * One row per number, so reports for several numbers never overwrite each other.
 * → { status, error } for a final report, null for an in-between one (queued, sent)
 */
export async function recordTextStatus(DB, { to, status, code = null, sid = null }) {
  const num = normalizePhone(to);
  if (!DB || !num || !['delivered', 'undelivered', 'failed'].includes(status)) return null;
  const n = Number(code) || null;
  const rec = { status, at: new Date().toISOString(), code: n, error: n ? (TEXT_ERRORS[n] || `Twilio error ${n}`) : null, sid };
  await DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .bind(`${TEXT_STATUS_PREFIX}${num}`, JSON.stringify(rec), rec.at).run();
  return rec;
}

/** What the last staff text did, and which numbers replied STOP (Twilio then refuses them) */
export async function recordAlertTexts(DB, { title, result }) {
  if (!DB || !result) return;
  const rec = await readAlertTexts(DB);
  const at = new Date().toISOString();
  rec.last = { at, title: String(title || '').slice(0, 140), sent: result.sent || 0, failed: result.failed || 0, error: result.errors?.[0] || null };
  rec.stopped = rec.stopped || {};
  for (const n of result.optedOut || []) rec.stopped[n] = at;
  for (const n of result.accepted || []) delete rec.stopped[n];
  await DB.prepare(`INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .bind(ALERT_TEXTS_KEY, JSON.stringify(rec), at).run();
}

/** Text the staff list. Never throws. → sendSms's result, or null when there's nobody to text */
export async function textStaff(env, config, { title, body }) {
  const to = alertPhones(config);
  if (!to.length || !smsConfigured(env)) return null;
  try {
    const result = await sendSms(env, { to, body });
    await recordAlertTexts(env.DB, { title, result }).catch(() => {});
    return result;
  } catch (e) {
    return { sent: 0, failed: to.length, errors: [e.message], optedOut: [] };
  }
}

// ─── Admin alerts: Slack ────────────────────────────────────────────
// Two ways in. Preferred: a Slack app's bot token (SLACK_BOT_TOKEN, scopes
// chat:write, chat:write.public, channels:read, groups:read) posting with
// chat.postMessage to the channel picked in Reveals → Settings → Alerts
// (site_config "slack"), so the admin can name the channel and check it.
// Fallback: an incoming webhook (SLACK_WEBHOOK_URL), fixed to whichever
// channel it was made for and blind to which one that is.

const SLACK_API = 'https://slack.com/api';
export const SLACK_CONFIG_KEY = 'slack';
let _slackCfg = { db: null, at: 0, value: {} }; // per isolate, so every alert isn't a D1 read

/**
 * { channel, attention, updatedAt, updatedBy } — never the token. `channel`
 * ({ id, name, private }) is the Good news channel: gifts, new applications,
 * reveals going live. `attention` is the Needs attention channel: anything
 * that needs a hand; without it those go to `channel` too. `applications`
 * is the Makeover applications channel: everything about applicants and
 * their families, for the makeover team; without it those go by their kind.
 */
export async function readSlackConfig(DB, { fresh = false } = {}) {
  if (!DB) return {};
  if (!fresh && _slackCfg.db === DB && Date.now() - _slackCfg.at < 60e3) return _slackCfg.value;
  let value = {};
  try {
    const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(SLACK_CONFIG_KEY).first();
    value = row ? JSON.parse(row.data) || {} : {};
  } catch { value = {}; }
  _slackCfg = { db: DB, at: Date.now(), value };
  return value;
}

export async function writeSlackConfig(DB, value) {
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(SLACK_CONFIG_KEY, JSON.stringify(value), new Date().toISOString()).run();
  _slackCfg = { db: DB, at: Date.now(), value };
}

/**
 * Which kind of post goes where. 'news' | 'attention' → a channel id or null.
 * `area` 'applications' goes to the Makeover applications channel when one is picked.
 * `area` 'finance' goes only to the Finance channel; with none picked it isn't posted.
 */
export function slackChannelFor(cfg, kind = 'attention', area = null) {
  if (area === 'applications' && cfg?.applications?.id) return cfg.applications.id;
  // Money never falls back to a shared channel: without its own channel it stays in the admin
  if (area === 'finance') return cfg?.finance?.id || null;
  return (kind === 'attention' ? cfg?.attention?.id : null) || cfg?.channel?.id || null;
}

export function slackConfigured(env) {
  return !!(env.SLACK_BOT_TOKEN || env.SLACK_WEBHOOK_URL);
}

/**
 * Call a Slack Web API method with the bot token → Slack's JSON, or
 * { ok: false, error, status }. Messages go as JSON (blocks); Slack's read
 * methods only take form fields, so everything else is form-encoded.
 */
export async function slackApi(env, method, params = {}) {
  if (!env.SLACK_BOT_TOKEN) return { ok: false, error: 'not_connected', status: 0 };
  const asJson = method === 'chat.postMessage' || method === 'chat.update';
  try {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': asJson ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded' },
      body: asJson ? JSON.stringify(params) : new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: res.status === 429 ? 'ratelimited' : `HTTP ${res.status}`, status: res.status };
    const d = await res.json().catch(() => null);
    if (!d) return { ok: false, error: 'bad_response', status: res.status };
    return d.ok ? { ...d, status: 200 } : { ...d, status: 400 };
  } catch (e) {
    return { ok: false, error: e.message, status: 0 };
  }
}

/**
 * Post to Slack. With `blocks` (Block Kit) the message is formatted and
 * `text` is the notification line. Live issues have to land, so: one retry
 * on a network error, 429 or 5xx; if Slack rejects the blocks, the same
 * message again as plain text; and if the bot can't post (token revoked,
 * not in the channel), the webhook when there is one.
 * `kind` picks the channel: 'attention' (the default: anything that needs a
 * hand) or 'news' (good news everyone sees). `channel` (id or #name) sends
 * to that channel instead; it needs the bot token and never falls back to
 * the webhook.
 * `plain` is the whole message as text, for that plain resend (else `text`).
 * `thread` ({ channel, ts } of an earlier post, `broadcast` to show it in the
 * channel too) replies under it; `update` ({ channel, ts }) edits that post
 * instead. Both need the bot: through the webhook a reply is a new post and
 * an edit is skipped.
 * → { ok, status, attempts, via: 'bot'|'webhook', channel?, ts?, plain?, error?, botError?, skipped? }
 */
export async function slackAlert(env, text, blocks = null, { channel = null, plain = null, thread = null, update = null, kind = 'attention', area = null } = {}) {
  const ref = update || thread;
  const picked = env.SLACK_BOT_TOKEN ? (ref?.channel || channel || slackChannelFor(await readSlackConfig(env.DB), kind, area)) : null;
  const webhook = !channel && !update && area !== 'finance' && env.SLACK_WEBHOOK_URL ? env.SLACK_WEBHOOK_URL : null;
  if (!picked && !webhook) {
    if (area === 'finance' && !ref && !channel) return { ok: false, skipped: true, error: 'No Finance channel picked yet (Reveals → Settings → Alerts)' };
    const error = channel ? 'Posting to a named channel needs SLACK_BOT_TOKEN'
      : update ? 'Editing a post needs SLACK_BOT_TOKEN'
      : env.SLACK_BOT_TOKEN ? 'No Slack channel picked yet (Reveals → Settings → Alerts)' : 'Slack is not connected';
    return { ok: false, skipped: true, error };
  }
  const viaBot = async (payload) => {
    const d = update?.ts
      ? await slackApi(env, 'chat.update', { channel: picked, ts: update.ts, ...payload, ...(payload.blocks ? {} : { blocks: [] }) })
      : await slackApi(env, 'chat.postMessage', {
        channel: picked, unfurl_links: false, unfurl_media: false,
        ...(thread?.ts ? { thread_ts: thread.ts, ...(thread.broadcast ? { reply_broadcast: true } : {}) } : {}),
        ...payload,
      });
    return { ok: d.ok, status: d.status, error: d.ok ? null : d.error, ts: d.ts || null, channel: d.channel || null };
  };
  const viaWebhook = async (payload) => {
    try {
      const res = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
      return { ok: res.ok, status: res.status, error: res.ok ? null : (await res.text().catch(() => '')).slice(0, 200) || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  };
  let attempts = 0;
  const send = async (post) => {
    let r = { ok: false };
    for (const payload of blocks ? [{ text, blocks }, { text: plain || text }] : [{ text: plain || text }]) {
      for (let i = 0; i < 2; i++) {
        attempts++;
        r = await post(payload);
        if (r.ok) return { ...r, plain: !!blocks && !payload.blocks };
        const transient = !r.status || r.status === 429 || r.status >= 500;
        if (!transient) break;
        if (i === 0) await new Promise((res) => setTimeout(res, 1200));
      }
    }
    return r;
  };
  let botError = null;
  if (picked) {
    const r = await send(viaBot);
    if (r.ok) return { ok: true, status: r.status, attempts, via: 'bot', channel: r.channel || picked, ts: r.ts || update?.ts || null, plain: r.plain };
    botError = r.error;
    if (!webhook) return { ok: false, status: r.status, attempts, via: 'bot', channel: picked, error: r.error };
  }
  const r = await send(viaWebhook);
  if (r.ok) return { ok: true, status: r.status, attempts, via: 'webhook', plain: r.plain, ...(botError ? { botError } : {}) };
  return { ok: false, status: r.status, attempts, via: 'webhook', error: botError ? `${botError}; webhook: ${r.error}` : r.error, ...(botError ? { botError } : {}) };
}

/**
 * Is Slack really reachable? The bot token is checked (auth.test) and so is
 * the picked channel (conversations.info). → { mode: 'bot'|'webhook'|null,
 * ok, error?, team?, bot?, channel?, webhook } — the error is Slack's code
 * (invalid_auth, not_in_channel, …) or no_channel.
 */
export async function slackStatus(env) {
  const cfg = await readSlackConfig(env.DB, { fresh: true });
  const out = { mode: env.SLACK_BOT_TOKEN ? 'bot' : env.SLACK_WEBHOOK_URL ? 'webhook' : null, webhook: !!env.SLACK_WEBHOOK_URL, ok: false, error: null, errorFor: null, team: null, bot: null, channel: cfg.channel || null, attention: cfg.attention || null, applications: cfg.applications || null, finance: cfg.finance || null };
  if (out.mode !== 'bot') { out.ok = out.mode === 'webhook'; return out; }
  const auth = await slackApi(env, 'auth.test');
  if (!auth.ok) { out.error = auth.error; out.needed = auth.needed || null; return out; }
  out.team = auth.team || null;
  out.bot = auth.user || null;
  if (!cfg.channel?.id) { out.error = 'no_channel'; out.errorFor = 'news'; return out; }
  // Each picked channel must exist, be open, and (if private) have the app in it
  const check = async (picked) => {
    const info = await slackApi(env, 'conversations.info', { channel: picked.id });
    if (!info.ok) return { error: info.error, needed: info.needed || null, channel: picked };
    const c = info.channel || {};
    const channel = { id: c.id, name: c.name, private: !!c.is_private, member: !!c.is_member };
    if (c.is_archived) return { error: 'is_archived', channel };
    // chat:write.public lets the app post in any public channel; a private one needs an invite
    if (c.is_private && !c.is_member) return { error: 'not_in_channel', channel };
    return { channel };
  };
  const news = await check(cfg.channel);
  out.channel = news.channel;
  const attention = cfg.attention?.id ? await check(cfg.attention) : null;
  if (attention) out.attention = attention.channel;
  const applications = cfg.applications?.id ? await check(cfg.applications) : null;
  if (applications) out.applications = applications.channel;
  const finance = cfg.finance?.id ? await check(cfg.finance) : null;
  if (finance) out.finance = finance.channel;
  const bad = news.error ? ['news', news] : attention?.error ? ['attention', attention] : applications?.error ? ['applications', applications] : finance?.error ? ['finance', finance] : null;
  if (bad) { out.error = bad[1].error; out.needed = bad[1].needed || null; out.errorFor = bad[0]; return out; }
  out.ok = true;
  return out;
}

/**
 * Channels the app can post in: every public one, and the private ones it
 * was invited to. Listing both needs channels:read AND groups:read; without
 * groups:read the public ones still come back (missing names the scope).
 * → { ok, channels: [{ id, name, private, member }], missing?, error?, needed? }
 */
export async function slackChannels(env) {
  const channels = [];
  let types = 'public_channel,private_channel';
  let missing = null;
  let cursor;
  for (let page = 0; page < 10; page++) {
    const d = await slackApi(env, 'conversations.list', { types, exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
    // Only groups:read missing: list the public channels. Both missing: name both at once.
    const needed = String(d.needed || '');
    if (!d.ok && d.error === 'missing_scope' && page === 0 && types.includes('private') && needed.includes('groups:read') && !needed.includes('channels:read')) {
      types = 'public_channel';
      missing = 'groups:read';
      page = -1;
      continue;
    }
    if (!d.ok) return { ok: false, error: d.error, needed: d.needed || null, channels };
    for (const c of d.channels || []) channels.push({ id: c.id, name: c.name, private: !!c.is_private, member: !!c.is_member });
    cursor = d.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, channels, ...(missing ? { missing } : {}) };
}

/** Escape text for Slack mrkdwn. */
export function slackEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function alertEmails(env, config) {
  const fromEnv = String(env.ALERT_EMAILS || '').split(',').map(s => s.trim()).filter(isEmail);
  const fromConfig = (config?.alerts?.emails || []).filter(isEmail);
  return [...new Set([...fromEnv, ...fromConfig])];
}

/** Post a card from _slack-cards.js. Same options and result as slackAlert. */
export function slackPost(env, card, opts = {}) {
  return slackAlert(env, card.text, card.blocks, { plain: card.plain, ...opts });
}

// ─── Problems that clear ────────────────────────────────────────────
// A problem's first post is remembered by a key the caller picks
// ("invite:<jobId>", "live:<broadcastId>:noAudio"). Every update replies in
// its thread and shows in the channel too, so nobody misses it and one problem
// is one conversation. When it clears, the reply says so and the first post is
// edited into a short "✅ Resolved", so scrolling back shows what's still open.

let _openReady = { db: null, p: null }; // the table is made once per isolate and database
async function openPosts(DB) {
  if (!DB) return false;
  if (_openReady.db !== DB || !_openReady.p) {
    _openReady = { db: DB, p: DB.prepare(`CREATE TABLE IF NOT EXISTS slack_open_posts (
      key TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL, title TEXT, posted_at TEXT NOT NULL)`).run().then(() => true, () => false) };
  }
  const ok = await _openReady.p;
  if (!ok) _openReady = { db: null, p: null };
  return ok;
}

/** The open post for `key` → { key, channel, ts, title, posted_at } or null */
export async function slackOpenPost(env, key) {
  if (!(await openPosts(env.DB))) return null;
  return (await env.DB.prepare('SELECT * FROM slack_open_posts WHERE key = ?').bind(key).first().catch(() => null)) || null;
}

/**
 * Post a problem. The first time for `key` it's a new post, remembered; while
 * it's open, a reply in that post's thread, shown in the channel too. `title`
 * is what the ✅ edit says was resolved. Same result as slackAlert.
 */
export async function slackIssue(env, key, card, { title = null, kind = 'attention', area = null } = {}) {
  const open = await slackOpenPost(env, key);
  const r = await slackPost(env, card, open ? { thread: { channel: open.channel, ts: open.ts, broadcast: true } } : { kind, area });
  if (!open && r.ok && r.ts && r.via === 'bot' && (await openPosts(env.DB))) {
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT OR REPLACE INTO slack_open_posts (key, channel, ts, title, posted_at) VALUES (?, ?, ?, ?, ?)')
      .bind(key, r.channel, r.ts, title, now).run().catch(() => {});
    // A problem nobody cleared in a month is history, not open
    await env.DB.prepare('DELETE FROM slack_open_posts WHERE posted_at < ?').bind(new Date(Date.now() - 30 * 86400e3).toISOString()).run().catch(() => {});
  }
  return r;
}

/**
 * The problem for `key` cleared: `card` replies in its thread (shown in the
 * channel too), and the first post is edited into a short "✅ Resolved:
 * <title>" with `summary` under it, so it never repeats the reply.
 * → slackAlert's result for the reply, or null when nothing was open for the
 * key (the caller decides whether to post anyway).
 */
export async function slackResolved(env, key, card, { summary = null } = {}) {
  const open = await slackOpenPost(env, key);
  if (!open) return null;
  const ref = { channel: open.channel, ts: open.ts };
  const [, posted] = await Promise.all([
    slackPost(env, slackCard({ icon: '✅', title: `Resolved: ${open.title || 'this problem'}`, lead: summary }), { update: ref }),
    slackPost(env, card, { thread: { ...ref, broadcast: true } }),
  ]);
  await env.DB.prepare('DELETE FROM slack_open_posts WHERE key = ?').bind(key).run().catch(() => {});
  return posted;
}

/** The icon a problem or notice gets when the caller doesn't pick one */
export const LEVEL_ICON = { error: '🚨', warn: '⚠️', info: '📣' };

/** The main button's words for where `url` goes */
function urlLabelFor(url) {
  if (!url) return null;
  if (url.includes('#broadcast/control-room')) return 'Open the control room';
  if (/\/admin\/#broadcast(\/|$)/.test(url)) return 'Open Reveals';
  if (url.includes('/admin/')) return 'Open the admin';
  if (/\/live\/?(\?|#|$)/.test(url)) return 'Watch live';
  if (url.includes('instagram.com')) return 'Open on Instagram';
  return 'Open';
}

/** The Slack card alertAdmins posts, for the same options (no sending) */
export function adminCard({ level = 'warn', icon, title, detail, url, urlLabel, fix, context, facts = [], links = [], resolves = null, mention = null }) {
  const isTest = /^TEST · /.test(title || '');
  return slackCard({
    mention,
    icon: icon || (resolves ? '✅' : LEVEL_ICON[level] || LEVEL_ICON.info),
    title: isTest ? title.replace(/^TEST · /, '') : title,
    test: isTest ? 'Test reveal · not a real family' : null,
    lead: detail,
    facts,
    fix,
    buttons: [...(url ? [{ label: urlLabel || urlLabelFor(url), url }] : []), ...links].filter((l) => l?.url),
    footer: context,
  });
}

/**
 * Tell the humans. Slack if configured, email to the alert list. `level` is
 * 'info' | 'warn' | 'error'. Optional: `icon` (else one for the level),
 * `fix` (what to do), `context` (one small line: which reveal, how long
 * live), `facts` [[label, value]], `links` [{ label, url }] beyond `url`
 * (whose button says `urlLabel`). `issue` (a key) makes it a problem that
 * can clear (see slackIssue); `resolves` (the same key) clears it, turning
 * the first post into a ✅. `kind` is 'attention' (the default) or 'news'
 * (good news, for the channel everyone celebrates in). `urgent` adds @here,
 * but only in a Needs attention channel of its own, never the good-news one.
 * `text` also texts the staff numbers (reveal-day alerts only): true builds
 * the text from the alert, a string is the text itself.
 * A title starting "TEST · " is marked as a test. Never throws.
 * → { slack: slackAlert's result (with ts), email, text }
 */
/** The email side of a live alert (the same words go to Slack as a card) */
export function alertEmail({ title, detail, fix, context, links = [] }) {
  return {
    subject: `[SOARD Live] ${title}`,
    html: `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(detail || '').replace(/\n/g, '<br>')}</p>${fix ? `<p><strong>Fix:</strong> ${escapeHtml(fix)}</p>` : ''}${context ? `<p style="color:#666">${escapeHtml(context)}</p>` : ''}${links.map((l) => `<p><a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a></p>`).join('')}`,
    text: `${title}\n\n${detail || ''}${fix ? `\nFix: ${fix}` : ''}${context ? `\n${context}` : ''}\n${links.map((l) => `${l.label}: ${l.url}`).join('\n')}`,
  };
}

export async function alertAdmins(env, config, { level = 'warn', icon, title, detail, url, urlLabel, fix, context, facts = [], links = [], issue = null, resolves = null, kind = 'attention', urgent = false, text = false }) {
  const headline = /^TEST · /.test(title || '') ? title.replace(/^TEST · /, '') : title;
  const allLinks = [...(url ? [{ label: urlLabel || urlLabelFor(url), url }] : []), ...links].filter((l) => l?.url);
  const cfg = urgent && kind === 'attention' && env.SLACK_BOT_TOKEN ? await readSlackConfig(env.DB) : null;
  const separate = !!(cfg?.attention?.id && cfg.attention.id !== cfg.channel?.id);
  const card = adminCard({ level, icon, title, detail, url, urlLabel, fix, context, facts, links, resolves, mention: separate ? 'here' : null });
  let slack;
  try {
    slack = resolves ? (await slackResolved(env, resolves, card, { summary: [headline, detail].filter(Boolean).join('. ').replace(/\.\./g, '.') })) || (await slackPost(env, card, { kind }))
      : issue ? await slackIssue(env, issue, card, { title: headline.replace(/^Still: /, ''), kind })
      : await slackPost(env, card, { kind });
  } catch (e) {
    slack = { ok: false, error: e.message };
  }
  const results = { slack, email: null };
  const to = alertEmails(env, config);
  if (to.length && emailConfigured(env)) {
    results.email = await sendEmails(env, {
      to,
      ...alertEmail({ title, detail, fix, context, links: allLinks }),
      tags: [{ name: 'category', value: 'live-alert' }],
    });
  }
  // Texts only for the reveal alerts that ask (see Staff alert texts above)
  results.text = text ? await textStaff(env, config, { title, body: typeof text === 'string' ? text : alertText({ title, detail, fix, url: allLinks[0]?.url, tone: toneFor({ level, resolves }), icon: textIcon({ level, resolves, icon }) }) }) : null;
  return results;
}
