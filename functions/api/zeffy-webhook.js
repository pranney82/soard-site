/**
 * POST /api/zeffy-webhook — Zeffy's payment.completed webhook
 * ============================================================
 * Public (in _middleware's PUBLIC_ROUTES): Zeffy's signature is checked inside
 * against ZEFFY_WEBHOOK_SECRET, and only a signed payment.completed posts
 * anything. See ./_zeffy.js for the post and the catch-up check behind it.
 *
 * Set up in Zeffy → Settings → Integrations → Webhook (organization owner):
 * URL https://sunshineonaranneyday.com/api/zeffy-webhook, event payment.completed.
 */

import { handleWebhook } from './_zeffy.js';

export async function onRequestPost(context) {
  try {
    return await handleWebhook(context.env, context.request);
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502 bodies with its own error page. Zeffy retries.
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'zeffy-webhook', method: 'POST', event: 'payment.completed' });
}
