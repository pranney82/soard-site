/**
 * The board: its meetings, documents and files, and what the board page shows
 * ===========================================================================
 * Everything here is private: its own D1 tables and files under board/ in R2
 * (BOARD_FILES when bound, else FILES; the public /files/ route and the files
 * subdomain serve only financials/, advisory/ and live/). Nothing reaches
 * site_config, the build or the public GitHub repo. The rules for a meeting
 * record are in public/admin/board-shared.js.
 *
 * Tables:
 *   board_meetings      id, date, data (the meeting without its files)
 *   board_files         one row per stored file: its R2 key and what owns it
 *                       (a meeting or a document), staff_only
 *   board_action_state  done or not, by action id (an action carried onto a
 *                       later agenda keeps its id, so done is done everywhere)
 *   board_rsvps         a member's answer for a meeting
 *   board_docs          the document library (bylaws, policies, budgets...)
 *   board_signatures    "I've read it" for a document, per member per year
 *   board_seen          a member's last visit to the board page
 *   board_cash          the bank balance, one row per month (the heartbeat)
 *   board_state         settings and caches (./_board-roles.js)
 *
 * Who sees what (./_board-roles.js): the Board area's admins see and change
 * everything; a board member sees shared meetings without Peter and Holly's
 * own notes or staff-only files, ticks off their own action items, answers
 * whether they'll come, and signs documents.
 */

import {
  cleanMeeting, forBoard, meetingName, openActions, nextMeeting, todayEastern, isDate, uid, emailOutline,
  longDate, timeRange, shortDate, DOC_KINDS, FILE_KINDS, RSVP, DEFAULT_TEMPLATE, newMeeting, LIMITS,
} from '../../public/admin/board-shared.js';
import { comparePeople, photoUrl } from '../../public/admin/team-shared.js';
import { reachedCount } from '../../public/admin/community-shared.js';
import { peopleRows, privateEmails, activeBoard, boardAdmins, readState, writeState, readSettings, normEmail, BOARD_PAGE } from './_board-roles.js';
import { cachedReveals, fetchJobs, loadKids, matchKid, isRehearsalJob, FIELD_JOB_STATUS, BUILDING_STATUSES } from './_reveals.js';
import { sendEmails, emailConfigured, EMAIL_FROM } from './_broadcast-notify.js';
import { emailShell, button, esc, facts } from './_email-shell.js';
import { sniffType } from './upload-file.js';
import { maybeSyncBoardAccess } from './_board-access.js';
import { maybeSyncBoardCalendar, calendarStatus } from './_board-calendar.js';
import { mercury } from './_mercury.js';

export const SITE = 'https://sunshineonaranneyday.com';
export const boardFiles = (env) => env?.BOARD_FILES || env?.FILES || null;
export const MAX_FILE = 50 * 1024 * 1024;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS board_meetings (id TEXT PRIMARY KEY, date TEXT, data TEXT NOT NULL, updated_at TEXT, updated_by TEXT)',
  `CREATE TABLE IF NOT EXISTS board_files (id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, r2_key TEXT NOT NULL,
    name TEXT, type TEXT, size INTEGER, kind TEXT, staff_only INTEGER DEFAULT 0, at TEXT, by TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_board_files_owner ON board_files(owner_type, owner_id)',
  'CREATE TABLE IF NOT EXISTS board_action_state (action_id TEXT PRIMARY KEY, done INTEGER NOT NULL, done_on TEXT, by TEXT)',
  'CREATE TABLE IF NOT EXISTS board_rsvps (meeting_id TEXT NOT NULL, slug TEXT NOT NULL, answer TEXT NOT NULL, at TEXT, PRIMARY KEY (meeting_id, slug))',
  'CREATE TABLE IF NOT EXISTS board_docs (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE IF NOT EXISTS board_signatures (doc_id TEXT NOT NULL, slug TEXT NOT NULL, year INTEGER NOT NULL, name TEXT, at TEXT, PRIMARY KEY (doc_id, slug, year))',
  'CREATE TABLE IF NOT EXISTS board_seen (slug TEXT PRIMARY KEY, at TEXT)',
  'CREATE TABLE IF NOT EXISTS board_cash (month TEXT PRIMARY KEY, total REAL, accounts TEXT, at TEXT)',
];
const _ready = new WeakSet();
export async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  for (const s of SCHEMA) await DB.prepare(s).run();
  _ready.add(DB);
}

const nowIso = () => new Date().toISOString();
const parse = (s, fallback = {}) => { try { return JSON.parse(s || '') ?? fallback; } catch { return fallback; } };
export const ID = /^[a-z0-9_]{3,40}$/i;

// ─── Settings ───────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = Object.freeze({ quorum: 0, defaults: { start: '08:00', end: '10:00', location: '', address: '', video: '' }, template: DEFAULT_TEMPLATE });

/** Settings with every default filled in, and who can open the Board area */
export async function getSettings(DB) {
  const s = await readSettings(DB);
  return {
    quorum: Number(s.quorum) > 0 ? Math.round(s.quorum) : 0,
    defaults: { ...DEFAULT_SETTINGS.defaults, ...(s.defaults || {}) },
    template: Array.isArray(s.template) && s.template.length ? s.template : DEFAULT_TEMPLATE,
    admins: await boardAdmins(DB, s),
    adminsSaved: Array.isArray(s.admins) && s.admins.length > 0,
  };
}

/** Save Settings (admins, quorum, meeting defaults, the agenda template). Keeps at least the person saving as an admin. */
export async function saveSettings(DB, patch, by) {
  const s = await readSettings(DB);
  const next = { ...s };
  if (Array.isArray(patch.admins)) {
    const list = [...new Set(patch.admins.map(normEmail).filter((e) => /^[^\s@]+@soardcharity\.com$/.test(e)))];
    if (!list.includes(normEmail(by))) list.unshift(normEmail(by));
    next.admins = list.slice(0, 10);
  }
  if (patch.quorum !== undefined) next.quorum = Math.max(0, Math.min(50, Math.round(Number(patch.quorum) || 0)));
  if (patch.defaults) {
    const clean = cleanMeeting({ ...patch.defaults, date: '2026-01-01' });
    next.defaults = { start: clean.start, end: clean.end, location: clean.location, address: clean.address, video: clean.video };
  }
  if (Array.isArray(patch.template)) {
    next.template = cleanMeeting({ sections: patch.template }).sections
      .map((sec) => ({ title: sec.title, items: sec.items.filter((it) => it.title).map((it) => ({ title: it.title, ...(it.presenter ? { presenter: it.presenter } : {}), ...(it.live ? { live: it.live } : {}) })) }))
      .filter((sec) => sec.title);
  }
  await writeState(DB, 'settings', next);
  return getSettings(DB);
}

// ─── People, as the board page shows them ───────────────────────────

/** The board, staff and Advisory Board for the board page and the admin's pickers */
export async function roster(DB, { withEmails = false } = {}) {
  const [people, emails] = await Promise.all([peopleRows(DB), withEmails ? privateEmails(DB) : {}]);
  const card = (p) => ({
    slug: p.slug, name: p.name, title: p.title || '', seat: p.seat || '', organization: p.organization || '',
    committees: Array.isArray(p.committees) ? p.committees : [], photo: p.photo ? photoUrl(p, 160) : '', since: p.since || null,
    ...(withEmails ? { email: emails[p.slug] || null } : {}),
  });
  const active = people.filter((p) => p.status === 'active' && !p.draft).sort(comparePeople);
  return {
    board: active.filter((p) => p.group === 'board').map(card),
    staff: active.filter((p) => p.group !== 'board' && p.group !== 'advisory' && p.role !== 'honorary').map(card),
    advisory: active.filter((p) => p.group === 'advisory').map(card),
  };
}

// ─── Meetings ───────────────────────────────────────────────────────

async function filesOf(DB, type, ids = null) {
  const rows = (await DB.prepare('SELECT * FROM board_files WHERE owner_type = ? ORDER BY at').bind(type).all()).results || [];
  const by = {};
  for (const r of rows) {
    if (ids && !ids.includes(r.owner_id)) continue;
    (by[r.owner_id] ||= []).push({ id: r.id, name: r.name, type: r.type, size: r.size || 0, kind: r.kind || 'other', staffOnly: !!r.staff_only, at: r.at });
  }
  return by;
}

/** Meetings with what lives beside them: their files, each action's done state, each member's answer */
async function withState(DB, meetings) {
  if (!meetings.length) return [];
  const [files, done, rsvps] = await Promise.all([
    filesOf(DB, 'meeting'),
    DB.prepare('SELECT * FROM board_action_state').all().then((r) => Object.fromEntries((r.results || []).map((x) => [x.action_id, x]))),
    DB.prepare('SELECT * FROM board_rsvps').all().then((r) => r.results || []),
  ]);
  return meetings.map((m) => {
    const answers = Object.fromEntries(rsvps.filter((r) => r.meeting_id === m.id).map((r) => [r.slug, r.answer]));
    return cleanMeeting({
      ...m,
      files: files[m.id] || [],
      actions: m.actions.map((a) => (done[a.id] ? { ...a, done: !!done[a.id].done, doneOn: done[a.id].done_on || '' } : { ...a, done: false, doneOn: '' })),
      attendance: m.attendance.map((p) => ({ ...p, rsvp: (p.slug && answers[p.slug]) || '' })),
    });
  });
}

/** Every meeting, newest first, with its files, done states and answers */
export async function listMeetings(DB) {
  await ensureSchema(DB);
  const rows = (await DB.prepare('SELECT data FROM board_meetings ORDER BY date DESC').all()).results || [];
  return withState(DB, rows.map((r) => cleanMeeting(parse(r.data))));
}

export async function getMeeting(DB, id) {
  await ensureSchema(DB);
  const row = await DB.prepare('SELECT data FROM board_meetings WHERE id = ?').bind(id).first();
  return row ? (await withState(DB, [cleanMeeting(parse(row.data))]))[0] : null;
}

async function writeMeeting(DB, m) {
  // Files, done states and answers live in their own tables
  const { files, ...rest } = m;
  const stored = { ...rest, actions: rest.actions.map(({ done, doneOn, ...a }) => a), attendance: rest.attendance.map(({ rsvp, ...p }) => p) };
  await DB.prepare('INSERT OR REPLACE INTO board_meetings (id, date, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)')
    .bind(m.id, m.date || '', JSON.stringify(stored), m.updatedAt, m.updatedBy || '').run();
}

/**
 * Save a meeting from the admin. `base` is the updatedAt the editor loaded:
 * a meeting saved by someone else since then is refused (409, with theirs).
 * The packet's numbers and its sent record are the server's to set.
 */
export async function saveMeeting(DB, raw, { by, base = null } = {}) {
  await ensureSchema(DB);
  const m = cleanMeeting(raw);
  if (!m.date) throw Object.assign(new Error('A meeting needs a date'), { status: 400 });
  const current = await getMeeting(DB, m.id);
  if (current && base !== null && current.updatedAt && current.updatedAt !== base) {
    throw Object.assign(new Error(`${current.updatedBy || 'Someone'} saved this meeting since you opened it`), { status: 409, current });
  }
  const next = {
    ...m,
    snapshot: current?.snapshot || null,
    packetSentAt: current?.packetSentAt || '',
    packetSentTo: current?.packetSentTo || 0,
    approvedOn: m.minutes === 'approved' ? (m.approvedOn || current?.approvedOn || todayEastern()) : '',
    createdAt: current?.createdAt || nowIso(),
    updatedAt: nowIso(),
    updatedBy: by || '',
  };
  await writeMeeting(DB, next);
  return getMeeting(DB, m.id);
}

/** A new meeting from Settings' template, saved (not shared yet) */
export async function createMeeting(env, { date, by }) {
  await ensureSchema(env.DB);
  if (!isDate(date)) throw Object.assign(new Error('Pick the meeting’s date'), { status: 400 });
  const [settings, meetings, people] = await Promise.all([getSettings(env.DB), listMeetings(env.DB), roster(env.DB)]);
  const founders = people.staff.filter((p) => /founder/i.test(p.title));
  const m = newMeeting({
    date, template: settings.template, meetings, defaults: settings.defaults,
    board: people.board.map((p) => ({ slug: p.slug, name: p.name, org: p.organization })),
    staff: founders.map((p) => ({ slug: p.slug, name: p.name })),
  });
  return saveMeeting(env.DB, { ...m, video: settings.defaults.video }, { by });
}

/** A meeting brought in from an old agenda (see parseAgendaText), saved as approved minutes unless it's ahead */
export async function importMeeting(env, parsed, { by }) {
  const m = cleanMeeting({ ...parsed, id: uid('m_'), minutes: parsed.date && parsed.date < todayEastern() ? 'approved' : 'draft', shared: false });
  return saveMeeting(env.DB, m, { by });
}

export async function deleteMeeting(env, id) {
  await ensureSchema(env.DB);
  const files = (await env.DB.prepare("SELECT id FROM board_files WHERE owner_type = 'meeting' AND owner_id = ?").bind(id).all()).results || [];
  for (const f of files) await deleteFile(env, f.id);
  await env.DB.prepare('DELETE FROM board_rsvps WHERE meeting_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM board_meetings WHERE id = ?').bind(id).run();
}

/** Done or not, by action id: an admin for any action, a member for their own */
export async function setActionDone(DB, actionId, done, { by, slug = null } = {}) {
  await ensureSchema(DB);
  if (!ID.test(String(actionId || ''))) throw Object.assign(new Error('Which action item?'), { status: 400 });
  const meetings = await listMeetings(DB);
  const action = meetings.flatMap((m) => m.actions).find((a) => a.id === actionId);
  if (!action) throw Object.assign(new Error('That action item is gone'), { status: 404 });
  if (slug && action.owner !== slug) throw Object.assign(new Error('Only the person it’s assigned to can tick it off'), { status: 403 });
  await DB.prepare('INSERT OR REPLACE INTO board_action_state (action_id, done, done_on, by) VALUES (?, ?, ?, ?)')
    .bind(actionId, done ? 1 : 0, done ? todayEastern() : null, by || '').run();
  return { id: actionId, done: !!done, doneOn: done ? todayEastern() : '' };
}

export async function setRsvp(DB, meetingId, slug, answer) {
  await ensureSchema(DB);
  if (!RSVP.some((r) => r.id === answer)) throw Object.assign(new Error('Pick an answer'), { status: 400 });
  const m = await getMeeting(DB, meetingId);
  if (!m?.shared) throw Object.assign(new Error('That meeting isn’t on the board page'), { status: 404 });
  await DB.prepare('INSERT OR REPLACE INTO board_rsvps (meeting_id, slug, answer, at) VALUES (?, ?, ?, ?)').bind(meetingId, slug, answer, nowIso()).run();
  return { meetingId, answer };
}

// ─── Documents ──────────────────────────────────────────────────────

export function cleanDoc(raw = {}) {
  const one = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return {
    id: ID.test(String(raw.id || '')) ? raw.id : uid('d_'),
    title: one(raw.title, 200),
    kind: DOC_KINDS.some((k) => k.id === raw.kind) ? raw.kind : 'other',
    note: String(raw.note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 2000),
    sign: raw.sign === true,
    shared: raw.shared !== false,
    year: Number(raw.year) >= 2000 && Number(raw.year) <= 2100 ? Math.round(raw.year) : null,
    createdAt: one(raw.createdAt, 40),
    updatedAt: one(raw.updatedAt, 40),
  };
}

/** Every document with its file and this year's signatures: { ...doc, file, signed: { slug: { name, at } } } */
export async function listDocs(DB, year = Number(todayEastern().slice(0, 4))) {
  await ensureSchema(DB);
  const [rows, files, sigs] = await Promise.all([
    DB.prepare('SELECT data FROM board_docs').all().then((r) => r.results || []),
    filesOf(DB, 'doc'),
    DB.prepare('SELECT * FROM board_signatures WHERE year = ?').bind(year).all().then((r) => r.results || []),
  ]);
  return rows.map((r) => cleanDoc(parse(r.data))).map((d) => ({
    ...d,
    file: (files[d.id] || []).at(-1) || null,
    signed: Object.fromEntries(sigs.filter((s) => s.doc_id === d.id).map((s) => [s.slug, { name: s.name, at: s.at }])),
  })).sort((a, b) => a.title.localeCompare(b.title));
}

export async function saveDoc(DB, raw) {
  await ensureSchema(DB);
  const d = cleanDoc(raw);
  if (!d.title) throw Object.assign(new Error('A document needs a title'), { status: 400 });
  const row = await DB.prepare('SELECT data FROM board_docs WHERE id = ?').bind(d.id).first();
  const next = { ...d, createdAt: row ? parse(row.data).createdAt : nowIso(), updatedAt: nowIso() };
  await DB.prepare('INSERT OR REPLACE INTO board_docs (id, data, updated_at) VALUES (?, ?, ?)').bind(d.id, JSON.stringify(next), next.updatedAt).run();
  return (await listDocs(DB)).find((x) => x.id === d.id);
}

export async function deleteDoc(env, id) {
  await ensureSchema(env.DB);
  const files = (await env.DB.prepare("SELECT id FROM board_files WHERE owner_type = 'doc' AND owner_id = ?").bind(id).all()).results || [];
  for (const f of files) await deleteFile(env, f.id);
  await env.DB.prepare('DELETE FROM board_signatures WHERE doc_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM board_docs WHERE id = ?').bind(id).run();
}

/** A member's "I've read it" for this year, with their typed name */
export async function signDoc(DB, docId, member, name) {
  await ensureSchema(DB);
  const doc = (await listDocs(DB)).find((d) => d.id === docId);
  if (!doc?.shared || !doc.sign) throw Object.assign(new Error('That document doesn’t ask for a signature'), { status: 404 });
  const typed = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (typed.length < 3) throw Object.assign(new Error('Type your full name to sign'), { status: 400 });
  const year = Number(todayEastern().slice(0, 4));
  await DB.prepare('INSERT OR REPLACE INTO board_signatures (doc_id, slug, year, name, at) VALUES (?, ?, ?, ?, ?)').bind(docId, member.slug, year, typed, nowIso()).run();
  return { docId, year, name: typed };
}

// ─── Files ──────────────────────────────────────────────────────────

// Office files are ZIPs (docx, xlsx, pptx) or the older OLE kind (doc, xls); they always download
const OFFICE = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc: 'application/msword', xls: 'application/vnd.ms-excel' };
export function fileTypeOf(bytes, name) {
  const found = sniffType(bytes);
  if (found) return found;
  const ext = String(name || '').toLowerCase().split('.').pop();
  const b = new Uint8Array(bytes.slice ? bytes.slice(0, 8) : bytes);
  if (['docx', 'xlsx', 'pptx'].includes(ext) && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) return OFFICE[ext];
  if (['doc', 'xls'].includes(ext) && b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) return OFFICE[ext];
  return null;
}
const safeName = (n) => String(n || 'file').normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').replace(/^[.-]+/, '').slice(-100) || 'file';

/** Store an uploaded file for a meeting or a document → its row as the admin shows it */
export async function putFile(env, { ownerType, ownerId, file, kind = 'other', staffOnly = false, by = '' }) {
  await ensureSchema(env.DB);
  const bucket = boardFiles(env);
  if (!bucket) throw Object.assign(new Error('File storage isn’t set up (FILES)'), { status: 503 });
  if (!['meeting', 'doc'].includes(ownerType) || !ID.test(String(ownerId || ''))) throw Object.assign(new Error('What is this file for?'), { status: 400 });
  const owner = ownerType === 'meeting'
    ? await env.DB.prepare('SELECT id FROM board_meetings WHERE id = ?').bind(ownerId).first()
    : await env.DB.prepare('SELECT id FROM board_docs WHERE id = ?').bind(ownerId).first();
  if (!owner) throw Object.assign(new Error(`Save the ${ownerType === 'meeting' ? 'meeting' : 'document'} first`), { status: 404 });
  if (!file || typeof file.arrayBuffer !== 'function') throw Object.assign(new Error('No file came with that'), { status: 400 });
  if (file.size > MAX_FILE) throw Object.assign(new Error('That file is over 50 MB'), { status: 413 });
  const bytes = await file.arrayBuffer();
  const type = fileTypeOf(new Uint8Array(bytes), file.name);
  if (!type) throw Object.assign(new Error('Board files can be PDFs, pictures, or Word, Excel and PowerPoint files'), { status: 415 });
  const id = uid('f_');
  const name = String(file.name || 'file').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 200) || 'file';
  const key = `board/${ownerType}/${ownerId}/${id}-${safeName(name)}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  const fileKind = (ownerType === 'doc' ? ['other'] : FILE_KINDS.map((k) => k.id)).includes(kind) ? kind : 'other';
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, ownerType, ownerId, key, name, type, bytes.byteLength, fileKind, staffOnly ? 1 : 0, nowIso(), by).run();
  return { id, name, type, size: bytes.byteLength, kind: fileKind, staffOnly: !!staffOnly, at: nowIso() };
}

export async function updateFile(DB, id, { kind, staffOnly, name } = {}) {
  await ensureSchema(DB);
  const row = await DB.prepare('SELECT * FROM board_files WHERE id = ?').bind(id).first();
  if (!row) throw Object.assign(new Error('That file is gone'), { status: 404 });
  const next = {
    kind: kind !== undefined && FILE_KINDS.some((k) => k.id === kind) ? kind : row.kind,
    staff: staffOnly !== undefined ? (staffOnly ? 1 : 0) : row.staff_only,
    name: name !== undefined && String(name).trim() ? String(name).replace(/[\u0000-\u001F]/g, '').trim().slice(0, 200) : row.name,
  };
  await DB.prepare('UPDATE board_files SET kind = ?, staff_only = ?, name = ? WHERE id = ?').bind(next.kind, next.staff, next.name, id).run();
  return { id, kind: next.kind, staffOnly: !!next.staff, name: next.name };
}

export async function deleteFile(env, id) {
  const row = await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ?').bind(id).first();
  if (!row) return false;
  await boardFiles(env)?.delete(row.r2_key).catch(() => {});
  await env.DB.prepare('DELETE FROM board_files WHERE id = ?').bind(id).run();
  return true;
}

/** The file's row if this person may open it: admins any; a member only a shared meeting's or document's, never staff-only */
export async function fileFor(DB, id, { admin = false } = {}) {
  await ensureSchema(DB);
  if (!ID.test(String(id || ''))) return null;
  const row = await DB.prepare('SELECT * FROM board_files WHERE id = ?').bind(id).first();
  if (!row) return null;
  if (admin) return row;
  if (row.staff_only) return null;
  if (row.owner_type === 'meeting') return (await getMeeting(DB, row.owner_id))?.shared ? row : null;
  const doc = await DB.prepare('SELECT data FROM board_docs WHERE id = ?').bind(row.owner_id).first();
  return doc && cleanDoc(parse(doc.data)).shared ? row : null;
}

// ─── The numbers (the packet's, and the board page's) ───────────────

/** Mercury's checking and savings balances right now → { total, accounts: [{ name, kind, balance }], at } or null without a key */
export async function cashNow(env, { fetchImpl = fetch } = {}) {
  if (!String(env.MERCURY_API_TOKEN || '').trim()) return null;
  const accounts = ((await mercury(env, '/accounts', { fetchImpl }))?.accounts || [])
    .filter((a) => !['deleted', 'archived', 'closed'].includes(String(a.status || '').toLowerCase()) && !/external/i.test(`${a.kind} ${a.type}`) && typeof a.currentBalance === 'number')
    .map((a) => ({ name: a.nickname || a.name || 'Account', kind: a.kind || '', balance: Math.round(a.currentBalance * 100) / 100 }));
  return { total: Math.round(accounts.reduce((s, a) => s + a.balance, 0) * 100) / 100, accounts, at: nowIso() };
}

/** The balance at the end of each month the heartbeat saw (last 24), newest first */
export async function cashHistory(DB) {
  await ensureSchema(DB);
  return ((await DB.prepare('SELECT month, total, at FROM board_cash ORDER BY month DESC LIMIT 24').all()).results || []).map((r) => ({ month: r.month, total: r.total, at: r.at }));
}

/** Open makeovers by JobTread status, the building ones with their kid → { byStatus, building: [{ name, slug, status }] } (15-minute copy) */
export async function projectsNow(env, { fetchImpl = fetch, now = Date.now(), fresh = false } = {}) {
  const cached = await readState(env.DB, 'projects');
  if (!fresh && cached.at && now - Date.parse(cached.at) < 15 * 60 * 1000) return cached.value;
  if (!env.JOBTREAD_GRANT_KEY) return cached.value || null;
  try {
    const [jobs, kids] = await Promise.all([fetchJobs(env.JOBTREAD_GRANT_KEY, fetchImpl), loadKids(env.DB).catch(() => [])]);
    const byStatus = {};
    const building = [];
    for (const job of jobs) {
      if (isRehearsalJob(job)) continue;
      const status = String((job.customFieldValues?.nodes || []).find((v) => v.customField?.id === FIELD_JOB_STATUS)?.value || '').trim();
      if (!status) continue;
      byStatus[status] = (byStatus[status] || 0) + 1;
      if (BUILDING_STATUSES.has(status)) {
        const kid = matchKid(job.name, kids, job.id);
        // JobTread names a job "Maya (2026)"; a job no kid page matches shows by that first name
        building.push({ name: kid?.name || String(job.name || '').replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+[-–].*$/, '').trim(), slug: kid?.slug || null, status });
      }
    }
    const value = { byStatus, building };
    await writeState(env.DB, 'projects', { at: new Date(now).toISOString(), value });
    return value;
  } catch (err) {
    console.error('[board] projects', err.message);
    return cached.value || null;
  }
}

/** Kids served and rooms built, the way the site counts them (src/utils/stats.ts) */
async function impact(DB) {
  const read = async (table) => { try { return ((await DB.prepare(`SELECT data FROM ${table}`).all()).results || []).map((r) => parse(r.data)).filter((d) => d.publishStatus !== 'draft'); } catch { return []; } };
  const [kids, community] = await Promise.all([read('kids'), read('community')]);
  return {
    kids: kids.reduce((s, k) => s + (Number(k.childCount) || 1), 0),
    rooms: kids.reduce((s, k) => s + (Number(k.roomCount) || 1), 0),
    communityProjects: community.length,
    reached: community.reduce((s, c) => s + reachedCount(c), 0),
    years: Number(todayEastern().slice(0, 4)) - 2012,
  };
}

/** Events from today on (and the last 120 days), soonest first */
async function eventsList(DB, today = todayEastern()) {
  let rows = [];
  try { rows = ((await DB.prepare('SELECT slug, data FROM events').all()).results || []).map((r) => ({ slug: r.slug, ...parse(r.data) })); } catch { return { upcoming: [], recent: [] }; }
  const keep = rows.filter((e) => isDate(e.date) && e.publishStatus !== 'draft')
    .map((e) => ({ slug: e.slug, title: String(e.title || '').trim(), date: e.date, endDate: isDate(e.endDate) ? e.endDate : e.date, time: e.time || '', location: e.location || '', url: `/events/${e.slug}/` }));
  const cutoff = new Date(Date.parse(`${today}T12:00:00Z`) - 120 * 86_400_000).toISOString().slice(0, 10);
  return {
    upcoming: keep.filter((e) => e.endDate >= today).sort((a, b) => a.date.localeCompare(b.date)),
    recent: keep.filter((e) => e.endDate < today && e.date >= cutoff).sort((a, b) => b.date.localeCompare(a.date)),
  };
}

const revealRow = (r) => ({ slug: r.slug, name: r.name, confirmed: r.confirmed !== false, date: r.date || '', time: r.time || '', window: r.window || null, kidUrl: r.kidUrl || `/kids/${r.slug}/` });

// ─── Finance summaries from Job Costs ───────────────────────────────
// The money in and out (12 months by makeovers, store and operating, the year
// so far against last year, the cash forecast, the month's close) comes from
// the finance module, which registers itself here when it ships:
//   provideBoardFinance(boardFinance)   in functions/api/_finance.js
// so the board never imports Job Costs code, and shows the section once it's there.
let financeSource = null;
export function provideBoardFinance(fn) { financeSource = typeof fn === 'function' ? fn : null; }

/** The finance summary (totals only, whole dollars), a 15-minute copy; null until the finance module is live or has history */
export async function boardFinanceNow(env, { now = Date.now(), fresh = false } = {}) {
  if (!financeSource || !env.DB) return null;
  const c = await readState(env.DB, 'finance');
  if (!fresh && c.at && now - Date.parse(c.at) < 15 * 60 * 1000) return c.value || null;
  try {
    const value = (await financeSource(env, { now })) || null;
    await writeState(env.DB, 'finance', { at: new Date(now).toISOString(), value });
    return value;
  } catch (err) {
    console.error('[board] finance', err.message);
    return c.value || null;
  }
}

/** Everything an agenda's live items show, as of now */
export async function liveNumbers(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const today = todayEastern(now);
  const [cash, projects, reveals, events, meetings, kids, finance] = await Promise.all([
    cachedCash(env, { fetchImpl, now }),
    projectsNow(env, { fetchImpl, now }),
    cachedReveals(env, now).catch(() => ({ upcoming: [], past: [] })),
    eventsList(env.DB, today),
    listMeetings(env.DB),
    impact(env.DB),
    boardFinanceNow(env, { now }),
  ]);
  return {
    at: new Date(now).toISOString(),
    cash,
    finance,
    projects,
    reveals: (reveals.upcoming || []).map(revealRow),
    pastReveals: (reveals.past || []).map((r) => revealRow({ ...r, confirmed: true })),
    events: events.upcoming,
    recentEvents: events.recent,
    meetings: meetings.filter((m) => m.date >= today).sort((a, b) => a.date.localeCompare(b.date)).map((m) => ({ id: m.id, name: meetingName(m), date: m.date, start: m.start, shared: m.shared })),
    impact: kids,
  };
}

async function cachedCash(env, { fetchImpl, now }) {
  const c = await readState(env.DB, 'cash');
  if (c.at && now - Date.parse(c.at) < 60 * 60 * 1000) return c.value || null;
  try {
    const value = await cashNow(env, { fetchImpl });
    await writeState(env.DB, 'cash', { at: new Date(now).toISOString(), value });
    return value;
  } catch (err) {
    console.error('[board] cash', err.message);
    return c.value || null;
  }
}

/** Lock today's numbers into a meeting's packet */
export async function takeSnapshot(env, id, { by, fetchImpl = fetch, now = Date.now() } = {}) {
  const m = await getMeeting(env.DB, id);
  if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
  const n = await liveNumbers(env, { fetchImpl, now });
  const snapshot = { at: n.at, by: by || '', cash: n.cash, finance: n.finance, projects: n.projects, reveals: n.reveals, events: n.events, meetings: n.meetings.filter((x) => x.id !== id), impact: n.impact };
  await writeMeeting(env.DB, { ...m, snapshot, updatedAt: nowIso(), updatedBy: by || m.updatedBy });
  return getMeeting(env.DB, id);
}

// ─── The packet email ───────────────────────────────────────────────

/** Who gets the packet: the active board with an email on file */
export async function packetList(DB) {
  return (await activeBoard(DB)).filter((p) => p.email).map((p) => ({ slug: p.slug, name: p.name, email: p.email }));
}

/** The email: when and where, the agenda's headings (never its notes, never a confidential item's title), the button */
export function packetEmail(m, { test = false } = {}) {
  const when = [longDate(m.date), timeRange(m.start, m.end)].filter(Boolean).join(', ');
  const outline = emailOutline(m).map((s) => `<p class="ink" style="margin:14px 0 4px;font-weight:700;">${esc(s.title)}</p>`
    + (s.items.length ? `<ul style="margin:0 0 0 18px;padding:0;">${s.items.map((t) => `<li class="ink" style="margin:0 0 3px;">${esc(t)}</li>`).join('')}</ul>` : '')).join('');
  const url = `${SITE}${BOARD_PAGE}#/meetings/${m.id}`;
  const name = meetingName(m);
  return {
    subject: `${test ? '[Preview] ' : ''}Board packet: ${name}, ${shortDate(m.date)}`,
    html: emailShell({
      eyebrow: 'SOARD Board',
      preheader: `${when}${m.location ? ` at ${m.location}` : ''}. The agenda and financials are on the board page.`,
      heading: `The packet for the ${name} is ready`,
      intro: esc(`${when}${m.location ? ` · ${m.location}` : ''}`),
      bodyHtml: facts([['When', esc(when)], ['Where', esc([m.location, m.address].filter(Boolean).join(', '))], ['Video', m.video ? `<a href="${esc(m.video)}" style="color:#2B6CB0;">Join link</a>` : '']])
        + `<div style="margin:18px 0 6px;">${button('Open the packet', url)}</div>`
        + `<p class="muted" style="margin:6px 0 18px;font-size:13px;color:#5A5B61;">Sign in with this email address. You’ll get a one-time code by email.</p>`
        + outline,
      footerHtml: 'You’re getting this as a member of the Sunshine on a Ranney Day Board of Directors. Notes, financials and confidential items stay on the board page and are never emailed.',
    }),
    text: `The packet for the ${name} is ready.\n${when}${m.location ? `\n${m.location}` : ''}\n\nOpen it: ${url}\nSign in with this email address; you'll get a one-time code.`,
  };
}

/** Email the board that the packet is ready (or, test, just `to`); records who it went to */
export async function sendPacket(env, id, { by, to = null, replyTo = [] } = {}) {
  const m = await getMeeting(env.DB, id);
  if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
  if (!emailConfigured(env)) throw Object.assign(new Error('Email isn’t set up (RESEND_API_KEY)'), { status: 503 });
  const test = Array.isArray(to);
  if (!test && !m.shared) throw Object.assign(new Error('Share the meeting with the board first, so the button has something to open'), { status: 409 });
  const list = test ? to : (await packetList(env.DB)).map((p) => p.email);
  if (!list.length) throw Object.assign(new Error('No board member has an email on file (People → Board)'), { status: 409 });
  const mail = packetEmail(m, { test });
  const r = await sendEmails(env, { to: list, ...mail, from: EMAIL_FROM.replace(/^[^<]*/, 'SOARD Board '), tags: [{ name: 'kind', value: test ? 'board-packet-preview' : 'board-packet' }], replyTo });
  if (!test && r.sent) await writeMeeting(env.DB, { ...m, packetSentAt: nowIso(), packetSentTo: r.sent, updatedAt: m.updatedAt, updatedBy: m.updatedBy });
  return { sent: r.sent, failed: r.failed, errors: r.errors, to: test ? list : undefined };
}

// ─── The board page ─────────────────────────────────────────────────

async function siteDoc(DB, key) {
  try { return parse((await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(key).first())?.data, null); } catch { return null; }
}

/** Everything the board page shows, for a member (`member`) or an admin looking (`admin`) */
export async function portalData(env, { member = null, admin = false, now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const today = todayEastern(now);
  const [meetings, docs, numbers, history, people, filings, snapshot, settings] = await Promise.all([
    listMeetings(env.DB), listDocs(env.DB), liveNumbers(env, { now }), cashHistory(env.DB), roster(env.DB, { withEmails: true }),
    siteDoc(env.DB, 'financials'), siteDoc(env.DB, 'financial-snapshot'), getSettings(env.DB),
  ]);
  if (member) {
    const seen = await env.DB.prepare('SELECT at FROM board_seen WHERE slug = ?').bind(member.slug).first();
    if (!seen || now - Date.parse(seen.at) > 10 * 60 * 1000) await env.DB.prepare('INSERT OR REPLACE INTO board_seen (slug, at) VALUES (?, ?)').bind(member.slug, new Date(now).toISOString()).run();
  }
  const shared = meetings.map(forBoard).filter(Boolean);
  const mine = member?.slug || null;
  // A member's own answers, whether or not they're on that meeting's list yet
  const answers = mine ? Object.fromEntries(((await env.DB.prepare('SELECT meeting_id, answer FROM board_rsvps WHERE slug = ?').bind(mine).all()).results || []).map((r) => [r.meeting_id, r.answer])) : {};
  return {
    me: member ? { name: member.name, slug: member.slug, title: member.title, email: member.email, admin } : { name: null, slug: null, admin },
    today,
    meetings: shared.map((m) => ({ ...m, myRsvp: answers[m.id] || '' })),
    next: nextMeeting(shared, today)?.id || null,
    quorum: settings.quorum,
    actions: openActions(shared).map((a) => ({ ...a, mine: !!mine && a.owner === mine })),
    docs: docs.filter((d) => d.shared).map((d) => ({ ...d, file: d.file && !d.file.staffOnly ? d.file : null, signedByMe: mine ? d.signed[mine] || null : null, signedCount: Object.keys(d.signed).length })),
    numbers,
    cashHistory: history,
    filings: (filings?.documents || []).map((d) => ({ title: d.title, year: d.year, type: d.type, url: d.url })).filter((d) => /^https:\/\//.test(String(d.url || ''))),
    snapshot: snapshot || null,
    people: {
      board: people.board.map(({ email, ...p }) => ({ ...p, email: email || null })),
      staff: people.staff.map(({ email, ...p }) => p),
      advisory: people.advisory.map(({ email, ...p }) => p),
    },
  };
}

/** For the admin's Members tab: each active board member, their email on file, last visit and this year's signatures */
export async function memberStatus(DB) {
  await ensureSchema(DB);
  const [board, seen] = await Promise.all([activeBoard(DB), DB.prepare('SELECT slug, at FROM board_seen').all().then((r) => Object.fromEntries((r.results || []).map((x) => [x.slug, x.at])))]);
  return board.sort(comparePeople).map((p) => ({ slug: p.slug, name: p.name, title: p.title || '', seat: p.seat || '', email: p.email, lastSeen: seen[p.slug] || null }));
}

// ─── The heartbeat ──────────────────────────────────────────────────

/**
 * Every 5 minutes at most: keep Access's board list in step with People → Board
 * (./_board-access.js); every hour, the board meetings on Peter and Holly's
 * calendars (./_board-calendar.js); once a day, the month's bank balance for
 * the board page's history. Never throws.
 */
export async function maybeRunBoard(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    await maybeSyncBoardAccess(env, { fetchImpl, now });
    await maybeSyncBoardCalendar(env, { fetchImpl, now });
    if (!String(env.MERCURY_API_TOKEN || '').trim()) return;
    const runs = await readState(env.DB, 'runs');
    if (runs.cashAt && now - Date.parse(runs.cashAt) < 20 * 60 * 60 * 1000) return;
    await writeState(env.DB, 'runs', { ...runs, cashAt: new Date(now).toISOString() });
    const cash = await cashNow(env, { fetchImpl });
    if (!cash) return;
    await writeState(env.DB, 'cash', { at: new Date(now).toISOString(), value: cash });
    await env.DB.prepare('INSERT OR REPLACE INTO board_cash (month, total, accounts, at) VALUES (?, ?, ?, ?)')
      .bind(todayEastern(now).slice(0, 7), cash.total, JSON.stringify(cash.accounts), new Date(now).toISOString()).run();
  } catch (err) {
    console.error('[board] heartbeat', err.message);
  }
}

export { LIMITS };

/** For Site → Automations: the board's sign-in list and its bank history, as counts, times and on/off (never an email) */
export async function boardFacts(env) {
  const { accessStatus } = await import('./_board-access.js');
  await ensureSchema(env.DB);
  const [a, cash, packet, cal] = await Promise.all([
    accessStatus(env),
    env.DB.prepare('SELECT count(*) AS n, max(at) AS last FROM board_cash').first(),
    env.DB.prepare('SELECT data FROM board_meetings').all().then((r) => (r.results || []).map((x) => parse(x.data).packetSentAt).filter(Boolean).sort().at(-1) || null),
    calendarStatus(env.DB),
  ]);
  return {
    access: { configured: a.configured, ok: !!a.ok, attached: !!a.attached, current: !!a.current, emails: a.emails, missing: (a.missing || []).length, syncedAt: a.syncedAt || null, error: a.error ? String(a.error).replace(/\S+@\S+/g, '…').slice(0, 200) : null },
    cash: { mercury: Boolean(String(env.MERCURY_API_TOKEN || '').trim() && String(env.MERCURY_RELAY_KEY || '').trim()), months: cash?.n || 0, lastAt: cash?.last || null },
    lastPacketAt: packet,
    calendar: { configured: Boolean(env.GOOGLE_CALENDAR_KEY), ok: !!cal.ok, checkedAt: cal.checkedAt || null, found: cal.found || 0, failing: (cal.errors || []).length },
  };
}
