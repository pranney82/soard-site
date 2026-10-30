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
  cleanMeeting, forBoard, meetingName, openActions, nextMeeting, todayEastern, isDate, uid, parseAgendaText, fileTitle, plural, minutesFileOf,
  longDate, timeRange, shortDate, DOC_KINDS, FILE_KINDS, RSVP, DEFAULT_TEMPLATE, newMeeting, LIMITS, repliesOf,
  agendaIsDraft, draftAgenda, draftSource, draftName, DRAFTER, callName, readAgain, AGENDA_READER, isLive, cleanLive, majority, guessItem,
} from '../../public/admin/board-shared.js';
import { comparePeople, photoUrl } from '../../public/admin/team-shared.js';
import { reachedCount } from '../../public/admin/community-shared.js';
import { peopleRows, privateEmails, activeBoard, boardAdmins, readState, writeState, readSettings, normEmail, BOARD_PAGE } from './_board-roles.js';
import { cachedReveals, fetchJobs, loadKids, loadProjects, matchProject, isProject, isRehearsalJob, FIELD_JOB_STATUS, BUILDING_STATUSES } from './_reveals.js';
import { sendEmails, sendEmailItems, emailConfigured, EMAIL_FROM } from './_broadcast-notify.js';
import { emailShell, button, esc, facts, link } from './_email-shell.js';
import { answerLinks } from './_board-rsvp.js';
import { sniffType } from './upload-file.js';
import { maybeSyncBoardAccess } from './_board-access.js';
import { maybeSyncBoardCalendar, calendarStatus } from './_board-calendar.js';
import { maybeReadBoardMail, mailStatus } from './_board-mail.js';
import { mercury } from './_mercury.js';
import { bankBalances, plaidConfigured, bankFacts } from './_plaid.js';
import { booksNow, booksFacts } from './_quickbooks.js';
import { limit } from './_rate-limit.js';

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
  // A one-tap answer link's token (its hash) from a board email: ./_board-rsvp.js
  'CREATE TABLE IF NOT EXISTS board_rsvp_links (hash TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, slug TEXT NOT NULL, expires TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS board_docs (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE IF NOT EXISTS board_signatures (doc_id TEXT NOT NULL, slug TEXT NOT NULL, year INTEGER NOT NULL, name TEXT, at TEXT, PRIMARY KEY (doc_id, slug, year))',
  'CREATE TABLE IF NOT EXISTS board_seen (slug TEXT PRIMARY KEY, at TEXT)',
  'CREATE TABLE IF NOT EXISTS board_cash (month TEXT PRIMARY KEY, total REAL, accounts TEXT, at TEXT)',
  // The admins' practice meetings (simulated members): a table of their own, so nothing that reads board_meetings
  // (the board page, the calendar, invites, emails, Drive, mail, Meet attendance, drafts) can ever reach one
  'CREATE TABLE IF NOT EXISTS board_practice (id TEXT PRIMARY KEY, date TEXT, data TEXT NOT NULL, updated_at TEXT, updated_by TEXT)',
  // A meeting as it's held: who checked in from the board page, and how each one voted on an open motion
  "CREATE TABLE IF NOT EXISTS board_checkins (meeting_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT, how TEXT NOT NULL, at TEXT, PRIMARY KEY (meeting_id, slug))",
  "CREATE TABLE IF NOT EXISTS board_votes (meeting_id TEXT NOT NULL, motion_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT, vote TEXT NOT NULL, at TEXT, PRIMARY KEY (meeting_id, motion_id, slug))",
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
    invitesFrom: await (await import('./_board-invite.js')).organizerFor(DB),
    driveFolder: s.driveFolder || '',
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
  if (patch.invitesFrom !== undefined) next.invitesFrom = normEmail(patch.invitesFrom);
  // The Board folder in Google Drive (./_board-drive.js): a link to it or its id; '' for the usual one
  if (patch.driveFolder !== undefined) next.driveFolder = (String(patch.driveFolder || '').match(/folders\/([\w-]{10,})/) || String(patch.driveFolder || '').trim().match(/^([\w-]{10,})$/) || [])[1] || '';
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

/** Every meeting, newest first, with its files, done states and answers. Practice meetings only when asked ({ practice: true }) */
export async function listMeetings(DB, { practice = false } = {}) {
  await ensureSchema(DB);
  const rows = (await DB.prepare('SELECT data FROM board_meetings ORDER BY date DESC').all()).results || [];
  const more = practice ? (await DB.prepare('SELECT data FROM board_practice ORDER BY date DESC').all()).results || [] : [];
  return withState(DB, [...rows, ...more].map((r) => cleanMeeting(parse(r.data))));
}

export async function getMeeting(DB, id) {
  await ensureSchema(DB);
  const row = await DB.prepare('SELECT data FROM board_meetings WHERE id = ?').bind(id).first();
  return row ? (await withState(DB, [cleanMeeting(parse(row.data))]))[0] : null;
}

/** The agenda as a person writes it (sections, items, who presents, notes, board-only marks, its documents), to tell when someone changed it */
const agendaSkeleton = (m) => JSON.stringify((m.sections || []).map((s) => [s.title, s.minutes || 0, s.items.map((it) => [it.title, it.presenter, it.who, it.notes, it.staffNote, it.confidential, it.docs])]));

const stored = (m) => {
  // Files, done states and answers live in their own tables
  const { files, ...rest } = m;
  return JSON.stringify({ ...rest, actions: rest.actions.map(({ done, doneOn, ...a }) => a), attendance: rest.attendance.map(({ rsvp, ...p }) => p) });
};
async function writeMeeting(DB, m) {
  // Practice meetings live in their own table (see SCHEMA): getMeeting, and every action built on it, never finds one
  await DB.prepare(`INSERT OR REPLACE INTO ${m.practice ? 'board_practice' : 'board_meetings'} (id, date, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)`)
    .bind(m.id, m.date || '', stored(m), m.updatedAt, m.updatedBy || '').run();
}

/** A practice meeting by id (null for a board meeting: those are getMeeting's) */
export async function getPractice(DB, id) {
  await ensureSchema(DB);
  const row = await DB.prepare('SELECT data FROM board_practice WHERE id = ?').bind(id).first();
  if (!row) return null;
  const raw = parse(row.data);
  const [m] = await withState(DB, [cleanMeeting({ ...raw, practice: true })]);
  // The documents it borrows from board meetings (createPractice), as they are now: one deleted or made staff-only
  // since drops out. null: made before practice meetings borrowed any (createPractice makes a new one)
  const borrowed = Array.isArray(raw.borrowed) ? raw.borrowed.filter((x) => ID.test(String(x))) : null;
  const all = borrowed?.length ? Object.values(await filesOf(DB, 'meeting')).flat() : [];
  const files = (borrowed || []).map((x) => all.find((f) => f.id === x)).filter((f) => f && !f.staffOnly);
  return { ...m, files: [...m.files, ...files], borrowed, docsFrom: isDate(raw.docsFrom) ? raw.docsFrom : '' };
}
/** Today's practice meeting, if one's been started */
export async function todayPractice(DB, now = Date.now()) {
  await ensureSchema(DB);
  const row = await DB.prepare('SELECT id FROM board_practice WHERE date = ? ORDER BY updated_at DESC LIMIT 1').bind(todayEastern(now)).first();
  return row ? getPractice(DB, row.id) : null;
}

/**
 * Server-set fields (the invite, its Meet link, the replies to it) onto the
 * meeting as it's stored now, so a save made while Google was answering is
 * kept: written only if no one saved in between, else read again and redone.
 * A newer updatedAt, so a copy open in an editor merges. → the meeting
 */
export async function patchMeeting(DB, id, fn) {
  for (let i = 0; i < 5; i++) {
    const cur = await getMeeting(DB, id);
    if (!cur) return null;
    const next = { ...fn(cur), id, updatedAt: nowIso(), updatedBy: cur.updatedBy || '' };
    const r = await DB.prepare('UPDATE board_meetings SET date = ?, data = ?, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ?')
      .bind(next.date || '', stored(next), next.updatedAt, next.updatedBy, id, cur.updatedAt).run();
    if ((r?.meta?.changes ?? r?.changes ?? 0) > 0) return getMeeting(DB, id);
  }
  throw new Error('The meeting kept changing; try again');
}

/**
 * Save a meeting from the admin. `base` is the updatedAt the editor loaded:
 * a meeting saved by someone else since then is refused (409, with theirs).
 * The packet's numbers and its sent record are the server's to set.
 */
export async function saveMeeting(DB, raw, { by, base = null } = {}) {
  await ensureSchema(DB);
  // Practice is the server's to set: a meeting is one only if it was made as one (createPractice)
  const practice = await getPractice(DB, cleanMeeting(raw).id);
  if (practice) return savePractice(DB, practice, raw, { by, base });
  // A practice meeting started over (or cleared after a week) while an editor still had it open: never a new board meeting
  if (raw?.practice === true && !(await getMeeting(DB, cleanMeeting(raw).id))) throw Object.assign(new Error('That practice meeting is gone. Open Practice again for a new one.'), { status: 404 });
  const m = { ...cleanMeeting(raw), practice: false };
  const at = nowIso();
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
    minutesSentAt: current?.minutesSentAt || '',
    invite: current?.invite || null,
    // Who joined by Meet is the server's (./_board-attendance.js). Where the agenda came from is named by
    // server code that fills it (board mail, the drafts); a person changing the agenda or its notes makes it theirs
    fromMeet: 'fromMeet' in raw ? m.fromMeet : current?.fromMeet || null,
    // Which minutes filled the meeting in is the minutes reader's (./_board-minutes.js)
    minutesFrom: 'minutesFrom' in raw ? m.minutesFrom : current?.minutesFrom || null,
    agendaFrom: 'agendaFrom' in raw ? m.agendaFrom : !current ? null : agendaSkeleton(m) !== agendaSkeleton(current) ? { kind: 'typed', name: '', at } : current.agendaFrom,
    approvedOn: m.minutes === 'approved' ? (m.approvedOn || current?.approvedOn || todayEastern()) : '',
    createdAt: current?.createdAt || at,
    updatedAt: at,
    updatedBy: by || '',
  };
  await writeMeeting(DB, next);
  return getMeeting(DB, m.id);
}

/** A practice meeting saved from the chair's screen: what a person edits, never shared, never an invite or a packet */
async function savePractice(DB, current, raw, { by, base = null } = {}) {
  if (base !== null && current.updatedAt && current.updatedAt !== base) {
    throw Object.assign(new Error(`${current.updatedBy || 'Someone'} saved this meeting since you opened it`), { status: 409, current });
  }
  const m = cleanMeeting(raw);
  const next = {
    ...m, id: current.id, date: current.date, practice: true, shared: false, notBoard: false, calendar: null, invite: null, snapshot: null,
    packetSentAt: '', packetSentTo: 0, minutesSentAt: '', fromMeet: null, agendaFrom: current.agendaFrom,
    borrowed: current.borrowed || [], docsFrom: current.docsFrom,
    createdAt: current.createdAt, updatedAt: nowIso(), updatedBy: by || '',
  };
  await writeMeeting(DB, next);
  return getPractice(DB, current.id);
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
  const m = cleanMeeting({ agendaFrom: { kind: 'typed', name: '', at: nowIso() }, ...parsed, id: uid('m_'), minutes: parsed.date && parsed.date < todayEastern() ? 'approved' : 'draft', shared: false });
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
  const meetings = await listMeetings(DB, { practice: !slug });
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
  if (!onBoardPage(m)) throw Object.assign(new Error('That meeting isn’t on the board page'), { status: 404 });
  await DB.prepare('INSERT OR REPLACE INTO board_rsvps (meeting_id, slug, answer, at) VALUES (?, ?, ?, ?)').bind(meetingId, slug, answer, nowIso()).run();
  return { meetingId, answer };
}

/**
 * The board already has it on their calendars: Board's own invite went out, or
 * the organizer's event invites three or more of the board
 */
export const boardHasIt = (m) => !!m?.invite?.sentAt || Object.keys(repliesOf(m) || {}).length >= 3;
/**
 * A meeting a board member can see something of: a shared one, or one ahead
 * that's on their calendars already but isn't shared yet (its day, time and
 * place only: see portalData's nextPending)
 */
export const onBoardPage = (m, today = todayEastern()) => !!m && (m.shared || (!m.notBoard && !m.calendar?.gone && isDate(m.date) && m.date >= today && boardHasIt(m)));
/** A meeting's calendar file for the board page, or null when it isn't theirs to see (one not shared yet carries no agenda) */
export async function boardIcs(DB, id) {
  const m = ID.test(String(id || '')) ? await getMeeting(DB, id) : null;
  if (!m?.date || !onBoardPage(m)) return null;
  return meetingIcs(m.shared ? m : { ...m, sections: [] });
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

/**
 * A stored file read with the agenda rules (minutes uploaded after the
 * meeting, an old agenda): Word read here, a PDF through Workers AI.
 * → { sections, attendance, date, start, end, location, unmatched } or null when it can't be read
 */
export async function readFileAsAgenda(env, id) {
  const row = await env.DB.prepare('SELECT * FROM board_files WHERE id = ?').bind(id).first();
  if (!row) throw Object.assign(new Error('That file is gone'), { status: 404 });
  const obj = await boardFiles(env)?.get(row.r2_key);
  if (!obj) throw Object.assign(new Error('That file is gone'), { status: 404 });
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  const { fileText } = await import('./_board-mail.js');
  const text = await fileText(env, { name: row.name, bytes });
  if (!text) return null;
  const people = await roster(env.DB);
  const parsed = parseAgendaText(text, [
    ...people.board.map((p) => ({ slug: p.slug, name: p.name, org: p.organization, kind: 'board' })),
    ...people.staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })),
  ]);
  return parsed.sections.some((s) => s.items.length) ? parsed : null;
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

/**
 * The money in the bank right now: Mercury's checking and savings (live), and each bank connected through Plaid
 * in Settings → Bank balances (Chase's checking and CD, as Plaid last read them) →
 * { total, mercuryTotal (null without Mercury), accounts: [{ bank, name, kind, balance }], owed: [credit cards: { bank, name, balance, limit }],
 *   banksAt, stale: [banks not read in a day and a half], at } or null with neither
 */
export async function cashNow(env, { fetchImpl = fetch } = {}) {
  const mercuryOn = !!String(env.MERCURY_API_TOKEN || '').trim();
  const [m, banks] = await Promise.all([
    mercuryOn ? mercury(env, '/accounts', { fetchImpl }).then((r) => r?.accounts || []) : null,
    bankBalances(env.DB).catch((err) => { console.error('[board] banks', err.message); return null; }),
  ]);
  if (!m && !banks) return null;
  // Mercury's own accounts only: a bank linked in Mercury for transfers isn't SOARD's Mercury money (Plaid counts it)
  const merc = (m || [])
    .filter((a) => !['deleted', 'archived', 'closed'].includes(String(a.status || '').toLowerCase()) && !/external/i.test(`${a.kind} ${a.type}`) && typeof a.currentBalance === 'number')
    .map((a) => ({ bank: 'Mercury', name: a.nickname || a.name || 'Account', kind: a.kind || '', balance: Math.round(a.currentBalance * 100) / 100 }));
  const sum = (l) => Math.round(l.reduce((s, a) => s + a.balance, 0) * 100) / 100;
  const accounts = [...(banks?.accounts || []).map(({ at, ...a }) => a), ...merc];
  return { total: sum(accounts), mercuryTotal: m ? sum(merc) : null, accounts, owed: (banks?.owed || []).map(({ at, ...a }) => a), banksAt: banks?.at || null, stale: banks?.stale || [], at: nowIso() };
}

/** The balance at the end of each month the heartbeat saw (last 24), newest first */
export async function cashHistory(DB) {
  await ensureSchema(DB);
  return ((await DB.prepare('SELECT month, total, at FROM board_cash WHERE total > 0 ORDER BY month DESC LIMIT 24').all()).results || []).map((r) => ({ month: r.month, total: r.total, at: r.at }));
}

/** JobTread's Status for a family approved and waiting on the money to start */
export const AWAITING_FUNDING = 'Awaiting Funding';

/**
 * Open makeovers by JobTread status, the building ones with their kid or
 * community project → { byStatus, building: [{ name, slug, status, url?, kind? }], waiting: [same, Awaiting Funding] }
 * (15-minute copy). A project carries kind 'community', and its url only
 * once its page is public.
 */
export async function projectsNow(env, { fetchImpl = fetch, now = Date.now(), fresh = false } = {}) {
  const cached = await readState(env.DB, 'projects');
  if (!fresh && cached.at && now - Date.parse(cached.at) < 15 * 60 * 1000) return cached.value;
  if (!env.JOBTREAD_GRANT_KEY) return cached.value || null;
  try {
    const [jobs, kids, projects] = await Promise.all([fetchJobs(env.JOBTREAD_GRANT_KEY, fetchImpl), loadKids(env.DB).catch(() => []), loadProjects(env.DB, { drafts: true }).catch(() => [])]);
    const byStatus = {};
    const building = [];
    // Families approved and waiting on the money to start: the board's first column
    const waiting = [];
    for (const job of jobs) {
      if (isRehearsalJob(job)) continue;
      const status = String((job.customFieldValues?.nodes || []).find((v) => v.customField?.id === FIELD_JOB_STATUS)?.value || '').trim();
      if (!status) continue;
      byStatus[status] = (byStatus[status] || 0) + 1;
      const list = BUILDING_STATUSES.has(status) ? building : status === AWAITING_FUNDING ? waiting : null;
      if (!list) continue;
      const hit = matchProject(job.name, [...kids, ...projects], job.id);
      if (isProject(hit)) {
        // An organization, by its name on Community even before it's published (the board is SOARD's own;
        // a child's name waits for their page). Linked and pictured once its page is public
        list.push({ name: hit.name || null, slug: hit.page ? hit.slug : null, status, kind: 'community', url: hit.page || null, ...photoField(hit.published && hit.heroImage) });
        continue;
      }
      const kid = hit;
      // By name only with a published kid page: a job's own name in JobTread is internal ("Not Published Yet"). Its photo likewise
      list.push({ name: kid?.name || null, slug: kid?.slug || null, status, ...photoField(kid?.name && kid.heroImage) });
    }
    const value = { byStatus, building, waiting };
    await writeState(env.DB, 'projects', { at: new Date(now).toISOString(), value });
    return value;
  } catch (err) {
    console.error('[board] projects', err.message);
    return cached.value || null;
  }
}

/** Kids served and rooms built, the way the site counts them (src/utils/stats.ts) */
async function impact(DB) {
  const read = async (table) => { try { return ((await DB.prepare(`SELECT slug, data FROM ${table}`).all()).results || []).map((r) => ({ slug: r.slug, ...parse(r.data) })).filter((d) => d.publishStatus !== 'draft'); } catch { return []; } };
  const [kids, community] = await Promise.all([read('kids'), read('community')]);
  return {
    kids: kids.reduce((s, k) => s + (Number(k.childCount) || 1), 0),
    rooms: kids.reduce((s, k) => s + (Number(k.roomCount) || 1), 0),
    communityProjects: community.length,
    reached: community.reduce((s, c) => s + reachedCount(c), 0),
    years: Number(todayEastern().slice(0, 4)) - 2012,
    // Each year's kids served, rooms built and makeovers (a published profile is one), counted as the admin's
    // Dashboard does; every year from the first through this one, so a quiet year shows as one
    byYear: byYear(kids),
  };
}
function byYear(kids) {
  const by = new Map();
  for (const k of kids) {
    const y = Number(k.year);
    if (!(y > 2000 && y < 2100)) continue;
    const r = by.get(y) || { year: y, kids: 0, rooms: 0, makeovers: 0, profiles: [] };
    const n = Number(k.childCount) || 1;
    const rooms = Number(k.roomCount) || 1;
    r.kids += n;
    r.rooms += rooms;
    r.makeovers += 1;
    // Each makeover by its published page: the kid's name, page and photo (for Explore by year)
    r.profiles.push({ name: String(k.name || ''), slug: String(k.slug || ''), kids: n, rooms, ...photoField(k.heroImage || k.photos?.[0]?.url) });
    by.set(y, r);
  }
  if (!by.size) return [];
  const first = Math.min(...by.keys());
  const last = Math.max(Number(todayEastern().slice(0, 4)), ...by.keys());
  return Array.from({ length: last - first + 1 }, (_, i) => by.get(first + i) || { year: first + i, kids: 0, rooms: 0, makeovers: 0, profiles: [] });
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

const revealRow = (r, photos = {}) => ({ slug: r.slug, name: r.name, confirmed: r.confirmed !== false, date: r.date || '', time: r.time || '', window: r.window || null, kidUrl: r.kidUrl || `/kids/${r.slug}/`, ...photoField(r.name && (photos[r.slug] || r.image)) });
/** A published page's photo, from Cloudflare Images only (the board page's pictures come from nowhere else) */
const photoOf = (url) => (/^(https:\/\/imagedelivery\.net\/|\/cdn-cgi\/imagedelivery\/)[\w/=,.-]+$/.test(String(url || '')) ? String(url) : null);
/** { photo } when there's one to show, else nothing */
const photoField = (url) => (photoOf(url) ? { photo: photoOf(url) } : {});

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
  const [cash, projects, reveals, events, meetings, kids, finance, pages, books] = await Promise.all([
    cachedCash(env, { fetchImpl, now }),
    projectsNow(env, { fetchImpl, now }),
    cachedReveals(env, now).catch(() => ({ upcoming: [], past: [] })),
    eventsList(env.DB, today),
    listMeetings(env.DB),
    impact(env.DB),
    boardFinanceNow(env, { now }),
    loadKids(env.DB).catch(() => []),
    // The year's revenue and expenses so far, as QuickBooks last answered (Settings → QuickBooks)
    booksNow(env.DB, { now }).catch(() => null),
  ]);
  // Each reveal's kid by their published page's photo (a draft page's kid has none)
  const photos = Object.fromEntries(pages.map((k) => [k.slug, photoOf(k.heroImage)]).filter(([, p]) => p));
  // The cash shows once a bank holds money: Chase through Plaid, Mercury once SOARD's money moves there (Oct 2026
  // on). Mercury's own record (the finance summary) speaks for SOARD only once Mercury itself holds money
  const funded = !!cash && cash.total > 0;
  const inMercury = cash ? cash.mercuryTotal ?? cash.total : null;
  return {
    at: new Date(now).toISOString(),
    cash: funded ? cash : null,
    mercury: cash && inMercury !== null ? { empty: !(inMercury > 0), at: cash.at } : null,
    finance,
    books,
    projects,
    reveals: (reveals.upcoming || []).map((r) => revealRow(r, photos)),
    pastReveals: (reveals.past || []).map((r) => revealRow({ ...r, confirmed: true }, photos)),
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
  const snapshot = { at: n.at, by: by || '', cash: n.cash, mercury: n.mercury, finance: n.finance, books: n.books, projects: n.projects, reveals: n.reveals, pastReveals: n.pastReveals, events: n.events, recentEvents: n.recentEvents, meetings: n.meetings.filter((x) => x.id !== id), impact: n.impact };
  await writeMeeting(env.DB, { ...m, snapshot, updatedAt: nowIso(), updatedBy: by || m.updatedBy });
  return getMeeting(env.DB, id);
}

// ─── The packet email ───────────────────────────────────────────────

/** Who gets the packet: the active board with an email on file */
export async function packetList(DB) {
  return (await activeBoard(DB)).filter((p) => p.email).map((p) => ({ slug: p.slug, name: p.name, email: p.email }));
}

const FOOTER = 'You’re getting this as a member of the Sunshine on a Ranney Day Board of Directors.';
const fromBoard = () => EMAIL_FROM.replace(/^[^<]*/, 'SOARD Board ');
const meetingUrl = (m) => `${SITE}${BOARD_PAGE}#/meetings/${m.id}`;
const whenOf = (m) => [longDate(m.date), timeRange(m.start, m.end)].filter(Boolean).join(', ');
const placeOf = (m) => [m.location, m.address].filter(Boolean).join(', ');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
// A call link as people read it: meet.google.com/abc-defg-hij
const bareLink = (url) => String(url).replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
const SIGN_IN = 'Sign in with this email address. You’ll get a one-time code by email.';
const small = (html) => `<p class="muted" style="margin:6px 0 0;font-size:13px;line-height:1.5;color:#5A5B61;">${html}</p>`;
const ruled = (html) => `<div class="rule" style="margin:24px 0 0;padding:20px 0 0;border-top:1px solid #E5E4E0;">${html}</div>`;

/** When, where and the video call as an email's fact rows (`more`: [label, html] rows after them) */
function meetingFacts(m, more = []) {
  return facts([
    ['When', esc(whenOf(m))],
    ['Where', esc(placeOf(m))],
    ['Video', m.video ? `${esc(callName(m.video))}: <a class="lnk" href="${esc(m.video)}" style="color:#2B6CB0;">${esc(bareLink(m.video))}</a>` : ''],
    ...more,
  ]);
}
const factsText = (m) => [`When: ${whenOf(m)}`, placeOf(m) && `Where: ${placeOf(m)}`, m.video && `Video (${callName(m.video)}): ${m.video}`].filter(Boolean).join('\n');

/**
 * "Will you be there?" as three buttons: a member's own one-tap answers
 * (./_board-rsvp.js). A preview's open the meeting on the board page.
 */
function answerButtons(m, links, { lead = false } = {}) {
  return RSVP.map((r, i) => button(r.ask, links?.[r.id] || meetingUrl(m), lead && !i ? 'primary' : 'outline')).join('');
}
const answerText = (m, links) => RSVP.map((r) => `${r.ask}: ${links?.[r.id] || meetingUrl(m)}`).join('\n');

/**
 * The documents email, for one board member: everything stays on the board page (nothing is attached; the board
 * reads it there, the meeting presents it from there, and Print it all is there for paper). When, where and the
 * call; what the documents are (never one on a board-only item, by name); their one-tap answer when they haven't
 * given one (`links`). `files`: the documents' names.
 */
export function packetEmail(m, { test = false, files = [], private: hidden = 0, name: who = '', links = null, ask = true } = {}) {
  const name = meetingName(m);
  const first = firstName(who);
  const titles = files.map((n) => fileTitle(n));
  const count = titles.length + hidden;
  const lead = `${first ? `${first}, the` : 'The'} agenda${count ? ` and ${plural(count, 'document')}` : ''} for the ${name} ${count ? 'are' : 'is'} on the board page. Read ${count ? 'them' : 'it'} there, or print it all from there if you’d like paper.`;
  const answer = ask ? ruled(`<p class="ink" style="margin:0 0 12px;font-weight:700;">Will you be there?</p>${answerButtons(m, links)}${small('One tap answers. No sign-in needed.')}`) : '';
  const docsHtml = [...titles.map((t) => esc(t)), hidden ? `${plural(hidden, 'board-only document')}` : ''].filter(Boolean).join('<br>');
  return {
    subject: `${test ? '[Preview] ' : ''}The agenda and documents: ${name}, ${shortDate(m.date)}`,
    html: emailShell({
      eyebrow: 'SOARD Board',
      preheader: `${whenOf(m)}. The agenda${count ? ' and documents are' : ' is'} on the board page.`,
      heading: `The agenda and documents for the ${name}`,
      intro: esc(lead),
      bodyHtml: meetingFacts(m, [['Documents', docsHtml]])
        + `<div style="margin:18px 0 0;">${button('Open the agenda and documents', meetingUrl(m))}</div>`
        + small(SIGN_IN)
        + answer,
      footerHtml: FOOTER,
    }),
    text: [`The agenda and documents for the ${name}.`, lead, factsText(m),
      count ? `Documents: ${[...titles, hidden ? plural(hidden, 'board-only document') : ''].filter(Boolean).join(', ')}` : '',
      `Open the agenda and documents: ${meetingUrl(m)}\n${SIGN_IN}`,
      ask ? `Will you be there? One tap answers, no sign-in needed.\n${answerText(m, links)}` : ''].filter(Boolean).join('\n\n'),
  };
}

/** The documents an email may name: the board's files, never one that goes with a board-only item → { names, hidden } */
export function packetDocs(m) {
  const secret = new Set(m.sections.flatMap((s) => s.items.filter((it) => it.confidential).flatMap((it) => it.docs || [])));
  const docs = m.files.filter((f) => !f.staffOnly && f.kind !== 'signed' && f.kind !== 'minutes');
  return { names: docs.filter((f) => !secret.has(f.id)).map((f) => f.name), hidden: docs.filter((f) => secret.has(f.id)).length };
}

/** Each email on its own: each member's has their own answer links */
const sendEach = (env, items, { tags, replyTo }) => sendEmailItems(env, items, { from: fromBoard(), tags, replyTo });

/** Email the board the link to the agenda and documents, what the documents are, and one-tap answers (test: only `to`) */
export async function sendPacket(env, id, { by, to = null, replyTo = [] } = {}) {
  const m = await getMeeting(env.DB, id);
  if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
  if (!emailConfigured(env)) throw Object.assign(new Error('Email isn’t set up (RESEND_API_KEY)'), { status: 503 });
  const test = Array.isArray(to);
  if (!test && !m.shared) throw Object.assign(new Error('Share the meeting with the board first, so the button has something to open'), { status: 409 });
  const people = test ? to.map((email) => ({ email, name: '' })) : await packetList(env.DB);
  if (!people.length) throw Object.assign(new Error('No board member has an email on file (People → Board)'), { status: 409 });
  const docs = packetDocs(m);
  // Only someone who hasn't said whether they'll come is asked, with their own links
  const open = test ? [] : (await notAnswered(env, m)).map((p) => p.slug);
  const links = await answerLinks(env.DB, m, open);
  const items = people.map((p) => ({ to: p.email, ...packetEmail(m, { test, files: docs.names, private: docs.hidden, name: p.name, links: links[p.slug], ask: test || open.includes(p.slug) }) }));
  const tags = [{ name: 'kind', value: test ? 'board-packet-preview' : 'board-packet' }];
  const r = await sendEach(env, items, { tags, replyTo });
  if (!test && r.sent) await writeMeeting(env.DB, { ...m, packetSentAt: nowIso(), packetSentTo: r.sent, updatedAt: m.updatedAt, updatedBy: m.updatedBy });
  return { sent: r.sent, failed: r.failed, errors: r.errors, to: test ? to : undefined, documents: docs.names.length + docs.hidden };
}

/** The board approved a meeting's minutes (at a later meeting, on its date) */
export async function approveMinutes(env, id, { on, by }) {
  const m = await getMeeting(env.DB, id);
  if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
  return saveMeeting(env.DB, { ...m, minutes: 'approved', approvedOn: isDate(on) ? on : todayEastern() }, { by });
}

/** Board members who haven't said whether they'll come, here or on the calendar invite */
export async function notAnswered(env, m) {
  const list = await packetList(env.DB);
  return list.filter((p) => {
    const here = m.attendance.find((a) => a.slug === p.slug);
    const invite = repliesOf(m)[p.slug];
    return !(here?.rsvp) && !['accepted', 'declined', 'tentative'].includes(invite);
  });
}

/** The reminder, for one board member: three one-tap answers, then when and where */
export function reminderEmail(m, { test = false, name: who = '', links = null } = {}) {
  const name = meetingName(m);
  const first = firstName(who);
  const heading = `${first ? `${first}, will` : 'Will'} you be at the ${name}?`;
  return {
    subject: `${test ? '[Preview] ' : ''}Will you be at the ${name}? ${shortDate(m.date)}`,
    html: emailShell({
      eyebrow: 'SOARD Board',
      preheader: `${whenOf(m)}. One tap answers; no sign-in needed.`,
      heading,
      intro: esc('One tap answers. You don’t need to sign in.'),
      bodyHtml: `<div style="margin:4px 0 14px;">${answerButtons(m, links, { lead: true })}</div>`
        + meetingFacts(m)
        + `<div style="margin:10px 0 0;">${small(`The agenda and documents: ${link('the board page', meetingUrl(m))}. ${SIGN_IN}`)}</div>`,
      footerHtml: FOOTER,
    }),
    text: [heading, `One tap answers. You don't need to sign in.\n${answerText(m, links)}`, factsText(m), `The agenda and documents: ${meetingUrl(m)}`].join('\n\n'),
  };
}

/** Ask the board members who haven't answered whether they'll come, each with their own one-tap answers (test: only `to`) */
export async function remindRsvp(env, id, { to = null, replyTo = [] } = {}) {
  const m = await getMeeting(env.DB, id);
  if (!m?.shared) throw Object.assign(new Error('Share the meeting with the board first, so the button has something to open'), { status: 409 });
  const test = Array.isArray(to);
  const people = test ? to.map((email) => ({ email, name: '' })) : await notAnswered(env, m);
  if (!people.length) throw Object.assign(new Error('Everyone has answered'), { status: 409 });
  const links = test ? {} : await answerLinks(env.DB, m, people.map((p) => p.slug));
  const items = people.map((p) => ({ to: p.email, ...reminderEmail(m, { test, name: p.name, links: links[p.slug] }) }));
  const r = await sendEach(env, items, { tags: [{ name: 'kind', value: test ? 'board-reminder-preview' : 'board-reminder' }], replyTo });
  return { sent: r.sent, failed: r.failed, errors: r.errors, to: test ? to : undefined };
}

/** The minutes notice: which meeting, and (a draft) when the board votes on them */
export function minutesEmail(m, { test = false, next = null } = {}) {
  const name = meetingName(m);
  const approved = m.minutes === 'approved';
  const intro = approved
    ? `The board approved them${m.approvedOn ? ` on ${longDate(m.approvedOn)}` : ''}.`
    : 'The board votes on them at the next meeting. Reply if anything needs correcting.';
  return {
    subject: `${test ? '[Preview] ' : ''}${approved ? 'Minutes' : 'Draft minutes'}: ${name}, ${shortDate(m.date)}`,
    html: emailShell({
      eyebrow: 'SOARD Board',
      preheader: intro,
      heading: `The ${approved ? '' : 'draft '}minutes of the ${name} are up`,
      intro: esc(intro),
      bodyHtml: facts([['Meeting', esc(longDate(m.date))], ['Next meeting', next ? esc(whenOf(next)) : '']])
        + `<div style="margin:18px 0 0;">${button('Read the minutes', meetingUrl(m))}</div>`
        + small(`${SIGN_IN} The minutes stay on the board page; they are never emailed.`),
      footerHtml: FOOTER,
    }),
    text: [`The ${approved ? '' : 'draft '}minutes of the ${name} (${longDate(m.date)}) are up.`, intro, `Read them: ${meetingUrl(m)}\n${SIGN_IN}`].join('\n\n'),
  };
}

/** Tell the board the minutes are on the board page (test: only `to`) */
export async function sendMinutesNotice(env, id, { to = null, replyTo = [] } = {}) {
  const m = await getMeeting(env.DB, id);
  if (!m?.shared) throw Object.assign(new Error('Share the minutes with the board first'), { status: 409 });
  const list = Array.isArray(to) ? to : (await packetList(env.DB)).map((p) => p.email);
  if (!list.length) throw Object.assign(new Error('No board member has an email on file (People → Board)'), { status: 409 });
  const next = (await listMeetings(env.DB)).filter((x) => x.date > m.date).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  const mail = minutesEmail(m, { test: Array.isArray(to), next });
  const r = await sendEmails(env, { to: list, ...mail, from: fromBoard(), tags: [{ name: 'kind', value: Array.isArray(to) ? 'board-minutes-preview' : 'board-minutes' }], replyTo });
  if (!Array.isArray(to) && r.sent) await writeMeeting(env.DB, { ...m, minutesSentAt: nowIso(), updatedAt: m.updatedAt, updatedBy: m.updatedBy });
  return { sent: r.sent, failed: r.failed, errors: r.errors, to: Array.isArray(to) ? to : undefined };
}

// Plain text: Google copies an invite's notes into its .ics as they are, and
// Apple Calendar and Outlook would show HTML as tags
/** Where Board's part of an invite's notes starts (the organizer's own notes stay above it) */
export const NOTES_START = 'The agenda and documents:';
/** What Board's part started with before, still found and replaced (Oct 2026) */
export const OLD_NOTES_STARTS = ['The agenda and the packet are on the board page:'];
/**
 * What a meeting's calendar invite says: the way to its page (the agenda and every document are there, to read,
 * present or print) and that replies count. Nothing else, so the agenda changing never touches the invite.
 */
export function inviteNotes(m) {
  return [
    `${NOTES_START} ${meetingUrl(m)}`,
    'Sign in with the email address this invite came to; you’ll get a one-time code.',
    '',
    'Your reply to this invite shows on the board page.',
  ].join('\n');
}

/** A meeting as a calendar file, for a board member who isn't on its invite */
export function meetingIcs(m) {
  const stamp = (d, t) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date(`${d}T${t}:00Z`)).find((x) => x.type === 'timeZoneName')?.value || 'GMT-5';
    const [, sign, hh] = p.match(/GMT([+-])(\d{1,2})/) || [null, '-', '5'];
    return new Date(Date.parse(`${d}T${t}:00Z`) - (sign === '-' ? -1 : 1) * Number(hh) * 3_600_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  const start = m.start || '08:00';
  const end = m.end || `${String(Math.min(23, Number(start.slice(0, 2)) + 2)).padStart(2, '0')}${start.slice(2)}`;
  const esc2 = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sunshine on a Ranney Day//Board//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:board-${m.id}@sunshineonaranneyday.com`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`, `DTSTART:${stamp(m.date, start)}`, `DTEND:${stamp(m.date, end)}`,
    `SUMMARY:${esc2(`SOARD ${meetingName(m)}`)}`, ...(m.location || m.address ? [`LOCATION:${esc2([m.location, m.address].filter(Boolean).join(', '))}`] : []),
    `DESCRIPTION:${esc2(`${inviteNotes(m)}${m.video ? `\n\nVideo (${callName(m.video)}): ${m.video}` : ''}`)}`, `URL:${meetingUrl(m)}`,
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

/** The email that tells a board member their page is ready, and how to sign in */
export function welcomeEmail({ name = '', email = '', test = false } = {}) {
  const url = `${SITE}/board`;
  const first = String(name).split(/\s+/)[0];
  return {
    subject: `${test ? '[Preview] ' : ''}Your SOARD board page is ready`,
    html: emailShell({
      eyebrow: 'SOARD Board',
      preheader: 'Meetings, minutes, financials and reveals in one place. Sign in with this email address.',
      heading: first ? `${first}, your board page is ready` : 'Your board page is ready',
      intro: 'Everything for the board, in one place: the next meeting and its agenda, past minutes, the financials, upcoming reveals, and the documents to sign.',
      bodyHtml: `<div style="margin:4px 0 16px;">${button('Open the board page', url)}</div>`
        + `<p class="ink" style="margin:0 0 10px;font-weight:700;">Signing in takes a minute</p>`
        + `<ol class="ink" style="margin:0 0 14px 18px;padding:0;"><li style="margin:0 0 6px;">Open <a href="${esc(url)}" style="color:#2B6CB0;">sunshineonaranneyday.com/board</a>.</li>`
        + `<li style="margin:0 0 6px;">Type ${email ? `<strong>${esc(email)}</strong>` : 'this email address'} and choose Send code.</li>`
        + '<li style="margin:0 0 6px;">Copy the six-digit code from the email that arrives, and paste it in.</li></ol>'
        + '<p class="muted" style="margin:0;font-size:13px;color:#5A5B61;">You stay signed in on that device for a week. Bookmark the page, or save it to your phone’s home screen.</p>',
      footerHtml: FOOTER,
    }),
    text: `Your SOARD board page is ready: ${url}\nSign in with ${email || 'this email address'}: choose Send code, then paste the six-digit code from the email that arrives.`,
  };
}

/** Email each active board member (on their own) how to sign in; test: only `to` */
export async function sendWelcome(env, { to = null, slugs = null, replyTo = [] } = {}) {
  if (!emailConfigured(env)) throw Object.assign(new Error('Email isn’t set up (RESEND_API_KEY)'), { status: 503 });
  const people = Array.isArray(to) ? to.map((email) => ({ email, name: '' })) : (await packetList(env.DB)).filter((p) => !slugs || slugs.includes(p.slug));
  if (!people.length) throw Object.assign(new Error('No board member has an email on file (People → Board)'), { status: 409 });
  let sent = 0; let failed = 0; const errors = [];
  for (const p of people) {
    const mail = welcomeEmail({ name: p.name, email: p.email, test: Array.isArray(to) });
    const r = await sendEmails(env, { to: [p.email], ...mail, from: fromBoard(), tags: [{ name: 'kind', value: Array.isArray(to) ? 'board-welcome-preview' : 'board-welcome' }], replyTo });
    sent += r.sent; failed += r.failed; errors.push(...r.errors);
  }
  if (!Array.isArray(to) && sent) await writeState(env.DB, 'welcome', { sentAt: nowIso(), sent });
  return { sent, failed, errors, to: Array.isArray(to) ? to : undefined };
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
  // The Board area's admins by their names on People; who to ask is the one the invites come from
  const nameOf = (e) => people.staff.find((p) => e.startsWith(`${String(p.name).split(/\s+/)[0].toLowerCase()}@`))?.name || e.split('@')[0];
  const admins = settings.admins.map((e) => ({ email: e, name: nameOf(e) }));
  const contact = admins.find((a) => a.email === settings.invitesFrom) || admins[0] || null;
  // The next meeting ahead the board already has on its calendars, before it's shared here: when and where only,
  // never its agenda, notes, files or numbers. None once a shared meeting comes first (or the same day)
  const sharedNext = nextMeeting(shared, today);
  const ahead = meetings.filter((m) => !m.shared && onBoardPage(m, today)).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  const pending = ahead && !(sharedNext && sharedNext.date <= ahead.date) ? ahead : null;
  const pendingInvite = pending && mine ? repliesOf(pending)[mine] || '' : '';
  // An admin looking at the board page: today's practice meeting, if they've started one (members never see it)
  const practice = admin && !member ? await todayPractice(env.DB, now) : null;
  return {
    ...(admin && !member ? { practice: practice ? { id: practice.id, title: meetingName(practice), date: practice.date, live: practice.live } : null } : {}),
    contact,
    admins: admins.map((a) => a.name),
    nextPending: pending ? {
      id: pending.id, date: pending.date, start: pending.start, end: pending.end, title: pending.title, name: meetingName(pending),
      location: pending.location, address: pending.address, video: pending.video || pending.invite?.meet || '',
      onCalendar: !!pendingInvite, myInvite: pendingInvite, myRsvp: answers[pending.id] || '',
    } : null,
    me: member ? { name: member.name, slug: member.slug, title: member.title, email: member.email, admin } : { name: null, slug: null, admin },
    today,
    // Their own answer here, else how they answered the calendar invite (which also means it's on their calendar)
    meetings: shared.map((m) => {
      const invite = mine ? repliesOf(meetings.find((x) => x.id === m.id))[mine] || '' : '';
      return { ...m, myRsvp: answers[m.id] || '', myInvite: invite, onCalendar: !!invite };
    }),
    next: nextMeeting(shared, today)?.id || null,
    quorum: settings.quorum,
    actions: openActions(shared).map((a) => ({ ...a, mine: !!mine && a.owner === mine })),
    docs: docs.filter((d) => d.shared).map((d) => ({ ...d, file: d.file && !d.file.staffOnly ? d.file : null, signedByMe: mine ? d.signed[mine] || null : null, signedCount: Object.keys(d.signed).length })),
    numbers,
    // Cash at each month's end: QuickBooks' own month-ends once it's connected (13 of them, the books'), else the banks' history
    cashHistory: numbers.books?.months?.length > 1 ? [...numbers.books.months].reverse().map((r) => ({ month: r.month, total: r.total, at: r.end })) : history,
    // The public copies, through the site's own /files/ route so the page's viewer can open them
    filings: (filings?.documents || []).map((d) => ({ title: d.title, year: d.year, type: d.type, url: String(d.url || '').replace(/^https:\/\/files\.sunshineonaranneyday\.com\/financials\//, '/files/financials/') }))
      .filter((d) => /^(https:\/\/|\/files\/financials\/)/.test(d.url)),
    snapshot: snapshot || null,
    people: {
      board: people.board.map(({ email, ...p }) => ({ ...p, email: email || null })),
      staff: people.staff.map(({ email, ...p }) => p),
      advisory: people.advisory.map(({ email, ...p }) => p),
    },
  };
}

// ─── A meeting as it's held ─────────────────────────────────────────
//
// The chair runs the meeting from the Board area (public/admin/board-meeting.js, During): starts it, moves item by
// item, opens and closes votes. Board members follow it on the board page (GET /api/board-portal?live=<id>, every
// few seconds): the item being discussed, who's here, the vote that's open. They check in and vote there; the chair's
// screen sees both (GET /api/board-admin?live=<id>). A practice meeting runs the same way with simulated members.

const fnv = (s) => { let h = 0x811c9dc5; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
const isoOf = (ms) => new Date(ms).toISOString();
const HOW = ['present', 'remote'];
const VOTE_CHOICES = ['for', 'against', 'abstain'];
const err = (message, status) => Object.assign(new Error(message), { status });

/**
 * A practice meeting's simulated board members, worked out from the clock (never stored, the same on every
 * screen): each checks in 3 to 40 seconds after the chair starts, most in the room, some by video, one or two
 * never. → [{ slug, name, how, at, simulated }]
 */
export function simulatedCheckins(m, now = Date.now()) {
  const t0 = Date.parse(m?.live?.startedAt || '');
  if (!m?.practice || !Number.isFinite(t0)) return [];
  const hashed = m.attendance.filter((p) => p.kind === 'board' && p.slug).map((p) => ({ p, h: fnv(`${m.id}:${p.slug}`) }));
  const never = hashed.length > 3 ? hashed.reduce((a, b) => (b.h < a.h ? b : a)).p.slug : '';
  return hashed.flatMap(({ p, h }) => {
    const r = h % 100;
    if (p.slug === never || r < 7) return [];
    const t = t0 + (3 + ((h >>> 8) % 38)) * 1000;
    return t <= now ? [{ slug: p.slug, name: p.name, how: r < 27 ? 'remote' : 'present', at: isoOf(t), simulated: true }] : [];
  });
}
/** …and each simulated member who's here votes 2 to 14 seconds after the vote opens (or after arriving), mostly for */
export function simulatedVotes(m, vote, checkins, now = Date.now()) {
  const t1 = Date.parse(vote?.openedAt || '');
  if (!m?.practice || !Number.isFinite(t1)) return [];
  return checkins.filter((c) => c.simulated).flatMap((c) => {
    const h = fnv(`${m.id}:${vote.motionId}:${c.slug}`);
    const t = Math.max(t1, Date.parse(c.at)) + (2 + (h % 13)) * 1000;
    if (t > now) return [];
    const r = (h >>> 8) % 20;
    return [{ slug: c.slug, name: c.name, vote: r === 0 ? 'against' : r === 1 ? 'abstain' : 'for', at: isoOf(t), simulated: true }];
  });
}

/** An admin practising, as one more member: { slug: 'admin:peter', name: their name on People } */
async function adminVoter(DB, email) {
  const e = String(email || '').toLowerCase();
  const local = e.split('@')[0].replace(/[^a-z0-9.-]/g, '') || 'you';
  const people = await roster(DB);
  const name = people.staff.find((p) => e.startsWith(`${String(p.name).split(/\s+/)[0].toLowerCase()}@`))?.name || local[0].toUpperCase() + local.slice(1);
  return { slug: `admin:${local}`, name };
}

/** The meeting someone follows live: a member, a shared one (acting); an admin, a shared one (looking) or a practice one (acting) */
async function liveMeeting(DB, id, { member = null, admin = false } = {}) {
  if (!ID.test(String(id || ''))) throw err('Which meeting?', 400);
  const m = await getMeeting(DB, id);
  if (m) {
    if (!m.shared) throw err('That meeting isn’t on the board page', 404);
    return { m, canAct: !!member };
  }
  const p = admin && !member ? await getPractice(DB, id) : null;
  if (!p) throw err('That meeting isn’t on the board page', 404);
  return { m: p, canAct: true };
}

/** Check-ins (real, and a practice meeting's simulated ones), who's here, and the votes by motion */
async function liveRows(DB, m, now) {
  const [ci, vs] = await Promise.all([
    DB.prepare('SELECT slug, name, how, at FROM board_checkins WHERE meeting_id = ?').bind(m.id).all().then((r) => r.results || []),
    DB.prepare('SELECT motion_id, slug, name, vote, at FROM board_votes WHERE meeting_id = ?').bind(m.id).all().then((r) => r.results || []),
  ]);
  const real = new Map(ci.map((c) => [c.slug, { slug: c.slug, name: c.name || '', how: c.how, at: c.at || '' }]));
  const checkins = [...simulatedCheckins(m, now).filter((c) => !real.has(c.slug)), ...real.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // Here: board members the chair marked there, then anyone who checked in (practising, the admin is one more)
  const board = m.attendance.filter((p) => p.kind === 'board');
  const here = new Map();
  for (const p of board) if (p.status === 'present' || p.status === 'remote') here.set(p.slug || p.key, p.status);
  for (const c of checkins) {
    if (here.has(c.slug)) continue;
    if (board.some((p) => p.slug === c.slug) || (m.practice && c.slug.startsWith('admin:'))) here.set(c.slug, c.how);
  }
  // Votes by motion: an open vote counts only what came in since it opened (a vote taken again starts over)
  const vote = isLive(m) && m.live.vote && m.motions.some((x) => x.id === m.live.vote.motionId) ? m.live.vote : null;
  const votes = {};
  for (const v of vs) {
    if (vote && v.motion_id === vote.motionId && vote.openedAt && String(v.at) < vote.openedAt) continue;
    (votes[v.motion_id] ||= []).push({ slug: v.slug, name: v.name || '', vote: v.vote, at: v.at || '' });
  }
  if (vote) {
    const cast = new Set((votes[vote.motionId] || []).map((v) => v.slug));
    votes[vote.motionId] = [...(votes[vote.motionId] || []), ...simulatedVotes(m, vote, checkins, now).filter((v) => !cast.has(v.slug))]
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
  return { checkins, here, votes, vote, board };
}

/**
 * GET /api/board-portal?live=<id>: the meeting as it's held, for the board page (cheap: no JobTread or Mercury).
 * Never a private note. The quorum is Settings' number when set, else a majority of the board on the list.
 * `here.met` is null only when the meeting has no board members on its list.
 */
export async function liveView(env, id, { member = null, admin = false, adminEmail = '', now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const { m, canAct } = await liveMeeting(env.DB, id, { member, admin });
  const [settings, rows] = await Promise.all([getSettings(env.DB), liveRows(env.DB, m, now)]);
  const { here, votes, vote, board, checkins } = rows;
  const me = member ? { slug: member.slug, name: member.name } : canAct ? await adminVoter(env.DB, adminEmail) : null;
  const seen = m.practice ? m : forBoard(m);
  const sections = seen.sections.map((sec) => ({
    id: sec.id, title: sec.title, minutes: sec.minutes || 0,
    items: sec.items.map((it) => ({ id: it.id, title: it.title, presenter: it.presenter, who: it.who, notes: it.notes, confidential: it.confidential, live: it.live, about: it.about, docs: it.docs })),
  }));
  // The last meeting's minutes, for an item that asks the board to approve them (only from a meeting the board can see)
  const prior = [];
  for (const id of new Set(seen.sections.flatMap((sec) => sec.items.filter((it) => it.live === 'minutes' && it.about).map((it) => it.about)))) {
    const prev = await getMeeting(env.DB, id);
    if (!prev?.shared) continue;
    const f = minutesFileOf(prev);
    // Its date and name for the screen's "since we last met"; its minutes for the item that approves them
    prior.push({ id: prev.id, date: prev.date, name: meetingName(prev), files: f ? [f] : [] });
  }
  const motion = vote ? m.motions.find((x) => x.id === vote.motionId) : null;
  const cast = motion ? votes[motion.id] || [] : [];
  const n = (v) => cast.filter((x) => x.vote === v).length;
  const marked = me ? m.attendance.find((p) => p.slug === me.slug && HOW.includes(p.status))?.status : '';
  const q = settings.quorum || majority(board.length + (m.practice ? 1 : 0));
  return {
    id: m.id, practice: !!m.practice, updatedAt: m.updatedAt, title: meetingName(m), date: m.date, start: m.start, end: m.end,
    live: { startedAt: m.live.startedAt, endedAt: m.live.endedAt, itemId: m.live.itemId, fileId: m.live.fileId, page: m.live.page, screen: m.live.screen, sectionId: m.live.sectionId, sectionAt: m.live.sectionAt, floor: m.live.floor },
    sections,
    // What the screen shows: the board's files (never a staff-only one), the last meeting's minutes, the locked numbers
    files: seen.files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, kind: f.kind, at: f.at })),
    prior,
    snapshot: m.snapshot || null,
    here: { board: here.size, of: board.length + (m.practice ? 1 : 0), quorum: q, met: q ? here.size >= q : null, remote: [...here.values()].filter((h) => h === 'remote').length },
    me: { how: (me && (checkins.find((c) => c.slug === me.slug)?.how || marked)) || '', canAct: !!(canAct && me), name: me?.name || '' },
    vote: motion ? {
      motionId: motion.id, text: motion.text, by: motion.by, second: motion.second, openedAt: vote.openedAt,
      counts: { for: n('for'), against: n('against'), abstain: n('abstain'), voted: cast.length, of: here.size },
      mine: (me && cast.find((x) => x.slug === me.slug)?.vote) || '',
    } : null,
    motions: m.motions.map((x) => ({ id: x.id, text: x.text, by: x.by, second: x.second, result: x.result, tally: x.tally })),
    actions: m.actions.map((a) => ({ id: a.id, text: a.text, ownerName: a.ownerName, owner: a.owner, due: a.due, done: a.done })),
  };
}

async function liveActor(env, m, canAct, { member, adminEmail, now }) {
  if (!canAct) throw err('Board members answer for themselves.', 403);
  const who = member ? { slug: member.slug, name: member.name } : await adminVoter(env.DB, adminEmail);
  const rl = await limit(env.DB, `board-live:${m.id}:${who.slug}`, 40, 60, { now });
  if (!rl.ok) throw err('That’s a lot of taps. Wait a few seconds and try again.', 429);
  return who;
}

/** POST { action: 'checkin', meetingId, how }: here in the room, or on video (a member on the meeting's day; an admin practising) */
export async function liveCheckIn(env, id, { member = null, admin = false, adminEmail = '', how, now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  if (!HOW.includes(how)) throw err('In the room, or on video?', 400);
  const { m, canAct } = await liveMeeting(env.DB, id, { member, admin });
  if (!m.practice && !isLive(m) && m.date !== todayEastern(now)) throw err('Checking in opens on the meeting’s day', 409);
  const who = await liveActor(env, m, canAct, { member, adminEmail, now });
  await env.DB.prepare('INSERT OR REPLACE INTO board_checkins (meeting_id, slug, name, how, at) VALUES (?, ?, ?, ?, ?)').bind(m.id, who.slug, who.name, how, isoOf(now)).run();
  return liveView(env, id, { member, admin, adminEmail, now });
}

/** POST { action: 'vote', meetingId, motionId, vote }: for, against or abstain, while the chair has that vote open (a change of mind counts) */
export async function liveVote(env, id, motionId, choice, { member = null, admin = false, adminEmail = '', now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  if (!VOTE_CHOICES.includes(choice)) throw err('For, against, or abstain?', 400);
  const { m, canAct } = await liveMeeting(env.DB, id, { member, admin });
  if (!isLive(m) || m.live.vote?.motionId !== motionId) throw err('That vote isn’t open', 409);
  const who = await liveActor(env, m, canAct, { member, adminEmail, now });
  const { here } = await liveRows(env.DB, m, now);
  if (!here.has(who.slug)) throw err('Check in first (in the room or on video), then vote', 409);
  await env.DB.prepare('INSERT OR REPLACE INTO board_votes (meeting_id, motion_id, slug, name, vote, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(m.id, motionId, who.slug, who.name, choice, isoOf(now)).run();
  return liveView(env, id, { member, admin, adminEmail, now });
}

/** GET /api/board-admin?live=<id>: the chair's screen, every few seconds: who checked in, and every vote by motion */
export async function chairLive(env, id, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  if (!ID.test(String(id || ''))) throw err('Which meeting?', 400);
  const m = (await getMeeting(env.DB, id)) || (await getPractice(env.DB, id));
  if (!m) throw err('That meeting is gone', 404);
  const { checkins, votes } = await liveRows(env.DB, m, now);
  return {
    checkins: checkins.map(({ slug, name, how, at }) => ({ slug, name, how, at })),
    votes: Object.fromEntries(Object.entries(votes).map(([k, list]) => [k, list.map(({ slug, name, vote, at }) => ({ slug, name, vote, at }))])),
  };
}

const easternHm = (ms) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York' }).format(new Date(ms));
async function clearPractice(DB, id, { remove = false } = {}) {
  await DB.prepare('DELETE FROM board_checkins WHERE meeting_id = ?').bind(id).run();
  await DB.prepare('DELETE FROM board_votes WHERE meeting_id = ?').bind(id).run();
  if (remove) await DB.prepare('DELETE FROM board_practice WHERE id = ?').bind(id).run();
}

/**
 * POST /api/board-admin { action: 'practice' }: today's practice meeting, made the first time. Only the admins see
 * it: the next meeting's agenda (else one drafted from the last, else Settings' outline), the real board as its
 * members (simulated once it starts), a motion to vote on. A week later it's cleared away. → the meeting
 */
export async function createPractice(env, { by = '', now = Date.now(), fresh = false } = {}) {
  await ensureSchema(env.DB);
  const today = todayEastern(now);
  if (!fresh) {
    const cur = await todayPractice(env.DB, now);
    if (cur?.borrowed) return cur;
    // One made before practice meetings had documents: a new one that has them
    if (cur) await clearPractice(env.DB, cur.id, { remove: true });
  }
  const weekAgo = todayEastern(now - 7 * 86_400_000);
  for (const r of (await env.DB.prepare('SELECT id FROM board_practice WHERE date < ?').bind(weekAgo).all()).results || []) await clearPractice(env.DB, r.id, { remove: true });
  const [meetings, settings, people] = await Promise.all([listMeetings(env.DB), getSettings(env.DB), roster(env.DB)]);
  const withAgenda = meetings.filter((x) => isDate(x.date) && x.sections.some((sec) => sec.items.length));
  const ahead = withAgenda.filter((x) => x.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  const last = withAgenda.filter((x) => x.date < today)[0];
  const base = newMeeting({
    date: today, template: settings.template, meetings: [], defaults: settings.defaults,
    board: people.board.map((p) => ({ slug: p.slug, name: p.name, org: p.organization })),
    staff: people.staff.filter((p) => /founder/i.test(p.title)).map((p) => ({ slug: p.slug, name: p.name })),
  });
  // Its documents are borrowed, never copied: the files stay the real meeting's (getPractice reads them as they are now)
  const shown = (x) => (x?.files || []).filter((f) => !f.staffOnly && f.kind !== 'signed');
  const borrowed = shown(ahead).map((f) => f.id);
  // Its own ids, and no link back to a real meeting (its minutes item can't approve anything). The minutes it would
  // approve stay on that item, as the screen shows them at the real meeting
  const own = (sections) => sections.map((sec) => ({ ...sec, id: uid('s_'), items: sec.items.map((it) => {
    const prev = it.live === 'minutes' && it.about ? meetings.find((x) => x.id === it.about) : null;
    const f = prev?.shared ? minutesFileOf(prev) : null;
    if (f && !borrowed.includes(f.id)) borrowed.push(f.id);
    return { ...it, id: uid('i_'), about: '', docs: f ? [f.id, ...(it.docs || []).filter((d) => d !== f.id)] : it.docs };
  }) }));
  const sections = own(ahead ? ahead.sections : last ? draftAgenda(last, { template: settings.template }) : base.sections);
  const startMin = Math.floor(((([h, mm]) => h * 60 + mm)(easternHm(now).split(':').map(Number))) / 5) * 5;
  const hm = (min) => `${String(Math.floor(Math.min(min, 1439) / 60)).padStart(2, '0')}:${String(Math.min(min, 1439) % 60).padStart(2, '0')}`;
  const m = cleanMeeting({
    ...base, id: uid('m_'), date: today, start: hm(startMin), end: hm(startMin + 60), title: 'Practice meeting', location: '', address: '', video: '',
    practice: true, shared: false, sections, actions: [],
    motions: [{ id: uid('v_'), text: last ? `Approve the minutes of the ${meetingName(last)}` : 'Approve the agenda as written', by: '', second: '', result: 'passed' }],
    agendaFrom: { kind: 'typed', name: '', at: isoOf(now) }, createdAt: isoOf(now), updatedAt: isoOf(now), updatedBy: by,
  });
  // The next meeting has no documents yet: the last meeting's, each with the item it fits (as an upload is placed)
  let docsFrom = '';
  if (!shown(ahead).length) {
    const prev = meetings.find((x) => isDate(x.date) && x.date < today && !x.notBoard && shown(x).some((f) => f.kind !== 'agenda' && !borrowed.includes(f.id)));
    // (never its old agenda: the practice has its own)
    for (const f of shown(prev).filter((x) => x.kind !== 'agenda' && !borrowed.includes(x.id))) {
      borrowed.push(f.id);
      const at = guessItem(m, f, today);
      if (at) m.sections = m.sections.map((sec) => ({ ...sec, items: sec.items.map((it) => (it.id === at ? { ...it, docs: [...it.docs, f.id] } : it)) }));
    }
    if (prev) docsFrom = prev.date;
  }
  await writeMeeting(env.DB, { ...m, borrowed, docsFrom });
  return getPractice(env.DB, m.id);
}

/** POST { action: 'practice-reset', id }: start over (a new practice meeting; the old one's taps and votes go) */
export async function resetPractice(env, id, { by = '', now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  if (!(await getPractice(env.DB, id))) throw err('That practice meeting is gone', 404);
  await clearPractice(env.DB, id, { remove: true });
  return createPractice(env, { by, now, fresh: true });
}

/** For the admin's Members tab: each active board member, their email on file, last visit and this year's signatures */
export async function memberStatus(DB) {
  await ensureSchema(DB);
  const [board, seen] = await Promise.all([activeBoard(DB), DB.prepare('SELECT slug, at FROM board_seen').all().then((r) => Object.fromEntries((r.results || []).map((x) => [x.slug, x.at])))]);
  return board.sort(comparePeople).map((p) => ({ slug: p.slug, name: p.name, title: p.title || '', seat: p.seat || '', email: p.email, lastSeen: seen[p.slug] || null }));
}

// ─── The heartbeat ──────────────────────────────────────────────────

/**
 * Each meeting ahead whose agenda nobody has written (SOARD's usual outline,
 * or a draft) follows the last agenda someone wrote or emailed: drafted from
 * it (draftAgenda), and drafted again when a newer one comes in. An agenda
 * emailed for the meeting itself replaces the draft (./_board-mail.js); a
 * person's change makes it theirs. Every ten minutes at most. → ids drafted
 */
/** A fresh draft keeps the documents already put with its items (by item name), so drafting again never strands a file */
function keepDocs(was, draft) {
  const docsOf = new Map(was.flatMap((s) => s.items).filter((it) => it.docs?.length).map((it) => [it.title.toLowerCase(), it.docs]));
  return draft.map((s) => ({ ...s, items: s.items.map((it) => (docsOf.has(it.title.toLowerCase()) ? { ...it, docs: docsOf.get(it.title.toLowerCase()) } : it)) }));
}

/**
 * On a meeting's day, its numbers are locked by themselves (the makeovers, reveals, events and money as they stand
 * that morning), so the minutes keep what the board saw. Once; the chair's Start locks them too if this hasn't yet
 */
export async function maybeLockNumbers(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const today = todayEastern(now);
  const locked = [];
  try {
    for (const m of (await listMeetings(env.DB)).filter((x) => x.date === today && !x.snapshot && !x.notBoard && x.sections.some((s) => s.items.length))) {
      await takeSnapshot(env, m.id, { by: 'Board', fetchImpl, now });
      locked.push(m.id);
    }
  } catch (err) {
    console.error('[board] locking numbers', err.message);
  }
  return locked;
}

export async function maybeDraftAgendas(env, { now = Date.now() } = {}) {
  try {
    const runs = await readState(env.DB, 'runs');
    if (runs.draftAt && now - Date.parse(runs.draftAt) < 10 * 60 * 1000) return [];
    await writeState(env.DB, 'runs', { ...runs, draftAt: new Date(now).toISOString() });
    const [meetings, settings] = await Promise.all([listMeetings(env.DB), getSettings(env.DB)]);
    const today = todayEastern(now);
    const drafted = [];
    const real = meetings.filter((x) => !x.notBoard);
    for (const m of real.filter((x) => x.date >= today && agendaIsDraft(x, settings.template))) {
      const prev = draftSource(m, real, settings.template);
      // Already drafted from it, unless that agenda was read again (from Drive or email) since
      const since = prev?.agendaFrom?.at && m.agendaFrom?.at && prev.agendaFrom.at > m.agendaFrom.at;
      // A draft an older drafter made is drafted again (DRAFTER: the minutes item and the live facts are found better now)
      const current = m.agendaFrom?.kind === 'last-meeting' && m.agendaFrom.name === draftName(prev) && (m.agendaFrom.v || 1) >= DRAFTER;
      if (!prev || (current && !since)) continue;
      const done = await patchMeeting(env.DB, m.id, (cur) => (agendaIsDraft(cur, settings.template)
        ? { ...cur, sections: keepDocs(cur.sections, draftAgenda(prev, { template: settings.template })), agendaFrom: { kind: 'last-meeting', name: draftName(prev), at: new Date(now).toISOString(), v: DRAFTER } }
        : cur));
      if (done) drafted.push(m.id);
    }
    return drafted;
  } catch (err) {
    console.error('[board] agenda drafts', err.message);
    return [];
  }
}

/**
 * Once for each newer agenda reader (board-shared.js AGENDA_READER): an agenda
 * an older reader filled from an emailed file, nobody has changed since, read
 * again from the copy Board keeps. Kept as it was when it reads no better.
 * Google Drive's are read again from Drive (./_board-drive.js). → ids read again
 */
export async function maybeRereadEmailAgendas(env, { now = Date.now() } = {}) {
  const done = [];
  try {
    for (const m of (await listMeetings(env.DB)).filter((x) => x.agendaFrom?.kind === 'email' && readAgain(x))) {
      const f = m.files.find((x) => x.name === m.agendaFrom.name);
      let parsed = null;
      if (f) { try { parsed = await readFileAsAgenda(env, f.id); } catch (err) { console.error('[board] reading again', f.name, err.message); } }
      const better = !!parsed?.sections.some((s) => s.items.length);
      await patchMeeting(env.DB, m.id, (cur) => (cur.agendaFrom?.kind === 'email' && readAgain(cur)
        ? { ...cur, ...(better ? { sections: parsed.sections } : {}), agendaFrom: { ...cur.agendaFrom, ...(better ? { at: new Date(now).toISOString() } : {}), v: AGENDA_READER } }
        : cur));
      if (better) done.push(m.id);
    }
  } catch (err) {
    console.error('[board] email agendas', err.message);
  }
  return done;
}

/**
 * The heartbeat, in order:
 *   - every 5 minutes at most, Access's board list kept in step with People → Board (./_board-access.js)
 *   - hourly, the board meetings on Peter and Holly's calendars (./_board-calendar.js)
 *   - each minute, a new place onto an invite that's out once it has settled; hourly until it
 *     passes, the check that Calendar, Meet, transcripts and attendance work (./_board-invite.js)
 *   - once a newer agenda reader ships, emailed agendas it reads better (maybeRereadEmailAgendas); then
 *   - every ten minutes, agendas nobody wrote drafted from the last one (maybeDraftAgendas), a meeting's
 *     numbers locked on its day (maybeLockNumbers), and
 *     who joined a Google Meet that ended (./_board-attendance.js)
 *   - last, past meetings from the Board folder in Google Drive (./_board-drive.js), then board mail
 *     (./_board-mail.js): every minute while there's a backlog, hourly after; then minutes read without
 *     Workers AI read again for their motions and action items (./_board-minutes.js maybeFinishMinutes)
 *   - hourly, QuickBooks' revenue and expenses for the year so far (./_quickbooks.js)
 *   - once a day, the month's bank balance for the board page's history
 * Never throws.
 */
export async function maybeRunBoard(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    await maybeSyncBoardAccess(env, { fetchImpl, now });
    await maybeSyncBoardCalendar(env, { fetchImpl, now });
    const invites = await import('./_board-invite.js');
    await invites.maybeRefreshInvites(env, { fetchImpl, now });
    await invites.maybeCheckInvites(env, { fetchImpl, now });
    await maybeRereadEmailAgendas(env, { now });
    await maybeDraftAgendas(env, { now });
    await maybeLockNumbers(env, { fetchImpl, now });
    await (await import('./_board-attendance.js')).maybeFillAttendance(env, { fetchImpl, now });
    // Last: past meetings' minutes and packets from Google Drive, then board mail (each reads for seconds while it has
    // a backlog; mail waits out a minute Drive was busy, so one heartbeat stays within its time)
    const drive = await (await import('./_board-drive.js')).maybeReadBoardDrive(env, { fetchImpl, now });
    if (!drive?.busy) {
      await maybeReadBoardMail(env, { fetchImpl, now });
      // Minutes read without Workers AI (it ran out of time): their motions and action items, one meeting at a time
      await (await import('./_board-minutes.js')).maybeFinishMinutes(env, { now });
    }
    // The banks connected through Plaid every six hours (they keep their own times), then the day's cash
    await (await import('./_plaid.js')).maybeReadBanks(env, { fetchImpl, now });
    // QuickBooks' year so far, hourly once it's connected
    await (await import('./_quickbooks.js')).maybeReadBooks(env, { fetchImpl, now });
    if (!String(env.MERCURY_API_TOKEN || '').trim() && !plaidConfigured(env)) return;
    const runs = await readState(env.DB, 'runs');
    if (runs.cashAt && now - Date.parse(runs.cashAt) < 20 * 60 * 60 * 1000) return;
    await writeState(env.DB, 'runs', { ...runs, cashAt: new Date(now).toISOString() });
    const cash = await cashNow(env, { fetchImpl });
    if (!cash) return;
    await writeState(env.DB, 'cash', { at: new Date(now).toISOString(), value: cash });
    // Months with nothing in the bank aren't history (Mercury's accounts were opened before the money moved)
    if (!(cash.total > 0)) { await env.DB.prepare('DELETE FROM board_cash WHERE total <= 0').run(); return; }
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
  const { inviteCheck } = await import('./_board-invite.js');
  const [a, cash, stored, cal, mail, pending, check, banks, books] = await Promise.all([
    accessStatus(env),
    env.DB.prepare('SELECT count(*) AS n, max(at) AS last FROM board_cash WHERE total > 0').first(),
    env.DB.prepare('SELECT data FROM board_meetings').all().then((r) => (r.results || []).map((x) => parse(x.data))),
    calendarStatus(env.DB),
    mailStatus(env.DB),
    readState(env.DB, 'invite-pending'),
    inviteCheck(env.DB),
    bankFacts(env),
    booksFacts(env),
  ]);
  const packet = stored.map((m) => m.packetSentAt).filter(Boolean).sort().at(-1) || null;
  const today = todayEastern();
  const invites = stored.filter((m) => m.invite?.eventId && m.date >= today);
  return {
    access: { configured: a.configured, ok: !!a.ok, attached: !!a.attached, current: !!a.current, emails: a.emails, missing: (a.missing || []).length, syncedAt: a.syncedAt || null, error: a.error ? String(a.error).replace(/\S+@\S+/g, '…').slice(0, 200) : null },
    cash: { mercury: Boolean(String(env.MERCURY_API_TOKEN || '').trim() && String(env.MERCURY_RELAY_KEY || '').trim()), months: cash?.n || 0, lastAt: cash?.last || null, empty: !((await readState(env.DB, 'cash')).value?.total > 0), readAt: (await readState(env.DB, 'cash')).at || null, banks },
    // QuickBooks' year so far for the board page (./_quickbooks.js): on/off, the company and times only
    books,
    lastPacketAt: packet,
    invite: {
      ahead: invites.length, needsSetup: invites.filter((m) => m.invite.transcript === 'needs-setup').length, failing: invites.filter((m) => m.invite.transcript === 'error').length,
      waiting: Object.keys(pending || {}).length, lastAt: stored.map((m) => m.invite?.updatedAt).filter(Boolean).sort().at(-1) || null,
      check: check ? { ok: !!check.ok, transcript: check.transcript || '', attendance: check.attendance || '', checkedAt: check.checkedAt || null, error: check.error ? String(check.error).replace(/\S+@\S+/g, '…').slice(0, 200) : null } : null,
    },
    // The agendas drafted from the last one, and who joined by Meet, for the meetings that had it
    drafts: { ahead: stored.filter((m) => m.date >= today && m.agendaFrom?.kind === 'last-meeting').length, lastAt: stored.map((m) => (m.agendaFrom?.kind === 'last-meeting' ? m.agendaFrom.at : '')).filter(Boolean).sort().at(-1) || null },
    attendance: {
      read: stored.filter((m) => m.fromMeet?.status === 'ok').length, needsSetup: stored.filter((m) => m.fromMeet?.status === 'needs-setup').length,
      failing: stored.filter((m) => m.fromMeet?.status === 'error').length, lastAt: stored.map((m) => m.fromMeet?.at).filter(Boolean).sort().at(-1) || null,
    },
    calendar: { configured: Boolean(env.GOOGLE_CALENDAR_KEY), ok: !!cal.ok, checkedAt: cal.checkedAt || null, found: cal.found || 0, failing: (cal.errors || []).length },
    mail: {
      configured: Boolean(env.GOOGLE_CALENDAR_KEY), ok: !!mail.ok, needsScope: !!mail.needsScope, checkedAt: mail.checkedAt || null, waiting: mail.backlog ?? mail.waiting ?? 0, failing: (mail.errors || []).length,
      meetings: mail.totals?.meetings || 0, files: mail.totals?.files || 0, skipped: mail.totals?.skipped || 0,
    },
    calendarPast: cal.past || 0,
    drive: await (await import('./_board-drive.js')).driveStatus(env.DB).then((d) => ({
      checkedAt: d.checkedAt || null, needsScope: !!d.needsScope, apiOff: !!d.apiOff, failing: (d.errors || []).length,
      backlog: d.backlog || 0, meetings: d.meetings || 0, files: d.files || 0,
    })),
  };
}
