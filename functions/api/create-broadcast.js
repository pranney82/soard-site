/**
 * POST /api/create-broadcast
 *
 * Generates an on-brand email from a template + kid/data, then creates
 * a Resend broadcast draft. Returns the broadcast ID so the admin can
 * link to Resend to review and send.
 *
 * Authenticated endpoint (behind CF Access).
 *
 * Required env vars: RESEND_API_KEY, RESEND_AUDIENCE_ID
 *
 * Request body:
 *   { "template": "reveal"|"kickoff"|"monthly", "kid": {...}, "data": {...}, "opts": {...} }
 */

import { projectReveal, projectKickoff, monthlyImpact } from './_email-templates.js';

export async function onRequestPost(context) {
  const { RESEND_API_KEY, RESEND_AUDIENCE_ID } = context.env;

  if (!RESEND_API_KEY) {
    return Response.json({ ok: false, error: 'RESEND_API_KEY is not configured.' }, { status: 503 });
  }

  const audienceId = RESEND_AUDIENCE_ID || '02c95b02-54d6-4d45-851b-90058fd81f4d';

  const body = await context.request.json();
  const { template, kid, data, opts = {} } = body;

  if (!template) {
    return Response.json({ ok: false, error: 'Missing "template" field.' }, { status: 400 });
  }

  let tpl;
  switch (template) {
    case 'reveal':
      if (!kid) return Response.json({ ok: false, error: 'Missing "kid" for reveal template.' }, { status: 400 });
      tpl = projectReveal(kid, opts);
      break;
    case 'kickoff':
      if (!kid) return Response.json({ ok: false, error: 'Missing "kid" for kickoff template.' }, { status: 400 });
      tpl = projectKickoff(kid, opts);
      break;
    case 'monthly':
      if (!data) return Response.json({ ok: false, error: 'Missing "data" for monthly template.' }, { status: 400 });
      tpl = monthlyImpact(data, opts);
      break;
    default:
      return Response.json({ ok: false, error: `Unknown template: ${template}` }, { status: 400 });
  }

  // Build a friendly name for the broadcast
  const name = template === 'monthly'
    ? `Monthly Update — ${data.month || 'Unknown'}`
    : `${kid.name} — ${template === 'reveal' ? 'Project Reveal' : 'Project Kickoff'}`;

  // Preview mode: return HTML without creating broadcast
  if (body.preview) {
    return Response.json({
      ok: true,
      name,
      subject: tpl.subject,
      previewHtml: tpl.html,
    });
  }

  try {
    const res = await fetch('https://api.resend.com/broadcasts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audience_id: audienceId,
        from: tpl.from,
        subject: tpl.subject,
        html: tpl.html,
        name,
      }),
    });

    const result = await res.json();

    if (!res.ok) {
      console.error(`Resend broadcast error ${res.status}:`, JSON.stringify(result));
      return Response.json(
        { ok: false, error: result.message || 'Failed to create broadcast.', details: result },
        { status: res.status }
      );
    }

    return Response.json({
      ok: true,
      broadcastId: result.id,
      name,
      subject: tpl.subject,
      previewHtml: tpl.html,
    });
  } catch (err) {
    console.error('Create broadcast error:', err);
    return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
