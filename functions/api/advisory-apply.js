/**
 * /api/advisory-apply — the public Advisory Board application (page: /advisory-board/apply/)
 * ===========================================================================
 * GET               → { ok, turnstileSiteKey } (null when Turnstile isn't set up)
 * POST JSON { answers, website, turnstileToken, startedAt }
 *                   → { ok: true, first } once it's stored
 *                   → 422 { ok: false, problems: { field: message } } when an answer needs a look
 *                     (checked before Turnstile, so fixing a typo doesn't need a second robot check)
 *
 * Public: listed in the middleware's PUBLIC_ROUTES and rate limited per IP
 * there (5 a minute), and here per day across every isolate. A honeypot field
 * ("website"), a too-fast check, and Turnstile (once TURNSTILE_SECRET_KEY is
 * set) keep bots out; a bot's send is answered like a person's and dropped.
 * The applicant's copy, the staff email and the Slack card go after the
 * answer (./_advisory-applications.js notifyNew).
 */

import { submitApplication, notifyNew } from './_advisory-applications.js';
import { checkAnswers } from './_advisory-form.js';
import { turnstileOn, turnstileSiteKey, verifyTurnstile, clientIp } from './_secure.js';
import { limit } from './_rate-limit.js';

const MAX_BODY = 64 * 1024;
const PER_DAY = 5;
const TOO_FAST_MS = 20 * 1000; // nobody reads and answers five steps in 20 seconds
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function ipHash(ip, pepper = '') {
  const data = new TextEncoder().encode(`soard-advisory:${ip || 'unknown'}`);
  const buf = pepper
    ? await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pepper)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data)
    : await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ env }) {
  return json({ ok: true, turnstileSiteKey: turnstileOn(env) ? turnstileSiteKey(env) : null });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return json({ ok: false, error: 'The application isn’t available right now. Please try again later.' }, 500);
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return json({ ok: false, error: 'That’s too much to send at once.' }, 413);
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: 'That’s too much to send at once.' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'That didn’t come through. Please try again.' }, 400);
  }
  const now = Date.now();
  // Bots: answered like a person, and dropped
  const started = Number(body?.startedAt);
  if (String(body?.website || '').trim() || (Number.isFinite(started) && started > 0 && now - started < TOO_FAST_MS)) {
    return json({ ok: true, first: '' });
  }
  // Answers first: a fixable mistake must not spend the applicant's Turnstile check (each token works once)
  const { problems: early } = checkAnswers(body?.answers || {});
  if (Object.keys(early).length) return json({ ok: false, problems: early, error: 'A few answers need a look.' }, 422);
  const ip = clientIp(request);
  if (turnstileOn(env) && !(await verifyTurnstile(env, body?.turnstileToken, ip))) {
    return json({ ok: false, code: 'turnstile', error: 'Please confirm you’re not a robot, then send it again.' }, 400);
  }
  const hash = await ipHash(ip, env.APPLY_IP_PEPPER || env.LIVE_IP_PEPPER);
  const lim = await limit(env.DB, `advisory-apply:${hash}`, PER_DAY, 24 * 3600, { now });
  if (!lim.ok) return json({ ok: false, error: 'We’ve had several applications from here today. Please write to info@soardcharity.com and we’ll help.' }, 429);

  const { app, problems, repeat } = await submitApplication(env, body?.answers || {}, { ipHash: hash, now });
  if (problems) return json({ ok: false, problems, error: 'A few answers need a look.' }, 422);
  if (!repeat) {
    const send = notifyNew(env, app, { now });
    if (context.waitUntil) context.waitUntil(send); else await send;
  }
  const first = String(app.answers.preferredName || app.answers.fullName || '').trim().split(/\s+/)[0] || '';
  return json({ ok: true, first });
}
