/**
 * POST /api/flush-deploy
 * Triggers a CF Pages deploy via the deploy hook.
 * Called by the admin "Deploy Now" button.
 *
 * Env vars: CF_PAGES_DEPLOY_HOOK (CF Pages deploy hook URL)
 */

import { logAudit } from './_audit.js';

export async function onRequestPost(context) {
  try {
    const hook = context.env.CF_PAGES_DEPLOY_HOOK;
    if (!hook) {
      return Response.json(
        { success: false, error: 'Deploy hook not configured — set CF_PAGES_DEPLOY_HOOK env var' },
        { status: 503 }
      );
    }

    const res = await fetch(hook, { method: 'POST' });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[flush-deploy] Deploy hook failed (${res.status}): ${text}`);
      return Response.json(
        { success: false, error: `Deploy hook failed (${res.status})` },
        { status: 502 }
      );
    }

    // Log who triggered the deploy
    const userEmail = context.data?.userEmail;
    await logAudit(context.env.DB, {
      userEmail,
      action: 'deployed',
      entityType: 'site',
      entitySlug: null,
      entityName: 'Production Deploy',
      changes: null,
      path: '/api/flush-deploy',
      gitStatus: null,
    });

    console.log(`[flush-deploy] Deploy triggered by ${userEmail || 'unknown'}`);
    return Response.json({ success: true, message: 'Deploy triggered' });
  } catch (err) {
    console.error('[flush-deploy]', err);
    return Response.json(
      { success: false, error: err.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}
