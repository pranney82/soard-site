/**
 * POST /api/newsletter
 *
 * Adds an email to the Constant Contact mailing list via their v3 API.
 * Protected by Cloudflare Turnstile to prevent bot signups.
 *
 * Required Cloudflare Pages env vars:
 *   CC_API_TOKEN          — Constant Contact API key (v3)
 *   CC_LIST_ID            — UUID of the contact list to add subscribers to
 *   TURNSTILE_SECRET_KEY  — Cloudflare Turnstile secret key (required)
 *
 * Request body: { "email": "user@example.com", "turnstileToken": "..." }
 * Response:     { "ok": true } or { "ok": false, "error": "..." }
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function onRequestPost(context) {
  try {
    const { email, turnstileToken } = await context.request.json();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json(
        { ok: false, error: 'Please enter a valid email address.' },
        { status: 400 }
      );
    }

    // ── Turnstile bot protection ──────────────────────────────────
    const turnstileSecret = context.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      if (!turnstileToken) {
        return Response.json(
          { ok: false, error: 'Bot verification failed. Please try again.' },
          { status: 403 }
        );
      }

      const ip = context.request.headers.get('CF-Connecting-IP') || '';
      const verifyRes = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: turnstileSecret,
          response: turnstileToken,
          remoteip: ip,
        }),
      });

      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        console.error('[newsletter] Turnstile verification failed:', verifyData['error-codes']);
        return Response.json(
          { ok: false, error: 'Bot verification failed. Please try again.' },
          { status: 403 }
        );
      }
    } else {
      console.warn('[newsletter] TURNSTILE_SECRET_KEY not set — skipping bot protection');
    }

    // ── Constant Contact signup ───────────────────────────────────
    const token = context.env.CC_API_TOKEN;
    const listId = context.env.CC_LIST_ID;

    if (!token || !listId) {
      console.error('[newsletter] Missing CC_API_TOKEN or CC_LIST_ID env vars');
      return Response.json(
        { ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' },
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
      return Response.json({ ok: true }, { status: 200 });
    }

    const errBody = await res.text();
    console.error(`[newsletter] CC API error ${res.status}: ${errBody}`);
    return Response.json(
      { ok: false, error: 'Something went wrong. Please try again.' },
      { status: 502 }
    );
  } catch (err) {
    console.error('[newsletter]', err);
    return Response.json(
      { ok: false, error: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }
}
