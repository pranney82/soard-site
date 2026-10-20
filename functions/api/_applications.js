/**
 * Makeover applications: drafts, submit, and the load into JobTread
 * ===========================================================================
 * The form at /apply/form/ (definition in ./_application-form.js) saves a
 * draft on every step, keyed by an unguessable token the family keeps in a
 * resume link. Photos go to private R2 (FILES, under applications/<draft>/),
 * the video straight from the browser to Cloudflare Stream (private, signed
 * URLs only). Submit freezes the draft into an `applications` row and runs
 * processApplication, which builds the JobTread customer the way the Jotform
 * + Zapier pipeline did, and attaches what staff used to download and upload
 * by hand:
 *
 *   account   child's name, Status "Applied", Diagnosis, Birthday, Gender,
 *             Language, Referred By, Verbal, Mobile, *Makeover Year/Type,
 *             Application URL (all in the create call, so nothing that reacts
 *             to a new account ever sees it half filled)
 *   contacts  each parent/guardian (title = relationship, Email, Phone)
 *   location  the child's home (County); DataX fills Zillow data on its own
 *   files     {Child}_Application.pdf, four photos, {Child}_Application.mp4
 *             (the video follows once Stream has processed it)
 *   messages  "Application Status" to the family with the PDF attached, and
 *             the internal "Child's Medical Condition" (./_applicant-comms.js)
 *   email     a heads-up to the Qualification Committee inbox
 *
 * Every step records its result in jt_state and is skipped once done, so a
 * retry (the sweep below, or Retry in admin) never makes a second account,
 * contact or file. A create call that timed out is looked up by its
 * Application URL before it's tried again.
 *
 * Env: JOBTREAD_GRANT_KEY, JOBTREAD_QC_GRANT_KEY (optional), CF_ACCOUNT_ID +
 * CF_STREAM_TOKEN (video), RESEND_API_KEY (emails), FILES (R2), DB, AI.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import {
  applicationForm, cleanAnswers, formErrors, stopFor, nameText, addressText, toE164, allFields,
} from './_application-form.js';
import { buildApplicationPdf } from './_application-pdf.js';
import { sendEmails, escapeHtml, SITE_ORIGIN } from './_broadcast-notify.js';
import { readApplicant, sendIntake, ensureCommsSchema } from './_applicant-comms.js';

// ─── JobTread fields (SOARD org) ────────────────────────────────────
export const JT_FIELDS = {
  status: '22P46wDp3NLd',
  diagnosis: '22P46st8HNPY',
  birthday: '22P46syd4j6E',
  language: '22P46u8a49hk',
  gender: '22P4VnkCXPSY',
  referredBy: '22P4VnmXcjjy',
  applicationUrl: '22P4v2gNtdFR',
  verbal: '22PJxPDbM5Rr',
  mobile: '22PJxPF6vCpk',
  makeoverYear: '22P52xmCz3cx',
  makeoverType: '22P5KVgrLeXK',
  contactEmail: '22NJw43QvHeJ',
  contactPhone: '22NJw43UauSc',
  county: '22PK2MzzJD93',
};
const JT_LANGUAGES = ['English', 'Spanish', 'French', 'Vietnamese', 'Chinese', 'Korean'];
const JT_YEARS = ['2025', '2026', '2027', '2028', '2029', '2030'];
export const MAKEOVER_TYPE_MAP = {
  'Accessible Bathroom': 'Bathroom',
  'Dream Bedroom': 'Bedroom',
  'In-Home Therapy Room': 'Therapy Room',
  Ramp: 'Ramp',
};

export const STAFF_EMAILS = ['selection@soardcharity.com'];
export const ALERT_EMAILS = ['peter@soardcharity.com'];

const PHOTO_FIELDS = ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2'];
const PHOTO_FILE_NAMES = {
  photoChild: (c) => `${c}.jpg`,
  photoFamily: (c) => `${c} Family.jpg`,
  photoSpace1: (c) => `${c} Space 1.jpg`,
  photoSpace2: (c) => `${c} Space 2.jpg`,
};

export const DRAFT_TTL_DAYS = 60;
const LOCK_MS = 2 * 60 * 1000;
const SWEEP_EVERY_MS = 2 * 60 * 1000;
const ALERT_AFTER_ATTEMPTS = 4;
const MEDICAL_TRIES = 4;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const JT_TIMEOUT_MS = 25000;
export const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 600;
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const MAX_THUMB_BYTES = 1024 * 1024;

// ─── D1 ─────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS application_drafts (
    id TEXT PRIMARY KEY, year TEXT, email TEXT, answers TEXT, files TEXT, page TEXT,
    ip_hash TEXT, verified INTEGER DEFAULT 0, link_sends INTEGER DEFAULT 0, video_creates INTEGER DEFAULT 0,
    submitted_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_application_drafts_updated ON application_drafts(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_application_drafts_ip ON application_drafts(ip_hash, created_at)`,
  `CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY, draft_id TEXT, year TEXT, child_name TEXT, parent_name TEXT, parent_email TEXT,
    makeover_types TEXT, answers TEXT, files TEXT, is_test INTEGER DEFAULT 0,
    jt_account_id TEXT, jt_state TEXT, status TEXT NOT NULL, attempts INTEGER DEFAULT 0,
    next_try_at INTEGER, locked_until INTEGER, last_error TEXT, alerted TEXT,
    submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status, next_try_at)`,
  `CREATE INDEX IF NOT EXISTS idx_applications_account ON applications(jt_account_id)`,
  // Runtime bookkeeping (sweep slot). Not site_config: site_config rows are written into builds.
  `CREATE TABLE IF NOT EXISTS application_runtime (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`,
];
const _schemaReady = new WeakSet();
export async function ensureSchema(DB) {
  if (_schemaReady.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _schemaReady.add(DB);
  await ensureCommsSchema(DB);
}

const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const iso = (t) => new Date(t).toISOString();

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const newDraftId = () => randomHex(16);
export const newApplicationId = () => `app-${Date.now().toString(36)}-${randomHex(3)}`;
export const isDraftId = (s) => /^[0-9a-f]{32}$/.test(String(s || ''));
export const isApplicationId = (s) => /^app-[0-9a-z]{6,12}-[0-9a-f]{6}$/.test(String(s || ''));

export async function hashIp(ip) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`soard-apply:${ip || 'unknown'}`));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A season year the form may be filled for: this year through two years out */
export function cleanYear(y, now = Date.now()) {
  const n = Number(String(y || '').trim());
  const thisYear = new Date(now).getUTCFullYear();
  return Number.isInteger(n) && n >= thisYear - 1 && n <= thisYear + 2 ? String(n) : String(thisYear + 1);
}

/** Admin settings for the application (D1 site_config "settings"), or {} */
export async function applicationSettings(DB) {
  try {
    const row = await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first();
    return parse(row?.data, {})?.application || {};
  } catch {
    return {};
  }
}

// ─── Drafts ─────────────────────────────────────────────────────────

function draftRow(r) {
  if (!r) return null;
  return { ...r, answers: parse(r.answers, {}), files: parse(r.files, {}) };
}

export async function getDraft(DB, id) {
  if (!isDraftId(id)) return null;
  await ensureSchema(DB);
  return draftRow(await DB.prepare('SELECT * FROM application_drafts WHERE id = ?').bind(id).first());
}

export async function createDraft(DB, { year, ipHash, verified = false, now = Date.now() }) {
  await ensureSchema(DB);
  const id = newDraftId();
  await DB.prepare(`INSERT INTO application_drafts (id, year, answers, files, ip_hash, verified, created_at, updated_at) VALUES (?, ?, '{}', '{}', ?, ?, ?, ?)`)
    .bind(id, year, ipHash || null, verified ? 1 : 0, iso(now), iso(now)).run();
  return id;
}

export async function draftsToday(DB, ipHash, now = Date.now()) {
  await ensureSchema(DB);
  const row = await DB.prepare('SELECT COUNT(*) AS n FROM application_drafts WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, iso(now - 24 * 3600 * 1000)).first();
  return Number(row?.n || 0);
}

export async function saveDraft(DB, draft, { answers, page }, now = Date.now()) {
  const form = applicationForm({ year: draft.year });
  const clean = cleanAnswers(form, answers || {});
  const email = clean.parentEmail || draft.email || null;
  const pageId = form.pages.some(p => p.id === page) ? page : draft.page;
  await DB.prepare('UPDATE application_drafts SET answers = ?, page = ?, email = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(clean), pageId || null, email, iso(now), draft.id).run();
  return { answers: clean, page: pageId };
}

export async function setDraftFile(DB, draftId, fieldId, record, now = Date.now()) {
  const draft = await getDraft(DB, draftId);
  if (!draft) throw new Error('draft not found');
  const files = { ...draft.files };
  if (record) files[fieldId] = record; else delete files[fieldId];
  await DB.prepare('UPDATE application_drafts SET files = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(files), iso(now), draftId).run();
  return files;
}

/** What the browser gets back on resume: never R2 keys or Stream ids */
export function publicFiles(files = {}) {
  const out = {};
  for (const [k, v] of Object.entries(files)) {
    if (k === 'video') out.video = { uploaded: !!v.uploaded, name: v.name || null, size: v.size || null };
    else out[k] = { name: v.name || null, size: v.size || null, hasThumb: !!v.thumbKey };
  }
  return out;
}

export const photoKey = (draftId, fieldId, thumb = false) => `applications/${draftId}/${fieldId}${thumb ? '-thumb' : ''}.jpg`;

// ─── Cloudflare Stream ──────────────────────────────────────────────

function streamConfigured(env) {
  return !!(env.CF_ACCOUNT_ID && env.CF_STREAM_TOKEN);
}

async function streamApi(env, path, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CF_STREAM_TOKEN}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = json?.errors?.[0]?.message || `HTTP ${res.status}`;
    const err = new Error(`Stream: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

/**
 * A one-time tus upload URL for a family's video. Private (signed URLs only),
 * capped at MAX_VIDEO_SECONDS, uploadable only from the page's origin.
 */
export async function createVideoUpload(env, { draftId, size, origin }, fetchImpl = fetch) {
  if (!streamConfigured(env)) throw new Error('Video uploads are not set up (CF_ACCOUNT_ID / CF_STREAM_TOKEN)');
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(String(s))));
  const meta = [`name ${b64(`application ${draftId.slice(0, 8)}`)}`, 'requiresignedurls', `maxdurationseconds ${b64(MAX_VIDEO_SECONDS)}`];
  try { if (origin) meta.push(`allowedorigins ${b64(new URL(origin).host)}`); } catch { /* no origin: Stream allows any */ }
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream?direct_user=true`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_STREAM_TOKEN}`,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Metadata': meta.join(','),
      'Upload-Creator': `application-${draftId.slice(0, 8)}`,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 200);
    try { detail = JSON.parse(text)?.errors?.[0]?.message || detail; } catch { /* plain text */ }
    throw new Error(`Stream ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const uploadUrl = res.headers.get('location');
  const uid = res.headers.get('stream-media-id');
  if (!uploadUrl || !uid) throw new Error('Stream did not return an upload URL');
  return { uploadUrl, uid };
}

export async function getVideo(env, uid, fetchImpl = fetch) {
  return streamApi(env, `/${encodeURIComponent(uid)}`, {}, fetchImpl);
}

export async function deleteVideo(env, uid, fetchImpl = fetch) {
  try { await streamApi(env, `/${encodeURIComponent(uid)}`, { method: 'DELETE' }, fetchImpl); } catch { /* best effort */ }
}

/** Has the tus upload finished? (Stream has the whole file, processing or not) */
export function videoUploaded(video) {
  const state = video?.status?.state;
  return !!video && state !== 'pendingupload' && state !== 'error' && state !== undefined;
}

/**
 * A signed MP4 download URL once Stream has made one, or null while it's
 * still processing. Asks Stream to make the MP4 the first time.
 */
export async function videoDownloadUrl(env, uid, fetchImpl = fetch) {
  const video = await getVideo(env, uid, fetchImpl);
  if (video?.status?.state === 'error') throw new Error(`Stream could not process the video (${video.status.errorReasonCode || 'error'})`);
  if (!video?.readyToStream) return null;
  let dl = (await streamApi(env, `/${encodeURIComponent(uid)}/downloads`, {}, fetchImpl))?.default;
  if (!dl) dl = (await streamApi(env, `/${encodeURIComponent(uid)}/downloads`, { method: 'POST', body: '{}' }, fetchImpl))?.default;
  if (!dl || dl.status !== 'ready' || !dl.url) return null;
  const token = (await streamApi(env, `/${encodeURIComponent(uid)}/token`, {
    method: 'POST', body: JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 6 * 3600, downloadable: true }),
  }, fetchImpl))?.token;
  if (!token) throw new Error('Stream did not sign a download URL');
  return dl.url.replace(`/${uid}/`, `/${token}/`);
}

// ─── Submit ─────────────────────────────────────────────────────────

/** Is this a rehearsal? Child's first name "TEST" (any case), or an admin test */
export function isTestAnswers(answers) {
  return /^test\b/i.test(String(answers?.childName?.first || '').trim());
}

/**
 * Freeze a draft into an application. Returns { ok, id } or { ok: false,
 * errors | error }. Submitting twice returns the same application.
 */
export async function submitDraft(env, draft, { now = Date.now(), forceTest = false } = {}) {
  const { DB } = env;
  if (draft.submitted_id) return { ok: true, id: draft.submitted_id, duplicate: true };
  const form = applicationForm({ year: draft.year });
  const answers = cleanAnswers(form, draft.answers);
  const stop = stopFor(form, answers);
  if (stop) return { ok: false, error: 'stopped', stop: stop.key };
  const errors = formErrors(form, answers, draft.files);
  if (Object.keys(errors).length) return { ok: false, errors };

  const id = newApplicationId();
  const childName = nameText(answers.childName);
  const isTest = forceTest || isTestAnswers(answers);
  const at = iso(now);
  // Claim the draft first so a double tap can't make two applications
  const claimed = await DB.prepare('UPDATE application_drafts SET submitted_id = ?, updated_at = ? WHERE id = ? AND submitted_id IS NULL').bind(id, at, draft.id).run();
  if (!(claimed?.meta?.changes > 0)) {
    const again = await getDraft(DB, draft.id);
    return { ok: true, id: again?.submitted_id, duplicate: true };
  }
  await DB.prepare(`INSERT INTO applications (id, draft_id, year, child_name, parent_name, parent_email, makeover_types, answers, files, is_test,
      jt_state, status, attempts, next_try_at, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'processing', 0, ?, ?, ?)`)
    .bind(id, draft.id, draft.year, childName, nameText(answers.parentName), answers.parentEmail || null,
      JSON.stringify(answers.makeoverTypes || []), JSON.stringify(answers), JSON.stringify(draft.files || {}), isTest ? 1 : 0, now, at, at).run();
  return { ok: true, id };
}

function applicationRow(r) {
  if (!r) return null;
  return { ...r, answers: parse(r.answers, {}), files: parse(r.files, {}), jt_state: parse(r.jt_state, {}), makeover_types: parse(r.makeover_types, []) };
}

export async function getApplication(DB, id) {
  await ensureSchema(DB);
  return applicationRow(await DB.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first());
}

// ─── JobTread load ──────────────────────────────────────────────────

/** The admin record link stored in the account's Application URL field */
export const applicationUrl = (id) => `${SITE_ORIGIN}/admin/#applications/${id}`;
export const jobtreadAccountUrl = (accountId) => `https://app.jobtread.com/customers/${accountId}`;

/** The account's display name: the child's name, "TEST " in front of a rehearsal */
export function accountName(app) {
  const name = nameText(app.answers.childName) || 'Applicant';
  return app.is_test && !/^test\b/i.test(name) ? `TEST ${name}` : name;
}

const yesNo = (s) => (String(s || '').startsWith('Yes') ? 'Yes' : String(s || '').startsWith('No') ? 'No' : null);

/** Custom field values for createAccount */
export function accountFields(app) {
  const a = app.answers;
  const types = [...new Set((a.makeoverTypes || []).map(t => MAKEOVER_TYPE_MAP[t]).filter(Boolean))];
  const f = {
    [JT_FIELDS.status]: 'Applied',
    [JT_FIELDS.diagnosis]: String(a.diagnosis || '').slice(0, 4000) || null,
    [JT_FIELDS.birthday]: /^\d{4}-\d{2}-\d{2}$/.test(a.birthdate || '') ? a.birthdate : null,
    [JT_FIELDS.gender]: ['Male', 'Female'].includes(a.gender) ? a.gender : null,
    [JT_FIELDS.language]: JT_LANGUAGES.includes(a.language) ? a.language : null,
    [JT_FIELDS.referredBy]: a.referredBy || null,
    [JT_FIELDS.verbal]: yesNo(a.verbal),
    [JT_FIELDS.mobile]: yesNo(a.ambulatory),
    [JT_FIELDS.makeoverYear]: JT_YEARS.includes(String(app.year)) ? String(app.year) : null,
    [JT_FIELDS.makeoverType]: types.length ? types : null,
    [JT_FIELDS.applicationUrl]: applicationUrl(app.id),
  };
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v != null));
}

/** The parents/guardians as JobTread contacts, main contact first */
export function contactInputs(app) {
  const a = app.answers;
  const out = [];
  const add = (name, relation, email, phone) => {
    const n = nameText(name);
    if (!n) return;
    const fields = {};
    if (email) fields[JT_FIELDS.contactEmail] = email;
    const e164 = toE164(phone);
    if (e164) fields[JT_FIELDS.contactPhone] = e164;
    out.push({ name: n, title: relation || null, customFieldValues: fields });
  };
  add(a.parentName, a.parentRelation, a.parentEmail, a.parentPhone);
  add(a.parent2Name, a.parent2Relation, a.parent2Email, a.parent2Phone);
  return out;
}

function jtFetch(fetchImpl) {
  return (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(JT_TIMEOUT_MS) });
}

/** An account this application already made (a create whose answer we lost), by its Application URL */
async function findAccountByUrl(env, app, since, fetchImpl) {
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    organization: {
      $: { id: SOARD_ORG_ID },
      accounts: {
        $: { size: 25, where: { and: [['type', '=', 'customer'], ['createdAt', '>=', iso(since - 5 * 60 * 1000)]] } },
        nodes: { id: {}, customFieldValues: { $: { where: [['customField', 'id'], '=', JT_FIELDS.applicationUrl] }, nodes: { value: {} } } },
      },
    },
  }, fetchImpl);
  const url = applicationUrl(app.id);
  return (data?.organization?.accounts?.nodes || []).find(n => n.customFieldValues?.nodes?.some(v => v.value === url))?.id || null;
}

/** Upload bytes to JobTread; returns the upload request id */
async function uploadBytes(env, { bytes, type }, fetchImpl) {
  const out = await pave(env.JOBTREAD_GRANT_KEY, {
    createUploadRequest: {
      $: { organizationId: SOARD_ORG_ID, size: bytes.byteLength, type },
      createdUploadRequest: { id: {}, url: {}, method: {}, headers: {} },
    },
  }, fetchImpl);
  const req = out?.createUploadRequest?.createdUploadRequest;
  if (!req?.url) throw new Error('JobTread did not return an upload URL');
  const res = await fetchImpl(req.url, { method: req.method || 'PUT', headers: req.headers || {}, body: bytes });
  if (!res.ok) throw new Error(`JobTread upload returned ${res.status}`);
  return req.id;
}

/**
 * Have JobTread fetch a public URL (the signed Stream MP4) itself; it fetches
 * right away and takes the type from the response. Returns the upload request id.
 */
async function uploadFromUrl(env, url, fetchImpl) {
  const out = await pave(env.JOBTREAD_GRANT_KEY, {
    createUploadRequest: { $: { organizationId: SOARD_ORG_ID, url }, createdUploadRequest: { id: {} } },
  }, fetchImpl);
  const id = out?.createUploadRequest?.createdUploadRequest?.id;
  if (!id) throw new Error('JobTread did not accept the video URL');
  return id;
}

async function attachFile(env, { accountId, name, uploadRequestId }, fetchImpl) {
  const out = await pave(env.JOBTREAD_GRANT_KEY, {
    createFile: { $: { name, targetType: 'account', targetId: accountId, uploadRequestId }, createdFile: { id: {} } },
  }, fetchImpl);
  return out?.createFile?.createdFile?.id || null;
}

async function r2Bytes(env, key) {
  if (!key || !env.FILES) return null;
  const obj = await env.FILES.get(key);
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

const pdfKey = (app) => `applications/${app.draft_id}/application.pdf`;
const pdfName = (app) => `${accountName(app)}_Application.pdf`;

async function ensurePdf(env, app) {
  const existing = app.jt_state.pdf?.key ? await r2Bytes(env, app.jt_state.pdf.key) : null;
  if (existing) return existing;
  const form = applicationForm({ year: app.year });
  const photos = {};
  for (const id of PHOTO_FIELDS) {
    const f = app.files[id];
    const bytes = await r2Bytes(env, f?.thumbKey);
    if (bytes) photos[id] = bytes;
  }
  const bytes = await buildApplicationPdf({ form, answers: app.answers, files: app.files, submittedAt: app.submitted_at, photos });
  await env.FILES.put(pdfKey(app), bytes, { httpMetadata: { contentType: 'application/pdf' } });
  app.jt_state.pdf = { key: pdfKey(app), size: bytes.byteLength };
  return bytes;
}

function staffEmail(app, accountId) {
  const a = app.answers;
  const first = String(a.childName?.first || 'A new applicant').trim();
  const types = (a.makeoverTypes || []).join(' and ') || 'a makeover';
  const lines = [
    ['Child', nameText(a.childName)],
    ['Makeover', types],
    ['Diagnosis', a.diagnosis],
    ['County', a.county],
    ['Inside the service area', a.boundary],
    ['Main contact', [nameText(a.parentName), a.parentEmail].filter(Boolean).join(', ')],
  ].filter(([, v]) => v);
  const rows = lines.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#5A5B61;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0;color:#373A36">${escapeHtml(v)}</td></tr>`).join('');
  const link = accountId ? jobtreadAccountUrl(accountId) : applicationUrl(app.id);
  return {
    subject: `${app.is_test ? '[TEST] ' : ''}New makeover application: ${first}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#373A36;max-width:560px">
<p>A ${escapeHtml(app.year)} application just came in through the website for <strong>${escapeHtml(first)}</strong> (${escapeHtml(types)}).</p>
<table style="border-collapse:collapse;margin:12px 0">${rows}</table>
<p>It's in JobTread with the application PDF and photos attached; the video follows once it finishes processing. The family has been sent the "Application Status" message.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#FFDA24;color:#373A36;padding:10px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Open in JobTread</a></p>
</div>`,
    text: `A ${app.year} application just came in for ${first} (${types}).\n\n${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nOpen in JobTread: ${link}`,
  };
}

async function saveState(DB, app, fields = {}, now = Date.now()) {
  const sets = ['jt_state = ?', 'updated_at = ?'];
  const binds = [JSON.stringify(app.jt_state), iso(now)];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); binds.push(v); }
  await DB.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, app.id).run();
}

/** Which steps are done (for the admin checklist) */
export function checklist(app) {
  const s = app.jt_state || {};
  const contactsWanted = contactInputs(app).length;
  const photosWanted = PHOTO_FIELDS.filter(id => app.files?.[id]).length;
  const photosDone = PHOTO_FIELDS.filter(id => s.files?.[id]?.id).length;
  return {
    account: !!s.account?.id,
    contacts: (s.contacts || []).filter(c => c?.id).length >= contactsWanted,
    home: !!s.location?.id,
    pdf: !!s.files?.pdf?.id,
    photos: photosDone >= photosWanted,
    video: app.files?.video ? (s.video?.id ? true : s.video?.error ? 'error' : 'waiting') : 'none',
    familyMessage: s.intake?.welcome === 'sent' || s.intake?.welcome === 'already' ? true : s.intake?.welcome || false,
    medicalNote: s.intake?.medical === 'sent' || s.intake?.medical === 'already' ? true : s.intake?.medical || false,
    staffEmail: !!s.staffEmail,
  };
}

/**
 * Do (or finish) everything for one application. Safe to call any number of
 * times, from anywhere: a D1 lock keeps runs from overlapping, and each step
 * is skipped once done. Never throws; returns { status, error? }.
 */
export async function processApplication(env, id, opts = {}) {
  try {
    return await runApplication(env, id, opts);
  } catch (e) {
    try {
      await env.DB.prepare('UPDATE applications SET locked_until = NULL, last_error = ?, status = ?, next_try_at = ?, updated_at = ? WHERE id = ?')
        .bind(String(e.message).slice(0, 500), 'error', (opts.now || Date.now()) + 5 * 60 * 1000, iso(opts.now || Date.now()), id).run();
    } catch { /* D1 itself is down: the lock expires on its own */ }
    return { status: 'error', error: e.message };
  }
}

async function runApplication(env, id, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const lock = await DB.prepare('UPDATE applications SET locked_until = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)')
    .bind(now + LOCK_MS, id, now).run();
  if (!(lock?.meta?.changes > 0)) return { status: 'busy' };
  const app = await getApplication(DB, id);
  if (!app) return { status: 'missing' };
  const jt = jtFetch(fetchImpl);
  const s = app.jt_state;
  s.files ||= {};
  let error = null;
  let waiting = false;

  const step = async (name, fn) => {
    if (error) return;
    try { await fn(); } catch (e) { error = `${name}: ${e.message}`; }
    await saveState(DB, app, {}, now);
  };

  if (!env.JOBTREAD_GRANT_KEY) error = 'JOBTREAD_GRANT_KEY is not set';

  // The PDF first: it doesn't need JobTread, and the family's message carries it
  let pdf = null;
  await step('pdf', async () => { pdf = await ensurePdf(env, app); });

  await step('account', async () => {
    if (s.account?.id) return;
    if (s.accountTriedAt) {
      const found = await findAccountByUrl(env, app, s.accountTriedAt, jt);
      if (found) { s.account = { id: found, adopted: true }; return; }
    }
    s.accountTriedAt = now;
    await saveState(DB, app, {}, now);
    const out = await pave(env.JOBTREAD_GRANT_KEY, {
      createAccount: {
        $: { organizationId: SOARD_ORG_ID, type: 'customer', name: accountName(app), suffixIfNecessary: true, customFieldValues: accountFields(app) },
        createdAccount: { id: {} },
      },
    }, jt);
    const accountId = out?.createAccount?.createdAccount?.id;
    if (!accountId) throw new Error('JobTread did not return the new account');
    s.account = { id: accountId };
    await saveState(DB, app, { jt_account_id: accountId }, now);
  });
  if (s.account?.id && !app.jt_account_id) await saveState(DB, app, { jt_account_id: s.account.id }, now);
  const accountId = s.account?.id;

  await step('contacts', async () => {
    s.contacts ||= [];
    const inputs = contactInputs(app);
    for (let i = 0; i < inputs.length; i++) {
      if (s.contacts[i]?.id) continue;
      const out = await pave(env.JOBTREAD_GRANT_KEY, {
        createContact: { $: { accountId, ...inputs[i] }, createdContact: { id: {} } },
      }, jt);
      s.contacts[i] = { id: out?.createContact?.createdContact?.id || null };
      if (!s.contacts[i].id) throw new Error('JobTread did not return the new contact');
      await saveState(DB, app, {}, now);
    }
  });

  await step('home', async () => {
    if (s.location?.id) return;
    const a = app.answers;
    const out = await pave(env.JOBTREAD_GRANT_KEY, {
      createLocation: {
        $: {
          accountId, address: addressText(a.address), name: a.address?.line1 || null, parseAddress: true,
          ...(s.contacts?.[0]?.id ? { contactId: s.contacts[0].id } : {}),
          ...(a.county ? { customFieldValues: { [JT_FIELDS.county]: a.county } } : {}),
        },
        createdLocation: { id: {} },
      },
    }, jt);
    s.location = { id: out?.createLocation?.createdLocation?.id || null };
    if (!s.location.id) throw new Error('JobTread did not return the new location');
  });

  await step('pdf file', async () => {
    if (s.files.pdf?.id) return;
    const uploadRequestId = await uploadBytes(env, { bytes: pdf, type: 'application/pdf' }, jt);
    s.files.pdf = { id: await attachFile(env, { accountId, name: pdfName(app), uploadRequestId }, jt) };
  });

  await step('photos', async () => {
    for (const fieldId of PHOTO_FIELDS) {
      const f = app.files[fieldId];
      if (!f?.key || s.files[fieldId]?.id) continue;
      const bytes = await r2Bytes(env, f.key);
      if (!bytes) throw new Error(`${fieldId} is missing from storage`);
      const uploadRequestId = await uploadBytes(env, { bytes, type: f.type || 'image/jpeg' }, jt);
      s.files[fieldId] = { id: await attachFile(env, { accountId, name: PHOTO_FILE_NAMES[fieldId](accountName(app)), uploadRequestId }, jt) };
      await saveState(DB, app, {}, now);
    }
  });

  await step('family message', async () => {
    const done = (v) => v === 'sent' || v === 'already';
    // The medical note gets a few tries (the model can be briefly unavailable), then is left to staff
    const medicalSettled = (v) => done(v) || v === 'skipped: no diagnosis' || (s.medicalTries || 0) >= MEDICAL_TRIES;
    if (done(s.intake?.welcome) && medicalSettled(s.intake?.medical)) return;
    const applicant = await readApplicant(env, accountId, jt);
    if (!applicant) throw new Error('could not read the account back');
    // Fresh upload request each try: JobTread consumes one per attachment
    const attach = done(s.intake?.welcome) ? [] : [{ id: await uploadBytes(env, { bytes: pdf, type: 'application/pdf' }, jt), name: pdfName(app) }];
    s.intake = await sendIntake(env, applicant, { uploadRequestIds: attach, fetchImpl: jt, now });
    if (!done(s.intake.welcome)) throw new Error(`welcome ${s.intake.welcome}`);
    if (!medicalSettled(s.intake.medical)) {
      s.medicalTries = (s.medicalTries || 0) + 1;
      if (s.medicalTries < MEDICAL_TRIES) waiting = true;
    }
  });

  await step('staff email', async () => {
    if (s.staffEmail) return;
    const to = app.is_test ? ALERT_EMAILS : STAFF_EMAILS;
    const msg = staffEmail(app, accountId);
    const r = await sendEmails(env, { to, ...msg, tags: [{ name: 'type', value: 'application' }] });
    if (r.errors.length && !r.sent) throw new Error(r.errors[0]);
    s.staffEmail = iso(now);
  });

  await step('video', async () => {
    const v = app.files.video;
    if (!v?.uid || s.video?.id) return;
    const url = await videoDownloadUrl(env, v.uid, fetchImpl).catch((e) => { s.video = { error: e.message }; throw e; });
    if (!url) { waiting = true; return; }
    const uploadRequestId = await uploadFromUrl(env, url, jt);
    s.video = { id: await attachFile(env, { accountId, name: `${accountName(app)}_Application.mp4`, uploadRequestId }, jt) };
    // Name the video in the Stream dashboard (best effort)
    streamApi(env, `/${encodeURIComponent(v.uid)}`, { method: 'POST', body: JSON.stringify({ meta: { name: `${accountName(app)} application`, application: app.id } }) }, fetchImpl).catch(() => {});
  });

  const attempts = error ? (app.attempts || 0) + 1 : 0;
  const status = error ? 'error' : waiting ? 'waiting' : 'done';
  const retryIn = error ? Math.min(MAX_BACKOFF_MS, 60 * 1000 * 2 ** Math.min(attempts, 10)) : 2 * 60 * 1000;
  await saveState(DB, app, {
    status, attempts, last_error: error, locked_until: null,
    next_try_at: status === 'done' ? null : now + retryIn,
  }, now);

  if (error && attempts >= ALERT_AFTER_ATTEMPTS && app.alerted !== error) {
    await sendEmails(env, {
      to: ALERT_EMAILS,
      subject: `Application for ${accountName(app)} is stuck`,
      html: `<p>The website couldn't finish loading an application into JobTread after ${attempts} tries.</p><p><strong>${escapeHtml(error)}</strong></p><p>It keeps retrying on its own. <a href="${escapeHtml(applicationUrl(app.id))}">Open it in the admin</a> to retry now.</p>`,
      text: `The website couldn't finish loading an application into JobTread after ${attempts} tries.\n\n${error}\n\nIt keeps retrying on its own. Admin: ${applicationUrl(app.id)}`,
    }).catch(() => {});
    await DB.prepare('UPDATE applications SET alerted = ? WHERE id = ?').bind(error, app.id).run();
  }
  return error ? { status, error } : { status };
}

// ─── Sweep ──────────────────────────────────────────────────────────

/**
 * Finish what's unfinished: retry failed steps (with backoff), attach videos
 * once Stream has processed them, and clear drafts nobody submitted within
 * DRAFT_TTL_DAYS (their photos and video too). Rides the live hub's minute
 * heartbeat; runs at most every SWEEP_EVERY_MS. Never throws.
 */
export async function maybeSweepApplications(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  try {
    const { DB } = env;
    if (!DB) return null;
    await ensureSchema(DB);
    if (!force) {
      const next = String(now + SWEEP_EVERY_MS);
      const ins = await DB.prepare("INSERT OR IGNORE INTO application_runtime (key, value, updated_at) VALUES ('sweep', ?, ?)").bind(next, iso(now)).run();
      if (!(ins?.meta?.changes > 0)) {
        const upd = await DB.prepare("UPDATE application_runtime SET value = ?, updated_at = ? WHERE key = 'sweep' AND CAST(value AS INTEGER) <= ?").bind(next, iso(now), now).run();
        if (!(upd?.meta?.changes > 0)) return null;
      }
    }
    const { results } = await DB.prepare("SELECT id FROM applications WHERE status != 'done' AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY next_try_at LIMIT 3").bind(now).all();
    const processed = [];
    for (const r of results || []) processed.push({ id: r.id, ...(await processApplication(env, r.id, { fetchImpl, now })) });
    const expired = await expireDrafts(env, { now, fetchImpl });
    return { processed, expired };
  } catch {
    return null;
  }
}

/** Drop unsubmitted drafts older than DRAFT_TTL_DAYS, with their files */
export async function expireDrafts(env, { now = Date.now(), fetchImpl = fetch, limit = 10 } = {}) {
  const { DB } = env;
  const cutoff = iso(now - DRAFT_TTL_DAYS * 24 * 3600 * 1000);
  const { results } = await DB.prepare('SELECT id, files FROM application_drafts WHERE submitted_id IS NULL AND updated_at < ? LIMIT ?').bind(cutoff, limit).all();
  for (const r of results || []) {
    const files = parse(r.files, {});
    for (const [k, f] of Object.entries(files)) {
      if (k === 'video') { if (f?.uid) await deleteVideo(env, f.uid, fetchImpl); continue; }
      if (env.FILES) for (const key of [f?.key, f?.thumbKey].filter(Boolean)) await env.FILES.delete(key).catch(() => {});
    }
    await DB.prepare('DELETE FROM application_drafts WHERE id = ? AND submitted_id IS NULL').bind(r.id).run();
  }
  return (results || []).length;
}

// ─── Admin ──────────────────────────────────────────────────────────

export async function listApplications(DB, { limit = 50 } = {}) {
  await ensureSchema(DB);
  const { results } = await DB.prepare('SELECT * FROM applications ORDER BY submitted_at DESC LIMIT ?').bind(limit).all();
  const drafts = await DB.prepare('SELECT COUNT(*) AS n FROM application_drafts WHERE submitted_id IS NULL').first();
  return {
    applications: (results || []).map(applicationRow).map(a => ({
      id: a.id, year: a.year, child: a.child_name, parent: a.parent_name, email: a.parent_email,
      makeoverTypes: a.makeover_types, isTest: !!a.is_test, status: a.status, attempts: a.attempts,
      lastError: a.last_error, submittedAt: a.submitted_at, accountId: a.jt_account_id,
      jobtreadUrl: a.jt_account_id ? jobtreadAccountUrl(a.jt_account_id) : null,
      checklist: checklist(a),
    })),
    draftsInProgress: Number(drafts?.n || 0),
  };
}

/** A canned application for admin's "Send test application" (no video, tiny photos) */
export const TEST_JPEG = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='), c => c.charCodeAt(0));

export function testAnswers(email, year) {
  return {
    ackParameters: "Yes, I have read and understand SOARD's makeover parameters.",
    ackSeason: 'Yes, I have read and understand the above statement.',
    boundary: 'Yes, it is within the boundary.',
    childName: { first: 'TEST', last: 'Applicant' }, birthdate: `${Number(year) - 9}-05-01`, gender: 'Female',
    diagnosis: 'Cerebral palsy',
    address: { line1: '1 Test Way', line2: '', city: 'Marietta', state: 'GA', zip: '30067' }, county: 'Cobb',
    resides50: 'Yes', previouslyApplied: 'No', referredBy: 'Website admin test',
    parentName: { first: 'Test', last: 'Parent' }, parentEmail: email, parentPhone: '(404) 555-0100', parentRelation: 'Mother',
    residesWith: 'Parents', ownership: 'Yes, at least one person living in the home is the owner.',
    diagnosisImpact: 'Test application: please archive this account.',
    verbal: 'Yes', ambulatory: 'No', sensory: 'No', destructive: 'No', language: 'English', equipment: 'Wheelchair (test).',
    interests: 'This is a test application from the website admin.', otherChildren: 'None (test).',
    makeoverTypes: ['Accessible Bathroom'], makeoverWhy: 'Test application.', positiveImpact: 'Test application.',
    residingDuration: 'Forever', permits: 'No', conviction: 'No',
    signature: 'Test Parent',
  };
}

export async function createTestApplication(env, { email, year, now = Date.now() }) {
  const { DB } = env;
  const draftId = await createDraft(DB, { year, ipHash: 'admin', verified: true, now });
  const files = {};
  for (const id of PHOTO_FIELDS) {
    const key = photoKey(draftId, id);
    const thumbKey = photoKey(draftId, id, true);
    await env.FILES.put(key, TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await env.FILES.put(thumbKey, TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    files[id] = { key, thumbKey, type: 'image/jpeg', size: TEST_JPEG.byteLength, name: `${id}.jpg` };
  }
  const answers = testAnswers(email, year);
  await DB.prepare('UPDATE application_drafts SET answers = ?, files = ?, email = ? WHERE id = ?').bind(JSON.stringify(answers), JSON.stringify(files), email, draftId).run();
  // The test has no video (the form requires one), so it's frozen here instead of through submitDraft
  const errors = formErrors(applicationForm({ year }), answers, files);
  delete errors.video;
  if (Object.keys(errors).length) return { ok: false, errors };
  const id = newApplicationId();
  const at = iso(now);
  await DB.prepare('UPDATE application_drafts SET submitted_id = ? WHERE id = ?').bind(id, draftId).run();
  await DB.prepare(`INSERT INTO applications (id, draft_id, year, child_name, parent_name, parent_email, makeover_types, answers, files, is_test,
      jt_state, status, attempts, next_try_at, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}', 'processing', 0, ?, ?, ?)`)
    .bind(id, draftId, year, nameText(answers.childName), nameText(answers.parentName), email, JSON.stringify(answers.makeoverTypes), JSON.stringify(answers), JSON.stringify(files), now, at, at).run();
  return { ok: true, id };
}

export { allFields };
