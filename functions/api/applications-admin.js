/**
 * /api/applications-admin — the admin's view of makeover applications
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET                      → { applications: [...checklist], draftsInProgress, events, qcGrant }
 * GET ?id=<app>            → one application: answers (by section), files, JobTread state
 * GET ?file=<app>&field=<f> → a stored photo or the PDF (field=pdf), streamed from R2
 * POST { retry: <app> }    → run the JobTread load again now
 * POST { test: true }      → a sample (TEST) application with the admin as the parent, through the
 *                            real intake: they get the family's welcome and the staff heads-up
 * POST { sweep: true }     → run the retry sweep now
 *
 * Open, closed, season (Admin → Applications → Settings), `application` in the site settings:
 * GET ?settings=1           → { settings, history, rules, area: { points, history } } (area: every
 *                             family's home on the Applicants map, for what a change would mean,
 *                             and the outlines the service area has had)
 *                             and cap: where the season stands against its application limit
 *                             (./_application-cap.js capFacts)
 * POST { settings, base }   → save them ({ conflict } 409 when someone changed them since
 *                             `base`; { errors } 422); open/close times run on the heartbeat.
 *                             A limit at or under what's in closes applications at once ({ capClosed })
 * The other settings there (who gets the new-application email, the service area, when
 * status emails go out) save at once, without the form's Put live (_application-forms.js):
 * POST { rules: { staffEmails?, serviceArea?, notify? }, base, force? } → { rules, history }
 *                             ({ conflict } 409, { errors } 422); a new boundary re-places
 *                             every applicant on the map
 *
 * The list: GET ?q=&show=all|attention|outside|repeat|test|deleted&year=&offset=
 * GET ?export=csv&year=[&tests=1] → every application as CSV
 * GET ?insights=1&year=     → the funnel: started, finished, where people stop
 * POST { deleteApp: <app> } → delete the family's data from the site (JobTread untouched)
 *
 * The form (Admin → Applications → Form / Messages / Spanish / History):
 * GET ?form=1               → { live, draft, versions, problems, locked, types, translation }
 * GET ?form-version=<n>     → one version's definition
 * GET ?form-diff=draft|<n>  → what changed (the draft vs live, or a version vs the one before)
 * GET ?jobtread-fields=1    → JobTread fields a new question can fill
 * POST { formSave: def, base?, force? } → save the draft (always saves; returns problems,
 *                             or { conflict } when someone else saved since `base`)
 * POST { formPutLive: true } → the draft becomes the form families see
 * POST { formDiscard: true } / { formRestore: <n> }
 * POST { translate: { path: english } } → Spanish drafts from Workers AI
 * POST { areaTest: address, polygon?, nearMiles? } → where this address sits against the service area
 *
 * Staff review applications in JobTread; this page is the health check for
 * the pipe from the form to JobTread.
 */

import {
  ensureSchema, listApplications, getApplication, processApplication, createTestApplication,
  maybeSweepApplications, checklist, flags, jobtreadAccountUrl, isApplicationId, cleanYear, applicationSettings,
  exportCsv, deleteApplicationData, insights, pickApplication, saveApplicationSettings, applicationSettingsHistory, applicantFiles,
  enforceApplicationCap,
} from './_applications.js';
import { capFacts } from './_application-cap.js';
import {
  answerSections, LOCKED_FIELDS, FIELD_TYPES, DEFAULT_DEFINITION, DEFAULT_SERVICE_AREA, validateDefinition, normalizeDefinition,
  translationStatus, englishStrings,
} from './_application-form.js';
import {
  formFor, getLiveForm, getDraftForm, getFormVersion, saveDraftForm, putDraftLive, discardDraftForm,
  restoreFormVersion, listFormVersions, diffForm, getFormRules, saveFormRules, pickRules, areaHistory,
} from './_application-forms.js';
import { checkServiceArea, areaText } from './_geo.js';
import { translateStrings } from './_translate.js';
import { jobtreadFields } from './_jobtread-fields.js';
import { recentEvents } from './_applicant-comms.js';
import { logAudit } from './_audit.js';
import { replaceBoundary } from './_applicants.js';
import { advanceOpening } from './_application-waitlist.js';

/** When applications last opened or closed, and who did it ("schedule" for the timer, "limit" when it filled) */
const sinceOf = (a) => (a?.openChangedAt ? { at: a.openChangedAt, by: a.openChangedBy || null } : null);

/** Settings → Application limit: how many are in for the season, partway through, the pace (./_application-cap.js) */
const capNow = (DB, stored) => capFacts(DB, pickApplication(stored), { openedAt: stored?.openChangedAt || null, board: true });

/**
 * For Settings → Service area: every home on the Applicants map (no names, just
 * where and how far along), so a change shows what it would mean, and the
 * outlines the area has had.
 */
async function areaContext(DB) {
  let points = [];
  try {
    const { results } = await DB.prepare('SELECT account_id, lat, lng, status, year FROM applicants WHERE lat IS NOT NULL AND lng IS NOT NULL').all();
    points = (results || []).map(r => ({ id: r.account_id, lat: r.lat, lng: r.lng, status: r.status || null, year: r.year || null }));
  } catch { /* the Applicants mirror isn't there yet */ }
  return { points, history: await areaHistory(DB).catch(() => []) };
}

/** The settings as the site uses them now, and who last saved them */
async function rulesNow(DB) {
  const [live, saved] = await Promise.all([formFor(DB, { year: '2027' }), getFormRules(DB).catch(() => null)]);
  return { values: pickRules(live), updatedAt: saved?.updatedAt || null, updatedBy: saved?.updatedBy || null, defaults: { serviceArea: DEFAULT_SERVICE_AREA } };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return Response.json({ success: false, error: 'DB not bound' }, { status: 500 });
  await ensureSchema(env.DB);
  const url = new URL(request.url);

  const fileApp = url.searchParams.get('file');
  if (fileApp) {
    const app = isApplicationId(fileApp) ? await getApplication(env.DB, fileApp) : null;
    if (!app || !applicantFiles(env)) return new Response('Not found', { status: 404 });
    const field = url.searchParams.get('field');
    const key = field === 'pdf' ? app.jt_state?.pdf?.key : (url.searchParams.get('thumb') ? app.files?.[field]?.thumbKey : app.files?.[field]?.key);
    const obj = key ? await applicantFiles(env).get(key) : null;
    if (!obj) return new Response('Not found', { status: 404 });
    // Shown in the browser only when it's a photo or the PDF; anything else downloads
    const type = String(obj.httpMetadata?.contentType || 'application/octet-stream').toLowerCase();
    const showable = /^image\/(jpeg|png|webp|heic|heif)$/.test(type) || type === 'application/pdf';
    const name = `${(app.child_name || 'application').replace(/[^\w .-]/g, '')}${field === 'pdf' ? '_Application.pdf' : ''}`;
    return new Response(obj.body, {
      headers: {
        'Content-Type': showable ? type : 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': showable ? (field === 'pdf' ? `inline; filename="${name}"` : 'inline') : `attachment; filename="${name || 'file'}"`,
      },
    });
  }

  if (url.searchParams.get('export') === 'csv') {
    const csv = await exportCsv(env.DB, { year: url.searchParams.get('year') || '', includeTests: url.searchParams.get('tests') === '1' });
    const name = `soard-applications${url.searchParams.get('year') ? `-${url.searchParams.get('year')}` : ''}.csv`;
    return new Response(`\uFEFF${csv}`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
  }
  if (url.searchParams.get('settings')) {
    const [stored, history, rules, area] = await Promise.all([applicationSettings(env.DB), applicationSettingsHistory(env.DB), rulesNow(env.DB), areaContext(env.DB)]);
    return Response.json({ success: true, settings: pickApplication(stored), since: sinceOf(stored), cap: await capNow(env.DB, stored), history, rules, area, now: new Date().toISOString() });
  }
  if (url.searchParams.get('insights')) {
    const settings = await applicationSettings(env.DB);
    return Response.json({ success: true, insights: await insights(env.DB, { year: url.searchParams.get('year') || cleanYear(settings.year) }) });
  }
  if (url.searchParams.has('form-diff')) {
    return Response.json({ success: true, changes: await diffForm(env.DB, url.searchParams.get('form-diff')) });
  }
  if (url.searchParams.get('jobtread-fields')) {
    try {
      return Response.json({ success: true, fields: await jobtreadFields(env) });
    } catch (e) {
      return Response.json({ success: false, error: e.message }, { status: 500 });
    }
  }

  if (url.searchParams.get('form')) {
    const [live, draft, versions] = await Promise.all([getLiveForm(env.DB, { fresh: true }), getDraftForm(env.DB), listFormVersions(env.DB)]);
    const settings = await applicationSettings(env.DB);
    return Response.json({
      success: true,
      year: cleanYear(settings.year),
      live: { version: live.version, definition: live.definition, liveAt: live.liveAt || null, liveBy: live.liveBy || null, builtIn: !!live.builtIn },
      draft: draft ? { version: draft.version, definition: draft.definition, updatedAt: draft.updatedAt, updatedBy: draft.updatedBy, note: draft.note } : null,
      problems: draft ? validateDefinition(normalizeDefinition(draft.definition)) : [],
      translation: translationStatus(normalizeDefinition((draft || live).definition), 'es'),
      // Built-in values the editor shows as placeholders
      defaults: { serviceArea: DEFAULT_SERVICE_AREA },
      me: context.data?.userEmail || null,
      versions,
      locked: LOCKED_FIELDS,
      types: FIELD_TYPES,
    });
  }
  if (url.searchParams.has('form-version')) {
    const v = await getFormVersion(env.DB, url.searchParams.get('form-version'));
    return Response.json({ success: true, version: v.version, definition: v.definition || DEFAULT_DEFINITION });
  }

  const id = url.searchParams.get('id');
  if (id) {
    const app = isApplicationId(id) ? await getApplication(env.DB, id) : null;
    if (!app) return Response.json({ success: false, error: 'Not found' }, { status: 404 });
    // Staff read in English; a Spanish application shows the family's wording beside it
    const form = await formFor(env.DB, { year: app.year, version: app.form_version || 0, lang: app.lang || 'en' });
    return Response.json({
      success: true,
      application: {
        id: app.id, year: app.year, child: app.child_name, parent: app.parent_name, email: app.parent_email,
        isTest: !!app.is_test, status: app.status, attempts: app.attempts, lastError: app.last_error,
        submittedAt: app.submitted_at, accountId: app.jt_account_id, formVersion: app.form_version || 0,
        jobtreadUrl: app.jt_account_id ? jobtreadAccountUrl(app.jt_account_id) : null,
        checklist: checklist(app),
        lang: app.lang || 'en',
        flags: flags(app),
        deletedAt: app.deleted_at || null,
        sections: answerSections(form, app.answers, app.files, { en: true }).map(s => ({
          ...s, items: s.items.map(i => (i.upload ? { id: i.id, type: i.type, label: i.label, upload: true, hasThumb: !!i.file?.thumbKey, fileType: i.file?.type || null, size: i.file?.size || null, video: i.type === 'video' ? { uploaded: !!i.file?.uploaded, duration: i.file?.duration || null } : undefined } : i)),
        })),
        hasPdf: !!app.jt_state?.pdf?.key,
      },
    });
  }

  const list = await listApplications(env.DB, {
    q: url.searchParams.get('q') || '',
    show: url.searchParams.get('show') || 'all',
    year: url.searchParams.get('year') || '',
    offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
    limit: Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50)),
  });
  const settings = await applicationSettings(env.DB);
  return Response.json({
    success: true,
    ...list,
    open: settings.open === true,
    year: cleanYear(settings.year),
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
    return Response.json({ success: true, id: made.id, email, result });
  }

  if (body.settings) {
    const out = await saveApplicationSettings(env, body.settings, { user, base: body.base || null });
    if (out.conflict) return Response.json({ success: false, conflict: out.conflict, error: 'Someone changed these settings since you opened them.' }, { status: 409 });
    if (out.errors) return Response.json({ success: false, errors: out.errors, error: out.errors[0].error }, { status: 422 });
    if (out.busy) return Response.json({ success: false, error: 'The site settings were being saved at the same moment. Try again.' }, { status: 500 });
    // A limit at or under what's already in closes applications now, with the team's notice
    // (and the heads-up, if this limit's is due)
    const capped = await enforceApplicationCap(env);
    // Opening (or closing) moves the waitlist email right away (it takes its own lock, never throws)
    if (out.changes?.some(c => c.field === 'application.open') || capped?.closed) context.waitUntil?.(advanceOpening(env, { force: true }).catch(() => {}));
    const stored = await applicationSettings(env.DB);
    return Response.json({
      success: true, settings: pickApplication(stored), changes: out.changes, capClosed: !!capped?.closed,
      cap: await capNow(env.DB, stored), since: sinceOf(stored), history: await applicationSettingsHistory(env.DB),
    });
  }

  if (body.rules) {
    const out = await saveFormRules(env.DB, body.rules, { user, base: body.base ?? null, force: !!body.force });
    if (out.conflict) return Response.json({ success: false, conflict: out.conflict, error: `${out.conflict.updatedBy} changed these settings while you had them open.` }, { status: 409 });
    if (out.errors) return Response.json({ success: false, errors: out.errors, error: out.errors[0].message }, { status: 422 });
    if (out.changes.length) {
      await logAudit(env.DB, { userEmail: user, action: 'updated', entityType: 'application-settings', entitySlug: 'rules', entityName: 'Applications settings', changes: out.changes });
      // A new boundary: every applicant on the map is placed against it again
      if (out.changes.some(c => c.field === 'application.serviceArea')) await replaceBoundary(env.DB, out.rules.serviceArea.polygon).catch(() => 0);
    }
    return Response.json({ success: true, changes: out.changes, rules: await rulesNow(env.DB), history: await applicationSettingsHistory(env.DB), area: await areaContext(env.DB) });
  }

  if (body.formSave) {
    const out = await saveDraftForm(env.DB, body.formSave, { user, base: body.base ?? null, force: !!body.force });
    if (out.conflict) return Response.json({ success: false, conflict: out.conflict, error: `${out.conflict.updatedBy} changed the draft at the same time.` }, { status: 409 });
    return Response.json({ success: true, version: out.version, problems: out.errors, definition: out.definition, updatedAt: out.updatedAt });
  }
  if (body.translate) {
    try {
      const out = await translateStrings(env, body.translate, { lang: 'es' });
      return Response.json({ success: true, ...out });
    } catch (e) {
      return Response.json({ success: false, error: e.message }, { status: 500 });
    }
  }
  if (body.areaTest) {
    // Against what's on screen in Settings (unsaved changes too), else what's in use
    const live = (await formFor(env.DB, { year: '2027' })).serviceArea;
    const polygon = Array.isArray(body.polygon) && body.polygon.length >= 3 ? body.polygon : live.polygon;
    const nearMiles = body.nearMiles != null ? body.nearMiles : live.nearMiles;
    const area = await checkServiceArea(String(body.areaTest).slice(0, 300), { polygon, nearMiles });
    return Response.json({ success: true, area, text: areaText(area) });
  }
  if (body.deleteApp) {
    if (!isApplicationId(body.deleteApp)) return Response.json({ success: false, error: 'Bad id' }, { status: 400 });
    const out = await deleteApplicationData(env, body.deleteApp, { user });
    if (!out.ok) return Response.json({ success: false, error: out.error }, { status: 404 });
    await logAudit(env.DB, { userEmail: user, action: 'deleted', entityType: 'application', entitySlug: body.deleteApp, entityName: 'Application data' });
    return Response.json({ success: true, accountUrl: out.accountId ? jobtreadAccountUrl(out.accountId) : null });
  }
  if (body.formPutLive) {
    const out = await putDraftLive(env.DB, { user });
    if (!out.ok) return Response.json({ success: false, error: out.error, problems: out.errors || [] }, { status: 422 });
    // The boundary may have moved: re-place every applicant on the map
    const live = await getLiveForm(env.DB, { fresh: true });
    if (live.definition?.serviceArea?.polygon?.length >= 3) await replaceBoundary(env.DB, live.definition.serviceArea.polygon).catch(() => 0);
    await logAudit(env.DB, { userEmail: user, action: 'published', entityType: 'application-form', entitySlug: `version-${out.version}`, entityName: `Application form version ${out.version}` });
    return Response.json({ success: true, version: out.version });
  }
  if (body.formDiscard) {
    await discardDraftForm(env.DB);
    return Response.json({ success: true });
  }
  if (body.formRestore != null) {
    const out = await restoreFormVersion(env.DB, body.formRestore, { user });
    if (!out.ok) return Response.json({ success: false, error: out.error }, { status: 404 });
    return Response.json({ success: true, version: out.version, problems: out.errors });
  }

  if (body.sweep) {
    return Response.json({ success: true, result: await maybeSweepApplications(env, { force: true }) });
  }

  return Response.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
