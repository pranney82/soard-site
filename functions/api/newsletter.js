/**
 * POST /api/newsletter
 *
 * Adds an email to the Constant Contact mailing list via their v3 API.
 *
 * Required Cloudflare Pages env vars:
 *   CC_API_TOKEN  — Constant Contact API key (v3)
 *   CC_LIST_ID    — UUID of the contact list to add subscribers to
 *
 * Request body: { "email": "user@example.com" }
 * Response:     { "ok": true } or { "ok": false, "error": "..." }
 */

export async function onRequestPost(context) {
  try {
    const { email } = await context.request.json();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Please enter a valid email address.' }),
        { status: 400 }
      );
    }

    const token = context.env.CC_API_TOKEN;
    const listId = context.env.CC_LIST_ID;

    if (!token || !listId) {
      console.error('Missing CC_API_TOKEN or CC_LIST_ID env vars');
      return new Response(
        JSON.stringify({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }),
        { status: 503 }
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
        { status: 200 }
      );
    }

    const errBody = await res.text();
    console.error(`CC API error ${res.status}: ${errBody}`);
    return new Response(
      JSON.stringify({ ok: false, error: 'Something went wrong. Please try again.' }),
      { status: 502 }
    );
  } catch (err) {
    console.error('Newsletter handler error:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'Something went wrong. Please try again.' }),
      { status: 500 }
    );
  }
}

// Handle CORS preflight
,
  });
}
