/**
 * Deploy queue — debounces CF Pages rebuilds across rapid admin edits.
 *
 * Instead of triggering a deploy on every save/delete, edits are batched:
 *   - First edit: records timestamps, no deploy yet
 *   - Subsequent edits: updates last_edit_at
 *   - Deploy fires when: 2 min of quiet OR 10 min since first pending edit
 *
 * Uses the singleton deploy_queue table (id=1) in D1.
 *
 * Flow:
 *   save-content / delete-content
 *     → recordEdit()          // upsert timestamp
 *     → shouldDeploy()        // check thresholds
 *     → if yes: triggerDeploy() + clearQueue()
 *
 * Manual flush: POST /api/flush-deploy calls forceDeploy().
 */

const QUIET_PERIOD_MS = 2 * 60 * 1000;   // 2 minutes of no edits
const MAX_WAIT_MS     = 10 * 60 * 1000;  // 10 minutes max from first edit

/**
 * Record an edit in the deploy queue.
 * Creates the singleton row on first edit, updates last_edit_at on subsequent edits.
 */
export async function recordEdit(DB) {
  const now = new Date().toISOString();
  await DB.prepare(`
    INSERT INTO deploy_queue (id, first_pending_at, last_edit_at)
    VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET last_edit_at = excluded.last_edit_at
  `).bind(now, now).run();
}

/**
 * Check whether a deploy should fire based on queue timestamps.
 * Returns true if: no pending edits exist (nothing to do) → false,
 * or quiet period elapsed, or max wait exceeded.
 */
export async function shouldDeploy(DB) {
  const row = await DB.prepare('SELECT first_pending_at, last_edit_at FROM deploy_queue WHERE id = 1').first();
  if (!row) return false; // no pending edits

  const now = Date.now();
  const firstPending = new Date(row.first_pending_at).getTime();
  const lastEdit = new Date(row.last_edit_at).getTime();

  const quietElapsed = now - lastEdit >= QUIET_PERIOD_MS;
  const maxWaitExceeded = now - firstPending >= MAX_WAIT_MS;

  return quietElapsed || maxWaitExceeded;
}

/**
 * Clear the deploy queue after a deploy is triggered.
 */
export async function clearQueue(DB) {
  await DB.prepare('DELETE FROM deploy_queue WHERE id = 1').run();
}

/**
 * Trigger a Cloudflare Pages deploy via the deploy hook.
 * Requires CF_DEPLOY_HOOK env var (webhook URL from CF Pages settings).
 */
export async function triggerDeploy(env) {
  const hook = env.CF_DEPLOY_HOOK;
  if (!hook) {
    console.warn('[deploy-queue] CF_DEPLOY_HOOK not set — skipping deploy trigger');
    return false;
  }

  const res = await fetch(hook, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[deploy-queue] Deploy hook failed (${res.status}): ${text}`);
    return false;
  }

  console.log('[deploy-queue] Deploy triggered successfully');
  return true;
}

/**
 * Full check-and-deploy cycle. Call this after every edit.
 * Returns true if a deploy was triggered.
 */
export async function checkAndDeploy(env) {
  const { DB } = env;
  if (await shouldDeploy(DB)) {
    const ok = await triggerDeploy(env);
    if (ok) await clearQueue(DB);
    return ok;
  }
  return false;
}

/**
 * Force an immediate deploy regardless of thresholds.
 * Used by POST /api/flush-deploy.
 */
export async function forceDeploy(env) {
  const { DB } = env;
  const ok = await triggerDeploy(env);
  if (ok) await clearQueue(DB);
  return ok;
}
