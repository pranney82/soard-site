/**
 * POST /api/live-click — count a click on the live banner
 * ========================================================
 * Fired via navigator.sendBeacon when a visitor clicks "Watch" on the
 * live pill. Increments the clicks counter inside the live-status record
 * atomically (SQLite json_set — no read-modify-write race). The count
 * shows on the admin Go Live page and is written to the audit log when
 * the broadcast ends.
 *
 * Public + rate-limited via middleware (5/min/IP). Always returns 204 —
 * analytics must never surface an error to the visitor.
 *
 * Env bindings: DB (D1)
 */

const CONFIG_KEY = 'live-status';

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
    await DB.prepare(
      `UPDATE site_config
       SET data = json_set(data, '$.clicks', COALESCE(json_extract(data, '$.clicks'), 0) + 1)
       WHERE key = ? AND json_extract(data, '$.enabled') = 1`
    ).bind(CONFIG_KEY).run();
  } catch {
    // swallow — a lost click is not worth a console error on the visitor's page
  }
  return new Response(null, { status: 204 });
}
