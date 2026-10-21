/**
 * CompanyCam for makeover families before they have a job
 * ===========================================================================
 * Peter, Oct 21 2026: "when makeover families are in the customer stage we
 * are vetting them and getting onsite photos, but company cam doesnt connect
 * to JT for customers, only for jobs ... i need a best in class solution".
 *
 * JobTread's own CompanyCam integration starts at the job: a new job gets a
 * project within seconds, and that project's photos copy into the job. A
 * family being vetted is only a JobTread customer, so their home-visit photos
 * had nowhere to go (staff uploaded them to the customer by hand). This
 * covers that stretch and hands over to JobTread's integration at the job:
 *
 *  1. In Review (the interview and home visit): the family gets one
 *     CompanyCam project, named the way their job will be ("Ava Smith
 *     (2027)"), at their home, with their primary contact, a "Vetting" label,
 *     a line about the makeover with a link back to JobTread, and the two
 *     photos of the space from their application. A project staff already
 *     started at that address is used instead, never one an earlier job uses.
 *  2. Every photo and document taken in it copies to the family's JobTread
 *     customer within seconds (CompanyCam's webhook, ./companycam-webhook.js),
 *     in a "Home visit" folder, tagged .BeforePics plus any CompanyCam tag
 *     whose name matches a JobTread file tag (CompanyCam "Exterior" is
 *     JobTread ":Exterior"). A caption, tag or markup added later follows
 *     (tags staff add in JobTread stay). A check every 10 minutes catches
 *     anything the webhook missed.
 *  3. The job (made on approval by ./_applicant-approved.js with this
 *     project's id, or by hand): it's linked to the same project, so JobTread
 *     doesn't start a second one and copies the project's photos to the job
 *     itself. Once the job has a photo, the site's copy on the customer is
 *     removed (a job's files show on its customer page too, so nothing shows
 *     twice) unless someone commented on it in JobTread. JobTread's copy gets
 *     the same folder and tag. If JobTread hasn't copied a photo 30 minutes
 *     after the link, the site copies it to the job itself. A job that already
 *     has its own project with photos in it keeps that project: the
 *     home-visit photos are copied to the job, and new ones in the home-visit
 *     project keep following.
 *  4. Denied (or the customer archived): the project is archived, and restored
 *     if the family comes back to In Review. Their JobTread files stay.
 *
 * Runs on the live hub's heartbeat (./broadcast-hooks.js) at most once a
 * minute, a few families and files per run, inside a time budget. Each piece
 * is claimed in D1 first, so a webhook and the heartbeat never copy the same
 * photo twice. CompanyCam's webhook body only says what to look at: the
 * photo, document or project is read back from CompanyCam before anything is
 * written to JobTread. Problems go to Slack once (a family with no full home
 * address, CompanyCam turning the key down, a photo JobTread won't take),
 * threaded, and turn ✅ when they clear. The family's history in Admin →
 * Applicants shows each step.
 *
 * Videos stay in CompanyCam: its API has no file to copy, only a stream.
 *
 * Env: COMPANYCAM_TOKEN (./_companycam.js), JOBTREAD_GRANT_KEY.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import { FIELDS, jobtreadAccountUrl, jobtreadJobUrl, refreshApplicants } from './_applicants.js';
import { FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE } from './_applicant-comms.js';
import { cleanYear, isTestFamily, existingJob, approveFamily, ensureApprovalSchema } from './_applicant-approved.js';
import { slackIssue, slackResolved, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import {
  companycamOn, CompanyCamError, getProject, searchProjects, createProject, archiveProject, unarchiveProject,
  setProjectDescription, addProjectLabels, removeProjectLabel, projectUrl, projectPhotos, projectDocuments,
  getPhoto, getDocument, photoImageUrl, markupText, uploadPhoto, listWebhooks, createWebhook, updateWebhook,
  deleteWebhook, webhookToken, setPhotoDescription, addPhotoTags, listTags, webhookDeliveries, projectLabels, deletePhoto,
} from './_companycam.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TICK_EVERY_MS = MIN;
const RECONCILE_EVERY_MS = 10 * MIN;
const WEBHOOK_CHECK_EVERY_MS = 10 * MIN; // CompanyCam turns a webhook off after failed deliveries; back on within minutes
const MOVE_AFTER_MS = 10 * MIN;          // JobTread copies a linked project's photos within seconds; this is room to spare
const COPY_OURSELVES_AFTER_MS = 30 * MIN; // ...and past this, the site copies what JobTread didn't
const CLAIM_STALE_MS = 5 * MIN;           // a claim this old means its worker died mid-way
const RETRY_MS = [1, 5, 15, 60, 180, 360].map((m) => m * MIN);
const ALERT_AFTER_TRIES = 6;              // about 4½ hours of trying before Slack hears about a photo
const TOKEN_ALERT_EVERY_MS = DAY;
const BUDGET_MS = 20000;                  // Pages gives waitUntil about 30 seconds
const PER_TICK = { families: 3, files: 8, reconcile: 3, moves: 2 };
const NOT_PROCESSED_RETRY_MS = 2 * MIN;
const APP_PHOTO_TRIES = 5;
const ADOPT_WITHIN_MS = 180 * DAY;       // a project staff started for this home visit, not one from years ago
const HAS_JOB_RECHECK_MS = DAY;

/**
 * Off since Oct 21 2026 (Peter: "i actually dont think we need this ... i move
 * the onsite visit to the job anyway"): families in review get no project of
 * their own unless COMPANYCAM_CUSTOMER_STAGE is "on" in Cloudflare. Everything else stays: the webhook, the API, the copies already
 * made, and what ./_companycam-jobs.js uses to keep jobs' photos whole.
 */
export const customerStage = (env) => String(env?.COMPANYCAM_CUSTOMER_STAGE || '').trim().toLowerCase() === 'on';

export const FOLDER = 'Home visit';
export const BEFORE_TAG = '.BeforePics';
export const VETTING_LABEL = 'Vetting';
export const APPLICATION_PHOTOS = ['photoSpace1', 'photoSpace2']; // the space, not the child or family portraits
const APP_CAPTION = 'Sent by the family with their application';
export const WEBHOOK_URL = `${SITE_ORIGIN}/api/companycam-webhook`;
export const WEBHOOK_SCOPES = ['photo.*', 'document.created', 'document.updated', 'project.deleted', 'project.merged'];

const iso = (t = Date.now()) => new Date(t).toISOString();
const cut = (s, n) => (s == null ? null : String(s).slice(0, n));
const retryIn = (tries) => RETRY_MS[Math.min(Math.max(tries - 1, 0), RETRY_MS.length - 1)];
const errText = (e) => cut(String(e?.message || e), 300);

// ─── D1 ─────────────────────────────────────────────────────────────

const SCHEMA = [
  // One row per family: their CompanyCam project and where it is in the handover
  //   stage: making | waiting (couldn't make it yet) | customer | linked (the job uses it)
  //          | separate (the job has its own project) | closed (archived) | gone (deleted in CompanyCam)
  //          | selftest (the one-time check's project at the office, below)
  //          | has-job (in review, but their makeover already has its job: JobTread's integration has it)
  `CREATE TABLE IF NOT EXISTS companycam_projects (
    account_id TEXT PRIMARY KEY, project_id TEXT, project_url TEXT, name TEXT, stage TEXT NOT NULL, how TEXT,
    job_id TEXT, seen_job_id TEXT, other_project_id TEXT, linked_at TEXT, label_id TEXT, app_photos TEXT,
    checked_at INTEGER, problem TEXT, detail TEXT, tries INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER,
    claimed_at INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_companycam_projects_project ON companycam_projects(project_id)',
  // One row per CompanyCam photo or document in a family's project ("photo:123", "document:45")
  //   state: pending | working | copied (on the customer) | moved (on the job) | skipped | failed (still retried)
  //   origin: companycam (taken there) | application (the site put it there from the family's application)
  `CREATE TABLE IF NOT EXISTS companycam_files (
    cc_id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT NOT NULL, account_id TEXT NOT NULL,
    origin TEXT NOT NULL, state TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, jt_file_id TEXT, job_file_id TEXT,
    synced TEXT, cc_updated TEXT, tries INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER, claimed_at INTEGER,
    error TEXT, copied_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_companycam_files_due ON companycam_files(state, next_try_at)',
  'CREATE INDEX IF NOT EXISTS idx_companycam_files_account ON companycam_files(account_id, state)',
  'CREATE TABLE IF NOT EXISTS companycam_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
export async function ensureCompanyCamSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  _ready.add(DB);
}

async function getState(DB, key) {
  const v = await DB.prepare('SELECT value FROM companycam_state WHERE key = ?').bind(key).first('value');
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
async function putState(DB, key, value, now) {
  await DB.prepare('INSERT INTO companycam_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), iso(now)).run();
}
/** Take a turn at `key` if its last turn was `everyMs` ago (one isolate at a time) */
async function takeTurn(DB, key, everyMs, now) {
  const next = String(now + everyMs);
  const ins = await DB.prepare('INSERT OR IGNORE INTO companycam_state (key, value, updated_at) VALUES (?, ?, ?)').bind(`turn:${key}`, next, iso(now)).run();
  if (ins?.meta?.changes > 0) return true;
  const upd = await DB.prepare('UPDATE companycam_state SET value = ?, updated_at = ? WHERE key = ? AND CAST(value AS INTEGER) <= ?').bind(next, iso(now), `turn:${key}`, now).run();
  return upd?.meta?.changes > 0;
}

const PROJECT_COLUMNS = ['project_id', 'project_url', 'name', 'stage', 'how', 'job_id', 'seen_job_id', 'other_project_id', 'linked_at', 'label_id', 'app_photos', 'checked_at', 'problem', 'detail', 'tries', 'next_try_at', 'claimed_at'];
export const getFamilyRow = (DB, accountId) => DB.prepare('SELECT * FROM companycam_projects WHERE account_id = ?').bind(String(accountId)).first();
const rowForProject = (DB, projectId) => DB.prepare('SELECT * FROM companycam_projects WHERE project_id = ?').bind(String(projectId)).first();
async function saveFamily(DB, row, now) {
  const cols = PROJECT_COLUMNS.filter((c) => c in row);
  const vals = cols.map((c) => row[c] ?? null);
  // A change to a row that's there; a new row needs its stage
  const upd = await DB.prepare(`UPDATE companycam_projects SET ${[...cols.map((c) => `${c} = ?`), 'updated_at = ?'].join(', ')} WHERE account_id = ?`)
    .bind(...vals, iso(now), String(row.account_id)).run();
  if (upd?.meta?.changes > 0 || !row.stage) return;
  await DB.prepare(`INSERT INTO companycam_projects (account_id, ${cols.join(', ')}, created_at, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?)`)
    .bind(String(row.account_id), ...vals, row.created_at || iso(now), iso(now)).run();
}

/** In the family's history (Admin → Applicants), like ./_applicants.js writes it */
async function logActivity(DB, accountId, { title, body = null, data = null }, now) {
  await DB.prepare('INSERT OR IGNORE INTO applicant_activity (id, account_id, at, kind, by_name, source, title, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`companycam:${now}:${Math.random().toString(36).slice(2, 8)}`, String(accountId), iso(now), 'companycam', 'Website (automatic)', 'website', title, body, data ? JSON.stringify(data) : null)
    .run().catch(() => null); // no applicant tables (a test, or before the first applicant sync)
}

// ─── JobTread ───────────────────────────────────────────────────────

const jt = (env, query, fetchImpl) => pave(env.JOBTREAD_GRANT_KEY, query, fetchImpl);

// Small explicit sizes: JobTread sizes a query by its worst case (413 otherwise)
const ACCOUNT = {
  id: {}, name: {}, type: {}, createdAt: {}, archivedAt: {}, organization: { id: {} },
  customFieldValues: { $: { size: 8, where: [['customField', 'id'], 'in', [FIELDS.status.id, FIELDS.year.id, FIELDS.types.id]] }, nodes: { value: {}, customField: { id: {} } } },
  primaryLocation: { id: {}, street: {}, city: {}, state: {}, postalCode: {}, country: {}, latitude: {}, longitude: {} },
  primaryContact: { id: {}, name: {}, customFieldValues: { $: { size: 2, where: [['customField', 'id'], 'in', [FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE]] }, nodes: { value: {}, customField: { id: {} } } } },
  jobs: { $: { size: 10, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: { id: {}, name: {}, closedOn: {}, createdAt: {}, companycamId: {} } },
};

function values(node) {
  const out = {};
  for (const v of node?.customFieldValues?.nodes || []) {
    const id = v.customField?.id;
    if (!id) continue;
    out[id] = id in out ? [].concat(out[id], v.value) : v.value;
  }
  return out;
}
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The family as this needs it, fresh from JobTread, or null if it isn't a SOARD customer */
export async function readFamily(env, accountId, fetchImpl = fetch) {
  const out = await jt(env, { account: { $: { id: String(accountId) }, ...ACCOUNT } }, fetchImpl);
  const a = out?.account;
  if (!a || a.organization?.id !== SOARD_ORG_ID || a.type !== 'customer') return null;
  const v = values(a);
  const c = values(a.primaryContact);
  const loc = a.primaryLocation || {};
  const types = v[FIELDS.types.id];
  return {
    id: a.id, name: String(a.name || '').trim(), createdAt: a.createdAt || null, archived: !!a.archivedAt, status: v[FIELDS.status.id] || '',
    year: cleanYear(v[FIELDS.year.id]), types: (Array.isArray(types) ? types : types ? [types] : []).map(String),
    locationId: loc.id || null,
    home: {
      street: String(loc.street || '').trim(), city: String(loc.city || '').trim(), state: String(loc.state || '').trim(),
      postal: String(loc.postalCode || '').trim(), country: String(loc.country || '').trim() || 'US', lat: num(loc.latitude), lng: num(loc.longitude),
    },
    contact: a.primaryContact ? { name: String(a.primaryContact.name || '').trim(), email: String(c[FIELD_CONTACT_EMAIL] || '').trim(), phone: String(c[FIELD_CONTACT_PHONE] || '').trim() } : null,
    jobs: (a.jobs?.nodes || []).map((j) => ({ id: j.id, name: j.name || '', closedOn: j.closedOn || null, createdAt: j.createdAt || null, companycamId: j.companycamId ? String(j.companycamId) : null })),
  };
}

/** The org's file tags, by a loose name (".BeforePics" and "before pics" are the same tag) */
const tagKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
let _tags = null;
async function fileTags(env, fetchImpl, now) {
  if (_tags && _tags.at > now - 5 * MIN && _tags.env === env) return _tags.map;
  const out = await jt(env, { organization: { $: { id: SOARD_ORG_ID }, fileTags: { $: { size: 100 }, nodes: { id: {}, name: {} } } } }, fetchImpl);
  const map = new Map((out?.organization?.fileTags?.nodes || []).map((t) => [tagKey(t.name), t.id]));
  _tags = { at: now, env, map };
  return map;
}
/** JobTread tag ids for a CompanyCam photo: .BeforePics, then its tags that JobTread also has (JobTread takes 10) */
export function tagIdsFor(kind, ccTags, tags) {
  const ids = [];
  if (kind === 'photo' && tags.get(tagKey(BEFORE_TAG))) ids.push(tags.get(tagKey(BEFORE_TAG)));
  for (const t of ccTags || []) {
    const id = tags.get(tagKey(t?.display_value || t?.value || t));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 10);
}

/** A JobTread upload request for a file at `url`: JobTread fetches it, or the site carries the bytes if it can't */
export async function uploadToJobTread(env, url, fetchImpl) {
  try {
    const up = await jt(env, { createUploadRequest: { $: { organizationId: SOARD_ORG_ID, url }, createdUploadRequest: { id: {} } } }, fetchImpl);
    const id = up?.createUploadRequest?.createdUploadRequest?.id;
    if (id) return id;
  } catch (e) {
    if (!/JobTread returned 4\d\d/.test(e.message)) throw e;
  }
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`CompanyCam’s file returned ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  const up = await jt(env, { createUploadRequest: { $: { organizationId: SOARD_ORG_ID, size: bytes.byteLength, type }, createdUploadRequest: { id: {}, url: {}, method: {}, headers: {} } } }, fetchImpl);
  const req = up?.createUploadRequest?.createdUploadRequest;
  if (!req?.id || !req?.url) throw new Error('JobTread didn’t give an upload slot');
  const put = await fetchImpl(req.url, { method: req.method || 'PUT', headers: req.headers || {}, body: bytes });
  if (!put.ok) throw new Error(`JobTread’s upload returned ${put.status}`);
  return req.id;
}

async function createJtFile(env, input, fetchImpl) {
  const out = await jt(env, { createFile: { $: input, createdFile: { id: {} } } }, fetchImpl);
  const id = out?.createFile?.createdFile?.id;
  if (!id) throw new Error('JobTread didn’t make the file');
  return id;
}
// update* and delete* return the query root: select nothing
const updateJtFile = (env, input, fetchImpl) => jt(env, { updateFile: { $: input } }, fetchImpl);
const deleteJtFile = (env, id, fetchImpl) => jt(env, { deleteFile: { $: { id } } }, fetchImpl);
async function jtFile(env, id, fetchImpl) {
  const out = await jt(env, { file: { $: { id }, id: {}, name: {}, folder: {}, fileTags: { $: { size: 10 }, nodes: { id: {} } }, comments: { $: { size: 1 }, nodes: { id: {} } } } }, fetchImpl);
  return out?.file || null;
}
const tagIdsOf = (file) => (file?.fileTags?.nodes || []).map((t) => t.id);

// ─── What a copy says ───────────────────────────────────────────────

const WHEN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** CompanyCam's times: ISO from the API, seconds in webhooks */
function whenText(t) {
  if (t == null || t === '') return '';
  const d = new Date(typeof t === 'number' || /^\d+$/.test(String(t)) ? Number(t) * 1000 : t);
  return Number.isNaN(d.getTime()) ? '' : WHEN.format(d);
}
const plainCaption = (item) => String(typeof item?.description === 'string' ? item.description : item?.description?.plain_text_content || '').replace(/\s+/g, ' ').trim();
const safeName = (s) => String(s || '').replace(/[\\/\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
/** A caption short enough for a file name: a whole first sentence that fits, else whole words and "…" */
export function captionWords(caption, max = 60) {
  const c = safeName(caption);
  if (c.length <= max) return c;
  const cut = c.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end >= 20) return cut.slice(0, end + (cut[end] === '.' || cut[end] === ';' ? 0 : 1));
  return `${cut.replace(/\s+\S*$/, '').replace(/[\s,;:.-]+$/, '')}…`;
}

/** The JobTread file a CompanyCam photo or document becomes: { name, description } */
export function copyOf(kind, item) {
  if (kind === 'document') {
    return { name: safeName(item?.name).slice(0, 120) || 'CompanyCam document', description: item?.project_id ? `From CompanyCam: ${projectUrl(item.project_id)}` : null };
  }
  const caption = plainCaption(item);
  const words = captionWords(caption);
  const when = whenText(item?.captured_at);
  const markup = markupText(item);
  return {
    name: `${words || FOLDER}${when ? ` · ${when}` : ''}.jpg`,
    description: [caption, markup && `Markup: ${markup}`, item?.photo_url && `In CompanyCam: ${item.photo_url}`].filter(Boolean).join('\n').slice(0, 4000) || null,
  };
}
/** The picture's identity without a signed link's changing query */
const imageKey = (item) => {
  if (item?.hash) return `hash:${item.hash}`;
  const u = photoImageUrl(item);
  try { const x = new URL(u); return `${x.host}${x.pathname}`; } catch { return u || null; }
};

// ─── The queue of photos and documents ──────────────────────────────

const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/**
 * Something in a family's project to copy or bring up to date. A photo
 * already copied goes back in the queue (its caption, tags or markup
 * changed); one the site put there from the application never does.
 */
export async function enqueueFile(DB, { kind, id, projectId, accountId, origin = 'companycam', ccUpdated = null }, now = Date.now()) {
  const ccId = `${kind}:${id}`;
  await DB.prepare(`INSERT INTO companycam_files (cc_id, kind, project_id, account_id, origin, state, next_try_at, cc_updated, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(cc_id) DO UPDATE SET
      state = CASE WHEN companycam_files.origin = 'companycam' AND companycam_files.state IN ('copied', 'moved', 'failed') THEN 'pending' ELSE companycam_files.state END,
      dirty = CASE WHEN companycam_files.state = 'working' THEN 1 ELSE companycam_files.dirty END,
      tries = CASE WHEN companycam_files.state = 'failed' THEN 0 ELSE companycam_files.tries END,
      next_try_at = CASE WHEN companycam_files.state IN ('copied', 'moved', 'failed') THEN excluded.next_try_at ELSE companycam_files.next_try_at END,
      updated_at = excluded.updated_at`)
    .bind(ccId, kind, String(projectId), String(accountId), origin, now, ccUpdated, iso(now), iso(now)).run();
  return ccId;
}

async function claimFile(DB, ccId, now) {
  const r = await DB.prepare(`UPDATE companycam_files SET state = 'working', claimed_at = ?, dirty = 0, updated_at = ?
    WHERE cc_id = ? AND ((state IN ('pending', 'failed') AND COALESCE(next_try_at, 0) <= ?) OR (state = 'working' AND COALESCE(claimed_at, 0) < ?))`)
    .bind(now, iso(now), ccId, now, now - CLAIM_STALE_MS).run();
  if (!(r?.meta?.changes > 0)) return null;
  return DB.prepare('SELECT * FROM companycam_files WHERE cc_id = ?').bind(ccId).first();
}

/** Where a file rests when nothing more is owed: on the job, on the customer, or nowhere */
const restingState = (f) => (f.job_file_id ? 'moved' : f.jt_file_id ? 'copied' : 'skipped');

async function finishFile(DB, f, changes, now) {
  const next = { ...f, ...changes };
  const dirty = await DB.prepare('SELECT dirty FROM companycam_files WHERE cc_id = ?').bind(f.cc_id).first('dirty');
  const again = !!dirty && next.state !== 'skipped'; // something changed while it was being copied: once more, now
  await DB.prepare(`UPDATE companycam_files SET state = ?, dirty = 0, jt_file_id = ?, job_file_id = ?, synced = ?, cc_updated = ?, tries = ?, next_try_at = ?,
      claimed_at = NULL, error = ?, copied_at = ?, project_id = ?, account_id = ?, origin = ?, updated_at = ? WHERE cc_id = ?`)
    .bind(again ? 'pending' : next.state, next.jt_file_id ?? null, next.job_file_id ?? null, next.synced ?? null, next.cc_updated ?? null, next.tries ?? 0,
      again ? now : next.next_try_at ?? null, next.error ?? null, next.copied_at ?? null, next.project_id, next.account_id, next.origin, iso(now), f.cc_id).run();
}

/**
 * Copy one queued photo or document to JobTread, or bring its copy up to
 * date. Never throws: a failure waits its turn to try again.
 */
export async function processFile(env, ccId, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const f = await claimFile(DB, ccId, now);
  if (!f) return { ccId, busy: true };
  try {
    return await copyFile(env, f, { fetchImpl, now });
  } catch (e) {
    const tries = (f.tries || 0) + 1;
    await finishFile(DB, f, { state: tries >= ALERT_AFTER_TRIES ? 'failed' : 'pending', tries, next_try_at: now + retryIn(tries), error: errText(e) }, now);
    if (e instanceof CompanyCamError && e.status === 401) await tokenProblem(env, e, now);
    if (tries === ALERT_AFTER_TRIES) await fileProblem(env, f, e, now);
    return { ccId, error: errText(e) };
  }
}

async function copyFile(env, f, { fetchImpl, now }) {
  const { DB } = env;
  const done = (changes) => finishFile(DB, f, { tries: 0, error: null, ...changes }, now).then(() => ({ ccId: f.cc_id, ...changes }));
  if (f.origin !== 'companycam') return done({ state: 'skipped' });
  const fam = await getFamilyRow(DB, f.account_id);
  const ccNum = f.cc_id.split(':')[1];

  // Read it back from CompanyCam: the webhook only said where to look
  let item;
  try {
    item = f.kind === 'photo' ? await getPhoto(env, ccNum, { fetchImpl }) : await getDocument(env, ccNum, { fetchImpl });
  } catch (e) {
    if (e.status === 404) return done({ state: restingState(f) }); // deleted in CompanyCam: a copy already made stays
    throw e;
  }
  if (!item || (item.status && item.status !== 'active')) return done({ state: restingState(f) });
  // One the site put there from the application, whose webhook beat the site's note of it
  if (f.kind === 'photo' && !f.jt_file_id && !f.job_file_id && plainCaption(item) === APP_CAPTION) return done({ state: 'skipped', origin: 'application' });
  // The same picture already in the project: JobTread has it once already
  if (f.kind === 'photo' && item.processing_status === 'duplicate' && !f.jt_file_id && !f.job_file_id) return done({ state: 'skipped', error: 'A duplicate of a photo already in the project' });
  if (f.kind === 'photo' && item.processing_status && !['processed', 'duplicate'].includes(item.processing_status)) {
    if (item.processing_status === 'processing_error') return done({ state: restingState(f), error: 'CompanyCam couldn’t process this photo' });
    return finishFile(DB, f, { state: 'pending', next_try_at: now + NOT_PROCESSED_RETRY_MS }, now).then(() => ({ ccId: f.cc_id, waiting: 'processing' }));
  }

  // Moved to another project since: another family's project takes it over; anywhere else, it stays where it was copied
  let target = fam;
  if (item.project_id && String(item.project_id) !== String(f.project_id)) {
    const other = await rowForProject(DB, item.project_id);
    if (!other || f.jt_file_id || f.job_file_id) return done({ state: restingState(f) });
    target = other;
    f.project_id = other.project_id;
    f.account_id = other.account_id;
  }
  // Before the job (or after a denial) the copy goes on the customer; a job with its own project gets it
  // directly; a job using this project gets it from JobTread's own integration
  const where = ['customer', 'closed', 'selftest'].includes(target?.stage) ? { targetType: 'account', targetId: target.account_id }
    : target?.stage === 'separate' && target.job_id ? { targetType: 'job', targetId: target.job_id } : null;

  const tags = await fileTags(env, fetchImpl, now);
  const { name, description } = copyOf(f.kind, item);
  const tagIds = tagIdsFor(f.kind, item.tags, tags);
  const key = f.kind === 'photo' ? imageKey(item) : null;
  const ccUpdated = item.updated_at ? String(item.updated_at) : null;
  const synced = parseJson(f.synced, null);

  if (!f.jt_file_id && !f.job_file_id) {
    if (!where) return done({ state: 'skipped', cc_updated: ccUpdated });
    const url = f.kind === 'photo' ? photoImageUrl(item) : item.url;
    if (!url) throw new Error('CompanyCam has no file to copy yet');
    const uploadRequestId = await uploadToJobTread(env, url, fetchImpl);
    const fileId = await createJtFile(env, { name, targetType: where.targetType, targetId: where.targetId, uploadRequestId, folder: FOLDER, description, fileTagIds: tagIds }, fetchImpl);
    const onJob = where.targetType === 'job';
    return done({
      state: onJob ? 'moved' : 'copied', jt_file_id: onJob ? null : fileId, job_file_id: onJob ? fileId : null,
      synced: JSON.stringify({ name, description, tagIds, key }), cc_updated: ccUpdated, copied_at: iso(now),
    });
  }

  // Already copied: bring the copy up to date. A job's copy JobTread made is JobTread's to update.
  const fileId = f.jt_file_id || (target?.stage === 'separate' ? f.job_file_id : null);
  if (!fileId || !synced) return done({ state: restingState(f), cc_updated: ccUpdated });
  const input = { id: fileId };
  if ((description || null) !== (synced.description || null)) input.description = description;
  const tagsChanged = tagIds.join() !== (synced.tagIds || []).join();
  if (tagsChanged) {
    // Keep tags someone added in JobTread; trade the ones CompanyCam gave last time for today's
    const current = tagIdsOf(await jtFile(env, fileId, fetchImpl));
    const mine = new Set(synced.tagIds || []);
    input.fileTagIds = [...new Set([...current.filter((t) => !mine.has(t)), ...tagIds])].slice(0, 10);
  }
  // A new picture (markup drawn on it): JobTread shows it as the file's markup and keeps the original
  if (f.kind === 'photo' && key && synced.key && key !== synced.key && markupText(item)) {
    input.annotatedUploadRequestId = await uploadToJobTread(env, photoImageUrl(item), fetchImpl);
  }
  if (Object.keys(input).length > 1) await updateJtFile(env, input, fetchImpl);
  return done({ state: restingState(f), synced: JSON.stringify({ ...synced, description, tagIds, key: key || synced.key }), cc_updated: ccUpdated });
}

// ─── A family's project ─────────────────────────────────────────────

const ABBR = { street: 'st', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', avenue: 'ave', boulevard: 'blvd', circle: 'cir', place: 'pl', parkway: 'pkwy', trail: 'trl', crossing: 'xing', terrace: 'ter', highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };
/** "210 Gold Valley Crossing" and "210 gold valley xing." are the same street */
export const streetKey = (s) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map((w) => ABBR[w] || w).join(' ');

/**
 * The project's name: the family and their year ("Ava Smith (2027)"), in full.
 * (JobTread's 30-character limit is for job names only; shortened names could
 * collide, and CompanyCam treats the same name at the same address as the same project.)
 */
const projectNameFor = (fam) => {
  const name = String(fam.name || 'Makeover family').replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 90);
  return fam.year ? `${name} (${fam.year})` : name;
};

/** Of these CompanyCam projects, the ones any JobTread job uses (any customer's) */
async function projectsWithJobs(env, ids, fetchImpl) {
  const list = [...new Set(ids.map(String))];
  if (!list.length) return new Set();
  const out = await jt(env, { organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, where: ['companycamId', 'in', list] }, nodes: { companycamId: {} } } } }, fetchImpl);
  return new Set((out?.organization?.jobs?.nodes || []).map((j) => String(j.companycamId)));
}

/**
 * A project for the family: one staff already started at their home for this
 * visit, else a new one. { project, how }. Never a project from an earlier
 * makeover: it must be newer than the family's last job (a sibling's room,
 * or their own earlier one) and from the last 180 days.
 */
async function findOrMakeProject(env, fam, { fetchImpl, now }) {
  const taken = new Set(fam.jobs.map((j) => j.companycamId).filter(Boolean));
  // Nor one another family's (two homes on one street line: a duplex, an apartment block)
  const { results: others } = await env.DB.prepare('SELECT project_id FROM companycam_projects WHERE account_id != ? AND project_id IS NOT NULL').bind(fam.id).all();
  for (const r of others || []) taken.add(String(r.project_id));
  const lastJobAt = Math.max(0, ...fam.jobs.map((j) => Date.parse(j.createdAt || '') || 0));
  // Started for them: after they became a customer (and their last job), in the last 180 days
  const since = Math.max(lastJobAt, (Date.parse(fam.createdAt || '') || 0) - DAY, now - ADOPT_WITHIN_MS);
  const thisVisit = (p) => {
    const t = Date.parse(p?.created_at || '');
    return Number.isFinite(t) && t > since && !taken.has(String(p.id));
  };
  const want = streetKey(fam.home.street);
  let found = (await searchProjects(env, fam.home.street, { fetchImpl }))
    .filter((p) => p && !p.archived && p.status !== 'deleted' && streetKey(p.address?.street_address_1) === want && thisVisit(p))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  // Never one a job uses, whoever's job it is (the people who lived there before, a rehearsal at the office)
  if (found.length) {
    const used = await projectsWithJobs(env, found.map((p) => p.id), fetchImpl);
    found = found.filter((p) => !used.has(String(p.id)));
  }
  if (found.length) return { project: found[0], how: 'adopted' };

  const body = {
    name: projectNameFor(fam), street_address_1: fam.home.street, city: fam.home.city, state: fam.home.state,
    postal_code: fam.home.postal, country: fam.home.country || 'US',
  };
  if (fam.home.lat != null && fam.home.lng != null) body.coordinates = { lat: String(fam.home.lat), lon: String(fam.home.lng) };
  const contact = fam.contact?.name ? { name: fam.contact.name, email: fam.contact.email, phone_number: fam.contact.phone } : null;
  const create = async (b) => {
    try {
      return await createProject(env, contact ? { ...b, primary_contact: contact } : b, { fetchImpl });
    } catch (e) {
      if (!(e.status === 422 && contact)) throw e;
      return createProject(env, b, { fetchImpl }); // CompanyCam wants a full contact; the project matters more
    }
  };
  // CompanyCam answers with the project it already has under this name and address (restoring a deleted one)
  const existed = (p) => { const t = Date.parse(p?.created_at || ''); return Number.isFinite(t) && t < now - 10 * MIN; };
  // Never another family's (CompanyCam answers by name and address), an earlier makeover's, or a job's
  const usable = async (p) => !taken.has(String(p.id)) && (!existed(p) || (thisVisit(p) && !(await projectsWithJobs(env, [p.id], fetchImpl)).has(String(p.id))));
  let project = await create(body);
  for (const name of [`${body.name} home visit`, `${body.name} home visit ${String(fam.id).slice(-4)}`]) {
    if (!project?.id || (await usable(project))) break;
    project = await create({ ...body, name });
  }
  if (project?.id && !(await usable(project))) throw new Error('CompanyCam keeps answering with another project at this address');
  if (!project?.id) throw new Error('CompanyCam didn’t make the project');
  // An archived one sends no webhooks: open it again first
  if (project.archived) { await unarchiveProject(env, project.id, { fetchImpl }); project = { ...project, archived: false }; }
  return { project, how: existed(project) ? 'adopted' : 'made' };
}

/** The line in CompanyCam about the makeover, with the way back to JobTread */
export function projectDescription(fam) {
  const what = fam.types.length ? `${fam.types.join(' & ')} makeover` : 'Makeover';
  return `${what}${fam.year ? ` (${fam.year})` : ''}. Home visit photos copy to the family in JobTread: ${jobtreadAccountUrl(fam.id)}`;
}

/** The family's application photos of the space, into their project (once each). Never throws. */
async function addApplicationPhotos(env, row, { fetchImpl, now }) {
  const { DB } = env;
  const have = parseJson(row.app_photos, {});
  if ((have.tries || 0) >= APP_PHOTO_TRIES) return have;
  let files = {};
  try {
    const app = await DB.prepare('SELECT jt_state FROM applications WHERE jt_account_id = ?').bind(row.account_id).first();
    files = parseJson(app?.jt_state, {})?.files || {};
  } catch {
    return have; // a family who didn't apply on the site
  }
  const todo = APPLICATION_PHOTOS.filter((k) => files[k]?.id && !have[k]);
  if (!todo.length) return have;
  try {
    for (const field of todo) {
      const out = await jt(env, { file: { $: { id: files[field].id }, id: {}, name: {}, type: {}, url: {}, createdAt: {} } }, fetchImpl);
      const file = out?.file;
      if (!file?.url) continue;
      const res = await fetchImpl(file.url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`JobTread’s copy of the application photo returned ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const photo = await uploadPhoto(env, row.project_id, {
        bytes, filename: safeName(file.name) || `${field}.jpg`, contentType: file.type || 'image/jpeg',
        capturedAt: file.createdAt || null, description: APP_CAPTION,
      }, { fetchImpl });
      if (photo?.id) {
        have[field] = String(photo.id);
        // Its webhook mustn't copy it back to JobTread, where it came from
        await DB.prepare(`INSERT INTO companycam_files (cc_id, kind, project_id, account_id, origin, state, created_at, updated_at) VALUES (?, 'photo', ?, ?, 'application', 'skipped', ?, ?)
          ON CONFLICT(cc_id) DO UPDATE SET origin = 'application', state = 'skipped', updated_at = excluded.updated_at`)
          .bind(`photo:${photo.id}`, row.project_id, row.account_id, iso(now), iso(now)).run();
      }
    }
    delete have.error;
  } catch (e) {
    have.tries = (have.tries || 0) + 1;
    have.error = errText(e);
  }
  await saveFamily(DB, { account_id: row.account_id, app_photos: JSON.stringify(have) }, now);
  return have;
}

/**
 * The applicant mirror's view of the family (./_applicants.js), or null when
 * they've left it. Throws when the mirror can't be read, so a missing table
 * never looks like every family leaving.
 */
const mirrorOf = (DB, accountId) => DB.prepare('SELECT account_id, name, status, archived_at, job_id FROM applicants WHERE account_id = ?').bind(String(accountId)).first();
const familyName = async (DB, accountId) => (await mirrorOf(DB, accountId).catch(() => null))?.name || 'A family in review';

/** Make (or find) the project for a family in review. Safe to repeat. */
async function startFamily(env, accountId, prior, { fetchImpl, now }) {
  const { DB } = env;
  // Claim it: a fresh row, or one whose wait is over, or one whose last worker died
  const claim = await DB.prepare(`INSERT INTO companycam_projects (account_id, stage, claimed_at, created_at, updated_at) VALUES (?, 'making', ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET stage = 'making', claimed_at = excluded.claimed_at, updated_at = excluded.updated_at
    WHERE (companycam_projects.stage IN ('waiting', 'has-job') AND COALESCE(companycam_projects.next_try_at, 0) <= ?)
       OR (companycam_projects.stage = 'making' AND COALESCE(companycam_projects.claimed_at, 0) < ?)`)
    .bind(String(accountId), now, iso(now), iso(now), now, now - CLAIM_STALE_MS).run();
  if (!(claim?.meta?.changes > 0)) return { id: accountId, busy: true };

  let fam;
  try {
    fam = await readFamily(env, accountId, fetchImpl);
  } catch (e) {
    return waitFamily(env, accountId, prior, 'error', errText(e), null, now);
  }
  if (!fam || fam.archived || fam.status !== 'In Review') {
    await DB.prepare("DELETE FROM companycam_projects WHERE account_id = ? AND stage = 'making'").bind(String(accountId)).run();
    return { id: accountId, moved: fam?.status || 'gone' };
  }
  // Their makeover already has its job (a status nobody moved on): JobTread's integration has it
  const job = existingJob(fam.jobs, fam.year);
  if (job) {
    await saveFamily(DB, { account_id: accountId, stage: 'has-job', job_id: job.id, seen_job_id: job.id, problem: null, detail: null, next_try_at: now + HAS_JOB_RECHECK_MS, claimed_at: null }, now);
    return { id: accountId, hasJob: job.id };
  }
  const h = fam.home;
  if (!h.street || !h.city || !h.state || !h.postal) return waitFamily(env, accountId, prior, 'no-home', null, fam, now);

  let made;
  try {
    made = await findOrMakeProject(env, fam, { fetchImpl, now });
  } catch (e) {
    if (e instanceof CompanyCamError && e.status === 401) await tokenProblem(env, e, now);
    return waitFamily(env, accountId, prior, 'error', errText(e), fam, now);
  }
  const { project, how } = made;
  const row = {
    account_id: fam.id, project_id: String(project.id), project_url: project.project_url || projectUrl(project.id),
    name: cut(project.name || projectNameFor(fam), 200), stage: 'customer', how, problem: null, detail: null, tries: 0,
    next_try_at: null, claimed_at: null, checked_at: now, seen_job_id: null,
  };
  await saveFamily(DB, row, now);

  // The extras: none of them holds up the project
  try {
    const labels = await addProjectLabels(env, row.project_id, [VETTING_LABEL], { fetchImpl });
    const label = labels.find((l) => tagKey(l.display_value || l.value) === tagKey(VETTING_LABEL));
    if (label?.id) await saveFamily(DB, { account_id: fam.id, label_id: String(label.id) }, now);
  } catch (e) {
    console.warn('[companycam] label', e.message);
  }
  if (how === 'made' || !String(project.description || '').trim()) {
    await setProjectDescription(env, row.project_id, projectDescription(fam), { fetchImpl }).catch((e) => console.warn('[companycam] description', e.message));
  }
  await addApplicationPhotos(env, row, { fetchImpl, now });

  await logActivity(DB, fam.id, {
    title: how === 'adopted' ? `CompanyCam: using “${row.name}” for the home visit` : `CompanyCam project ready for the home visit: ${row.name}`,
    body: `Photos taken in it copy to this family in JobTread (Files → ${FOLDER}) and go with them to the job. ${row.project_url}`,
    data: { projectId: row.project_id, url: row.project_url, how },
  }, now);
  if (prior?.problem) await slackResolved(env, `companycam:family:${fam.id}`, slackCard({ icon: '✅', title: `${fam.name}: CompanyCam project ready`, test: isTestFamily(fam.name), lead: 'Home visit photos copy to JobTread now.', buttons: [{ label: 'Open in CompanyCam', url: row.project_url }] }), { summary: 'The project is ready' }).catch(() => null);
  return { id: fam.id, project: row.project_id, how };
}

const FAMILY_PROBLEMS = {
  'no-home': {
    why: 'JobTread doesn’t have a full home address for them (street, city, state and ZIP), and CompanyCam needs one.',
    fix: 'Add their home on their customer page in JobTread. The project follows within a few minutes.',
  },
  error: {
    why: 'CompanyCam or JobTread didn’t take the request.',
    fix: 'Nothing to do yet: the site keeps trying. If it keeps failing, CompanyCam’s key may need replacing (Site → Automations).',
  },
};

async function waitFamily(env, accountId, prior, problem, detail, fam, now) {
  const { DB } = env;
  const tries = (prior?.stage === 'waiting' ? prior.tries || 0 : 0) + 1;
  await saveFamily(DB, { account_id: accountId, stage: 'waiting', problem, detail, tries, next_try_at: now + retryIn(tries), claimed_at: null }, now);
  // Slack hears once a problem has lasted a few tries (a blip clears itself), once per problem
  const alertAt = problem === 'no-home' ? 1 : 4;
  if (tries === alertAt || (prior?.problem && prior.problem !== problem && tries >= alertAt)) {
    const p = FAMILY_PROBLEMS[problem] || FAMILY_PROBLEMS.error;
    const name = fam?.name || (await familyName(DB, accountId));
    await slackIssue(env, `companycam:family:${accountId}`, slackCard({
      icon: '⚠️', title: `${name}: no CompanyCam project yet`, test: isTestFamily(name), lead: p.why,
      facts: detail ? [['What it said', detail]] : [], fix: p.fix, buttons: [{ label: 'Open the family in JobTread', url: jobtreadAccountUrl(accountId) }],
      footer: 'CompanyCam for families in review',
    }), { title: `${name}: CompanyCam project`, kind: 'attention' }).catch(() => null);
    await logActivity(DB, accountId, { title: 'No CompanyCam project yet', body: `${p.why} ${p.fix}`, data: { problem } }, now);
  }
  return { id: accountId, waiting: problem };
}

/** The family moved on to their job: link it to the home-visit project */
async function handOver(env, row, mirror, { fetchImpl, now }) {
  const { DB } = env;
  const fam = await readFamily(env, row.account_id, fetchImpl);
  if (!fam) return { id: row.account_id, skipped: 'not a SOARD customer' };
  // Their makeover's job: one already using this project, else one made since the project (an older job is an earlier makeover)
  const since = Date.parse(row.created_at || '') - DAY;
  const job = fam.jobs.find((j) => j.companycamId === row.project_id)
    || fam.jobs.find((j) => !j.closedOn && Date.parse(j.createdAt || '') >= since);
  if (!job) {
    await saveFamily(DB, { account_id: row.account_id, seen_job_id: mirror?.job_id || null }, now);
    return { id: row.account_id, noJob: true };
  }

  let stage = 'linked';
  let other = null;
  if (job.companycamId && job.companycamId !== row.project_id) {
    // JobTread already started a project for the job. Empty, it gives way; with photos in it, the job keeps it.
    let theirs = null;
    try { theirs = await getProject(env, job.companycamId, { fetchImpl }); } catch (e) { if (e.status !== 404) throw e; }
    other = job.companycamId;
    if (theirs && (theirs.photo_count > 0 || theirs.document_count > 0)) stage = 'separate';
  }
  if (stage === 'linked' && job.companycamId !== row.project_id) {
    try {
      await jt(env, { updateJob: { $: { id: job.id, companycamId: row.project_id } } }, fetchImpl);
      if (other) await archiveProject(env, other, { fetchImpl }).catch((e) => console.warn('[companycam] archive the empty one', e.message));
    } catch (e) {
      // JobTread links a project to one job at most: one already linked elsewhere can't be this job's
      if (!(/JobTread returned 4\d\d/.test(e.message) && /companycam/i.test(e.message))) throw e;
      stage = 'separate';
    }
  }
  if (row.label_id) await removeProjectLabel(env, row.project_id, row.label_id, { fetchImpl }).catch(() => null);
  await saveFamily(DB, { account_id: row.account_id, stage, job_id: job.id, seen_job_id: job.id, other_project_id: other, linked_at: iso(now), label_id: null, problem: null, detail: null }, now);
  await logActivity(DB, row.account_id, stage === 'linked'
    ? { title: `CompanyCam: ${job.name} uses the home-visit project`, body: `JobTread copies its photos to the job, and the home-visit photos move there from the family’s files. ${row.project_url}`, data: { jobId: job.id, projectId: row.project_id } }
    : { title: `CompanyCam: ${job.name} has its own project`, body: `The job already had a CompanyCam project with photos, so it keeps it. The home-visit photos are copied to the job, and new ones in “${row.name}” keep following. ${row.project_url}`, data: { jobId: job.id, projectId: row.project_id, jobProjectId: other } }, now);
  return { id: row.account_id, stage, jobId: job.id };
}

/** Denied or archived: the project is archived (restored if they're back in review) */
async function closeFamily(env, row, why, { fetchImpl, now }) {
  let detail = null;
  try {
    await archiveProject(env, row.project_id, { fetchImpl });
  } catch (e) {
    if (e.status !== 404) detail = e.status === 403 ? 'CompanyCam only lets a manager’s or admin’s key archive projects' : errText(e);
  }
  await saveFamily(env.DB, { account_id: row.account_id, stage: 'closed', detail }, now);
  await logActivity(env.DB, row.account_id, { title: detail ? 'CompanyCam project left open' : 'CompanyCam project archived', body: detail || `The family is ${why}. Their photos stay in JobTread, and the project comes back if they’re in review again.`, data: { projectId: row.project_id } }, now);
  return { id: row.account_id, closed: why };
}

async function reopenFamily(env, row, { fetchImpl, now }) {
  try {
    await unarchiveProject(env, row.project_id, { fetchImpl });
  } catch (e) {
    if (e.status === 404) {
      // Deleted since: start over with a new one
      await env.DB.prepare('DELETE FROM companycam_projects WHERE account_id = ?').bind(row.account_id).run();
      return startFamily(env, row.account_id, null, { fetchImpl, now });
    }
    if (e.status !== 403) throw e;
  }
  await saveFamily(env.DB, { account_id: row.account_id, stage: 'customer', detail: null, checked_at: 0, seen_job_id: null }, now);
  await logActivity(env.DB, row.account_id, { title: 'CompanyCam project open again', body: `The family is in review again. ${row.project_url}`, data: { projectId: row.project_id } }, now);
  return { id: row.account_id, reopened: true };
}

/** One family, brought up to date with JobTread's status and job. Never throws. */
export async function syncFamily(env, accountId, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  try {
    await ensureCompanyCamSchema(DB);
    const row = await getFamilyRow(DB, accountId);
    const mirror = await mirrorOf(DB, accountId);
    const inReview = mirror && !mirror.archived_at && mirror.status === 'In Review';
    if (!row || ['waiting', 'making', 'has-job'].includes(row.stage)) return inReview && customerStage(env) ? await startFamily(env, accountId, row, { fetchImpl, now }) : null;
    if (row.stage === 'closed') return inReview ? await reopenFamily(env, row, { fetchImpl, now }) : null;
    if (row.stage !== 'customer') return null;
    if (!mirror || mirror.archived_at) return await closeFamily(env, row, 'archived in JobTread', { fetchImpl, now });
    if (mirror.status === 'Denied') return await closeFamily(env, row, 'denied', { fetchImpl, now });
    if (mirror.job_id && mirror.job_id !== row.seen_job_id) return await handOver(env, row, mirror, { fetchImpl, now });
    return null;
  } catch (e) {
    if (e instanceof CompanyCamError && e.status === 401) await tokenProblem(env, e, now);
    console.error('[companycam] family', accountId, e.message);
    return { id: accountId, error: errText(e) };
  }
}

/** Families with something to do: in review without a project, or a project whose family moved on */
async function dueFamilies(DB, now, limit, on = true) {
  if (!on) return [];
  try {
    const { results } = await DB.prepare(`
      SELECT a.account_id AS id FROM applicants a LEFT JOIN companycam_projects p ON p.account_id = a.account_id
        WHERE a.archived_at IS NULL AND a.status = 'In Review' AND (p.account_id IS NULL OR p.stage = 'closed'
          OR (p.stage IN ('waiting', 'has-job') AND COALESCE(p.next_try_at, 0) <= ?1) OR (p.stage = 'making' AND COALESCE(p.claimed_at, 0) < ?2))
      UNION
      SELECT p.account_id AS id FROM companycam_projects p LEFT JOIN applicants a ON a.account_id = p.account_id
        WHERE p.stage = 'customer' AND (a.account_id IS NULL OR a.archived_at IS NOT NULL OR a.status = 'Denied'
          OR (COALESCE(a.job_id, '') != '' AND a.job_id != COALESCE(p.seen_job_id, '')))
      LIMIT ?3`).bind(now, now - CLAIM_STALE_MS, limit).all();
    return (results || []).map((r) => r.id);
  } catch {
    return []; // no applicant mirror yet
  }
}

// ─── Moving the home-visit photos to the job ────────────────────────

/** Files on the job by name: Map(name → file) */
async function jobFilesNamed(env, jobId, names, fetchImpl) {
  const out = new Map();
  for (let i = 0; i < names.length; i += 50) {
    const chunk = names.slice(i, i + 50);
    const r = await jt(env, { job: { $: { id: jobId }, files: { $: { size: 100, where: ['name', 'in', chunk] }, nodes: { id: {}, name: {}, folder: {}, fileTags: { $: { size: 10 }, nodes: { id: {} } } } } } }, fetchImpl);
    for (const file of r?.job?.files?.nodes || []) if (!out.has(file.name)) out.set(file.name, file);
  }
  return out;
}

/**
 * Once the job has the home-visit photos, the customer's copies go. JobTread
 * names its copy of CompanyCam photo 123 "CompanyCam 123"; a document keeps
 * its name. Never throws.
 */
export async function moveToJob(env, row, { fetchImpl = fetch, now = Date.now(), deadline = Infinity } = {}) {
  const { DB } = env;
  const moved = [];
  try {
    const linkedAt = Date.parse(row.linked_at || '') || now;
    if (row.stage === 'linked' && now < linkedAt + MOVE_AFTER_MS) return moved;
    const { results } = await DB.prepare("SELECT * FROM companycam_files WHERE account_id = ? AND origin = 'companycam' AND state = 'copied' AND jt_file_id IS NOT NULL ORDER BY created_at LIMIT 40").bind(row.account_id).all();
    const files = results || [];
    if (!files.length || !row.job_id) return moved;
    const nativeName = (f) => (f.kind === 'photo' ? `CompanyCam ${f.cc_id.split(':')[1]}` : parseJson(f.synced, {}).name);
    const theirs = row.stage === 'linked' ? await jobFilesNamed(env, row.job_id, files.map(nativeName).filter(Boolean), fetchImpl) : new Map();
    const tags = await fileTags(env, fetchImpl, now);
    const before = tags.get(tagKey(BEFORE_TAG));
    for (const f of files) {
      if (Date.now() > deadline) break;
      const synced = parseJson(f.synced, {});
      let jobFileId = null;
      const native = theirs.get(nativeName(f));
      if (native) {
        // JobTread's copy: in the same folder, with the same tag
        const have = tagIdsOf(native);
        const input = { id: native.id };
        if (native.folder !== FOLDER) input.folder = FOLDER;
        if (f.kind === 'photo' && before && !have.includes(before) && have.length < 10) input.fileTagIds = [...have, before];
        if (Object.keys(input).length > 1) await updateJtFile(env, input, fetchImpl);
        jobFileId = native.id;
      } else if (row.stage === 'separate' || now >= linkedAt + COPY_OURSELVES_AFTER_MS) {
        jobFileId = await createJtFile(env, { name: synced.name || nativeName(f) || 'CompanyCam photo', targetType: 'job', targetId: row.job_id, copyFromFileId: f.jt_file_id, folder: FOLDER, description: synced.description || null, fileTagIds: synced.tagIds || [] }, fetchImpl);
      } else {
        continue; // JobTread's own copy is on its way
      }
      // The customer's copy goes, unless someone talked about it there
      const ours = await jtFile(env, f.jt_file_id, fetchImpl).catch(() => null);
      const keep = !!ours?.comments?.nodes?.length;
      if (ours && !keep) await deleteJtFile(env, f.jt_file_id, fetchImpl);
      await DB.prepare("UPDATE companycam_files SET state = 'moved', job_file_id = ?, jt_file_id = ?, updated_at = ? WHERE cc_id = ?")
        .bind(jobFileId, keep ? f.jt_file_id : null, iso(now), f.cc_id).run();
      moved.push({ ccId: f.cc_id, jobFileId, kept: keep });
    }
    if (moved.length) {
      const all = await DB.prepare("SELECT count(*) AS n FROM companycam_files WHERE account_id = ? AND origin = 'companycam' AND state = 'copied'").bind(row.account_id).first('n');
      if (!all) await logActivity(DB, row.account_id, { title: 'Home visit photos are on the job', body: `In the job’s files (${FOLDER}). ${jobtreadJobUrl(row.job_id)}`, data: { jobId: row.job_id } }, now);
    }
  } catch (e) {
    console.error('[companycam] move', row.account_id, e.message);
  }
  return moved;
}

// ─── Catching up with CompanyCam ────────────────────────────────────

/**
 * A family's project against what's been copied: anything new or changed
 * since goes in the queue (a webhook CompanyCam never sent, or one the site
 * missed). Never throws.
 */
export async function reconcileProject(env, row, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const queued = [];
  try {
    await DB.prepare('UPDATE companycam_projects SET checked_at = ? WHERE account_id = ?').bind(now, row.account_id).run();
    let photos;
    let documents;
    try {
      [photos, documents] = await Promise.all([projectPhotos(env, row.project_id, { max: 500, fetchImpl }), projectDocuments(env, row.project_id, { max: 200, fetchImpl })]);
    } catch (e) {
      if (e.status === 404) {
        await saveFamily(DB, { account_id: row.account_id, stage: 'gone', detail: 'Deleted in CompanyCam' }, now);
        await logActivity(DB, row.account_id, { title: 'CompanyCam project deleted', body: `“${row.name}” was deleted or merged in CompanyCam. The photos already copied stay in JobTread.`, data: { projectId: row.project_id } }, now);
        return queued;
      }
      throw e;
    }
    const { results } = await DB.prepare('SELECT cc_id, state, cc_updated FROM companycam_files WHERE account_id = ?').bind(row.account_id).all();
    const known = new Map((results || []).map((r) => [r.cc_id, r]));
    const items = [...photos.filter((p) => p?.status !== 'deleted').map((p) => ['photo', p]), ...documents.map((d) => ['document', d])];
    for (const [kind, item] of items) {
      const k = known.get(`${kind}:${item.id}`);
      const changed = k && ['copied', 'moved'].includes(k.state) && item.updated_at && String(item.updated_at) !== String(k.cc_updated || '');
      if (k && !changed) continue;
      queued.push(await enqueueFile(DB, { kind, id: item.id, projectId: row.project_id, accountId: row.account_id }, now));
    }
    if (row.stage === 'customer') await addApplicationPhotos(env, row, { fetchImpl, now });
  } catch (e) {
    if (e instanceof CompanyCamError && e.status === 401) await tokenProblem(env, e, now);
    console.error('[companycam] reconcile', row.account_id, e.message);
  }
  return queued;
}

// ─── The webhook ────────────────────────────────────────────────────

/**
 * Keep the site's webhook in CompanyCam: there, on, with these events, and
 * signed with today's token (a new COMPANYCAM_TOKEN means a new one).
 */
export async function ensureWebhook(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const token = await webhookToken(env);
  const fingerprint = token.slice(0, 16);
  const st = (await getState(DB, 'webhook')) || {};
  const hooks = (await listWebhooks(env, { fetchImpl })).filter((h) => h?.url === WEBHOOK_URL);
  let hook = st.fingerprint === fingerprint ? hooks.find((h) => String(h.id) === String(st.id)) : null;
  // Anything else at the site's address signs with a token the site can't check
  for (const h of hooks) if (h !== hook) await deleteWebhook(env, h.id, { fetchImpl }).catch(() => null);
  let action = 'ok';
  if (!hook) {
    hook = await createWebhook(env, { url: WEBHOOK_URL, scopes: WEBHOOK_SCOPES, token }, { fetchImpl });
    action = st.id ? 'replaced' : 'made';
  } else if (!hook.enabled || [...(hook.scopes || [])].sort().join() !== [...WEBHOOK_SCOPES].sort().join()) {
    // CompanyCam turns a webhook off after too many failed deliveries; the catch-up check filled the gap
    hook = await updateWebhook(env, hook.id, { enabled: 'true', scopes: WEBHOOK_SCOPES }, { fetchImpl }); // a string, as CompanyCam's spec has it
    action = 'turned back on';
  }
  // What CompanyCam last sent and what the site answered, to see why it ever turned the webhook off
  let recent = st.recent || [];
  try {
    recent = (await webhookDeliveries(env, hook.id, { limit: 10, fetchImpl })).map((d) => ({ event: d.event, status: d.response_status, ok: !!d.success, at: d.created_at, error: d.error_message ? String(d.error_message).slice(0, 160) : null }));
  } catch { /* the history is a nice-to-have */ }
  const value = {
    id: String(hook.id), fingerprint, enabled: hook.enabled !== false && hook.enabled !== 'false', checkedAt: iso(now),
    action: action === 'ok' ? st.action || 'made' : action, changedAt: action === 'ok' ? st.changedAt || iso(now) : iso(now),
    turnedBackOn: (st.turnedBackOn || 0) + (action === 'turned back on' ? 1 : 0), recent, failing: recent.filter((d) => !d.ok).length,
  };
  await putState(DB, 'webhook', value, now);
  return { ...value, action };
}

/**
 * What a CompanyCam webhook asks for. Only the ids in it are used: the work
 * that follows reads everything back from CompanyCam. Returns the queued
 * item's id (`ccId`) for the caller to process, or why there's nothing to do.
 */
export async function takeEvent(env, ev, { now = Date.now(), fetchImpl = fetch } = {}) {
  const { DB } = env;
  await ensureCompanyCamSchema(DB);
  const type = String(ev?.event_type || ev?.event || '');
  const payload = ev?.payload && typeof ev.payload === 'object' ? ev.payload : {};
  const kind = type.startsWith('photo.') ? 'photo' : type.startsWith('document.') ? 'document' : type.startsWith('project.') ? 'project' : null;
  if (!kind) return { ignored: 'event' };
  const item = payload[kind] && typeof payload[kind] === 'object' ? payload[kind] : payload;
  // A photo's caption or tag event carries the caption or tag; the photo is its photo_id
  const itemId = String(item?.id ?? (kind === 'photo' ? findKey(payload, 'photo_id') : kind === 'document' ? findKey(payload, 'document_id') : '') ?? '').trim();
  const nested = kind === 'photo' && !payload.photo ? findKey(payload, 'photo_id') : null;
  const id = /^\d{1,20}$/.test(String(nested ?? '')) ? String(nested) : itemId;
  if (!/^\d{1,20}$/.test(id)) {
    await putState(DB, 'webhook-unread', { at: iso(now), type, keys: keysOf(payload) }, now).catch(() => null); // the shape, never the values
    return { ignored: 'no ids' };
  }
  let projectId = String(kind === 'project' ? id : item?.project_id ?? findKey(payload, 'project_id') ?? '').trim();
  if (!/^\d{1,20}$/.test(projectId)) {
    // A body without its project: CompanyCam says where the photo or document is
    try {
      const it = kind === 'photo' ? await getPhoto(env, id, { fetchImpl }) : kind === 'document' ? await getDocument(env, id, { fetchImpl }) : null;
      projectId = String(it?.project_id ?? '').trim();
    } catch { projectId = ''; }
    if (!/^\d{1,20}$/.test(projectId)) return { ignored: 'no ids' };
  }
  // Most events are a job's project, which JobTread's own integration copies
  const fam = await rowForProject(DB, projectId);
  if (!fam || !['customer', 'separate', 'closed', 'selftest'].includes(fam.stage)) return { ignored: 'not a family project' };
  await putState(DB, 'webhook-seen', { at: iso(now), type }, now); // CompanyCam's webhook reaches the site
  if (kind === 'project') {
    await DB.prepare('UPDATE companycam_projects SET checked_at = 0 WHERE account_id = ?').bind(fam.account_id).run(); // the next check looks again
    return { recheck: fam.account_id };
  }
  return { ccId: await enqueueFile(DB, { kind, id, projectId, accountId: fam.account_id }, now) };
}

/** The first value under `key` anywhere in a webhook body (a few levels deep) */
function findKey(o, key, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return null;
  if (o[key] != null && typeof o[key] !== 'object') return o[key];
  for (const v of Object.values(o)) { const f = findKey(v, key, depth + 1); if (f != null) return f; }
  return null;
}
/** A body's shape for the record: its key names, two levels down, never a value */
const keysOf = (o, depth = 0) => (!o || typeof o !== 'object' || depth > 1 ? null
  : Object.fromEntries(Object.keys(o).slice(0, 30).map((k) => [k, typeof o[k] === 'object' && o[k] ? keysOf(o[k], depth + 1) : typeof o[k]])));

// ─── Problems ───────────────────────────────────────────────────────

/** CompanyCam turned the key down: Slack once a day until it works again */
async function tokenProblem(env, e, now) {
  const { DB } = env;
  try {
    const st = (await getState(DB, 'token')) || {};
    const due = !st.bad || !st.alertedAt || Date.parse(st.alertedAt) < now - TOKEN_ALERT_EVERY_MS;
    await putState(DB, 'token', { bad: true, error: errText(e), since: st.bad ? st.since : iso(now), alertedAt: due ? iso(now) : st.alertedAt }, now);
    if (!due) return;
    await slackIssue(env, 'companycam:token', slackCard({
      icon: '⚠️', title: 'CompanyCam turned down the site’s key',
      lead: 'Home visit photos aren’t copying to JobTread, and new families in review aren’t getting projects, until it’s replaced.',
      facts: [['What it said', errText(e)]],
      fix: 'In CompanyCam (as an admin) go to app.companycam.com/access-keys → New Personal Access Token → Read & Write, then paste it in Cloudflare → Pages → soard-site → Settings → Variables and Secrets as COMPANYCAM_TOKEN (Encrypt) and redeploy. Everything missed catches up on its own.',
      buttons: [{ label: 'Make a CompanyCam key', url: 'https://app.companycam.com/access-keys' }],
      footer: 'CompanyCam for families in review',
    }), { title: 'CompanyCam key', kind: 'attention' }).catch(() => null);
  } catch { /* the alert is best-effort */ }
}
async function tokenOk(env, now) {
  const st = await getState(env.DB, 'token');
  if (st?.bad) {
    await slackResolved(env, 'companycam:token', slackCard({ icon: '✅', title: 'CompanyCam takes the site’s key again', lead: 'Home visit photos are copying to JobTread, and anything missed is catching up.' }), { summary: 'The key works' }).catch(() => null);
  }
  if (!st || st.bad) await putState(env.DB, 'token', { bad: false, okAt: iso(now) }, now);
}

async function fileProblem(env, f, e, now) {
  const name = await familyName(env.DB, f.account_id);
  await slackIssue(env, `companycam:family:${f.account_id}`, slackCard({
    icon: '⚠️', title: `${name}: a home visit photo won’t copy to JobTread`, test: isTestFamily(name),
    lead: 'The site has tried for a few hours and keeps trying every 6 hours.',
    facts: [['What it said', errText(e)]],
    fix: 'Usually nothing: it clears itself once JobTread or CompanyCam takes it. If it doesn’t, save the photo from CompanyCam to the family’s files in JobTread by hand.',
    buttons: [{ label: 'Open the family in JobTread', url: jobtreadAccountUrl(f.account_id) }],
    footer: 'CompanyCam for families in review',
  }), { title: `${name}: CompanyCam photos`, kind: 'attention' }).catch(() => null);
}

// ─── The heartbeat ──────────────────────────────────────────────────

/**
 * The heartbeat's call (./broadcast-hooks.js): at most once a minute, the
 * webhook check (hourly), families with something to do, queued photos, the
 * catch-up check, and home-visit photos ready to move to a job. Never throws.
 */
export async function maybeRunCompanyCam(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const { DB } = env;
  try {
    if (!DB || !companycamOn(env) || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureCompanyCamSchema(DB);
    if (!force && !(await takeTurn(DB, 'tick', TICK_EVERY_MS, now))) return null;
    const deadline = Date.now() + BUDGET_MS;
    const out = { families: [], files: [], reconciled: 0, moved: 0 };

    if (force || (await takeTurn(DB, 'webhook-check', WEBHOOK_CHECK_EVERY_MS, now))) {
      try {
        out.webhook = (await ensureWebhook(env, { fetchImpl, now })).action;
        await tokenOk(env, now);
      } catch (e) {
        out.webhook = `error: ${errText(e)}`;
        await putState(DB, 'webhook-error', { error: errText(e), at: iso(now) }, now);
        if (e instanceof CompanyCamError && e.status === 401) await tokenProblem(env, e, now);
        if (e instanceof CompanyCamError && e.status === 401) return out; // nothing else will work either
      }
    }

    for (const id of await dueFamilies(DB, now, PER_TICK.families, customerStage(env))) {
      if (Date.now() > deadline) break;
      const r = await syncFamily(env, id, { fetchImpl, now });
      if (r) out.families.push(r);
    }

    const { results: due } = await DB.prepare("SELECT cc_id FROM companycam_files WHERE (state IN ('pending', 'failed') AND COALESCE(next_try_at, 0) <= ?) OR (state = 'working' AND COALESCE(claimed_at, 0) < ?) ORDER BY next_try_at LIMIT ?")
      .bind(now, now - CLAIM_STALE_MS, PER_TICK.files).all();
    for (const r of due || []) {
      if (Date.now() > deadline) break;
      out.files.push(await processFile(env, r.cc_id, { fetchImpl, now }));
    }

    const { results: stale } = await DB.prepare("SELECT * FROM companycam_projects WHERE stage IN ('customer', 'separate', 'selftest') AND COALESCE(checked_at, 0) <= ? ORDER BY checked_at LIMIT ?")
      .bind(now - RECONCILE_EVERY_MS, PER_TICK.reconcile).all();
    for (const row of stale || []) {
      if (Date.now() > deadline) break;
      out.reconciled += (await reconcileProject(env, row, { fetchImpl, now })).length;
    }

    const { results: moving } = await DB.prepare(`SELECT p.* FROM companycam_projects p WHERE p.stage IN ('linked', 'separate') AND p.job_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM companycam_files f WHERE f.account_id = p.account_id AND f.origin = 'companycam' AND f.state = 'copied') LIMIT ?`).bind(PER_TICK.moves).all();
    for (const row of moving || []) {
      if (Date.now() > deadline) break;
      out.moved += (await moveToJob(env, row, { fetchImpl, now, deadline })).length;
    }

    // Once: the whole path on the real CompanyCam and JobTread, with test things only (below)
    if (Date.now() < deadline && (await getState(DB, 'webhook'))?.enabled) out.selfTest = (await maybeSelfTest(env, { fetchImpl, now }))?.step || null;
    // Then once: two TEST families through the real stages (below)
    if (Date.now() < deadline && (await getState(DB, 'self-test'))?.ok) out.rehearsal = (await maybeRehearsal(env, { fetchImpl, now }))?.step || null;

    await putState(DB, 'last-run', { at: iso(now), families: out.families.length, files: out.files.length, reconciled: out.reconciled, moved: out.moved }, now);
    return out;
  } catch (e) {
    console.error('[companycam]', e.message);
    return null;
  }
}

/** For Site → Automations: is it on, the webhook, the families' projects, and the photos copied */
export async function companycamFacts(env) {
  const { DB } = env;
  if (!companycamOn(env)) return { on: false };
  await ensureCompanyCamSchema(DB);
  const [stages, files, last, failing, webhook, token, lastRun, waiting, seen, check, rehearsal] = await Promise.all([
    DB.prepare('SELECT stage, count(*) AS n FROM companycam_projects GROUP BY stage').all(),
    DB.prepare("SELECT state, count(*) AS n FROM companycam_files WHERE origin = 'companycam' GROUP BY state").all(),
    DB.prepare('SELECT max(copied_at) AS at FROM companycam_files').first('at'),
    DB.prepare("SELECT count(*) AS n FROM companycam_files WHERE state = 'failed'").first('n'),
    getState(DB, 'webhook'),
    getState(DB, 'token'),
    getState(DB, 'last-run'),
    DB.prepare("SELECT count(*) AS n FROM companycam_projects WHERE stage = 'waiting'").first('n'),
    getState(DB, 'webhook-seen'),
    getState(DB, 'self-test'),
    getState(DB, 'rehearsal'),
  ]);
  const by = (rows, k) => Object.fromEntries((rows?.results || []).map((r) => [r[k], r.n]));
  return {
    on: true, projects: by(stages, 'stage'), files: by(files, 'state'), lastCopied: last || null, failing: failing || 0, waiting: waiting || 0,
    webhook: webhook ? { enabled: webhook.enabled, checkedAt: webhook.checkedAt, turnedBackOn: webhook.turnedBackOn || 0, recentFailing: webhook.failing || 0 } : null,
    tokenBad: !!token?.bad, tokenError: token?.bad ? token.error : null, lastRun: lastRun?.at || null, lastWebhook: seen?.at || null,
    rehearsal: rehearsal ? { step: rehearsal.step, ok: rehearsal.ok ?? null, at: rehearsal.at || null, error: rehearsal.error || null } : null,
    selfTest: check ? { step: check.step, ok: check.ok ?? null, at: check.at || check.startedAt || null, error: check.error || null, seconds: check.copied?.seconds ?? null, linkKept: check.job?.linkKept ?? null, imported: check.job?.imported ?? null } : null,
  };
}

// ─── The self-test ──────────────────────────────────────────────────

/**
 * Once, on the first heartbeat with a working key and webhook (again only
 * when SELF_TEST changes): the whole path on the real CompanyCam and
 * JobTread, with test things only, at the office.
 *   1. A TEST project gets one picture (the site's share card), and
 *      CompanyCam's webhook has to bring it to the office account in JobTread
 *      (Home visit, .BeforePics).
 *   2. A caption, and a tag the company already has in CompanyCam, are added
 *      there; both have to follow to the JobTread copy.
 *   3. A TEST job made with the project's id, the way an approval makes it,
 *      shows whether JobTread keeps that link and copies the photo itself.
 *   4. The move: JobTread's copy gets the folder and tag, and the customer's
 *      copy goes.
 * Afterwards the TEST job is closed (like the other rehearsal jobs there)
 * and the test project archived. The result is in companycam_state
 * "self-test" and on Site → Automations. No button.
 */
export const SELF_TEST = '2026-10-21c'; // each run gets a project and a picture of its own (one already in a project is a duplicate: no webhook, and JobTread doesn't copy it)
export const OFFICE_ACCOUNT = '22P3HT8y9dhc'; // "Sunshine Office", where the rehearsal jobs live
const SELF_TEST_JOB = 'TEST CompanyCam check';
const SELF_TEST_CAPTION = 'TEST: the website checking CompanyCam to JobTread. Safe to ignore.';
const SELF_TEST_CAPTION_2 = 'TEST: a caption added later in CompanyCam';
const todayEastern = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(now));

// ─── A picture no one has uploaded before ───────────────────────────
// CompanyCam marks a picture already in the project as a duplicate, sends no
// webhook for it, and JobTread's integration doesn't copy it. So each check
// draws its own: brand yellow with a row of blocks whose colours come from
// the moment it runs. A PNG made here, so no image file lives in the repo.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** A 480×300 PNG: brand yellow, and 12 blocks coloured from `seed` */
export async function testPicture(seed) {
  const W = 480; const H = 300;
  let x = (Number(seed) % 2147483647) || 1;
  const rnd = () => (x = (x * 48271) % 2147483647) / 2147483647;
  const blocks = Array.from({ length: 12 }, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0; // no filter
    for (let i = 0; i < W; i++) {
      const inBand = y >= 120 && y < 180 && i >= 24 && i < 456;
      const [r, g, b] = inBand ? blocks[Math.floor((i - 24) / 36)] : [255, 214, 0];
      raw.set([r, g, b], row + 1 + i * 3);
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, W); v.setUint32(4, H);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', await deflate(raw)), pngChunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function maybeSelfTest(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  let st = await getState(DB, 'self-test');
  if (st?.id === SELF_TEST && st.step === 'done') return null;
  // An earlier check still under way: its TEST job, project and file are tidied first
  if (st && st.id !== SELF_TEST && st.step !== 'done') return finishSelfTest(env, { ...st, error: 'replaced by a newer check' }, { fetchImpl, now });
  if (!st || st.id !== SELF_TEST) st = { id: SELF_TEST, step: 'start', startedAt: iso(now) };
  try {
    if (st.step === 'start') return await selfTestStart(env, st, { fetchImpl, now });
    if (st.step === 'photo') return await selfTestPhoto(env, st, { fetchImpl, now });
    if (st.step === 'update') return await selfTestUpdate(env, st, { fetchImpl, now });
    if (st.step === 'job') return await selfTestJob(env, st, { fetchImpl, now });
    return null;
  } catch (e) {
    return finishSelfTest(env, { ...st, error: errText(e) }, { fetchImpl, now });
  }
}

async function selfTestStart(env, st, { fetchImpl, now }) {
  const { DB } = env;
  const office = await readFamily(env, OFFICE_ACCOUNT, fetchImpl);
  const h = office?.home;
  if (!h?.street || !h.city || !h.state || !h.postal || !office.locationId) throw new Error('The office account has no full address in JobTread');
  // Its own name each run: CompanyCam hands back a project it already has by name and address
  const body = { name: `${SELF_TEST_JOB} ${SELF_TEST}`, street_address_1: h.street, city: h.city, state: h.state, postal_code: h.postal, country: h.country || 'US' };
  if (h.lat != null && h.lng != null) body.coordinates = { lat: String(h.lat), lon: String(h.lng) };
  const project = await createProject(env, body, { fetchImpl });
  if (!project?.id) throw new Error('CompanyCam didn’t make the test project');
  const projectId = String(project.id);
  if (project.archived) await unarchiveProject(env, projectId, { fetchImpl }); // last run's, archived: it sends no webhooks until it's open
  await saveFamily(DB, { account_id: OFFICE_ACCOUNT, project_id: projectId, project_url: project.project_url || projectUrl(projectId), name: body.name, stage: 'selftest', how: 'made', checked_at: now }, now);
  const next = { ...st, step: 'photo', projectId, locationId: office.locationId };
  await putState(DB, 'self-test', next, now); // the project exists: cleaned up even if the photo fails
  const bytes = await testPicture(now);
  const photo = await uploadPhoto(env, projectId, { bytes, filename: `soard-website-check-${now}.png`, contentType: 'image/png', description: SELF_TEST_CAPTION }, { fetchImpl });
  if (!photo?.id) throw new Error('CompanyCam didn’t take the test photo');
  const withPhoto = { ...next, photoId: String(photo.id), photoAt: iso(now) };
  await putState(DB, 'self-test', withPhoto, now);
  return withPhoto;
}

async function selfTestPhoto(env, st, { fetchImpl, now }) {
  const { DB } = env;
  if (!st.photoId) throw new Error('The test photo never reached CompanyCam');
  const f = await DB.prepare('SELECT * FROM companycam_files WHERE cc_id = ?').bind(`photo:${st.photoId}`).first();
  if (!(f?.state === 'copied' && f.jt_file_id)) {
    if (now - Date.parse(st.photoAt) < 20 * MIN) return st; // CompanyCam processes it, then its webhook comes
    return finishSelfTest(env, { ...st, error: f ? `The photo reached the site but not JobTread (${f.state}${f.error ? `: ${f.error}` : ''})` : 'CompanyCam’s webhook never brought the photo' }, { fetchImpl, now });
  }
  const seen = await getState(DB, 'webhook-seen');
  const file = await jtFile(env, f.jt_file_id, fetchImpl);
  const tags = await fileTags(env, fetchImpl, now);
  const before = tags.get(tagKey(BEFORE_TAG));
  const copied = {
    fileId: f.jt_file_id, name: file?.name || null, seconds: Math.max(0, Math.round((Date.parse(f.copied_at) - Date.parse(st.photoAt)) / 1000)),
    byWebhook: !!seen && Date.parse(seen.at) >= Date.parse(st.photoAt), folder: file?.folder === FOLDER, beforeTag: !before || tagIdsOf(file).includes(before),
  };
  // A caption and a tag added in CompanyCam later: a tag the company already has whose name JobTread also has, never a new one
  const ccTag = (await listTags(env, { fetchImpl })).find((t) => { const k = tagKey(t.display_value || t.value); return k && k !== tagKey(BEFORE_TAG) && tags.has(k); }) || null;
  await setPhotoDescription(env, st.photoId, SELF_TEST_CAPTION_2, { fetchImpl });
  if (ccTag) await addPhotoTags(env, st.photoId, [ccTag.display_value || ccTag.value], { fetchImpl });
  const warn = copied.byWebhook ? null : 'CompanyCam’s webhook didn’t bring the photo; the 10-minute check did';
  const next = { ...st, step: 'update', copied, ...(warn ? { warn } : {}), tag: ccTag ? { name: ccTag.display_value || ccTag.value, jtId: tags.get(tagKey(ccTag.display_value || ccTag.value)) } : null, updateAt: iso(now) };
  await putState(DB, 'self-test', next, now);
  return next;
}

async function selfTestUpdate(env, st, { fetchImpl, now }) {
  const { DB } = env;
  const file = await jtFile(env, st.copied.fileId, fetchImpl);
  const fresh = await jt(env, { file: { $: { id: st.copied.fileId }, description: {} } }, fetchImpl).catch(() => null);
  const seen = await getState(DB, 'webhook-seen');
  const updated = {
    via: seen && Date.parse(seen.at) > Date.parse(st.updateAt) ? 'webhook' : 'catch-up',
    caption: String(fresh?.file?.description || '').startsWith(SELF_TEST_CAPTION_2),
    tag: st.tag ? tagIdsOf(file).includes(st.tag.jtId) : null,
    tagsKept: tagIdsOf(file).length > 0,
  };
  if (!(updated.caption && updated.tag !== false) && now - Date.parse(st.updateAt) < 12 * MIN) return st; // its webhooks, or the 10-minute check
  // The job, made with the project's id the way an approval makes it
  const out = await jt(env, { createJob: { $: { locationId: st.locationId, name: SELF_TEST_JOB, companycamId: st.projectId }, createdJob: { id: {} } } }, fetchImpl);
  const jobId = out?.createJob?.createdJob?.id;
  if (!jobId) return finishSelfTest(env, { ...st, updated, error: 'JobTread didn’t make the TEST job' }, { fetchImpl, now });
  const next = { ...st, step: 'job', updated, jobId, jobAt: iso(now) };
  await putState(DB, 'self-test', next, now);
  return next;
}

async function selfTestJob(env, st, { fetchImpl, now }) {
  const { DB } = env;
  const waited = now - Date.parse(st.jobAt);
  if (waited < 3 * MIN) return st;
  const r = await jt(env, { job: { $: { id: st.jobId }, id: {}, companycamId: {}, files: { $: { size: 5, where: ['name', '=', `CompanyCam ${st.photoId}`] }, nodes: { id: {} } } } }, fetchImpl);
  const job = { linkKept: String(r?.job?.companycamId || '') === st.projectId, imported: !!r?.job?.files?.nodes?.length, projectNow: r?.job?.companycamId ? String(r.job.companycamId) : null };
  if (!job.imported && waited < 10 * MIN) return st; // more time for JobTread's own copy
  // The move, exactly as a family's runs once their job has the photos
  let moved = null;
  if (job.imported) {
    const linkedAt = iso(now - MOVE_AFTER_MS - 1000);
    await saveFamily(DB, { account_id: OFFICE_ACCOUNT, stage: 'linked', job_id: st.jobId, linked_at: linkedAt }, now);
    const row = await getFamilyRow(DB, OFFICE_ACCOUNT);
    const done = await moveToJob(env, row, { fetchImpl, now });
    const theirs = r.job.files.nodes[0].id;
    const native = await jtFile(env, theirs, fetchImpl);
    const ours = await jtFile(env, st.copied.fileId, fetchImpl).catch(() => null);
    const before = (await fileTags(env, fetchImpl, now)).get(tagKey(BEFORE_TAG));
    moved = { ran: done.length === 1, folder: native?.folder === FOLDER, beforeTag: !before || tagIdsOf(native).includes(before), customerCopyGone: !ours };
  }
  return finishSelfTest(env, { ...st, job, moved }, { fetchImpl, now });
}

/** Clean up what the check made and keep the result. Never throws. */
async function finishSelfTest(env, st, { fetchImpl, now }) {
  const { DB } = env;
  const tidy = async (what, fn) => { try { await fn(); } catch (e) { console.warn('[companycam] self-test tidy', what, e.message); } };
  if (st.copied?.fileId && !st.moved?.customerCopyGone) await tidy('file', async () => { if (await jtFile(env, st.copied.fileId, fetchImpl)) await deleteJtFile(env, st.copied.fileId, fetchImpl); });
  if (st.jobId) await tidy('job', () => jt(env, { updateJob: { $: { id: st.jobId, closedOn: todayEastern(now) } } }, fetchImpl));
  for (const id of new Set([st.projectId, st.job?.projectNow].filter(Boolean))) await tidy('project', () => archiveProject(env, id, { fetchImpl }));
  // Any test copy an interrupted check left on the office account (a job's copies stay with their closed TEST job)
  await tidy('strays', async () => {
    const out = await jt(env, { account: { $: { id: OFFICE_ACCOUNT }, files: { $: { size: 50, where: ['folder', '=', FOLDER] }, nodes: { id: {}, description: {}, job: { id: {} } } } } }, fetchImpl);
    for (const f of out?.account?.files?.nodes || []) {
      if (!f.job && String(f.description || '').startsWith('TEST: ')) await deleteJtFile(env, f.id, fetchImpl);
    }
  });
  await tidy('rows', async () => {
    await DB.prepare("DELETE FROM companycam_projects WHERE account_id = ? AND stage IN ('selftest', 'linked')").bind(OFFICE_ACCOUNT).run();
    await DB.prepare('DELETE FROM companycam_files WHERE account_id = ?').bind(OFFICE_ACCOUNT).run();
  });
  // What CompanyCam sent the site meanwhile, for anyone reading the result
  let deliveries = null;
  await tidy('deliveries', async () => {
    const hook = await getState(DB, 'webhook');
    if (hook?.id && st.startedAt) deliveries = (await webhookDeliveries(env, hook.id, { since: st.startedAt, limit: 20, fetchImpl })).map((d) => ({ event: d.event, id: d.resource_id, ok: d.success, status: d.response_status, at: d.created_at }));
  });
  st = { ...st, deliveries };
  const ok = !st.error && !!st.copied?.byWebhook && !!st.copied?.folder && !!st.copied?.beforeTag && !!st.updated?.caption && st.updated?.tag !== false
    && !!st.job?.linkKept && !!st.job?.imported && !!st.moved?.ran && !!st.moved?.folder && !!st.moved?.beforeTag && !!st.moved?.customerCopyGone;
  const done = { ...st, step: 'done', ok, at: iso(now) };
  await putState(DB, 'self-test', done, now).catch(() => null);
  console.log('[companycam] self-test', JSON.stringify({ ok, error: st.error || null, copied: st.copied || null, updated: st.updated || null, job: st.job || null, moved: st.moved || null }));
  return done;
}

// ─── The rehearsal ──────────────────────────────────────────────────

/**
 * Once, after the self-test passes (again only when REHEARSAL changes): two
 * TEST families at the office go through the real stages, with the
 * heartbeat doing the work exactly as it does for a family, while this only
 * makes the JobTread changes and checks what followed on the next ticks.
 *   A "TEST CompanyCam Family": In Review → its project (label, line about
 *     the makeover) → a home-visit photo reaches the customer → Denied
 *     archives the project → In Review opens it again → a job made by hand
 *     (JobTread starts an empty project of its own) is switched to the
 *     home-visit project and the empty one archived → the photo moves to
 *     the job.
 *   B "TEST CompanyCam Approved": In Review → its own project (not A's, at
 *     the same address) → Approved → the real approval code makes the job
 *     with the project's id.
 * Status changes go in with the site's own JobTread key, which JobTread's
 * applicant-messages workflow skips, and the families have no email, so no
 * family or staff message goes anywhere. Afterwards the jobs are closed, the
 * projects archived and both TEST customers archived in JobTread. The result
 * is in companycam_state "rehearsal". No button.
 */
export const REHEARSAL = '2026-10-21c'; // c: full names (b's shortened names collided into one project); b: never a job's project
const R_NAMES = { a: 'TEST CompanyCam Family', b: 'TEST CompanyCam Approved' };
const R_CAPTION = 'TEST: a home visit photo for the rehearsal';
const R_WAIT_MS = 20 * MIN;

async function setStatus(env, accountId, status, fetchImpl) {
  await jt(env, { updateAccount: { $: { id: accountId, notify: false, customFieldValues: { [FIELDS.status.id]: status } } } }, fetchImpl);
  await refreshApplicants(env, [accountId], { fetchImpl });
}

async function makeTestFamily(env, name, address, fetchImpl) {
  const made = await jt(env, { createAccount: { $: { organizationId: SOARD_ORG_ID, name, type: 'customer', notify: false, suffixIfNecessary: true, customFieldValues: { [FIELDS.status.id]: 'In Review', [FIELDS.year.id]: '2027', [FIELDS.types.id]: ['Bedroom'] } }, createdAccount: { id: {} } } }, fetchImpl);
  const id = made?.createAccount?.createdAccount?.id;
  if (!id) throw new Error(`JobTread didn’t make ${name}`);
  const loc = await jt(env, { createLocation: { $: { accountId: id, address, name: 'Home' }, createdLocation: { id: {} } } }, fetchImpl);
  const contact = await jt(env, { createContact: { $: { accountId: id, name: 'TEST Parent' }, createdContact: { id: {} } } }, fetchImpl);
  const locationId = loc?.createLocation?.createdLocation?.id;
  await jt(env, { updateAccount: { $: { id, notify: false, primaryLocationId: locationId, primaryContactId: contact?.createContact?.createdContact?.id || null } } }, fetchImpl);
  return { id, locationId };
}

export async function maybeRehearsal(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  let st = await getState(DB, 'rehearsal');
  if (st?.id === REHEARSAL && st.step === 'done') return null;
  if (st && st.id !== REHEARSAL && st.step !== 'done') return finishRehearsal(env, { ...st, error: 'replaced by a newer rehearsal' }, { fetchImpl, now });
  if (!st || st.id !== REHEARSAL) st = { id: REHEARSAL, step: 'start', startedAt: iso(now), checks: {} };
  const save = async (next) => { await putState(DB, 'rehearsal', next, now); return next; };
  const late = (since) => now - Date.parse(since) > R_WAIT_MS;
  try {
    if (st.step === 'start') {
      const office = await readFamily(env, OFFICE_ACCOUNT, fetchImpl);
      const h = office?.home;
      if (!h?.street) throw new Error('The office account has no address in JobTread');
      const address = `${h.street}, ${h.city}, ${h.state} ${h.postal}`;
      const a = await makeTestFamily(env, R_NAMES.a, address, fetchImpl);
      const next = await save({ ...st, step: 'projects', a, stepAt: iso(now) }); // made: cleaned up whatever happens next
      const b = await makeTestFamily(env, R_NAMES.b, address, fetchImpl);
      await refreshApplicants(env, [a.id, b.id], { fetchImpl });
      return save({ ...next, b, stepAt: iso(now) });
    }
    const A = await getFamilyRow(DB, st.a.id);
    const B = st.b ? await getFamilyRow(DB, st.b.id) : null;

    if (st.step === 'projects') {
      // The heartbeat makes both projects
      if (!(A?.stage === 'customer' && B?.stage === 'customer')) {
        if (late(st.stepAt)) return finishRehearsal(env, { ...st, error: `No project: A ${A?.stage || 'none'}${A?.problem ? ` (${A.problem}: ${A.detail})` : ''}, B ${B?.stage || 'none'}${B?.problem ? ` (${B.problem}: ${B.detail})` : ''}` }, { fetchImpl, now });
        return st;
      }
      const pa = await getProject(env, A.project_id, { fetchImpl });
      const la = await projectLabels(env, A.project_id, { fetchImpl }).catch(() => []);
      st.checks.projects = {
        separate: A.project_id !== B.project_id, how: [A.how, B.how],
        label: la.some((l) => tagKey(l.display_value || l.value) === tagKey(VETTING_LABEL)),
        description: String(pa?.description || '').startsWith('Bedroom makeover (2027)'),
        name: pa?.name || null,
      };
      const photo = await uploadPhoto(env, A.project_id, { bytes: await testPicture(now), filename: `soard-rehearsal-${now}.png`, contentType: 'image/png', description: R_CAPTION }, { fetchImpl });
      return save({ ...st, step: 'photo', photoId: String(photo.id), stepAt: iso(now) });
    }

    if (st.step === 'photo') {
      const f = await DB.prepare('SELECT * FROM companycam_files WHERE cc_id = ?').bind(`photo:${st.photoId}`).first();
      if (!(f?.state === 'copied' && f.jt_file_id)) {
        if (late(st.stepAt)) return finishRehearsal(env, { ...st, error: `The home-visit photo never reached JobTread (${f?.state || 'no word from CompanyCam'})` }, { fetchImpl, now });
        return st;
      }
      const file = await jtFile(env, f.jt_file_id, fetchImpl);
      st.checks.photo = { onCustomer: !!file, folder: file?.folder === FOLDER, beforeTag: tagIdsOf(file).includes((await fileTags(env, fetchImpl, now)).get(tagKey(BEFORE_TAG))) };
      await setStatus(env, st.a.id, 'Denied', fetchImpl);
      return save({ ...st, step: 'denied', customerFileId: f.jt_file_id, stepAt: iso(now) });
    }

    if (st.step === 'denied') {
      if (A?.stage !== 'closed') return late(st.stepAt) ? finishRehearsal(env, { ...st, error: `Denied didn’t close the project (${A?.stage})` }, { fetchImpl, now }) : st;
      st.checks.denied = { archived: !!(await getProject(env, A.project_id, { fetchImpl }))?.archived };
      await setStatus(env, st.a.id, 'In Review', fetchImpl);
      return save({ ...st, step: 'reopened', stepAt: iso(now) });
    }

    if (st.step === 'reopened') {
      if (A?.stage !== 'customer') return late(st.stepAt) ? finishRehearsal(env, { ...st, error: `Back in review didn’t open the project (${A?.stage})` }, { fetchImpl, now }) : st;
      st.checks.reopened = { open: (await getProject(env, A.project_id, { fetchImpl }))?.archived === false, same: true };
      // A: a job made by hand, as staff would (no project id: JobTread starts its own)
      const ja = await jt(env, { createJob: { $: { locationId: st.a.locationId, name: `${R_NAMES.a} (2027)`.slice(0, 30) }, createdJob: { id: {} } } }, fetchImpl);
      // B: approved, and the real approval code makes its job
      await setStatus(env, st.b.id, 'Approved', fetchImpl);
      await ensureApprovalSchema(DB);
      // Claimed the way the approval sweep claims a settled approval, then the sweep's own step
      await DB.prepare(`INSERT INTO applicant_approvals (account_id, name, approved_at, state, attempts, claimed_at, updated_at) VALUES (?, ?, ?, 'working', 0, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET state = 'working', claimed_at = excluded.claimed_at, updated_at = excluded.updated_at`).bind(st.b.id, R_NAMES.b, iso(now), now, iso(now)).run();
      const approval = await approveFamily(env, st.b.id, { fetchImpl, now });
      await refreshApplicants(env, [st.a.id, st.b.id], { fetchImpl });
      return save({ ...st, step: 'jobs', jobA: ja?.createJob?.createdJob?.id || null, approval: { jobId: approval?.job?.id || null, waiting: approval?.waiting || null, error: approval?.error || null }, stepAt: iso(now) });
    }

    if (st.step === 'jobs') {
      if (now - Date.parse(st.stepAt) < 2 * MIN) return st; // JobTread starts its own project for A's job within seconds
      await refreshApplicants(env, [st.a.id, st.b.id], { fetchImpl });
      if (!(A?.stage === 'linked' && B?.stage === 'linked')) {
        if (late(st.stepAt)) return finishRehearsal(env, { ...st, error: `The jobs weren’t linked: A ${A?.stage}, B ${B?.stage}` }, { fetchImpl, now });
        return st;
      }
      const read = async (id) => (await jt(env, { job: { $: { id }, id: {}, companycamId: {}, files: { $: { size: 5, where: ['name', '=', `CompanyCam ${st.photoId}`] }, nodes: { id: {} } } } }, fetchImpl))?.job;
      const ja = await read(A.job_id);
      const jb = await read(B.job_id);
      const theirs = A.other_project_id ? await getProject(env, A.other_project_id, { fetchImpl }).catch(() => null) : null;
      const labelsA = await projectLabels(env, A.project_id, { fetchImpl }).catch(() => []);
      st.checks.jobs = {
        approvalLinked: String(jb?.companycamId || '') === B.project_id,
        byHandRelinked: String(ja?.companycamId || '') === A.project_id,
        theirsArchived: A.other_project_id ? !!theirs?.archived : null,
        vettingLabelGone: !labelsA.some((l) => tagKey(l.display_value || l.value) === tagKey(VETTING_LABEL)),
        importedAfterRelink: !!ja?.files?.nodes?.length,
      };
      // The move, as for a family once the job has had its turn (the site copies it itself if JobTread didn't)
      await saveFamily(DB, { account_id: A.account_id, linked_at: iso(now - COPY_OURSELVES_AFTER_MS - MIN) }, now);
      const moved = await moveToJob(env, await getFamilyRow(DB, A.account_id), { fetchImpl, now });
      const ours = await jtFile(env, st.customerFileId, fetchImpl).catch(() => null);
      st.checks.move = { ran: moved.length >= 1, by: st.checks.jobs.importedAfterRelink ? 'JobTread' : 'the site', customerCopyGone: !ours };
      return finishRehearsal(env, st, { fetchImpl, now });
    }
    return null;
  } catch (e) {
    return finishRehearsal(env, { ...st, error: errText(e) }, { fetchImpl, now });
  }
}

/** Tidy everything the rehearsal made and keep the result. Never throws. */
async function finishRehearsal(env, st, { fetchImpl, now }) {
  const { DB } = env;
  const tidy = async (what, fn) => { try { await fn(); } catch (e) { console.warn('[companycam] rehearsal tidy', what, e.message); } };
  const ids = [st.a?.id, st.b?.id].filter(Boolean);
  const rows = [];
  for (const id of ids) rows.push(await getFamilyRow(DB, id).catch(() => null));
  // The rows first, so the heartbeat stops acting for these families
  await tidy('rows', async () => {
    for (const id of ids) {
      await DB.prepare('DELETE FROM companycam_projects WHERE account_id = ?').bind(id).run();
      await DB.prepare('DELETE FROM companycam_files WHERE account_id = ?').bind(id).run();
    }
  });
  for (const r of rows.filter(Boolean)) {
    if (r.job_id) await tidy('job', () => jt(env, { updateJob: { $: { id: r.job_id, closedOn: todayEastern(now) } } }, fetchImpl));
    if (r.how === 'made' && r.project_id) await tidy('project', () => archiveProject(env, r.project_id, { fetchImpl }));
    if (r.other_project_id) await tidy('project', () => archiveProject(env, r.other_project_id, { fetchImpl }));
    if (r.how === 'adopted' && r.project_id) {
      // Someone else's project: only what the rehearsal added comes off
      if (r.label_id) await tidy('label', () => removeProjectLabel(env, r.project_id, r.label_id, { fetchImpl }));
      await tidy('description', async () => {
        const p = await getProject(env, r.project_id, { fetchImpl });
        if (/Home visit photos copy to the family in JobTread/.test(String(p?.description || ''))) await setProjectDescription(env, r.project_id, ' ', { fetchImpl });
      });
      if (r.account_id === st.a?.id && st.photoId) await tidy('photo', () => deletePhoto(env, st.photoId, { fetchImpl })); // its test picture
    }
  }
  if (st.jobA && !rows.some((r) => r?.job_id === st.jobA)) await tidy('job', () => jt(env, { updateJob: { $: { id: st.jobA, closedOn: todayEastern(now) } } }, fetchImpl));
  // A test copy still on a TEST customer, then the customers themselves
  for (const id of ids) {
    await tidy('files', async () => {
      const out = await jt(env, { account: { $: { id }, files: { $: { size: 50, where: ['folder', '=', FOLDER] }, nodes: { id: {}, description: {}, job: { id: {} } } } } }, fetchImpl);
      for (const f of out?.account?.files?.nodes || []) if (!f.job && String(f.description || '').startsWith('TEST: ')) await deleteJtFile(env, f.id, fetchImpl);
    });
    await tidy('account', () => jt(env, { updateAccount: { $: { id, notify: false, archive: true } } }, fetchImpl));
  }
  await tidy('mirror', () => refreshApplicants(env, ids, { fetchImpl }));
  const c = st.checks || {};
  const ok = !st.error && !!c.projects?.separate && !!c.projects?.label && !!c.projects?.description && !!c.photo?.folder && !!c.photo?.beforeTag
    && !!c.denied?.archived && !!c.reopened?.open && !!c.jobs?.approvalLinked && !!c.jobs?.byHandRelinked && c.jobs?.theirsArchived !== false
    && !!c.jobs?.vettingLabelGone && !!c.move?.ran && !!c.move?.customerCopyGone;
  const done = { ...st, step: 'done', ok, at: iso(now) };
  await putState(DB, 'rehearsal', done, now).catch(() => null);
  console.log('[companycam] rehearsal', JSON.stringify({ ok, error: st.error || null, checks: c }));
  return done;
}
