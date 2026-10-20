/**
 * POST /api/reveal-invites (public) — wake-up call from SOARD JobTread
 * workflows: { jobId }. Everything is re-read from JobTread before the
 * calendar is touched (see ./_reveal-invites.js), so the body is untrusted.
 * Responses never include guests, addresses or event details.
 */

import { reconcileJob } from './_reveal-invites.js';
import { syncBroadcastSchedule } from './_broadcast-schedule.js';
import { syncKidStatuses } from './_kid-status.js';

export async function onRequestPost(context) {
  let body = {};
  try { body = await context.request.json(); } catch { /* empty */ }
  const jobId = String(body.jobId || '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(jobId)) return Response.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  try {
    // The kid's status on the site follows the job (a status change, the Reveal task done)
    context.waitUntil(syncKidStatuses(context.env, { jobId }));
    const r = await reconcileJob(context.env, jobId);
    // Confirmed, status or the Reveal task changed: the live countdown follows right away.
    // A construction task finishing can't move the countdown, so it doesn't force a check.
    if (body.source !== 'construction') context.waitUntil(syncBroadcastSchedule(context.env, { force: true }));
    return Response.json({ ok: r.action !== 'error', action: r.action, ...(r.reason ? { reason: r.reason } : {}) });
  } catch (err) {
    // 500, not 502: Cloudflare swaps 502 bodies for its own error page
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
