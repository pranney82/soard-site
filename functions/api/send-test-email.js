/**
 * POST /api/send-test-email
 *
 * Renders a block-based template and sends it as a one-off email to a single
 * address — for QA before pushing the broadcast to Resend.
 *
 * Body:
 *   { testEmail: 'user@example.com', data: { blocks }, opts }
 *
 * Authenticated endpoint (behind CF Access).
 *
 * Required env vars: RESEND_API_KEY
 */

import { customTemplate } from './_email-templates.js';

export async function onRequestPost(context) {
  const { RESEND_API_KEY } = context.env;

  if (!RESEND_API_KEY) {
    return Response.json({ ok: false, error: 'RESEND_API_KEY is not configured.' }, { status: 503 });
  }

  const body = await context.request.json();
  const { testEmail, data, opts = {} } = body;

  if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
    return Response.json({ ok: false, error: 'Please provide a valid test email address.' }, { status: 400 });
  }

  if (!data || !Array.isArray(data.blocks)) {
    return Response.json({ ok: false, error: 'Missing "data.blocks" — expected an array of block descriptors.' }, { status: 400 });
  }

  const tpl = customTemplate(data, opts);

  // Strip the broadcast-only unsubscribe merge tag for test sends — Resend
  // only resolves {{{RESEND_UNSUBSCRIBE_URL}}} for broadcasts, not /emails.
  const html = tpl.html.replace(/\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/g, '#');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: tpl.from,
        to: [testEmail],
        subject: `[TEST] ${tpl.subject}`,
        html,
      }),
    });

    const result = await res.json();

    if (!res.ok) {
      console.error(`Resend test send error ${res.status}:`, JSON.stringify(result));
      return Response.json(
        { ok: false, error: result.message || 'Failed to send test email.', details: result },
        { status: res.status }
      );
    }

    return Response.json({ ok: true, id: result.id, to: testEmail });
  } catch (err) {
    console.error('Send test email error:', err);
    return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
