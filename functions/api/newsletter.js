/**
 * POST /api/newsletter
 *
 * Adds an email to a Resend Audience via their API.
 *
 * Required Cloudflare Pages env vars:
 *   RESEND_API_KEY
 *
 * Audience ID source (in priority order):
 *   1. RESEND_AUDIENCE_ID env var (override)
 *   2. newsletter.audienceId from site settings (set via admin panel)
 *
 * Accepts both JSON (JS-enhanced) and form-encoded (no-JS fallback) POSTs.
 * JSON:  { "email": "user@example.com" }  →  { "ok": true/false }
 * Form:  standard form POST  →  302 redirect back with ?subscribed=1 or ?newsletter_error=...
 */

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
      if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'invalid_email' });
      return jsonOk({ ok: false, error: 'Please enter a valid email address.' }, 400);
    }

    const apiKey = context.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error('RESEND_API_KEY is not set');
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'not_configured' });
      return jsonOk({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }, 503);
    }

    // Resolve audience ID: env var takes priority, then static config from admin
    let audienceId = context.env.RESEND_AUDIENCE_ID || '';
    if (!audienceId) {
      try {
        const configRes = await context.env.ASSETS.fetch(
          new URL('/newsletter-config.json', context.request.url)
        );
        if (configRes.ok) {
          const config = await configRes.json();
          audienceId = config.audienceId || '';
        }
      } catch (e) {
        console.error('Failed to read newsletter config:', e);
      }
    }

    if (!audienceId) {
      console.error('No RESEND_AUDIENCE_ID env var or newsletter.audienceId in settings');
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'not_configured' });
      return jsonOk({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }, 503);
    }

    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });

    if (res.ok) {
      if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    // Resend returns 409 if contact already exists — still a success for the user
    if (res.status === 409) {
      if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    const errBody = await res.text();
    console.error(`Resend API error ${res.status}: ${errBody}`);
    if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'server' });
    return jsonOk({ ok: false, error: 'Something went wrong. Please try again.' }, 502);
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
