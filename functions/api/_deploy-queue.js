/**
 * Deploy Queue — D1-backed debounce for Cloudflare Pages deploy hooks.
 *
 * Instead of firing CF_PAGES_DEPLOY_HOOK on every save/delete, we record
 * a pending deploy in D1 and only fire the hook when:
 *   1. DEBOUNCE_MS of quiet time has passed since the last edit, OR
 *   2. MAX_WAIT_MS has elapsed since the first edit in the current batch
 *      (prevents indefinite deferral during long editing sessions).
 *
 * The queue is a singleton row (id = 1) in the deploy_queue table.
 */

const DEBOUNCE_MS = 6 * 60 * 60 * 1000;  // 6 hours of quiet
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;  // 6 hour hard cap

/**
 * Record that a content change happened and check whether a previously
 * pending deploy is now mature enough to fire.
 *
 * Call this from save-content / delete-content INSTEAD of firing the
 * deploy hook directly.
 *
 * @param {D1Database} db
 * @param {string} deployHookUrl – CF_PAGES_DEPLOY_HOOK value
 * @param {ExecutionContext} ctx – for waitUntil
 */
export async function recordAndFlush(db, deployHookUrl, ctx) {
  if (!deployHookUrl) return;

  const now = new Date().toISOString();

  // 1. Check for a mature pending deploy BEFORE recording the new edit.
  //    This ensures that during a long editing session, earlier batches
  //    still get deployed even if new edits keep arriving.
  await flushIfReady(db, deployHookUrl, ctx);

  // 2. Upsert the pending deploy.
  //    - first_pending_at: only set on INSERT (preserves the batch start).
  //    - last_edit_at: always updated to the current timestamp.
  await db.prepare(`
    INSERT INTO deploy_queue (id, first_pending_at, last_edit_at)
    VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET last_edit_at = excluded.last_edit_at
  `).bind(now, now).run();
}

/**
 * Check the deploy queue and fire the hook if conditions are met.
 * Safe to call frequently — it's a single cheap D1 read in the common case.
 *
 * @param {D1Database} db
 * @param {string} deployHookUrl
 * @param {ExecutionContext} ctx
 * @returns {Promise<boolean>} true if a deploy was fired
 */
export async function flushIfReady(db, deployHookUrl, ctx) {
  if (!deployHookUrl) return false;

  const row = await db.prepare(
    'SELECT first_pending_at, last_edit_at FROM deploy_queue WHERE id = 1'
  ).first();

  if (!row || !row.first_pending_at) return false;

  const now = Date.now();
  const firstPending = new Date(row.first_pending_at).getTime();
  const lastEdit = new Date(row.last_edit_at).getTime();

  const quietPeriodMet = (now - lastEdit) >= DEBOUNCE_MS;
  const maxWaitMet = (now - firstPending) >= MAX_WAIT_MS;

  if (!quietPeriodMet && !maxWaitMet) return false;

  // Conditions met — fire the deploy hook.
  // Clear the queue row FIRST to prevent double-fires from concurrent
  // requests. If the hook call fails, we re-insert so it retries next time.
  await db.prepare(
    'DELETE FROM deploy_queue WHERE id = 1'
  ).run();

  const fireAndForget = async () => {
    try {
      const res = await fetch(deployHookUrl, { method: 'POST' });
      if (!res.ok) throw new Error(`Deploy hook returned ${res.status}`);
    } catch (err) {
      console.error('[deploy-queue] Hook failed, re-queuing:', err.message);
      // Re-insert so the next check retries. Use the original timestamps
      // so the max-wait clock doesn't reset.
      await db.prepare(`
        INSERT OR IGNORE INTO deploy_queue (id, first_pending_at, last_edit_at)
        VALUES (1, ?, ?)
      `).bind(row.first_pending_at, row.last_edit_at).run();
    }
  };

  if (ctx) {
    ctx.waitUntil(fireAndForget());
  } else {
    await fireAndForget();
  }

  return true;
}
