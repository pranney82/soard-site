/**
 * POST /api/mercury-webhook — Mercury's transaction events (see ./_spend.js)
 * Public (in _middleware's PUBLIC_ROUTES): the Mercury-Signature is checked
 * inside against the secret Mercury gave the site when it registered the
 * webhook, and nothing is done for a request that fails it.
 */

import { handleWebhook } from './_spend.js';

export async function onRequestPost(context) {
  // The job's ledger rebuilds after the answer: Mercury gives up after 5 seconds
  return handleWebhook(context.env, context.request, { after: (p) => context.waitUntil(p) });
}

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'mercury-webhook', method: 'POST' });
}
