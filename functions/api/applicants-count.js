/**
 * GET /api/applicants-count → { success, applied }
 *
 * The sidebar's count on Applications: families still at Applied (the first
 * column of the Applicants board, waiting for a first look), not archived and
 * not a staff test run. One indexed count from D1, no JobTread call; the
 * sidebar asks every few minutes. Behind Cloudflare Access like every admin route.
 */

import { ensureApplicantSchema } from './_applicants.js';

export async function onRequestGet({ env }) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    await ensureApplicantSchema(env.DB);
    const notTest = `NOT EXISTS (SELECT 1 FROM applications p WHERE p.jt_account_id = a.account_id AND p.is_test = 1)`;
    const count = (sql) => env.DB.prepare(sql).first('n');
    const base = "SELECT count(*) AS n FROM applicants a WHERE a.archived_at IS NULL AND a.status = 'Applied'";
    // Before the first form application there's no applications table to rule tests out with
    const applied = await count(`${base} AND ${notTest}`).catch(() => count(base));
    return Response.json({ success: true, applied: applied || 0 }, { headers });
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502 bodies with its own error page
    return Response.json({ success: false, error: err.message }, { status: 500, headers });
  }
}
