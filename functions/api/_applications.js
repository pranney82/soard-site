/**
 * Makeover applications: drafts, submit, and the load into JobTread
 * ===========================================================================
 * The form at /apply/form/ (definition in ./_application-form.js) saves a
 * draft on every step, keyed by an unguessable token the family keeps in a
 * resume link. Photos go to R2 (applicantFiles(): APPLICANT_FILES, a bucket
 * with no public domain, once it's bound; FILES until then), under applications/<draft>/,
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
  cleanAnswers, formErrors, stopFor, nameText, addressText, toE164, allFields, isVisible, indexById, DEFAULT_STAFF_EMAILS,
} from './_application-form.js';
import { buildApplicationPdf } from './_application-pdf.js';
import { COUNTIES, COMMUNITY_PROJECT_TYPE, COMMUNITY_PROJECT_LIKE } from './_application-constants.js';
import { sendEmails, escapeHtml, SITE_ORIGIN, slackPost, slackIssue, slackResolved } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import * as mail from './_email-shell.js';
import { readApplicant, sendIntake, ensureCommsSchema, ensureCommunityProjectType } from './_applicant-comms.js';
import { formFor, ensureFormSchema, getLiveForm } from './_application-forms.js';
import { spanishToDo, catchUpSpanish } from './_translate.js';
import { isUpload, isInput, answerText, progressPercent, renderMessage, choice, AREA_VALUES, kindOf, isOrganizationKind, rolesFor } from './_application-form.js';
import { checkServiceArea, areaText, addressKey, checkableAddress, bandOf } from './_geo.js';
import { placeHome } from '../../public/admin/area-shared.js';
import { maybeSyncApplicants } from './_applicants.js';
import { runJotformBackfill, jotformSecondLook } from './_jotform-backfill.js';
import { runNotifications } from './_applicant-notify.js';
import { runApprovals } from './_applicant-approved.js';
import { logAudit } from './_audit.js';
import { seasonSummary } from './_application-season.js';
import { capOf, capFacts, countReceived, claimWarning, tellCap, fullMessageOf, wholeNumber, CAP_USER, MAX_LIMIT } from './_application-cap.js';

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

/**
 * The home's county: the family's answer on a form that still asked, else the
 * address check's. The form doesn't ask any more: the address says (any county,
 * not just the ones a list would hold).
 */
export function countyOf(app) {
  const picked = String(app?.answers?.county || '').trim();
  if (picked && !/^other\b/i.test(picked)) return picked;
  const s = app?.jt_state || {};
  const fa = s.formArea;
  const fromForm = fa?.county && fa.key === addressKey(app?.answers?.address) ? fa.county : null;
  return String(s.area?.county || fromForm || '').replace(/\s+County$/i, '').trim() || null;
}

let _countyChoices = null; // { at, options }: the choices of JobTread's location County field (null = it takes any text)
/** The county as JobTread's County field takes it: one of its choices (spelled its way), any text when it has none, else left off */
export async function jobtreadCounty(env, county, fetchImpl, now = Date.now()) {
  const name = String(county || '').replace(/\s+County$/i, '').trim();
  if (!name) return null;
  if (!_countyChoices || now - _countyChoices.at > 10 * 60 * 1000) {
    try {
      const out = await pave(env.JOBTREAD_GRANT_KEY, {
        organization: { $: { id: SOARD_ORG_ID }, customFields: { $: { size: 100, where: ['targetType', '=', 'location'] }, nodes: { id: {}, options: {} } } },
      }, fetchImpl);
      const node = (out?.organization?.customFields?.nodes || []).find(f => f.id === JT_FIELDS.county);
      _countyChoices = { at: now, options: !node ? COUNTIES : Array.isArray(node.options) && node.options.length ? node.options : null };
    } catch {
      _countyChoices = { at: now - 9 * 60 * 1000, options: COUNTIES }; // JobTread didn't say: the ones it has always taken, asked again in a minute
    }
  }
  const { options } = _countyChoices;
  return !options ? name : options.find(o => String(o).toLowerCase() === name.toLowerCase()) || null;
}
/** For tests: forget JobTread's County choices */
export const forgetCountyChoices = () => { _countyChoices = null; };
const JT_YEARS = ['2025', '2026', '2027', '2028', '2029', '2030'];
export const MAKEOVER_TYPE_MAP = {
  'Accessible Bathroom': 'Bathroom',
  'Dream Bedroom': 'Bedroom',
  'In-Home Therapy Room': 'Therapy Room',
  Ramp: 'Ramp',
};
export const STAFF_EMAILS = DEFAULT_STAFF_EMAILS; // the live form's settings can change who gets them
export const ALERT_EMAILS = ['peter@soardcharity.com'];

// The built-in photo questions keep the file names staff know; any photo
// question added in the editor is named after its wording
const PHOTO_FIELDS = ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2'];
const PHOTO_FILE_NAMES = {
  photoChild: (c) => `${c}.jpg`,
  photoFamily: (c) => `${c} Family.jpg`,
  photoSpace1: (c) => `${c} Space 1.jpg`,
  photoSpace2: (c) => `${c} Space 2.jpg`,
  photoSpace3: (c) => `${c} Space 3.jpg`,
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
const SPANISH_RETRY_MS = 15 * 60 * 1000;
const SPANISH_LONGEST_WAIT_MS = 24 * 60 * 60 * 1000;
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
  //   *.kind                     'family' or 'organization' (./_application-form-org.js)
  //   application_drafts.*       language, furthest page, stop screen hit, reminder emails,
  //                              cleared_at (expired: personal data gone, kept for the funnel),
  //                              the last service-area check of the home address (area),
  //                              and test_by: a staff test run, every email going to that person
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
    'ALTER TABLE application_drafts ADD COLUMN area TEXT',
    'ALTER TABLE application_drafts ADD COLUMN area_checks INTEGER DEFAULT 0',
    'ALTER TABLE application_drafts ADD COLUMN test_by TEXT',
    // Which application it is: a family's, or an organization's for a community project (Oct 28 2026)
    "ALTER TABLE application_drafts ADD COLUMN kind TEXT DEFAULT 'family'",
    "ALTER TABLE applications ADD COLUMN kind TEXT DEFAULT 'family'",
    // Which save the draft's answers are (a tab left open can't save over another device's answers, Nov 1 2026)
    'ALTER TABLE application_drafts ADD COLUMN rev INTEGER DEFAULT 0',
    // An expired draft whose page, still open, started a new one with its answers (once; Nov 1 2026)
    'ALTER TABLE application_drafts ADD COLUMN renewed_at TEXT',
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

/**
 * A connection's address, hashed for the per-day limit. With a pepper (env
 * APPLY_IP_PEPPER or LIVE_IP_PEPPER) it's an HMAC, which can't be reversed by
 * trying every IPv4 address; without one, a plain hash as before.
 */
export async function hashIp(ip, pepper = '') {
  const data = new TextEncoder().encode(`soard-apply:${ip || 'unknown'}`);
  let buf;
  if (pepper) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pepper)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    buf = await crypto.subtle.sign('HMAC', key, data);
  } else buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Where applicants' photos and PDFs live: one place, so the bucket can change without a hunt */
export const applicantFiles = (env) => env?.APPLICANT_FILES || env?.FILES || null;

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

// maxApplications, warnAt and fullMessage are the application limit (./_application-cap.js): 0
// means no limit, and warnAt 0 means the built-in heads-up at 80% of it. orgOpen and
// orgClosedMessage are the organization application's (/apply/community-project/): it runs all
// year, open unless switched off, outside the family season's dates and limit.
export const APPLICATION_FIELDS = ['open', 'year', 'closedMessage', 'formUrl', 'opensAt', 'closesAt', 'maxApplications', 'warnAt', 'fullMessage', 'orgOpen', 'orgClosedMessage'];
const HTTPS_LINK = /^https:\/\/[^\s/]+\.[^\s]+$/i;

/** The stored block, every field present and normalized */
export function pickApplication(a = {}, now = Date.now()) {
  const maxApplications = wholeNumber(a?.maxApplications);
  const warnAt = maxApplications ? wholeNumber(a?.warnAt) : 0;
  return {
    open: a?.open === true,
    year: cleanYear(a?.year, now),
    closedMessage: String(a?.closedMessage || '').trim(),
    formUrl: String(a?.formUrl || '').trim(),
    opensAt: a?.opensAt ? String(a.opensAt) : '',
    closesAt: a?.closesAt ? String(a.closesAt) : '',
    maxApplications,
    warnAt: warnAt && warnAt < maxApplications ? warnAt : 0,
    fullMessage: String(a?.fullMessage || '').trim(),
    orgOpen: a?.orgOpen !== false,
    orgClosedMessage: String(a?.orgClosedMessage || '').trim(),
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
  out.fullMessage = out.fullMessage.replace(/\s+/g, ' ').slice(0, 200);
  out.orgClosedMessage = out.orgClosedMessage.replace(/\s+/g, ' ').slice(0, 200);
  if (out.formUrl && !HTTPS_LINK.test(out.formUrl)) errors.push({ field: 'formUrl', error: 'Use a full link that starts with https://' });
  // The limit: blank or 0 is no limit; anything else has to be a count the form can reach
  const given = (k) => input?.[k] != null && String(input[k]).trim() !== '' && Number(String(input[k]).replace(/,/g, '')) !== 0;
  if (given('maxApplications') && !out.maxApplications) errors.push({ field: 'maxApplications', error: `Use a whole number from 1 to ${MAX_LIMIT.toLocaleString('en-US')}` });
  if (out.maxApplications && given('warnAt') && !out.warnAt) {
    errors.push({ field: 'warnAt', error: wholeNumber(input.warnAt) ? `Pick a number under the limit of ${out.maxApplications.toLocaleString('en-US')}` : 'Use a whole number' });
  }
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
    // Opening (now, or a new time to open) a season that's already at its limit: the limit goes up first
    const cap = capOf(settings);
    const opening = (settings.open && !current.open) || (!!settings.opensAt && settings.opensAt !== current.opensAt);
    if (cap.max && opening) {
      const received = await countReceived(DB, settings.year);
      if (received >= cap.max) {
        return { errors: [{ field: 'maxApplications', error: `${received.toLocaleString('en-US')} of ${cap.max.toLocaleString('en-US')} applications are already in for ${settings.year}. Raise the limit to open again.` }] };
      }
    }
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
    const { results } = await DB.prepare(`SELECT user_email, entity_slug, changes, created_at FROM audit_log
      WHERE entity_type IN ('application-settings', 'settings') AND changes LIKE '%"application.%' ORDER BY id DESC LIMIT ?`).bind(limit).all();
    return (results || []).map(r => ({
      by: r.user_email,
      // The community project application's own settings (saved as rules-organization)
      kind: r.entity_slug === 'rules-organization' ? 'organization' : 'family',
      at: /Z$|[+-]\d\d:?\d\d$/.test(r.created_at) ? r.created_at : `${String(r.created_at).replace(' ', 'T')}Z`,
      changes: (parse(r.changes, []) || []).filter(c => String(c.field).startsWith('application.')),
    }));
  } catch {
    return [];
  }
}

/** When the community project application was last switched on or off (the audit log; null if never) */
export async function orgOpenChangedAt(DB) {
  try {
    const r = await DB.prepare(`SELECT created_at FROM audit_log WHERE entity_type IN ('application-settings', 'settings') AND changes LIKE '%"application.orgOpen"%' ORDER BY id DESC LIMIT 1`).first();
    if (!r?.created_at) return null;
    return /Z$|[+-]\d\d:?\d\d$/.test(r.created_at) ? r.created_at : `${String(r.created_at).replace(' ', 'T')}Z`;
  } catch {
    return null;
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
  // Time to open, but the season is already at its limit (families who started finished after it
  // closed): it stays closed, the time comes off, and the team hears why
  if (due.open && capOf(s).max) {
    const f = await capFacts(env.DB, s, { now });
    if (f.full) {
      const skipped = await saveApplicationSettings(env, { opensAt: '' }, { user: 'schedule', base: s, now });
      if (skipped.changes?.length) await tellCap(env, 'blocked', f, { opensAt: s.opensAt, at: now });
      return null;
    }
  }
  const out = await saveApplicationSettings(env, due, { user: 'schedule', base: s, now });
  if (!out.changes?.length) return null;
  const done = due.open ? 'opened' : 'closed';
  await slackPost(env, due.open
    ? slackCard({
      icon: '📬', title: `Applications are open for ${s.year}`,
      lead: 'They opened on schedule, so families can apply now.',
      buttons: [{ label: 'See the form', url: `${SITE_ORIGIN}/apply/form/` }, { label: 'Open Applications', url: `${SITE_ORIGIN}/admin/#applications` }],
    })
    : slackCard({
      icon: '📪', title: `Applications are closed for ${s.year}`,
      lead: 'They closed on schedule. Families who already started can still finish.',
      buttons: [{ label: 'Open Applications', url: `${SITE_ORIGIN}/admin/#applications` }],
    }), { kind: 'news', area: 'applications' }).catch(() => null);
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

/**
 * The application limit (./_application-cap.js), after every submit, on the
 * sweep and after a settings save: one heads-up to the team at the warn
 * point, and at the limit applications close by themselves (logged as made
 * by "limit"; whoever's write lands first sends the notice). Never throws.
 * → { warned: true } | { closed: true } | null
 */
export async function enforceApplicationCap(env, { now = Date.now() } = {}) {
  try {
    if (!env.DB) return null;
    const stored = await applicationSettings(env.DB);
    const s = pickApplication(stored, now);
    if (!s.open || !s.maxApplications) return null;
    const f = await capFacts(env.DB, s, { now, openedAt: stored.openChangedAt });
    if (f.full) {
      const out = await saveApplicationSettings(env, { open: false }, { user: CAP_USER, base: s, now });
      if (!out.changes?.length) return null;
      await tellCap(env, 'full', f, { at: now, message: fullMessageOf(s) });
      return { closed: true };
    }
    if (f.received >= f.warnAt && await claimWarning(env.DB, f.year, f.warnAt, now)) {
      await tellCap(env, 'warn', f, { at: now });
      return { warned: true };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Drafts ─────────────────────────────────────────────────────────

function draftRow(r) {
  if (!r) return null;
  return { ...r, answers: parse(r.answers, {}), files: parse(r.files, {}), area: parse(r.area, null) };
}

export async function getDraft(DB, id) {
  if (!isDraftId(id)) return null;
  await ensureSchema(DB);
  // An expired draft keeps a row for the funnel, but it can't be resumed
  return draftRow(await DB.prepare('SELECT * FROM application_drafts WHERE id = ? AND cleared_at IS NULL').bind(id).first());
}

/**
 * A new draft. testBy: a staff member's test run (Admin → Applications → Form, "Go through it as a
 * family"): it's kept out of the funnel and the per-connection limit (ip_hash 'admin'), gets no
 * reminders, and every email it sends goes to that person (see submitDraft).
 */
export async function createDraft(DB, { year, ipHash, verified = false, lang = 'en', testBy = null, kind = 'family', now = Date.now() }) {
  await ensureSchema(DB);
  const id = newDraftId();
  const by = testBy ? String(testBy).trim().toLowerCase() : null;
  // An organization's application is in English
  const k = kindOf(kind);
  await DB.prepare(`INSERT INTO application_drafts (id, year, answers, files, ip_hash, verified, lang, email, test_by, kind, created_at, updated_at) VALUES (?, ?, '{}', '{}', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, year, by ? 'admin' : (ipHash || null), by || verified ? 1 : 0, lang === 'es' && k === 'family' ? 'es' : 'en', by, by, k, iso(now), iso(now)).run();
  return id;
}

/**
 * A draft that expired while its page was still open (weeks on): that page may start a new one with its
 * answers without the quick check again (it passed it for this one), once. True when it may
 */
export async function renewExpired(DB, id, now = Date.now()) {
  if (!isDraftId(id)) return false;
  await ensureSchema(DB);
  const r = await DB.prepare('UPDATE application_drafts SET renewed_at = ? WHERE id = ? AND cleared_at IS NOT NULL AND submitted_id IS NULL AND renewed_at IS NULL')
    .bind(iso(now), id).run();
  return !!r?.meta?.changes;
}

export async function draftsToday(DB, ipHash, now = Date.now()) {
  await ensureSchema(DB);
  const row = await DB.prepare('SELECT COUNT(*) AS n FROM application_drafts WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, iso(now - 24 * 3600 * 1000)).first();
  return Number(row?.n || 0);
}

/**
 * Saves a page's answers. `rev` is the save the page last had (from resume or its own last save) and
 * `changed` the answers it changed since: when the draft was saved from somewhere else in between (the
 * emailed link on another device, a tab left open), what's saved there stays, with what changed here
 * on top, and `theirs` tells the page which answers came from there. A page that doesn't say (an
 * older one) saves everything, as before.
 */
export async function saveDraft(DB, draft, { answers, page, lang, rev = null, changed = null }, now = Date.now(), tries = 0) {
  const form = await formFor(DB, { kind: draft.kind, year: draft.year });
  const was = Number(draft.rev) || 0;
  const stale = Number.isInteger(rev) && rev !== was && Array.isArray(changed);
  const sent = cleanAnswers(form, answers || {});
  const clean = stale
    ? { ...cleanAnswers(form, draft.answers || {}), ...Object.fromEntries(changed.filter(id => typeof id === 'string' && id in sent).map(id => [id, sent[id]])) }
    : sent;
  // The service-area answer is the check's when the address was placed on the map (not the browser's word for it)
  const af = areaFieldOf(form);
  const placed = af ? placedArea(draft.area, clean.address, form.serviceArea) : null;
  if (placed) clean[af.id] = AREA_VALUES[placed.band];
  // (the area's answer follows the address, which the page checks again itself)
  const theirs = stale ? Object.fromEntries(Object.keys(clean).filter(id => id !== af?.id && !changed.includes(id) && JSON.stringify(clean[id]) !== JSON.stringify(sent[id])).map(id => [id, clean[id]])) : null;
  // A test run's emails only ever go to the staff member running it
  const email = draft.test_by || clean[rolesFor(draft.kind).email] || draft.email || null;
  const pageId = form.pages.some(p => p.id === page) ? page : draft.page;
  // For the funnel: the furthest page reached, and a stop screen if one was hit
  const at = form.pages.findIndex(p => p.id === pageId);
  const maxPage = Math.max(Number(draft.max_page) || 0, at);
  const maxPageId = at >= (Number(draft.max_page) || 0) ? pageId : (draft.max_page_id || pageId);
  const stop = stopFor(form, clean);
  const language = lang === 'es' || lang === 'en' ? lang : (draft.lang || 'en');
  const r = await DB.prepare('UPDATE application_drafts SET answers = ?, page = ?, email = ?, lang = ?, max_page = ?, max_page_id = ?, stop_key = ?, updated_at = ?, rev = ? WHERE id = ? AND COALESCE(rev, 0) = ?')
    .bind(JSON.stringify(clean), pageId || null, email, language, maxPage, maxPageId || null, stop?.key || null, iso(now), was + 1, draft.id, was).run();
  // Saved from somewhere else this very moment: done again on top of that save
  if (!r?.meta?.changes && tries < 3) {
    const fresh = await getDraft(DB, draft.id);
    if (fresh && !fresh.submitted_id) return saveDraft(DB, fresh, { answers, page, lang, rev, changed }, now, tries + 1);
  }
  return { answers: clean, page: pageId, rev: was + 1, theirs, maxPage: maxPageId || null };
}

// ─── The service-area check ─────────────────────────────────────────

/** The form's service-area question (type 'area'), or null on a form without one */
export function areaFieldOf(form) {
  return allFields(form).find(f => f.type === 'area') || null;
}

/**
 * A stored check, if it was for this address and found it on the map, placed
 * against today's service area (the outline or the close distance may have
 * changed since): { ...check, band, miles, edgeMiles }. Else null.
 */
export function placedArea(check, address, area) {
  if (!check || check.lat == null || check.lng == null || !area?.polygon) return null;
  if (check.key !== addressKey(address)) return null;
  const p = placeHome(check.lat, check.lng, area);
  return p.band === 'unknown' ? null : { ...check, ...p, nearMiles: area.nearMiles };
}

export const MAX_AREA_CHECKS = 40; // Census lookups per draft (a family retyping their address a few times uses a handful)

/**
 * Check a home address against the service area, for a draft (stored on it)
 * or a staff preview (draft null). The same address isn't looked up twice:
 * the stored check is placed again instead. Never throws.
 * → { key, band: 'inside'|'near'|'far'|'unknown', miles, edgeMiles, nearMiles, lat, lng, county, matched,
 *     reason?: 'incomplete' | 'no-match' | 'error' | 'limit', at }
 */
export async function areaCheck(env, form, address, { draft = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const key = addressKey(address);
  const area = form.serviceArea;
  if (!key || !checkableAddress(address)) return { key, band: 'unknown', reason: 'incomplete' };
  const known = placedArea(draft?.area, address, area);
  if (known) return known;
  // The Census didn't know this exact address before: it won't now either
  if (draft?.area?.key === key && draft.area.reason === 'no-match') return draft.area;
  if (draft && (Number(draft.area_checks) || 0) >= MAX_AREA_CHECKS) return { key, band: 'unknown', reason: 'limit' };
  const r = await checkServiceArea(addressText(address), area, fetchImpl);
  const out = {
    key, band: r.band, miles: r.miles ?? null, edgeMiles: r.edgeMiles ?? null, nearMiles: area.nearMiles,
    lat: r.lat ?? null, lng: r.lng ?? null, county: r.county ?? null, matched: r.matched ?? null,
    ...(r.reason ? { reason: r.reason } : {}), at: iso(now),
  };
  // Trouble reaching the Census isn't kept: the next save or the submit asks again
  if (draft && env.DB && r.reason !== 'error') {
    await env.DB.prepare('UPDATE application_drafts SET area = ?, area_checks = COALESCE(area_checks, 0) + 1 WHERE id = ?').bind(JSON.stringify(out), draft.id).run();
    draft.area = out;
    draft.area_checks = (Number(draft.area_checks) || 0) + 1;
  }
  return out;
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

/** Who an application is for, as the JobTread account and staff read it: the child's full name, or the organization's */
export function applicantNameOf(answers, kind = 'family') {
  const r = rolesFor(kind);
  return r.nameType === 'name' ? nameText(answers?.[r.name]) : String(answers?.[r.name] || '').replace(/\s+/g, ' ').trim();
}

/** Is this a rehearsal? Child's first name (or the organization's name) "TEST" (any case), or an admin test */
export function isTestAnswers(answers, kind = 'family') {
  const r = rolesFor(kind);
  const v = r.nameType === 'name' ? answers?.[r.name]?.first : answers?.[r.name];
  return /^test\b/i.test(String(v || '').trim());
}

/**
 * Freeze a draft into an application. Returns { ok, id } or { ok: false,
 * errors | error }. Submitting twice returns the same application.
 */
export async function submitDraft(env, draft, { now = Date.now(), forceTest = false } = {}) {
  const { DB } = env;
  if (draft.submitted_id) return { ok: true, id: draft.submitted_id, duplicate: true };
  const lang = draft.lang === 'es' ? 'es' : 'en';
  const form = await formFor(DB, { kind: draft.kind, year: draft.year });
  const answers = cleanAnswers(form, draft.answers);
  // The service area, checked again from the address on file (the family answers it only when the map can't place the home)
  const af = areaFieldOf(form);
  const area = af ? await areaCheck(env, form, answers.address, { draft, now }) : null;
  if (af && area.band !== 'unknown') answers[af.id] = AREA_VALUES[area.band];
  const stop = stopFor(form, answers);
  if (stop) return { ok: false, error: 'stopped', stop: stop.key };
  // An answer to a question these answers no longer show (Sensory "Yes", explained, then "No"): kept in the
  // draft in case they switch back, never sent
  const byId = indexById(form);
  for (const f of allFields(form)) if (f.id in answers && !isVisible(f, answers, byId)) delete answers[f.id];
  const errors = formErrors(form, answers, draft.files, null, lang);
  if (Object.keys(errors).length) return { ok: false, errors };

  // A staff test run: whatever emails were typed, the family's emails (JobTread's, from the
  // contacts made with these) and the staff heads-up all go to the person running it
  const testTo = draft.test_by || null;
  const kind = kindOf(draft.kind);
  const roles = rolesFor(kind);
  if (testTo) {
    answers[roles.email] = testTo;
    if (answers[roles.contact2.email]) answers[roles.contact2.email] = testTo;
  }
  const id = newApplicationId();
  const childName = applicantNameOf(answers, kind);
  const isTest = forceTest || !!testTo || isTestAnswers(answers, kind);
  const at = iso(now);
  // Claim the draft first so a double tap can't make two applications
  const claimed = await DB.prepare('UPDATE application_drafts SET submitted_id = ?, updated_at = ? WHERE id = ? AND submitted_id IS NULL').bind(id, at, draft.id).run();
  if (!(claimed?.meta?.changes > 0)) {
    const again = await getDraft(DB, draft.id);
    return { ok: true, id: again?.submitted_id, duplicate: true };
  }
  // The form's check rides along for intake, which reports it to staff
  const state = area && area.band !== 'unknown' ? { formArea: area } : area?.reason ? { formArea: { key: area.key, band: 'unknown', reason: area.reason } } : {};
  // A staff test run: the intake knows, so the team's Slack channel stays quiet
  if (testTo) state.testRun = testTo;
  await DB.prepare(`INSERT INTO applications (id, draft_id, year, child_name, parent_name, parent_email, makeover_types, answers, files, is_test,
      jt_state, status, attempts, next_try_at, submitted_at, updated_at, form_version, lang, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 0, ?, ?, ?, ?, ?, ?)`)
    .bind(id, draft.id, draft.year, childName, nameText(answers[roles.contactName]), answers[roles.email] || null,
      JSON.stringify(answers[roles.types] || []), JSON.stringify(answers), JSON.stringify(draft.files || {}), isTest ? 1 : 0, JSON.stringify(state), now, at, at, form.version || 0, lang, kind).run();
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

/** The account's display name: the child's name (or the organization's), "TEST " in front of a rehearsal */
export function accountName(app) {
  const name = applicantNameOf(app.answers, app.kind) || 'Applicant';
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
  if (isOrganizationKind(app.kind)) {
    // An organization: no child fields (Birthday, Diagnosis…), and Community Project as its type. The spaces it asked for stay in the application.
    const f = {
      [JT_FIELDS.status]: 'Applied',
      [JT_FIELDS.referredBy]: a.referredBy || null,
      [JT_FIELDS.makeoverYear]: JT_YEARS.includes(String(app.year)) ? String(app.year) : null,
      [JT_FIELDS.makeoverType]: [COMMUNITY_PROJECT_TYPE],
      [JT_FIELDS.applicationUrl]: applicationUrl(app.id),
    };
    return { ...mappedFields(form, a, 'account'), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null)) };
  }
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

/** The parents/guardians (or the organization's people) as JobTread contacts, main contact first */
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
  const r = rolesFor(app.kind);
  add(a[r.contactName], a[r.title], a[r.email], a[r.phone]);
  add(a[r.contact2.name], a[r.contact2.title], a[r.contact2.email], a[r.contact2.phone]);
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
  if (!key || !applicantFiles(env)) return null;
  const obj = await applicantFiles(env).get(key);
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

const pdfKey = (app) => `applications/${app.draft_id}/application.pdf`;
const pdfName = (app) => `${accountName(app)}_Application.pdf`;

async function ensurePdf(env, app) {
  const existing = app.jt_state.pdf?.key ? await r2Bytes(env, app.jt_state.pdf.key) : null;
  if (existing) return existing;
  // The family's language, with the English beside it for staff when that's Spanish
  const form = await formFor(env.DB, { kind: app.kind, year: app.year, version: app.form_version || 0, lang: app.lang || 'en' });
  const photos = {};
  for (const { id } of photoFieldsOf(app, form)) {
    const bytes = await r2Bytes(env, app.files[id]?.thumbKey);
    if (bytes) photos[id] = bytes;
  }
  const bytes = await buildApplicationPdf({ form, answers: app.answers, files: app.files, submittedAt: app.submitted_at, photos });
  await applicantFiles(env).put(pdfKey(app), bytes, { httpMetadata: { contentType: 'application/pdf' } });
  app.jt_state.pdf = { key: pdfKey(app), size: bytes.byteLength };
  return bytes;
}

export function staffEmail(app, accountId) {
  if (isOrganizationKind(app.kind)) return orgStaffEmail(app, accountId);
  const a = app.answers;
  const s = app.jt_state || {};
  const first = String(a.childName?.first || '').trim() || 'A new applicant';
  const age = ageOn(a.birthdate, app.submitted_at);
  const types = (a.makeoverTypes || []).join(' and ') || 'a makeover';
  const area = s.area;
  const county = countyOf(app);
  const repeats = s.repeat?.matches || [];
  const photos = Object.keys(app.files || {}).filter((k) => k !== 'video' && app.files[k]?.key).length;
  const { pill, TONES, esc } = mail;
  const areaHtml = !area ? null
    : area.status === 'inside' ? `${pill(area.edgeMiles != null && area.edgeMiles < 1 ? 'Inside, near the edge' : 'Inside', TONES.green)}`
    : area.status === 'outside' ? `${pill(`About ${area.miles} ${area.miles === 1 ? 'mile' : 'miles'} outside${bandOf(area) === 'near' ? ', close' : ''}`, TONES.amber)}`
    : `${pill('Couldn’t check the address', TONES.amber)}`;
  const countyClash = area?.county && a.county && area.county !== a.county ? ` <span class="muted" style="color:${mail.MUTED};">The Census says ${esc(area.county)} County.</span>` : '';
  const repeatHtml = repeats.length
    ? `${pill('Possible repeat', TONES.amber)} ${esc(repeats.map(m => `${m.name}${m.year ? ` (${m.year})` : ''}${m.status ? `, ${m.status}` : ''}`).join('; '))}`
    : a.previouslyApplied === 'Yes' ? 'The family says yes; no match found' : 'No';
  const contact = [nameText(a.parentName), a.parentEmail].filter(Boolean);
  const rows = [
    ['Makeover', esc(types)],
    ['Child', esc([nameText(a.childName), age != null ? `age ${age}` : null].filter(Boolean).join(', '))],
    ['Diagnosis', esc(a.diagnosis)],
    ['County', esc(county) + countyClash],
    ['Service area', areaHtml],
    ['Applied before', repeatHtml],
    ['Photos and video', esc([photos ? `${photos} ${photos === 1 ? 'photo' : 'photos'}` : 'No photos', app.files?.video ? 'video' : 'no video'].join(', '))],
    ['Language', app.lang === 'es' ? 'Spanish (applied in Spanish)' : null],
    ['Main contact', contact.length ? esc(contact.join(', ')) : null],
  ];
  const applicants = accountId ? `${SITE_ORIGIN}/admin/#applications/applicants/${accountId}` : applicationUrl(app.id);
  const jt = accountId ? jobtreadAccountUrl(accountId) : null;
  const html = mail.emailShell({
    preheader: `${types}${county ? `, ${county} County` : ''}. It’s in JobTread and the family has their copy.`,
    eyebrow: app.is_test ? 'Test application · not a real family' : `New application · ${app.year} season`,
    heading: `${first}’s family applied`,
    intro: `It came in through the website and is in JobTread with the application PDF and photos attached${app.files?.video ? '; the video follows once it finishes processing' : ''}. The family has the “Application Status” email with a copy of their answers.`,
    bodyHtml: mail.panel(mail.facts(rows))
      + `<div style="margin-top:16px;">${mail.button('Open in Applicants', applicants, 'primary')}${jt ? mail.button('Open in JobTread', jt, 'outline') : ''}</div>`
      + `<div style="font-family:${mail.SANS};font-size:13px;margin-top:2px;">${mail.link('The full application, photos and video', applicationUrl(app.id))}</div>`,
    footerHtml: `This has the family’s diagnosis and contact details, so please keep it inside SOARD. It goes to the staff list in ${mail.link('Applications settings', `${SITE_ORIGIN}/admin/#applications/settings`)}.`,
  });
  return {
    subject: `${app.is_test ? '[TEST] ' : ''}New makeover application: ${first}`,
    html,
    text: `${first}'s family applied (${app.year} season).\n\n${[
      ['Makeover', types], ['Child', nameText(a.childName)], ['Diagnosis', a.diagnosis], ['County', county],
      ['Service area', area ? areaText(area) : null], ['Main contact', contact.join(', ')],
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nOpen in Applicants: ${applicants}${jt ? `\nOpen in JobTread: ${jt}` : ''}`,
  };
}

/** The same heads-up for Slack. Kept short: no diagnosis or contact details in the channel. */
export function staffSlack(app, accountId) {
  if (isOrganizationKind(app.kind)) return orgStaffSlack(app, accountId);
  const a = app.answers;
  const s = app.jt_state || {};
  const first = String(a.childName?.first || '').trim();
  const age = ageOn(a.birthdate, app.submitted_at);
  const who = first ? `${first}${age != null ? `, age ${age}` : ''}` : 'a new family';
  const types = (a.makeoverTypes || []).join(' and ');
  const repeats = s.repeat?.matches || [];
  const photos = Object.keys(app.files || {}).filter((k) => k !== 'video' && app.files[k]?.key).length;
  const area = s.area;
  const county = countyOf(app);
  const areaWords = !area ? null
    : area.status === 'inside' ? (area.edgeMiles != null && area.edgeMiles < 1 ? 'Inside, near the edge' : 'Inside')
    : area.status === 'outside' ? `⚠️ About ${area.miles} ${area.miles === 1 ? 'mile' : 'miles'} outside${bandOf(area) === 'near' ? ' (close)' : ''}`
    : '⚠️ Couldn’t check the address';
  const countyClash = area?.county && a.county && area.county !== a.county ? ` (the Census says ${area.county} County)` : '';
  return slackCard({
    icon: '📝',
    title: `New application: ${who}`,
    test: app.is_test ? 'Test application · not a real family' : null,
    lead: [types, county ? `${county} County` : null, app.year ? `${app.year} season` : null].filter(Boolean).join(' · '),
    facts: [
      ['Service area', areaWords ? `${areaWords}${countyClash}` : null],
      ['Applied before', repeats.length
        ? `⚠️ Possible repeat: ${repeats.slice(0, 2).map((m) => `${m.name}${m.year ? ` (${m.year})` : ''}`).join('; ')}${repeats.length > 2 ? ` and ${repeats.length - 2} more` : ''}`
        : a.previouslyApplied === 'Yes' ? 'The family says yes; no match found' : 'No'],
      ['Sent', [app.files?.video ? 'a video' : null, photos ? `${photos} ${photos === 1 ? 'photo' : 'photos'}` : null].filter(Boolean).join(' and ') || 'No video or photos'],
      ['Language', app.lang === 'es' ? 'Spanish' : null],
      ['Heard about us', a.referredBy],
    ],
    buttons: [
      { label: 'Open the application', url: applicationUrl(app.id) },
      accountId ? { label: 'Open in JobTread', url: jobtreadAccountUrl(accountId) } : null,
    ],
    footer: 'Diagnosis and contact details stay in the application.',
  });
}

/** The service area as a pill for the staff email, and as words for Slack */
function areaPill(area) {
  const { pill, TONES } = mail;
  if (!area) return null;
  if (area.status === 'inside') return pill(area.edgeMiles != null && area.edgeMiles < 1 ? 'Inside, near the edge' : 'Inside', TONES.green);
  if (area.status === 'outside') return pill(`About ${area.miles} ${area.miles === 1 ? 'mile' : 'miles'} outside${bandOf(area) === 'near' ? ', close' : ''}`, TONES.amber);
  return pill('Couldn’t check the address', TONES.amber);
}
function areaWords(area) {
  if (!area) return null;
  if (area.status === 'inside') return area.edgeMiles != null && area.edgeMiles < 1 ? 'Inside, near the edge' : 'Inside';
  if (area.status === 'outside') return `⚠️ About ${area.miles} ${area.miles === 1 ? 'mile' : 'miles'} outside${bandOf(area) === 'near' ? ' (close)' : ''}`;
  return '⚠️ Couldn’t check the address';
}
const repeatWords = (repeats) => repeats.slice(0, 2).map((m) => `${m.name}${m.year ? ` (${m.year})` : ''}${m.status ? `, ${m.status}` : ''}`).join('; ') + (repeats.length > 2 ? ` and ${repeats.length - 2} more` : '');
/** An organization's spaces as the staff read them, "Something else" spelled out */
const orgSpaces = (a) => (a.spaceTypes || []).map((t) => (t === 'Something else' && a.spaceOther ? a.spaceOther : t)).join(' and ') || 'a space';

/** The new-application email to staff, for an organization's application */
function orgStaffEmail(app, accountId) {
  const a = app.answers;
  const s = app.jt_state || {};
  const org = applicantNameOf(a, 'organization') || 'A new organization';
  const spaces = orgSpaces(a);
  const area = s.area;
  const county = countyOf(app);
  const repeats = s.repeat?.matches || [];
  const photos = Object.keys(app.files || {}).filter((k) => k !== 'video' && app.files[k]?.key).length;
  const { pill, TONES, esc } = mail;
  const countyClash = area?.county && a.county && area.county !== a.county ? ` <span class="muted" style="color:${mail.MUTED};">The Census says ${esc(area.county)} County.</span>` : '';
  const kindText = a.orgType === 'Something else' && a.orgTypeOther ? a.orgTypeOther : a.orgType;
  const contact = [nameText(a.contactName), a.contactTitle, a.contactEmail].filter(Boolean);
  const rows = [
    ['Space', esc(spaces)],
    ['Organization', esc([org, kindText].filter(Boolean).join(', '))],
    ['Children served', esc([a.childrenServed ? `About ${a.childrenServed} a year` : null, a.agesServed ? `ages ${a.agesServed}` : null].filter(Boolean).join(', '))],
    ['County', esc(county) + countyClash],
    ['Service area', areaPill(area)],
    ['Applied before', repeats.length ? `${pill('Possible repeat', TONES.amber)} ${esc(repeatWords(repeats))}` : a.previouslyApplied === 'Yes' ? 'They say yes; no match found' : 'No'],
    ['Photos', esc(photos ? `${photos} ${photos === 1 ? 'photo' : 'photos'} of the space` : 'No photos')],
    ['Main contact', contact.length ? esc(contact.join(', ')) : null],
  ];
  const applicants = accountId ? `${SITE_ORIGIN}/admin/#applications/applicants/${accountId}` : applicationUrl(app.id);
  const jt = accountId ? jobtreadAccountUrl(accountId) : null;
  const html = mail.emailShell({
    preheader: `${spaces}${county ? `, ${county} County` : ''}. It’s in JobTread and they have their copy.`,
    eyebrow: app.is_test ? 'Test application · not a real organization' : `New community project application · ${app.year} season`,
    heading: `${org} applied for a community project`,
    intro: 'It came in through the website and is in JobTread with the application PDF and photos attached. Their contact has the “Application Status” email with a copy of their answers.',
    bodyHtml: mail.panel(mail.facts(rows))
      + `<div style="margin-top:16px;">${mail.button('Open in Applicants', applicants, 'primary')}${jt ? mail.button('Open in JobTread', jt, 'outline') : ''}</div>`
      + `<div style="font-family:${mail.SANS};font-size:13px;margin-top:2px;">${mail.link('The full application and photos', applicationUrl(app.id))}</div>`,
    footerHtml: `It has their contact details, so please keep it inside SOARD. It goes to the staff list in ${mail.link('Applications settings', `${SITE_ORIGIN}/admin/#applications/settings`)}.`,
  });
  return {
    subject: `${app.is_test ? '[TEST] ' : ''}New community project application: ${org}`,
    html,
    text: `${org} applied for a community project (${app.year} season).\n\n${[
      ['Space', spaces], ['Organization', [org, kindText].filter(Boolean).join(', ')], ['County', county],
      ['Service area', area ? areaText(area) : null], ['Main contact', contact.join(', ')],
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nOpen in Applicants: ${applicants}${jt ? `\nOpen in JobTread: ${jt}` : ''}`,
  };
}

/** The same heads-up for Slack, for an organization */
function orgStaffSlack(app, accountId) {
  const a = app.answers;
  const s = app.jt_state || {};
  const org = applicantNameOf(a, 'organization') || 'a new organization';
  const repeats = s.repeat?.matches || [];
  const photos = Object.keys(app.files || {}).filter((k) => k !== 'video' && app.files[k]?.key).length;
  const area = s.area;
  const county = countyOf(app);
  const countyClash = area?.county && a.county && area.county !== a.county ? ` (the Census says ${area.county} County)` : '';
  return slackCard({
    icon: '🏫',
    title: `New community project application: ${org}`,
    test: app.is_test ? 'Test application · not a real organization' : null,
    lead: [orgSpaces(a), county ? `${county} County` : null, app.year ? `${app.year} season` : null].filter(Boolean).join(' · '),
    facts: [
      ['Children served', a.childrenServed ? `About ${a.childrenServed} a year${a.agesServed ? `, ages ${a.agesServed}` : ''}` : null],
      ['Service area', areaWords(area) ? `${areaWords(area)}${countyClash}` : null],
      ['Applied before', repeats.length ? `⚠️ Possible repeat: ${repeatWords(repeats)}` : a.previouslyApplied === 'Yes' ? 'They say yes; no match found' : 'No'],
      ['Sent', photos ? `${photos} ${photos === 1 ? 'photo' : 'photos'} of the space` : 'No photos'],
      ['Heard about us', a.referredBy],
    ],
    buttons: [
      { label: 'Open the application', url: applicationUrl(app.id) },
      accountId ? { label: 'Open in JobTread', url: jobtreadAccountUrl(accountId) } : null,
    ],
    footer: 'Contact details stay in the application.',
  });
}

/** Whole years old on the day they applied, or null */
function ageOn(birthdate, on) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate || '');
  const d = new Date(on || Date.now());
  if (!m || Number.isNaN(d.getTime())) return null;
  let years = d.getUTCFullYear() - Number(m[1]);
  if (d.getUTCMonth() + 1 < Number(m[2]) || (d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() < Number(m[3]))) years--;
  return years >= 0 && years < 40 ? years : null;
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
  // An organization: the same organization name, or the same contact email or phone
  const org = isOrganizationKind(app.kind);
  const roles = rolesFor(app.kind);
  const child = norm(applicantNameOf(a, app.kind));
  const last = org ? '' : norm(a.childName?.last);
  const email = String(a[roles.email] || '').trim().toLowerCase();
  const phone = toE164(a[roles.phone]);
  const who = org ? 'contact' : 'parent';
  const matches = [];
  try {
    const { results } = await env.DB.prepare('SELECT id, year, child_name, answers, jt_account_id, submitted_at, kind FROM applications WHERE id != ? AND is_test = 0 AND deleted_at IS NULL ORDER BY submitted_at DESC LIMIT 400').bind(app.id).all();
    for (const r of results || []) {
      const ra = parse(r.answers, {});
      const rr = rolesFor(r.kind);
      const why = [];
      if (child && norm(r.child_name) === child) why.push(org ? 'same organization name' : 'same child\u2019s name');
      else if (last && ra.birthdate && ra.birthdate === a.birthdate && norm(ra.childName?.last) === last) why.push('same birthday and last name');
      if (email && String(ra[rr.email] || '').trim().toLowerCase() === email) why.push(`same ${who} email`);
      if (phone && toE164(ra[rr.phone]) === phone) why.push(`same ${who} phone`);
      if (why.length) matches.push({ where: 'site', id: r.id, name: r.child_name, year: r.year, why: why.join(', '), url: r.jt_account_id ? jobtreadAccountUrl(r.jt_account_id) : applicationUrl(r.id), accountId: r.jt_account_id || null });
    }
  } catch { /* no earlier applications to compare */ }
  try {
    const name = applicantNameOf(a, app.kind);
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
    // An organization has no diagnosis, so no medical note
    medicalNote: isOrganizationKind(app.kind) ? 'none' : s.intake?.medical === 'sent' || s.intake?.medical === 'already' ? true : s.intake?.medical || false,
    staffEmail: !!s.staffEmail,
    staffSlack: s.staffSlack === 'off' ? 'none' : !!s.staffSlack,
  };
}

/**
 * Where a staff test run's application has got to, for the checklist on its thank-you screen:
 * each intake step as it finishes, where the emails went, and the links to it. Nudges the
 * intake along when a retry is due, so the screen doesn't wait for the sweep.
 */
export async function testRunStatus(env, draft, { now = Date.now(), nudge = null } = {}) {
  if (!draft?.test_by) return null;
  if (!draft.submitted_id) return { submitted: false, to: draft.test_by };
  const app = await getApplication(env.DB, draft.submitted_id);
  if (!app) return { submitted: false, to: draft.test_by };
  if (nudge && app.status !== 'done' && (!app.next_try_at || app.next_try_at <= now) && !(app.locked_until > now)) nudge(processApplication(env, app.id, { now }));
  const s = app.jt_state || {};
  return {
    submitted: true,
    id: app.id,
    status: app.status,
    error: app.status === 'error' ? app.last_error || null : null,
    to: app.parent_email || draft.test_by,
    name: accountName(app),
    steps: { ...checklist(app), archived: !!s.archived },
    // Its row in Applicants → Submissions, which opens even once the JobTread account is archived
    adminUrl: `${SITE_ORIGIN}/admin/#applications/submissions/${app.id}`,
    jobtreadUrl: app.jt_account_id ? jobtreadAccountUrl(app.jt_account_id) : null,
  };
}

/** The checks staff see beside each application */
export function flags(app) {
  const s = app.jt_state || {};
  return {
    area: s.area ? { status: s.area.status, band: bandOf(s.area), miles: s.area.miles ?? null, text: areaText(s.area), county: s.area.county || null, from: s.area.from || null } : null,
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
  const form = await formFor(DB, { kind: app.kind, year: app.year, version: app.form_version || 0 });

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
    if (isOrganizationKind(app.kind)) await ensureCommunityProjectType(env, { fetchImpl: jt });
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

  // Where the home is, first: a check for staff, and the county its JobTread address gets.
  // Neither it nor the repeat check ever holds the application up: a failure is noted and left
  await step('service area', async () => {
    if (s.area) return;
    // The form placed the home as the family typed it (and again on submit): use that, else ask the Census now
    const fa = s.formArea;
    const fromForm = fa && fa.lat != null && fa.key === addressKey(app.answers.address);
    s.area = fromForm
      ? { status: fa.band === 'inside' ? 'inside' : 'outside', band: fa.band, miles: fa.miles, edgeMiles: fa.edgeMiles, nearMiles: fa.nearMiles, lat: fa.lat, lng: fa.lng, county: fa.county, matched: fa.matched, from: 'form' }
      : await checkServiceArea(addressText(app.answers.address), form.serviceArea, fetchImpl);
    if (s.area.status !== 'inside' || (s.area.county && app.answers.county && s.area.county !== app.answers.county)) {
      const lines = [areaText(s.area)];
      if (s.area.matched) lines.push(`The Census matched it to: ${s.area.matched}`);
      if (s.area.county && app.answers.county && s.area.county !== app.answers.county) lines.push(`The family picked ${app.answers.county} County; the Census says ${s.area.county} County.`);
      const field = areaFieldOf(form) || { type: 'radio', options: [] };
      const said = answerText(field, app.answers.boundary, true);
      lines.push(fromForm ? 'The form placed the home from its address as the family typed it, so they didn’t answer this themselves.' : `The family's answer: ${said || 'not given'}`);
      await postInternal(env, accountId, 'Service area check (automatic)', lines.join('\n\n'), jt).catch(() => {});
    }
  });

  await step('home', async () => {
    if (s.location?.id) return;
    const a = app.answers;
    const county = await jobtreadCounty(env, countyOf(app), jt, now); // from the address (the form doesn't ask)
    const out = await pave(env.JOBTREAD_GRANT_KEY, {
      createLocation: {
        $: {
          accountId, address: addressText(a.address), name: a.address?.line1 || null, parseAddress: true,
          ...(s.contacts?.[0]?.id ? { contactId: s.contacts[0].id } : {}),
          customFieldValues: { ...mappedFields(form, a, 'location'), ...(county ? { [JT_FIELDS.county]: county } : {}) },
        },
        createdLocation: { id: {} },
      },
    }, jt);
    s.location = { id: out?.createLocation?.createdLocation?.id || null };
    if (!s.location.id) throw new Error('JobTread did not return the new location');
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
    s.intake = await sendIntake(env, applicant, { uploadRequestIds: attach, fetchImpl: jt, now, lang: app.lang || 'en', medicalFallback: lastTry, kind: app.kind });
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
      // A sample goes to whoever sent it, so they see exactly what staff get
      const to = app.is_test ? [app.parent_email || ALERT_EMAILS[0]] : (await formFor(env.DB, { kind: app.kind, year: app.year })).staffEmails;
      const msg = staffEmail(app, accountId);
      const r = await sendEmails(env, { to, ...msg, tags: [{ name: 'type', value: 'application' }] });
      if (r.errors.length && !r.sent) failed.push(`email: ${r.errors[0]}`);
      else s.staffEmail = iso(now);
    }
    // A staff member's own test run of the form is nobody else's business: no team Slack post
    if (!s.staffSlack && s.testRun) s.staffSlack = 'off';
    if (!s.staffSlack) {
      // A test application is staff's business, not good news for the whole team
      const r = await slackPost(env, staffSlack(app, accountId), { kind: app.is_test ? 'attention' : 'news', area: 'applications' });
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

  // A sample has done its job once the emails are out: it archives itself in JobTread
  if (app.is_test && !waiting) {
    await step('archive sample', async () => {
      if (s.archived || !accountId) return;
      await pave(env.JOBTREAD_GRANT_KEY, { updateAccount: { $: { id: accountId, archive: true } } }, jt);
      s.archived = iso(now);
    });
  }

  const attempts = error ? (app.attempts || 0) + 1 : 0;
  const status = error ? 'error' : waiting ? 'waiting' : 'done';
  const retryIn = error ? Math.min(MAX_BACKOFF_MS, 60 * 1000 * 2 ** Math.min(attempts, 10)) : 2 * 60 * 1000;
  await saveState(DB, app, {
    status, attempts, last_error: error, locked_until: null,
    next_try_at: status === 'done' ? null : now + retryIn,
  }, now);

  if (error && attempts >= ALERT_AFTER_ATTEMPTS && app.alerted !== error) {
    // A new problem on an application already reported replies in that post's thread, and the channel
    const open = s.stuckSlack?.ts ? s.stuckSlack : null;
    const [, posted] = await Promise.all([
      sendEmails(env, { to: ALERT_EMAILS, ...stuckEmail(app, { attempts, error }) }).catch(() => {}),
      slackPost(env, stuckCard(app, { attempts, error, again: !!open }), open ? { thread: { ...open, broadcast: true } } : { area: 'applications' }).catch(() => null),
    ]);
    if (!open && posted?.ok && posted.ts) {
      s.stuckSlack = { channel: posted.channel, ts: posted.ts, since: iso(now) };
      await saveState(DB, app, {}, now);
    }
    await DB.prepare('UPDATE applications SET alerted = ? WHERE id = ?').bind(error, app.id).run();
  }
  // It got through on its own: a reply says so (in the channel too), and the stuck post turns a short ✅
  if (!error && s.stuckSlack?.ts) {
    const ref = { channel: s.stuckSlack.channel, ts: s.stuckSlack.ts };
    const tries = (app.attempts || 0) + 1;
    await Promise.all([
      slackPost(env, slackCard({
        icon: '✅', title: `Resolved: ${accountName(app)}’s application was stuck`, lead: 'It got through on its own.',
      }), { update: ref }).catch(() => null),
      slackPost(env, slackCard({
        icon: '✅',
        title: `Unstuck: ${accountName(app)}’s application`,
        lead: `It loaded into JobTread on its own after ${tries} tries. Nothing to do.`,
        buttons: [{ label: 'Open the application', url: applicationUrl(app.id) }],
      }), { thread: { ...ref, broadcast: true } }).catch(() => null),
    ]);
    delete s.stuckSlack;
    // Fixed and said so: if the same error comes back later, that's news again
    await saveState(DB, app, { alerted: null }, now);
  }
  return error ? { status, error } : { status };
}

/** The Slack post for an application that can't get into JobTread */
export function stuckCard(app, { attempts, error, again }) {
  return slackCard({
    icon: '⚠️',
    title: again ? `Still stuck: ${accountName(app)}’s application` : `Stuck: ${accountName(app)}’s application`,
    test: app.is_test ? 'Test application · not a real family' : null,
    lead: `${again ? 'A different problem now. ' : ''}The website couldn’t finish loading it into JobTread after ${attempts} tries.`,
    facts: [['Error', error]],
    fix: 'Nothing, usually: it keeps retrying on its own, and this post changes to ✅ when it gets through. To try right away, open it in the admin and press Retry.',
    buttons: [{ label: 'Open the application', url: applicationUrl(app.id) }],
  });
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
    // The application limit, should a submit's own check not have run (it rides waitUntil)
    const capped = await enforceApplicationCap(env, { now });
    // The live form's Spanish, for whatever Put live couldn't translate; before the emails below go out
    const spanish = await catchUpLiveSpanish(env, { now }).catch(() => null);
    const { results } = await DB.prepare("SELECT id FROM applications WHERE status != 'done' AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY next_try_at LIMIT 3").bind(now).all();
    const processed = [];
    for (const r of results || []) processed.push({ id: r.id, ...(await processApplication(env, r.id, { fetchImpl, now })) });
    const reminded = await sendReminders(env, { now });
    const expired = await expireDrafts(env, { now, fetchImpl });
    // Family status emails whose wait is over, and staff summaries (./_applicant-notify.js)
    const notified = await runNotifications(env, { fetchImpl, now });
    // Settled approvals: the makeover's JobTread job and the kid's profile (./_applicant-approved.js)
    const approved = await runApprovals(env, { fetchImpl, now });
    // Every applicant in JobTread, for Admin → Applications → Applicants
    const applicants = await maybeSyncApplicants(env, { fetchImpl, now });
    // Jotform's applications, copied home once (./_jotform-backfill.js); a no-op once done
    const jotform = await runJotformBackfill(env, { fetchImpl, now });
    // Then, once: the families it couldn't place, and JobTread's Application URLs off Jotform
    const jotformLook = await jotformSecondLook(env, { fetchImpl, now });
    return { processed, reminded, expired, notified, approved, applicants, capped, spanish, jotform, jotformLook };
  } catch {
    return null;
  }
}

/**
 * The live family form's Spanish, caught up with its English (./_translate.js).
 * Put live does this as a version goes live; this catches what the AI
 * couldn't do then. A try that got some done tries again on the next sweep;
 * one that got nothing waits SPANISH_RETRY_MS, twice that after another, up
 * to a day, so a string the AI can't do isn't asked for every 15 minutes for
 * good. After SPANISH_ALERT_TRIES tries in a row with nothing done, it says
 * so in Slack once; the post turns ✅ when the Spanish catches up.
 */
async function catchUpLiveSpanish(env, { now = Date.now() } = {}) {
  const { DB } = env;
  const live = await getLiveForm(DB);
  const behind = live.version ? Object.keys(spanishToDo(live.definition)).length : 0;
  const last = parse((await DB.prepare("SELECT value FROM application_runtime WHERE key = 'spanish'").first())?.value, null) || {};
  const save = (o) => DB.prepare("INSERT INTO application_runtime (key, value, updated_at) VALUES ('spanish', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(o), iso(now)).run();
  if (!behind) {
    if (last.alerted) {
      await spanishCaughtUp(env);
      await save({ ...last, alerted: false });
    }
    return null;
  }
  const same = last.version === live.version;
  if (same && now < (last.next || 0)) return null;
  // Claimed before the AI runs, so a sweep that overlaps this one doesn't start it again
  await save({ version: live.version, next: now + SPANISH_RETRY_MS, tries: same ? last.tries || 0 : 0, alerted: !!last.alerted });
  const out = await catchUpSpanish(env, live.version);
  // A cap reached isn't the AI failing at the Spanish: no try, no Slack post, and it goes on when it lifts
  if (out.capped && !out.filled) {
    await save({ version: live.version, next: now + SPANISH_RETRY_MS, tries: same ? last.tries || 0 : 0, alerted: !!last.alerted });
    return { version: live.version, ...out };
  }
  const tries = out.filled ? 0 : (same ? last.tries || 0 : 0) + 1;
  let alerted = !!last.alerted;
  if (out.failed.length && tries >= SPANISH_ALERT_TRIES && !alerted) {
    await slackIssue(env, SPANISH_ISSUE, spanishBehindCard(out.failed, tries), { title: 'The Spanish application was behind the English', area: 'applications' }).catch(() => null);
    alerted = true;
  } else if (!out.failed.length && alerted) {
    await spanishCaughtUp(env);
    alerted = false;
  }
  await save({ version: live.version, next: out.filled ? now : now + Math.min(SPANISH_RETRY_MS * 2 ** Math.max(0, tries - 1), SPANISH_LONGEST_WAIT_MS), tries, alerted });
  return { version: live.version, tries, ...out };
}
const spanishCaughtUp = (env) => slackResolved(env, SPANISH_ISSUE, slackCard({ icon: '✅', title: 'The Spanish application caught up', lead: 'Spanish-speaking families get the current wording again. Nothing to do.' })).catch(() => null);
const SPANISH_ISSUE = 'application-spanish';
const SPANISH_ALERT_TRIES = 4;
const SPANISH_PLACES = { 'message:welcome': 'Application received email', 'message:copyNote': 'Application received email', 'message:inReview': 'In review email', 'message:approved': 'Approved email', 'message:denied': 'Denied email', 'message:correction': 'Correction email', 'reminder:subject': 'Reminder email', 'reminder:body': 'Reminder email' };

/** The Slack post for Spanish the AI can't translate */
export function spanishBehindCard(paths, tries) {
  const places = [...new Set(paths.map(p => SPANISH_PLACES[p] || 'Questions on the form'))];
  return slackCard({
    icon: '⚠️',
    title: 'The Spanish application is behind the English',
    lead: `The website couldn’t translate ${paths.length === 1 ? 'one change' : `${paths.length} changes`} to the application after ${tries} tries, so Spanish-speaking families still get the older Spanish there.`,
    facts: [['Where', places.join(', ')]],
    fix: 'Nothing, usually: it tries again every 15 minutes, and this post turns ✅ when the Spanish catches up. To fix it now, open the Spanish, write it for each one marked Out of date, press “The Spanish is still right”, then Put live.',
    buttons: [{ label: 'Open the Spanish', url: `${SITE_ORIGIN}/admin/#applications/form/spanish` }],
  });
}

/**
 * Clear unsubmitted drafts older than DRAFT_TTL_DAYS: their answers, email,
 * photos and video go; a bare row stays (dates, furthest page, language,
 * stop screen) so the funnel still counts them. The link stops working.
 */
export async function expireDrafts(env, { now = Date.now(), fetchImpl = fetch, limit = 10 } = {}) {
  const { DB } = env;
  const cutoff = iso(now - DRAFT_TTL_DAYS * 24 * 3600 * 1000);
  const { results } = await DB.prepare('SELECT id, files, area FROM application_drafts WHERE submitted_id IS NULL AND cleared_at IS NULL AND updated_at < ? LIMIT ?').bind(cutoff, limit).all();
  for (const r of results || []) {
    const files = parse(r.files, {});
    for (const [k, f] of Object.entries(files)) {
      if (k === 'video') { for (const uid of [f?.uid, f?.next?.uid].filter(Boolean)) await deleteVideo(env, uid, fetchImpl); continue; } // (and a replacement left half-sent)
      if (applicantFiles(env)) for (const key of [f?.key, f?.thumbKey].filter(Boolean)) await applicantFiles(env).delete(key).catch(() => {});
    }
    // What the funnel reads stays: the area check's band, miles outside and why it couldn't place an
    // address; the address, point and county go. So does 'admin', the mark that keeps staff's tries out
    // of the counts (any other connection hash goes)
    const was = parse(r.area, null);
    const kept = was?.band ? { band: was.band, ...(Number.isFinite(Number(was.miles)) ? { miles: Number(was.miles) } : {}), ...(was.reason ? { reason: was.reason } : {}) } : null;
    await DB.prepare("UPDATE application_drafts SET answers = '{}', files = '{}', email = NULL, ip_hash = CASE WHEN ip_hash = 'admin' THEN 'admin' ELSE NULL END, area = ?, cleared_at = ? WHERE id = ? AND submitted_id IS NULL")
      .bind(kept ? JSON.stringify(kept) : null, iso(now), r.id).run();
  }
  return (results || []).length;
}

/** The email that says an application can't get into JobTread (after ALERT_AFTER_ATTEMPTS tries) */
export function stuckEmail(app, { attempts, error }) {
  return {
    subject: `Application for ${accountName(app)} is stuck`,
    html: `<p>The website couldn't finish loading an application into JobTread after ${attempts} tries.</p><p><strong>${escapeHtml(error)}</strong></p><p>It keeps retrying on its own. <a href="${escapeHtml(applicationUrl(app.id))}">Open it in the admin</a> to retry now.</p>`,
    text: `The website couldn't finish loading an application into JobTread after ${attempts} tries.\n\n${error}\n\nIt keeps retrying on its own. Admin: ${applicationUrl(app.id)}`,
  };
}

// ─── Reminder emails ────────────────────────────────────────────────

const DAY_MS = 24 * 3600 * 1000;

/** The email that nudges a family to finish (subject, html, text) */
export function reminderEmail({ form, draft, link, stopLink, percent }) {
  const a = draft.answers || {};
  const es = draft.lang === 'es';
  const org = isOrganizationKind(draft.kind);
  const roles = rolesFor(draft.kind);
  const vars = {
    parent: String(a[roles.contactName]?.first || '').trim() || (es ? 'hola' : 'there'),
    child: org ? (applicantNameOf(a, 'organization') || 'your organization') : String(a.childName?.first || '').trim() || (es ? 'su hijo o hija' : 'your child'),
    percent: String(percent),
    year: form.year,
  };
  const subject = renderMessage(form.reminders.subject, vars);
  const body = renderMessage(form.reminders.body, vars);
  const cta = es ? 'Terminar mi solicitud' : 'Finish my application';
  const stop = es ? 'No quiero más recordatorios' : 'Stop these reminders';
  const done = es ? `Avance: ${percent}%` : `${percent}% done`;
  const html = mail.emailShell({
    lang: es ? 'es' : 'en',
    preheader: es ? `Sus respuestas están guardadas. Ya completó el ${percent}%.` : `Your answers are saved. You're ${percent}% done.`,
    eyebrow: es ? `Solicitud de ${form.year}` : `${form.year} ${org ? 'community project' : 'makeover'} application`,
    heading: es ? 'Su solicitud está guardada' : 'Your application is saved',
    bodyHtml: mail.paragraphs(body, `font-family:${mail.SANS};font-size:16px;line-height:1.6;`)
      + `<div class="muted" style="margin:18px 0 8px;font-family:${mail.SANS};font-size:13px;font-weight:700;color:${mail.MUTED};">${mail.esc(done)}</div>`
      + mail.progress(percent)
      + `<div style="margin-top:22px;">${mail.button(cta, link, 'primary')}</div>`,
    footerHtml: `${es ? 'Recibe este correo porque comenzó una solicitud con Sunshine on a Ranney Day.' : 'You’re getting this because you started an application with Sunshine on a Ranney Day.'} ${mail.link(stop, stopLink)}`,
  });
  return { subject, html, text: `${body}\n\n${cta}: ${link}\n\n${stop}: ${stopLink}` };
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
    WHERE submitted_id IS NULL AND cleared_at IS NULL AND email IS NOT NULL AND verified = 1 AND test_by IS NULL
      AND COALESCE(reminders_off, 0) = 0 AND stop_key IS NULL AND COALESCE(reminders_sent, 0) < ?
      AND updated_at < ? AND (last_reminder_at IS NULL OR last_reminder_at < ?)
    ORDER BY updated_at LIMIT ?`).bind(days.length, iso(now - days[0] * DAY_MS), iso(now - DAY_MS), limit).all();
  let sent = 0;
  for (const r of results || []) {
    const draft = draftRow(r);
    const n = Number(draft.reminders_sent) || 0;
    if (now - Date.parse(draft.updated_at) < days[n] * DAY_MS) continue;
    const form = await formFor(DB, { kind: draft.kind, year: draft.year, lang: draft.lang || 'en' });
    const link = `${SITE_ORIGIN}${isOrganizationKind(draft.kind) ? '/apply/community-project/' : '/apply/form/'}?resume=${draft.id}`;
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
/** Accounts whose Makeover Type is Community Project (./_application-cap.js counts them the same way) */
async function communityAccounts(DB) {
  try {
    return new Set(((await DB.prepare('SELECT account_id FROM applicants WHERE types LIKE ?').bind(COMMUNITY_PROJECT_LIKE).all()).results || []).map(r => r.account_id));
  } catch {
    return new Set(); // no mirror yet
  }
}

/** What an application counts as: Community Project on its account overrides the form it came through (which still decides how it reads) */
const countsAs = (a, community) => (community.has(a.jt_account_id) ? 'organization' : kindOf(a.kind));

export async function listApplications(DB, { limit = 50, offset = 0, q = '', show = 'all', year = '', kind = '' } = {}) {
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
  const community = await communityAccounts(DB);
  if (kind) rows = rows.filter(a => countsAs(a, community) === kindOf(kind));
  if (show === 'outside') rows = rows.filter(a => a.jt_state?.area?.status === 'outside');
  if (show === 'unchecked') rows = rows.filter(a => a.jt_state?.area?.status === 'unknown');
  if (show === 'repeat') rows = rows.filter(a => a.jt_state?.repeat?.matches?.length);
  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  const years = (await DB.prepare('SELECT DISTINCT year FROM applications ORDER BY year DESC').all()).results?.map(r => r.year).filter(Boolean) || [];
  return {
    applications: page.map(a => ({
      id: a.id, year: a.year, kind: countsAs(a, community), child: a.child_name, parent: a.parent_name, email: a.parent_email,
      makeoverTypes: a.makeover_types, isTest: !!a.is_test, status: a.status, attempts: a.attempts,
      lastError: a.last_error, submittedAt: a.submitted_at, accountId: a.jt_account_id,
      jobtreadUrl: a.jt_account_id ? jobtreadAccountUrl(a.jt_account_id) : null,
      deletedAt: a.deleted_at || null, deletedBy: a.deleted_by || null,
      checklist: checklist(a), flags: flags(a),
    })),
    total,
    years,
  };
}

// A cell a spreadsheet would read as a formula (=, +, -, @, a tab or a return first) is kept as text
const csvCell = (v) => {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
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
    const key = `${a.kind || 'family'}:${a.year}:${a.form_version || 0}`;
    if (!forms.has(key)) forms.set(key, await formFor(DB, { kind: a.kind, year: a.year, version: a.form_version || 0 }));
    for (const f of allFields(forms.get(key))) if (isInput(f)) columns.set(f.id, f.label);
  }
  const fieldOf = (a, id) => allFields(forms.get(`${a.kind || 'family'}:${a.year}:${a.form_version || 0}`)).find(f => f.id === id);
  const head = ['Submitted', 'Season', 'Application', 'Child or organization', 'Main contact', 'Email', 'Status', 'JobTread account', 'Address check', 'Possible repeat', 'Language', ...columns.values()];
  const lines = [head.map(csvCell).join(',')];
  const community = await communityAccounts(DB);
  for (const a of rows) {
    const fl = flags(a);
    const base = [a.submitted_at, a.year, countsAs(a, community) === 'organization' ? 'Organization' : 'Family', a.child_name, a.parent_name, a.parent_email, a.status, a.jt_account_id ? jobtreadAccountUrl(a.jt_account_id) : '',
      fl.area?.text || '', fl.repeat.map(m => `${m.name}${m.year ? ` (${m.year})` : ''}`).join('; '), a.lang === 'es' ? 'Spanish' : 'English'];
    const answers = [...columns.keys()].map(id => { const f = fieldOf(a, id); return f ? answerText(f, a.answers?.[id], true) : ''; });
    lines.push([...base, ...answers].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

const REMOVED = JSON.stringify({ removed: 'the family’s data was deleted' });

/**
 * Delete a family's data from the site: answers, photos, the PDF, the video,
 * where the address check placed the home, the site's activity timeline for
 * the family and the admin's change log entries about them. A row stays
 * (dates, who deleted it) so the record shows it happened. JobTread is left
 * alone (archive the account there).
 */
export async function deleteApplicationData(env, id, { user = 'admin', now = Date.now(), fetchImpl = fetch } = {}) {
  const { DB } = env;
  const app = await getApplication(DB, id);
  if (!app) return { ok: false, error: 'Not found' };
  if (app.deleted_at) return { ok: true, already: true };
  const keys = [];
  for (const [k, f] of Object.entries(app.files || {})) {
    if (k === 'video') { for (const uid of [f?.uid, f?.next?.uid].filter(Boolean)) await deleteVideo(env, uid, fetchImpl); continue; }
    keys.push(f?.key, f?.thumbKey);
  }
  keys.push(app.jt_state?.pdf?.key);
  if (applicantFiles(env)) for (const key of keys.filter(Boolean)) await applicantFiles(env).delete(key).catch(() => {});
  const first = isOrganizationKind(app.kind) ? applicantNameOf(app.answers, 'organization') : String(app.answers?.childName?.first || '').trim();
  // What intake kept stays as a record of what was done (JobTread ids, which steps ran), minus where
  // the family lives: the address check's point, matched address and county
  const s = app.jt_state || {};
  const keep = { ...s };
  for (const k of ['area', 'formArea']) if (keep[k]) keep[k] = { band: keep[k].band || null, status: keep[k].status || null };
  const accountId = app.jt_account_id || null;
  const stmts = [
    DB.prepare("UPDATE applications SET answers = '{}', files = '{}', parent_name = NULL, parent_email = NULL, child_name = ?, jt_state = ?, deleted_at = ?, deleted_by = ?, status = 'done', next_try_at = NULL WHERE id = ?")
      .bind(first ? `${first} (deleted)` : 'Deleted application', JSON.stringify(keep), iso(now), user, id),
    DB.prepare("UPDATE application_drafts SET answers = '{}', files = '{}', email = NULL, ip_hash = NULL, area = NULL, cleared_at = ? WHERE id = ?").bind(iso(now), app.draft_id),
  ];
  // The site's own notes about the family: its activity timeline (read from JobTread's log once,
  // so it wouldn't come back) and the admin's change log (statuses, field values, messages).
  // The Applicants mirror row stays: it's JobTread's copy, refreshed from JobTread while the family is there.
  if (accountId) {
    stmts.push(DB.prepare('DELETE FROM applicant_activity WHERE account_id = ?').bind(accountId));
    stmts.push(DB.prepare("UPDATE audit_log SET changes = ?, entity_name = 'Deleted family' WHERE entity_slug = ?").bind(REMOVED, accountId));
    // What the board page kept: its list of their files (with JobTread's links), and their name on who opened them
    stmts.push(DB.prepare('DELETE FROM board_state WHERE key = ?').bind(`family-files:${accountId}`));
    stmts.push(DB.prepare("UPDATE board_activity SET sub = substr(sub, 1, instr(sub, '|')) WHERE kind = 'family' AND ref = ?").bind(accountId));
  }
  stmts.push(DB.prepare("UPDATE audit_log SET changes = ?, entity_name = 'Deleted application' WHERE entity_slug = ?").bind(REMOVED, id));
  // Either table may not exist on a fresh database; the application's own rows are what matter
  await DB.batch(stmts.slice(0, 2));
  for (const st of stmts.slice(2)) await st.run().catch(() => {});
  return { ok: true, accountId };
}

/**
 * The funnel for a season: who started, how far they got, who finished, and
 * what helped. Counts drafts (including expired ones, whose personal data is
 * gone) and submitted applications. Left out: staff's tries that never went in
 * (a test run, or the form opened while closed: ip_hash 'admin', test_by), and
 * sent applications marked test. A sent one counts by its application alone.
 */
export async function insights(DB, { year, now = Date.now(), kind = 'family' } = {}) {
  await ensureSchema(DB);
  // Each form's own funnel: its pages, its drafts and applications
  const k = kindOf(kind);
  const form = await formFor(DB, { year, kind: k });
  const drafts = ((await DB.prepare("SELECT id, created_at, updated_at, submitted_id, page, max_page, max_page_id, stop_key, lang, reminders_sent, cleared_at, area, answers FROM application_drafts WHERE year = ? AND COALESCE(kind, 'family') = ? AND (submitted_id IS NOT NULL OR (COALESCE(ip_hash, '') != 'admin' AND test_by IS NULL))").bind(String(year), k).all()).results) || [];
  const apps = ((await DB.prepare("SELECT id, draft_id, submitted_at, answers, lang, is_test, jt_state, jt_account_id, child_name FROM applications WHERE year = ? AND deleted_at IS NULL AND COALESCE(kind, 'family') = ?").bind(String(year), k).all()).results || []).map(applicationRow);
  // Left out: tests, deleted applications (their drafts stay behind, emptied), and from the makeovers' funnel any marked Community Project
  const deleted = ((await DB.prepare('SELECT draft_id FROM applications WHERE year = ? AND deleted_at IS NOT NULL').bind(String(year)).all()).results || []).map(r => r.draft_id);
  const community = k === 'family' ? await communityAccounts(DB) : new Set();
  const leftOut = new Set([...deleted, ...apps.filter(a => a.is_test || community.has(a.jt_account_id)).map(a => a.draft_id)]);
  const real = drafts.filter(d => !leftOut.has(d.id));
  const submitted = real.filter(d => d.submitted_id);
  const stopped = real.filter(d => !d.submitted_id && d.stop_key);
  const quietDays = (d) => (now - Date.parse(d.updated_at)) / DAY_MS;
  const inProgress = real.filter(d => !d.submitted_id && !d.stop_key && !d.cleared_at && quietDays(d) < 14);
  const gone = real.filter(d => !d.submitted_id && !d.stop_key && (d.cleared_at || quietDays(d) >= 14));
  const pageIds = form.pages.map(p => p.id);
  // The furthest page by its id; a page since taken out of the form falls back to its place then
  const furthest = (d) => { const i = d.max_page_id ? pageIds.indexOf(d.max_page_id) : -1; return i >= 0 ? i : Math.min(pageIds.length - 1, Number(d.max_page) || 0); };
  const reachedIndex = (d) => (d.submitted_id ? pageIds.length : Math.max(0, furthest(d)));
  const at = (list, i) => list.filter(d => reachedIndex(d) === i).length;
  // Still working: the page they're on now, which isn't always the furthest they've looked
  const onNow = (d) => (pageIds.includes(d.page) ? pageIds.indexOf(d.page) : reachedIndex(d));
  const byPage = form.pages.map((p, i) => ({
    id: p.id, title: p.title,
    reached: real.filter(d => reachedIndex(d) >= i).length,
    leftHere: at(gone, i),
    hereNow: inProgress.filter(d => onNow(d) === i).length,
    stoppedHere: at(stopped, i),
  }));
  const minutes = submitted.map(d => {
    const app = apps.find(a => a.draft_id === d.id);
    return app ? (Date.parse(app.submitted_at) - Date.parse(d.created_at)) / 60000 : null;
  }).filter(x => x != null && x >= 0).sort((x, y) => x - y);
  const mid = minutes.length >> 1;
  const median = minutes.length ? Math.round(minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2) : null;
  // Only who's had the 14 days that decide it: a quick finisher counts at once and a leaver only after 14 quiet days, so anyone newer flatters the rate
  const decided = (list) => list.filter(d => now - Date.parse(d.created_at) >= 14 * DAY_MS).length;
  // Who's had that long but isn't counted, so the line under the rate can say so
  const finishOf = { finished: decided(submitted), of: decided(submitted) + decided(gone), working: decided(inProgress), stopped: decided(stopped) };
  const realApps = apps.filter(a => !leftOut.has(a.draft_id));
  // "Who referred you" is typed: Facebook and facebook are one source, shown as most of them wrote it
  const refKey = (a) => String(a?.answers?.referredBy || '').trim().replace(/\s+/g, ' ');
  const spellings = {};
  for (const a of realApps) {
    const said = refKey(a);
    const key = said.toLowerCase();
    if (!key) continue;
    (spellings[key] ||= {})[said] = (spellings[key][said] || 0) + 1;
  }
  const sourceOf = (a) => {
    const key = refKey(a).toLowerCase();
    if (!key) return 'Not given';
    return Object.entries(spellings[key]).sort((x, y) => y[1] - x[1])[0][0];
  };
  const referral = {};
  for (const a of realApps) referral[sourceOf(a)] = (referral[sourceOf(a)] || 0) + 1;
  const working = new Set(inProgress.map(d => d.id));
  const people = real.map(d => {
    const app = apps.find(a => a.draft_id === d.id);
    const area = parse(d.area, null);
    return {
      id: d.id,
      name: app?.child_name || applicantNameOf(parse(d.answers, {}), k) || null,
      state: d.submitted_id ? 'submitted' : d.stop_key ? 'stopped' : working.has(d.id) ? 'working' : 'left',
      stop: d.stop_key || null,
      page: working.has(d.id) ? onNow(d) : reachedIndex(d),
      reached: reachedIndex(d),
      at: d.updated_at,
      band: area?.band || null,
      miles: Number.isFinite(Number(area?.miles)) ? Number(area.miles) : null,
      reason: area?.reason || null,
      referral: app ? sourceOf(app) : null,
      accountId: app?.jt_account_id || null,
    };
  }).sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
  return {
    year: String(year),
    kind: k,
    started: real.length,
    submitted: submitted.length,
    season: await seasonSummary(DB, year, now),
    people,
    inProgress: inProgress.length,
    leftUnfinished: gone.length,
    stopped: { outside: stopped.filter(d => d.stop_key === 'outside').length, rental: stopped.filter(d => d.stop_key === 'rental').length, other: stopped.filter(d => !['outside', 'rental'].includes(d.stop_key)).length },
    // Of those the form could finish for: still working isn't an answer yet, and stopped by the form isn't a failure to finish
    finishRate: finishOf.of ? Math.round((finishOf.finished / finishOf.of) * 100) : null,
    finishOf,
    medianMinutes: median,
    medianOf: minutes.length,
    byPage,
    languages: { en: real.filter(d => (d.lang || 'en') === 'en').length, es: real.filter(d => d.lang === 'es').length },
    reminders: { sent: real.reduce((n, d) => n + (Number(d.reminders_sent) || 0), 0), finishedAfter: submitted.filter(d => Number(d.reminders_sent) > 0).length },
    referral: Object.entries(referral).map(([source, count]) => ({ source, count })).sort((x, y) => y.count - x.count),
    area: areaInsights(form, real, gone),
    checks: {
      outside: realApps.filter(a => a.jt_state?.area?.status === 'outside').length,
      unchecked: realApps.filter(a => a.jt_state?.area?.status === 'unknown').length,
      repeat: realApps.filter(a => a.jt_state?.repeat?.matches?.length).length,
    },
  };
}

/**
 * Where the families who started live, from the form's address check: how
 * many it placed inside, close and farther out, how many addresses it
 * couldn't find, how far out the outside ones are (in steps up to and past
 * the close distance), and what families farther out did.
 */
function areaInsights(form, real, gone) {
  const sa = form.serviceArea || {};
  const checks = real.map(d => ({ d, a: parse(d.area, null) })).filter(x => x.a);
  const count = (band) => checks.filter(x => x.a.band === band).length;
  const near = Number(sa.nearMiles) || 0;
  const edges = [...new Set([5, 10, near, 25, 50].filter(n => n > 0))].sort((x, y) => x - y);
  const outside = checks.filter(x => x.a.band === 'near' || x.a.band === 'far').map(x => Number(x.a.miles)).filter(Number.isFinite);
  const steps = edges.map((to, i) => ({ from: i ? edges[i - 1] : 0, to, count: outside.filter(m => m > (i ? edges[i - 1] : 0) && m <= to).length, close: to <= near }));
  steps.push({ from: edges[edges.length - 1], to: null, count: outside.filter(m => m > edges[edges.length - 1]).length, close: false });
  const far = checks.filter(x => x.a.band === 'far').map(x => x.d);
  const goneIds = new Set(gone.map(d => d.id));
  return {
    nearMiles: near,
    beyond: sa.beyond === 'stop' ? 'stop' : 'warn',
    checked: checks.length,
    inside: count('inside'),
    near: count('near'),
    far: count('far'),
    notFound: checks.filter(x => x.a.band === 'unknown' && x.a.reason === 'no-match').length,
    // Not placed for another reason: the address wasn't finished, the Census didn't answer, too many tries
    notChecked: checks.filter(x => x.a.band === 'unknown' && x.a.reason !== 'no-match').length,
    steps,
    farDid: {
      applied: far.filter(d => d.submitted_id).length,
      stopped: far.filter(d => d.stop_key === 'outside').length,
      // Stopped as too far out, though today's close distance takes them in: the limit was shorter then
      earlier: checks.filter(x => x.a.band === 'far' && x.d.stop_key === 'outside' && near && Number(x.a.miles) <= near).length,
      left: far.filter(d => goneIds.has(d.id)).length,
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

/** The organization form's sample answers (Admin → Applications, "Send a test application") */
export function testOrgAnswers(email, year) {
  return {
    ackParameters: 'Yes, I understand.',
    ackSeason: 'Yes, I have read and understand the above statement.',
    boundary: 'Yes, it is within the boundary.',
    address: { line1: '1 Test Way', line2: '', city: 'Marietta', state: 'GA', zip: '30067' }, county: 'Cobb',
    orgName: 'TEST Organization', orgType: 'School', orgStatus: 'Yes, a 501(c)(3) nonprofit', website: 'https://example.org',
    mission: 'Test application from the website admin: please archive this account.', childrenServed: '120', agesServed: '3 to 12',
    needsServed: 'Test application.', previouslyApplied: 'No', referredBy: 'Website admin test',
    contactName: { first: 'Test', last: 'Contact' }, contactTitle: 'Director', contactEmail: email, contactPhone: '(404) 555-0100',
    building: 'We own it', approver: 'Yes, I can approve it',
    spaceTypes: ['Sensory room'], spaceToday: 'Test application.', spaceDream: 'Test application.', childrenUsing: '40',
    signature: 'Test Contact',
  };
}

export async function createTestApplication(env, { email, year, kind = 'family', now = Date.now() }) {
  const { DB } = env;
  const org = isOrganizationKind(kind);
  const draftId = await createDraft(DB, { year, ipHash: 'admin', verified: true, kind, now });
  const files = {};
  for (const id of org ? ['photoSpace1', 'photoSpace2'] : PHOTO_FIELDS) {
    const key = photoKey(draftId, id);
    const thumbKey = photoKey(draftId, id, true);
    await applicantFiles(env).put(key, TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await applicantFiles(env).put(thumbKey, TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    files[id] = { key, thumbKey, type: 'image/jpeg', size: TEST_JPEG.byteLength, name: `${id}.jpg` };
  }
  const answers = org ? testOrgAnswers(email, year) : testAnswers(email, year);
  await DB.prepare('UPDATE application_drafts SET answers = ?, files = ?, email = ? WHERE id = ?').bind(JSON.stringify(answers), JSON.stringify(files), email, draftId).run();
  // The test has no video (the form requires one), so it's frozen here instead of through submitDraft
  const form = await formFor(DB, { year, kind });
  const errors = formErrors(form, answers, files);
  delete errors.video;
  if (Object.keys(errors).length) return { ok: false, errors };
  const id = newApplicationId();
  const at = iso(now);
  await DB.prepare('UPDATE application_drafts SET submitted_id = ? WHERE id = ?').bind(id, draftId).run();
  const roles = rolesFor(kind);
  await DB.prepare(`INSERT INTO applications (id, draft_id, year, child_name, parent_name, parent_email, makeover_types, answers, files, is_test,
      jt_state, status, attempts, next_try_at, submitted_at, updated_at, form_version, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}', 'processing', 0, ?, ?, ?, ?, ?)`)
    .bind(id, draftId, year, applicantNameOf(answers, kind), nameText(answers[roles.contactName]), email, JSON.stringify(answers[roles.types] || []), JSON.stringify(answers), JSON.stringify(files), now, at, at, form.version || 0, kindOf(kind)).run();
  return { ok: true, id };
}

export { allFields };
