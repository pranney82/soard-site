/**
 * Broadcast notifications
 * =======================
 * Everything that leaves the site when a reveal is scheduled, goes live, or
 * has a replay: reminder emails (Resend), SMS (Twilio), browser push
 * (Web Push with VAPID, no library), calendar files, and admin alerts
 * (Slack webhook + email). Every sender is best-effort and never throws;
 * callers get counts and error strings to record.
 *
 * Env vars (all optional except RESEND_API_KEY for email):
 *   RESEND_API_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (E.164) or TWILIO_MESSAGING_SERVICE_SID
 *   SLACK_WEBHOOK_URL
 *   ALERT_EMAILS  (comma-separated; falls back to the admin's audit email list)
 *
 * VAPID keys are generated once by the admin and stored in D1
 * (broadcast-config.vapid) so the site never needs a new env var for push.
 */

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

/** Normalize a US/intl phone number to E.164; null if it doesn't look like one. */
export function normalizePhone(s) {
  const digits = String(s || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

export function formatWhen(iso, tz = 'America/New_York') {
  if (!iso) return '';
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(d);
  return `${date} at ${time}`;
}

// ─── Email (Resend) ─────────────────────────────────────────────────

export function emailConfigured(env) {
  return !!env.RESEND_API_KEY;
}

/**
 * Send one message to many recipients, each as its own email (no one sees
 * anyone else's address). Batches of 100 per Resend call.
 * @returns {{sent:number, failed:number, errors:string[]}}
 */
export async function sendEmails(env, { to, subject, html, text, from = EMAIL_FROM, tags = [] }) {
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
        body: JSON.stringify(chunk.map(addr => ({ from, to: [addr], subject, html, text, tags }))),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) out.sent += chunk.length;
      else { out.failed += chunk.length; out.errors.push(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`); }
    } catch (e) {
      out.failed += chunk.length;
      out.errors.push(e.message);
    }
  }
  return out;
}

/**
 * Send pre-built messages (each with its own html, e.g. a personal
 * unsubscribe link), 100 per Resend call.
 * @param {{to:string, subject:string, html:string, text?:string}[]} items
 */
export async function sendEmailItems(env, items, { from = EMAIL_FROM, tags = [] } = {}) {
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
        body: JSON.stringify(chunk.map(m => ({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, tags }))),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) out.sent += chunk.length;
      else { out.failed += chunk.length; out.errors.push(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`); }
    } catch (e) {
      out.failed += chunk.length;
      out.errors.push(e.message);
    }
  }
  return out;
}

// ─── SMS (Twilio) ───────────────────────────────────────────────────

export function smsConfigured(env) {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID));
}

/** @returns {{sent:number, failed:number, errors:string[], optedOut:string[]}} */
export async function sendSms(env, { to, body }) {
  const out = { sent: 0, failed: 0, errors: [], optedOut: [] };
  const list = (to || []).map(normalizePhone).filter(Boolean);
  if (!list.length) return out;
  if (!smsConfigured(env)) { out.failed = list.length; out.errors.push('Twilio not configured'); return out; }
  const auth = 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  // Twilio is per-message; keep it to a bounded parallelism
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const num = queue.shift();
      const form = new URLSearchParams({ To: num, Body: body });
      if (env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
      else form.set('From', env.TWILIO_FROM);
      try {
        const res = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15000) });
        if (res.ok) { out.sent++; continue; }
        const err = await res.json().catch(() => ({}));
        // 21610 = recipient replied STOP; drop them from the list
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
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
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

function emailShell({ preheader, heading, body, cta, ctaUrl, image, unsubscribeUrl }) {
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
  You asked us to remind you about live room reveals. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6B6C72;">Stop these reminders</a>.
</td></tr>
</table></center></body></html>`;
}

/**
 * kind: 'scheduled' | 'day' | 'hour' | 'live' | 'replay'
 */
export function reminderEmail({ kind, kidName, scheduledAt, liveUrl, replayUrl, image, unsubscribeUrl, tz }) {
  const who = kidName ? `${kidName}'s` : 'the next';
  const when = formatWhen(scheduledAt, tz);
  const map = {
    scheduled: {
      subject: `Save the date: ${who} room reveal`,
      preheader: `We go live ${when}.`,
      heading: `${who.charAt(0).toUpperCase() + who.slice(1)} reveal is coming`,
      body: `<p>We're building something wonderful, and you're invited to watch the moment it's unveiled.</p><p><strong>${escapeHtml(when)}</strong></p><p>We'll remind you the day before and again an hour before we go live. The stream plays right on our site, and on Facebook.</p>`,
      cta: 'See the reveal page', ctaUrl: liveUrl,
    },
    day: {
      subject: `Tomorrow: ${who} room reveal, live`,
      preheader: `We go live ${when}.`,
      heading: `Tomorrow is reveal day`,
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
  const html = emailShell({ ...t, image, unsubscribeUrl });
  const text = `${t.heading}\n\n${t.body.replace(/<[^>]+>/g, '')}\n\n${t.cta}: ${t.ctaUrl}\n\nStop these reminders: ${unsubscribeUrl}`;
  return { subject: t.subject, html, text };
}

export function reminderSms({ kind, kidName, scheduledAt, liveUrl, replayUrl, tz, first = false }) {
  const who = kidName ? `${kidName}'s` : 'the next';
  const when = formatWhen(scheduledAt, tz);
  const map = {
    scheduled: `Sunshine on a Ranney Day: ${who} room reveal streams live ${when}. Watch here: ${liveUrl}`,
    day: `Sunshine on a Ranney Day: tomorrow is reveal day! ${who} reveal goes live ${when}. ${liveUrl}`,
    hour: `Sunshine on a Ranney Day: ${who} reveal goes live in about an hour. ${liveUrl}`,
    live: `Sunshine on a Ranney Day: we're LIVE with ${who} reveal right now. Watch: ${liveUrl}`,
    replay: `Sunshine on a Ranney Day: missed the reveal? Watch the replay: ${replayUrl || liveUrl}`,
  };
  const body = map[kind] || map.live;
  return first ? `${body} Reply STOP to opt out.` : body;
}

export function reminderPush({ kind, kidName, liveUrl, replayUrl, image }) {
  const who = kidName ? `${kidName}'s` : 'the next';
  const map = {
    scheduled: { title: 'Reveal scheduled', body: `${who} room reveal has a date. Tap for details.`, url: liveUrl },
    day: { title: 'Tomorrow is reveal day', body: `${who} reveal streams live tomorrow.`, url: liveUrl },
    hour: { title: 'One hour to go', body: `${who} reveal goes live in about an hour.`, url: liveUrl },
    live: { title: "We're live", body: `${who} room reveal is happening right now.`, url: liveUrl },
    replay: { title: 'Replay is ready', body: `Watch ${who} reveal any time.`, url: replayUrl || liveUrl },
  };
  const m = map[kind] || map.live;
  return { ...m, icon: '/apple-touch-icon.png', image: image || undefined, tag: `reveal-${kind}` };
}

// ─── Admin alerts ───────────────────────────────────────────────────

export function slackConfigured(env) {
  return !!env.SLACK_WEBHOOK_URL;
}

export async function slackAlert(env, text) {
  if (!slackConfigured(env)) return { ok: false, skipped: true };
  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function alertEmails(env, config) {
  const fromEnv = String(env.ALERT_EMAILS || '').split(',').map(s => s.trim()).filter(isEmail);
  const fromConfig = (config?.alerts?.emails || []).filter(isEmail);
  return [...new Set([...fromEnv, ...fromConfig])];
}

/**
 * Tell the humans. Slack if configured, email to the alert list. `level` is
 * 'info' | 'warn' | 'error'. Never throws.
 */
export async function alertAdmins(env, config, { level = 'warn', title, detail, url }) {
  const icon = level === 'error' ? '🔴' : level === 'warn' ? '🟡' : '🟢';
  const text = `${icon} *${title}*\n${detail || ''}${url ? `\n${url}` : ''}`;
  const results = { slack: await slackAlert(env, text), email: null };
  const to = alertEmails(env, config);
  if (to.length && emailConfigured(env)) {
    results.email = await sendEmails(env, {
      to,
      subject: `[SOARD Live] ${title}`,
      html: `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(detail || '').replace(/\n/g, '<br>')}</p>${url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : ''}`,
      text: `${title}\n\n${detail || ''}\n${url || ''}`,
      tags: [{ name: 'category', value: 'live-alert' }],
    });
  }
  return results;
}
