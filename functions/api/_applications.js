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
 * CF_STREAM_TOKEN (video), RESEND_API_KEY (emails), SLACK_BOT_TOKEN or
 * SLACK_WEBHOOK_URL (staff Slack posts, optional), FILES (R2), DB, AI.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import {
  cleanAnswers, formErrors, stopFor, nameText, addressText, toE164, allFields, DEFAULT_STAFF_EMAILS,
} from './_application-form.js';
import { buildApplicationPdf } from './_application-pdf.js';
import { sendEmails, escapeHtml, SITE_ORIGIN, slackAlert, slackEscape } from './_broadcast-notify.js';
import { readApplicant, sendIntake, ensureCommsSchema } from './_applicant-comms.js';
import { formFor, ensureFormSchema } from './_application-forms.js';
import { isUpload, isInput, answerText, progressPercent, renderMessage, choice } from './_application-form.js';
import { checkServiceArea, areaText } from './_geo.js';
import { maybeSyncApplicants } from './_applicants.js';
import { runNotifications } from './_applicant-notify.js';
import { logAudit } from './_audit.js';

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

export const STAFF_EMAILS = DEFAULT_STAFF_EMAILS; // the live form's settings can change who gets them
export const ALERT_EMAILS = ['peter@soardcharity.com'];

// The four built-in photo questions keep the file names staff know; any photo
// question added in the editor is named after its wording
const PHOTO_FIELDS = ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2'];
const PHOTO_FILE_NAMES = {
  photoChild: (c) => `${c}.jpg`,
  photoFamily: (c) => `${c} Family.jpg`,
  photoSpace1: (c) => `${c} Space 1.jpg`,
  photoSpace2: (c) => `${c} Space 2.jpg`,
};
const photoFileName = (fieldId, child, label) => (PHOTO_FILE_NAMES[fieldId]
  ? PHOTO_FILE_NAMES[fieldId](child)
  : `${child} ${String(label || fieldId).replace(/^please upload (a |an )?(picture|photo) of (the )?/i, '').replace(/[^\w\s-]/g, '').trim().slice(0, 60) || fieldId}.jpg`);
/** Every photo the family uploaded, in form order (built-in ones first if the form doesn't list them) */
export function photoFieldsOf(app, form) {
  const inForm = form ? allFields(form).filter(f => f.type === 'photo').map(f => ({ id: f.id, label: f.labelEn || f.label })) : [];
  const known = new Set(inForm.map(f => f.id));
  const extra = Object.keys(app.files || {}).filter(k => k !== 'video' && app.files[k]?.key && !known.has(k)).map(id => ({ id, label: id }));
  return [...inForm, ...extra].filter(f => app.files?.[f.id]?.key);
}

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
  // Added after launch (each is a no-op once there):
  //   applications.form_version  the form version it was answered on (0 = built in)
  //   applications.lang          the language it was answered in
  //   applications.deleted_*     staff deleted the family's data (the row stays as a record)
  //   application_drafts.*       language, furthest page, stop screen hit, reminder emails,
  //                              and cleared_at (expired: personal data gone, kept for the funnel)
  for (const sql of [
    'ALTER TABLE applications ADD COLUMN form_version INTEGER DEFAULT 0',
    "ALTER TABLE applications ADD COLUMN lang TEXT DEFAULT 'en'",
    'ALTER TABLE applications ADD COLUMN deleted_at TEXT',
    'ALTER TABLE applications ADD COLUMN deleted_by TEXT',
    "ALTER TABLE application_drafts ADD COLUMN lang TEXT DEFAULT 'en'",
    'ALTER TABLE application_drafts ADD COLUMN max_page INTEGER DEFAULT 0',
    'ALTER TABLE application_drafts ADD COLUMN max_page_id TEXT',
    'ALTER TABLE application_drafts ADD COLUMN stop_key TEXT',
    'ALTER TABLE application_drafts ADD COLUMN reminders_sent INTEGER DEFAULT 0',
    'ALTER TABLE application_drafts ADD COLUMN last_reminder_at TEXT',
    'ALTER TABLE application_drafts ADD COLUMN reminders_off INTEGER DEFAULT 0',
    'ALTER TABLE application_drafts ADD COLUMN cleared_at TEXT',
  ]) {
    try { await DB.prepare(sql).run(); } catch { /* already there */ }
  }
  _schemaReady.add(DB);
  await ensureCommsSchema(DB);
  await ensureFormSchema(DB);
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

// ─── Open, closed, season (Admin → Applications → Settings) ────────
// `application` in the site settings row. The form and the Apply page read it
// on every visit (functions/apply/), so a change shows without a Publish.

export const APPLICATION_FIELDS = ['open', 'year', 'closedMessage', 'formUrl', 'opensAt', 'closesAt'];
const HTTPS_LINK = /^https:\/\/[^\s/]+\.[^\s]+$/i;

/** The stored block, every field present and normalized */
export function pickApplication(a = {}, now = Date.now()) {
  return {
    open: a?.open === true,
    year: cleanYear(a?.year, now),
    closedMessage: String(a?.closedMessage || '').trim(),
    formUrl: String(a?.formUrl || '').trim(),
    opensAt: a?.opensAt ? String(a.opensAt) : '',
    closesAt: a?.closesAt ? String(a.closesAt) : '',
  };
}
const sameApplication = (a, b) => APPLICATION_FIELDS.every(k => pickApplication(a)[k] === pickApplication(b)[k]);

/**
 * What the editor sent, cleaned, and what's wrong with it. Times only have to
 * be in the future when they changed (a stored one may have just passed).
 */
export function cleanApplicationSettings(input = {}, { now = Date.now(), previous = {} } = {}) {
  const errors = [];
  const out = pickApplication(input, now);
  out.closedMessage = out.closedMessage.replace(/\s+/g, ' ').slice(0, 200);
  if (out.formUrl && !HTTPS_LINK.test(out.formUrl)) errors.push({ field: 'formUrl', error: 'Use a full link that starts with https://' });
  for (const k of ['opensAt', 'closesAt']) {
    if (!out[k]) continue;
    const t = Date.parse(out[k]);
    if (!Number.isFinite(t)) { errors.push({ field: k, error: 'That is not a date and time' }); out[k] = ''; continue; }
    out[k] = new Date(t).toISOString();
    if (t <= now && out[k] !== pickApplication(previous)[k]) errors.push({ field: k, error: 'Pick a time that hasn’t passed' });
  }
  if (out.open) out.opensAt = '';
  if (!out.open && out.closesAt && !out.opensAt) out.closesAt = '';
  if (out.opensAt && out.closesAt && Date.parse(out.closesAt) <= Date.parse(out.opensAt)) errors.push({ field: 'closesAt', error: 'Close after it opens' });
  return { settings: out, errors };
}

/**
 * Write `application` and leave every other site setting as stored. `base` is
 * what the editor loaded: when these fields changed since, nothing is written
 * and { conflict } comes back. The row is swapped only if nobody wrote it in
 * between (other Site Config saves land on the same row).
 */
export async function saveApplicationSettings(env, input, { user = 'admin', base = null, now = Date.now() } = {}) {
  const { DB } = env;
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first();
    const all = parse(row?.data, {}) || {};
    const current = pickApplication(all.application, now);
    if (base && !sameApplication(base, current)) return { conflict: current };
    const { settings, errors } = cleanApplicationSettings({ ...current, ...input }, { now, previous: current });
    if (errors.length) return { errors };
    const changes = APPLICATION_FIELDS.filter(k => current[k] !== settings[k]).map(k => ({ field: `application.${k}`, from: current[k], to: settings[k] }));
    if (!changes.length) return { settings, changes };
    // Who opened or closed it, and when: the "since" line in the admin, and how the
    // waitlist tells a scheduled open (user "schedule") from a manual one
    const stamp = current.open !== settings.open ? { openChangedAt: iso(now), openChangedBy: user } : {};
    const next = JSON.stringify({ ...all, application: { ...(all.application || {}), ...settings, ...stamp } });
    const res = row
      ? await DB.prepare("UPDATE site_config SET data = ?, updated_at = ? WHERE key = 'settings' AND data = ?").bind(next, iso(now), row.data).run()
      : await DB.prepare("INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES ('settings', ?, ?)").bind(next, iso(now)).run();
    if (!(res?.meta?.changes > 0)) continue;
    const verb = changes.some(c => c.field === 'application.open') ? (settings.open ? 'Applications opened' : 'Applications closed') : 'Applications settings';
    // Its own type: the form and the Apply page read these at request time, so nothing waits for Publish
    await logAudit(DB, { userEmail: user, action: 'updated', entityType: 'application-settings', entitySlug: 'application', entityName: verb, changes, path: 'src/content/site/settings.json' });
    return { settings, changes };
  }
  return { busy: true };
}

/** Recent changes to these fields, newest first, from the audit log */
export async function applicationSettingsHistory(DB, limit = 12) {
  try {
    const { results } = await DB.prepare(`SELECT user_email, changes, created_at FROM audit_log
      WHERE entity_type IN ('application-settings', 'settings') AND changes LIKE '%"application.%' ORDER BY id DESC LIMIT ?`).bind(limit).all();
    return (results || []).map(r => ({
      by: r.user_email,
      at: /Z$|[+-]\d\d:?\d\d$/.test(r.created_at) ? r.created_at : `${String(r.created_at).replace(' ', 'T')}Z`,
      changes: (parse(r.changes, []) || []).filter(c => String(c.field).startsWith('application.')),
    }));
  } catch {
    return [];
  }
}

/**
 * Open or close at the times set in Settings. Runs on every heartbeat sweep;
 * the change is logged as made by "schedule" and staff hear about it in Slack.
 */
export async function runApplicationSchedule(env, { now = Date.now() } = {}) {
  if (!env.DB) return null;
  const s = pickApplication(await applicationSettings(env.DB), now);
  const due = !s.open && s.opensAt && Date.parse(s.opensAt) <= now ? { open: true, opensAt: '' }
    : s.open && s.closesAt && Date.parse(s.closesAt) <= now ? { open: false, closesAt: '' } : null;
  if (!due) return null;
  const out = await saveApplicationSettings(env, due, { user: 'schedule', base: s, now });
  if (!out.changes?.length) return null;
  const done = due.open ? 'opened' : 'closed';
  await slackAlert(env, due.open
    ? `Makeover applications opened on schedule for the ${s.year} season. Families can apply at ${SITE_ORIGIN}/apply/form/`
    : `Makeover applications closed on schedule. Families who already started can still finish.`).catch(() => null);
  return done;
}

/**
 * The same, for callers that want flags and never an exception (the waitlist
 * runner calls it before its own check). Whoever runs it first in a minute
 * flips it; the stored application.openChangedBy is "schedule" either way.
 */
export async function applyApplicationSchedule(env, { now = Date.now() } = {}) {
  try {
    const done = await runApplicationSchedule(env, { now });
    return { opened: done === 'opened', closed: done === 'closed' };
  } catch {
    return { opened: false, closed: false };
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
  // An expired draft keeps a row for the funnel, but it can't be resumed
  return draftRow(await DB.prepare('SELECT * FROM application_drafts WHERE id = ? AND cleared_at IS NULL').bind(id).first());
}

export async function createDraft(DB, { year, ipHash, verified = false, lang = 'en', now = Date.now() }) {
  await ensureSchema(DB);
  const id = newDraftId();
  await DB.prepare(`INSERT INTO application_drafts (id, year, answers, files, ip_hash, verified, lang, created_at, updated_at) VALUES (?, ?, '{}', '{}', ?, ?, ?, ?, ?)`)
    .bind(id, year, ipHash || null, verified ? 1 : 0, lang === 'es' ? 'es' : 'en', iso(now), iso(now)).run();
  return id;
}

export async function draftsToday(DB, ipHash, now = Date.now()) {
  await ensureSchema(DB);
  const row = await DB.prepare('SELECT COUNT(*) AS n FROM application_drafts WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, iso(now - 24 * 3600 * 1000)).first();
  return Number(row?.n || 0);
}

export async function saveDraft(DB, draft, { answers, page, lang }, now = Date.now()) {
  const form = await formFor(DB, { year: draft.year });
  const clean = cleanAnswers(form, answers || {});
  const email = clean.parentEmail || draft.email || null;
  const pageId = form.pages.some(p => p.id === page) ? page : draft.page;
  // For the funnel: the furthest page reached, and a stop screen if one was hit
  const at = form.pages.findIndex(p => p.id === pageId);
  const maxPage = Math.max(Number(draft.max_page) || 0, at);
  const maxPageId = at >= (Number(draft.max_page) || 0) ? pageId : (draft.max_page_id || pageId);
  const stop = stopFor(form, clean);
  const language = lang === 'es' || lang === 'en' ? lang : (draft.lang || 'en');
  await DB.prepare('UPDATE application_drafts SET answers = ?, page = ?, email = ?, lang = ?, max_page = ?, max_page_id = ?, stop_key = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(clean), pageId || null, email, language, maxPage, maxPageId || null, stop?.key || null, iso(now), draft.id).run();
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
  const lang = draft.lang === 'es' ? 'es' : 'en';
  const form = await formFor(DB, { year: draft.year });
  const answers = cleanAnswers(form, draft.answers);
  const stop = stopFor(form, answers);
  if (stop) return { ok: false, error: 'stopped', stop: stop.key };
  const errors = formErrors(form, answers, draft.files, null, lang);
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
      jt_state, status, attempts, next_try_at, submitted_at, updated_at, form_version, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'processing', 0, ?, ?, ?, ?, ?)`)
    .bind(id, draft.id, draft.year, childName, nameText(answers.parentName), answers.parentEmail || null,
      JSON.stringify(answers.makeoverTypes || []), JSON.stringify(answers), JSON.stringify(draft.files || {}), isTest ? 1 : 0, now, at, at, form.version || 0, lang).run();
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

/** A question's answer as a JobTread custom field value (null when it doesn't fit) */
export function jobtreadValue(field, value) {
  const jt = field.jobtread;
  if (!jt || value == null || value === '' || (Array.isArray(value) && !value.length)) return null;
  switch (jt.type) {
    case 'option': {
      const vals = (Array.isArray(value) ? value : [value]).filter(v => !jt.options || jt.options.includes(v));
      if (!vals.length) return null;
      return jt.multiple ? vals : vals[0];
    }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : null;
    case 'number': { const n = Number(String(value).replace(/,/g, '')); return Number.isFinite(n) ? n : null; }
    case 'boolean': return !!value;
    case 'phoneNumber': return toE164(value);
    default: {
      const text = Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? (nameText(value) || addressText(value)) : String(value);
      return text.slice(0, 4000) || null;
    }
  }
}

/** Questions the editor sent to a JobTread field, by target ('account' | 'location') */
export function mappedFields(form, answers, target) {
  const out = {};
  if (!form) return out;
  for (const f of allFields(form)) {
    if (f.jobtread?.target !== target) continue;
    const v = jobtreadValue(f, answers?.[f.id]);
    if (v != null) out[f.jobtread.fieldId] = v;
  }
  return out;
}

/** Custom field values for createAccount (the built-in mapping, then any question the editor sent to JobTread) */
export function accountFields(app, form = null) {
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
  return { ...mappedFields(form, a, 'account'), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null)) };
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
  // The family's language, with the English beside it for staff when that's Spanish
  const form = await formFor(env.DB, { year: app.year, version: app.form_version || 0, lang: app.lang || 'en' });
  const photos = {};
  for (const { id } of photoFieldsOf(app, form)) {
    const bytes = await r2Bytes(env, app.files[id]?.thumbKey);
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
    ['Address check', app.jt_state?.area ? areaText(app.jt_state.area) : null],
    ['Possible repeat', app.jt_state?.repeat?.matches?.length ? app.jt_state.repeat.matches.map(m => `${m.name}${m.year ? ` (${m.year})` : ''}${m.status ? `, ${m.status}` : ''}`).join('; ') : null],
    ['Language', app.lang === 'es' ? 'Spanish (applied in Spanish)' : null],
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

/** The same heads-up for Slack. Kept short: no diagnosis or contact details in the channel. */
function staffSlack(app, accountId) {
  const a = app.answers;
  const first = String(a.childName?.first || 'A new applicant').trim();
  const types = (a.makeoverTypes || []).join(' and ') || 'a makeover';
  const title = `${app.is_test ? '[TEST] ' : ''}New makeover application: ${first}`;
  const detail = [app.year, types, a.county].filter(Boolean).join(' · ');
  const links = [
    accountId ? { label: 'Open in JobTread', url: jobtreadAccountUrl(accountId) } : null,
    { label: 'Open the application', url: applicationUrl(app.id) },
  ].filter(Boolean);
  return {
    text: `🟢 ${title}: ${detail} ${links[0].url}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `🟢 *${slackEscape(title)}*\n${slackEscape(detail)}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: links.map((l) => `<${l.url}|${slackEscape(l.label)}>`).join('  ·  ') }] },
    ],
  };
}

/** A staff-only comment on the account (not emailed to anyone) */
async function postInternal(env, accountId, name, message, fetchImpl) {
  if (!accountId) return;
  await pave(env.JOBTREAD_GRANT_KEY, {
    createComment: { $: { targetType: 'account', targetId: accountId, name, message: String(message).slice(0, 4096), isVisibleToInternalRoles: true, isVisibleToCustomerRoles: false, isVisibleToVendorRoles: false } },
  }, fetchImpl);
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Has this family applied before? Earlier applications on the site (same
 * child's name, or same birthday and last name, or the same parent email or
 * phone) and JobTread customer accounts with the child's name.
 * { matches: [{ where, id, name, year?, status?, why, url }] }
 */
export async function findRepeats(env, app, accountId, fetchImpl) {
  const a = app.answers;
  const child = norm(nameText(a.childName));
  const last = norm(a.childName?.last);
  const email = String(a.parentEmail || '').trim().toLowerCase();
  const phone = toE164(a.parentPhone);
  const matches = [];
  try {
    const { results } = await env.DB.prepare('SELECT id, year, child_name, answers, jt_account_id, submitted_at FROM applications WHERE id != ? AND is_test = 0 AND deleted_at IS NULL ORDER BY submitted_at DESC LIMIT 400').bind(app.id).all();
    for (const r of results || []) {
      const ra = parse(r.answers, {});
      const why = [];
      if (child && norm(r.child_name) === child) why.push('same child\u2019s name');
      else if (last && ra.birthdate && ra.birthdate === a.birthdate && norm(ra.childName?.last) === last) why.push('same birthday and last name');
      if (email && String(ra.parentEmail || '').trim().toLowerCase() === email) why.push('same parent email');
      if (phone && toE164(ra.parentPhone) === phone) why.push('same parent phone');
      if (why.length) matches.push({ where: 'site', id: r.id, name: r.child_name, year: r.year, why: why.join(', '), url: r.jt_account_id ? jobtreadAccountUrl(r.jt_account_id) : applicationUrl(r.id), accountId: r.jt_account_id || null });
    }
  } catch { /* no earlier applications to compare */ }
  try {
    const name = nameText(a.childName);
    if (name && env.JOBTREAD_GRANT_KEY) {
      const data = await pave(env.JOBTREAD_GRANT_KEY, {
        organization: {
          $: { id: SOARD_ORG_ID },
          accounts: {
            $: { size: 10, where: { and: [['type', '=', 'customer'], ['name', '=', name]] } },
            nodes: { id: {}, name: {}, createdAt: {}, customFieldValues: { $: { where: [['customField', 'id'], 'in', [JT_FIELDS.status, JT_FIELDS.makeoverYear]] }, nodes: { value: {}, customField: { id: {} } } } },
          },
        },
      }, fetchImpl);
      for (const n of data?.organization?.accounts?.nodes || []) {
        if (n.id === accountId || matches.some(m => m.accountId === n.id)) continue;
        const val = (id) => n.customFieldValues?.nodes?.find(v => v.customField?.id === id)?.value || null;
        matches.push({ where: 'jobtread', id: n.id, name: n.name, year: val(JT_FIELDS.makeoverYear), status: val(JT_FIELDS.status), why: 'same name in JobTread', url: jobtreadAccountUrl(n.id) });
      }
    }
  } catch { /* JobTread unavailable: the site matches still count */ }
  return { matches, said: a.previouslyApplied === 'Yes' };
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
  const photoIds = Object.keys(app.files || {}).filter(k => k !== 'video' && app.files[k]?.key);
  const photosWanted = photoIds.length;
  const photosDone = photoIds.filter(id => s.files?.[id]?.id).length;
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
    staffSlack: s.staffSlack === 'off' ? 'none' : !!s.staffSlack,
  };
}

/** The checks staff see beside each application */
export function flags(app) {
  const s = app.jt_state || {};
  return {
    area: s.area ? { status: s.area.status, miles: s.area.miles ?? null, text: areaText(s.area), county: s.area.county || null } : null,
    repeat: s.repeat?.matches?.length ? s.repeat.matches.map(m => ({ name: m.name, year: m.year || null, status: m.status || null, why: m.why, url: m.url })) : [],
    saidApplied: app.answers?.previouslyApplied === 'Yes',
    lang: app.lang || 'en',
    // The county the family chose, beside the one the address check found
    county: app.answers?.county || null,
    countyMismatch: !!(s.area?.county && app.answers?.county && String(s.area.county).toLowerCase() !== String(app.answers.county).toLowerCase()),
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
  // The questions this family answered (the version live when they submitted)
  const form = await formFor(DB, { year: app.year, version: app.form_version || 0 });

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
        $: { organizationId: SOARD_ORG_ID, type: 'customer', name: accountName(app), suffixIfNecessary: true, customFieldValues: accountFields(app, form) },
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
          customFieldValues: { ...mappedFields(form, a, 'location'), ...(a.county ? { [JT_FIELDS.county]: a.county } : {}) },
        },
        createdLocation: { id: {} },
      },
    }, jt);
    s.location = { id: out?.createLocation?.createdLocation?.id || null };
    if (!s.location.id) throw new Error('JobTread did not return the new location');
  });

  // Checks for staff. Neither ever holds the application up: a failure is noted and left
  await step('service area', async () => {
    if (s.area) return;
    const polygon = form.serviceArea?.polygon;
    s.area = await checkServiceArea(addressText(app.answers.address), polygon, fetchImpl);
    if (s.area.status !== 'inside' || (s.area.county && app.answers.county && s.area.county !== app.answers.county)) {
      const lines = [areaText(s.area)];
      if (s.area.matched) lines.push(`The Census matched it to: ${s.area.matched}`);
      if (s.area.county && app.answers.county && s.area.county !== app.answers.county) lines.push(`The family picked ${app.answers.county} County; the Census says ${s.area.county} County.`);
      lines.push(`The family's answer: ${app.answers.boundary || 'not given'}`);
      await postInternal(env, accountId, 'Service area check (automatic)', lines.join('\n\n'), jt).catch(() => {});
    }
  });
  await step('repeat check', async () => {
    if (s.repeat) return;
    s.repeat = await findRepeats(env, app, accountId, jt);
    if (s.repeat.matches.length) {
      const lines = s.repeat.matches.map(m => `${m.name}${m.year ? ` (${m.year})` : ''}${m.status ? `, ${m.status}` : ''}${m.why ? `: ${m.why}` : ''}${m.url ? `\n${m.url}` : ''}`);
      await postInternal(env, accountId, 'Possible repeat applicant (automatic)', `${lines.join('\n\n')}${app.answers.previouslyApplied === 'Yes' ? '\n\nThe family said they applied before.' : ''}`, jt).catch(() => {});
    }
  });

  await step('pdf file', async () => {
    if (s.files.pdf?.id) return;
    const uploadRequestId = await uploadBytes(env, { bytes: pdf, type: 'application/pdf' }, jt);
    s.files.pdf = { id: await attachFile(env, { accountId, name: pdfName(app), uploadRequestId }, jt) };
  });

  await step('photos', async () => {
    for (const { id: fieldId, label } of photoFieldsOf(app, form)) {
      const f = app.files[fieldId];
      if (!f?.key || s.files[fieldId]?.id) continue;
      const bytes = await r2Bytes(env, f.key);
      if (!bytes) throw new Error(`${fieldId} is missing from storage`);
      const uploadRequestId = await uploadBytes(env, { bytes, type: f.type || 'image/jpeg' }, jt);
      s.files[fieldId] = { id: await attachFile(env, { accountId, name: photoFileName(fieldId, accountName(app), label), uploadRequestId }, jt) };
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
    // The last try posts the family's diagnosis even if the model can't summarize it
    const lastTry = (s.medicalTries || 0) + 1 >= MEDICAL_TRIES;
    s.intake = await sendIntake(env, applicant, { uploadRequestIds: attach, fetchImpl: jt, now, lang: app.lang || 'en', medicalFallback: lastTry });
    if (!done(s.intake.welcome)) throw new Error(`welcome ${s.intake.welcome}`);
    if (!medicalSettled(s.intake.medical)) {
      s.medicalTries = (s.medicalTries || 0) + 1;
      if (s.medicalTries < MEDICAL_TRIES) waiting = true;
    }
  });

  // Email and Slack are each done once and remembered, so a retry only
  // repeats the one that failed and an outage in one never holds up the other
  await step('staff heads-up', async () => {
    const failed = [];
    if (!s.staffEmail) {
      const to = app.is_test ? ALERT_EMAILS : (await formFor(env.DB, { year: app.year })).staffEmails;
      const msg = staffEmail(app, accountId);
      const r = await sendEmails(env, { to, ...msg, tags: [{ name: 'type', value: 'application' }] });
      if (r.errors.length && !r.sent) failed.push(`email: ${r.errors[0]}`);
      else s.staffEmail = iso(now);
    }
    if (!s.staffSlack) {
      const { text, blocks } = staffSlack(app, accountId);
      const r = await slackAlert(env, text, blocks);
      if (r.ok) s.staffSlack = iso(now);
      else if (r.skipped) s.staffSlack = 'off'; // Slack not connected, or no channel picked
      else failed.push(`Slack: ${r.error || `HTTP ${r.status}`}`);
    }
    if (failed.length) throw new Error(failed.join('; '));
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
    await Promise.all([
      sendEmails(env, {
        to: ALERT_EMAILS,
        subject: `Application for ${accountName(app)} is stuck`,
        html: `<p>The website couldn't finish loading an application into JobTread after ${attempts} tries.</p><p><strong>${escapeHtml(error)}</strong></p><p>It keeps retrying on its own. <a href="${escapeHtml(applicationUrl(app.id))}">Open it in the admin</a> to retry now.</p>`,
        text: `The website couldn't finish loading an application into JobTread after ${attempts} tries.\n\n${error}\n\nIt keeps retrying on its own. Admin: ${applicationUrl(app.id)}`,
      }).catch(() => {}),
      slackAlert(env, `🟡 Application for ${accountName(app)} is stuck: the website couldn't finish loading it into JobTread after ${attempts} tries. ${error}. It keeps retrying on its own; open it in the admin to retry now. ${applicationUrl(app.id)}`).catch(() => {}),
    ]);
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
    // Scheduled open/close is due to the minute, so it runs before the sweep's throttle
    await runApplicationSchedule(env, { now }).catch(() => null);
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
    const reminded = await sendReminders(env, { now });
    const expired = await expireDrafts(env, { now, fetchImpl });
    // Family status emails whose wait is over, and staff summaries (./_applicant-notify.js)
    const notified = await runNotifications(env, { fetchImpl, now });
    // Every applicant in JobTread, for Admin → Applications → Applicants
    const applicants = await maybeSyncApplicants(env, { fetchImpl, now });
    return { processed, reminded, expired, notified, applicants };
  } catch {
    return null;
  }
}

/**
 * Clear unsubmitted drafts older than DRAFT_TTL_DAYS: their answers, email,
 * photos and video go; a bare row stays (dates, furthest page, language,
 * stop screen) so the funnel still counts them. The link stops working.
 */
export async function expireDrafts(env, { now = Date.now(), fetchImpl = fetch, limit = 10 } = {}) {
  const { DB } = env;
  const cutoff = iso(now - DRAFT_TTL_DAYS * 24 * 3600 * 1000);
  const { results } = await DB.prepare('SELECT id, files FROM application_drafts WHERE submitted_id IS NULL AND cleared_at IS NULL AND updated_at < ? LIMIT ?').bind(cutoff, limit).all();
  for (const r of results || []) {
    const files = parse(r.files, {});
    for (const [k, f] of Object.entries(files)) {
      if (k === 'video') { if (f?.uid) await deleteVideo(env, f.uid, fetchImpl); continue; }
      if (env.FILES) for (const key of [f?.key, f?.thumbKey].filter(Boolean)) await env.FILES.delete(key).catch(() => {});
    }
    await DB.prepare("UPDATE application_drafts SET answers = '{}', files = '{}', email = NULL, ip_hash = NULL, cleared_at = ? WHERE id = ? AND submitted_id IS NULL").bind(iso(now), r.id).run();
  }
  return (results || []).length;
}

// ─── Reminder emails ────────────────────────────────────────────────

const DAY_MS = 24 * 3600 * 1000;

/** The email that nudges a family to finish (subject, html, text) */
export function reminderEmail({ form, draft, link, stopLink, percent }) {
  const a = draft.answers || {};
  const es = draft.lang === 'es';
  const vars = {
    parent: String(a.parentName?.first || '').trim() || (es ? 'hola' : 'there'),
    child: String(a.childName?.first || '').trim() || (es ? 'su hijo o hija' : 'your child'),
    percent: String(percent),
    year: form.year,
  };
  const subject = renderMessage(form.reminders.subject, vars);
  const body = renderMessage(form.reminders.body, vars);
  const paras = body.split(/\n{2,}/).map(p => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const button = es ? 'Terminar mi solicitud' : 'Finish my application';
  const stop = es ? 'No quiero más recordatorios' : 'Stop these reminders';
  const bar = `<div style="background:#F5F4F0;border-radius:99px;height:10px;margin:6px 0 18px;overflow:hidden"><div style="background:#FFDA24;height:10px;width:${Math.max(4, Math.min(100, percent))}%"></div></div>`;
  return {
    subject,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#373A36;max-width:520px">
${paras}
<p style="margin:0;font-size:13px;color:#5A5B61">${es ? `Avance: ${percent}%` : `${percent}% done`}</p>
${bar}
<p style="margin:0 0 22px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#FFDA24;color:#373A36;padding:12px 26px;border-radius:999px;text-decoration:none;font-weight:bold">${button}</a></p>
<p style="margin:0;font-size:13px;color:#5A5B61">Sunshine on a Ranney Day · <a href="${escapeHtml(stopLink)}" style="color:#5A5B61">${stop}</a></p>
</div>`,
    text: `${body}\n\n${button}: ${link}\n\n${stop}: ${stopLink}`,
  };
}

/**
 * Nudge families who started and went quiet: the Nth reminder goes once their
 * last change is form.reminders.days[N] days old. Never after they submit,
 * hit a stop screen, ask to stop, or the draft expires; at most one a day.
 */
export async function sendReminders(env, { now = Date.now(), limit = 20 } = {}) {
  const { DB } = env;
  if (!env.RESEND_API_KEY) return 0;
  const live = await formFor(DB, { year: String(new Date(now).getUTCFullYear() + 1) });
  if (!live.reminders?.enabled || !live.reminders.days?.length) return 0;
  const days = live.reminders.days;
  const { results } = await DB.prepare(`SELECT * FROM application_drafts
    WHERE submitted_id IS NULL AND cleared_at IS NULL AND email IS NOT NULL AND verified = 1
      AND COALESCE(reminders_off, 0) = 0 AND stop_key IS NULL AND COALESCE(reminders_sent, 0) < ?
      AND updated_at < ? AND (last_reminder_at IS NULL OR last_reminder_at < ?)
    ORDER BY updated_at LIMIT ?`).bind(days.length, iso(now - days[0] * DAY_MS), iso(now - DAY_MS), limit).all();
  let sent = 0;
  for (const r of results || []) {
    const draft = draftRow(r);
    const n = Number(draft.reminders_sent) || 0;
    if (now - Date.parse(draft.updated_at) < days[n] * DAY_MS) continue;
    const form = await formFor(DB, { year: draft.year, lang: draft.lang || 'en' });
    const link = `${SITE_ORIGIN}/apply/form/?resume=${draft.id}`;
    const stopLink = `${link}&reminders=off`;
    const msg = reminderEmail({ form, draft, link, stopLink, percent: progressPercent(form, draft.answers, draft.files) });
    const out = await sendEmails(env, { to: [draft.email], ...msg, tags: [{ name: 'type', value: 'application-reminder' }] });
    if (out.sent) {
      await DB.prepare('UPDATE application_drafts SET reminders_sent = ?, last_reminder_at = ? WHERE id = ?').bind(n + 1, iso(now), draft.id).run();
      sent++;
    }
  }
  return sent;
}

export async function stopReminders(DB, draftId) {
  await DB.prepare('UPDATE application_drafts SET reminders_off = 1 WHERE id = ?').bind(draftId).run();
}

// ─── Admin ──────────────────────────────────────────────────────────

/**
 * Applications for the admin list. q searches the child, parent and email;
 * show: 'all' | 'attention' (not finished) | 'outside' | 'repeat' | 'test' |
 * 'deleted'; year: a season or '' for all.
 */
export async function listApplications(DB, { limit = 50, offset = 0, q = '', show = 'all', year = '' } = {}) {
  await ensureSchema(DB);
  const where = [];
  const binds = [];
  if (show === 'deleted') where.push('deleted_at IS NOT NULL'); else where.push('deleted_at IS NULL');
  if (show === 'test') where.push('is_test = 1');
  else if (show !== 'deleted' && show !== 'all') where.push('is_test = 0');
  if (show === 'attention') where.push("status != 'done'");
  if (year) { where.push('year = ?'); binds.push(String(year)); }
  if (q) {
    const like = `%${String(q).trim().toLowerCase().replace(/[%_]/g, '')}%`;
    where.push('(LOWER(child_name) LIKE ? OR LOWER(parent_name) LIKE ? OR LOWER(parent_email) LIKE ?)');
    binds.push(like, like, like);
  }
  const sql = `FROM applications WHERE ${where.join(' AND ')}`;
  // The area and repeat filters read the checks stored in jt_state
  const all = (await DB.prepare(`SELECT * ${sql} ORDER BY submitted_at DESC LIMIT 2000`).bind(...binds).all()).results || [];
  let rows = all.map(applicationRow);
  if (show === 'outside') rows = rows.filter(a => a.jt_state?.area?.status === 'outside');
  if (show === 'repeat') rows = rows.filter(a => a.jt_state?.repeat?.matches?.length);
  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  const drafts = await DB.prepare('SELECT COUNT(*) AS n FROM application_drafts WHERE submitted_id IS NULL AND cleared_at IS NULL').first();
  const years = (await DB.prepare('SELECT DISTINCT year FROM applications ORDER BY year DESC').all()).results?.map(r => r.year).filter(Boolean) || [];
  return {
    applications: page.map(a => ({
      id: a.id, year: a.year, child: a.child_name, parent: a.parent_name, email: a.parent_email,
      makeoverTypes: a.makeover_types, isTest: !!a.is_test, status: a.status, attempts: a.attempts,
      lastError: a.last_error, submittedAt: a.submitted_at, accountId: a.jt_account_id,
      jobtreadUrl: a.jt_account_id ? jobtreadAccountUrl(a.jt_account_id) : null,
      deletedAt: a.deleted_at || null, deletedBy: a.deleted_by || null,
      checklist: checklist(a), flags: flags(a),
    })),
    total,
    years,
    draftsInProgress: Number(drafts?.n || 0),
  };
}

const csvCell = (v) => {
  const t = String(v ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/**
 * Every application (not deleted, not tests unless asked) as CSV: the basics,
 * the checks, then one column per question, by its wording in the newest form
 * version that asked it.
 */
export async function exportCsv(DB, { year = '', includeTests = false } = {}) {
  await ensureSchema(DB);
  const where = ['deleted_at IS NULL'];
  const binds = [];
  if (!includeTests) where.push('is_test = 0');
  if (year) { where.push('year = ?'); binds.push(String(year)); }
  const rows = ((await DB.prepare(`SELECT * FROM applications WHERE ${where.join(' AND ')} ORDER BY submitted_at`).bind(...binds).all()).results || []).map(applicationRow);
  const forms = new Map();
  const columns = new Map(); // field id → label (newest wins)
  for (const a of rows) {
    const key = `${a.year}:${a.form_version || 0}`;
    if (!forms.has(key)) forms.set(key, await formFor(DB, { year: a.year, version: a.form_version || 0 }));
    for (const f of allFields(forms.get(key))) if (isInput(f)) columns.set(f.id, f.label);
  }
  const fieldOf = (a, id) => allFields(forms.get(`${a.year}:${a.form_version || 0}`)).find(f => f.id === id);
  const head = ['Submitted', 'Season', 'Child', 'Main contact', 'Email', 'Status', 'JobTread account', 'Address check', 'Possible repeat', 'Language', ...columns.values()];
  const lines = [head.map(csvCell).join(',')];
  for (const a of rows) {
    const fl = flags(a);
    const base = [a.submitted_at, a.year, a.child_name, a.parent_name, a.parent_email, a.status, a.jt_account_id ? jobtreadAccountUrl(a.jt_account_id) : '',
      fl.area?.text || '', fl.repeat.map(m => `${m.name}${m.year ? ` (${m.year})` : ''}`).join('; '), a.lang === 'es' ? 'Spanish' : 'English'];
    const answers = [...columns.keys()].map(id => { const f = fieldOf(a, id); return f ? answerText(f, a.answers?.[id], true) : ''; });
    lines.push([...base, ...answers].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Delete a family's data from the site: answers, photos, the PDF and the
 * video. A row stays (dates, who deleted it) so the record shows it happened.
 * JobTread is left alone (archive the account there).
 */
export async function deleteApplicationData(env, id, { user = 'admin', now = Date.now(), fetchImpl = fetch } = {}) {
  const { DB } = env;
  const app = await getApplication(DB, id);
  if (!app) return { ok: false, error: 'Not found' };
  if (app.deleted_at) return { ok: true, already: true };
  const keys = [];
  for (const [k, f] of Object.entries(app.files || {})) {
    if (k === 'video') { if (f?.uid) await deleteVideo(env, f.uid, fetchImpl); continue; }
    keys.push(f?.key, f?.thumbKey);
  }
  keys.push(app.jt_state?.pdf?.key);
  if (env.FILES) for (const key of keys.filter(Boolean)) await env.FILES.delete(key).catch(() => {});
  const first = String(app.answers?.childName?.first || '').trim();
  await DB.batch([
    DB.prepare("UPDATE applications SET answers = '{}', files = '{}', parent_name = NULL, parent_email = NULL, child_name = ?, deleted_at = ?, deleted_by = ?, status = 'done', next_try_at = NULL WHERE id = ?")
      .bind(first ? `${first} (deleted)` : 'Deleted application', iso(now), user, id),
    DB.prepare("UPDATE application_drafts SET answers = '{}', files = '{}', email = NULL, cleared_at = ? WHERE id = ?").bind(iso(now), app.draft_id),
  ]);
  return { ok: true, accountId: app.jt_account_id || null };
}

/**
 * The funnel for a season: who started, how far they got, who finished, and
 * what helped. Counts drafts (including expired ones, whose personal data is
 * gone) and submitted applications; tests left out.
 */
export async function insights(DB, { year, now = Date.now() } = {}) {
  await ensureSchema(DB);
  const form = await formFor(DB, { year });
  const drafts = ((await DB.prepare("SELECT id, created_at, updated_at, submitted_id, max_page, max_page_id, stop_key, lang, reminders_sent, cleared_at FROM application_drafts WHERE year = ? AND COALESCE(ip_hash, '') != 'admin'").bind(String(year)).all()).results) || [];
  const apps = ((await DB.prepare('SELECT id, draft_id, submitted_at, answers, lang, is_test, jt_state FROM applications WHERE year = ? AND deleted_at IS NULL').bind(String(year)).all()).results || []).map(applicationRow);
  const tests = new Set(apps.filter(a => a.is_test).map(a => a.draft_id));
  const real = drafts.filter(d => !tests.has(d.id));
  const submitted = real.filter(d => d.submitted_id);
  const stopped = real.filter(d => !d.submitted_id && d.stop_key);
  const quietDays = (d) => (now - Date.parse(d.updated_at)) / DAY_MS;
  const inProgress = real.filter(d => !d.submitted_id && !d.stop_key && !d.cleared_at && quietDays(d) < 14);
  const gone = real.filter(d => !d.submitted_id && !d.stop_key && (d.cleared_at || quietDays(d) >= 14));
  const pageIds = form.pages.map(p => p.id);
  const reachedIndex = (d) => (d.submitted_id ? pageIds.length : Math.max(0, d.max_page_id ? pageIds.indexOf(d.max_page_id) : Number(d.max_page) || 0));
  const byPage = form.pages.map((p, i) => ({
    id: p.id, title: p.title,
    reached: real.filter(d => reachedIndex(d) >= i).length,
    leftHere: gone.filter(d => reachedIndex(d) === i).length,
  }));
  const minutes = submitted.map(d => {
    const app = apps.find(a => a.draft_id === d.id);
    return app ? (Date.parse(app.submitted_at) - Date.parse(d.created_at)) / 60000 : null;
  }).filter(x => x != null && x >= 0).sort((x, y) => x - y);
  const median = minutes.length ? Math.round(minutes[Math.floor(minutes.length / 2)]) : null;
  const realApps = apps.filter(a => !a.is_test);
  const referral = {};
  for (const a of realApps) {
    const k = String(a.answers?.referredBy || '').trim() || 'Not given';
    referral[k] = (referral[k] || 0) + 1;
  }
  const weeks = {};
  for (const a of realApps) {
    const d = new Date(a.submitted_at);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    const k = monday.toISOString().slice(0, 10);
    weeks[k] = (weeks[k] || 0) + 1;
  }
  return {
    year: String(year),
    started: real.length,
    submitted: submitted.length,
    inProgress: inProgress.length,
    leftUnfinished: gone.length,
    stopped: { outside: stopped.filter(d => d.stop_key === 'outside').length, rental: stopped.filter(d => d.stop_key === 'rental').length, other: stopped.filter(d => !['outside', 'rental'].includes(d.stop_key)).length },
    finishRate: real.length ? Math.round((submitted.length / real.length) * 100) : null,
    medianMinutes: median,
    byPage,
    languages: { en: real.filter(d => (d.lang || 'en') === 'en').length, es: real.filter(d => d.lang === 'es').length },
    reminders: { sent: real.reduce((n, d) => n + (Number(d.reminders_sent) || 0), 0), finishedAfter: submitted.filter(d => Number(d.reminders_sent) > 0).length },
    referral: Object.entries(referral).map(([source, count]) => ({ source, count })).sort((x, y) => y.count - x.count),
    perWeek: Object.entries(weeks).sort().map(([week, count]) => ({ week, count })),
    checks: {
      outside: realApps.filter(a => a.jt_state?.area?.status === 'outside').length,
      unchecked: realApps.filter(a => a.jt_state?.area?.status === 'unknown').length,
      repeat: realApps.filter(a => a.jt_state?.repeat?.matches?.length).length,
    },
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
  const form = await formFor(DB, { year });
  const errors = formErrors(form, answers, files);
  delete errors.video;
  if (Object.keys(errors).length) return { ok: false, errors };
  const id = newApplicationId();
  const at = iso(now);
  await DB.prepare('UPDATE application_drafts SET submitted_id = ? WHERE id = ?').bind(id, draftId).run();
  await DB.prepare(`INSERT INTO applications (id, draft_id, year, child_name, parent_name, parent_email, makeover_types, answers, files, is_test,
      jt_state, status, attempts, next_try_at, submitted_at, updated_at, form_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}', 'processing', 0, ?, ?, ?, ?)`)
    .bind(id, draftId, year, nameText(answers.childName), nameText(answers.parentName), email, JSON.stringify(answers.makeoverTypes), JSON.stringify(answers), JSON.stringify(files), now, at, at, form.version || 0).run();
  return { ok: true, id };
}

export { allFields };
