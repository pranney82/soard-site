/**
 * POST /api/newsletter
 *
 * Adds an email to the Constant Contact mailing list via their v3 API.
 *
 * Required Cloudflare Pages env vars:
 *   CC_API_TOKEN  — Constant Contact API access token (v3)
 *
 * List ID source (in priority order):
 *   1. CC_LIST_ID env var (override)
 *   2. newsletter.listId from site settings (set via admin panel)
 *
 * Request body: { "email": "user@example.com" }
 * Response:     { "ok": true } or { "ok": false, "error": "..." }
 */

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const { email } = await context.request.json();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Please enter a valid email address.' }),
        { status: 400, headers: cors }
      );
    }

    const token = context.env.CC_API_TOKEN;
    if (!token) {
      console.error('Missing CC_API_TOKEN env var');
      return new Response(
        JSON.stringify({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }),
        { status: 503, headers: cors }
      );
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
      return new Response(
        JSON.stringify({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }),
        { status: 503, headers: cors }
      );
    }

    const res = await fetch('https://api.cc.email/v3/contacts/sign_up_form', {
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

    if (res.ok || res.status === 409) {
      // 409 = already subscribed, still a success from the user's perspective
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: cors }
      );
    }

    const errBody = await res.text();
    console.error(`CC API error ${res.status}: ${errBody}`);
    return new Response(
      JSON.stringify({ ok: false, error: 'Something went wrong. Please try again.' }),
      { status: 502, headers: cors }
    );
  } catch (err) {
    console.error('Newsletter handler error:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'Something went wrong. Please try again.' }),
      { status: 500, headers: cors }
    );
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
