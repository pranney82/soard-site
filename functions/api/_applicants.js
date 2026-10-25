/**
 * Applicants: every makeover family, managed from the site admin
 * ===========================================================================
 * JobTread stays the record. Admin → Applications → Applicants reads it and
 * writes to it; nothing here is the only copy of anything, so work done in
 * JobTread and work done here always agree.
 *
 *  - applicants (D1): a mirror of each applicant account (a customer with a
 *    Status or Makeover Year, or one the site's form made). Its fields, the
 *    contacts, the home and its map point (JobTread geocodes locations) and
 *    where that point sits against the service-area boundary. The board,
 *    list and map read this, not JobTread.
 *  - applicant_activity (D1): what happened to each family, from JobTread's
 *    own event log. Status and field changes, comments (family messages,
 *    email replies, the texts and calls DataX logs), files, contacts, the
 *    home, the makeover job. It records who did it and where (JobTread, the
 *    website, DataX, Zapier). It's read forward from a cursor about every
 *    minute and backfilled once to Jan 2025.
 *  - Actions from the site (status, fields, messaging the family, archive)
 *    go to JobTread first and then refresh the mirror. Families text
 *    SOARD's Quo number; the site doesn't send texts. A
 *    status change sends the same family message a change made in JobTread
 *    would, through the same send-once claim (./_applicant-comms.js).
 *    JobTread's workflow skips the site's own grant, so nothing sends twice.
 *
 * Woken by the application sweep (./_applications.js maybeSweepApplications,
 * on the live hub's heartbeat) and right after the JobTread workflow's
 * /api/applicant-sync call, so a status change in JobTread shows up at once.
 */

import { pave, SOARD_ORG_ID, matchKid, normalizeName } from './_reveals.js';
import { bestPhotoOf, photoUrl } from './_job-covers.js';
import {
  readApplicant, statusMessagePreview, postAccountComment, SITE_GRANT_ID, STATUS_RANK,
  FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE, familyRecipients, greetingNames,
} from './_applicant-comms.js';
import { noteStatus, changeInfo, dontSend, sendNow as sendNowNotify, whenWouldSend, notifyMap, notifyFor, ensureNotifySchema } from './_applicant-notify.js';
import { insidePolygon, milesToEdge } from './_geo.js';
import { alertFamilyReplies, waitingReplies } from './_applicant-replies.js';
import { getLiveForm } from './_application-forms.js';
import { DEFAULT_SERVICE_AREA, toE164 } from './_application-form.js';

export const STATUSES = ['Applied', 'In Review', 'Approved', 'Denied'];

/** The JobTread customer fields staff see and edit here (key → JobTread field) */
export const FIELDS = {
  status: { id: '22P46wDp3NLd', label: 'Status', type: 'option', options: STATUSES },
  year: { id: '22P52xmCz3cx', label: 'Makeover year', type: 'option', options: ['2025', '2026', '2027', '2028', '2029', '2030'] },
  types: { id: '22P5KVgrLeXK', label: 'Makeover type', type: 'multi', options: ['Bedroom', 'Bathroom', 'Therapy Room', 'Ramp'] },
  diagnosis: { id: '22P46st8HNPY', label: 'Diagnosis', type: 'text', long: true },
  birthday: { id: '22P46syd4j6E', label: 'Birthday', type: 'date' },
  gender: { id: '22P4VnkCXPSY', label: 'Gender', type: 'option', options: ['Male', 'Female'] },
  language: { id: '22P46u8a49hk', label: 'Primary language', type: 'option', options: ['English', 'Spanish', 'French', 'Vietnamese', 'Chinese', 'Korean'] },
  verbal: { id: '22PJxPDbM5Rr', label: 'Verbal', type: 'option', options: ['Yes', 'No'], free: true },
  mobile: { id: '22PJxPF6vCpk', label: 'Mobile (walks on their own)', type: 'option', options: ['Yes', 'No'], free: true },
  qualified: { id: '22PKReLAwkRR', label: 'Qualified', type: 'option', options: ['Yes', 'No'] },
  referredBy: { id: '22P4VnmXcjjy', label: 'Referred by', type: 'text' },
  denialReason: { id: '22PJx2jt4Vma', label: 'Denial reason', type: 'text', long: true },
};
const FIELD_APPLICATION_URL = '22P4v2gNtdFR';
const FIELD_LOCATION_COUNTY = '22PK2MzzJD93';
const BY_ID = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [f.id, k]));
// JobTread's event log names custom fields by their display name
const BY_NAME = { Status: 'status', '*Makeover Year': 'year', '*Makeover Type': 'types', Diagnosis: 'diagnosis', Birthday: 'birthday', Gender: 'gender', 'Primary Language': 'language', Verbal: 'verbal', Mobile: 'mobile', Qualified: 'qualified', 'Referred By': 'referredBy', 'Denial Reason': 'denialReason' };
// Bookkeeping fields nobody needs to see in the history
const QUIET_FIELDS = new Set(['Zap Table Record', 'Metadata', '**REQUIRED FIELDS**', 'Application URL']);

export const jobtreadAccountUrl = (id) => `https://app.jobtread.com/customers/${id}`;
export const jobtreadJobUrl = (id) => `https://app.jobtread.com/jobs/${id}`;
export const isAccountId = (s) => /^[A-Za-z0-9]{6,32}$/.test(String(s || ''));

const iso = (t = Date.now()) => new Date(t).toISOString();
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const cut = (s, n) => (s == null ? null : String(s).slice(0, n));

// ─── D1 ─────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS applicants (
    account_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, year TEXT, types TEXT, fields TEXT,
    location_id TEXT, address TEXT, city TEXT, county TEXT, lat REAL, lng REAL, area TEXT, area_miles REAL,
    contact_name TEXT, contact_email TEXT, contact_phone TEXT, contacts TEXT,
    job_id TEXT, job_name TEXT, comms_thread_id TEXT, application_url TEXT,
    created_at TEXT, archived_at TEXT, synced_at TEXT NOT NULL, photo_file_id TEXT, photo_url TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_applicants_status ON applicants(status, year)',
  `CREATE TABLE IF NOT EXISTS applicant_activity (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
    by_name TEXT, source TEXT, title TEXT, body TEXT, data TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_applicant_activity_account ON applicant_activity(account_id, at)',
  'CREATE INDEX IF NOT EXISTS idx_applicant_activity_at ON applicant_activity(at)',
  'CREATE TABLE IF NOT EXISTS applicant_sync (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
export async function ensureApplicantSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  // The child's photo (added Oct 2026) on mirrors made before it
  for (const col of ['photo_file_id', 'photo_url']) {
    try { await DB.prepare(`ALTER TABLE applicants ADD COLUMN ${col} TEXT`).run(); } catch { /* already there */ }
  }
  _ready.add(DB);
}

async function getSync(DB, key) {
  const r = await DB.prepare('SELECT value FROM applicant_sync WHERE key = ?').bind(key).first();
  return r?.value ?? null;
}
async function setSync(DB, key, value, now = Date.now()) {
  await DB.prepare('INSERT INTO applicant_sync (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value == null ? null : String(value), iso(now)).run();
}
/** Take a turn at `key` if its last turn was `everyMs` ago (one isolate at a time) */
async function takeTurn(DB, key, everyMs, now) {
  const next = String(now + everyMs);
  const ins = await DB.prepare('INSERT OR IGNORE INTO applicant_sync (key, value, updated_at) VALUES (?, ?, ?)').bind(key, next, iso(now)).run();
  if (ins?.meta?.changes > 0) return true;
  const upd = await DB.prepare('UPDATE applicant_sync SET value = ?, updated_at = ? WHERE key = ? AND CAST(value AS INTEGER) <= ?').bind(next, iso(now), key, now).run();
  return upd?.meta?.changes > 0;
}

// ─── Reading JobTread ───────────────────────────────────────────────

// JobTread refuses a query whose worst case (page size × every nested
// size, with unsized lists counting as their maximum) is too big: "413
// Request Entity Too Large". So every nested list has a small explicit
// size, and pages are 25 accounts (PAGE). Checked against JobTread itself.
const PAGE = 25;
const PHOTOS = 12;
const CONTACT = {
  id: {}, name: {}, title: {},
  customFieldValues: { $: { size: 2, where: [['customField', 'id'], 'in', [FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE]] }, nodes: { value: {}, customField: { id: {} } } },
};
const ACCOUNT = {
  id: {}, name: {}, type: {}, createdAt: {}, archivedAt: {},
  organization: { id: {} },
  customFieldValues: { $: { size: 25 }, nodes: { value: {}, customField: { id: {} } } },
  primaryContact: { id: {} },
  contacts: { $: { size: 5 }, nodes: CONTACT },
  primaryLocation: {
    id: {}, address: {}, city: {}, county: {}, latitude: {}, longitude: {},
    customFieldValues: { $: { size: 1, where: [['customField', 'id'], '=', FIELD_LOCATION_COUNTY] }, nodes: { value: {} } },
  },
  jobs: { $: { size: 2, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: { id: {}, name: {} } },
  comms: { _: 'comments', $: { size: 1, where: ['name', '=', 'Comms Thread'] }, nodes: { id: {} } },
  // Photos on the account itself (the application's), oldest first; the job's are build photos
  files: {
    $: { size: PHOTOS, where: { and: [['type', 'like', 'image/%'], [['job', 'id'], '=', null]] }, sortBy: [{ field: 'createdAt', order: 'asc' }] },
    nodes: { id: {}, name: {}, type: {}, thumb: { _: 'url', $: { size: 256 } } },
  },
};

// A multi-choice field (Makeover Type) comes back as one value per choice
function values(node) {
  const out = {};
  for (const v of node?.customFieldValues?.nodes || []) {
    const id = v.customField?.id;
    if (!id) continue;
    out[id] = id in out ? [].concat(out[id], v.value) : v.value;
  }
  return out;
}
const contactOf = (c) => {
  const v = values(c);
  return { id: c.id, name: c.name || '', title: c.title || '', email: v[FIELD_CONTACT_EMAIL] || '', phone: v[FIELD_CONTACT_PHONE] || '' };
};
const countyName = (s) => String(s || '').replace(/\s+County$/i, '').trim() || null;
const typesOf = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String);

/** Where a point sits against the boundary: { area, miles } */
export function placeOnArea(lat, lng, polygon) {
  if (lat == null || lng == null || !Array.isArray(polygon) || polygon.length < 3) return { area: 'unknown', miles: null };
  if (insidePolygon([lat, lng], polygon)) return { area: 'inside', miles: 0 };
  return { area: 'outside', miles: Math.round(milesToEdge([lat, lng], polygon) * 10) / 10 };
}

// ─── The child's photo (the avatar) ─────────────────────────────────
//
// What families send with an application lands on the account as files:
// the form attaches "<Child>.jpg", "<Child> Family.jpg" and "Space" photos;
// staff upload Jotform's as "<Name>.jpg" next to "<Name> Family.jpg", or keep
// Jotform's own names ("5f2face<Name>_…" is the child's field, "…family…" the
// family's). Camera names (IMG_0978) could be the child or a room, so they're
// never guessed at; those families keep their initials.

// Words that mean the photo is of someone or something else
const NOT_CHILD = new Set(['family', 'families', 'parents', 'siblings', 'space', 'room', 'rooms', 'bedroom', 'bathroom', 'bath', 'bed', 'kitchen',
  'house', 'home', 'ramp', 'therapy', 'mood', 'board', 'plan', 'plans', 'floor', 'before', 'after', 'site', 'onsite', 'note', 'notes',
  'render', 'rendr', 'design', 'layout', 'logo', 'screenshot', 'scan', 'door', 'doorway', 'hall', 'hallway', 'stair', 'stairs', 'yard',
  'porch', 'closet', 'tub', 'shower', 'toilet', 'sink', 'garage', 'exterior', 'interior', 'existing', 'proposed', 'resume', 'letter', 'map']);
const CAMERA = /^(?:img|dsc|dscn|dcim|pxl|photo|image|screenshot|scan|untitled|companycam|whatsapp|mvimg|pic)[\s_-]*\d/i;
const fileBase = (name) => String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
// Words in a file name, with Jotform's glued ones split ("7d4faceBen_5e81d0" → face, ben)
const fileWords = (name) => fileBase(name).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 1);
const nameWords = (s) => normalizeName(s).split(' ').filter(w => w.length > 2 && !/^(test|and|the|for|jr|sr|iii?)$/.test(w));

/**
 * The child's own photo among an account's files, or null. `names` are the
 * account's and job's names. A name only counts with a reason to believe it's
 * the child: the child's name in it, a "<same> Family" photo beside it, or
 * Jotform's child field.
 */
export function childPhotoFile(files, names = []) {
  const child = new Set(names.flatMap(nameWords));
  const key = (name) => fileWords(name).filter(w => w !== 'family' && w !== 'families').join(' ');
  const besideFamily = new Set((files || []).filter(f => fileWords(f.name).some(w => w === 'family' || w === 'families')).map(f => key(f.name)).filter(Boolean));
  let best = null;
  for (const f of files || []) {
    if (!f?.id || (f.type && !/^image\//.test(f.type)) || CAMERA.test(fileBase(f.name))) continue;
    const words = fileWords(f.name);
    if (!words.length || words.some(w => NOT_CHILD.has(w))) continue;
    const score = (besideFamily.has(words.join(' ')) ? 4 : 0) + (words.some(w => child.has(w)) ? 3 : 0) + (words.includes('face') ? 3 : 0);
    if (score >= 3 && (!best || score > best.score)) best = { score, file: f };
  }
  return best?.file || null;
}

/** Is this JobTread account an applicant? (customer, with a Status or Makeover Year, or made by the form) */
export function isApplicantAccount(a) {
  if (!a || a.type !== 'customer') return false;
  const v = values(a);
  return !!(v[FIELDS.status.id] || v[FIELDS.year.id] || /#applications\//.test(String(v[FIELD_APPLICATION_URL] || '')));
}

/** A mirror row from one JobTread account node */
export function rowFromAccount(a, polygon, now = Date.now()) {
  const v = values(a);
  const fields = {};
  for (const [key, f] of Object.entries(FIELDS)) if (v[f.id] != null && v[f.id] !== '') fields[key] = key === 'types' ? typesOf(v[f.id]) : v[f.id];
  const contacts = (a.contacts?.nodes || []).map(contactOf);
  const primary = contacts.find(c => c.id === a.primaryContact?.id) || contacts[0] || null;
  const loc = a.primaryLocation || null;
  const lat = num(loc?.latitude);
  const lng = num(loc?.longitude);
  const { area, miles } = placeOnArea(lat, lng, polygon);
  const job = a.jobs?.nodes?.[0] || null;
  const photo = childPhotoFile(a.files?.nodes, [a.name, job?.name]);
  return {
    account_id: a.id, name: a.name || '(no name)', status: fields.status || null, year: fields.year || null,
    types: JSON.stringify(fields.types || []), fields: JSON.stringify(fields),
    location_id: loc?.id || null, address: cut(loc?.address, 300), city: cut(loc?.city, 80),
    county: countyName(loc?.county) || countyName(values(loc)[FIELD_LOCATION_COUNTY]), lat, lng, area, area_miles: miles,
    contact_name: cut(primary?.name, 120), contact_email: cut(primary?.email, 200), contact_phone: cut(primary?.phone, 40),
    contacts: JSON.stringify(contacts), job_id: job?.id || null, job_name: cut(job?.name, 200),
    comms_thread_id: a.comms?.nodes?.[0]?.id || null, application_url: cut(v[FIELD_APPLICATION_URL], 300),
    created_at: a.createdAt || null, archived_at: a.archivedAt || null, synced_at: iso(now),
    photo_file_id: photo?.id || null, photo_url: cut(photo?.thumb, 1000),
  };
}

const COLUMNS = ['account_id', 'name', 'status', 'year', 'types', 'fields', 'location_id', 'address', 'city', 'county', 'lat', 'lng', 'area', 'area_miles',
  'contact_name', 'contact_email', 'contact_phone', 'contacts', 'job_id', 'job_name', 'comms_thread_id', 'application_url', 'created_at', 'archived_at', 'synced_at',
  'photo_file_id', 'photo_url'];
const UPSERT = `INSERT INTO applicants (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(account_id) DO UPDATE SET ${COLUMNS.slice(1).map(c => `${c} = excluded.${c}`).join(', ')}`;
const upsert = (DB, row) => DB.prepare(UPSERT).bind(...COLUMNS.map(c => row[c] ?? null));

async function boundary(DB) {
  try {
    const live = await getLiveForm(DB);
    const p = live.definition?.serviceArea?.polygon;
    return Array.isArray(p) && p.length >= 3 ? p : DEFAULT_SERVICE_AREA.polygon;
  } catch {
    return DEFAULT_SERVICE_AREA.polygon;
  }
}

/**
 * Re-read every customer account and rewrite the mirror (about two pages of
 * JobTread for SOARD). Accounts that stopped being applicants, or were
 * deleted in JobTread, leave the mirror.
 */
export async function syncAllApplicants(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureApplicantSchema(DB);
  const polygon = await boundary(DB);
  // Only rows that changed are written (D1 writes are the cost here)
  const { results: current } = await DB.prepare('SELECT * FROM applicants').all();
  const sig = (r) => COLUMNS.filter(c => c !== 'synced_at').map(c => (r[c] ?? null)).join('\u0001');
  const before = new Map((current || []).map(r => [r.account_id, sig(r)]));
  const seen = [];
  let page = null;
  for (let i = 0; i < 40; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        accounts: { $: { size: PAGE, where: ['type', '=', 'customer'], sortBy: [{ field: 'createdAt', order: 'desc' }], ...(page ? { page } : {}) }, nextPage: {}, nodes: ACCOUNT },
      },
    }, fetchImpl);
    const conn = data?.organization?.accounts;
    const rows = (conn?.nodes || []).filter(isApplicantAccount).map(a => rowFromAccount(a, polygon, now));
    const changed = rows.filter(r => before.get(r.account_id) !== sig(r));
    if (changed.length) await DB.batch(changed.map(r => upsert(DB, r)));
    seen.push(...rows.map(r => r.account_id));
    page = conn?.nextPage || null;
    if (!page) break;
  }
  if (seen.length) {
    const { results } = await DB.prepare('SELECT account_id FROM applicants').all();
    const gone = (results || []).map(r => r.account_id).filter(id => !seen.includes(id));
    if (gone.length) await DB.batch(gone.map(id => DB.prepare('DELETE FROM applicants WHERE account_id = ?').bind(id)));
  }
  await setSync(DB, 'full_at', iso(now), now);
  return { applicants: seen.length };
}

/** Re-read some accounts into the mirror (after an event or a site action) */
export async function refreshApplicants(env, ids, { fetchImpl = fetch, now = Date.now() } = {}) {
  const list = [...new Set((ids || []).filter(isAccountId))];
  if (!list.length || !env.DB || !env.JOBTREAD_GRANT_KEY) return 0;
  const { DB } = env;
  await ensureApplicantSchema(DB);
  const polygon = await boundary(DB);
  let n = 0;
  for (let i = 0; i < list.length; i += PAGE) {
    const chunk = list.slice(i, i + PAGE);
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: { $: { id: SOARD_ORG_ID }, accounts: { $: { size: PAGE, where: ['id', 'in', chunk] }, nodes: ACCOUNT } },
    }, fetchImpl);
    const nodes = data?.organization?.accounts?.nodes || [];
    const found = new Set(nodes.map(a => a.id));
    const stmts = nodes.filter(isApplicantAccount).map(a => upsert(DB, rowFromAccount(a, polygon, now)));
    // Gone from JobTread, or no longer an applicant
    for (const id of chunk) if (!found.has(id) || !nodes.find(a => a.id === id && isApplicantAccount(a))) stmts.push(DB.prepare('DELETE FROM applicants WHERE account_id = ?').bind(id));
    if (stmts.length) await DB.batch(stmts);
    n += nodes.length;
  }
  return n;
}

// ─── Activity (JobTread's event log) ────────────────────────────────

const EVENT_TYPES = ['accountCreated', 'accountUpdated', 'commentCreated', 'fileCreated', 'contactCreated', 'contactUpdated', 'locationCreated', 'locationUpdated', 'jobCreated'];
const EVENT_NODE = {
  id: {}, createdAt: {}, type: {}, createdByGrantId: {}, createdByGrantName: {}, createdByUser: { id: {}, name: {}, emailAddress: {} }, data: {},
  account: { _on_account: { id: {}, type: {} } },
};
const BACKFILL_FROM = '2025-01-01T00:00:00Z';

/** Who did it, in words: the person, and where (JobTread, the website, DataX, Zapier) */
function sourceOf(ev) {
  const grant = String(ev.createdByGrantName || '');
  if (ev.createdByGrantId === SITE_GRANT_ID) return 'website';
  if (/zapier/i.test(grant)) return 'zapier';
  if (/datax/i.test(grant)) return 'datax';
  if (/link access/i.test(grant)) return 'family';
  if (/claude/i.test(grant)) return 'claude';
  if (!ev.createdByGrantId) return ev.createdByUser?.name === 'JobTread' ? 'workflow' : 'jobtread';
  return 'jobtread';
}

const show = (v) => (Array.isArray(v) ? v.join(', ') : v == null || v === '' ? 'blank' : String(v));

/**
 * One JobTread event as a history row, or null when it isn't worth showing
 * (job-level comments and files, bookkeeping fields, other account types).
 */
export function activityFromEvent(ev) {
  const accountId = ev.account?.id;
  if (!accountId || ev.account?.type !== 'customer') return null;
  const next = ev.data?.next || {};
  const prev = ev.data?.previous || {};
  const base = { id: ev.id, account_id: accountId, at: ev.createdAt, by_name: ev.createdByUser?.name || null, source: sourceOf(ev) };
  switch (ev.type) {
    case 'accountCreated':
      return { ...base, kind: 'created', title: 'Added to JobTread', body: null, data: null };
    case 'accountUpdated': {
      if ('archivedAt' in next) return { ...base, kind: next.archivedAt ? 'archived' : 'unarchived', title: next.archivedAt ? 'Archived' : 'Unarchived', body: null, data: null };
      if (next.name && prev.name !== undefined) return { ...base, kind: 'renamed', title: `Renamed to ${next.name}`, body: `Was ${prev.name}`, data: null };
      const changes = Object.keys(next.custom || {}).filter(k => !QUIET_FIELDS.has(k)).map(k => ({ field: BY_NAME[k] || k, label: FIELDS[BY_NAME[k]]?.label || k, from: prev.custom?.[k] ?? null, to: next.custom[k] ?? null }));
      if (!changes.length) return null;
      const status = changes.find(c => c.field === 'status');
      if (status) return { ...base, kind: 'status', title: status.to ? `Status: ${status.to}` : 'Status cleared', body: status.from ? `Was ${status.from}` : null, data: JSON.stringify({ from: status.from, to: status.to, others: changes.filter(c => c !== status) }) };
      return { ...base, kind: 'fields', title: changes.length === 1 ? `${changes[0].label} changed` : `${changes.length} details changed`, body: changes.map(c => `${c.label}: ${show(c.to)}`).join('\n').slice(0, 2000), data: JSON.stringify({ changes }) };
    }
    case 'commentCreated': {
      if (next.jobId || (next.targetType && next.targetType !== 'account')) return null;
      const msg = String(next.message || '');
      let kind = 'comment';
      if (next.fromEmailStorageId) kind = 'reply';
      else if (/New (incoming|outgoing) _message_/i.test(msg)) kind = /incoming/i.test(msg) ? 'textIn' : 'textOut';
      else if (/New (incoming|outgoing) _call_/i.test(msg)) kind = 'call';
      else if (next.isVisibleToInternalRoles !== false && base.source === 'family') kind = 'reply';
      // DataX logs lead with the company number; the useful part is after it
      const body = msg.replace(/^Company Number:[^\n]*\n+/i, '').slice(0, 4000);
      return { ...base, kind, title: next.name || null, body, data: JSON.stringify({ commentId: next.id, parentCommentId: next.parentCommentId || null, pinned: !!next.isPinned }) };
    }
    case 'fileCreated':
      if (next.jobId) return null;
      return { ...base, kind: 'file', title: next.name || 'A file', body: null, data: JSON.stringify({ fileId: next.id, type: next.type, size: next.size }) };
    case 'contactCreated':
      return { ...base, kind: 'contact', title: `Contact added: ${next.name || ''}`.trim(), body: [next.title, next.custom?.Email, next.custom?.Phone].filter(Boolean).join(' · ') || null, data: null };
    case 'contactUpdated': {
      const keys = Object.keys(next.custom || {}).concat(['name', 'title'].filter(k => k in next));
      if (!keys.length) return null;
      return { ...base, kind: 'contact', title: 'Contact updated', body: keys.map(k => `${k === 'name' ? 'Name' : k === 'title' ? 'Relationship' : k}: ${show(next.custom?.[k] ?? next[k])}`).join('\n'), data: null };
    }
    case 'locationCreated':
      return { ...base, kind: 'home', title: 'Home added', body: next.formattedAddress || next.address || null, data: null };
    case 'locationUpdated': {
      if (next.address && prev.address !== undefined && next.address !== prev.address && !ev.data?.workflowRun) return { ...base, kind: 'home', title: 'Address changed', body: next.address, data: null };
      const custom = Object.keys(next.custom || {});
      if (!custom.length) return null;
      return { ...base, kind: 'home', title: custom.length === 1 ? `${custom[0]} updated` : 'Home details updated', body: custom.map(k => `${k}: ${show(next.custom[k])}`).join('\n').slice(0, 1000), data: null };
    }
    case 'jobCreated':
      return { ...base, kind: 'job', title: `Makeover job created: ${next.name || ''}`.trim(), body: null, data: JSON.stringify({ jobId: next.id }) };
    default:
      return null;
  }
}

const ACTIVITY_COLS = ['id', 'account_id', 'at', 'kind', 'by_name', 'source', 'title', 'body', 'data'];
const insertActivity = (DB, r) => DB.prepare(`INSERT OR IGNORE INTO applicant_activity (${ACTIVITY_COLS.join(', ')}) VALUES (${ACTIVITY_COLS.map(() => '?').join(', ')})`).bind(...ACTIVITY_COLS.map(c => r[c] ?? null));

async function eventsPage(env, where, order, page, fetchImpl) {
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    organization: {
      $: { id: SOARD_ORG_ID },
      events: { $: { size: 100, where, sortBy: [{ field: 'createdAt', order }], ...(page ? { page } : {}) }, nextPage: {}, nodes: EVENT_NODE },
    },
  }, fetchImpl);
  return data?.organization?.events || {};
}

/**
 * Read JobTread's events since the cursor; store the ones about applicants
 * and refresh the accounts they touched. The first run starts the cursor
 * at "now" and leaves the past to backfillActivity.
 */
export async function syncEvents(env, { fetchImpl = fetch, now = Date.now(), maxPages = 5 } = {}) {
  const { DB } = env;
  await ensureApplicantSchema(DB);
  let cursor = await getSync(DB, 'events_cursor');
  if (!cursor) {
    cursor = iso(now - 5 * 60 * 1000);
    await setSync(DB, 'events_cursor', cursor, now);
    await setSync(DB, 'backfill_before', cursor, now);
  }
  // Family replies alert staff from the first sync that knows how (never ones from before)
  let repliesSince = await getSync(DB, 'replies_since');
  if (!repliesSince) {
    repliesSince = iso(now);
    await setSync(DB, 'replies_since', repliesSince, now);
  }
  const replies = [];
  const portal = [];            // comments that may be a family member writing in JobTread's portal
  const authors = new Map();    // event → who wrote the comment (their email)
  const touched = new Set();
  const statusEvents = new Map(); // account → its latest Status change in this batch
  let stored = 0;
  let page = null;
  let last = cursor;
  for (let i = 0; i < maxPages; i++) {
    const conn = await eventsPage(env, { and: [['createdAt', '>', cursor], ['type', 'in', EVENT_TYPES]] }, 'asc', page, fetchImpl);
    const nodes = conn.nodes || [];
    const rows = nodes.map(activityFromEvent).filter(Boolean);
    if (rows.length) await DB.batch(rows.map(r => insertActivity(DB, r)));
    stored += rows.length;
    replies.push(...rows.filter(r => r.kind === 'reply'));
    for (const ev of nodes) if (ev.type === 'commentCreated' && ev.createdByUser?.emailAddress) authors.set(ev.id, ev.createdByUser.emailAddress);
    portal.push(...rows.filter(r => r.kind === 'comment' && authors.has(r.id)));
    for (const ev of nodes) {
      if (ev.account?.type === 'customer') touched.add(ev.account.id);
      if (ev.createdAt > last) last = ev.createdAt;
      if (ev.type === 'accountUpdated' && ev.account?.type === 'customer' && ev.data?.next?.custom && 'Status' in ev.data.next.custom && ev.createdByGrantId !== SITE_GRANT_ID) statusEvents.set(ev.account.id, ev);
    }
    page = conn.nextPage || null;
    if (!page) break;
  }
  if (last !== cursor) await setSync(DB, 'events_cursor', last, now);
  // Only accounts already known, or new ones that just became applicants
  const ids = [...touched];
  if (ids.length) await refreshApplicants(env, ids, { fetchImpl, now });
  const missed = await catchStatusChanges(env, statusEvents, { fetchImpl, now });
  // Written in JobTread's family portal by one of the family's contacts: a reply too, not an email one
  for (const r of portal) {
    const row = await getApplicantRow(DB, r.account_id);
    const email = String(authors.get(r.id) || '').toLowerCase();
    if (!row || !(row.contacts || []).some(c => String(c.email || '').toLowerCase() === email)) continue;
    await DB.prepare("UPDATE applicant_activity SET kind = 'reply' WHERE id = ?").bind(r.id).run();
    replies.push({ ...r, kind: 'reply' });
  }
  // A family answered a JobTread message: Slack and the staff list hear about it (./_applicant-replies.js)
  const alerts = replies.length ? await alertFamilyReplies(env, replies, { since: repliesSince, getApplicant: (id) => getApplicantRow(DB, id), now }) : null;
  // When JobTread was last read, changes or not (the cursor only moves when something happened)
  await setSync(DB, 'events_checked', iso(now), now);
  return { stored, touched: ids.length, cursor: last, missed, ...(alerts ? { replyAlerts: alerts } : {}) };
}

/**
 * The backup for family emails: a Status change in the event log that the
 * JobTread workflow never told us about (its call failed, or the workflow was
 * off) is scheduled now, exactly as the workflow would have.
 */
async function catchStatusChanges(env, events, { fetchImpl, now }) {
  if (!events.size) return 0;
  const { DB } = env;
  await ensureNotifySchema(DB);
  let n = 0;
  for (const [accountId, ev] of events) {
    const row = await DB.prepare('SELECT status FROM applicant_notify WHERE account_id = ?').bind(accountId).first();
    if (row && row.status === (ev.data.next.custom.Status ?? '')) continue; // already handled
    const applicant = await readApplicant(env, accountId, fetchImpl).catch(() => null);
    if (!applicant || (row && row.status === (applicant.status || ''))) continue;
    const grant = String(ev.createdByGrantName || '');
    await noteStatus(env, applicant, {
      previous: ev.data.previous?.custom?.Status ?? null, at: ev.createdAt,
      by: ev.createdByUser ? { name: ev.createdByUser.name || null, email: ev.createdByUser.emailAddress || null } : null,
      via: /zapier|datax/i.test(grant) ? 'integration' : 'jobtread', fetchImpl, now,
    });
    n++;
  }
  return n;
}

/** One step of the history backfill: newest-first pages before the oldest point read so far */
export async function backfillActivity(env, { fetchImpl = fetch, now = Date.now(), maxPages = 3 } = {}) {
  const { DB } = env;
  await ensureApplicantSchema(DB);
  const before = await getSync(DB, 'backfill_before');
  if (!before || before === 'done') return { done: true };
  let page = await getSync(DB, 'backfill_page');
  let stored = 0;
  let oldest = before;
  for (let i = 0; i < maxPages; i++) {
    const conn = await eventsPage(env, { and: [['createdAt', '<=', before], ['createdAt', '>=', BACKFILL_FROM], ['type', 'in', EVENT_TYPES]] }, 'desc', page, fetchImpl);
    const rows = (conn.nodes || []).map(activityFromEvent).filter(Boolean);
    if (rows.length) await DB.batch(rows.map(r => insertActivity(DB, r)));
    stored += rows.length;
    for (const ev of conn.nodes || []) if (ev.createdAt < oldest) oldest = ev.createdAt;
    page = conn.nextPage || null;
    if (!page) {
      await setSync(DB, 'backfill_before', 'done', now);
      await setSync(DB, 'backfill_page', null, now);
      return { done: true, stored };
    }
  }
  await setSync(DB, 'backfill_page', page, now);
  await setSync(DB, 'backfill_oldest', oldest, now);
  return { done: false, stored, oldest };
}

/**
 * The applicant part of the sweep: new events every run, the history
 * backfill until it's done, and a full re-read every 30 minutes (and on the
 * very first run). Never throws.
 */
/**
 * The sweep's turn at JobTread. force: now, whatever the turns say.
 * catchUp: just the changes since the last look (the admin coming back to
 * the tab), which takes a second or two.
 */
/**
 * Once: history from before the site knew family members also write in
 * JobTread's family portal. A comment there by one of the family's contacts
 * (matched by name; the history keeps no email) becomes a 'reply'. No alerts.
 */
export async function relabelFamilyComments(DB, now = Date.now()) {
  await ensureApplicantSchema(DB);
  if (await getSync(DB, 'family_comments_relabelled')) return 0;
  const { results } = await DB.prepare(`SELECT x.id, x.by_name, a.contacts FROM applicant_activity x JOIN applicants a ON a.account_id = x.account_id
    WHERE x.kind = 'comment' AND x.by_name IS NOT NULL`).all();
  const ids = (results || []).filter(r => parse(r.contacts, []).some(c => c.name && c.name.trim().toLowerCase() === String(r.by_name).trim().toLowerCase())).map(r => r.id);
  for (let i = 0; i < ids.length; i += 50) await DB.batch(ids.slice(i, i + 50).map(id => DB.prepare("UPDATE applicant_activity SET kind = 'reply' WHERE id = ?").bind(id)));
  await setSync(DB, 'family_comments_relabelled', iso(now), now);
  return ids.length;
}

export async function maybeSyncApplicants(env, { fetchImpl = fetch, now = Date.now(), force = false, catchUp = false } = {}) {
  const { DB } = env;
  if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
  const out = {};
  try {
    await ensureApplicantSchema(DB);
    if (!catchUp && (force || await takeTurn(DB, 'full_turn', 30 * 60 * 1000, now))) out.full = await syncAllApplicants(env, { fetchImpl, now });
    if (force || catchUp || await takeTurn(DB, 'events_turn', 50 * 1000, now)) {
      out.events = await syncEvents(env, { fetchImpl, now });
      if (!catchUp) out.backfill = await backfillActivity(env, { fetchImpl, now });
      if (!catchUp) out.relabelled = await relabelFamilyComments(DB, now);
      // JobTread answered: an earlier failure is over
      await DB.prepare("DELETE FROM applicant_sync WHERE key = 'last_error'").run();
    }
  } catch (e) {
    out.error = e.message;
    try { await setSync(DB, 'last_error', `${iso(now)} ${e.message}`.slice(0, 500), now); } catch { /* best effort */ }
  }
  return out;
}

/** Past this, the 2-minute sweep has stopped reaching JobTread */
export const SYNC_STALE_MS = 10 * 60 * 1000;

/**
 * How fresh the mirror is, for the admin. problem is null while all is well,
 * else { reason, since } in plain words, for the one time a person should act.
 */
export async function syncState(DB, now = Date.now()) {
  await ensureApplicantSchema(DB);
  const { results } = await DB.prepare("SELECT key, value, updated_at FROM applicant_sync WHERE key IN ('full_at', 'events_cursor', 'events_checked', 'backfill_before', 'backfill_oldest', 'last_error')").all();
  const m = Object.fromEntries((results || []).map(r => [r.key, r]));
  return {
    fullAt: m.full_at?.value || null,
    eventsThrough: m.events_cursor?.value || null,
    eventsCheckedAt: m.events_checked?.value || m.events_cursor?.updated_at || null,
    historyDone: m.backfill_before?.value === 'done',
    historyBackTo: m.backfill_before?.value === 'done' ? BACKFILL_FROM : (m.backfill_oldest?.value || null),
    lastError: m.last_error?.value || null,
    problem: syncProblem(m, now),
  };
}

function syncProblem(m, now) {
  const err = m.last_error?.value || '';
  if (err) {
    const [since, ...rest] = err.split(' ');
    return { reason: `JobTread didn't answer: ${rest.join(' ') || 'unknown error'}`, since: Number.isFinite(Date.parse(since)) ? since : m.last_error.updated_at || null };
  }
  const checked = m.events_checked?.value || m.events_cursor?.updated_at;
  if (checked && now - Date.parse(checked) > SYNC_STALE_MS) return { reason: 'The automatic check of JobTread has stopped running.', since: checked };
  return null;
}

// ─── Reading the mirror ─────────────────────────────────────────────

function applicantFromRow(r) {
  if (!r) return null;
  const fields = parse(r.fields, {});
  return {
    id: r.account_id, name: r.name, status: r.status || '', year: r.year || '', types: parse(r.types, []), fields,
    address: r.address, city: r.city, county: r.county, lat: r.lat, lng: r.lng, area: r.area || 'unknown', areaMiles: r.area_miles,
    contact: r.contact_name || r.contact_email || r.contact_phone ? { name: r.contact_name, email: r.contact_email, phone: r.contact_phone } : null,
    contacts: parse(r.contacts, []), jobId: r.job_id, jobName: r.job_name, commsThreadId: r.comms_thread_id,
    applicationId: (String(r.application_url || '').match(/#applications\/(app-[0-9a-z-]+)/) || [])[1] || null,
    applicationUrl: r.application_url || null,
    createdAt: r.created_at, archivedAt: r.archived_at, syncedAt: r.synced_at,
    stageAt: r.stage_at || null, lastActivityAt: r.last_at || null, lastActivity: r.last_title || r.last_kind ? { kind: r.last_kind, title: r.last_title, by: r.last_by, source: r.last_source } : null,
    jobtreadUrl: jobtreadAccountUrl(r.account_id), jobUrl: r.job_id ? jobtreadJobUrl(r.job_id) : null,
    // The child's photo from the application, in JobTread (a kid page's photo replaces it: pagePhotos)
    ...(r.photo_url ? { photo: r.photo_url, photoFrom: 'application' } : {}),
  };
}

/**
 * Once the family photos are on the kid's page, its best photo (the Main
 * photo, centered on its focal point) is the family's avatar here too. The
 * page is the one the family's job links to (jobtreadJobId, else the name
 * and year, like the reveal dates and job covers).
 */
async function pagePhotos(DB, list) {
  const linked = list.filter(a => a.jobId && !/^\s*test\b/i.test(a.jobName || a.name || ''));
  if (!linked.length) return;
  // Only the kids one of these jobs could be: its year, or linked to it by id
  const years = [...new Set(linked.map(a => Number((String(a.jobName || '').match(/\((\d{4})\)\s*$/) || [])[1])).filter(Boolean))];
  const jobIds = [...new Set(linked.map(a => a.jobId))].slice(0, 80);
  let kids = [];
  try {
    const { results } = await DB.prepare(`SELECT slug, name, year, data FROM kids WHERE year IN (${years.map(() => '?').join(', ') || 'NULL'})
      OR json_extract(data, '$.jobtreadJobId') IN (${jobIds.map(() => '?').join(', ')})`).bind(...years, ...jobIds).all();
    kids = (results || []).map((row) => {
      const data = parse(row.data, {}) || {};
      return { slug: row.slug, name: data.name || row.name, year: row.year ?? data.year, data };
    });
  } catch { return; /* no kids table (tests) */ }
  if (!kids.length) return;
  // Office test jobs ("TEST <name> (2026)") would match the real kid, so they were left out above
  for (const a of linked) {
    const kid = matchKid(a.jobName, kids, a.jobId);
    if (!kid) continue;
    a.kid = { slug: kid.slug, name: kid.name, draft: kid.data?.publishStatus === 'draft' };
    const best = bestPhotoOf(kid.data);
    if (best) { a.photo = photoUrl(best, 'w=128,h=128,fit=cover', 'q=80'); a.photoFrom = 'page'; }
  }
}

// When it reached its current status, and its latest activity, alongside each row
const LIST_SQL = `SELECT a.*,
  (SELECT MAX(x.at) FROM applicant_activity x WHERE x.account_id = a.account_id AND x.kind = 'status') AS stage_at,
  l.at AS last_at, l.kind AS last_kind, l.title AS last_title, l.by_name AS last_by, l.source AS last_source
  FROM applicants a
  LEFT JOIN applicant_activity l ON l.id = (SELECT y.id FROM applicant_activity y WHERE y.account_id = a.account_id ORDER BY y.at DESC LIMIT 1)`;

/**
 * Every applicant for the board, list and map, with the site's own flags
 * (outside the boundary, possible repeat, Spanish) for those the form made.
 */
export async function listApplicants(DB, { archived = false } = {}) {
  await ensureApplicantSchema(DB);
  const { results } = await DB.prepare(`${LIST_SQL} WHERE ${archived ? '1 = 1' : 'a.archived_at IS NULL'} ORDER BY a.created_at DESC`).all();
  const list = (results || []).map(applicantFromRow);
  // Status emails waiting to go (or a family told something that's no longer true)
  const pending = await notifyMap(DB).catch(() => ({}));
  for (const a of list) if (pending[a.id]) a.notify = pending[a.id];
  // Families who replied and are waiting on us (./_applicant-replies.js)
  const waiting = new Map((await waitingReplies(DB).catch(() => [])).map(w => [w.id, w]));
  for (const a of list) if (waiting.has(a.id)) a.waiting = waiting.get(a.id);
  // The site's application for each (photos, flags), when it came from the form
  try {
    const { results: apps } = await DB.prepare('SELECT id, jt_account_id, lang, jt_state, files, is_test, submitted_at FROM applications WHERE jt_account_id IS NOT NULL AND deleted_at IS NULL').all();
    const byAccount = new Map((apps || []).map(a => [a.jt_account_id, a]));
    for (const a of list) {
      const app = byAccount.get(a.id);
      if (!app) continue;
      const st = parse(app.jt_state, {});
      a.applicationId = app.id;
      a.lang = app.lang || 'en';
      a.isTest = !!app.is_test;
      a.submittedAt = app.submitted_at;
      a.repeat = (st.repeat?.matches || []).map(m => m.name).slice(0, 3);
      // The child's photo from the form, through the admin's file proxy, until JobTread has it too
      if (!a.photo && parse(app.files, {})?.photoChild?.thumbKey) { a.photo = `/api/applications-admin?file=${app.id}&field=photoChild&thumb=1`; a.photoFrom = 'application'; }
    }
  } catch { /* no applications table yet */ }
  await pagePhotos(DB, list);
  return list;
}

export async function getApplicantRow(DB, id) {
  await ensureApplicantSchema(DB);
  const row = applicantFromRow(await DB.prepare(`${LIST_SQL} WHERE a.account_id = ?`).bind(id).first());
  if (row) await pagePhotos(DB, [row]);
  return row;
}

export async function activityFor(DB, id, { limit = 300 } = {}) {
  await ensureApplicantSchema(DB);
  // Rows written in the same moment keep the order they happened in
  const { results } = await DB.prepare('SELECT * FROM applicant_activity WHERE account_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').bind(id, limit).all();
  return (results || []).map(r => ({ id: r.id, at: r.at, kind: r.kind, by: r.by_name, source: r.source, title: r.title, body: r.body, data: parse(r.data, null) }));
}

/** Across everyone, newest first (the admin's "Recent activity") */
export async function recentActivity(DB, { limit = 60, before = null } = {}) {
  await ensureApplicantSchema(DB);
  const { results } = await DB.prepare(`SELECT x.*, a.name AS applicant FROM applicant_activity x JOIN applicants a ON a.account_id = x.account_id
    WHERE ${before ? 'x.at < ?' : '1 = 1'} ORDER BY x.at DESC LIMIT ?`).bind(...(before ? [before, limit] : [limit])).all();
  return (results || []).map(r => ({ id: r.id, accountId: r.account_id, applicant: r.applicant, at: r.at, kind: r.kind, by: r.by_name, source: r.source, title: r.title, body: r.body ? String(r.body).slice(0, 280) : null }));
}

/** A JobTread file as the admin's file viewer takes it (thumb: JobTread's JPEG of a photo, PDF or video) */
const fileOut = (f) => ({
  id: f.id, name: f.name, type: f.type, size: f.size ?? null, at: f.createdAt ?? null, url: f.url || null,
  thumb: /^(image|video)\/|^application\/pdf$/.test(f.type || '') ? f.thumb || null : null,
});

/**
 * One applicant, live from JobTread: the comments thread (family messages,
 * replies, texts, notes) and files, plus the mirror's fields and the
 * history. Also refreshes the mirror row, so opening a family is a sync.
 */
export async function applicantDetail(env, id, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await refreshApplicants(env, [id], { fetchImpl, now }).catch(() => 0);
  const row = await getApplicantRow(DB, id);
  if (!row) return null;
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    account: {
      $: { id },
      comments: {
        $: { size: 100, sortBy: [{ field: 'createdAt', order: 'desc' }] },
        nodes: {
          id: {}, name: {}, message: {}, createdAt: {}, isFromEmail: {}, isPinned: {}, isVisibleToCustomerRoles: {},
          createdByUser: { id: {}, name: {} }, parentComment: { id: {} },
          // Shared with anyone? Who with is read below: membership details here make the query too big for JobTread
          aces: { $: { size: 10 }, nodes: { id: {} } },
          // What a family attached to a message, so the admin can show it (JobTread makes a thumbnail of photos, PDFs and videos)
          files: { $: { size: 10 }, nodes: { id: {}, name: {}, type: {}, size: {}, url: {}, thumb: { _: 'url', $: { size: 600 } } } },
        },
      },
      // The family's own files only. Asking for the newest of everything and dropping the job's afterwards
      // lost a makeover family's application to the job's hundreds of newer photos, receipts and plans.
      files: {
        $: { size: 60, where: [['job', 'id'], '=', null], sortBy: [{ field: 'createdAt', order: 'desc' }] },
        nodes: { id: {}, name: {}, type: {}, size: {}, createdAt: {}, url: {}, thumb: { _: 'url', $: { size: 600 } }, job: { id: {} } },
      },
    },
  }, fetchImpl).catch(() => null);
  const comments = (data?.account?.comments?.nodes || []).map(c => ({
    id: c.id, name: c.name || null, message: c.message || '', at: c.createdAt, fromEmail: !!c.isFromEmail, pinned: !!c.isPinned,
    by: c.createdByUser?.name || null, parentId: c.parentComment?.id || null, files: (c.files?.nodes || []).map(fileOut),
    shared: (c.aces?.nodes || []).length,
  }));
  // Who each shared message went to: shared with the family's contacts means JobTread emailed them
  const recipients = await sharedWith(env, comments.filter(c => c.shared).slice(0, 40).map(c => c.id), fetchImpl);
  for (const c of comments) {
    c.to = recipients.get(c.id) || [];
    delete c.shared;
  }
  const files = (data?.account?.files?.nodes || []).filter(f => !f.job?.id).map(fileOut);
  // Waiting on us: always set (null when answered), so the family's page never shows a stale banner
  row.waiting = (await waitingReplies(DB).catch(() => [])).find(w => w.id === id) || null;
  return { applicant: row, comments, files, activity: await activityFor(DB, id), notify: await notifyFor(DB, id).catch(() => null), live: !!data };
}

/**
 * The family contacts each comment is shared with: Map(commentId → [{ name, email }]).
 * Eight comments a call keeps each query inside JobTread's size limit. A
 * failed read leaves those comments out (the page still shows them).
 */
async function sharedWith(env, ids, fetchImpl) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 8) chunks.push(ids.slice(i, i + 8));
  await Promise.all(chunks.map(async (chunk) => {
    const query = {};
    chunk.forEach((id, i) => {
      query[`c${i}`] = { _: 'comment', $: { id }, aces: { $: { size: 10 }, nodes: { membership: { accountType: {}, user: { name: {}, emailAddress: {} } } } } };
    });
    const data = await pave(env.JOBTREAD_GRANT_KEY, query, fetchImpl).catch(() => null);
    chunk.forEach((id, i) => {
      const nodes = data?.[`c${i}`]?.aces?.nodes;
      if (!nodes) return;
      out.set(id, nodes.filter(x => x.membership?.accountType === 'customer' && x.membership.user?.emailAddress)
        .map(({ membership: { user: u } }) => ({ name: u.name || u.emailAddress, email: u.emailAddress })));
    });
  }));
  return out;
}

// ─── Acting (JobTread first, then the mirror) ───────────────────────

/** "linzi@soardcharity.com" → "Linzi" for notes and the history */
export function adminName(user) {
  const s = String(user || '').trim();
  if (!s || s === 'admin') return 'An admin';
  const local = s.split('@')[0].split(/[._+-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1) : s;
}

async function logSite(DB, accountId, { kind, title, body = null, data = null, user, now }) {
  await ensureApplicantSchema(DB);
  await insertActivity(DB, {
    id: `site:${now}:${Math.random().toString(36).slice(2, 8)}`, account_id: accountId, at: iso(now), kind,
    by_name: adminName(user), source: 'website', title, body, data: data ? JSON.stringify(data) : null,
  }).run();
}

/** The value JobTread takes for one field from what the admin typed or chose */
export function fieldInput(key, value) {
  const f = FIELDS[key];
  if (!f) throw new Error(`Unknown field: ${key}`);
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return null;
  if (f.type === 'multi') {
    const list = (Array.isArray(value) ? value : [value]).map(String).filter(v => f.options.includes(v));
    return list.length ? list : null;
  }
  if (f.type === 'option' && !f.free && !f.options.includes(String(value))) throw new Error(`${f.label} must be one of: ${f.options.join(', ')}`);
  if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`${f.label} must be a date`);
  return String(value).slice(0, f.long ? 4000 : 300);
}

async function updateAccountFields(env, accountId, customFieldValues, fetchImpl) {
  await pave(env.JOBTREAD_GRANT_KEY, { updateAccount: { $: { id: accountId, customFieldValues } } }, fetchImpl);
}

/**
 * Change details other than Status. { key: value } with keys from FIELDS;
 * empty clears. Returns the refreshed applicant.
 */
export async function updateApplicantFields(env, accountId, changes, { user = 'admin', fetchImpl = fetch, now = Date.now() } = {}) {
  const entries = Object.entries(changes || {}).filter(([k]) => k !== 'status' && FIELDS[k]);
  if (!entries.length) throw new Error('Nothing to change');
  const before = await getApplicantRow(env.DB, accountId);
  const input = {};
  for (const [k, v] of entries) input[FIELDS[k].id] = fieldInput(k, v);
  await updateAccountFields(env, accountId, input, fetchImpl);
  await refreshApplicants(env, [accountId], { fetchImpl, now });
  const lines = entries.map(([k, v]) => `${FIELDS[k].label}: ${show(Array.isArray(v) ? v : v || null)}`);
  await logSite(env.DB, accountId, { kind: 'fields', title: entries.length === 1 ? `${FIELDS[entries[0][0]].label} changed` : `${entries.length} details changed`, body: lines.join('\n'), data: { changes: entries.map(([k, v]) => ({ field: k, from: before?.fields?.[k] ?? null, to: v ?? null })) }, user, now });
  return getApplicantRow(env.DB, accountId);
}

/** What changing to `status` would send, for the admin to look at first */
export async function previewStatus(env, accountId, status, { fetchImpl = fetch } = {}) {
  if (!STATUSES.includes(status)) throw new Error('Unknown status');
  const applicant = await readApplicant(env, accountId, fetchImpl);
  if (!applicant) throw new Error('That account isn’t a SOARD customer in JobTread');
  const previous = applicant.status || '';
  const forward = (STATUS_RANK[status] ?? 0) >= (STATUS_RANK[previous] ?? 0);
  const message = forward ? await statusMessagePreview(env, applicant, status) : null;
  return {
    previous, status, forward, message,
    sendAt: message && !message.already ? await whenWouldSend(env, status) : null,
    note: !forward ? 'The family isn’t emailed. If they were already told a later status, the site offers to send them a correction.' : null,
  };
}

/**
 * Move an applicant to a status from the site. Writes JobTread's Status
 * (and the denial reason), then sends what a change in JobTread would send,
 * unless `notify` is false.
 */
export async function setApplicantStatus(env, accountId, status, { notify = true, emailNow = false, denialReason = null, user = 'admin', fetchImpl = fetch, now = Date.now() } = {}) {
  if (!STATUSES.includes(status)) throw new Error('Unknown status');
  const before = await readApplicant(env, accountId, fetchImpl);
  if (!before) throw new Error('That account isn’t a SOARD customer in JobTread');
  const previous = before.status || '';
  const input = { [FIELDS.status.id]: status };
  if (status === 'Denied' && denialReason != null && String(denialReason).trim()) input[FIELDS.denialReason.id] = String(denialReason).trim().slice(0, 4000);
  await updateAccountFields(env, accountId, input, fetchImpl);
  // The family's email follows the same timing as a change made in JobTread (./_applicant-notify.js)
  const name = adminName(user);
  const out = previous === status ? {} : await noteStatus(env, { ...before, status }, { previous, at: new Date(now).toISOString(), by: { name, email: /@/.test(user) ? user : null }, via: 'website', sendingNow: notify && emailNow, fetchImpl, now });
  let email = out.kind ? 'scheduled' : null;
  if (out.kind && !notify) { await dontSend(env, accountId, { user: name, now }); email = 'not sent'; }
  else if (out.kind && emailNow) { const r = await sendNowNotify(env, accountId, { user: name, fetchImpl, now }); email = r.result || 'sent'; }
  await refreshApplicants(env, [accountId], { fetchImpl, now });
  await logSite(env.DB, accountId, {
    kind: 'status', title: `Status: ${status}`,
    // What happens to the family's email is logged on its own line (./_applicant-notify.js)
    body: previous ? `Was ${previous}` : null,
    data: { from: previous || null, to: status, email, dueAt: out.dueAt || null, site: true }, user, now,
  });
  return { previous, status, email, dueAt: out.dueAt || null, applicant: await getApplicantRow(env.DB, accountId) };
}

/**
 * A message to the family from the Qualification Committee: a comment
 * assigned to everyone on the account with an email address, which
 * JobTread emails to each. Replies come back onto the account and show in
 * the thread here. Read fresh from JobTread, so a contact added a minute ago
 * is included.
 *
 * `replyTo` (a comment on this account) answers in that comment's thread,
 * the way staff reply in JobTread: no new subject, and the family gets it
 * as part of the same conversation. JobTread sends a reply to whoever is on
 * the thread (it ignores a reply's own assignees), so that's who it goes to.
 */
export async function messageFamily(env, accountId, { subject, message, replyTo = null, user = 'admin', fetchImpl = fetch, now = Date.now() } = {}) {
  const text = String(message || '').trim();
  if (!text) throw new Error('Write a message first');
  const applicant = await readApplicant(env, accountId, fetchImpl);
  if (!applicant) throw new Error('Unknown applicant');
  const thread = replyTo ? await threadOf(env, accountId, replyTo, fetchImpl) : null;
  if (thread && !thread.to.length) throw new Error('No one in the family is on that conversation in JobTread, so a reply wouldn’t reach them. Send a new message instead.');
  const to = thread ? thread.to : familyRecipients(applicant);
  if (!to.length) throw new Error('This family has no email address in JobTread');
  const commentId = await postAccountComment(env, thread
    ? { accountId, message: text, parentCommentId: thread.id }
    : { accountId, message: text, assignTo: to, name: String(subject || '').trim().slice(0, 128) || 'A message from Sunshine on a Ranney Day' }, fetchImpl);
  const names = greetingNames(to, { fallback: 'the family' });
  await logSite(env.DB, accountId, {
    kind: 'sent', title: thread ? `Replied to ${names}` : `Emailed ${names}`, body: text.slice(0, 4000),
    data: { commentId, to: to.map(p => p.email), subject: thread ? null : subject, ...(thread ? { replyTo: thread.id, thread: thread.name } : {}) }, user, now,
  });
  return { commentId, to, ...(thread ? { thread: { id: thread.id, name: thread.name } } : {}) };
}

/**
 * The thread a comment belongs to (its first message), checked to be on this
 * family's account, with the family members on it (who a reply reaches).
 */
async function threadOf(env, accountId, commentId, fetchImpl) {
  const people = { $: { size: 10 }, nodes: { membership: { accountType: {}, user: { name: {}, emailAddress: {} } } } };
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    comment: { $: { id: commentId }, id: {}, name: {}, account: { id: {} }, aces: people, parentComment: { id: {}, name: {}, aces: people } },
  }, fetchImpl);
  const c = data?.comment;
  if (!c || c.account?.id !== accountId) throw new Error('That message isn’t on this family’s account');
  const root = c.parentComment?.id ? c.parentComment : c;
  const to = (root.aces?.nodes || []).filter(x => x.membership?.accountType === 'customer' && x.membership.user?.emailAddress)
    .map(({ membership: { user: u } }) => ({ name: u.name || u.emailAddress, email: u.emailAddress }));
  return { id: root.id, name: root.name || null, to };
}

/** A family's reply needs no answer (a "thanks"): they stop waiting on us. Site only; nothing goes to JobTread */
export async function markReplyHandled(env, accountId, { user = 'admin', now = Date.now() } = {}) {
  await logSite(env.DB, accountId, { kind: 'handled', title: 'No reply needed', user, now });
  return getApplicantRow(env.DB, accountId);
}

/** Archive (or bring back) the account in JobTread */
export async function archiveApplicant(env, accountId, { archive = true, user = 'admin', fetchImpl = fetch, now = Date.now() } = {}) {
  await pave(env.JOBTREAD_GRANT_KEY, { updateAccount: { $: { id: accountId, archive: !!archive } } }, fetchImpl);
  await refreshApplicants(env, [accountId], { fetchImpl, now });
  await logSite(env.DB, accountId, { kind: archive ? 'archived' : 'unarchived', title: archive ? 'Archived' : 'Unarchived', user, now });
  return getApplicantRow(env.DB, accountId);
}

/** Change the service-area point for everyone after the boundary moves (no JobTread calls) */
export async function replaceBoundary(DB, polygon) {
  await ensureApplicantSchema(DB);
  const { results } = await DB.prepare('SELECT account_id, lat, lng FROM applicants').all();
  const stmts = (results || []).map(r => {
    const { area, miles } = placeOnArea(r.lat, r.lng, polygon);
    return DB.prepare('UPDATE applicants SET area = ?, area_miles = ? WHERE account_id = ?').bind(area, miles, r.account_id);
  });
  for (let i = 0; i < stmts.length; i += 50) await DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}
