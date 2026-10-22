/**
 * POST /api/twilio-status — did a staff alert text arrive?
 * ===========================================================================
 * Every staff text asks Twilio to report here (_broadcast-notify.js sendSms,
 * StatusCallback). Twilio accepting a text only means it's queued; this is
 * where the site learns the phone got it, or why not.
 *
 * Signed: X-Twilio-Signature = Base64(HMAC-SHA1(TWILIO_AUTH_TOKEN, the URL
 * followed by every form field's name and value, sorted by name)). No token
 * set: 503. A signature that doesn't match: 403.
 *
 * Only the final word counts (delivered, undelivered, failed); queued and
 * sent are answered and dropped. Each number's last report is kept for
 * Reveals → Settings → Alerts. A text that didn't arrive tells staff in Slack
 * and by email, never by text (texting is what failed), once a day per number.
 * Twilio wants a 2xx back, so anything past the signature answers 204.
 */

import * as notify from './_broadcast-notify.js';
import { readConfig } from './_broadcast.js';
import { safeEqual } from './_secure.js';
import { limit } from './_rate-limit.js';

const MAX_BODY = 16 * 1024;
const enc = new TextEncoder();

/** Twilio's request signature for a URL and its form fields */
export async function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  const key = await crypto.subtle.importKey('raw', enc.encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig));
}

/** What staff can do about a text that didn't arrive */
function fixFor(code) {
  if (code === 21610) return 'They can text START to the alert number to turn texts back on.';
  if (code === 30034 || code === 30032) return 'Check the number’s registration in Twilio: Messaging → Regulatory Compliance.';
  if (code === 30005 || code === 30006) return 'Check the number in Reveals → Settings → Alerts. It needs to be a mobile phone.';
  return 'Check the number in Reveals → Settings → Alerts, and the text in Twilio’s message log.';
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.TWILIO_AUTH_TOKEN) return new Response('Not set up', { status: 503 });
  const raw = await request.text().catch(() => '');
  if (!raw || raw.length > MAX_BODY) return new Response('Bad request', { status: 400 });
  const params = Object.fromEntries(new URLSearchParams(raw));
  const expected = await twilioSignature(env.TWILIO_AUTH_TOKEN, request.url, params);
  if (!safeEqual(expected, request.headers.get('X-Twilio-Signature') || '')) return new Response('Forbidden', { status: 403 });

  const rec = await notify.recordTextStatus(env.DB, { to: params.To, status: params.MessageStatus, code: params.ErrorCode, sid: params.MessageSid }).catch(() => null);
  if (rec && rec.status !== 'delivered') {
    const work = (async () => {
      const num = notify.normalizePhone(params.To);
      if (!(await limit(env.DB, `twilio-status:${num}`, 1, 86400)).ok) return;
      const config = await readConfig(env.DB);
      await notify.alertAdmins(env, config, {
        level: 'warn', icon: '📵',
        title: `A staff text didn’t arrive: ${notify.formatPhone(num)}`,
        detail: `Twilio says ${rec.error || 'it couldn’t be delivered'}.`,
        fix: fixFor(rec.code),
        url: `${notify.SITE_ORIGIN}/admin/#broadcast/settings`,
      });
    })().catch(() => {});
    if (context.waitUntil) context.waitUntil(work); else await work;
  }
  return new Response(null, { status: 204 });
}
