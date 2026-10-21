/**
 * POST /api/reveal-sync (public) — wake-up from the SOARD JobTread workflows
 * "Reveal task → …" and "Reveal Date field → …" when either side changes.
 * Body: { eventId, jobId, … }. Only those two are read: the event is checked
 * with JobTread and says which side changed, and both sides are re-read
 * before anything is written (see ./_reveal-sync.js), so the body can only
 * point at a change, never set a date or pick a side.
 *
 * With JOBTREAD_WEBHOOK_SECRET set, the workflow must send it (?key=… on the
 * URL or an X-Webhook-Secret header). The answer is { ok } and nothing more.
 *
 * Turning the secret on, in this order (none of the workflows send it yet):
 *   1. add the X-Webhook-Secret header (or ?key=) to all 7 SOARD JobTread
 *      workflows that wake the site: these two, the four "… → Site reveal
 *      invites" and "Applicant Status/Diagnosis → Site applicant messages".
 *      The site ignores it while the variable is unset.
 *   2. then set JOBTREAD_WEBHOOK_SECRET in Cloudflare Pages and redeploy.
 * The other way round, every wake-up is refused (401) until step 1 is done.
 *
 * Until then anyone can call this, so each address gets PER_IP calls a minute
 * before JobTread is asked anything. The per-job and site-wide limits count
 * only changes JobTread confirmed, so junk can't crowd out a real one.
 */

import { wakeSync } from './_reveal-sync.js';
import { syncBroadcastSchedule } from './_broadcast-schedule.js';
import { wakeSecretOk, clientIp } from './_secure.js';
import { limit, tooMany } from './_rate-limit.js';

// Calls a minute from one address while no secret is set (with the secret,
// the caller is JobTread itself and isn't counted)
const PER_IP = 30;

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!wakeSecretOk(request, env, 'JOBTREAD_WEBHOOK_SECRET')) return Response.json({ ok: false }, { status: 401 });
  if (!String(env.JOBTREAD_WEBHOOK_SECRET || '').trim()) {
    const ip = await limit(env.DB, `reveal-sync:ip:${clientIp(request)}`, PER_IP, 60);
    if (!ip.ok) return tooMany(ip.retryAfter);
  }
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const jobId = String(body.jobId || '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(jobId)) return Response.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  try {
    const r = await wakeSync(env, { jobId, eventId: String(body.eventId || '').trim() });
    // A reveal date changed: the live countdown follows (re-read from JobTread, at most once a minute)
    if (r.ran) context.waitUntil(syncBroadcastSchedule(env, { wake: true }));
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[reveal-sync]', err.message);
    // 500, not 502: Cloudflare swaps 502 bodies for its own error page
    return Response.json({ ok: false }, { status: 500 });
  }
}
