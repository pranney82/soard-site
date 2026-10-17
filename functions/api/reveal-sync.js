/**
 * POST /api/reveal-sync (public) — wake-up from the SOARD JobTread workflows
 * "Reveal task → …" and "Reveal Date field → …" when either side changes.
 * Body: { eventId, source: 'task' | 'field', jobId, taskStartDate?, taskStartTime?, revealDate? }
 * Everything is re-read from JobTread before anything is written (see
 * ./_reveal-sync.js), so the body can only point at a job, never set a date.
 */

import { syncJob } from './_reveal-sync.js';

export async function onRequestPost(context) {
  let body = {};
  try { body = await context.request.json(); } catch { /* empty */ }
  const jobId = String(body.jobId || '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(jobId)) return Response.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  try {
    const r = await syncJob(context.env, { ...body, jobId });
    return Response.json({ ok: true, action: r.action, ...(r.reason ? { reason: r.reason } : {}) });
  } catch (err) {
    // 500, not 502: Cloudflare swaps 502 bodies for its own error page
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
