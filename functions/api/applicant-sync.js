/**
 * POST /api/applicant-sync — JobTread wake-up for applicant messages
 * =====================================================================
 * Sent by the JobTread workflow "Applicant Status/Diagnosis → Site applicant
 * messages" (customerCreatedOrUpdated, not by the site's grant):
 *   { eventId, accountId, previousStatus, status, changedBy }
 * The body only names the account; ./_applicant-comms.js re-reads it from
 * JobTread (the medical note goes now) and ./_applicant-notify.js schedules
 * the family's status email for once the status has settled. Replaces the Zapier
 * "account created" and "account updated" Zaps.
 */

import { handleWorkflowCall } from './_applicant-notify.js';
import { refreshApplicants } from './_applicants.js';

export async function onRequestPost(context) {
  let body = {};
  try { body = await context.request.json(); } catch { return Response.json({ ok: false, error: 'Expected JSON' }, { status: 400 }); }
  // JobTread waits on the webhook; answer within its window and keep working after.
  // The admin's Applicants mirror picks the change up straight away too.
  const work = handleWorkflowCall(context.env, body).then(async (out) => {
    await refreshApplicants(context.env, [String(body?.accountId || '')]).catch(() => 0);
    return out;
  });
  let timer;
  const quick = await Promise.race([work, new Promise(r => { timer = setTimeout(() => r(null), 8000); })]);
  clearTimeout(timer);
  if (!quick) {
    context.waitUntil(work);
    return Response.json({ ok: true, queued: true });
  }
  return Response.json(quick, { status: quick.ok ? 200 : (quick.error === 'bad accountId' ? 400 : 500) });
}

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'applicant-sync', method: 'POST' });
}
