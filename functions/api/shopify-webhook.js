/**
 * POST /api/shopify-webhook
 *
 * Receives Shopify webhooks (product/collection changes) and triggers
 * a Cloudflare Pages rebuild via deploy hook.
 *
 * SETUP:
 *   1. Create a CF Pages deploy hook in the dashboard:
 *      Settings → Builds & Deployments → Deploy Hooks → Add → name "shopify"
 *      Copy the URL, save it as CF_DEPLOY_HOOK_URL env var.
 *
 *   2. In Shopify admin → Settings → Notifications → Webhooks:
 *      Add webhooks for these topics pointing to
 *      https://sunshineonaranneyday.com/api/shopify-webhook
 *        - products/create
 *        - products/update
 *        - products/delete
 *        - collections/create
 *        - collections/update
 *        - collections/delete
 *
 *   3. Copy the webhook signing secret from Shopify, save as
 *      SHOPIFY_WEBHOOK_SECRET env var in CF Pages.
 *
 * ENV VARS:
 *   CF_DEPLOY_HOOK_URL      — CF Pages deploy hook URL
 *   SHOPIFY_WEBHOOK_SECRET  — Shopify webhook HMAC signing secret (optional but recommended)
 */

export async function onRequestPost({ request, env }) {
  const hookUrl = env.CF_DEPLOY_HOOK_URL;

  if (!hookUrl) {
    console.error('[shopify-webhook] CF_DEPLOY_HOOK_URL not configured');
    return new Response(JSON.stringify({ error: 'Webhook not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Verify Shopify HMAC signature (if secret is configured) ──
  const secret = env.SHOPIFY_WEBHOOK_SECRET;
  if (secret) {
    const hmacHeader = request.headers.get('X-Shopify-Hmac-SHA256');
    if (!hmacHeader) {
      return new Response(JSON.stringify({ error: 'Missing HMAC signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.clone().arrayBuffer();
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, body);
    const computed = btoa(String.fromCharCode(...new Uint8Array(signature)));

    if (computed !== hmacHeader) {
      console.error('[shopify-webhook] HMAC verification failed');
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ── Log the webhook topic for debugging ──
  const topic = request.headers.get('X-Shopify-Topic') || 'unknown';
  console.log(`[shopify-webhook] Received: ${topic}`);

  // ── Trigger CF Pages rebuild ──
  try {
    const deployRes = await fetch(hookUrl, { method: 'POST' });

    if (!deployRes.ok) {
      const text = await deployRes.text();
      console.error(`[shopify-webhook] Deploy hook failed: ${deployRes.status} ${text}`);
      return new Response(JSON.stringify({ error: 'Deploy trigger failed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`[shopify-webhook] Rebuild triggered for: ${topic}`);
    return new Response(JSON.stringify({ ok: true, topic, message: 'Rebuild triggered' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[shopify-webhook] Error triggering deploy:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
