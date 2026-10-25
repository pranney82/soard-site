/**
 * /api/applicants-admin — Admin → Applications → Applicants
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list). Every
 * change goes to JobTread first; see ./_applicants.js.
 *
 * GET ?list=1[&archived=1]   → { applicants, sync, statuses, fields, boundary, season }
 * GET ?id=<account>          → { applicant, comments, files, activity } (live from JobTread)
 * GET ?activity=1[&before=]  → recent activity across every family
 * GET ?preview=<status>&id=  → what moving to that status would send the family
 * GET ?cdn=<JobTread file URL> → that file, passed through (Range too) for the file viewer
 *
 * POST { status: { id, status, notify, denialReason } }
 * POST { fields: { id, changes: { key: value } } }
 * POST { message: { id, subject, message, replyTo? } }    → JobTread emails everyone on the account (replyTo: in that thread)
 * POST { archive: { id, archive } }
 * POST { sync: true }                                     → re-read everything now ("Check JobTread now")
 * POST { sync: 'catchup' }                                → just the changes since the last look
 *
 * Family status emails (./_applicant-notify.js):
 * GET ?correction=<account>                               → a ready-to-edit correction
 * POST { notify: { id, action: 'send' | 'skip' | 'back' } } → send now / don't email / move back
 * POST { pause: { minutes } } / { resume: true }          → pause family emails (cleanup)
 * POST { held: 'send' | 'skip' }                          → the emails held during a pause
 * POST { correction: { id, subject, message } }           → send it; the family now knows the current status
 * POST { boundary: [[lat, lng], …], base? }               → the service area, live at once (a
 *                                                           setting, like Applications → Settings)
 */

import {
  ensureApplicantSchema, listApplicants, applicantDetail, recentActivity, previewStatus, setApplicantStatus,
  updateApplicantFields, messageFamily, archiveApplicant, markReplyHandled, maybeSyncApplicants, syncState,
  isAccountId, STATUSES, FIELDS, replaceBoundary,
} from './_applicants.js';
import { applicationSettings, cleanYear } from './_applications.js';
import { getLiveForm, getFormRules, saveFormRules } from './_application-forms.js';
import { DEFAULT_SERVICE_AREA } from './_application-form.js';
import { logAudit } from './_audit.js';
import { JT_URL } from './_reveals.js';
import {
  sendNow, dontSend, moveBack, pauseEmails, resumeEmails, pauseState, resolveHeld, correctionDraft, sendCorrection,
  runNotifications, overdueCount,
} from './_applicant-notify.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400, extra = {}) => Response.json({ success: false, error, ...extra }, { status });

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  if (!env.JOBTREAD_GRANT_KEY) return fail('JOBTREAD_GRANT_KEY is not set in Cloudflare', 500);
  await ensureApplicantSchema(env.DB);
  const url = new URL(request.url);

  // A file on JobTread's CDN, passed through for the file viewer (public/admin/file-viewer.js) when the
  // browser can't fetch it from the CDN itself: a tab opened before the admin's CSP allowed the CDN, or a
  // network that blocks it. JobTread's CDN only (staff-only, behind Access); a Range request is passed
  // on, so a big PDF still opens page by page.
  if (url.searchParams.has('cdn')) {
    let target;
    try { target = new URL(url.searchParams.get('cdn')); } catch { return fail('Bad file link'); }
    if (target.protocol !== 'https:' || target.host !== 'cdn.jobtread.com') return fail('Only JobTread’s files', 400);
    try {
      const range = request.headers.get('range');
      const res = await fetch(target, { headers: range ? { range } : {} });
      // (500, not 502: Cloudflare swaps a 502's body for its own error page)
      if (!res.ok) return new Response(`JobTread answered ${res.status}`, { status: res.status === 404 ? 404 : 500 });
      const headers = new Headers({ 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'etag', 'last-modified']) {
        const v = res.headers.get(k);
        if (v) headers.set(k, v);
      }
      return new Response(res.body, { status: res.status, headers });
    } catch (e) {
      return fail(e.message, 500);
    }
  }

  if (url.searchParams.get('list')) {
    // First visit ever: fill the mirror before answering
    let state = await syncState(env.DB);
    if (!state.fullAt) {
      await maybeSyncApplicants(env, { force: true });
      state = await syncState(env.DB);
    }
    const [applicants, settings, live, rules] = await Promise.all([
      listApplicants(env.DB, { archived: url.searchParams.get('archived') === '1' }),
      applicationSettings(env.DB),
      getLiveForm(env.DB),
      getFormRules(env.DB).catch(() => null),
    ]);
    // The sweep sends due emails every 2 minutes; if it ever stalls, opening the admin does it
    const overdue = await overdueCount(env.DB);
    if (overdue) context.waitUntil?.(runNotifications(env));
    return ok({
      applicants, sync: state, statuses: STATUSES,
      emails: { ...(await pauseState(env.DB)), overdue },
      fields: Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, { label: f.label, type: f.type, options: f.options || null, long: !!f.long }])),
      boundary: {
        live: live.definition?.serviceArea?.polygon || DEFAULT_SERVICE_AREA.polygon,
        // How far out counts as close (drawn as a dashed ring), and what families farther out get
        nearMiles: live.definition?.serviceArea?.nearMiles ?? DEFAULT_SERVICE_AREA.nearMiles,
        beyond: live.definition?.serviceArea?.beyond || DEFAULT_SERVICE_AREA.beyond,
        updatedAt: rules?.updatedAt || null,
      },
      season: cleanYear(settings.year),
      me: context.data?.userEmail || null,
    });
  }

  if (url.searchParams.get('activity')) {
    return ok({ activity: await recentActivity(env.DB, { before: url.searchParams.get('before') || null }) });
  }

  const id = url.searchParams.get('id');
  if (id && !isAccountId(id)) return fail('Bad id');

  // A JobTread document exactly as JobTread prints it (an agreement, an estimate): its PDF, for staff.
  // JobTread answers this one with the PDF itself, not JSON, so it doesn't go through pave().
  if (url.searchParams.has('pdf')) {
    const doc = url.searchParams.get('pdf');
    if (!isAccountId(doc)) return fail('Bad document id');
    try {
      const res = await fetch(JT_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { $: { grantKey: env.JOBTREAD_GRANT_KEY }, pdf: { $: { id: 'document', options: { id: doc } } } } }),
      });
      if (!res.ok || !/pdf/i.test(res.headers.get('content-type') || '')) return fail(`JobTread didn’t return a PDF (${res.status})`, 500);
      return new Response(res.body, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${doc}.pdf"`, 'Cache-Control': 'private, no-store' } });
    } catch (e) {
      return fail(e.message, 500);
    }
  }

  if (url.searchParams.has('correction')) {
    const cid = url.searchParams.get('correction');
    if (!isAccountId(cid)) return fail('Bad id');
    try {
      return ok({ draft: await correctionDraft(env, cid) });
    } catch (e) {
      return fail(e.message, 500);
    }
  }

  if (url.searchParams.has('preview')) {
    if (!id) return fail('Which applicant?');
    try {
      return ok({ preview: await previewStatus(env, id, url.searchParams.get('preview')) });
    } catch (e) {
      return fail(e.message, 500);
    }
  }

  if (id) {
    try {
      const detail = await applicantDetail(env, id);
      return detail ? ok(detail) : fail('Not found (or no longer an applicant in JobTread)', 404);
    } catch (e) {
      return fail(e.message, 500);
    }
  }

  return ok({ sync: await syncState(env.DB) });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  if (!env.JOBTREAD_GRANT_KEY) return fail('JOBTREAD_GRANT_KEY is not set in Cloudflare', 500);
  await ensureApplicantSchema(env.DB);
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const user = context.data?.userEmail || 'admin';
  const audit = (action, id, changes) => logAudit(env.DB, { userEmail: user, action, entityType: 'applicant', entitySlug: id, changes }).catch(() => {});
  const target = (o) => {
    if (!o || !isAccountId(o.id)) throw Object.assign(new Error('Which applicant?'), { status: 400 });
    return o.id;
  };

  try {
    if (body.status) {
      const id = target(body.status);
      const out = await setApplicantStatus(env, id, String(body.status.status || ''), { notify: body.status.notify !== false, emailNow: !!body.status.emailNow, denialReason: body.status.denialReason ?? null, user });
      await audit('status', id, { from: out.previous, to: out.status, email: out.email });
      return ok(out);
    }
    if (body.fields) {
      const id = target(body.fields);
      const applicant = await updateApplicantFields(env, id, body.fields.changes, { user });
      await audit('fields', id, body.fields.changes);
      return ok({ applicant });
    }
    if (body.message) {
      const id = target(body.message);
      const replyTo = body.message.replyTo == null ? null : String(body.message.replyTo);
      if (replyTo && !/^[A-Za-z0-9_-]{4,64}$/.test(replyTo)) throw Object.assign(new Error('Which message?'), { status: 400 });
      const out = await messageFamily(env, id, { subject: body.message.subject, message: body.message.message, replyTo, user });
      await audit('message', id, { to: out.to.map(p => p.email).join(', '), subject: body.message.subject || null });
      return ok(out);
    }
    if (body.handled) {
      const id = target(body.handled);
      const applicant = await markReplyHandled(env, id, { user });
      await audit('reply-handled', id, {});
      return ok({ applicant });
    }
    if (body.archive) {
      const id = target(body.archive);
      const applicant = await archiveApplicant(env, id, { archive: body.archive.archive !== false, user });
      await audit(body.archive.archive !== false ? 'archive' : 'unarchive', id, {});
      return ok({ applicant });
    }
    if (body.notify) {
      const id = target(body.notify);
      const name = adminNameOf(user);
      const act = body.notify.action;
      const out = act === 'send' ? await sendNow(env, id, { user: name })
        : act === 'skip' ? await dontSend(env, id, { user: name })
          : act === 'back' ? await moveBack(env, id, { user: name }) : { ok: false, error: 'Unknown action' };
      if (!out.ok) return fail(out.error || `Couldn't ${act === 'send' ? 'send it' : 'do that'}`, 409);
      await audit(`email-${act}`, id, {});
      return ok(out);
    }
    if (body.pause) {
      const state = await pauseEmails(env.DB, { minutes: body.pause.minutes, user });
      await audit('emails-paused', 'family-emails', { until: state.until });
      return ok({ emails: state });
    }
    if (body.resume) {
      const state = await resumeEmails(env.DB);
      await audit('emails-resumed', 'family-emails', {});
      return ok({ emails: state });
    }
    if (body.held) {
      const out = await resolveHeld(env, { send: body.held === 'send', user: adminNameOf(user) });
      await audit(body.held === 'send' ? 'held-sent' : 'held-dismissed', 'family-emails', out);
      return ok({ ...out, emails: await pauseState(env.DB) });
    }
    if (body.correction) {
      const id = target(body.correction);
      const out = await sendCorrection(env, id, { subject: body.correction.subject, message: body.correction.message, user: adminNameOf(user) });
      await audit('correction', id, { to: out.to.map(p => p.email).join(', ') });
      return ok(out);
    }
    if (body.sync) {
      // 'catchup': just JobTread's changes since the last look (the admin coming back to the tab); true: everything
      const out = await maybeSyncApplicants(env, body.sync === 'catchup' ? { catchUp: true } : { force: true });
      if (out?.error) return fail(out.error, 500);
      return ok({ result: out, sync: await syncState(env.DB) });
    }
    if (body.boundary) {
      const polygon = cleanPolygon(body.boundary);
      if (!polygon) return fail('The boundary needs at least 3 corners, as [latitude, longitude] pairs.');
      const out = await saveFormRules(env.DB, { serviceArea: { polygon } }, { user, base: body.base ?? null, force: !!body.force });
      if (out.conflict) return fail(`${out.conflict.updatedBy} changed the settings at the same time.`, 409, { conflict: { updatedAt: out.conflict.updatedAt, updatedBy: out.conflict.updatedBy } });
      if (out.errors) return fail(out.errors[0].message, 422);
      if (out.changes.length) {
        await logAudit(env.DB, { userEmail: user, action: 'updated', entityType: 'application-settings', entitySlug: 'rules', entityName: 'Applications settings', changes: out.changes });
        await replaceBoundary(env.DB, out.rules.serviceArea.polygon).catch(() => 0);
      }
      return ok({ updatedAt: out.updatedAt, boundary: out.rules.serviceArea.polygon, changed: out.changes.length > 0 });
    }
  } catch (e) {
    return fail(e.message, e.status || 500);
  }
  return fail('Unknown action');
}

const adminNameOf = (user) => {
  const local = String(user || '').split('@')[0].split(/[._+-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1) : 'Staff';
};

/** [[lat, lng], …] rounded to about a metre, or null when it isn't a usable outline */
function cleanPolygon(input) {
  if (!Array.isArray(input)) return null;
  const pts = input
    .map(p => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.lat), Number(p?.lng)]))
    .filter(([la, ln]) => Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180)
    .map(([la, ln]) => [Math.round(la * 1e5) / 1e5, Math.round(ln * 1e5) / 1e5]);
  return pts.length >= 3 && pts.length <= 200 ? pts : null;
}
