/**
 * POST /api/applicant-sync — JobTread wake-up for applicant messages
 * =====================================================================
 * Sent by the JobTread workflow "Applicant Status/Diagnosis → Site applicant
 * messages" (customerCreatedOrUpdated, not by the site's grant):
 *   { eventId, accountId, previousStatus, status, changedBy }
 * Only eventId and accountId are read. ./_applicant-notify.js looks the event
 * up in JobTread (it must be this account's, recent, and real) and takes the
 * status before the change from it; ./_applicant-comms.js re-reads the
 * account (the medical note goes now) and the family's status email is
 * scheduled for once the status has settled. Replaces the Zapier "account
 * created" and "account updated" Zaps.
 *
 * With JOBTREAD_WEBHOOK_SECRET set, the workflow must send it (?key=… on the
 * URL or an X-Webhook-Secret header). The answer is { ok } and nothing more:
 * what happened is in the admin (Applicants), never in the response.
 *
 * Turning the secret on, in this order (none of the workflows send it yet):
 *   1. add the X-Webhook-Secret header (or ?key=) to all 7 SOARD JobTread
 *      workflows that wake the site: this one, the two "… → Site reveal date
 *      sync" and the four "… → Site reveal invites". The site ignores it
 *      while the variable is unset.
 *   2. then set JOBTREAD_WEBHOOK_SECRET in Cloudflare Pages and redeploy.
 * The other way round, every wake-up is refused (401) until step 1 is done.
 *
 * Until then anyone can call this, so each address gets PER_IP calls a minute
 * before JobTread is asked anything. The per-family and site-wide limits
 * (./_applicant-notify.js) count only changes JobTread confirmed, so junk
 * can't use them up and crowd out a real one.
 */

import { handleWorkflowCall } from './_applicant-notify.js';
import { refreshApplicants } from './_applicants.js';
import { wakeSecretOk, clientIp } from './_secure.js';
import { limit, tooMany } from './_rate-limit.js';

// Calls a minute from one address while no secret is set (with the secret,
// the caller is JobTread itself and isn't counted)
const PER_IP = 30;

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!wakeSecretOk(request, env, 'JOBTREAD_WEBHOOK_SECRET')) return Response.json({ ok: false }, { status: 401 });
  if (!String(env.JOBTREAD_WEBHOOK_SECRET || '').trim()) {
    const ip = await limit(env.DB, `applicant-sync:ip:${clientIp(request)}`, PER_IP, 60);
    if (!ip.ok) return tooMany(ip.retryAfter);
  }
  let body = {};
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'Expected JSON' }, { status: 400 }); }
  const accountId = String(body?.accountId || '');
  if (!/^[A-Za-z0-9]{6,32}$/.test(accountId)) return Response.json({ ok: false, error: 'bad accountId' }, { status: 400 });

  // JobTread waits on the webhook; answer within its window and keep working after.
  // The admin's Applicants mirror picks a verified change up straight away too.
  const work = handleWorkflowCall(env, { accountId, eventId: body?.eventId }).then(async (out) => {
    if (out.verified) await refreshApplicants(env, [accountId]).catch(() => 0);
    return out;
  });
  let timer;
  const quick = await Promise.race([work, new Promise(r => { timer = setTimeout(() => r(null), 8000); })]);
  clearTimeout(timer);
  if (!quick) {
    context.waitUntil(work);
    return Response.json({ ok: true });
  }
  if (quick.ok) return Response.json({ ok: true });
  console.error('[applicant-sync]', quick.error);
  // 500, not 502: Cloudflare swaps 502 bodies for its own error page
  return Response.json({ ok: false, error: 'Couldn’t process this change' }, { status: 500 });
}

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'applicant-sync', method: 'POST' });
}
