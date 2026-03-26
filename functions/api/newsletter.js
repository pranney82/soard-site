/**
 * POST /api/newsletter
 *
 * Adds an email to the Constant Contact mailing list via their v3 API.
 *
 * Required Cloudflare Pages env vars:
 *   CC_CLIENT_ID, CC_CLIENT_SECRET, CC_REFRESH_TOKEN
 *
 * List ID source (in priority order):
 *   1. CC_LIST_ID env var (override)
 *   2. newsletter.listId from site settings (set via admin panel)
 *
 * Accepts both JSON (JS-enhanced) and form-encoded (no-JS fallback) POSTs.
 * JSON:  { "email": "user@example.com" }  →  { "ok": true/false }
 * Form:  standard form POST  →  302 redirect back with ?subscribed=1 or ?newsletter_error=...
 */

import { getCCAccessToken, clearCCTokenCache, CCAuthError } from './_cc-auth.js';

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
    // Only allow same-origin redirects to prevent open redirect
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
    let email, hp;

    if (contentType.includes('application/json')) {
      ({ email, hp } = await context.request.json());
    } else {
      const form = await context.request.formData();
      email = form.get('email');
      hp = form.get('website');
    }

    // Honeypot: if the hidden field has a value, it's a bot
    if (hp) {
      // Silently accept to avoid tipping off the bot
      if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'invalid_email' });
      return jsonOk({ ok: false, error: 'Please enter a valid email address.' }, 400);
    }

    let token;
    try {
      token = await getCCAccessToken(context.env);
    } catch (err) {
      if (err instanceof CCAuthError) {
        console.error(err.message);
        if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'not_configured' });
        return jsonOk({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }, 503);
      }
      throw err;
    }

    // Resolve list ID: env var takes priority, then static config from admin
    let listId = context.env.CC_LIST_ID || '';
    if (!listId) {
      try {
        const configRes = await context.env.ASSETS.fetch(
          new URL('/newsletter-config.json', context.request.url)
        );
        if (configRes.ok) {
          const config = await configRes.json();
          listId = config.listId || '';
        }
      } catch (e) {
        console.error('Failed to read newsletter config:', e);
      }
    }

    if (!listId) {
      console.error('No CC_LIST_ID env var or newsletter.listId in settings');
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'not_configured' });
      return jsonOk({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }, 503);
    }

    let res = await fetch('https://api.cc.email/v3/contacts/sign_up_form', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email_address: email,
        list_memberships: [listId],
      }),
    });

    // If 401, clear cache and retry once with a fresh token
    if (res.status === 401) {
      clearCCTokenCache();
      token = await getCCAccessToken(context.env);
      res = await fetch('https://api.cc.email/v3/contacts/sign_up_form', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email_address: email,
          list_memberships: [listId],
        }),
      });
    }

    if (res.ok || res.status === 409) {
      // 409 = already subscribed, still a success from the user's perspective
      if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    const errBody = await res.text();
    console.error(`CC API error ${res.status}: ${errBody}`);
    if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'server' });
    return jsonOk({ ok: false, error: 'Something went wrong. Please try again.' }, 502);
  } catch (err) {
    if (err instanceof CCAuthError) {
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'not_configured' });
      return jsonOk({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }, 503);
    }
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
