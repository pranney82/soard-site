/**
 * POST /api/newsletter
 *
 * Adds an email to the newsletter list in Kit (formerly ConvertKit), the
 * site's only list tool. See _kit.js (optional KIT_FORM_ID).
 *
 * Cloudflare Pages env vars:
 *   KIT_API_KEY — Kit subscriber write
 *
 * Accepts both JSON (JS-enhanced) and form-encoded (no-JS fallback) POSTs.
 * Optional `source` is one of the site's own forms (SOURCE_TAGS in _kit.js:
 * "newsletter", "application-waitlist"), each going to its fixed Kit tag so
 * each audience can be emailed on its own. Anything else is "newsletter".
 * JSON:  { "email": "user@example.com", "source": "newsletter", "turnstileToken": "…" }  →  { "ok": true/false }
 * Form:  standard form POST  →  a one-tap confirm page, whose button posts again
 *        →  302 redirect back with ?subscribed=1 or ?newsletter_error=...
 * GET    →  { turnstileSiteKey } (null while the quick check is off), for the forms' script
 *
 * "application-waitlist" (the Apply page's "tell me when applications open")
 * goes to ./_application-waitlist.js: saved on the site first, then Kit, and
 * emailed the moment applications open. It also takes `lang` (en | es) and
 * `page` (apply | apply-form), and answers { ok, status } where status is
 * 'added' | 'already' | 'open' (open: here's `formUrl`, applications are open now).
 *
 * Keeping it to people who mean it:
 *   - Only this site's pages may post here (Origin check; localhost only on localhost).
 *   - JSON posts carry a Cloudflare Turnstile token whenever turnstileOn(env).
 *   - A plain form post (no JavaScript, so no Turnstile) first gets a one-tap
 *     "confirm" page holding a signed ticket, and is only taken once that page
 *     has been open MIN_FILL_MS. A form post with a valid Turnstile token
 *     (the widget adds cf-turnstile-response) skips that page.
 *   - Limits in D1, across every isolate: per address (IP_LIMITS), per email
 *     (EMAIL_LIMITS), and tighter ones for the no-Turnstile form path (FORM_LIMITS).
 *   - The honeypot field `website` answers "done" without doing anything.
 */

import { kitSubscribe, cleanSource } from './_kit.js';
import { recordSignup } from './_application-waitlist.js';
import { turnstileOn, turnstileSiteKey, verifyTurnstile, clientIp } from './_secure.js';
import { limitAll } from './_rate-limit.js';

const SITE_ORIGIN = 'https://sunshineonaranneyday.com';

// [max, window seconds] per key. Per connection is roomy on purpose: a gala
// table on the venue's Wi-Fi, or a phone carrier's shared address, is one IP.
// The per-email limit, Turnstile and the form path's own caps stop abuse.
const IP_LIMITS = [[30, 3600], [100, 86400]];
const EMAIL_LIMITS = [[3, 86400]];
// The form path has no Turnstile: fewer per address, and a ceiling for everyone together
const FORM_LIMITS = [[2, 3600], [4, 86400]];
const FORM_ALL_LIMITS = [[60, 3600]];

export const MIN_FILL_MS = 2500;          // the confirm page must be open this long
const TICKET_TTL_MS = 60 * 60 * 1000;     // and its ticket lasts an hour

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

const isLocalHost = (host) => host === 'localhost' || host === '127.0.0.1';

/**
 * Only the site's own pages sign people up: the request's own origin (a
 * preview deployment), the live site, and localhost when this is localhost.
 * A browser with no Origin header still says where a request came from in
 * Sec-Fetch-Site.
 */
export function originAllowed(request) {
  const self = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin) {
    if (origin === self.origin || origin === SITE_ORIGIN) return true;
    try { return isLocalHost(new URL(origin).hostname) && isLocalHost(self.hostname); } catch { return false; }
  }
  return request.headers.get('Sec-Fetch-Site') !== 'cross-site';
}

// ─── The no-JS confirm ticket ──────────────────────────────────────

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A key for tickets, derived from a secret the site already has (never the secret itself) */
async function ticketKey(env) {
  const material = env.KIT_API_KEY || env.TURNSTILE_SECRET_KEY || env.RESEND_API_KEY;
  if (!material) return null;
  const base = await crypto.subtle.importKey('raw', enc.encode(String(material)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', base, enc.encode('soard newsletter confirm ticket v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function ticketSig(key, at, email, source) {
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${at}|${email}|${source}`))).slice(0, 40);
}

export async function issueTicket(env, email, source, now = Date.now()) {
  const key = await ticketKey(env);
  return key ? `${now}.${await ticketSig(key, now, email, source)}` : '';
}

/** → 'ok' | 'missing' | 'early' | 'bad'. 'ok' too when the site has no secret to sign with. */
export async function checkTicket(env, ticket, email, source, now = Date.now()) {
  const key = await ticketKey(env);
  if (!key) return 'ok';
  const m = /^(\d{13})\.([0-9a-f]{40})$/.exec(String(ticket || ''));
  if (!m) return 'missing';
  const at = Number(m[1]);
  let diff = 0;
  const want = await ticketSig(key, at, email, source);
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2].charCodeAt(i);
  if (diff !== 0 || at > now || now - at > TICKET_TTL_MS) return 'bad';
  return now - at < MIN_FILL_MS ? 'early' : 'ok';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CONFIRM_WORDS = {
  // lead() gets the address already escaped and bolded
  newsletter: { title: 'One more step', lead: (e) => `Tap the button to get the Sunshine newsletter at ${e}.`, button: 'Subscribe', wait: 'One moment, then tap the button again.', back: 'Back to the site' },
  'application-waitlist': { title: 'One more step', lead: (e) => `Tap the button and we'll email ${e} when applications open.`, button: 'Notify me', wait: 'One moment, then tap the button again.', back: 'Back to the site' },
  es: { title: 'Un paso más', lead: (e) => `Toque el botón y le escribiremos a ${e} cuando abran las solicitudes.`, button: 'Avísenme', wait: 'Un momento, y vuelva a tocar el botón.', back: 'Volver al sitio' },
};

/** The one-tap page a plain form post gets first: the same fields again, plus a fresh ticket */
function confirmPage({ email, source, lang, page, back, ticket, early }) {
  const w = source === 'application-waitlist' && lang === 'es' ? CONFIRM_WORDS.es : CONFIRM_WORDS[source] || CONFIRM_WORDS.newsletter;
  const hidden = { email, source, lang: lang || '', page: page || '', back, ft: ticket };
  const fields = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
  const html = `<!doctype html><html lang="${lang === 'es' ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(w.title)} | Sunshine on a Ranney Day</title>
<style>body{margin:0;font-family:Outfit,Helvetica,Arial,sans-serif;background:#FEFCF5;color:#2D2E33;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:460px;text-align:center}h1{font-family:'Libre Baskerville',Georgia,serif;font-size:1.75rem}p{line-height:1.6;overflow-wrap:anywhere}button{font:inherit;margin-top:8px;background:#FFDA24;color:#2D2E33;font-weight:700;border:0;padding:12px 26px;border-radius:10px;cursor:pointer}a{color:#2D2E33}.hp{position:absolute;left:-9999px;top:-9999px}</style></head>
<body><main><h1>${esc(w.title)}</h1><p>${w.lead(`<strong>${esc(email)}</strong>`).replace(/'/g, '&#39;')}</p>${early ? `<p>${esc(w.wait)}</p>` : ''}
<form method="POST" action="/api/newsletter">${fields}<div class="hp" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div><button type="submit">${esc(w.button)}</button></form>
<p><a href="${esc(back)}">${esc(w.back)}</a></p></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

/** A same-site path to send the visitor back to ("/apply/"), never another site */
function cleanBackPath(p) {
  const s = String(p || '');
  return /^\/(?![/\\])[^\s\\]{0,300}$/.test(s) ? s.split('#')[0] : null;
}

async function emailKey(email) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(email))).slice(0, 32);
}

function redirect(baseUrl, path, params) {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.hash = 'newsletter-form';
  return Response.redirect(url.toString(), 302);
}

function safeRedirectPath(referer, requestUrl) {
  try {
    const ref = new URL(referer);
    const req = new URL(requestUrl);
    if (ref.origin === req.origin) return ref.pathname;
  } catch { /* invalid URL, fall through */ }
  return '/';
}

export async function onRequestPost(context) {
  const contentType = context.request.headers.get('Content-Type') || '';
  const isFormPost = !contentType.includes('application/json');
  const redirectPath = safeRedirectPath(
    context.request.headers.get('Referer') || '',
    context.request.url
  );
  const origin = new URL(context.request.url).origin;
  const { env } = context;
  const now = Date.now();

  // Another website's form or script can't sign its visitors up
  if (!originAllowed(context.request)) {
    return isFormPost
      ? new Response('Sign up from sunshineonaranneyday.com.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      : jsonOk({ ok: false, error: 'Sign up from sunshineonaranneyday.com.' }, 403);
  }

  try {
    let email, hp, source, lang, page, turnstileToken, ticket, back;

    if (contentType.includes('application/json')) {
      const body = await context.request.json().catch(() => null);
      ({ email, hp, source, lang, page, turnstileToken } = body && typeof body === 'object' ? body : {});
    } else {
      const form = await context.request.formData();
      email = form.get('email');
      hp = form.get('website');
      source = form.get('source');
      lang = form.get('lang');
      page = form.get('page');
      turnstileToken = form.get('cf-turnstile-response'); // the widget adds it when JS ran
      ticket = form.get('ft');
      back = cleanBackPath(form.get('back'));
    }
    source = cleanSource(source);
    lang = lang === 'es' ? 'es' : lang === 'en' ? 'en' : '';
    page = page === 'apply-form' ? 'apply-form' : page === 'apply' ? 'apply' : '';
    const backPath = back || redirectPath;

    // Honeypot: if the hidden field has a value, it's a bot
    if (hp) {
      if (isFormPost) return redirect(origin, backPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    email = String(email || '').trim().toLowerCase();
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (isFormPost) return redirect(origin, backPath, { newsletter_error: 'invalid_email' });
      return jsonOk({ ok: false, error: 'Please enter a valid email address.' }, 400);
    }

    // The quick check. A form post without it gets the confirm page first.
    const ip = clientIp(context.request);
    let checked = !turnstileOn(env);
    if (turnstileOn(env) && turnstileToken) checked = await verifyTurnstile(env, turnstileToken, ip);
    if (!checked && !isFormPost) {
      return jsonOk({ ok: false, code: 'turnstile', error: 'Please finish the quick check and try again.' }, 403);
    }
    const formPath = isFormPost && !(turnstileOn(env) && checked);
    if (formPath) {
      const t = await checkTicket(env, ticket, email, source, now);
      if (t !== 'ok') {
        return confirmPage({
          email, source, lang, page, back: backPath, early: t === 'early',
          ticket: t === 'early' ? ticket : await issueTicket(env, email, source, now),
        });
      }
    }

    // Limits shared by every isolate (D1): per address, per email, and the form path's own
    const key = await emailKey(email);
    const checks = [
      ...IP_LIMITS.map(([max, win]) => [`nl:ip:${ip}:${win}`, max, win]),
      ...EMAIL_LIMITS.map(([max, win]) => [`nl:email:${key}:${win}`, max, win]),
      ...(formPath ? [
        ...FORM_LIMITS.map(([max, win]) => [`nl:form:${ip}:${win}`, max, win]),
        ...FORM_ALL_LIMITS.map(([max, win]) => [`nl:form:all:${win}`, max, win]),
      ] : []),
    ];
    const allowed = await limitAll(env.DB, checks, { now });
    if (!allowed.ok) {
      if (isFormPost) return redirect(origin, backPath, { newsletter_error: 'rate_limited' });
      return new Response(JSON.stringify({ ok: false, error: 'Lots of signups from here just now. Please try again in a little while.' }), {
        status: 429, headers: { ...jsonHeaders, 'Retry-After': String(allowed.retryAfter) },
      });
    }

    if (source === 'application-waitlist' && context.env.DB) {
      let out = null;
      try {
        out = await recordSignup(context.env, { email, lang, page: page || 'apply' });
      } catch (err) {
        console.error('Waitlist signup could not be saved on the site; Kit only:', err);
      }
      if (out?.ok) {
        if (isFormPost) return redirect(origin, backPath, { subscribed: '1', ...(out.status === 'open' ? { open: '1' } : {}) });
        return jsonOk({ ok: true, status: out.status, confirmed: !!out.confirmed, ...(out.formUrl ? { formUrl: out.formUrl } : {}) });
      }
    }

    const kit = await kitSubscribe(context.env, email, { source });

    if (kit.ok) {
      if (isFormPost) return redirect(origin, backPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    if (!kit.configured) {
      console.error('KIT_API_KEY is not set');
      if (isFormPost) return redirect(origin, backPath, { newsletter_error: 'not_configured' });
      return jsonOk({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }, 503);
    }

    // 503, not 502: Cloudflare replaces 502/504 bodies with its own error page,
    // which would hide this JSON from the client.
    if (isFormPost) return redirect(origin, backPath, { newsletter_error: 'server' });
    return jsonOk({ ok: false, error: 'Something went wrong. Please try again.' }, 503);
  } catch (err) {
    console.error('Newsletter handler error:', err);
    if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'server' });
    return jsonOk({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }
}

/** What the signup forms' script needs: the Turnstile site key while the quick check is on */
export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({ ok: true, turnstileSiteKey: turnstileOn(env) ? turnstileSiteKey(env) : null }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}

// Preflight: the middleware answers OPTIONS for public routes before this runs;
// kept for a direct call. Only the site itself posts here (see originAllowed).
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
