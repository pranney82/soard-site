/**
 * POST /api/flush-deploy
 * Checks the deploy queue and fires the CF Pages deploy hook if the
 * debounce conditions are met (2 min quiet OR 10 min max wait).
 *
 * Called by the admin panel on a polling interval to ensure the last
 * edit in a session always gets deployed — even if no further saves occur.
 *
 * GET is also supported so the admin can poll cheaply.
 *
 * Env bindings: DB (D1)
 * Env vars: CF_PAGES_DEPLOY_HOOK
 */

import { flushIfReady } from './_deploy-queue.js';

async function handleFlush(context) {
  const { DB, CF_PAGES_DEPLOY_HOOK } = context.env;

  if (!CF_PAGES_DEPLOY_HOOK) {
    return Response.json({ flushed: false, reason: 'no deploy hook configured' });
  }

  const fired = await flushIfReady(DB, CF_PAGES_DEPLOY_HOOK, context);

  return Response.json({ flushed: fired });
}

export const onRequestPost = handleFlush;
export const onRequestGet = handleFlush;
