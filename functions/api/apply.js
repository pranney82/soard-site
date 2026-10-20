/**
 * /api/apply — the public makeover application (page: /apply/form/)
 * ===========================================================================
 * GET  ?config                     → { open, year, turnstileSiteKey, form }
 *      ?config&preview=draft        → the same with the unsaved draft form (signed-in staff only)
 * POST JSON { action, ... }:
 *   start      { year, turnstileToken?, website }   → { token }  new draft
 *   resume     { token }                            → the draft's answers, files, page
 *   save       { token, answers, page }             → saves the whole answer set
 *   email-link { token, email? }                    → emails a resume link
 *   video-url  { token, size, name }                → one-time Stream tus URL
 *   video-done { token }                            → marks the video uploaded once Stream has it
 *   remove-file{ token, field }                     → clears a photo or the video
 *   submit     { token }                            → { id } and loads it into JobTread
 * POST multipart (action=photo, token, field, file, thumb?) → stores a photo
 *
 * The token is the draft's 128-bit id: whoever holds the resume link can see
 * and change that draft, nobody else. Public route (see _middleware.js), rate
 * limited per IP there and per draft here. A honeypot field ("website") and,
 * once TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY are both set, Turnstile on
 * start keep bots out; submit also needs four real photos and a video Stream
 * accepted, which bots don't bother with.
 */

import { isAuthenticated } from './_middleware.js';
import {
  ensureSchema, getDraft, createDraft, saveDraft, setDraftFile, draftsToday, hashIp, cleanYear,
  applicationSettings, publicFiles, photoKey, createVideoUpload, getVideo, deleteVideo, videoUploaded,
  submitDraft, processApplication, DRAFT_TTL_DAYS, MAX_PHOTO_BYTES, MAX_THUMB_BYTES, MAX_VIDEO_BYTES,
} from './_applications.js';
import { allFields, resolveForm } from './_application-form.js';
import { formFor, getDraftForm } from './_application-forms.js';
import { sendEmails, escapeHtml, isEmail } from './_broadcast-notify.js';

const MAX_DRAFTS_PER_IP_DAY = 20;
const MAX_LINK_SENDS = 5;
const MAX_VIDEO_CREATES = 8;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error, status = 400, extra = {}) => json({ ok: false, error, ...extra }, status);

function turnstileOn(env) {
  return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

async function verifyTurnstile(env, token, ip) {
  if (!token) return false;
  try {
    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET_KEY);
    body.append('response', token);
    if (ip) body.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    const out = await res.json();
    return !!out.success;
  } catch {
    return false;
  }
}

/** What the page needs to draw the form: no messages or staff addresses */
export function publicForm(form) {
  return { title: form.title, year: form.year, version: form.version, pages: form.pages, stops: form.stops };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('Not configured', 503);
  const url = new URL(request.url);
  const settings = await applicationSettings(env.DB);
  const year = cleanYear(settings.year);
  let form = await formFor(env.DB, { year });
  let preview = false;
  if (url.searchParams.get('preview') === 'draft' && await isAuthenticated(request, env)) {
    const draft = await getDraftForm(env.DB);
    if (draft) { form = resolveForm(draft.definition, { year, version: draft.version }); preview = true; }
  }
  return json({
    ok: true,
    open: settings.open === true,
    year,
    preview,
    turnstileSiteKey: turnstileOn(env) ? env.TURNSTILE_SITE_KEY : null,
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

  const draft = await getDraft(env.DB, body?.token);
  if (!draft) return fail('This application link has expired or is not valid. Please start a new application.', 404, { code: 'no-draft' });

  if (action === 'resume') {
    return json({ ok: true, year: draft.year, answers: draft.answers, files: publicFiles(draft.files), page: draft.page || null, submitted: !!draft.submitted_id });
  }
  if (draft.submitted_id) return action === 'submit' ? json({ ok: true, id: draft.submitted_id, duplicate: true }) : fail('This application has already been submitted.', 409, { code: 'submitted' });

  switch (action) {
    case 'save': {
      if (!body.answers || typeof body.answers !== 'object') return fail('answers required');
      const out = await saveDraft(env.DB, draft, { answers: body.answers, page: body.page });
      return json({ ok: true, page: out.page });
    }
    case 'email-link': return handleEmailLink(context, draft, body);
    case 'video-url': return handleVideoUrl(context, draft, body);
    case 'video-done': return handleVideoDone(context, draft);
    case 'remove-file': return handleRemoveFile(context, draft, body);
    case 'submit': {
      const out = await submitDraft(env, draft);
      if (!out.ok) return fail(out.error === 'stopped' ? 'stopped' : 'Some answers need attention.', 422, out);
      if (!out.duplicate) context.waitUntil(processApplication(env, out.id));
      return json({ ok: true, id: out.id });
    }
    default: return fail('Unknown action');
  }
}

async function handleStart(context, body) {
  const { env, request } = context;
  // Honeypot: people never see this field. Answer as if it worked.
  if (String(body.website || '').trim()) return json({ ok: true, token: '0'.repeat(32) });
  const admin = await isAuthenticated(request, env);
  const settings = await applicationSettings(env.DB);
  if (settings.open !== true && !admin) return fail('Applications are closed right now.', 403, { code: 'closed' });
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = await hashIp(ip);
  if (!admin && await draftsToday(env.DB, ipHash) >= MAX_DRAFTS_PER_IP_DAY) return fail('Too many new applications from this connection today. Please try again tomorrow.', 429);
  let verified = !turnstileOn(env);
  if (!verified) {
    verified = admin || await verifyTurnstile(env, body.turnstileToken, ip);
    if (!verified) return fail('Please complete the quick check below the Start button.', 403, { code: 'turnstile' });
  }
  const token = await createDraft(env.DB, { year: cleanYear(body.year || settings.year), ipHash, verified });
  return json({ ok: true, token, ttlDays: DRAFT_TTL_DAYS });
}

async function handleEmailLink(context, draft, body) {
  const { env, request } = context;
  const to = String(body.email || draft.answers?.parentEmail || draft.email || '').trim();
  if (!isEmail(to)) return fail('Please enter a valid email address.');
  if ((draft.link_sends || 0) >= MAX_LINK_SENDS) return fail('We have already emailed this link several times. Please check your inbox and spam folder.', 429);
  const origin = new URL(request.url).origin;
  const link = `${origin}/apply/form/?resume=${draft.id}`;
  const first = String(draft.answers?.parentName?.first || '').trim();
  const r = await sendEmails(env, {
    to: [to],
    subject: 'Your SOARD application: pick up where you left off',
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#373A36;max-width:520px">
<p>${first ? `Hi ${escapeHtml(first)},` : 'Hi,'}</p>
<p>Your Sunshine on a Ranney Day ${escapeHtml(draft.year)} application is saved. Use this link to pick up where you left off, on this device or any other:</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#FFDA24;color:#373A36;padding:12px 26px;border-radius:999px;text-decoration:none;font-weight:bold">Finish my application</a></p>
<p style="font-size:14px;color:#5A5B61">The link works for ${DRAFT_TTL_DAYS} days after your last change. Please keep it private, since anyone with it can see your answers.</p>
<p>Sunshine on a Ranney Day</p>
</div>`,
    text: `Your Sunshine on a Ranney Day ${draft.year} application is saved. Pick up where you left off: ${link}\n\nThe link works for ${DRAFT_TTL_DAYS} days after your last change. Please keep it private, since anyone with it can see your answers.`,
    tags: [{ name: 'type', value: 'application-resume' }],
  });
  if (!r.sent) return fail('We could not send the email just now. Please try again in a minute.', 500);
  await env.DB.prepare('UPDATE application_drafts SET link_sends = COALESCE(link_sends, 0) + 1, email = COALESCE(email, ?) WHERE id = ?').bind(to, draft.id).run();
  return json({ ok: true });
}

async function handlePhoto(context) {
  const { env, request } = context;
  if (!env.FILES) return fail('Uploads are not set up', 503);
  let form;
  try { form = await request.formData(); } catch { return fail('Could not read the upload'); }
  const draft = await getDraft(env.DB, form.get('token'));
  if (!draft) return fail('This application link has expired or is not valid.', 404, { code: 'no-draft' });
  if (draft.submitted_id) return fail('This application has already been submitted.', 409, { code: 'submitted' });
  if (!draft.verified) return fail('Please start the application again.', 403);
  const fieldId = String(form.get('field') || '');
  const field = allFields(await formFor(env.DB, { year: draft.year })).find(f => f.id === fieldId && f.type === 'photo');
  if (!field) return fail('Unknown photo');
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('No photo attached');
  const type = (file.type || '').toLowerCase();
  if (!PHOTO_TYPES.has(type)) return fail('Please choose a photo (JPEG, PNG, WebP or HEIC).');
  if (file.size > MAX_PHOTO_BYTES) return fail('That photo is too large. Please choose one under 25 MB.');
  const key = photoKey(draft.id, fieldId);
  await env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type } });
  let thumbKey = null;
  const thumb = form.get('thumb');
  if (thumb && typeof thumb !== 'string' && thumb.type === 'image/jpeg' && thumb.size <= MAX_THUMB_BYTES) {
    thumbKey = photoKey(draft.id, fieldId, true);
    await env.FILES.put(thumbKey, await thumb.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } });
  } else if (draft.files?.[fieldId]?.thumbKey) {
    await env.FILES.delete(draft.files[fieldId].thumbKey).catch(() => {});
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
    return fail(`We could not start the video upload. ${e.message}`, 500);
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
  try { video = await getVideo(env, v.uid); } catch (e) { return fail(`We could not check the video. ${e.message}`, 500); }
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
  else if (env.FILES) for (const key of [f.key, f.thumbKey].filter(Boolean)) await env.FILES.delete(key).catch(() => {});
  await setDraftFile(env.DB, draft.id, fieldId, null);
  return json({ ok: true });
}
