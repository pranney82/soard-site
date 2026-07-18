/**
 * POST /api/create-broadcast
 *
 * Renders a block-based email template and creates a Resend broadcast draft.
 * The admin always reviews & sends from the Resend dashboard.
 *
 *   { preview: true, data: { blocks }, opts }         → returns rendered HTML, no draft
 *   { audienceId, data: { blocks }, opts }            → creates draft in Resend
 *
 * The audience comes from the request body (picked in the admin editor),
 * falling back to the RESEND_AUDIENCE_ID env var. Audience IDs go stale when
 * audiences are deleted/recreated in Resend, so never hardcode one here.
 *
 * GET /api/create-broadcast
 *
 * Returns recent broadcast history from Resend.
 *
 * Authenticated endpoint (behind CF Access).
 *
 * Required env vars: RESEND_API_KEY
 */

import { customTemplate } from './_email-templates.js';
import { logAudit } from './_audit.js';

export async function onRequestPost(context) {
  const { RESEND_API_KEY, RESEND_AUDIENCE_ID, DB } = context.env;

  if (!RESEND_API_KEY) {
    return Response.json({ ok: false, error: 'RESEND_API_KEY is not configured.' }, { status: 503 });
  }

  const body = await context.request.json();
  const { data, opts = {}, preview } = body;

  if (!data || !Array.isArray(data.blocks)) {
    return Response.json({ ok: false, error: 'Missing "data.blocks" — expected an array of block descriptors.' }, { status: 400 });
  }

  const tpl = customTemplate(data, opts);
  const name = opts.name || tpl.subject || 'Custom Broadcast';

  // Preview mode: return HTML without creating broadcast
  if (preview) {
    return Response.json({ ok: true, name, subject: tpl.subject, previewHtml: tpl.html });
  }

  const audienceId = body.audienceId || RESEND_AUDIENCE_ID;
  if (!audienceId) {
    return Response.json({ ok: false, error: 'No audience selected. Pick an audience in the editor before pushing to Resend.' }, { status: 400 });
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
      // Log the upstream detail server-side; return a generic message so raw
      // Resend error bodies never reach the client.
      console.error(`Resend broadcast error ${res.status}:`, JSON.stringify(result));
      return Response.json(
        { ok: false, error: 'Failed to create broadcast. Please try again.' },
        { status: res.status }
      );
    }

    const userEmail = context.data?.userEmail || 'unknown';
    if (DB) {
      await logAudit(DB, {
        userEmail,
        action: 'create',
        entityType: 'email-broadcast',
        entitySlug: result.id,
        entityName: name,
        changes: [
          { field: 'subject', from: null, to: tpl.subject },
          { field: 'blocks', from: null, to: `${data.blocks.length}` },
          { field: 'audience', from: null, to: audienceId },
        ],
        path: null,
        gitStatus: 'draft',
      });
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

// GET — List recent broadcasts from Resend
export async function onRequestGet(context) {
  const { RESEND_API_KEY } = context.env;

  if (!RESEND_API_KEY) {
    return Response.json({ ok: false, error: 'RESEND_API_KEY is not configured.' }, { status: 503 });
  }

  try {
    const res = await fetch('https://api.resend.com/broadcasts', {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });

    const result = await res.json();

    if (!res.ok) {
      console.error(`Resend list broadcasts error ${res.status}:`, JSON.stringify(result));
      return Response.json({ ok: false, error: 'Failed to fetch broadcasts.' }, { status: res.status });
    }

    const broadcasts = (result.data || []).map(b => ({
      id: b.id,
      name: b.name || '(untitled)',
      status: b.status || 'draft',
      createdAt: b.created_at,
      sentAt: b.sent_at || null,
      subject: b.subject || null,
    }));

    return Response.json({ ok: true, broadcasts });
  } catch (err) {
    console.error('List broadcasts error:', err);
    return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
