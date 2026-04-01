/**
 * POST /api/send-email
 *
 * Sends an email via the Resend API. Authenticated endpoint (behind CF Access).
 *
 * Required Cloudflare Pages env vars:
 *   RESEND_API_KEY  — Resend API key
 *
 * Request body (JSON):
 *   { "to": ["email@example.com"], "subject": "...", "html": "...", "from": "..." }
 *
 * Or use a preset template:
 *   { "template": "adrian-2025", "to": ["email@example.com"] }
 */

import { getEmailTemplate } from './_email-templates.js';

export async function onRequestPost(context) {
  const { RESEND_API_KEY } = context.env;

  if (!RESEND_API_KEY) {
    return Response.json(
      { ok: false, error: 'RESEND_API_KEY is not configured.' },
      { status: 503 }
    );
  }

  const body = await context.request.json();
  let { to, subject, html, from, template } = body;

  // If a named template is requested, load it
  if (template) {
    const tpl = getEmailTemplate(template);
    if (!tpl) {
      return Response.json(
        { ok: false, error: `Unknown template: ${template}` },
        { status: 400 }
      );
    }
    subject = subject || tpl.subject;
    html = tpl.html;
    from = from || tpl.from;
  }

  if (!to || !Array.isArray(to) || to.length === 0) {
    return Response.json({ ok: false, error: 'Missing "to" array.' }, { status: 400 });
  }
  if (!subject || !html) {
    return Response.json({ ok: false, error: 'Missing "subject" or "html".' }, { status: 400 });
  }

  from = from || 'Sunshine on a Ranney Day <sunshine@comms.soardcharity.com>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`Resend API error ${res.status}:`, JSON.stringify(data));
      return Response.json(
        { ok: false, error: data.message || 'Failed to send email.', details: data },
        { status: res.status }
      );
    }

    return Response.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('Send email error:', err);
    return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
