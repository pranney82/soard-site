/**
 * /api/applications-admin — the admin's view of makeover applications
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET                      → { applications: [...checklist], draftsInProgress, events, qcGrant }
 * GET ?id=<app>            → one application: answers (by section), files, JobTread state
 * GET ?file=<app>&field=<f> → a stored photo or the PDF (field=pdf), streamed from R2
 * POST { retry: <app> }    → run the JobTread load again now
 * POST { test: true }      → a TEST application addressed to the admin, loaded like a real one
 * POST { sweep: true }     → run the retry sweep now
 *
 * Staff review applications in JobTread; this page is the health check for
 * the pipe from the form to JobTread.
 */

import {
  ensureSchema, listApplications, getApplication, processApplication, createTestApplication,
  maybeSweepApplications, checklist, jobtreadAccountUrl, isApplicationId, cleanYear, applicationSettings,
} from './_applications.js';
import { applicationForm, answerSections } from './_application-form.js';
import { recentEvents } from './_applicant-comms.js';
import { logAudit } from './_audit.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return Response.json({ success: false, error: 'DB not bound' }, { status: 500 });
  await ensureSchema(env.DB);
  const url = new URL(request.url);

  const fileApp = url.searchParams.get('file');
  if (fileApp) {
    const app = isApplicationId(fileApp) ? await getApplication(env.DB, fileApp) : null;
    if (!app || !env.FILES) return new Response('Not found', { status: 404 });
    const field = url.searchParams.get('field');
    const key = field === 'pdf' ? app.jt_state?.pdf?.key : (url.searchParams.get('thumb') ? app.files?.[field]?.thumbKey : app.files?.[field]?.key);
    const obj = key ? await env.FILES.get(key) : null;
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': field === 'pdf' ? `inline; filename="${(app.child_name || 'application').replace(/[^\w .-]/g, '')}_Application.pdf"` : 'inline',
      },
    });
  }

  const id = url.searchParams.get('id');
  if (id) {
    const app = isApplicationId(id) ? await getApplication(env.DB, id) : null;
    if (!app) return Response.json({ success: false, error: 'Not found' }, { status: 404 });
    const form = applicationForm({ year: app.year });
    return Response.json({
      success: true,
      application: {
        id: app.id, year: app.year, child: app.child_name, parent: app.parent_name, email: app.parent_email,
        isTest: !!app.is_test, status: app.status, attempts: app.attempts, lastError: app.last_error,
        submittedAt: app.submitted_at, accountId: app.jt_account_id,
        jobtreadUrl: app.jt_account_id ? jobtreadAccountUrl(app.jt_account_id) : null,
        checklist: checklist(app),
        sections: answerSections(form, app.answers, app.files).map(s => ({
          ...s, items: s.items.map(i => (i.upload ? { id: i.id, type: i.type, label: i.label, upload: true, hasThumb: !!i.file?.thumbKey, video: i.type === 'video' ? { uploaded: !!i.file?.uploaded, duration: i.file?.duration || null } : undefined } : i)),
        })),
        hasPdf: !!app.jt_state?.pdf?.key,
      },
    });
  }

  const list = await listApplications(env.DB);
  return Response.json({
    success: true,
    ...list,
    events: await recentEvents(env.DB, 25),
    qcGrant: !!env.JOBTREAD_QC_GRANT_KEY,
    stream: !!(env.CF_ACCOUNT_ID && env.CF_STREAM_TOKEN),
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return Response.json({ success: false, error: 'DB not bound' }, { status: 500 });
  await ensureSchema(env.DB);
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const user = context.data?.userEmail || 'admin';

  if (body.retry) {
    if (!isApplicationId(body.retry)) return Response.json({ success: false, error: 'Bad id' }, { status: 400 });
    await env.DB.prepare('UPDATE applications SET locked_until = NULL WHERE id = ? AND locked_until < ?').bind(body.retry, Date.now()).run();
    const result = await processApplication(env, body.retry);
    await logAudit(env.DB, { userEmail: user, action: 'retry', entityType: 'application', entitySlug: body.retry, changes: { result: result.status } });
    return Response.json({ success: true, result });
  }

  if (body.test) {
    const settings = await applicationSettings(env.DB);
    const email = /@/.test(user) ? user : 'peter@soardcharity.com';
    const made = await createTestApplication(env, { email, year: cleanYear(settings.year) });
    if (!made.ok) return Response.json({ success: false, error: 'Test answers did not validate', errors: made.errors }, { status: 500 });
    const result = await processApplication(env, made.id);
    await logAudit(env.DB, { userEmail: user, action: 'test', entityType: 'application', entitySlug: made.id, changes: { result: result.status } });
    return Response.json({ success: true, id: made.id, result });
  }

  if (body.sweep) {
    return Response.json({ success: true, result: await maybeSweepApplications(env, { force: true }) });
  }

  return Response.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
