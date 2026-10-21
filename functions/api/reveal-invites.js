/**
 * POST /api/reveal-invites (public) — wake-up call from SOARD JobTread
 * workflows: { jobId, eventId }. The event must be a change JobTread logged
 * on that job in the last 15 minutes, and everything is re-read from JobTread
 * before the calendar is touched (see ./_reveal-invites.js), so the body is
 * untrusted. A few verified wake-ups a minute per job do the work; past that
 * the job is owed a look on the next heartbeat (admitWake). The answer is
 * { ok } and nothing more: never guests, addresses, event details or what
 * JobTread says about the job.
 *
 * With JOBTREAD_WEBHOOK_SECRET set, the workflow must send it (?key=… on the
 * URL or an X-Webhook-Secret header). Turning it on, in this order (none of
 * the workflows send it yet):
 *   1. add the X-Webhook-Secret header (or ?key=) to all 7 SOARD JobTread
 *      workflows that wake the site: these four "… → Site reveal invites",
 *      the two "… → Site reveal date sync" and "Applicant Status/Diagnosis →
 *      Site applicant messages". The site ignores it while the variable is unset.
 *   2. then set JOBTREAD_WEBHOOK_SECRET in Cloudflare Pages and redeploy.
 * The other way round, every wake-up is refused (401) until step 1 is done.
 * Until then anyone can call this, so each address gets PER_IP calls a minute
 * before JobTread is asked anything.
 *
 * Busy (another update to the same invite is running) answers 200 with the
 * job owed a look: whether JobTread's workflows retry a non-2xx answer isn't
 * documented, and the owed look doesn't depend on it.
 */

import { verifiedJobEvent, admitWake, oweWake, reconcileJob } from './_reveal-invites.js';
import { syncBroadcastSchedule } from './_broadcast-schedule.js';
import { syncKidStatuses } from './_kid-status.js';
import { wakeSecretOk, clientIp } from './_secure.js';
import { limit, tooMany } from './_rate-limit.js';

// Calls a minute from one address while no secret is set (with the secret,
// the caller is JobTread itself and isn't counted)
const PER_IP = 30;

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!wakeSecretOk(request, env, 'JOBTREAD_WEBHOOK_SECRET')) return Response.json({ ok: false }, { status: 401 });
  if (!String(env.JOBTREAD_WEBHOOK_SECRET || '').trim()) {
    const ip = await limit(env.DB, `reveal-invites:ip:${clientIp(request)}`, PER_IP, 60);
    if (!ip.ok) return tooMany(ip.retryAfter);
  }
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const jobId = String(body.jobId || '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(jobId)) return Response.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  try {
    // Only a change JobTread logged on this job counts; anything else is answered, not counted
    if (!(await verifiedJobEvent(env.JOBTREAD_GRANT_KEY, { jobId, eventId: String(body.eventId || '').trim() }))) return Response.json({ ok: true });
    const turn = await admitWake(env.DB, jobId);
    // Confirmed, status or the Reveal task changed: the live countdown follows (a check at
    // most once a minute site-wide). A construction task finishing can't move the countdown.
    if (body.source !== 'construction') context.waitUntil(syncBroadcastSchedule(env, { wake: true }));
    if (turn !== 'run') return Response.json({ ok: true });
    // The kid's status on the site follows the job (a status change, the Reveal task done)
    context.waitUntil(syncKidStatuses(env, { jobId }));
    const r = await reconcileJob(env, jobId);
    if (r.action === 'busy') await oweWake(env.DB, jobId);
    return Response.json({ ok: r.action !== 'error' });
  } catch (err) {
    console.error('[reveal-invites]', err.message);
    // 500, not 502: Cloudflare swaps 502 bodies for its own error page
    return Response.json({ ok: false }, { status: 500 });
  }
}
