/**
 * POST /api/send-test-email
 *
 * Renders a block-based template and sends it as a one-off email to a single
 * address — for QA before pushing the broadcast to Kit.
 *
 * Body:
 *   { testEmail?: 'user@example.com', data: { blocks }, opts }  (no testEmail: the signed-in admin)
 *
 * Authenticated endpoint (behind CF Access). Sends through the site's
 * one-off sender (_broadcast-notify.js), not Kit.
 */

import { customTemplate, fillMergeTags } from './_email-templates.js';
import { sendEmails, emailConfigured } from './_broadcast-notify.js';

export async function onRequestPost(context) {
  const { env } = context;

  if (!emailConfigured(env)) {
    return Response.json({ ok: false, error: 'Email sending is not configured.' }, { status: 503 });
  }

  const body = await context.request.json();
  const { data, opts = {} } = body;
  // No address means "Send it to me": the person signed in to the admin
  const testEmail = String(body.testEmail || context.data?.userEmail || '').trim();

  if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
    return Response.json({ ok: false, error: 'That isn’t an email address.' }, { status: 400 });
  }

  if (!data || !Array.isArray(data.blocks)) {
    return Response.json({ ok: false, error: 'Missing "data.blocks" — expected an array of block descriptors.' }, { status: 400 });
  }

  // The reveal invite's calendar link is signed with the server's secret, never one from the request
  const tpl = customTemplate(data, opts, { calendarSecret: env.CALENDAR_LINK_SECRET || '' });

  // A test copy isn't sent to the list, so merge tags get plain values
  const fill = (s) => fillMergeTags(s, { email: testEmail });

  try {
    const r = await sendEmails(env, {
      to: [testEmail],
      from: tpl.from,
      subject: `[TEST] ${fill(tpl.subject)}`,
      html: fill(tpl.html),
      tags: [{ name: 'type', value: 'email-test' }],
    });

    if (!r.sent) {
      // Log the upstream detail server-side; keep the client message generic.
      console.error('Test send error:', r.errors.join('; '));
      return Response.json({ ok: false, error: 'Failed to send test email. Please try again.' }, { status: 500 });
    }

    return Response.json({ ok: true, to: testEmail });
  } catch (err) {
    console.error('Send test email error:', err);
    return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
