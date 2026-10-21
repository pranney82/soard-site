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
 * Authenticated endpoint (behind CF Access). Sends through the site's
 * one-off sender (_broadcast-notify.js), not Kit.
 */

import { customTemplate, fillMergeTags } from './_email-templates.js';
import { sendEmailItems, emailConfigured } from './_broadcast-notify.js';

const MAX_RECIPIENTS = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost(context) {
  const { env } = context;
  if (!emailConfigured(env)) {
    return Response.json({ ok: false, error: 'Email sending is not configured.' }, { status: 503 });
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

  // The reveal invite's calendar link is signed with the server's secret, never one from the request
  const tpl = customTemplate(data, opts, { calendarSecret: env.CALENDAR_LINK_SECRET || '' });

  // Direct sends aren't list mail: merge tags get plain values (no
  // unsubscribe link), and each copy carries its recipient's own address.
  const items = cleaned.map(to => ({
    to,
    subject: fillMergeTags(tpl.subject, { email: to }),
    html: fillMergeTags(tpl.html, { email: to }),
  }));

  try {
    const r = await sendEmailItems(env, items, { from: tpl.from });

    if (r.failed) {
      // Log the upstream detail server-side; keep the client message generic.
      console.error('Direct send error:', r.errors.join('; '));
      return Response.json(
        { ok: false, error: r.sent ? `Sent to ${r.sent} of ${cleaned.length}. The rest failed, please try them again.` : 'Failed to send. Please try again.' },
        { status: 500 }
      );
    }

    return Response.json({ ok: true, count: r.sent });
  } catch (err) {
    console.error('Send direct error:', err);
    return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
