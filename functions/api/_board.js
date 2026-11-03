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
 *   board_signatures    a member's signature on a paper every member signs, per
 *                       year: typed on the board page, their signed copy (a
 *                       board file owned 'signed', staff-only), or their copy
 *                       in Drive (./_board-drive.js), and the wording signed
 *   board_signatures_earlier  a member's signature on an earlier wording, kept
 *                       (its copy too) once they sign the next one
 *   board_doc_versions  each wording of a paper written in Board, kept: what
 *                       each signature was on
 *   board_seen         a member's last visit to the board page
 *   board_sign_asks    a member asked by email to sign this year's papers: when last, by whom, how many times
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
  longDate, timeRange, shortDate, DOC_KINDS, FILE_KINDS, RSVP, DEFAULT_TEMPLATE, newMeeting, LIMITS, repliesOf, inviteOut,
  agendaIsDraft, draftAgenda, draftSource, draftName, DRAFTER, callName, readAgain, AGENDA_READER, isLive, cleanLive, majority, guessItem, orgName, signsAs,
  isFilled, LIVE_TITLES, presentersOf, reportsOn, namesText,
} from '../../public/admin/board-shared.js';
import { welcomeHad, REPORT_LOOKS } from '../../public/admin/board-shared.js';
import { comparePeople, photoUrl } from '../../public/admin/team-shared.js';
import { reachedCount } from '../../public/admin/community-shared.js';
import { peopleRows, privateEmails, activeBoard, boardAdmins, readState, writeState, readSettings, normEmail, BOARD_PAGE } from './_board-roles.js';
import { cachedReveals, fetchJobs, loadKids, loadProjects, matchProject, isProject, isRehearsalJob, FIELD_JOB_STATUS, BUILDING_STATUSES } from './_reveals.js';
import { sendEmails, sendEmailItems, emailConfigured, EMAIL_FROM } from './_broadcast-notify.js';
import { isEmail } from './_broadcast-notify.js';
import { emailShell, button, esc, facts, link, panel, SANS, SERIF } from './_email-shell.js';
import { sniffType } from './upload-file.js';
import { maybeSyncBoardAccess } from './_board-access.js';
import { maybeSyncBoardCalendar, calendarStatus } from './_board-calendar.js';
import { pdfText } from './_vendor-read.js';
import { maybeReadBoardMail, mailStatus } from './_board-mail.js';
import { mercury } from './_mercury.js';
import { bankBalances, plaidConfigured, bankFacts } from './_plaid.js';
import { booksNow, booksFacts } from './_quickbooks.js';
import { giftsNow } from './_board-gifts.js';
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
  // An old one-tap answer link's token (its hash) from a board email before Nov 2 2026: ./_board-rsvp.js
  'CREATE TABLE IF NOT EXISTS board_rsvp_links (hash TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, slug TEXT NOT NULL, expires TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS board_docs (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE IF NOT EXISTS board_signatures (doc_id TEXT NOT NULL, slug TEXT NOT NULL, year INTEGER NOT NULL, name TEXT, at TEXT, PRIMARY KEY (doc_id, slug, year))',
  // A signature on an earlier version, kept (with its copy) when its member signs the next one
  'CREATE TABLE IF NOT EXISTS board_sign_asks (slug TEXT NOT NULL, year INTEGER NOT NULL, at TEXT NOT NULL, by TEXT, n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (slug, year))',
  'CREATE TABLE IF NOT EXISTS board_signatures_earlier (doc_id TEXT NOT NULL, slug TEXT NOT NULL, year INTEGER NOT NULL, version INTEGER NOT NULL, name TEXT, at TEXT, how TEXT, file_id TEXT, drive_id TEXT, drive_name TEXT, added_by TEXT, PRIMARY KEY (doc_id, slug, year, version))',
  'CREATE TABLE IF NOT EXISTS board_doc_versions (doc_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT, at TEXT, by TEXT, PRIMARY KEY (doc_id, version))',
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
  // How a signature came (SIGNED_BY), its copy, and who added it: Nov 2026
  for (const col of ['how', 'file_id', 'drive_id', 'drive_name', 'added_by']) {
    try { await DB.prepare(`ALTER TABLE board_signatures ADD COLUMN ${col} TEXT`).run(); } catch { /* already there */ }
  }
  // Which wording of a paper written in Board it signs (cleanDoc version)
  try { await DB.prepare('ALTER TABLE board_signatures ADD COLUMN version INTEGER').run(); } catch { /* already there */ }
  // What a wording was: words read from a file, or a new file the board signs again
  try { await DB.prepare('ALTER TABLE board_doc_versions ADD COLUMN note TEXT').run(); } catch { /* already there */ }
  // A paper's PDF's words, read once, for finding it by them on the board page ('' when it has none: a scan)
  try { await DB.prepare('ALTER TABLE board_files ADD COLUMN words TEXT').run(); } catch { /* already there */ }
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
    // Emails asking presenters for their reports (./_board-asks.js): 'test' (to the asker alone) until switched 'on'; or 'off'
    asks: ['on', 'off'].includes(s.asks) ? s.asks : 'test',
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
  if (patch.asks !== undefined) next.asks = ['on', 'off', 'test'].includes(patch.asks) ? patch.asks : 'test';
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

/**
 * Meetings with what lives beside them: their files and each action's done state. Who's coming is the calendar
 * invite's (repliesOf): answers once given on the board page or by email (board_rsvps) never show again
 */
async function withState(DB, meetings) {
  if (!meetings.length) return [];
  const [files, done] = await Promise.all([
    filesOf(DB, 'meeting'),
    DB.prepare('SELECT * FROM board_action_state').all().then((r) => Object.fromEntries((r.results || []).map((x) => [x.action_id, x]))),
  ]);
  return meetings.map((m) => cleanMeeting({
    ...m,
    files: files[m.id] || [],
    actions: m.actions.map((a) => (done[a.id] ? { ...a, done: !!done[a.id].done, doneOn: done[a.id].done_on || '' } : { ...a, done: false, doneOn: '' })),
    attendance: m.attendance.map((p) => ({ ...p, rsvp: '' })),
  }));
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
 * A newer updatedAt, so a copy open in an editor merges (`by`: the person, when one made the change). → the meeting
 */
export async function patchMeeting(DB, id, fn, { by = '' } = {}) {
  for (let i = 0; i < 5; i++) {
    const cur = await getMeeting(DB, id);
    if (!cur) return null;
    const next = { ...fn(cur), id, updatedAt: nowIso(), updatedBy: by || cur.updatedBy || '' };
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
    inviteGone: current?.inviteGone || '',
    // A meeting's day, time and place are typed in Board; a link to a calendar event older code made stays as it was
    calendar: current?.calendar || null,
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
  await stampReports(DB, next, current, { by, at });
  await writeMeeting(DB, next);
  return getMeeting(DB, m.id);
}

/**
 * Who wrote each report when, set here, never by the editor: a report changed in this save is the admin's (by
 * name), one that didn't change keeps who wrote it (a presenter on the board page, ./saveReport)
 */
async function stampReports(DB, next, current, { by, at }) {
  const was = new Map((current?.sections || []).flatMap((s) => s.items).map((it) => [it.id, it]));
  let name = null;
  for (const it of next.sections.flatMap((s) => s.items)) {
    const before = was.get(it.id);
    if ((it.report || '') === (before?.report || '')) {
      it.reportBy = before?.reportBy || (it.report ? it.reportBy : '');
      it.reportAt = before?.reportAt || (it.report ? it.reportAt : '');
      continue;
    }
    if (it.report && name === null) name = (await adminVoter(DB, by)).name;
    it.reportBy = it.report ? name : '';
    it.reportAt = it.report ? at : '';
  }
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

/**
 * An agenda item someone may write a report for, or put a document with: a board member who presents it (picked, or
 * named in its presenter line) on a meeting the board can see, until its minutes are approved; one of Board's admins,
 * any time. → { m, it }, else throws (404, 403, 409)
 */
export async function presenterGate(env, id, itemId, { member = null, admin = false } = {}) {
  if (!ID.test(String(id || '')) || !ID.test(String(itemId || ''))) throw err('Which item?', 400);
  const m = await getMeeting(env.DB, id);
  // A meeting ahead not shared yet opens to who presents in it (their report was asked for by email: _board-asks.js)
  const ahead = !!member && isDate(m?.date) && m.date >= todayEastern() && !m.notBoard;
  if (!m || (!admin && !forBoard(m) && !ahead)) throw err('That meeting isn’t on the board page', 404);
  const it = m.sections.flatMap((s) => s.items).find((x) => x.id === itemId);
  if (!it) throw err('That item isn’t on the agenda any more', 404);
  if (member) {
    const people = await roster(env.DB);
    if (!presentersOf(it, [...people.board, ...people.staff]).some((p) => p.slug === member.slug)) throw err('Only the person presenting this item can write its report or add documents to it', 403);
    if (m.minutes === 'approved') throw err('This meeting’s minutes are approved, so its reports stay as they were', 409);
  }
  return { m, it };
}

/** A file's kind by its name, as Board files a new one (financial statements, else other) */
const kindOfName = (name) => (/financ|balance|income|p&l|profit|loss|budget|statement/i.test(name) ? 'financials' : 'other');

/**
 * A document with an item, put there by who presents it on the board page (or an admin): stored as Board stores any,
 * then placed on the item, after its others. → { file, docs }
 */
export async function attachToItem(env, id, itemId, file, { member = null, admin = false, adminEmail = '' } = {}) {
  await ensureSchema(env.DB);
  const { it } = await presenterGate(env, id, itemId, { member, admin });
  if ((it.docs || []).length >= 20) throw err('That item has 20 documents already', 409);
  const stored = await putFile(env, { ownerType: 'meeting', ownerId: id, file, kind: kindOfName(file?.name || ''), by: member?.email || adminEmail });
  try {
    const saved = await patchMeeting(env.DB, id, (cur) => {
      if (!cur.sections.some((s) => s.items.some((x) => x.id === itemId))) throw err('That item isn’t on the agenda any more', 404);
      return { ...cur, sections: cur.sections.map((s) => ({ ...s, items: s.items.map((x) => (x.id === itemId ? { ...x, docs: [...(x.docs || []), stored.id] } : x)) })) };
    }, { by: member?.name || adminEmail });
    return { file: stored, docs: saved.sections.flatMap((s) => s.items).find((x) => x.id === itemId)?.docs || [] };
  } catch (e) {
    await deleteFile(env, stored.id); // never a file nothing shows
    throw e;
  }
}

/**
 * A document taken off an item on the board page: its presenter, only one they put there themselves (and it's gone
 * for good once nothing else has it); an admin, any (it stays with the meeting, as in Board). → { docs }
 */
export async function detachFromItem(env, id, itemId, fileId, { member = null, admin = false, adminEmail = '' } = {}) {
  await ensureSchema(env.DB);
  const { it } = await presenterGate(env, id, itemId, { member, admin });
  if (!(it.docs || []).includes(fileId)) throw err('That document isn’t with this item', 404);
  const row = await env.DB.prepare('SELECT by FROM board_files WHERE id = ?').bind(fileId).first();
  if (member && (!row || String(row.by || '').toLowerCase() !== String(member.email || '').toLowerCase())) throw err('Only Board’s admins can take off a document someone else put there', 403);
  const saved = await patchMeeting(env.DB, id, (cur) => ({ ...cur, sections: cur.sections.map((s) => ({ ...s, items: s.items.map((x) => (x.id === itemId ? { ...x, docs: (x.docs || []).filter((d) => d !== fileId) } : x)) })) }), { by: member?.name || adminEmail });
  if (member && !saved.sections.some((s) => s.items.some((x) => (x.docs || []).includes(fileId)))) await deleteFile(env, fileId);
  return { docs: saved.sections.flatMap((s) => s.items).find((x) => x.id === itemId)?.docs || [] };
}

/**
 * A report on an agenda item, written on the board page: by a board member who presents the item (picked, or named
 * in its presenter line) on a meeting the board can see, until its minutes are approved; or by one of Board's
 * admins, any time. `base` is the reportAt the writer started from: a report someone else saved since is refused
 * (409, with theirs as `current`), never written over. `look`: how the screen draws it (board-shared.js REPORT_LOOKS,
 * '' as it fits), chosen beside it; left as it was when not sent, and never a clash: it changes no words
 * → { itemId, report, reportBy, reportAt, reportLook }
 */
export async function saveReport(env, id, itemId, text, { member = null, admin = false, adminEmail = '', base = null, look = undefined } = {}) {
  await ensureSchema(env.DB);
  if (typeof text !== 'string') throw err('What does the report say?', 400);
  const { m, it } = await presenterGate(env, id, itemId, { member, admin });
  const itemOf = (x) => x.sections.flatMap((s) => s.items).find((y) => y.id === itemId);
  const report = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, LIMITS.report);
  const theirs = (x) => ({ itemId, report: x.report, reportBy: x.reportBy, reportAt: x.reportAt, reportLook: x.reportLook || '' });
  const reportLook = look === undefined ? undefined : REPORT_LOOKS.includes(look) ? look : '';
  const lookNow = reportLook !== undefined && reportLook !== (it.reportLook || '');
  if (report === it.report && !lookNow) return theirs(it);
  const by = member ? member.name : (await adminVoter(env.DB, adminEmail)).name;
  const at = nowIso();
  const saved = await patchMeeting(env.DB, id, (cur) => {
    const now = itemOf(cur);
    if (!now) throw err('That item isn’t on the agenda any more', 404);
    // (only how it shows: its words, who wrote them and when stay as they are)
    const words = now.report !== report;
    if (words && base !== null && String(base) !== (now.reportAt || '')) {
      throw Object.assign(err(`${now.reportBy || 'Someone'} changed this report since you opened it`, 409), { current: theirs(now) });
    }
    const patch = { ...(words ? { report, reportBy: report ? by : '', reportAt: report ? at : '' } : {}), ...(reportLook !== undefined ? { reportLook } : {}) };
    return { ...cur, sections: cur.sections.map((s) => ({ ...s, items: s.items.map((x) => (x.id === itemId ? { ...x, ...patch } : x)) })) };
  }, { by: member?.name || adminEmail });
  return theirs(itemOf(saved));
}

/**
 * What an item's presenter asks the board to vote on (item.motion), written ahead on the board page: the presenter or
 * Board's admins, until the meeting's minutes are approved (presenterGate). Empty takes it off. → { itemId, motion }
 */
export async function saveMotion(env, id, itemId, text, { member = null, admin = false, adminEmail = '', base = null } = {}) {
  await ensureSchema(env.DB);
  if (typeof text !== 'string') throw err('What should the board vote on?', 400);
  let it;
  try {
    ({ it } = await presenterGate(env, id, itemId, { member, admin }));
  } catch (e) {
    if (e.status === 403 && member) throw err('Only the person presenting this item can ask the board to vote on it', 403);
    throw e;
  }
  const motion = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.motion);
  if (motion === (it.motion || '')) return { itemId, motion };
  // `base`: the motion as the page last saw it. Someone else's since (a co-presenter, Board) is never written over
  const saved = await patchMeeting(env.DB, id, (cur) => {
    const now = cur.sections.flatMap((s) => s.items).find((x) => x.id === itemId);
    if (!now) throw err('That item isn’t on the agenda any more', 404);
    if (base !== null && String(base) !== (now.motion || '') && (now.motion || '') !== motion) {
      throw Object.assign(err('Someone changed this motion since you opened it', 409), { current: { itemId, motion: now.motion || '' } });
    }
    return { ...cur, sections: cur.sections.map((s) => ({ ...s, items: s.items.map((x) => (x.id === itemId ? { ...x, motion } : x)) })) };
  }, { by: member?.name || adminEmail });
  return { itemId, motion: saved.sections.flatMap((s) => s.items).find((x) => x.id === itemId)?.motion || '' };
}

/** The board already has it on their calendars: Board's invite went out */
export const boardHasIt = (m) => !!m?.invite?.sentAt;
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
    // SOARD's name as it's written, whatever a Drive file or a hurried title said
    title: orgName(one(raw.title, 200)),
    kind: DOC_KINDS.some((k) => k.id === raw.kind) ? raw.kind : 'other',
    note: String(raw.note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 2000),
    sign: raw.sign === true,
    shared: raw.shared !== false,
    year: Number(raw.year) >= 2000 && Number(raw.year) <= 2100 ? Math.round(raw.year) : null,
    // Its words, when it's written in Board (Markdown, ../../public/admin/board-report.js): what the board page shows
    body: String(raw.body ?? '').replace(/\r\n?/g, '\n').trim().slice(0, LIMITS.paper),
    // Which wording it is (each saved change of its words is the next, kept in board_doc_versions), and when and by
    // whom it was written; a signature on a wording before `signFrom` (the board asked to sign again) doesn't count
    version: Math.max(0, Math.round(Number(raw.version) || 0)),
    signFrom: Math.max(0, Math.round(Number(raw.signFrom) || 0)),
    // The first version a page must have read to sign: a change the admin said doesn't need signing again (a typo)
    // leaves it, so a page showing the version just before can still sign
    readFrom: Math.max(0, Math.round(Number(raw.readFrom) || 0)),
    wordsAt: one(raw.wordsAt, 40),
    wordsBy: one(raw.wordsBy, 200),
    // The file its words were read from (a board file's id): a newer file than that is one to bring the words in from
    wordsFile: one(raw.wordsFile, 40),
    createdAt: one(raw.createdAt, 40),
    updatedAt: one(raw.updatedAt, 40),
  };
}

/**
 * How a signature came: typed on the board page; the member's own signed copy, added there; a copy a Board admin
 * was handed for them (`staff`); their copy already in SOARD's Drive (./_board-drive.js, `drive`)
 */
export const SIGNED_BY = ['typed', 'copy', 'staff', 'drive'];
const thisYear = () => Number(todayEastern().slice(0, 4));
/** A signature row as Board shows it: { name, at, how, copy (the file, when one was added), drive ({ id, name } in Drive) } */
const signatureOf = (s, copies = {}) => ({
  name: s.name || '', at: s.at || '', how: SIGNED_BY.includes(s.how) ? s.how : 'typed', version: Number(s.version) || 0,
  copy: s.file_id ? copies[s.file_id] || null : null,
  drive: s.drive_id ? { id: s.drive_id, name: s.drive_name || '' } : null,
});

/**
 * Every document with its file and this year's signatures:
 * { ...doc, file, signed: { slug: { name, at, how, version, copy, drive } }, earlier: [slugs], before: { slug: … },
 *   prior: { slug: { year, at, how, version } } }
 * (`sign`: every board member signs it each year; `earlier`: who signed a wording before the one the board was asked
 * to sign again, their signature in `before`; `prior`: each member's signature in the last year before this one they
 * signed it, so a new year's "to sign" says they signed it then)
 */
export async function listDocs(DB, year = thisYear()) {
  await ensureSchema(DB);
  const [rows, files, sigs, copies, prior] = await Promise.all([
    DB.prepare('SELECT data FROM board_docs').all().then((r) => r.results || []),
    filesOf(DB, 'doc'),
    DB.prepare('SELECT * FROM board_signatures WHERE year = ?').bind(year).all().then((r) => r.results || []),
    filesOf(DB, 'signed').then((by) => Object.fromEntries(Object.values(by).flat().map((f) => [f.id, f]))),
    // (SQLite gives the other columns from the row with the latest year)
    DB.prepare('SELECT doc_id, slug, MAX(year) AS year, at, how, version FROM board_signatures WHERE year < ? GROUP BY doc_id, slug').bind(year).all().then((r) => r.results || []),
  ]);
  return rows.map((r) => cleanDoc(parse(r.data))).map((d) => {
    const theirs = sigs.filter((s) => s.doc_id === d.id);
    const counts = (s) => (Number(s.version) || 0) >= d.signFrom;
    return {
      ...d,
      file: (files[d.id] || []).at(-1) || null,
      signed: Object.fromEntries(theirs.filter(counts).map((s) => [s.slug, signatureOf(s, copies)])),
      earlier: theirs.filter((s) => !counts(s)).map((s) => s.slug),
      before: Object.fromEntries(theirs.filter((s) => !counts(s)).map((s) => [s.slug, signatureOf(s, copies)])),
      prior: Object.fromEntries(prior.filter((s) => s.doc_id === d.id).map((s) => [s.slug, { year: Number(s.year), at: s.at || '', how: SIGNED_BY.includes(s.how) ? s.how : 'typed', version: Number(s.version) || 0 }])),
    };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * A document saved (`by`: who). Its words are the next wording when they changed, kept on record. A save without
 * words keeps them. Decided here, from what's saved now (never from the page the admin opened a while ago):
 *   - `base`: the wording the admin's editor started from; someone else's newer one is a 409 with { conflict }
 *     (who, when, its number) and nothing is saved, until the admin chooses (base: that number, to save theirs over)
 *   - new words, or a new file (`newFile`: its name, uploaded right after), on a paper some of the board signed this
 *     year: a 409 with { ask: { names, since } } until the admin says whether they sign again (`askAgain` true or
 *     false; true: signatures on earlier wordings stop counting, a new file a wording of its own). `fromFile`: the
 *     words are its own file's, as read (the paper is the same, so nobody signs again); `wordsFrom`: the file's name,
 *     for the record
 *   - a paper everyone signs keeps its words or its file: one with neither can't be required
 */
export async function saveDoc(DB, raw, { by = '', askAgain = null, base = null, fromFile = false, wordsFrom = '', newFile = '' } = {}) {
  await ensureSchema(DB);
  const d = cleanDoc(raw);
  if (!d.title) throw Object.assign(new Error('A document needs a title'), { status: 400 });
  const row = await DB.prepare('SELECT data FROM board_docs WHERE id = ?').bind(d.id).first();
  // An editor open on a paper deleted meanwhile (another tab, someone else): not made again from what it had
  if (!row && base != null) throw Object.assign(new Error('This paper was deleted (in another tab, or by someone else), so nothing was saved'), { status: 410, extra: { deleted: true } });
  const was = row ? cleanDoc(parse(row.data)) : null;
  const body = raw.body === undefined ? was?.body || '' : d.body;
  const changed = body !== (was?.body || '');
  if (raw.wordsFile === undefined) d.wordsFile = was?.wordsFile || '';
  // On the board page or not is its switch's: a save that doesn't say keeps it as it is (an editor opened before the
  // switch was flipped never flips it back)
  if (raw.shared === undefined && was) d.shared = was.shared;
  if (was && changed && base != null && Number(base) !== was.version) {
    throw Object.assign(new Error('These words changed while you had them open'), { status: 409, extra: { conflict: { version: was.version, by: was.wordsBy, at: was.wordsAt, body: was.body } } });
  }
  if (was && d.sign && !body) {
    const file = await DB.prepare("SELECT id FROM board_files WHERE owner_type = 'doc' AND owner_id = ? LIMIT 1").bind(d.id).first();
    if (!file) throw Object.assign(new Error('A paper every member signs needs its words or its file: write them, add the file, or untick Required'), { status: 400 });
  }
  // A new file changes what the board reads only when it reads the paper as its file (written here, it reads the words)
  const newRead = !!newFile && !body;
  // Required after this save, and what the board reads changes now (new words, a new file) or changed while it wasn't
  // required (made required again): whoever's signature would count on it is asked about
  const reRequired = !!was && !was.sign && d.sign;
  const changesNow = changed || newRead;
  if (was && d.sign && (changesNow || reRequired) && askAgain == null && !(fromFile && !newFile && !was.body)) {
    const current = (await listDocs(DB)).find((x) => x.id === d.id);
    const board = await activeBoard(DB);
    const names = board.filter((p) => current?.signed[p.slug] && (changesNow || current.signed[p.slug].version < was.version)).map((p) => p.name);
    // since: what they signed (the earlier words, or the file); now: what the board will read; newFile: a new file;
    // paused: its words changed while it wasn't required
    if (names.length) throw Object.assign(new Error('Do they sign the new version?'), { status: 409, extra: { ask: { names, since: was.body ? 'words' : 'file', now: body ? 'words' : 'file', newFile: newFile ? String(newFile) : '', paused: reRequired && !changesNow } } });
  }
  // The wording's number, and who wrote it when, are the server's
  const next = { ...d, body, version: was?.version || 0, signFrom: was?.signFrom || 0, readFrom: was?.readFrom || 0, wordsAt: was?.wordsAt || '', wordsBy: was?.wordsBy || '', createdAt: row ? parse(row.data).createdAt : nowIso(), updatedAt: nowIso() };
  // A new version: new words, or a new file for a paper read as its file (whether or not the board signs it again:
  // a page still showing the old file can't sign the new one unread)
  // (required again, the board asked to sign again: from the version it is)
  if (reRequired && !changesNow && askAgain === true) { next.signFrom = next.version; next.readFrom = next.version; }
  if (changed || (was && newRead)) {
    next.version += 1;
    if (changed) { next.wordsAt = nowIso(); next.wordsBy = String(by || '').slice(0, 200); }
    // (its note: where its words came from, or the file it was; and that the board signed again from it)
    const note = [changed ? (wordsFrom ? `From ${String(wordsFrom).slice(0, 200)}` : '') : `A new file: ${String(newFile).slice(0, 200)}`, askAgain === true ? 'The board signs again from here' : ''].filter(Boolean).join(' · ');
    await DB.prepare('INSERT OR REPLACE INTO board_doc_versions (doc_id, version, body, at, by, note) VALUES (?, ?, ?, ?, ?, ?)').bind(d.id, next.version, body, nowIso(), String(by || '').slice(0, 200), note).run();
    if (askAgain === true) next.signFrom = next.version;
    // A page still on an earlier version re-reads before signing, unless the admin said the change doesn't need it
    if (askAgain !== false) next.readFrom = next.version;
  }
  await DB.prepare('INSERT OR REPLACE INTO board_docs (id, data, updated_at) VALUES (?, ?, ?)').bind(d.id, JSON.stringify(next), next.updatedAt).run();
  return (await listDocs(DB)).find((x) => x.id === d.id);
}

/** Papers' PDFs not read yet, a few at a time: their words kept for finding them (Workers AI's reader; '' for a scan) */
export async function fillDocWords(env, { limit = 3 } = {}) {
  try {
    await ensureSchema(env.DB);
    const bucket = boardFiles(env);
    if (!bucket || !env.AI?.toMarkdown) return 0;
    const rows = (await env.DB.prepare("SELECT id, r2_key, name FROM board_files WHERE owner_type = 'doc' AND type = 'application/pdf' AND words IS NULL ORDER BY at DESC LIMIT ?").bind(limit).all()).results || [];
    for (const r of rows) {
      const obj = await bucket.get(r.r2_key);
      const bytes = obj ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : null;
      const words = bytes ? await pdfText(env, { bytes, name: r.name }) : '';
      await env.DB.prepare('UPDATE board_files SET words = ? WHERE id = ?').bind(String(words || '').replace(/\s+/g, ' ').trim().slice(0, 60000), r.id).run();
    }
    return rows.length;
  } catch (err) {
    console.error('[board] doc words', err.message);
    return 0;
  }
}

/**
 * A paper's wordings written in Board, newest first: [{ version, body, at, by, note, signed }] (`note`: where its
 * words came from, or the new file it was; `signed`: how many signed it this year)
 */
export async function docVersions(DB, id, year = thisYear()) {
  await ensureSchema(DB);
  const counts = Object.fromEntries((((await DB.prepare('SELECT version, count(*) AS n FROM (SELECT version FROM board_signatures WHERE doc_id = ?1 AND year = ?2 UNION ALL SELECT version FROM board_signatures_earlier WHERE doc_id = ?1 AND year = ?2) GROUP BY version').bind(id, year).all()).results) || []).map((r) => [Number(r.version) || 0, Number(r.n)]));
  return ((await DB.prepare('SELECT version, body, at, by, note FROM board_doc_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 50').bind(id).all()).results || [])
    .map((r) => ({ version: Number(r.version), body: r.body || '', at: r.at || '', by: r.by || '', note: r.note || '', signed: counts[Number(r.version)] || 0 }));
}

export async function deleteDoc(env, id) {
  await ensureSchema(env.DB);
  // Its file, and the signed copies kept beside it
  const files = (await env.DB.prepare("SELECT id FROM board_files WHERE owner_type IN ('doc', 'signed') AND owner_id = ?").bind(id).all()).results || [];
  for (const f of files) await deleteFile(env, f.id);
  await env.DB.prepare('DELETE FROM board_signatures WHERE doc_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM board_signatures_earlier WHERE doc_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM board_doc_versions WHERE doc_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM board_docs WHERE id = ?').bind(id).run();
}

// Why a paper can't be signed now: taken off the board page, gone, or no longer asking (the page reloads it)
const noSignature = (doc) => Object.assign(new Error(!doc || !doc.shared ? 'That paper isn’t on the board page anymore' : 'That paper doesn’t ask for a signature anymore'), { status: 404, extra: { gone: true } });
/** The words they read aren't the paper's words anymore: they read the new ones first */
const notWhatTheyRead = (doc, version) => {
  if (version == null || version === '' || Number(version) >= doc.readFrom) return null;
  return Object.assign(new Error('It changed while you had it open. Read it again, then sign.'), { status: 409, extra: { changed: true } });
};
/** The version a signature is on: the one they read (a small change since doesn't need it read again), else the paper's */
const signedOn = (doc, version) => (version == null || version === '' ? doc.version : Math.min(doc.version, Math.max(Number(version), doc.readFrom)));
async function writeSignature(DB, { docId, slug, year, name, how, fileId = null, driveId = null, driveName = null, by = '', at = nowIso(), version = 0, signFrom = 0 }, { keep = false } = {}) {
  if (!keep) {
    const was = await DB.prepare('SELECT * FROM board_signatures WHERE doc_id = ? AND slug = ? AND year = ?').bind(docId, slug, year).first();
    if (was && (Number(was.version) || 0) < signFrom) {
      await DB.prepare('INSERT OR REPLACE INTO board_signatures_earlier (doc_id, slug, year, version, name, at, how, file_id, drive_id, drive_name, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(docId, slug, year, Number(was.version) || 0, was.name, was.at, was.how, was.file_id, was.drive_id, was.drive_name, was.added_by).run();
    }
  }
  return DB.prepare(`INSERT OR ${keep ? 'IGNORE' : 'REPLACE'} INTO board_signatures (doc_id, slug, year, name, at, how, file_id, drive_id, drive_name, added_by, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(docId, slug, year, name, at, how, fileId, driveId, driveName, by, version).run();
}

/**
 * A member's signature for this year, with their own name typed (../../public/admin/board-shared.js signsAs).
 * A signed copy already in (theirs, or one in Drive) stays: it's the better record
 */
export async function signDoc(DB, docId, member, name, { version = null } = {}) {
  await ensureSchema(DB);
  const doc = (await listDocs(DB)).find((d) => d.id === docId);
  if (!doc?.shared || !doc.sign) throw noSignature(doc);
  // `version`: the wording on their page when they signed; a newer one is signed only once they've read it
  const stale = notWhatTheyRead(doc, version);
  if (stale) throw stale;
  const had = doc.signed[member.slug];
  if (had && had.how !== 'typed') return { docId, year: thisYear(), ...had };
  if (String(name || '').trim().length < 3) throw Object.assign(new Error('Type your full name to sign'), { status: 400 });
  const typed = signsAs(name, member.name);
  if (!typed) throw Object.assign(new Error(`Sign with your own name, as the board has it: ${member.name}`), { status: 400 });
  const year = thisYear();
  const at = nowIso();
  const on = signedOn(doc, version);
  await writeSignature(DB, { docId, slug: member.slug, year, name: typed, how: 'typed', by: member.email || '', at, version: on, signFrom: doc.signFrom });
  return { docId, year, name: typed, at, how: 'typed', version: on, copy: null, drive: null };
}

/**
 * A signed copy as this year's signature: a board member's own, added on the board page (`member`), or one a Board
 * admin was handed for a member (`slug`, `by`). Kept staff-only beside the paper (the member opens their own);
 * it replaces a copy added for them before. A PDF or a photo of the signed page. `version`: the wording on the
 * member's page (as signDoc). → { docId, year, name, at, how, copy, drive }
 */
export async function signWithCopy(env, docId, file, { member = null, slug = '', by = '', version = null, replace = false } = {}) {
  await ensureSchema(env.DB);
  const doc = (await listDocs(env.DB)).find((d) => d.id === docId);
  if (!doc?.sign || (member && !doc.shared)) throw noSignature(doc);
  if (member) { const stale = notWhatTheyRead(doc, version); if (stale) throw stale; }
  const who = member || (await activeBoard(env.DB)).find((p) => p.slug === slug);
  if (!who) throw Object.assign(new Error('Whose is it? They aren’t on People → Board'), { status: 404 });
  const theirs = !member && doc.signed[who.slug];
  if (theirs && (theirs.how === 'typed' || theirs.how === 'copy') && !replace) {
    throw Object.assign(new Error(`${who.name} has signed it already (${theirs.how === 'typed' ? 'typed on the board page' : 'their own copy'})`), { status: 409, extra: { exists: { how: theirs.how, at: theirs.at, name: who.name } } });
  }
  if (file && typeof file.arrayBuffer === 'function') {
    const type = fileTypeOf(new Uint8Array(await file.arrayBuffer()), file.name);
    if (!type && /\.(pdf|jpe?g|png|gif|webp|hei[cf])$/i.test(file.name || '')) throw Object.assign(new Error(`${file.name} isn’t what its name says (another kind of file renamed): save the signed page again as a PDF or a photo`), { status: 415 });
    if (!type || !(type === 'application/pdf' || type.startsWith('image/'))) throw Object.assign(new Error('A signed copy is a PDF, or a photo of the signed page'), { status: 415 });
  }
  const year = thisYear();
  const before = await env.DB.prepare('SELECT file_id, version FROM board_signatures WHERE doc_id = ? AND slug = ? AND year = ?').bind(docId, who.slug, year).first();
  const copy = await putFile(env, { ownerType: 'signed', ownerId: docId, file, staffOnly: true, by: by || who.email || '' });
  const at = nowIso();
  const on = member ? signedOn(doc, version) : doc.version;
  await writeSignature(env.DB, { docId, slug: who.slug, year, name: who.name, how: member ? 'copy' : 'staff', fileId: copy.id, by: by || who.email || '', at, version: on, signFrom: doc.signFrom });
  // (the copy before it, while it still counted, is replaced: gone; one from before the board signed again is kept)
  if (before?.file_id && before.file_id !== copy.id && (Number(before.version) || 0) >= doc.signFrom) await deleteFile(env, before.file_id);
  return { docId, year, name: who.name, at, how: member ? 'copy' : 'staff', version: on, copy, drive: null };
}

/**
 * A member's copy in Drive as their signature for its year (./_board-drive.js). One they already gave that year,
 * typed or added, stays theirs (`replace`: a Board admin saying whose a copy is)
 */
export async function signFromDrive(DB, { docId, slug, year, name, driveId, driveName, at, by = 'Google Drive', version = 0 }, { replace = false } = {}) {
  await ensureSchema(DB);
  await writeSignature(DB, { docId, slug, year, name, how: 'drive', driveId, driveName, by, at: at || nowIso(), version }, { keep: !replace });
}

const DB_doc = async (DB, id) => { const r = await DB.prepare('SELECT data FROM board_docs WHERE id = ?').bind(id).first(); return r ? cleanDoc(parse(r.data)) : null; };
/** A signature taken off (a copy added for the wrong member, say): its copy goes with it; one from Drive isn't placed again */
export async function unsignDoc(env, docId, slug, year = thisYear()) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT * FROM board_signatures WHERE doc_id = ? AND slug = ? AND year = ?').bind(docId, slug, year).first();
  if (!row) return false;
  await env.DB.prepare('DELETE FROM board_signatures WHERE doc_id = ? AND slug = ? AND year = ?').bind(docId, slug, year).run();
  if (row.file_id) await deleteFile(env, row.file_id);
  const doc = await DB_doc(env.DB, docId);
  const counted = (Number(row.version) || 0) >= (doc?.signFrom || 0);
  const earlier = counted ? await env.DB.prepare('SELECT * FROM board_signatures_earlier WHERE doc_id = ? AND slug = ? AND year = ? ORDER BY version DESC LIMIT 1').bind(docId, slug, year).first() : null;
  if (earlier) {
    await env.DB.prepare('INSERT OR REPLACE INTO board_signatures (doc_id, slug, year, name, at, how, file_id, drive_id, drive_name, added_by, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(docId, slug, year, earlier.name, earlier.at, earlier.how, earlier.file_id, earlier.drive_id, earlier.drive_name, earlier.added_by, earlier.version).run();
    await env.DB.prepare('DELETE FROM board_signatures_earlier WHERE doc_id = ? AND slug = ? AND year = ? AND version = ?').bind(docId, slug, year, earlier.version).run();
  }
  if (row.drive_id) await env.DB.prepare("UPDATE board_drive_signed SET state = 'off' WHERE drive_id = ?").bind(row.drive_id).run().catch(() => {});
  return true;
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
const KNOWN_EXT = /\.(pdf|jpe?g|png|gif|webp|heic|heif|docx|xlsx|pptx|doc|xls)$/i;
/** Why a file can't be a board file ('' when it can): too big, or not what its name says, in plain words */
export async function boardFileProblem(file) {
  if (!file || typeof file.arrayBuffer !== 'function') return 'No file came with that';
  if (file.size > MAX_FILE) return 'That file is over 50 MB';
  if (fileTypeOf(new Uint8Array(await file.arrayBuffer()), file.name)) return '';
  return KNOWN_EXT.test(file.name || '') ? `${file.name} isn’t what its name says (a .docx named .doc, or a picture named .pdf): open it and save it again as what it is` : 'Board files can be PDFs, pictures, or Word, Excel and PowerPoint files';
}
// A signed copy saved under the name it really is (a photo named .pdf is a .jpg)
const EXT_OF = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic' };

/**
 * Store an uploaded file for a meeting, a document, or a member's signed copy of a document (`signed`, always
 * staff-only: signWithCopy) → its row as the admin shows it
 */
export async function putFile(env, { ownerType, ownerId, file, kind = 'other', staffOnly = false, by = '' }) {
  await ensureSchema(env.DB);
  const bucket = boardFiles(env);
  if (!bucket) throw Object.assign(new Error('File storage isn’t set up (FILES)'), { status: 503 });
  if (!['meeting', 'doc', 'signed'].includes(ownerType) || !ID.test(String(ownerId || ''))) throw Object.assign(new Error('What is this file for?'), { status: 400 });
  if (ownerType === 'signed') staffOnly = true;
  const owner = ownerType === 'meeting'
    ? await env.DB.prepare('SELECT id FROM board_meetings WHERE id = ?').bind(ownerId).first()
    : await env.DB.prepare('SELECT id FROM board_docs WHERE id = ?').bind(ownerId).first();
  if (!owner) throw Object.assign(new Error(`Save the ${ownerType === 'meeting' ? 'meeting' : 'document'} first`), { status: 404 });
  if (!file || typeof file.arrayBuffer !== 'function') throw Object.assign(new Error('No file came with that'), { status: 400 });
  if (file.size > MAX_FILE) throw Object.assign(new Error('That file is over 50 MB'), { status: 413 });
  const bytes = await file.arrayBuffer();
  const type = fileTypeOf(new Uint8Array(bytes), file.name);
  if (!type) throw Object.assign(new Error(await boardFileProblem(file)), { status: 415 });
  const id = uid('f_');
  let name = String(file.name || 'file').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 200) || 'file';
  const ext = EXT_OF[type];
  // (a signed copy: a photo of the page named .pdf is kept as the .jpg it is)
  if (ownerType === 'signed' && ext && !name.toLowerCase().endsWith(ext) && !(ext === '.jpg' && /\.jpeg$/i.test(name))) name = `${name.replace(/\.[a-z0-9]{2,5}$/i, '')}${ext}`;
  const key = `board/${ownerType}/${ownerId}/${id}-${safeName(name)}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  const fileKind = (ownerType === 'meeting' ? FILE_KINDS.map((k) => k.id) : ['other']).includes(kind) ? kind : 'other';
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

/**
 * The file's row if this person may open it: admins any; a member only a shared meeting's or document's, never
 * staff-only, and their own signed copy (`member`)
 */
export async function fileFor(DB, id, { admin = false, member = null } = {}) {
  await ensureSchema(DB);
  if (!ID.test(String(id || ''))) return null;
  const row = await DB.prepare('SELECT * FROM board_files WHERE id = ?').bind(id).first();
  if (!row) return null;
  if (admin) return row;
  if (row.owner_type === 'signed') {
    const sig = member?.slug ? await DB.prepare('SELECT slug FROM board_signatures WHERE file_id = ?').bind(id).first() : null;
    return sig && sig.slug === member.slug ? row : null;
  }
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
        // An organization, by its name and photo on Community even before it's published (the board is SOARD's
        // own; a child's name and photo wait for their page). Linked once its page is public
        list.push({ name: hit.name || null, slug: hit.page ? hit.slug : null, status, kind: 'community', url: hit.page || null, ...photoField(hit.heroImage) });
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
    // The year's board meetings, held and ahead (the screen's "2026 board meetings"), never another organization's
    thisYear: meetings.filter((m) => isDate(m.date) && m.date.slice(0, 4) === today.slice(0, 4) && !m.notBoard).sort((a, b) => a.date.localeCompare(b.date)).map((m) => ({ id: m.id, name: meetingName(m), date: m.date, start: m.start, shared: m.shared })),
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
  const snapshot = { at: n.at, by: by || '', cash: n.cash, mercury: n.mercury, finance: n.finance, books: n.books, projects: n.projects, reveals: n.reveals, pastReveals: n.pastReveals, events: n.events, recentEvents: n.recentEvents, meetings: n.meetings.filter((x) => x.id !== id), thisYear: n.thisYear || [], impact: n.impact };
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
// From a person, through the board's address: "Sam Ortiz via SOARD Board", quoted (a name may have a period or a
// comma), a phone's curly apostrophe kept as a plain one; no one, the board's own
const viaBoard = (who) => (who ? EMAIL_FROM.replace(/^[^<]*/, `"${who.replace(/[‘’]/g, "'").replace(/["\\<>\r\n]/g, '').trim()} via SOARD Board" `) : fromBoard());
const meetingUrl = (m) => `${SITE}${BOARD_PAGE}#/meetings/${m.id}`;
const whenOf = (m) => [longDate(m.date), timeRange(m.start, m.end)].filter(Boolean).join(', ');
const placeOf = (m) => [m.location, m.address].filter(Boolean).join(', ');
// A title or an initial isn't a first name: "Dr. Lee Park" → Lee, "J. Michael Ortiz" → Michael, "Ortiz, Sam" → Sam
const firstName = (name) => String(name || '').replace(/^([^,]+),\s*(?!\s|(?:jr|sr|ii|iii|iv|md|phd|esq|cpa)\b)(.+)$/i, '$2').trim().split(/\s+/).find((w) => w && !/^(dr|mr|mrs|ms|mx|rev|hon|prof|sir|judge)\.?$/i.test(w) && !/^\p{L}\.?$/u.test(w)) || '';
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
    ['Notes', m.inviteNote ? esc(m.inviteNote).replace(/\n/g, '<br>') : ''],
    ...more,
  ]);
}
const factsText = (m) => [`When: ${whenOf(m)}`, placeOf(m) && `Where: ${placeOf(m)}`, m.video && `Video (${callName(m.video)}): ${m.video}`, m.inviteNote && `Notes: ${m.inviteNote}`].filter(Boolean).join('\n');

/**
 * "Will you be there?": answered on the calendar invite and nowhere else (Peter, Nov 2 2026). `from`: the name of
 * whoever the invite comes from, so they know which one to look for
 */
const answerAsk = (from = '') => `Answer the calendar invite${from ? ` from ${from}` : ''}: yes, no or maybe. That’s where SOARD sees who’s coming.`;
/** Who a staff address is on People → Team (first@soardcharity.com), else null */
const staffFor = (people, email) => {
  const e = String(email || '').toLowerCase();
  return (e && people.staff.find((p) => e.startsWith(`${String(p.name).split(/\s+/)[0].toLowerCase()}@`))) || null;
};
/** Who a meeting's invite comes from: whoever Board's invite went out from, else Settings' */
const inviteOwner = (m, settings) => m.invite?.organizer || settings?.invitesFrom || '';
/** …by name */
function inviteFrom(m, people, settings) {
  return staffFor(people, inviteOwner(m, settings))?.name || '';
}

/**
 * The documents email, for one board member: everything stays on the board page (nothing is attached; the board
 * reads it there, the meeting presents it from there, and Print it all is there for paper). When, where and the
 * call; what the documents are (never one on a board-only item, by name); the calendar invite to answer when they
 * haven't (`ask`), naming whose it is (`from`). `files`: the documents' names. `toSign`: this year's papers every
 * member signs that they haven't yet, each a title or { title, id, written } (one written in Board opens on its own page).
 */
/** The items someone presents at a meeting, each with the page to write its report on: [{ title, url, written }] */
export function reportsFor(m, slug, people = []) {
  if (!slug) return [];
  return m.sections.flatMap((s) => s.items).filter((it) => reportsOn(it) && presentersOf(it, people).some((p) => p.slug === slug))
    .map((it) => ({ title: it.title, url: `${meetingUrl(m)}/report/${it.id}`, written: !!it.report }));
}

export function packetEmail(m, { test = false, files = [], private: hidden = 0, name: who = '', from = '', ask = true, reports = [], toSign = [] } = {}) {
  const name = meetingName(m);
  const first = firstName(who);
  const titles = files.map((n) => fileTitle(n));
  const count = titles.length + hidden;
  const lead = `${first ? `${first}, the` : 'The'} agenda${count ? ` and ${plural(count, 'document')}` : ''} for the ${name} ${count ? 'are' : 'is'} on the board page. Read ${count ? 'them' : 'it'} there, or print it all from there if you’d like paper.`;
  const answer = ask ? ruled(`<p class="ink" style="margin:0 0 6px;font-weight:700;">Will you be there?</p><p class="ink" style="margin:0;">${esc(answerAsk(from))}</p>`) : '';
  const docsHtml = [...titles.map((t) => esc(t)), hidden ? `${plural(hidden, 'board-only document')}` : ''].filter(Boolean).join('<br>');
  // What they present: the report to write on the board page (or theirs, already in)
  const todo = reports.filter((r) => !r.written);
  // Each item by name, bold, joined in words (a title with "and" in it stays one title)
  const joined = (list) => (list.length > 2 ? `${list.slice(0, -1).join(', ')}, and ${list.at(-1)}` : list.join(' and '));
  const presentHtml = !reports.length ? '' : ruled(`<p class="ink" style="margin:0 0 6px;">You present ${joined(reports.map((r) => `<strong>${esc(r.title)}</strong>`))}</p>`
    + `<p style="margin:0 0 14px;">${todo.length ? 'Write your report on the board page. The board reads it there before the meeting, and it’s on the screen when you present.' : `Your report${reports.length > 1 ? 's are' : ' is'} in. You can change ${reports.length > 1 ? 'them' : 'it'} there until the meeting.`}</p>`
    + reports.map((r) => (r.written ? `<p style="margin:6px 0 0;">${link(`Your report on ${r.title}`, r.url)}</p>` : `<div style="margin:8px 0 0;">${button(reports.length > 1 ? `Write your ${r.title} report` : 'Write your report', r.url)}</div>`)).join(''));
  // The papers every board member signs each year, while they haven't
  const year = todayEastern().slice(0, 4);
  const papers = toSign.map((t) => (typeof t === 'string' ? { title: t } : t));
  // One paper opens on its own page, its words (or its file) and the signing at their end; more, on Documents
  // (/board/<id>: a #/ link loses its place through Cloudflare's sign-in, public/_redirects)
  const documentsUrl = `${SITE}/board/${papers.length === 1 && papers[0].id ? papers[0].id : 'documents'}`;
  const signHow = 'Every board member signs these once a year. Read them on the board page and sign by typing your name, or add the copy you signed on paper.';
  const signHtml = !toSign.length ? '' : ruled(`<p class="ink" style="margin:0 0 6px;font-weight:700;">Still to sign for ${year}</p>`
    + `<p class="ink" style="margin:0;">${papers.map((t) => esc(t.title)).join('<br>')}</p>` + small(esc(signHow))
    + `<p style="margin:10px 0 0;">${link(toSign.length > 1 ? 'Read and sign them' : 'Read and sign it', documentsUrl)}</p>`);
  const signText = !toSign.length ? '' : `Still to sign for ${year}: ${papers.map((t) => t.title).join(', ')}. ${signHow}\n${documentsUrl}`;
  const presentText = !reports.length ? '' : `You present ${joined(reports.map((r) => `“${r.title}”`))}. ${todo.length ? 'Write your report on the board page; the board reads it there before the meeting.' : 'Your report is in; you can change it there until the meeting.'}\n${reports.map((r) => `${r.title}: ${r.url}`).join('\n')}`;
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
        + presentHtml
        + answer
        + signHtml,
      footerHtml: FOOTER,
    }),
    text: [`The agenda and documents for the ${name}.`, lead, factsText(m),
      count ? `Documents: ${[...titles, hidden ? plural(hidden, 'board-only document') : ''].filter(Boolean).join(', ')}` : '',
      `Open the agenda and documents: ${meetingUrl(m)}\n${SIGN_IN}`,
      presentText,
      ask ? `Will you be there? ${answerAsk(from)}` : '',
      signText].filter(Boolean).join('\n\n'),
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

/** Email the board the link to the agenda and documents, what the documents are, and (to who hasn't answered it) the calendar invite to answer (test: only `to`) */
export async function sendPacket(env, id, { by, to = null, replyTo = [] } = {}) {
  const m = await getMeeting(env.DB, id);
  if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
  if (!emailConfigured(env)) throw Object.assign(new Error('Email isn’t set up (RESEND_API_KEY)'), { status: 503 });
  const test = Array.isArray(to);
  if (!test && !m.shared) throw Object.assign(new Error('Share the meeting with the board first, so the button has something to open'), { status: 409 });
  const people = test ? to.map((email) => ({ email, name: '' })) : await packetList(env.DB);
  if (!people.length) throw Object.assign(new Error('No board member has an email on file (People → Board)'), { status: 409 });
  const docs = packetDocs(m);
  // Only someone on the invite who hasn't answered it is asked to
  const open = test ? [] : (await notAnswered(env, m)).map((p) => p.slug);
  const from = inviteFrom(m, await roster(env.DB), await getSettings(env.DB));
  // Each presenter's own copy asks for their report (a preview shows none: it's for no one in particular)
  const everyone = test ? [] : await roster(env.DB).then((r) => [...r.board, ...r.staff]);
  // …and each member's, the papers they haven't signed this year (a preview shows them all)
  const signable = (await listDocs(env.DB)).filter((d) => d.shared && d.sign && (d.body || d.file));
  const toSign = (p) => signable.filter((d) => !(p.slug && d.signed[p.slug])).map((d) => ({ title: d.title, id: d.id, written: !!d.body }));
  const items = people.map((p) => ({ to: p.email, ...packetEmail(m, { test, files: docs.names, private: docs.hidden, name: p.name, from, ask: test || open.includes(p.slug), reports: reportsFor(m, p.slug, everyone), toSign: toSign(p) }) }));
  const tags = [{ name: 'kind', value: test ? 'board-packet-preview' : 'board-packet' }];
  const r = await sendEach(env, items, { tags, replyTo });
  if (!test && r.sent) await writeMeeting(env.DB, { ...m, packetSentAt: nowIso(), packetSentTo: r.sent, updatedAt: m.updatedAt, updatedBy: m.updatedBy });
  return { sent: r.sent, failed: r.failed, errors: r.errors, to: test ? to : undefined, documents: docs.names.length + docs.hidden };
}

/**
 * The agenda approved (the chair's review on the board page, where Peter and Holly can approve it too) is what emails
 * the board (Peter, Nov 2 2026: "that's what should trigger the email"): the meeting goes on the board page and the
 * board gets the email, once. It waits for the email on how to sign in, so nobody gets an agenda before they know how
 * to open it; the heartbeat sends it then (maybeSendApprovedAgendas).
 * → { sent, failed, … } | { waiting: 'sign-in' } | null (nothing to send: sent already, not ahead, a practice)
 */
export async function sendApprovedAgenda(env, id, { now = Date.now() } = {}) {
  const m = await getMeeting(env.DB, id);
  if (!m || m.practice || m.notBoard || m.packetSentAt || !isDate(m.date) || m.date < todayEastern(now) || !emailConfigured(env)) return null;
  if (!(await readState(env.DB, 'welcome')).sentAt) return { waiting: 'sign-in' };
  // Once, even when the approval and the heartbeat reach it together
  const key = `agenda-email:${m.id}`;
  const at = new Date(now).toISOString();
  const claim = await env.DB.prepare('INSERT INTO board_state (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(key, JSON.stringify({ at }), at).run();
  if (!claim?.meta?.changes) return null;
  try {
    if (!m.shared) await patchMeeting(env.DB, m.id, (cur) => ({ ...cur, shared: true }), { by: 'Board' });
    const r = await sendPacket(env, m.id, { by: 'Board', replyTo: await boardAdmins(env.DB) });
    if (!r.sent) throw Object.assign(new Error(r.errors?.[0] || 'No email went'), { status: 502 });
    return r;
  } catch (err) {
    // Not sent: the heartbeat tries again
    await env.DB.prepare('DELETE FROM board_state WHERE key = ?').bind(key).run();
    throw err;
  }
}

/** Each agenda approved before the board had the sign-in email (or that didn't go): sent once it can be. Never throws */
export async function maybeSendApprovedAgendas(env, { now = Date.now() } = {}) {
  try {
    if (!(await readState(env.DB, 'welcome')).sentAt) return;
    const since = new Date(now - 60 * 86400000).toISOString();
    const rows = (await env.DB.prepare("SELECT meeting_id FROM board_asks WHERE kind = 'chair' AND status = 'approved' AND in_at >= ?").bind(since).all()).results || [];
    for (const { meeting_id: id } of rows) await sendApprovedAgenda(env, id, { now }).catch((err) => console.error('[board] approved agenda', id, err.message));
  } catch (err) {
    if (!/no such table/i.test(err.message)) console.error('[board] approved agendas', err.message);
  }
}

/** The board approved a meeting's minutes (at a later meeting, on its date) */
export async function approveMinutes(env, id, { on, by }) {
  const m = await getMeeting(env.DB, id);
  if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
  return saveMeeting(env.DB, { ...m, minutes: 'approved', approvedOn: isDate(on) ? on : todayEastern() }, { by });
}

/** Board members on the meeting's calendar invite who haven't answered it (yes, no or maybe) */
export async function notAnswered(env, m) {
  const replies = repliesOf(m);
  return (await packetList(env.DB)).filter((p) => replies[p.slug] === 'invited');
}
/** Board members the meeting's calendar invite doesn't have (by the email on People → Board): they can't answer it */
export async function notOnInvite(env, m) {
  const replies = repliesOf(m);
  return (await packetList(env.DB)).filter((p) => !replies[p.slug]);
}

/** The reminder, for one board member: answer the calendar invite (`from`: whose), then when and where */
export function reminderEmail(m, { test = false, name: who = '', from = '' } = {}) {
  const name = meetingName(m);
  const first = firstName(who);
  const heading = `${first ? `${first}, will` : 'Will'} you be at the ${name}?`;
  const ask = answerAsk(from);
  // What the invite is called in their email (Board names it, on the organizer's own event too)
  const called = inviteTitle(m);
  return {
    subject: `${test ? '[Preview] ' : ''}Will you be at the ${name}? ${shortDate(m.date)}`,
    html: emailShell({
      eyebrow: 'SOARD Board',
      preheader: `${whenOf(m)}. ${ask}`,
      heading,
      intro: esc(ask),
      bodyHtml: meetingFacts(m)
        + small(`Can’t find the invite? Search your email for “${esc(called)}”, or reply to this email and we’ll send it again.`)
        + `<div style="margin:10px 0 0;">${small(`The agenda and documents: ${link('the board page', meetingUrl(m))}. ${SIGN_IN}`)}</div>`,
      footerHtml: FOOTER,
    }),
    text: [heading, ask, factsText(m), `Can't find the invite? Search your email for "${called}", or reply to this email and we'll send it again.`, `The agenda and documents: ${meetingUrl(m)}`].join('\n\n'),
  };
}

/**
 * Ask the board members on the invite who haven't answered it, each by name (test: only `to`). Who isn't on the
 * invite can't answer it: they come back by name (`notOnInvite`), for the invite to add them
 */
export async function remindRsvp(env, id, { to = null, replyTo = [] } = {}) {
  const m = await getMeeting(env.DB, id);
  if (!m?.shared) throw Object.assign(new Error('Share the meeting with the board first, so the button has something to open'), { status: 409 });
  const test = Array.isArray(to);
  if (!test && !inviteOut(m)) throw Object.assign(new Error('The calendar invite hasn’t gone out yet: Send the invite first, then they can answer it'), { status: 409 });
  const [team, settings] = await Promise.all([roster(env.DB), getSettings(env.DB)]);
  const missing = test ? [] : (await notOnInvite(env, m)).map((p) => p.name);
  const people = test ? to.map((email) => ({ email, name: '' })) : await notAnswered(env, m);
  // Who can add someone: Send the invite, unless the event is someone's Board can't change
  const owner = inviteOwner(m, settings);
  const adds = owner && !settings.admins.includes(owner) ? `ask ${staffFor(team, owner)?.name.split(/\s+/)[0] || owner.split('@')[0]} to add ${missing.length === 1 ? 'them' : 'them all'}` : `Send the invite adds ${missing.length === 1 ? 'them' : 'them all'}`;
  if (!people.length) throw Object.assign(new Error(missing.length ? `Everyone on the invite has answered. ${missing.join(', ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} on it: ${adds}.` : 'Everyone has answered the invite'), { status: 409 });
  const from = inviteFrom(m, team, settings);
  const items = people.map((p) => ({ to: p.email, ...reminderEmail(m, { test, name: p.name, from }) }));
  const r = await sendEach(env, items, { tags: [{ name: 'kind', value: test ? 'board-reminder-preview' : 'board-reminder' }], replyTo });
  return { sent: r.sent, failed: r.failed, errors: r.errors, to: test ? to : undefined, notOnInvite: missing };
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
 * present or print) and the notes typed for it in Board (parking and the like). Nothing else, so the agenda changing
 * never touches the invite. The notes stay after NOTES_START, in Board's part, so a change replaces them on the
 * organizer's own event instead of adding them twice (withNotes in ./_board-invite.js). Its words changed: raise
 * NOTES_VERSION there, and the invites already out get them
 */
export function inviteNotes(m) {
  return [
    `${NOTES_START} ${inviteUrl(m)}`,
    'Sign in with the email this invite went to. A code comes by email.',
    ...(m.inviteNote ? ['', m.inviteNote] : []),
  ].join('\n');
}
/**
 * A meeting's short link, for its calendar invite: /board/<id> opens the meeting (public/_redirects, then the board
 * page), even through a first sign-in, where a #/meetings/<id> link would land on Home
 */
export const inviteUrl = (m) => `${SITE}/board/${m.id}`;
/**
 * What a meeting's calendar invite is called: which meeting it is, "SOARD Q4 2026 Board Meeting" (Peter, Nov 2 2026:
 * "make that better and more descriptive", then without "(in person or Google Meet)")
 */
export function inviteTitle(m) {
  return /soard/i.test(meetingName(m)) ? meetingName(m) : `SOARD ${meetingName(m)}`;
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
    `SUMMARY:${esc2(inviteTitle(m))}`, ...(m.location || m.address ? [`LOCATION:${esc2([m.location, m.address].filter(Boolean).join(', '))}`] : []),
    `DESCRIPTION:${esc2(`${inviteNotes(m)}${m.video ? `\n\nVideo (${callName(m.video)}): ${m.video}` : ''}`)}`, `URL:${meetingUrl(m)}`,
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

// The board page's sign-in word for word as Cloudflare Access shows it (soard.cloudflareaccess.com; its heading is
// the Access app's name), and who sends its code. Checked against the live page and Cloudflare's docs, Nov 2026
const ACCESS = { heading: 'Log in to SOARD Admin', send: 'Send login code', signIn: 'Sign in', again: 'Request new code', from: 'noreply@notify.cloudflare.com' };
// The sign-in page's own joke, on purpose (Peter's): the email says it too
const FIGURE_IT_OUT = '1-800-FIGUREITOUT';

/** "Sam", "Sam or Jordan", "Sam, Jordan or Lee" */
const orNames = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list[0] || '');

/** A numbered step, its number in a yellow circle (table cells, so Outlook keeps them) */
const step = (n, html) => `<tr><td valign="top" width="38" style="width:38px;padding:0 0 14px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>`
  + `<td class="num" width="26" height="26" align="center" valign="middle" bgcolor="#FFDA24" style="width:26px;height:26px;border-radius:999px;background:#FFDA24;color:#2D2E33;font-family:${SANS};font-size:13px;font-weight:700;line-height:26px;text-align:center;">${n}</td></tr></table></td>`
  + `<td class="ink" valign="top" style="padding:2px 0 14px 4px;font-family:${SANS};font-size:15px;line-height:1.5;color:#2D2E33;">${html}</td></tr>`;
const kicker = (text) => `<p class="muted" style="margin:0 0 6px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#5A5B61;">${esc(text)}</p>`;
const para = (html, { muted = false, top = 2 } = {}) => `<p class="${muted ? 'muted' : 'ink'}" style="margin:${top}px 0 0;font-family:${SANS};font-size:${muted ? 14 : 15}px;line-height:1.5;color:${muted ? '#5A5B61' : '#2D2E33'};">${html}</p>`;

/**
 * The email that brings a board member to their page: who invited them, what's waiting there (the next meeting,
 * papers to sign), and the first sign-in step by step in the screens' own words, with what to do when no code comes.
 * `inviter`: { name, title, photo } from People → Team; `next`: the next meeting on the board page; `toSign`: the
 * titles of this year's papers they haven't signed; `helpers`: the first names a reply reaches
 */
export function welcomeEmail({ name = '', email = '', test = false, inviter = null, next = null, toSign = [], helpers = [] } = {}) {
  const url = `${SITE}/board`;
  const bare = 'sunshineonaranneyday.com/board';
  const first = firstName(name);
  const who = String(inviter?.name || '').replace(/\s+/g, ' ').trim();
  // A long address wraps on a phone instead of pushing the page sideways
  const address = email ? `<strong style="word-break:break-all;">${esc(email)}</strong>` : 'the address this email came to';
  const help = helpers.length ? `${orNames(helpers)} will help` : 'we’ll help';
  const heading = first ? `${first}, your board page is ready` : 'Your board page is ready';
  const intro = `It has ${next ? `the next meeting${next.shared ? ' and its agenda' : ''}, ` : ''}past minutes, the financials, upcoming reveals and SOARD’s papers, all in one place.`;
  const signHow = `Read ${toSign.length > 1 ? 'them' : 'it'} on the board page, and sign by typing your name or adding the copy you signed on paper.`;
  const keep = 'No password to remember. You stay signed in for a week in the browser you used, then it’s a new code.';
  const save = `Bookmark ${bare}, or add it to your phone’s home screen.`;
  const year = todayEastern().slice(0, 4);
  const byline = !who ? '' : '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px;"><tr>'
    + (inviter.photo ? `<td valign="middle" style="width:44px;padding:0 12px 0 0;"><img src="${esc(inviter.photo)}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;border:0;border-radius:999px;"></td>` : '')
    + `<td class="ink" valign="middle" style="font-family:${SANS};font-size:15px;line-height:1.4;color:#2D2E33;"><strong>${esc(who)}</strong> invited you`
    + `${inviter.title ? `<br><span class="muted" style="font-size:13px;color:#5A5B61;">${esc(inviter.title)}</span>` : ''}</td></tr></table>`;
  const waiting = (next ? panel(kicker('Next meeting') + para(`<strong>${esc(meetingName(next))}</strong>`, { top: 0 }) + para(esc(whenOf(next)))
    + (placeOf(next) ? para(esc(placeOf(next)), { muted: true }) : '') + (next.shared ? para('Its agenda is on the board page.', { muted: true, top: 8 }) : ''), { accent: true }) : '')
    + (toSign.length ? panel(kicker(`To sign for ${year}`) + para(toSign.map((t) => esc(t)).join('<br>'), { top: 0 }) + para(esc(signHow), { muted: true, top: 8 }), { accent: true }) : '');
  const steps = '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;">'
    + step(1, `Open ${link(bare, url)}. A Cloudflare page that says <strong>${ACCESS.heading}</strong> opens. That’s the right one: Cloudflare keeps the board’s papers private.`)
    + step(2, `Type ${address} and choose <strong>${ACCESS.send}</strong>.`)
    + step(3, `A six-digit code comes by email from Cloudflare (${ACCESS.from}), usually within a minute. Type or paste it in and choose <strong>${ACCESS.signIn}</strong>. Leave the page open while you get it; the code works for 10 minutes.`)
    + '</table>';
  const noCode = `Look in spam, Junk or Promotions, and check that you typed ${address}. Another address gets no code, even though the page says one was sent. If the page says the code was already used, choose <strong>${ACCESS.again}</strong>. If the page closed, open the link again and ask for a new code.`;
  const stuck = `Still stuck? Reply to this email and ${help}, or call the SOARD admin team at ${FIGURE_IT_OUT}.`;
  const strip = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  return {
    subject: `${test ? '[Preview] ' : ''}${who ? `${who} invited you to SOARD’s board page` : 'Your SOARD board page is ready'}`,
    // From the person who sent it, through the board's address: "Sam Ortiz via SOARD Board", quoted (a name may
    // have a period or a comma), a phone's curly apostrophe kept as a plain one
    from: viaBoard(who),
    html: emailShell({
      eyebrow: 'SOARD Board',
      preheader: `${next ? `Next meeting ${shortDate(next.date)}. ` : ''}Sign in with ${email || 'this email address'}. No password, just a code by email.`,
      heading,
      intro: esc(intro),
      bodyHtml: byline
        + `<div style="margin:0 0 18px;">${button('Open the board page', url)}</div>`
        + waiting
        + `<p class="ink" style="margin:${waiting ? 22 : 4}px 0 12px;font-family:${SERIF};font-size:18px;line-height:1.3;font-weight:700;color:#2D2E33;">The first time you sign in</p>`
        + steps
        + small(esc(`${keep} ${save}`))
        + ruled(`<p class="ink" style="margin:0 0 6px;font-weight:700;">No code?</p><p class="ink" style="margin:0 0 10px;">${noCode}</p>${small(esc(stuck).replace(FIGURE_IT_OUT, `<span style="white-space:nowrap;">${FIGURE_IT_OUT}</span>`))}`),
      footerHtml: FOOTER,
    }),
    text: [
      heading,
      `${intro}${who ? ` ${who}${inviter.title ? ` (${inviter.title})` : ''} invited you.` : ''}`,
      `Open the board page: ${url}`,
      next ? [`Next meeting: ${meetingName(next)}`, whenOf(next), placeOf(next), next.shared ? 'Its agenda is on the board page.' : ''].filter(Boolean).join('\n') : '',
      toSign.length ? `To sign for ${year}:\n${toSign.map((t) => `- ${t}`).join('\n')}\n${signHow}` : '',
      ['The first time you sign in',
        `1. Open ${bare}. A Cloudflare page that says "${ACCESS.heading}" opens. That’s the right one: Cloudflare keeps the board’s papers private.`,
        `2. Type ${email || 'the address this email came to'} and choose ${ACCESS.send}.`,
        `3. A six-digit code comes by email from Cloudflare (${ACCESS.from}), usually within a minute. Type or paste it in and choose ${ACCESS.signIn}. Leave the page open while you get it; the code works for 10 minutes.`].join('\n'),
      `${keep} ${save}`,
      `No code? ${strip(noCode)}`,
      stuck,
    ].filter(Boolean).join('\n\n'),
  };
}

/** Email each active board member (on their own) how to sign in, from the admin sending it (`by`); test: only `to` */
export async function sendWelcome(env, opts = {}) {
  if (Array.isArray(opts.to)) return sendWelcomeNow(env, opts);
  // One send at a time: a second (another tab, the table during the panel's, a re-posted request) is turned away, and
  // the next finds who already has it. The claim lapses after two minutes if a send never finishes.
  await readState(env.DB, 'welcome');
  const now = nowIso();
  const got = await env.DB.prepare("INSERT INTO board_state (key, data, updated_at) VALUES ('welcome-sending', '{}', ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at WHERE board_state.updated_at < ?")
    .bind(now, new Date(Date.parse(now) - 2 * 60 * 1000).toISOString()).run();
  if (!got?.meta?.changes) throw Object.assign(new Error('Another sign-in email was going out at the same moment, so this one wasn’t sent. Board access shows who has it now.'), { status: 409 });
  try {
    if (opts.check) await opts.check();
    return await sendWelcomeNow(env, opts);
  } finally {
    await env.DB.prepare("DELETE FROM board_state WHERE key = 'welcome-sending'").run();
  }
}

async function sendWelcomeNow(env, { to = null, slugs = null, due = false, again = false, replyTo = [], by = '' } = {}) {
  if (!emailConfigured(env)) throw Object.assign(new Error('Email isn’t set up (RESEND_API_KEY)'), { status: 503 });
  const test = Array.isArray(to);
  const [list, people, settings, meetings, docs] = await Promise.all([packetList(env.DB), roster(env.DB), getSettings(env.DB), listMeetings(env.DB), listDocs(env.DB)]);
  const was = test ? {} : await readState(env.DB, 'welcome');
  // Nobody gets a second copy by accident:
  //   - the whole board's send, and a pick that's due (`due`: those who haven't had it), skip anyone who has it at the
  //     address on file
  //   - someone picked again, or everyone again (`again`), skips whoever had it in the last ten minutes (a double click,
  //     two admins at once)
  // A new address makes it due again. An address the mailer would drop (kim@gmail.c) isn't sent to, nor counted.
  const hasIt = (p) => !!welcomeHad(was, p, people.board.map((x) => x.slug));
  const justNow = (p) => Date.now() - Date.parse((was.members || {})[p.slug]) < 10 * 60 * 1000;
  const asked = test ? [] : list.filter((p) => !slugs || slugs.includes(p.slug));
  const usable = asked.filter((p) => isEmail(p.email));
  const unusable = asked.filter((p) => !isEmail(p.email)).map((p) => p.name);
  // A preview greets the admin by name, as a member's copy greets them
  const recipients = test ? to.map((email) => ({ email, name: staffFor(people, email)?.name || '', slug: '' })) : usable.filter((p) => !hasIt(p) || (((slugs && !due) || again) && !justNow(p)));
  if (!test && !recipients.length) {
    if (!asked.length) throw Object.assign(new Error(slugs ? 'They aren’t on People → Board with an email now' : 'No board member has an email on file (People → Board)'), { status: 409 });
    if (!usable.length) throw Object.assign(new Error(`The email on People → Board for ${unusable.join(', ')} isn’t a whole address`), { status: 409 });
    return { sent: 0, failed: 0, errors: [], already: usable.length, ...(unusable.length ? { unusable } : {}) };
  }
  // Who it's from: the admin sending it, else the one the invites come from
  const sender = staffFor(people, by) || staffFor(people, settings.invitesFrom);
  const inviter = sender ? { name: sender.name, title: sender.title, photo: sender.photo } : null;
  const today = todayEastern();
  // The next meeting: not one taken off the calendar, nor today's once it's over
  const nowHm = easternHm(Date.now());
  const next = nextMeeting(meetings.filter((m) => onBoardPage(m, today) && !m.calendar?.gone && !(m.date === today && (m.end || m.start) && (m.end || m.start) <= nowHm)), today);
  const helpers = [...new Set(replyTo.map((e) => firstName(staffFor(people, e)?.name)).filter(Boolean))];
  const signable = docs.filter((d) => d.shared && d.sign && (d.body || (d.file && !d.file.staffOnly)));
  const items = recipients.filter((p, i) => recipients.findIndex((x) => x.email === p.email) === i).map((p) => ({ to: p.email, ...welcomeEmail({ name: p.name, email: p.email, test, inviter, next, helpers, toSign: signable.filter((d) => !(p.slug && d.signed[p.slug])).map((d) => d.title) }) }));
  if (!test) {
    // Recorded before it goes: a send cut off midway (the page closed, the Worker stopped) counts as sent, so it never
    // doubles. Each member's own time (their row on Board → Members) and the address it went to (a corrected one is due
    // again); the board counts as told (sentAt) by the whole board's send, or once a pick has reached everyone
    const at = nowIso();
    const members = { ...(was.members || {}), ...Object.fromEntries(recipients.map((p) => [p.slug, at])) };
    const addresses = { ...(was.addresses || {}), ...Object.fromEntries(recipients.map((p) => [p.slug, p.email])) };
    const everyone = list.filter((p) => isEmail(p.email)).every((p) => welcomeHad({ members, addresses }, p, people.board.map((x) => x.slug)));
    // Unconfirmed until Resend says it took them (a send cut off midway stays unconfirmed, and Board access says so)
    const unconfirmed = [...new Set([...(was.unconfirmed || []), ...recipients.map((p) => p.slug)])];
    await writeState(env.DB, 'welcome', slugs && !(everyone && !was.sentAt) ? { ...was, members, addresses, unconfirmed } : { ...was, sentAt: at, sent: recipients.length, members, addresses, unconfirmed });
  }
  // One batch: every member's email goes, or none does, so sending again never gives anyone a second copy
  const r = await sendEmailItems(env, items, { from: items[0].from, tags: [{ name: 'kind', value: test ? 'board-welcome-preview' : 'board-welcome' }], replyTo });
  // Resend not answering (a timeout, a dropped connection) may still have sent it: it stays counted as sent
  // (a gateway's 502, 503 or 504 in front of Resend is no answer too). Resend's own error status is a sure no: nobody got
  // it, so the record goes back as it was
  const unsure = !test && r.failed > 0 && r.errors.some((e) => !/^Resend \d+:/.test(String(e)) || /^Resend 50[234]:/.test(String(e)));
  if (!test && !r.sent && !unsure) await writeState(env.DB, 'welcome', was);
  // Resend confirmed it: these are no longer unconfirmed
  else if (!test && !unsure) {
    const now = await readState(env.DB, 'welcome');
    const sentTo = new Set(recipients.map((p) => p.slug));
    const unconfirmed = (now.unconfirmed || []).filter((k) => !sentTo.has(k));
    await writeState(env.DB, 'welcome', { ...now, unconfirmed: unconfirmed.length ? unconfirmed : undefined });
  }
  return { sent: r.sent, ...(!test && r.sent && recipients.length !== items.length ? { reached: recipients.length } : {}), failed: r.failed, errors: r.errors, unsure: unsure || undefined, ...(unusable.length ? { unusable } : {}), to: test ? to : undefined };
}

// ─── Asking a member to sign ────────────────────────────────────────

/**
 * The email asking a board member to sign this year's papers they haven't (`papers`: [{ title, id }]), from the
 * admin asking (`from`: their name): its button opens the paper itself, ready to read and sign (more than one:
 * Documents, where they're listed to sign). One who has never been on the board page (`firstTime`) is told how its
 * sign-in works; `test`: a preview
 */
export function signAskEmail({ name = '', email = '', papers = [], from = '', firstTime = false, test = false } = {}) {
  const year = todayEastern().slice(0, 4);
  const first = firstName(name);
  const one = papers.length === 1 ? papers[0] : null;
  const what = one ? `the ${one.title.replace(/^the\s+/i, '')}` : `${papers.length} papers`;
  // (/board/<id>, which keeps its place through Cloudflare's sign-in; a #/ link lands on Home)
  const url = `${SITE}/board/${one ? one.id : 'documents'}`;
  const heading = `${first ? `${first}, please` : 'Please'} sign ${what} for ${year}`;
  const it = one ? 'it' : 'them';
  const intro = `Every board member reads and signs ${it} once a year. On the board page it takes a few minutes: read ${one ? 'it' : 'each one'}, then type your name at the end.`;
  const paper = `Signed ${it} on paper already? Add a photo or PDF of the signed page there instead.`;
  const signIn = `The board page opens with your email address${email ? `, ${email}` : ''}: Cloudflare emails you a six-digit code to type in. No password.`;
  const reply = 'Questions? Reply to this email.';
  return {
    subject: `${test ? '[Preview] ' : ''}Please sign ${what} for ${year}`,
    from: viaBoard(from),
    html: emailShell({
      eyebrow: 'SOARD Board',
      preheader: `${one ? one.title : `${papers.length} papers`}: read and sign on the board page. A few minutes.`,
      heading,
      intro: esc(intro),
      bodyHtml: (one ? '' : panel(kicker(`To sign for ${year}`) + para(papers.map((x) => esc(x.title)).join('<br>'), { top: 0 }), { accent: true }))
        + `<div style="margin:${one ? 4 : 18}px 0 0;">${button(one ? 'Read and sign it' : 'Read and sign them', url)}</div>`
        + small(esc(paper))
        + (firstTime ? ruled(`<p class="ink" style="margin:0 0 6px;font-weight:700;">The first time</p><p class="ink" style="margin:0;">${esc(signIn).replace(esc(email), `<strong style="word-break:break-all;">${esc(email)}</strong>`)}</p>`) : '')
        + small(esc(reply)),
      footerHtml: FOOTER,
    }),
    text: [
      heading,
      intro,
      one ? '' : `To sign for ${year}:\n${papers.map((x) => `- ${x.title}`).join('\n')}`,
      `${one ? 'Read and sign it' : 'Read and sign them'}: ${url}`,
      paper,
      firstTime ? `The first time: ${signIn}` : '',
      reply,
    ].filter(Boolean).join('\n\n'),
  };
}

/** Who has been asked to sign this year, and when last: { slug: { at, by, n } } */
export async function signAsks(DB, year = thisYear()) {
  await ensureSchema(DB);
  return Object.fromEntries((((await DB.prepare('SELECT slug, at, by, n FROM board_sign_asks WHERE year = ?').bind(year).all()).results) || []).map((r) => [r.slug, { at: r.at, by: r.by || '', n: Number(r.n) || 1 }]));
}

/**
 * Email each board member picked (`slugs`; none: the whole board) who hasn't signed this year's papers, asking them
 * to, from the admin asking (`by`). Whoever has signed them all, or was asked in the last ten minutes (a double
 * click, two admins at once), isn't emailed. `test`: a preview to `to` only.
 * → { sent, failed, errors, signed: n already signed, recent: [names], noEmail: [names], unsure }
 */
export async function askToSign(env, { slugs = null, by = '', replyTo = [], to = null } = {}) {
  if (!emailConfigured(env)) throw Object.assign(new Error('Email isn’t set up (RESEND_API_KEY)'), { status: 503 });
  await ensureSchema(env.DB);
  const test = Array.isArray(to);
  const year = thisYear();
  const [board, people, settings, docs, asks, seen] = await Promise.all([
    activeBoard(env.DB), roster(env.DB), getSettings(env.DB), listDocs(env.DB), signAsks(env.DB, year),
    env.DB.prepare('SELECT slug FROM board_seen').all().then((r) => new Set((r.results || []).map((x) => x.slug))),
  ]);
  const signable = docs.filter((d) => d.shared && d.sign && (d.body || (d.file && !d.file.staffOnly)));
  if (!signable.length) throw Object.assign(new Error('There’s nothing for the board to sign: tick Required on a paper in Documents, with its words or its file'), { status: 409 });
  const papersOf = (slug) => signable.filter((d) => !d.signed[slug]).map((d) => ({ title: d.title, id: d.id }));
  // Who it's from: the admin asking, else the one the invites come from
  const sender = staffFor(people, by) || staffFor(people, settings.invitesFrom);
  if (test) {
    const items = to.map((email) => ({ to: email, ...signAskEmail({ name: staffFor(people, email)?.name || '', email, papers: signable.map((d) => ({ title: d.title, id: d.id })), from: sender?.name || '', firstTime: true, test }) }));
    const r = await sendEmailItems(env, items, { from: items[0].from, tags: [{ name: 'kind', value: 'board-sign-ask-preview' }], replyTo });
    return { ...r, to };
  }
  const picked = board.filter((p) => !slugs || slugs.includes(p.slug));
  if (!picked.length) throw Object.assign(new Error('They aren’t on People → Board now'), { status: 409 });
  const left = picked.filter((p) => papersOf(p.slug).length);
  const noEmail = left.filter((p) => !isEmail(p.email)).map((p) => p.name);
  const recent = left.filter((p) => isEmail(p.email) && asks[p.slug] && Date.now() - Date.parse(asks[p.slug].at) < 10 * 60 * 1000);
  const recipients = left.filter((p) => isEmail(p.email) && !recent.includes(p));
  const base = { signed: picked.length - left.length, recent: recent.map((p) => p.name), noEmail };
  if (!recipients.length) return { sent: 0, failed: 0, errors: [], ...base };
  const items = recipients.map((p) => ({ to: p.email, ...signAskEmail({ name: p.name, email: p.email, papers: papersOf(p.slug), from: sender?.name || '', firstTime: !seen.has(p.slug) }) }));
  const r = await sendEmailItems(env, items, { from: items[0].from, tags: [{ name: 'kind', value: 'board-sign-ask' }], replyTo });
  // Asked, once Resend took it, or when it may have (no answer is no sure no); Resend's own error is a sure no
  const unsure = r.failed > 0 && r.errors.some((e) => !/^Resend \d+:/.test(String(e)) || /^Resend 50[234]:/.test(String(e)));
  if (r.sent || unsure) {
    const at = nowIso();
    for (const p of recipients) {
      await env.DB.prepare('INSERT INTO board_sign_asks (slug, year, at, by, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT(slug, year) DO UPDATE SET at = excluded.at, by = excluded.by, n = board_sign_asks.n + 1').bind(p.slug, year, at, String(by || '').slice(0, 200)).run();
    }
  }
  return { sent: r.sent, failed: r.failed, errors: r.errors, unsure: unsure || undefined, ...base };
}

// ─── The board page ─────────────────────────────────────────────────

async function siteDoc(DB, key) {
  try { return parse((await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(key).first())?.data, null); } catch { return null; }
}

/** Everything the board page shows, for a member (`member`) or an admin looking (`admin`) */
export async function portalData(env, { member = null, admin = false, adminEmail = '', now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const today = todayEastern(now);
  const [meetings, docs, numbers, history, people, filings, snapshot, settings, gifts] = await Promise.all([
    listMeetings(env.DB), listDocs(env.DB), liveNumbers(env, { now }), cashHistory(env.DB), roster(env.DB, { withEmails: true }),
    siteDoc(env.DB, 'financials'), siteDoc(env.DB, 'financial-snapshot'), getSettings(env.DB), giftsNow(env.DB, { now }).catch(() => null),
  ]);
  let seen = null;
  if (member) {
    seen = await env.DB.prepare('SELECT at FROM board_seen WHERE slug = ?').bind(member.slug).first();
    if (!seen || now - Date.parse(seen.at) > 10 * 60 * 1000) await env.DB.prepare('INSERT OR REPLACE INTO board_seen (slug, at) VALUES (?, ?)').bind(member.slug, new Date(now).toISOString()).run();
  }
  // A member's own documents (put with an item they present) are marked, so they can take them off again
  const own = member?.email ? new Set(((await env.DB.prepare('SELECT id FROM board_files WHERE lower(by) = ?').bind(String(member.email).toLowerCase()).all()).results || []).map((r) => r.id)) : new Set();
  const shared = meetings.map(forBoard).filter(Boolean).map((m) => (own.size ? { ...m, files: m.files.map((f) => (own.has(f.id) ? { ...f, mine: true } : f)) } : m));
  const mine = member?.slug || null;
  // A paper read as its PDF: its words, as read, to find it by them
  const fileWords = {};
  const pdfIds = docs.filter((d) => d.shared && !d.body && d.file?.type === 'application/pdf').map((d) => d.file.id);
  if (pdfIds.length) for (const r of ((await env.DB.prepare(`SELECT id, words FROM board_files WHERE id IN (${pdfIds.map(() => '?').join(',')})`).bind(...pdfIds).all()).results || [])) if (r.words) fileWords[r.id] = r.words.slice(0, 20000);
  // The words a member signed, for each paper they're asked to sign again: what changed, shown beside the new (from the
  // last version their signature counted on: a typo kept since isn't a change to them)
  const signedBodies = {};
  for (const d of docs) {
    // (or, in a new year, the wording they signed last time, when it's known and there's a newer one)
    const last = mine && d.prior?.[mine];
    const v = mine && d.body && !d.signed[mine] && (d.before?.[mine] ? Math.max(d.before[mine].version, d.signFrom - 1) : last && last.version && last.version < d.version ? last.version : 0);
    if (!v) continue;
    const row = await env.DB.prepare('SELECT body FROM board_doc_versions WHERE doc_id = ? AND version = ?').bind(d.id, v).first();
    if (row?.body) signedBodies[d.id] = row.body;
  }
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
    ...(admin && !member ? {
      practice: practice ? { id: practice.id, title: meetingName(practice), date: practice.date, live: practice.live } : null,
      // Board's "See it as the board will" on a meeting ahead not shared yet: what the board will see once it is, by its
      // link only (never in the lists, the search or Home, which stay as the board has them)
      previews: meetings.filter((m) => !m.shared && !m.notBoard && isDate(m.date) && m.date >= today)
        .map((m) => ({ ...forBoard({ ...m, shared: true }), shared: false, preview: true, myInvite: '', onCalendar: false })),
    } : {}),
    contact,
    admins: admins.map((a) => a.name),
    nextPending: pending ? {
      id: pending.id, date: pending.date, start: pending.start, end: pending.end, title: pending.title, name: meetingName(pending),
      location: pending.location, address: pending.address, video: pending.video || pending.invite?.meet || '',
      onCalendar: !!pendingInvite, myInvite: pendingInvite, inviteOut: inviteOut(pending), inviteBy: inviteFrom(pending, people, settings),
    } : null,
    // lastSeen: the visit before this one (a visit lasts 10 minutes), for what's new since
    // An admin looking: who they are on People (`as`), so the item they present asks them for its report too
    me: member ? { name: member.name, slug: member.slug, title: member.title, email: member.email, admin, lastSeen: seen?.at || null }
      : { name: null, slug: null, admin, as: people.staff.find((p) => String(adminEmail).toLowerCase().startsWith(`${String(p.name).split(/\s+/)[0].toLowerCase()}@`))?.slug || null },
    today,
    // Their own answer here, else how they answered the calendar invite (which also means it's on their calendar)
    meetings: shared.map((m) => {
      const full = meetings.find((x) => x.id === m.id);
      const invite = mine ? repliesOf(full)[mine] || '' : '';
      return { ...m, myInvite: invite, onCalendar: !!invite, inviteOut: inviteOut(full), inviteBy: inviteFrom(full, people, settings) };
    }),
    next: nextMeeting(shared, today)?.id || null,
    quorum: settings.quorum,
    actions: openActions(shared).map((a) => ({ ...a, mine: !!mine && a.owner === mine })),
    // Who has signed is Board's to see: a member sees how many of the board have, and their own (its copy, if one's in)
    // (and whether they signed an earlier wording, before the board was asked to sign again)
    docs: docs.filter((d) => d.shared || !member).map(({ signed, earlier, before, prior, wordsBy, ...d }) => ({
      ...(d.shared ? {} : { hidden: true }),
      ...d, file: d.file && !d.file.staffOnly ? d.file : null,
      signedByMe: mine && signed[mine] ? { ...signed[mine], drive: !!signed[mine].drive } : null,
      signedEarlier: !!mine && !signed[mine] && earlier.includes(mine),
      // Not signed this year, but in an earlier one: when, and on which wording (0: not known)
      signedBefore: mine && !signed[mine] && !earlier.includes(mine) && prior[mine] ? { year: prior[mine].year, at: prior[mine].how === 'drive' ? '' : prior[mine].at, version: prior[mine].version } : null,
      ...(signedBodies[d.id] ? { signedBody: signedBodies[d.id] } : {}),
      ...(!d.body && d.file && fileWords[d.file.id] ? { fileWords: fileWords[d.file.id] } : {}),
      signedCount: people.board.filter((p) => signed[p.slug]).length,
    })),
    numbers,
    // Cash at each month's end: QuickBooks' own month-ends once it's connected (13 of them, the books'), else the banks' history
    cashHistory: numbers.books?.months?.length > 1 ? [...numbers.books.months].reverse().map((r) => ({ month: r.month, total: r.total, at: r.end })) : history,
    // The public copies, through the site's own /files/ route so the page's viewer can open them
    filings: (filings?.documents || []).map((d) => ({ title: d.title, year: d.year, type: d.type, url: String(d.url || '').replace(/^https:\/\/files\.sunshineonaranneyday\.com\/financials\//, '/files/financials/') }))
      .filter((d) => /^(https:\/\/|\/files\/financials\/)/.test(d.url)),
    snapshot: snapshot || null,
    // This year's gifts of $1,000 or more, from Zeffy (./_board-gifts.js)
    gifts,
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
  // One never comes, so the admin practising (checking in as one more) never makes more here than the board has
  const never = hashed.length > 1 ? hashed.reduce((a, b) => (b.h < a.h ? b : a)).p.slug : '';
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
    // An admin previews it on the screen before it's shared (as the board will see it), acting in nothing
    if (!m.shared && !(admin && !member)) throw err('That meeting isn’t on the board page', 404);
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
  // As the board sees it (an admin's preview of one not shared yet too: never a private note or a staff-only file)
  const seen = m.practice ? m : forBoard({ ...m, shared: true });
  const sections = seen.sections.map((sec) => ({
    id: sec.id, title: sec.title, minutes: sec.minutes || 0,
    items: sec.items.filter(isFilled).map((it) => ({ id: it.id, title: it.title, motion: it.motion || '', presenter: it.presenter, who: it.who, notes: it.notes, confidential: it.confidential, live: it.live, also: it.also, about: it.about, docs: it.docs,
      report: it.report, reportBy: it.reportBy, reportAt: it.reportAt, reportLook: it.reportLook || '' })),
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
  const q = settings.quorum || majority(board.length);
  return {
    id: m.id, practice: !!m.practice, updatedAt: m.updatedAt, title: meetingName(m), date: m.date, start: m.start, end: m.end,
    live: { startedAt: m.live.startedAt, endedAt: m.live.endedAt, itemId: m.live.itemId, fileId: m.live.fileId, page: m.live.page, part: m.live.part, screen: m.live.screen, sectionId: m.live.sectionId, sectionAt: m.live.sectionAt, floor: m.live.floor },
    sections,
    // What the screen shows: the board's files (never a staff-only one), the last meeting's minutes, the locked numbers
    files: seen.files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, kind: f.kind, at: f.at })),
    prior,
    snapshot: m.snapshot || null,
    here: { board: here.size, of: board.length, quorum: q, met: q ? here.size >= q : null, remote: [...here.values()].filter((h) => h === 'remote').length },
    // The roll call on the screen: the board on the meeting's list, each one here (in the room or by video) or not yet
    roll: board.map((p) => ({ slug: p.slug || '', name: p.name, how: here.get(p.slug || p.key) || '' })),
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
  const own = (sections) => sections.map((sec) => ({ ...sec, id: uid('s_'), items: sec.items.filter(isFilled).map((it) => {
    const prev = it.live === 'minutes' && it.about ? meetings.find((x) => x.id === it.about) : null;
    const f = prev?.shared ? minutesFileOf(prev) : null;
    if (f && !borrowed.includes(f.id)) borrowed.push(f.id);
    return { ...it, id: uid('i_'), title: it.title || LIVE_TITLES[it.live] || '', about: '', docs: f ? [f.id, ...(it.docs || []).filter((d) => d !== f.id)] : it.docs };
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

/**
 * For the admin's Members tab: each active board member, their email on file, last visit, when they were last asked
 * to sign this year's papers (`asked`: { at, by, n }), and what they signed in the years before this one (`pastYears`,
 * newest first: [{ year, docId, title, name, at, how, copy, drive }]; this year's are on the documents)
 */
export async function memberStatus(DB) {
  await ensureSchema(DB);
  const [board, seen, past, titles, copies, asks] = await Promise.all([
    activeBoard(DB),
    DB.prepare('SELECT slug, at FROM board_seen').all().then((r) => Object.fromEntries((r.results || []).map((x) => [x.slug, x.at]))),
    DB.prepare('SELECT * FROM board_signatures WHERE year < ? ORDER BY year DESC, at').bind(thisYear()).all().then((r) => r.results || []),
    DB.prepare('SELECT data FROM board_docs').all().then((r) => Object.fromEntries((r.results || []).map((x) => cleanDoc(parse(x.data))).map((d) => [d.id, d.title]))),
    filesOf(DB, 'signed').then((by) => Object.fromEntries(Object.values(by).flat().map((f) => [f.id, f]))),
    signAsks(DB),
  ]);
  return board.sort(comparePeople).map((p) => ({
    slug: p.slug, name: p.name, title: p.title || '', seat: p.seat || '', email: p.email, lastSeen: seen[p.slug] || null,
    pastYears: past.filter((s) => s.slug === p.slug && titles[s.doc_id]).map((s) => ({ year: Number(s.year), docId: s.doc_id, title: titles[s.doc_id], ...signatureOf(s, copies) })),
    // Asked by email to sign this year's: when last, how many times
    asked: asks[p.slug] || null,
  }));
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
 *   - every 5 minutes at most, Access's board list kept in step with People → Board (./_board-access.js),
 *     and so is the board's Google Group, board@soardcharity.com (./_board-group.js)
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
 *   - every 15 minutes, the year's major gifts from Zeffy (./_board-gifts.js)
 *   - once a day, the month's bank balance for the board page's history
 * Never throws.
 */
export async function maybeRunBoard(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    await maybeSyncBoardAccess(env, { fetchImpl, now });
    await (await import('./_board-group.js')).maybeSyncBoardGroup(env, { fetchImpl, now });
    await maybeSyncBoardCalendar(env, { fetchImpl, now });
    const invites = await import('./_board-invite.js');
    await invites.maybeRefreshInvites(env, { fetchImpl, now });
    await invites.maybeCheckInvites(env, { fetchImpl, now });
    await maybeSendApprovedAgendas(env, { now });
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
    // The year's gifts of $1,000 or more, from Zeffy every 15 minutes
    await (await import('./_board-gifts.js')).maybeReadGifts(env, { fetchImpl, now });
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
    // board@soardcharity.com following the board (./_board-group.js): counts and times, never a name or an email
    group: await (await import('./_board-group.js')).groupStatus(env).then((g) => ({
      configured: g.configured, ok: g.ok, current: g.current, needs: g.needs, members: g.members, wanted: g.wanted, missing: g.missing.length,
      syncedAt: g.syncedAt, failedAt: g.failedAt, error: g.error ? String(g.error).replace(/\S+@\S+/g, '…').slice(0, 200) : null,
      lastChangeAt: g.changes[0]?.at || null, added: g.changes[0]?.added.length || 0, removed: g.changes[0]?.removed.length || 0,
    })),
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
    calendar: { configured: Boolean(env.GOOGLE_CALENDAR_KEY), ok: !!cal.ok, checkedAt: cal.checkedAt || null, invites: cal.invites || 0, gone: cal.gone || 0, failing: (cal.errors || []).length },
    mail: {
      configured: Boolean(env.GOOGLE_CALENDAR_KEY), ok: !!mail.ok, needsScope: !!mail.needsScope, checkedAt: mail.checkedAt || null, waiting: mail.backlog ?? mail.waiting ?? 0, failing: (mail.errors || []).length,
      meetings: mail.totals?.meetings || 0, files: mail.totals?.files || 0, skipped: mail.totals?.skipped || 0,
    },
    drive: await (await import('./_board-drive.js')).driveStatus(env.DB).then((d) => ({
      checkedAt: d.checkedAt || null, needsScope: !!d.needsScope, apiOff: !!d.apiOff, failing: (d.errors || []).length,
      backlog: d.backlog || 0, meetings: d.meetings || 0, files: d.files || 0,
    })),
  };
}
