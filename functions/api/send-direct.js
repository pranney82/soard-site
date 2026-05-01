/**
 * POST /api/send-direct
 *
 * Sends a block-based template directly to a small list of typed-in
 * recipients (e.g. reveal-invite RSVPs to family + sponsors). Each recipient
 * gets their own copy with their address in the To: line — not BCC, not
 * the broadcast audience. Use this for one-off invites where the audience
 * is known by name, not pulled from the newsletter list.
 *
 * Body:
 *   {
 *     recipients: ['a@b.com', 'c@d.com', ...],   // up to 100
 *     data: { blocks },
 *     opts: { subject, preheader, name, from? }
 *   }
 *
 * Authenticated endpoint (behind CF Access).
 *
 * Required env: RESEND_API_KEY
 */

import { customTemplate } from './_email-templates.js';

const MAX_RECIPIENTS = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost(context) {
  const { RESEND_API_KEY } = context.env;
  if (!RESEND_API_KEY) {
    return Response.json({ ok: false, error: 'RESEND_API_KEY is not configured.' }, { status: 503 });
  }

  let body;
  try { body = await context.request.json(); }
  catch { return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 }); }

  const { recipients, data, opts = {} } = body;

  if (!Array.isArray(recipients) || !recipients.length) {
    return Response.json({ ok: false, error: 'Provide at least one recipient.' }, { status: 400 });
  }
  if (!data || !Array.isArray(data.blocks)) {
    return Response.json({ ok: false, error: 'Missing "data.blocks" — expected an array of block descriptors.' }, { status: 400 });
  }

  // Dedupe + validate
  const cleaned = Array.from(new Set(recipients.map(s => String(s).trim().toLowerCase()).filter(Boolean)));
  const invalid = cleaned.filter(e => !EMAIL_RE.test(e));
  if (invalid.length) {
    return Response.json({ ok: false, error: `Invalid email${invalid.length === 1 ? '' : 's'}: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}` }, { status: 400 });
  }
  if (cleaned.length > MAX_RECIPIENTS) {
    return Response.json({ ok: false, error: `Too many recipients (max ${MAX_RECIPIENTS}). Got ${cleaned.length}.` }, { status: 400 });
  }

  const tpl = customTemplate(data, opts);

  // No broadcast unsubscribe URL for direct sends — Resend only resolves it
  // for /broadcasts. Strip the merge tag so the link doesn't render literally.
  const html = tpl.html.replace(/\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/g, '#');

  // Use Resend's batch endpoint — one HTTP call, up to 100 emails.
  // Each entry is a separate email (own To:), not a single BCC blast.
  const batch = cleaned.map(to => ({
    from: tpl.from,
    to: [to],
    subject: tpl.subject,
    html,
  }));

  try {
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
    });

    const result = await res.json();

    if (!res.ok) {
      console.error(`Resend batch send error ${res.status}:`, JSON.stringify(result));
      return Response.json(
        { ok: false, error: result.message || 'Failed to send.', details: result },
        { status: res.status }
      );
    }

    return Response.json({ ok: true, count: cleaned.length, ids: (result.data || []).map(r => r.id) });
  } catch (err) {
    console.error('Send direct error:', err);
    return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
