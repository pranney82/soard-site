/**
 * POST /api/flush-deploy
 * Triggers a CF Pages deploy via the deploy hook.
 * Called by the admin "Deploy Now" button.
 *
 * Checks for failed GitHub syncs and warns (but doesn't block) — builds read
 * from D1 via prebuild, so GitHub being stale doesn't affect the deployed site.
 * The warning surfaces VCS hygiene issues for the admin.
 *
 * Env vars (any one of these, checked in order — canonical first):
 *   CF_PAGES_DEPLOY_HOOK  — preferred
 *   CF_DEPLOY_HOOK        — legacy alias (kept so old setups keep working)
 *   DEPLOY_HOOK_URL       — generic alias
 */

import { logAudit } from './_audit.js';

const HOOK_ENV_VARS = ['CF_PAGES_DEPLOY_HOOK', 'CF_DEPLOY_HOOK', 'DEPLOY_HOOK_URL'];

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
    const hook = HOOK_ENV_VARS.map((k) => context.env[k]).find(Boolean);
    if (!hook) {
      return Response.json(
        { success: false, error: `Deploy hook not configured — set one of: ${HOOK_ENV_VARS.join(', ')}` },
        { status: 503 }
      );
    }

    // Check for failed GitHub syncs since last deploy (informational, non-blocking).
    let failedSyncs = 0;
    try {
      const lastDeploy = await DB.prepare(
        `SELECT created_at FROM audit_log WHERE action = 'deployed' AND git_status IS NULL ORDER BY created_at DESC LIMIT 1`
      ).first();

      const since = lastDeploy?.created_at || '2000-01-01';
      const failed = await DB.prepare(
        `SELECT COUNT(*) as count FROM audit_log WHERE git_status = 'failed' AND created_at > ?`
      ).bind(since).first();

      failedSyncs = failed?.count || 0;
    } catch (e) {
      // Don't let audit check failures block deploys
      console.error('[flush-deploy] Audit check error:', e.message);
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
    await logAudit(DB, {
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
    return Response.json({
      success: true,
      message: 'Deploy triggered',
      ...(failedSyncs > 0 ? {
        warning: `${failedSyncs} save(s) failed to sync to GitHub. The deploy will use D1 data (correct), but your GitHub repo is out of date.`,
        failedSyncs,
      } : {}),
    });
  } catch (err) {
    console.error('[flush-deploy]', err);
    return Response.json(
      { success: false, error: err.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}
