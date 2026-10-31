/**
 * /api/apply — the public makeover application (page: /apply/form/)
 * ===========================================================================
 * GET  ?config                     → { open, year, turnstileSiteKey, form }
 *      ?config&preview=draft        → the same with the unsaved draft form (signed-in staff only)
 * POST JSON { action, ... }:
 *   start      { year, turnstileToken?, website }   → { token }  new draft
 *   resume     { token }                            → the draft's answers, files, page, last area check
 *   area       { token, address }                   → where the home sits against the service area
 *                                                     (Census; signed-in staff may leave out the token
 *                                                     to try it in a preview)
 *   save       { token, answers, page }             → saves the whole answer set
 *   email-link { token, email? }                    → emails a resume link
 *   video-url  { token, size, name }                → one-time Stream tus URL
 *   video-done { token }                            → marks the video uploaded once Stream has it
 *   remove-file{ token, field }                     → clears a photo or the video
 *   submit     { token }                            → { id } and loads it into JobTread
 *   test-status{ token }                            → a staff test run's intake, step by step
 * POST multipart (action=photo, token, field, file, thumb?) → stores a photo
 *
 * Test runs: signed-in staff open /apply/form/?test=1 (Admin → Applications → Form, "Go through it
 * as a family") and start with { test: true }. That works while applications are closed, makes a
 * TEST application, and sends every email to the staff member (createDraft, submitDraft).
 *
 * The token is the draft's 128-bit id: whoever holds the resume link can see
 * and change that draft, nobody else. Public route (see _middleware.js), rate
 * limited per IP there and per draft here. A honeypot field ("website") and,
 * once TURNSTILE_SECRET_KEY is set (the site key has a public default), Turnstile on
 * start keep bots out; submit also needs four real photos and a video Stream
 * accepted, which bots don't bother with.
 */

import { isAuthenticated, verifyJwt } from './_middleware.js';
import { isStaffEmail } from './_board-roles.js';
import { staffStanding } from './_staff-access.js';
import {
  ensureSchema, getDraft, createDraft, saveDraft, setDraftFile, draftsToday, hashIp, cleanYear,
  applicationSettings, publicFiles, photoKey, createVideoUpload, getVideo, deleteVideo, videoUploaded,
  submitDraft, processApplication, enforceApplicationCap, stopReminders, testRunStatus, DRAFT_TTL_DAYS, MAX_PHOTO_BYTES, MAX_THUMB_BYTES, MAX_VIDEO_BYTES,
  areaCheck, placedArea, areaFieldOf, applicantFiles,
} from './_applications.js';
import { allFields, resolveForm, AREA_VALUES, kindOf, isOrganizationKind, rolesFor } from './_application-form.js';
import { formFor, getDraftForm, getLiveForm } from './_application-forms.js';
import { suggestAddresses } from './_address.js';
import { googleOn, googleSuggest, googlePlace, googleVerify } from './_google.js';
import { addressKey } from './_geo.js';
import { turnstileOn, turnstileSiteKey, verifyTurnstile } from './_secure.js';
import { checkImage, imageKind } from './_image-types.js';
import { sendEmails, escapeHtml, isEmail } from './_broadcast-notify.js';

const MAX_DRAFTS_PER_IP_DAY = 20;
const MAX_LINK_SENDS = 5;
const MAX_VIDEO_CREATES = 8;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error, status = 400, extra = {}) => json({ ok: false, error, ...extra }, status);

/** A first name fit for an email greeting: letters only, short; anything else greets without one */
export function greetingName(s) {
  const t = String(s || '').trim();
  return /^[\p{L}][\p{L}'’.-]{0,23}$/u.test(t) ? t : '';
}

/**
 * The signed-in staff member's email (their Cloudflare Access sign-in), or null. The same check
 * as isAuthenticated: the Access header, else the CF_Authorization cookie the admin sign-in sets
 * for the whole site.
 */
export async function staffEmail(request, env) {
  const { CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD } = env || {};
  if (!CF_ACCESS_TEAM_DOMAIN || !CF_ACCESS_AUD) return null;
  const cookie = (request.headers.get('Cookie') || '').split(/;\s*/).find(c => c.startsWith('CF_Authorization='));
  const jwt = request.headers.get('CF-Access-JWT-Assertion') || (cookie ? cookie.slice('CF_Authorization='.length) : '');
  if (!jwt) return null;
  try {
    const payload = await verifyJwt(jwt, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD);
    const email = String(payload?.email || '').trim().toLowerCase();
    // A board member's sign-in passes Access too; only staff (an active Google account) run test applications
    return isEmail(email) && isStaffEmail(email) && (await staffStanding(env, email)).staff ? email : null;
  } catch {
    return null;
  }
}

/** j•••@example.com: an address shown back without spelling it out */
const maskEmail = (e) => String(e).replace(/^(.)[^@]*(@.*)$/, (m, a, b) => `${a}•••${b}`);

/** What the page needs to draw the form: no messages or staff addresses */
export function publicForm(form) {
  return { kind: form.kind || 'family', title: form.title, year: form.year, version: form.version, lang: form.lang, languages: form.languages, pages: form.pages, stops: form.stops, serviceArea: form.serviceArea };
}

/** Is this form taking applications? The family form follows the season; the organization one its own switch */
export const formOpen = (settings, kind) => (isOrganizationKind(kind) ? settings?.orgOpen !== false : settings?.open === true);
/** The page each form lives on (resume links go back to it) */
export const formPath = (kind) => (isOrganizationKind(kind) ? '/apply/community-project/' : '/apply/form/');

/**
 * The stored definition, trimmed to what families see: the page resolves it
 * itself so switching English / Español is instant. No messages, reminder
 * wording or staff emails. The service area goes along: the page draws it
 * on its map (the old Jotform showed the same outline as a picture).
 */
export function publicDefinition(def) {
  const i18n = {};
  for (const [lang, tr] of Object.entries(def?.i18n || {})) {
    const strings = Object.fromEntries(Object.entries(tr?.strings || {}).filter(([p]) => !/^(message|reminder):/.test(p)));
    if (Object.keys(strings).length) i18n[lang] = { strings };
  }
  const sa = def?.serviceArea;
  return {
    schema: def?.schema || 2, ...(isOrganizationKind(def) ? { kind: 'organization' } : {}), title: def?.title, pages: def?.pages || [], stops: def?.stops || {}, i18n,
    ...(sa ? { serviceArea: { polygon: sa.polygon, nearMiles: sa.nearMiles, beyond: sa.beyond } } : {}),
  };
}

/** A check as the page gets it: where the home sits and the answer it gives (no address key) */
export function publicArea(a) {
  if (!a) return null;
  return {
    band: a.band || 'unknown', answer: AREA_VALUES[a.band] || null, miles: a.miles ?? null, edgeMiles: a.edgeMiles ?? null,
    nearMiles: a.nearMiles ?? null, lat: a.lat ?? null, lng: a.lng ?? null, county: a.county || null, matched: a.matched || null,
    ...(a.reason ? { reason: a.reason } : {}),
  };
}

// Address suggestions and area checks: a small per-connection allowance (the form asks as people type)
const allowance = (perMinute) => {
  const hits = new Map();
  return (ip, now = Date.now()) => {
    const e = hits.get(ip);
    if (!e || now > e.reset) { hits.set(ip, { n: 1, reset: now + 60000 }); if (hits.size > 5000) hits.clear(); return true; }
    e.n++;
    return e.n <= perMinute;
  };
};
const addressAllowed = allowance(40);
const areaAllowed = allowance(20);

/** Where an address sits against the service area (the form asks once the address is complete) */
async function handleArea(context, draft, body) {
  const { env, request } = context;
  const addr = body.address && typeof body.address === 'object' ? body.address : null;
  if (!addr) return fail('address required');
  const address = Object.fromEntries(['line1', 'line2', 'city', 'state', 'zip'].map(k => [k, String(addr[k] ?? '').slice(0, k === 'line1' ? 160 : 80)]));
  const form = await formFor(env.DB, { kind: draft?.kind || kindOf(body.kind), year: draft?.year || cleanYear((await applicationSettings(env.DB)).year) });
  if (!areaFieldOf(form)) return json({ ok: true, area: null });
  // A repeat of the address already checked costs nothing; a new one counts against the allowance
  const known = draft ? placedArea(draft.area, address, form.serviceArea) : null;
  if (!known && !areaAllowed(request.headers.get('CF-Connecting-IP') || 'x')) return json({ ok: true, area: { band: 'unknown', reason: 'busy' } });
  const area = known || await areaCheck(env, form, address, { draft });
  return json({ ok: true, area: publicArea(area) });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('Not configured', 503);
  const url = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  // The home address as it's typed: suggestions (Google's when SOARD has a key, else OpenStreetMap's),
  // the parts of a Google one they pick, and the Postal Service's word on the finished address
  if (url.searchParams.has('address')) {
    if (!addressAllowed(ip)) return json({ ok: true, results: [] });
    const q = url.searchParams.get('address');
    const google = await googleSuggest(env, q).catch(() => null);
    if (google?.length) return json({ ok: true, results: google, source: 'google' });
    const results = await suggestAddresses(q).catch(() => []);
    return json({ ok: true, results });
  }
  if (url.searchParams.has('place')) {
    if (!addressAllowed(ip)) return json({ ok: false });
    const address = await googlePlace(env, url.searchParams.get('place')).catch(() => null);
    return json({ ok: !!address, address });
  }
  if (url.searchParams.has('usps')) {
    if (!areaAllowed(ip)) return json({ ok: true, usps: null });
    const p = (k) => String(url.searchParams.get(k) || '').slice(0, 160);
    const usps = await googleVerify(env, { line1: p('line1'), line2: p('line2'), city: p('city'), state: p('state'), zip: p('zip') }).catch(() => null);
    return json({ ok: true, usps });
  }
  const settings = await applicationSettings(env.DB);
  const year = cleanYear(settings.year);
  const kind = kindOf(url.searchParams.get('kind'));
  let live = await getLiveForm(env.DB, { kind });
  let preview = false;
  if (url.searchParams.get('preview') === 'draft' && await isAuthenticated(request, env)) {
    const draft = await getDraftForm(env.DB, { kind });
    if (draft) { live = { version: draft.version, definition: draft.definition }; preview = true; }
  }
  const form = resolveForm(live.definition, { year, version: live.version });
  return json({
    ok: true,
    kind,
    open: formOpen(settings, kind),
    year,
    preview,
    turnstileSiteKey: turnstileOn(env) ? turnstileSiteKey(env) : null,
    usps: googleOn(env),
    version: live.version,
    definition: publicDefinition(live.definition),
    form: publicForm(form),
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('Not configured', 503);
  await ensureSchema(env.DB);
  const type = request.headers.get('content-type') || '';
  if (type.includes('multipart/form-data')) return handlePhoto(context);

  let body;
  try {
    const text = await request.text();
    if (text.length > 300_000) return fail('Too much data', 413);
    body = JSON.parse(text);
  } catch {
    return fail('Expected JSON');
  }
  const action = String(body?.action || '');
  if (action === 'start') return handleStart(context, body);
  // Staff trying the form in a preview have no draft
  if (action === 'area' && !body?.token) {
    if (!await isAuthenticated(request, env)) return fail('This application link has expired or is not valid. Please start a new application.', 404, { code: 'no-draft' });
    return handleArea(context, null, body);
  }

  const draft = await getDraft(env.DB, body?.token);
  if (!draft) return fail('This application link has expired or is not valid. Please start a new application.', 404, { code: 'no-draft' });

  if (action === 'resume') {
    if (body.reminders === 'off') await stopReminders(env.DB, draft.id);
    // The last area check, placed against today's area, so the map shows the home again
    let area = null;
    if (draft.area) {
      const form = await formFor(env.DB, { kind: draft.kind, year: draft.year });
      area = placedArea(draft.area, draft.answers?.address, form.serviceArea)
        || (draft.area.reason === 'no-match' && draft.area.key === addressKey(draft.answers?.address) ? draft.area : null);
    }
    return json({ ok: true, kind: kindOf(draft.kind), year: draft.year, lang: draft.lang || 'en', answers: draft.answers, files: publicFiles(draft.files), page: draft.page || null, maxPage: draft.max_page_id || null, submitted: !!draft.submitted_id, remindersOff: body.reminders === 'off' || !!draft.reminders_off, area: publicArea(area), test: draft.test_by ? { by: draft.test_by } : null });
  }
  if (action === 'test-status') {
    const st = await testRunStatus(env, draft, { nudge: (p) => context.waitUntil(p) });
    return st ? json({ ok: true, ...st }) : fail('Not a test run', 404, { code: 'not-test' });
  }
  if (action === 'reminders-off') {
    await stopReminders(env.DB, draft.id);
    return json({ ok: true });
  }
  if (draft.submitted_id) return action === 'submit' ? json({ ok: true, id: draft.submitted_id, duplicate: true }) : fail('This application has already been submitted.', 409, { code: 'submitted' });

  switch (action) {
    case 'save': {
      if (!body.answers || typeof body.answers !== 'object') return fail('answers required');
      const out = await saveDraft(env.DB, draft, { answers: body.answers, page: body.page, lang: body.lang });
      return json({ ok: true, page: out.page });
    }
    case 'area': return handleArea(context, draft, body);
    case 'email-link': return handleEmailLink(context, draft, body);
    case 'video-url': return handleVideoUrl(context, draft, body);
    case 'video-done': return handleVideoDone(context, draft);
    case 'remove-file': return handleRemoveFile(context, draft, body);
    case 'submit': {
      const out = await submitDraft(env, draft);
      if (!out.ok) return fail(out.error === 'stopped' ? 'stopped' : 'Some answers need attention.', 422, out);
      if (!out.duplicate) {
        context.waitUntil(processApplication(env, out.id));
        // The application limit: the team's heads-up near it, and closing at it (./_application-cap.js)
        context.waitUntil(enforceApplicationCap(env));
      }
      return json({ ok: true, id: out.id });
    }
    default: return fail('Unknown action');
  }
}

async function handleStart(context, body) {
  const { env, request } = context;
  // Honeypot: people never see this field. Answer as if it worked.
  if (String(body.website || '').trim()) return json({ ok: true, token: '0'.repeat(32) });
  const settings = await applicationSettings(env.DB);
  const kind = kindOf(body.kind);
  const es = body.lang === 'es' && kind === 'family';
  // A staff test run: open or closed, no quick check or limit; every email goes to them
  if (body.test) {
    const by = await staffEmail(request, env);
    if (!by) return fail('Test runs are for signed-in SOARD staff. Sign in to the admin, then start the test run again.', 403, { code: 'staff-only' });
    const token = await createDraft(env.DB, { year: cleanYear(body.year || settings.year), testBy: by, lang: es ? 'es' : 'en', kind });
    return json({ ok: true, token, ttlDays: DRAFT_TTL_DAYS, test: { by } });
  }
  const admin = await isAuthenticated(request, env);
  if (!formOpen(settings, kind) && !admin) return fail(es ? 'Las solicitudes están cerradas en este momento.' : 'Applications are closed right now.', 403, { code: 'closed' });
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = await hashIp(ip, env.APPLY_IP_PEPPER || env.LIVE_IP_PEPPER);
  if (!admin && await draftsToday(env.DB, ipHash) >= MAX_DRAFTS_PER_IP_DAY) return fail(es ? 'Hoy se comenzaron demasiadas solicitudes desde esta conexión. Intente de nuevo mañana.' : 'Too many new applications from this connection today. Please try again tomorrow.', 429, { code: 'limit' });
  let verified = !turnstileOn(env);
  if (!verified) {
    verified = admin || await verifyTurnstile(env, body.turnstileToken, ip);
    if (!verified) return fail(es ? 'Complete la verificación rápida arriba del botón Siguiente.' : 'Please complete the quick check above the Next button.', 403, { code: 'turnstile' });
  }
  const token = await createDraft(env.DB, { year: cleanYear(body.year || settings.year), ipHash, verified, lang: es ? 'es' : 'en', kind });
  return json({ ok: true, token, ttlDays: DRAFT_TTL_DAYS });
}

async function handleEmailLink(context, draft, body) {
  const { env, request } = context;
  const es = (body.lang || draft.lang) === 'es';
  // A test run's link goes to the staff member running it, whatever is typed
  const emailId = rolesFor(draft.kind).email;
  const to = draft.test_by || String(body.email || draft.answers?.[emailId] || draft.email || '').trim();
  if (!isEmail(to)) return fail(es ? 'Escriba un correo electrónico válido.' : 'Please enter a valid email address.');
  // Once a link has gone to an address, it goes only there (or to the email the family answered),
  // so a draft can't be used to send our email to anyone a stranger types in
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  if (!draft.test_by && draft.email && !same(to, draft.email) && !same(to, draft.answers?.[emailId])) {
    return fail(es ? `Por su privacidad, solo podemos enviar este enlace a ${maskEmail(draft.email)}, el correo que usó antes.` : `For your privacy, we can only send this link to ${maskEmail(draft.email)}, the address you used before.`, 403, { code: 'email-locked' });
  }
  if ((draft.link_sends || 0) >= MAX_LINK_SENDS) return fail(es ? 'Ya le enviamos este enlace varias veces. Revise su bandeja de entrada y la carpeta de correo no deseado.' : 'We have already emailed this link several times. Please check your inbox and spam folder.', 429);
  const origin = new URL(request.url).origin;
  const link = `${origin}${formPath(draft.kind)}?resume=${draft.id}`;
  const msg = resumeLinkEmail({ year: draft.year, first: greetingName(draft.answers?.[rolesFor(draft.kind).contactName]?.first), link, lang: es ? 'es' : 'en' });
  if (draft.test_by) msg.subject = `[Test run] ${msg.subject}`;
  const r = await sendEmails(env, {
    to: [to],
    ...msg,
    tags: [{ name: 'type', value: 'application-resume' }],
  });
  if (!r.sent) return fail(es ? 'No pudimos enviar el correo en este momento. Intente de nuevo en un minuto.' : 'We could not send the email just now. Please try again in a minute.', 500);
  await env.DB.prepare('UPDATE application_drafts SET link_sends = COALESCE(link_sends, 0) + 1, email = COALESCE(email, ?) WHERE id = ?').bind(to, draft.id).run();
  return json({ ok: true, to });
}

/** The "pick up where you left off" email a family asks for on the form */
export function resumeLinkEmail({ year, first, link, lang = 'en' }) {
  const es = lang === 'es';
  first = String(first || '').trim();
  const t = es ? {
    subject: 'Su solicitud de SOARD: continúe donde se quedó',
    hi: first ? `Hola, ${escapeHtml(first)}:` : 'Hola:',
    saved: `Su solicitud de Sunshine on a Ranney Day ${escapeHtml(year)} está guardada. Use este enlace para continuar donde se quedó, en este dispositivo o en cualquier otro:`,
    button: 'Terminar mi solicitud',
    note: `El enlace funciona durante ${DRAFT_TTL_DAYS} días después de su último cambio. Manténgalo privado, ya que cualquier persona que lo tenga puede ver sus respuestas.`,
  } : {
    subject: 'Your SOARD application: pick up where you left off',
    hi: first ? `Hi ${escapeHtml(first)},` : 'Hi,',
    saved: `Your Sunshine on a Ranney Day ${escapeHtml(year)} application is saved. Use this link to pick up where you left off, on this device or any other:`,
    button: 'Finish my application',
    note: `The link works for ${DRAFT_TTL_DAYS} days after your last change. Please keep it private, since anyone with it can see your answers.`,
  };
  return {
    subject: t.subject,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#373A36;max-width:520px">
<p>${t.hi}</p>
<p>${t.saved}</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#FFDA24;color:#373A36;padding:12px 26px;border-radius:999px;text-decoration:none;font-weight:bold">${t.button}</a></p>
<p style="font-size:14px;color:#5A5B61">${t.note}</p>
<p>Sunshine on a Ranney Day</p>
</div>`,
    text: `${t.saved.replace(/<[^>]+>/g, '')} ${link}\n\n${t.note}`,
  };
}

async function handlePhoto(context) {
  const { env, request } = context;
  const files = applicantFiles(env);
  if (!files) return fail('Uploads are not set up', 503);
  let form;
  try { form = await request.formData(); } catch { return fail('Could not read the upload'); }
  const draft = await getDraft(env.DB, form.get('token'));
  if (!draft) return fail('This application link has expired or is not valid.', 404, { code: 'no-draft' });
  if (draft.submitted_id) return fail('This application has already been submitted.', 409, { code: 'submitted' });
  if (!draft.verified) return fail('Please start the application again.', 403);
  const fieldId = String(form.get('field') || '');
  const field = allFields(await formFor(env.DB, { kind: draft.kind, year: draft.year })).find(f => f.id === fieldId && f.type === 'photo');
  if (!field) return fail('Unknown photo');
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('No photo attached');
  if (!PHOTO_TYPES.has((file.type || '').toLowerCase())) return fail('Please choose a photo (JPEG, PNG, WebP or HEIC).');
  if (file.size > MAX_PHOTO_BYTES) return fail('That photo is too large. Please choose one under 25 MB.');
  // The file's own first bytes must say it's a photo of that kind (a renamed file is turned away)
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = checkImage(bytes, file.type);
  if (!checked.ok || checked.kind === 'gif') return fail('Please choose a photo (JPEG, PNG, WebP or HEIC).');
  const type = checked.type;
  const key = photoKey(draft.id, fieldId);
  await files.put(key, bytes, { httpMetadata: { contentType: type } });
  let thumbKey = null;
  const thumb = form.get('thumb');
  const thumbBytes = thumb && typeof thumb !== 'string' && thumb.size <= MAX_THUMB_BYTES ? new Uint8Array(await thumb.arrayBuffer()) : null;
  if (thumbBytes && imageKind(thumbBytes) === 'jpeg') {
    thumbKey = photoKey(draft.id, fieldId, true);
    await files.put(thumbKey, thumbBytes, { httpMetadata: { contentType: 'image/jpeg' } });
  } else if (draft.files?.[fieldId]?.thumbKey) {
    await files.delete(draft.files[fieldId].thumbKey).catch(() => {});
  }
  const name = String(file.name || `${fieldId}.jpg`).slice(0, 120);
  await setDraftFile(env.DB, draft.id, fieldId, { key, thumbKey, type, size: file.size, name, at: new Date().toISOString() });
  return json({ ok: true, file: { name, size: file.size, hasThumb: !!thumbKey } });
}

async function handleVideoUrl(context, draft, body) {
  const { env, request } = context;
  if (!draft.verified) return fail('Please start the application again.', 403);
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return fail('Video size required');
  if (size > MAX_VIDEO_BYTES) return fail('That video is too large. Please choose one under 4 GB, or record a shorter clip.');
  if ((draft.video_creates || 0) >= MAX_VIDEO_CREATES) return fail('Too many upload attempts for this application. Please email us and we will help.', 429);
  let upload;
  try {
    upload = await createVideoUpload(env, { draftId: draft.id, size, origin: request.headers.get('origin') });
  } catch (e) {
    // The family gets plain words; what went wrong (a Stream setting, its reply) goes to the logs
    console.error('video-url', e?.message || e);
    return fail('We couldn’t start the video upload just now. Please try again in a few minutes.', 500);
  }
  const previous = draft.files?.video?.uid;
  await env.DB.prepare('UPDATE application_drafts SET video_creates = COALESCE(video_creates, 0) + 1 WHERE id = ?').bind(draft.id).run();
  await setDraftFile(env.DB, draft.id, 'video', { uid: upload.uid, uploaded: false, size, name: String(body.name || 'video').slice(0, 120), at: new Date().toISOString() });
  if (previous && previous !== upload.uid) context.waitUntil(deleteVideo(env, previous));
  return json({ ok: true, uploadUrl: upload.uploadUrl });
}

async function handleVideoDone(context, draft) {
  const { env } = context;
  const v = draft.files?.video;
  if (!v?.uid) return fail('No video upload in progress');
  let video;
  try { video = await getVideo(env, v.uid); } catch (e) { console.error('video-check', e?.message || e); return fail('We couldn’t check the video just now. Please try again in a few minutes.', 500); }
  if (video?.status?.state === 'error') return fail('The video could not be processed. Please try a different video file.', 422, { code: 'video-error' });
  const uploaded = videoUploaded(video);
  if (uploaded && !v.uploaded) await setDraftFile(env.DB, draft.id, 'video', { ...v, uploaded: true, duration: video.duration > 0 ? video.duration : null });
  return json({ ok: true, uploaded });
}

async function handleRemoveFile(context, draft, body) {
  const { env } = context;
  const fieldId = String(body.field || '');
  const f = draft.files?.[fieldId];
  if (!f) return json({ ok: true });
  if (fieldId === 'video') { if (f.uid) context.waitUntil(deleteVideo(env, f.uid)); }
  else if (applicantFiles(env)) for (const key of [f.key, f.thumbKey].filter(Boolean)) await applicantFiles(env).delete(key).catch(() => {});
  await setDraftFile(env.DB, draft.id, fieldId, null);
  return json({ ok: true });
}
