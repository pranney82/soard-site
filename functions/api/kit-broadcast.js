/**
 * POST /api/kit-broadcast
 *
 * Renders a block-based email template and creates a DRAFT broadcast in
 * Kit (formerly ConvertKit). Same review-before-send flow as the Resend
 * push: the admin always reviews & sends from the Kit dashboard. Kit
 * drafts default to all active subscribers — narrow the audience in Kit
 * at send time, so there's no audience picker here.
 *
 *   { data: { blocks }, opts }  →  creates draft in Kit
 *
 * GET /api/kit-broadcast           → recent Kit broadcast history
 * GET /api/kit-broadcast?check=1   → { ok, configured } — no Kit API call
 *
 * Authenticated endpoint (behind CF Access).
 *
 * Required env vars: KIT_API_KEY (set in the Cloudflare dashboard)
 * Optional: KIT_EMAIL_TEMPLATE_ID — see _kit.js
 */

import { customTemplate } from './_email-templates.js';
import { kitConfigured, kitCreateBroadcast, kitListBroadcasts } from './_kit.js';
import { logAudit } from './_audit.js';

export async function onRequestPost(context) {
  const { env } = context;

  if (!kitConfigured(env)) {
    return Response.json({ ok: false, error: 'KIT_API_KEY is not configured.' }, { status: 503 });
  }

  const body = await context.request.json();
  const { data, opts = {} } = body;

  if (!data || !Array.isArray(data.blocks)) {
    return Response.json({ ok: false, error: 'Missing "data.blocks" — expected an array of block descriptors.' }, { status: 400 });
  }

  const tpl = customTemplate(data, opts);
  const name = opts.name || tpl.subject || 'Custom Broadcast';

  // The template embeds Resend's unsubscribe merge tag; Kit uses Liquid.
  const html = tpl.html.replace(/\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/g, '{{ unsubscribe_url }}');

  try {
    const result = await kitCreateBroadcast(env, {
      subject: tpl.subject,
      previewText: opts.preheader || '',
      description: name,
      html,
    });

    if (!result.ok) {
      // Upstream detail is logged in _kit.js; keep the client message generic.
      return Response.json(
        { ok: false, error: 'Failed to create Kit broadcast. Please try again.' },
        { status: result.status || 502 }
      );
    }

    const userEmail = context.data?.userEmail || 'unknown';
    if (env.DB) {
      await logAudit(env.DB, {
        userEmail,
        action: 'create',
        entityType: 'email-broadcast',
        entitySlug: String(result.broadcast?.id ?? ''),
        entityName: name,
        changes: [
          { field: 'subject', from: null, to: tpl.subject },
          { field: 'blocks', from: null, to: `${data.blocks.length}` },
          { field: 'provider', from: null, to: 'kit' },
        ],
        path: null,
        gitStatus: 'draft',
      });
    }

    return Response.json({
      ok: true,
      broadcastId: result.broadcast?.id ?? null,
      name,
      subject: tpl.subject,
      previewHtml: tpl.html,
    });
  } catch (err) {
    console.error('Create Kit broadcast error:', err);
    return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
  }
}

// GET — Kit broadcast history (or a cheap config check with ?check=1)
export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);

  if (url.searchParams.get('check')) {
    return Response.json({ ok: true, configured: kitConfigured(env) });
  }

  if (!kitConfigured(env)) {
    return Response.json({ ok: false, error: 'KIT_API_KEY is not configured.' }, { status: 503 });
  }

  try {
    const result = await kitListBroadcasts(env);
    if (!result.ok) {
      return Response.json({ ok: false, error: 'Failed to fetch Kit broadcasts.' }, { status: result.status || 502 });
    }
    return Response.json({ ok: true, broadcasts: result.broadcasts });
  } catch (err) {
    console.error('List Kit broadcasts error:', err);
    return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
