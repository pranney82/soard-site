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
 * Optional `source` ("newsletter", "application-waitlist", …) becomes a Kit
 * tag so each audience can be emailed on its own. Defaults to "newsletter".
 * JSON:  { "email": "user@example.com", "source": "newsletter" }  →  { "ok": true/false }
 * Form:  standard form POST  →  302 redirect back with ?subscribed=1 or ?newsletter_error=...
 *
 * "application-waitlist" (the Apply page's "tell me when applications open")
 * goes to ./_application-waitlist.js: saved on the site first, then Kit, and
 * emailed the moment applications open. It also takes `lang` (en | es) and
 * `page` (apply | apply-form), and answers { ok, status } where status is
 * 'added' | 'already' | 'open' (open: here's `formUrl`, applications are open now).
 */

import { kitSubscribe } from './_kit.js';
import { recordSignup } from './_application-waitlist.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
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

  try {
    let email, hp, source, lang, page;

    if (contentType.includes('application/json')) {
      ({ email, hp, source, lang, page } = await context.request.json());
    } else {
      const form = await context.request.formData();
      email = form.get('email');
      hp = form.get('website');
      source = form.get('source');
      lang = form.get('lang');
      page = form.get('page');
    }
    source = String(source || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(source)) source = 'newsletter';

    // Honeypot: if the hidden field has a value, it's a bot
    if (hp) {
      if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    email = String(email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'invalid_email' });
      return jsonOk({ ok: false, error: 'Please enter a valid email address.' }, 400);
    }

    if (source === 'application-waitlist' && context.env.DB) {
      let out = null;
      try {
        out = await recordSignup(context.env, { email, lang, page: page === 'apply-form' ? 'apply-form' : 'apply' });
      } catch (err) {
        console.error('Waitlist signup could not be saved on the site; Kit only:', err);
      }
      if (out?.ok) {
        if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1', ...(out.status === 'open' ? { open: '1' } : {}) });
        return jsonOk({ ok: true, status: out.status, confirmed: !!out.confirmed, ...(out.formUrl ? { formUrl: out.formUrl } : {}) });
      }
    }

    const kit = await kitSubscribe(context.env, email, { source });

    if (kit.ok) {
      if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    if (!kit.configured) {
      console.error('KIT_API_KEY is not set');
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'not_configured' });
      return jsonOk({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }, 503);
    }

    // 503, not 502: Cloudflare replaces 502/504 bodies with its own error page,
    // which would hide this JSON from the client.
    if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'server' });
    return jsonOk({ ok: false, error: 'Something went wrong. Please try again.' }, 503);
  } catch (err) {
    console.error('Newsletter handler error:', err);
    if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'server' });
    return jsonOk({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
