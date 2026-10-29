/**
 * Board's past meetings from Google Drive
 * ===========================================================================
 * SOARD keeps each board meeting's minutes (and, lately, its whole packet)
 * in Google Drive: the "Board" folder (Settings → the Drive folder; SOARD's
 * Leadership folder until saved), a "2025 Board" folder for each year, and in
 * it a folder for each meeting named by its date ("7.24.25 Meeting",
 * "8.6.26 Board Meeting"). The older years are kept other ways, and Board
 * reads those too: minutes and agendas loose in the year folder, named as the
 * board meeting's ("Board Meeting Minutes 1/21/16", "SOARD Board Mtg Notes -
 * 20140605.docx", "SOARD Board Meeting- June 13, 2018.docx"), and a folder of
 * them without a date ("2015 Board Meeting Notes"), or one meeting's folder
 * without one ("2018 SOARD End of Year Board Meeting"). Every hour, and every
 * minute while there's a backlog, Board reads them:
 *   - each meeting folder (or a day's loose minutes and agenda) is one meeting
 *     on its date: the meeting already in Board within three days (the
 *     calendar may have it), else a past record
 *   - its files go on that meeting for the board (Google Docs, Sheets and
 *     Slides as PDFs): minutes, the agenda, financial statements, the rest as
 *     packet files, one copy of each ("Minutes.docx", "Minutes.docx.pdf" and
 *     "Copy of Minutes.docx" are the same minutes). A meeting's screenshots
 *     of its numbers come in; photos, Pages files,
 *     resumes, anything over 50 MB and the other loose files beside the
 *     meeting folders (expectations, nominees, birthdays, committee meetings)
 *     are left alone
 *   - the minutes fill in who was there (when nobody marked it), the
 *     meeting's sections and notes (when its agenda is still a draft), and
 *     mark the minutes approved once a later meeting exists
 *   - a past meeting nobody here worked on goes on the board page
 *   - a file is brought in once; one changed in Drive replaces its copy
 *   - a file added later comes in too: a meeting folder is looked in again
 *     hourly for the meetings of the last year, weekly for older ones
 * Meetings ahead are left alone: their agendas are written in Board.
 *
 * Board → Documents gets SOARD's own papers the same way, hourly once the
 * meetings are read: everything in the newest "2026 Board Manual" folder (the
 * signed bylaws, the board manual with its policies; never the members' signed
 * copies in the folders inside it), and, wherever the shared drive keeps them
 * when that folder doesn't, the Articles of Incorporation, the Articles of
 * Amendment, the IRS 501(c)(3) determination letter, the EIN letter, the W-9,
 * the state's Charitable Organization Permit and the D&O insurance policy, one
 * copy of each (the newest, for the ones renewed). Only those, by name, and
 * only in the shared drive: the folders they sit in hold other people's
 * papers, and a person's own Drive holds other companies' and their own. A
 * newer copy in Drive replaces the file; a document taken out in Board stays
 * out.
 *
 * It never writes, moves, shares or deletes anything in Drive.
 *
 * Reads as one of Board's admins through the site's service account (domain-
 * wide delegation, drive.readonly), which Google Admin must allow next to the
 * calendar scope (Board → Meetings says how until it does).
 */

import { accessToken } from './_google-calendar.js';
import { boardAdmins, peopleRows, readSettings, readState, writeState } from './_board-roles.js';
import { ensureSchema, listMeetings, getMeeting, saveMeeting, patchMeeting, putFile, deleteFile, roster, saveDoc, cleanDoc, MAX_FILE } from './_board.js';
import { fileText, attendanceIn } from './_board-mail.js';
import { parseAgendaText, cleanMeeting, agendaIsDraft, todayEastern, isDate, docHtmlText, readAgain, AGENDA_READER } from '../../public/admin/board-shared.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** SOARD's "Board" folder in the Sunshine - Leadership shared drive */
export const DEFAULT_DRIVE_FOLDER = '18UkzUWI1x_NZiGKt5CAeWYINCaRYVGgZ';
export const DRIVE_BY = 'Google Drive';
const KEY = 'drive';
const DONE = 'drive-done';
// 2: the older years' loose minutes and undated meeting folders, one copy of each document
// 3: a meeting's screenshots of its numbers and files up to 50 MB, every folder read once more for them
const VERSION = 3;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BUDGET_MS = 8000;
// As big as Board keeps; the words are read from those up to 15 MB
const MAX_BYTES = MAX_FILE;
const TEXT_MAX = 15 * 1024 * 1024;
const ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
const FOLDER = 'application/vnd.google-apps.folder';
// Google's own files, as PDFs (a Doc's text is read too)
const GOOGLE = {
  'application/vnd.google-apps.document': 'Doc',
  'application/vnd.google-apps.spreadsheet': 'Sheet',
  'application/vnd.google-apps.presentation': 'Slides',
};
const DOC = 'application/vnd.google-apps.document';
// A meeting folder checked again each hour while it's this recent, and each week after (a file added to an old meeting)
const RECENT_MS = 400 * DAY;
const WEEK = 7 * DAY;
// Never the meetings' own: the year folders' loose files never come through here, these are what a meeting folder can hold that isn't
const RESUME = /\b(resume|résumé|curriculum vitae|cv)\b/i;
const IMAGE = /\.(jpe?g|png|gif|heic|heif|webp|tiff?|bmp|svg)$/i;
// A picture from a camera or a phone, or of someone (a meeting's screenshots of its numbers come in): "IMG_0514.HEIC", "image007.jpg"
const PHOTO = /^(img|dsc|pxl|image|photo)\b|^(img|dsc|pxl|image)[\s_-]?\d+|headshot|\.(heic|heif)$/i;
const APPLE = /\.(pages|numbers|key)$/i;
// A folder without a date that holds board meetings, or is one: "2015 Board Meeting Notes", "2016 Board Meetings", "2018 SOARD End of Year Board Meeting"
const MEETINGS_FOLDER = /\bboard (meeting|mtg)|\bmeeting notes\b|\bminutes\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS board_drive (drive_id TEXT PRIMARY KEY, meeting_id TEXT, board_file_id TEXT, modified TEXT, name TEXT, folder_id TEXT, at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_board_drive_meeting ON board_drive(meeting_id)',
  // Documents' papers from Drive: one row a document ("articles", "manual:signed amended bylaws")
  'CREATE TABLE IF NOT EXISTS board_drive_docs (slot TEXT PRIMARY KEY, doc_id TEXT, drive_id TEXT, board_file_id TEXT, modified TEXT, name TEXT, at TEXT)',
];
const _ready = new WeakSet();
async function ensureDrive(DB) {
  if (_ready.has(DB)) return;
  await ensureSchema(DB);
  for (const s of SCHEMA) await DB.prepare(s).run();
  _ready.add(DB);
}

/** A Drive folder from a link ("…/folders/<id>?…", "…?id=<id>") or its bare ID; '' when it isn't one */
export function folderIdOf(link) {
  const s = String(link || '').trim();
  const m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : '';
}

const pad = (n) => String(n).padStart(2, '0');
/**
 * The meeting date a folder's name gives: "1.23.25", "8.6.26 Board Meeting",
 * "11.13.2025", "2025.07.24" (or with dashes, slashes or underscores).
 * `year` (the year folder's) must agree, give or take one (a January meeting
 * filed with the year before). → 'YYYY-MM-DD' or ''
 */
export function folderDate(name, year = 0) {
  const s = String(name || '');
  let y; let mo; let d;
  let m = s.match(/\b(20\d{2})[._/-](\d{1,2})[._/-](\d{1,2})\b/);
  if (m) [, y, mo, d] = m;
  else {
    m = s.match(/\b(\d{1,2})[._/-](\d{1,2})[._/-](\d{4}|\d{2})\b/);
    if (!m) return '';
    [, mo, d, y] = m;
    if (y.length === 2) y = `20${y}`;
  }
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  // A real day ("2.30.25" isn't one, though a date parser would roll it over)
  if (!isDate(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return '';
  if (year && Math.abs(Number(y) - year) > 1) return '';
  return date;
}

/**
 * A document's name without its copies' marks: "Copy of …", "(1)", and its
 * extensions ("Minutes.docx (1).pdf" → "minutes"), so the copies of one
 * document match
 */
export function stemOf(name) {
  let s = String(name || '').trim().replace(/^copy of\s+/i, '');
  for (let was = ''; was !== s;) {
    was = s;
    s = s.replace(/\s*\(\d+\)\s*$/, '').replace(/\.(docx?|pdf|xlsx?|pptx?|rtf|txt|csv)\s*$/i, '').trim();
  }
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The meeting date a file's name gives: what a folder's can ("1.27.16", "1/21/16"),
 * and the older files' ways: "December 17, 2018", "Oct. 15, 2015", "20140605",
 * "012121" (month, day, year), and with the year folder's year, "June 2 8am"
 * and "2_26". → 'YYYY-MM-DD' or ''
 */
export function fileDate(name, year = 0) {
  const s = String(name || '').trim().replace(/^copy of\s+/i, '').replace(/(\s*\(\d+\)|\.(docx?|pdf|xlsx?|pptx?|rtf|txt|csv))+\s*$/i, '').trim();
  const day = (y, mo, d) => {
    const date = `${y}-${pad(mo)}-${pad(d)}`;
    if (!isDate(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return '';
    return year && Math.abs(Number(y) - year) > 1 ? '' : date;
  };
  const dated = folderDate(s, year);
  if (dated) return dated;
  let m = s.match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) return day(m[1], m[2], m[3]);
  m = s.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) return day(`20${m[3]}`, m[1], m[2]);
  m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(20\d{2})\b)?/i);
  if (m) return m[3] || year ? day(m[3] || year, MONTHS.indexOf(m[1].toLowerCase()) + 1, m[2]) : '';
  m = year ? s.match(/(?:^|[^\d./_-])(\d{1,2})[._/-](\d{1,2})$/) : null;
  return m ? day(year, m[1], m[2]) : '';
}

/** A loose file named as a board meeting's own: its minutes, notes or agenda ("Board Meeting Minutes 1/21/16"), never a committee's */
export const meetingDoc = (name) => /\bboard\b/i.test(name) && /(meeting|mtg|minutes|agenda|notes)\b/i.test(name) && !/committee/i.test(name);

/** What a file is, by its name: minutes, agenda, financials, or a packet file */
export function driveKind(name) {
  const n = String(name || '');
  if (/minutes|\bnotes\b/i.test(n)) return 'minutes';
  if (/agenda/i.test(n)) return 'agenda';
  if (/statement of|financial|budget|balance sheet|profit|p\s*&\s*l\b|\bp&l\b|income|\bsales\b|\bytd\b|\btotals?\b/i.test(n)) return 'financials';
  return 'packet';
}

/** Why a file in a meeting folder isn't brought in (in words), or '' */
export function driveSkip(f) {
  const name = String(f.name || '');
  if (f.mimeType === FOLDER) return 'a folder';
  if ((/^image\//.test(f.mimeType || '') || IMAGE.test(name)) && (PHOTO.test(name) || /heic|heif/i.test(f.mimeType || ''))) return 'a photo';
  if (/^(video|audio)\//.test(f.mimeType || '')) return 'a video or recording';
  if (APPLE.test(name) || /iwork|apple\.(pages|numbers|keynote)/i.test(f.mimeType || '')) return 'an Apple Pages, Numbers or Keynote file';
  if (RESUME.test(name)) return 'a resume';
  if (/^application\/vnd\.google-apps\./.test(f.mimeType || '') && !GOOGLE[f.mimeType]) return 'a Google file that can’t be a document';
  if (!GOOGLE[f.mimeType] && Number(f.size) > MAX_BYTES) return 'over 50 MB';
  return '';
}

// ─── Drive ──────────────────────────────────────────────────────────

async function drive(token, path, fetchImpl, { bytes = false, text = false } = {}) {
  const res = await fetchImpl(`${DRIVE_API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw Object.assign(new Error(`Google Drive answered ${res.status}: ${body?.error?.message || ''}`.trim()), { status: res.status });
  }
  if (bytes) return new Uint8Array(await res.arrayBuffer());
  if (text) return res.text();
  return res.json();
}

/** The files a search finds, every page (`where`: which drive, for a search beyond one folder) */
async function listFiles(token, query, fetchImpl, where = '') {
  const out = [];
  let page = '';
  do {
    const q = encodeURIComponent(query);
    const r = await drive(token, `/files?q=${q}&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,size)')}&pageSize=1000&${ALL}${where ? `&${where}` : ''}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, fetchImpl);
    out.push(...(r.files || []));
    page = r.nextPageToken || '';
  } while (page && out.length < 5000);
  return out;
}

/** Everything in a folder (not in the trash), every page */
const children = (token, id, fetchImpl) => listFiles(token, `'${id}' in parents and trashed = false`, fetchImpl);

/**
 * The meetings: the meeting folders under each "2025 Board" folder (and any
 * right in the root), and in a year folder the older ways, a day's loose
 * minutes and agenda (`files`, an id of the folder and the day) and an
 * undated folder of meetings. → [{ id, name, date, files?, older? }], newest first
 */
async function meetingFolders(token, root, fetchImpl) {
  const top = await children(token, root, fetchImpl);
  const found = [];
  // A folder's loose minutes and agendas, a meeting a day
  const loose = (parent, files, year) => {
    const days = new Map();
    for (const f of files.filter((x) => x.mimeType !== FOLDER && meetingDoc(x.name))) {
      const date = fileDate(f.name, year);
      if (date) days.set(date, [...(days.get(date) || []), f]);
    }
    for (const [date, fs] of days) found.push({ id: `${parent.id}:${date}`, name: `${parent.name}: ${fs[0].name}${fs.length > 1 ? ` and ${fs.length - 1} more` : ''}`, date, files: fs, older: true });
  };
  for (const f of top.filter((x) => x.mimeType === FOLDER)) {
    const y = f.name.trim().match(/^(\d{4}) Board$/);
    if (!y) {
      const date = folderDate(f.name);
      if (date) found.push({ id: f.id, name: f.name, date });
      continue;
    }
    const year = Number(y[1]);
    const inYear = await children(token, f.id, fetchImpl);
    for (const c of inYear.filter((x) => x.mimeType === FOLDER)) {
      const date = folderDate(c.name, year);
      if (date) { found.push({ id: c.id, name: c.name, date }); continue; }
      if (!MEETINGS_FOLDER.test(c.name)) continue;
      // Undated: one meeting's folder when its minutes and agenda all name one day, else a folder of meetings
      const inside = await children(token, c.id, fetchImpl);
      const subs = inside.filter((x) => x.mimeType === FOLDER).map((x) => ({ id: x.id, name: x.name, date: folderDate(x.name, year) })).filter((x) => x.date);
      const days = new Set(inside.filter((x) => x.mimeType !== FOLDER && meetingDoc(x.name)).map((x) => fileDate(x.name, year)).filter(Boolean));
      if (!subs.length && days.size === 1) found.push({ id: c.id, name: c.name, date: [...days][0], older: true });
      else { found.push(...subs); loose(c, inside, year); }
    }
    loose(f, inYear, year);
  }
  return found.sort((a, b) => b.date.localeCompare(a.date));
}

/** The files of a meeting folder, and of the folders right inside it */
async function folderFiles(token, id, fetchImpl) {
  const here = await children(token, id, fetchImpl);
  const out = here.filter((x) => x.mimeType !== FOLDER);
  for (const sub of here.filter((x) => x.mimeType === FOLDER)) out.push(...(await children(token, sub.id, fetchImpl)).filter((x) => x.mimeType !== FOLDER));
  return out;
}

/** A Drive file's bytes as Board keeps it (Google's own as a PDF) and, for minutes, its text → { name, bytes, type, text } */
async function fetchFile(env, token, f, fetchImpl, { wantText }) {
  if (GOOGLE[f.mimeType]) {
    // (export takes no shared-drive flag: a file's ID is enough)
    const bytes = await drive(token, `/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent('application/pdf')}`, fetchImpl, { bytes: true });
    // A Doc's text from its HTML, which keeps each list's levels (its plain text writes every level as "1."); the plain text if that fails
    const exported = (type) => drive(token, `/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(type)}`, fetchImpl, { text: true }).catch(() => '');
    const text = wantText && f.mimeType === DOC ? docHtmlText(await exported('text/html')) || await exported('text/plain') : '';
    const name = keptName(f);
    return { name, bytes, type: 'application/pdf', text: text || (wantText ? await fileText(env, { name, bytes }) : '') };
  }
  const bytes = await drive(token, `/files/${encodeURIComponent(f.id)}?alt=media&${ALL.split('&')[0]}`, fetchImpl, { bytes: true });
  if (bytes.byteLength > MAX_BYTES) return null;
  return { name: f.name, bytes, type: f.mimeType || 'application/octet-stream', text: wantText && bytes.byteLength <= TEXT_MAX ? await fileText(env, { name: f.name, bytes }) : '' };
}

// ─── One meeting folder ─────────────────────────────────────────────

const untouched = (m) => ['the calendar', 'board email', DRIVE_BY, ''].includes(m.updatedBy || '');
/** The name Board keeps a Drive file under (Google's own as a PDF) */
const keptName = (f) => (!GOOGLE[f.mimeType] || /\.pdf$/i.test(f.name) ? f.name : `${f.name}.pdf`);
/** This file filled its meeting's agenda by an older reader, nobody has changed it since, and it's to be read again once */
const readsAgainFrom = (m, name) => m?.agendaFrom?.kind === 'drive' && readAgain(m) && stemOf(m.agendaFrom.name) === stemOf(name);

/**
 * What Board keeps of some Drive files: one copy of each document, the
 * original over a "Copy of", a PDF (or Google's own, as one) over a Word file,
 * then the newest. → { kept, skipped: [names with why] }
 */
function oneOfEach(files) {
  const skipped = [];
  const best = new Map();
  const rank = (f) => (/^copy of /i.test(f.name) ? 2 : 0) + (f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name) || GOOGLE[f.mimeType] ? 0 : 1);
  for (const f of files) {
    const why = driveSkip(f);
    if (why) { skipped.push(`${f.name} (${why})`); continue; }
    const key = stemOf(f.name);
    const b = best.get(key);
    if (!b || rank(f) < rank(b) || (rank(f) === rank(b) && (f.modifiedTime || '') > (b.modifiedTime || ''))) best.set(key, f);
  }
  for (const f of files) if (!driveSkip(f) && best.get(stemOf(f.name)) !== f) skipped.push(`${f.name} (a copy of ${best.get(stemOf(f.name)).name})`);
  return { kept: [...best.values()], skipped };
}
const ORDER = { minutes: 0, agenda: 1, financials: 2, packet: 3 };

/**
 * A meeting folder onto its meeting. → { meetingId, made, files (brought in or
 * replaced), skipped: [names with why] }
 */
async function bringFolder(env, { token, folder, fetchImpl, people, now }) {
  const today = todayEastern(now);
  let meetings = await listMeetings(env.DB);
  const near = meetings.filter((m) => m.date && !m.notBoard && Math.abs(Date.parse(`${m.date}T12:00:00Z`) - Date.parse(`${folder.date}T12:00:00Z`)) <= 3 * DAY)
    .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(folder.date)) - Math.abs(Date.parse(b.date) - Date.parse(folder.date)));
  let m = near[0] || null;
  const files = folder.files || await folderFiles(token, folder.id, fetchImpl);
  const { kept, skipped } = oneOfEach(files);
  // The older years named their minutes for the meeting alone ("SOARD Board Meeting- June 13, 2018.docx")
  const kindOf = (name) => { const k = driveKind(name); return folder.older && k === 'packet' && meetingDoc(name) ? 'minutes' : k; };
  const wanted = kept.map((f) => ({ ...f, kind: kindOf(f.name) }));
  // A folder with nothing to bring (empty, or only photos) doesn't make a meeting of its own
  if (!m && !wanted.length) return { meetingId: null, made: false, files: 0, skipped };
  let made = false;
  if (!m) {
    m = await saveMeeting(env.DB, cleanMeeting({ date: folder.date }), { by: DRIVE_BY });
    made = true;
    meetings = await listMeetings(env.DB);
  }
  wanted.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  let brought = 0;
  for (const f of wanted) {
    const row = await env.DB.prepare('SELECT * FROM board_drive WHERE drive_id = ?').bind(f.id).first();
    const textual = f.kind === 'minutes' || f.kind === 'agenda';
    const unchanged = row && row.modified === (f.modifiedTime || '') && row.meeting_id === m.id;
    // A file already here is read again only for the agenda an older reader filled from it (its copy stays as it is)
    if (unchanged && !(textual && readsAgainFrom(await getMeeting(env.DB, m.id), keptName(f)))) continue;
    const got = await fetchFile(env, token, f, fetchImpl, { wantText: textual });
    if (!got) { skipped.push(`${f.name} (over 50 MB)`); continue; }
    if (!unchanged) {
      const current = await getMeeting(env.DB, m.id);
      // Changed in Drive: the old copy goes. The same document already here (board email or another copy in Drive brought it): kept, not doubled
      if (row?.board_file_id) await deleteFile(env, row.board_file_id);
      const same = current.files.find((x) => stemOf(x.name) === stemOf(got.name) && x.id !== row?.board_file_id);
      let fileId = same?.id || '';
      if (!same) {
        try {
          fileId = (await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([got.bytes], got.name, { type: got.type }), kind: f.kind, staffOnly: false, by: DRIVE_BY })).id;
        } catch (err) {
          if (err.status === 415 || err.status === 413) { skipped.push(`${f.name} (${err.status === 415 ? 'not a kind of file Board keeps' : 'too big'})`); continue; }
          throw err;
        }
      }
      await env.DB.prepare('INSERT OR REPLACE INTO board_drive (drive_id, meeting_id, board_file_id, modified, name, folder_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(f.id, m.id, fileId, f.modifiedTime || '', got.name, folder.id, new Date(now).toISOString()).run();
      brought += 1;
    }
    // What the minutes (or the agenda) say: who was there, the sections and notes, approved once a later meeting exists
    if ((f.kind === 'minutes' || f.kind === 'agenda') && got.text) {
      const parsed = parseAgendaText(got.text, people);
      const who = f.kind === 'minutes' ? (parsed.attendance.length ? parsed.attendance : attendanceIn(got.text, people)) : [];
      const enough = parsed.sections.filter((s) => s.items.length).length >= 2;
      const later = meetings.filter((x) => x.date > folder.date).sort((a, b) => a.date.localeCompare(b.date))[0];
      await patchMeeting(env.DB, m.id, (cur) => {
        const next = { ...cur };
        if (who.length && !cur.attendance.some((p) => p.status)) next.attendance = who;
        // An empty or drafted agenda, or one an older reader filled from this file (read again once, kept as it was if it reads no better)
        const again = readsAgainFrom(cur, got.name);
        if (enough && (agendaIsDraft(cur) || again)) Object.assign(next, { sections: parsed.sections, agendaFrom: { kind: 'drive', name: got.name, at: new Date(now).toISOString(), v: AGENDA_READER } });
        else if (again) next.agendaFrom = { ...cur.agendaFrom, v: AGENDA_READER };
        if (f.kind === 'minutes' && later && untouched(cur) && cur.minutes !== 'approved') Object.assign(next, { minutes: 'approved', approvedOn: later.date <= today ? later.date : today });
        return next;
      });
    }
  }
  // An agenda an older reader filled from this folder that wasn't read again (its file is gone or renamed): kept, not tried again
  // (and one this folder filled before that it now goes past, so it's never waited on)
  const filled = ((await env.DB.prepare('SELECT DISTINCT meeting_id FROM board_drive WHERE folder_id = ?').bind(folder.id).all()).results || []).map((r) => r.meeting_id);
  for (const id of new Set([m.id, ...filled])) {
    const x = await getMeeting(env.DB, id);
    if (x?.agendaFrom?.kind === 'drive' && readAgain(x)) await patchMeeting(env.DB, id, (cur) => (readAgain(cur) ? { ...cur, agendaFrom: { ...cur.agendaFrom, v: AGENDA_READER } } : cur));
  }
  // The board's own packet and minutes: a past meeting nobody here worked on goes on the board page
  if (brought || made) await patchMeeting(env.DB, m.id, (cur) => (untouched(cur) && cur.date < today && !cur.shared ? { ...cur, shared: true } : cur));
  return { meetingId: m.id, made, files: brought, skipped };
}

// ─── Bylaws and SOARD's papers, for Documents ───────────────────────

/**
 * SOARD's own papers, wherever the shared drive keeps them, by what each one's
 * name says (`terms` find it in Drive). The founding papers don't change: the
 * cleanest copy, the one filed. The rest are renewed (`newest`). An EIN or a
 * W-9 must name SOARD: Drive holds vendors' and other companies' too
 */
export const PAPERS = [
  { slot: 'articles', title: 'Articles of Incorporation', re: /articles of incorporation/i, terms: ['Articles of Incorporation'] },
  { slot: 'amendment', title: 'Articles of Amendment', re: /articles of amendment/i, terms: ['Articles of Amendment'] },
  { slot: 'irs-letter', title: 'IRS 501(c)(3) determination letter', re: /letter of determination|determination letter/i, terms: ['Letter of Determination', 'Determination Letter'] },
  { slot: 'ein', title: 'EIN letter', re: /\bEIN\b/, not: /401\s*\(?k/i, soard: true, newest: true, terms: ['EIN'] },
  { slot: 'w9', title: 'W-9', re: /\bW-?9\b/i, soard: true, newest: true, terms: ['W9', 'W-9'] },
  { slot: 'charity-permit', title: 'Charitable Organization Permit', re: /charitable organization (permit|registration)/i, newest: true, terms: ['Charitable Organization'] },
  { slot: 'dno', title: 'D&O insurance', re: /\bD\s?&\s?O\b|directors (and|&) officers/i, newest: true, terms: ['D&O', 'Insurance', 'Directors'] },
];
const SOARD_NAME = /soard|sunshine/i;
const paperOf = (name) => PAPERS.find((p) => p.re.test(name) && !p.not?.test(name) && (!p.soard || SOARD_NAME.test(name))) || null;
// Never a draft or a markup of one
const NOT_FINAL = /^copy of\b|redline|\bdraft\b/i;
/** The latest year a paper's name gives ("2026 W9", "24-25 D&O"), else 0 */
export function nameYear(name) {
  const s = String(name || '');
  const years = [...s.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number(m[1]));
  const span = s.match(/\b(\d{2})\s*[-–]\s*(\d{2})\b/);
  if (span && Number(span[2]) === Number(span[1]) + 1) years.push(2000 + Number(span[2]));
  return years.length ? Math.max(...years) : 0;
}

/** Which Documents entry a Drive file fills: one of SOARD's papers, else the board manual's own by its name (years aside) */
export function docSlot(name) {
  const p = paperOf(name);
  if (p) return p.slot;
  return `manual:${stemOf(name).replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim()}`;
}
/** A document's title from its file name: "SunShine on a Ranney Day, Inc._Board Manual with Policies .pdf" → "SunShine on a Ranney Day, Inc. Board Manual with Policies" */
export const docTitle = (name) => String(name || '').replace(/(\s*\(\d+\)|\.(docx?|pdf|xlsx?|pptx?|rtf|txt|csv))+\s*$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
export const docKind = (name) => (/bylaw|by-law|articles|determination|incorporat|charter/i.test(name) ? 'governance' : /polic|manual|handbook|conflict|whistle|retention|code of/i.test(name) ? 'policy' : 'other');

/**
 * The papers Documents gets from Drive → [{ slot, title, kind, year, file }]:
 * the newest "2026 Board Manual" folder's own files, then SOARD's papers it
 * doesn't hold, one copy of each from the shared drive
 */
async function papers(token, root, fetchImpl) {
  const { driveId } = await drive(token, `/files/${encodeURIComponent(root)}?fields=driveId&${ALL.split('&')[0]}`, fetchImpl);
  const where = driveId ? `corpora=drive&driveId=${encodeURIComponent(driveId)}` : 'corpora=user';
  const manuals = (await listFiles(token, `name contains 'Board Manual' and mimeType = '${FOLDER}' and trashed = false`, fetchImpl, where))
    .map((f) => ({ ...f, year: Number((f.name.trim().match(/^(\d{4}) board manual$/i) || [])[1] || 0) })).filter((f) => f.year)
    .sort((a, b) => b.year - a.year || String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
  const manual = manuals[0] || null;
  const out = new Map();
  if (manual) {
    const { kept } = oneOfEach((await children(token, manual.id, fetchImpl)).filter((f) => f.mimeType !== FOLDER && !NOT_FINAL.test(f.name)));
    for (const f of kept) {
      const slot = docSlot(f.name);
      const paper = paperOf(f.name);
      if (!out.has(slot)) out.set(slot, { slot, title: paper ? paper.title : docTitle(f.name), kind: paper ? 'governance' : docKind(f.name), year: paper ? null : manual.year, file: f });
    }
  }
  const missing = PAPERS.filter((p) => !out.has(p.slot));
  if (missing.length) {
    const terms = [...new Set(missing.flatMap((p) => p.terms))].map((t) => `name contains '${t.replace(/'/g, "\\'")}'`).join(' or ');
    const found = (await listFiles(token, `(${terms}) and mimeType != '${FOLDER}' and trashed = false`, fetchImpl, where)).filter((f) => !NOT_FINAL.test(f.name) && !driveSkip(f));
    // The cleanest copy: no "(2)", no "3-" from a grant's attachments, a PDF
    const rank = (f) => (/\(\d+\)/.test(f.name) ? 2 : 0) + (/^\s*\d+\s*[-.]/.test(f.name) ? 2 : 0) + (/\.pdf$/i.test(f.name) || f.mimeType === 'application/pdf' ? 0 : 1);
    const at = (f) => String(f.modifiedTime || '');
    // Newest: the latest year its name or its last change gives, a dated name over an undated one, then the cleanest
    const when = (f) => Math.max(nameYear(f.name), Number(at(f).slice(0, 4)) || 0);
    const newest = (a, b) => when(b) - when(a) || Number(!!nameYear(b.name)) - Number(!!nameYear(a.name)) || rank(a) - rank(b) || at(b).localeCompare(at(a));
    // The one filed: the cleanest, then the oldest
    const filed = (a, b) => rank(a) - rank(b) || String(a.createdTime || a.modifiedTime || '').localeCompare(String(b.createdTime || b.modifiedTime || '')) || a.name.localeCompare(b.name);
    for (const p of missing) {
      const best = found.filter((f) => paperOf(f.name) === p).sort(p.newest ? newest : filed)[0];
      if (best) out.set(p.slot, { slot: p.slot, title: p.title, kind: 'governance', year: null, file: best });
    }
  }
  return { manual: manual?.name || '', list: [...out.values()] };
}

/** One paper onto its Documents entry (made the first time; a newer copy replaces the file) → 1 when a file came in */
async function bringPaper(env, { token, paper, fetchImpl, now }) {
  const { slot, title, kind, year, file } = paper;
  const row = await env.DB.prepare('SELECT * FROM board_drive_docs WHERE slot = ?').bind(slot).first();
  if (row && row.drive_id === file.id && row.modified === (file.modifiedTime || '')) return 0;
  const doc = row?.doc_id ? await env.DB.prepare('SELECT data FROM board_docs WHERE id = ?').bind(row.doc_id).first() : null;
  // Taken out in Board: it stays out
  if (row?.doc_id && !doc) return 0;
  const got = await fetchFile(env, token, file, fetchImpl, { wantText: false });
  if (!got) return 0;
  let docId = row?.doc_id;
  if (doc) {
    // A newer year's copy: the document is that year's now (its title, sharing and signing are Board's)
    const cur = cleanDoc(JSON.parse(doc.data));
    if (year && cur.year !== year) await saveDoc(env.DB, { ...cur, year });
  } else {
    docId = (await saveDoc(env.DB, { title, kind, year, shared: true })).id;
  }
  const put = await putFile(env, { ownerType: 'doc', ownerId: docId, file: new File([got.bytes], got.name, { type: got.type }), by: DRIVE_BY });
  if (row?.board_file_id) await deleteFile(env, row.board_file_id).catch(() => {});
  await env.DB.prepare('INSERT OR REPLACE INTO board_drive_docs (slot, doc_id, drive_id, board_file_id, modified, name, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(slot, docId, file.id, put.id, file.modifiedTime || '', got.name, new Date(now).toISOString()).run();
  return 1;
}

/** The papers onto Documents → { checkedAt, manual (the folder read), count (documents from Drive), brought, missing: [titles not found] } */
async function readPapers(env, { token, root, fetchImpl, now }) {
  const { manual, list } = await papers(token, root, fetchImpl);
  let brought = 0;
  for (const paper of list) brought += await bringPaper(env, { token, paper, fetchImpl, now });
  const ids = ((await env.DB.prepare("SELECT d.id FROM board_drive_docs x JOIN board_docs d ON d.id = x.doc_id").all()).results || []).length;
  return { checkedAt: new Date(now).toISOString(), manual, count: ids, brought, missing: PAPERS.filter((p) => !list.some((x) => x.slot === p.slot)).map((p) => p.title) };
}

// ─── A look ─────────────────────────────────────────────────────────

/** Totals over what's been brought in, for the admin */
async function totals(DB) {
  const r = await DB.prepare("SELECT count(DISTINCT meeting_id) AS meetings, sum(CASE WHEN board_file_id != '' THEN 1 ELSE 0 END) AS files FROM board_drive").first();
  return { meetings: r?.meetings || 0, files: r?.files || 0 };
}

/**
 * Read the Drive folder for about eight seconds, newest meetings first →
 * the saved state: { version, ok, needsScope, apiOff, checkedAt, root,
 * folders (meeting folders found), meetings (meetings brought in or filled),
 * files, backlog (meeting folders still to read), read (this look), errors }
 */
export async function readBoardDrive(env, { fetchImpl = fetch, now = Date.now(), budgetMs = BUDGET_MS } = {}) {
  await ensureDrive(env.DB);
  const last = await readState(env.DB, KEY);
  if (!env.GOOGLE_CALENDAR_KEY) return writeState(env.DB, KEY, { ...last, version: VERSION, ok: false, configured: false, checkedAt: new Date(now).toISOString() });
  const lock = await env.DB.prepare(`INSERT INTO board_state (key, data, updated_at) VALUES ('drive-lock', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE CAST(json_extract(board_state.data, '$.until') AS INTEGER) < ?`)
    .bind(JSON.stringify({ until: now + 2 * 60 * 1000 }), new Date(now).toISOString(), now).run();
  if (!((lock?.meta?.changes ?? 0) > 0)) return last;
  const started = Date.now();
  try {
    const root = folderIdOf((await readSettings(env.DB))?.driveFolder) || DEFAULT_DRIVE_FOLDER;
    const errors = [];
    let needsScope = false;
    let apiOff = false;
    let token = '';
    let admin = '';
    // As the first admin who can see the folder
    for (const a of await boardAdmins(env.DB)) {
      let t;
      try { t = await accessToken(env, a, { fetchImpl, now, scope: DRIVE_SCOPE }); } catch (err) {
        if (/unauthorized_client|access_denied|not authorized/i.test(err.message)) needsScope = true;
        else errors.push(`${a.split('@')[0]}: ${String(err.message).slice(0, 200)}`);
        continue;
      }
      try {
        await drive(t, `/files/${encodeURIComponent(root)}?fields=id,name&${ALL.split('&')[0]}`, fetchImpl);
        token = t; admin = a;
        break;
      } catch (err) {
        if (err.status === 403 && /has not been used|is disabled|accessNotConfigured/i.test(err.message)) { apiOff = true; break; }
        errors.push(`${a.split('@')[0]} can’t open the Drive folder: ${String(err.message).slice(0, 160)}`);
      }
    }
    const base = { version: VERSION, reader: AGENDA_READER, configured: true, root, checkedAt: new Date(now).toISOString(), read: 0 };
    if (!token) {
      return await writeState(env.DB, KEY, { ...base, ok: false, needsScope: needsScope && !apiOff, apiOff, folders: last.folders || 0, backlog: 0, ...(await totals(env.DB)), errors: errors.slice(0, 10) });
    }
    // The meeting folders: walked again hourly (and after an upgrade), else the list from the last walk
    const done = await readState(env.DB, DONE);
    const fresh = done.version === VERSION && done.root === root && done.walkedAt && now - Date.parse(done.walkedAt) < HOUR;
    const folders = fresh ? done.folders : await meetingFolders(token, root, fetchImpl);
    // (an upgrade walks again for meetings it missed, but doesn't read again the folders it read; the one to 3 does, for the pictures and big files)
    const seen = done.root === root && done.version >= 3 ? { ...(done.seen || {}) } : {};
    const today = todayEastern(now);
    const past = folders.filter((f) => f.date < today);
    // First the folders never read; then the read ones again for files added since: hourly for the last year's
    // meetings (minutes come in after the meeting), weekly for older ones
    const todo = past.filter((f) => !seen[f.id]);
    // (and, once, those whose meeting's agenda an older reader filled: board-shared.js readAgain)
    const stale = await staleFolders(env.DB);
    const every = (f) => (now - Date.parse(`${f.date}T12:00:00Z`) < RECENT_MS ? HOUR : WEEK);
    const again = past.filter((f) => seen[f.id] && (stale.has(f.id) || now - Date.parse(seen[f.id]) >= every(f)));
    const people = (await peopleRows(env.DB)).filter((p) => p.group === 'board').map((p) => ({ slug: p.slug, name: p.name, org: p.organization || '', kind: 'board' }))
      .concat((await roster(env.DB)).staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })));
    let read = 0;
    let filesNow = 0;
    for (const folder of [...todo, ...again]) {
      if (read > 0 && Date.now() - started > budgetMs) break; // at least one each look, so a backlog always moves
      try {
        const r = await bringFolder(env, { token, folder, fetchImpl, people, now });
        filesNow += r.files;
        seen[folder.id] = new Date(now).toISOString();
        read += 1;
      } catch (err) {
        errors.push(`${folder.name}: ${String(err.message).slice(0, 200)}`);
        if (err.status === 429 || err.status >= 500) break; // Drive is busy: the next look carries on
      }
    }
    await writeState(env.DB, DONE, { version: VERSION, root, admin, walkedAt: fresh ? done.walkedAt : new Date(now).toISOString(), folders, seen });
    const backlog = past.filter((f) => !seen[f.id]).length;
    // Documents' papers: hourly, once the meetings are read (and after an upgrade)
    let docs = last.docs || null;
    if (!backlog && (last.version !== VERSION || !docs?.checkedAt || now - Date.parse(docs.checkedAt) >= HOUR)) {
      try { docs = await readPapers(env, { token, root, fetchImpl, now }); } catch (err) { errors.push(`Documents: ${String(err.message).slice(0, 200)}`); }
    }
    const staleLeft = [...(await staleFolders(env.DB))].filter((id) => past.some((f) => f.id === id)).length;
    return await writeState(env.DB, KEY, {
      ...base, ok: !errors.length, needsScope: false, apiOff: false, folders: folders.length, read, brought: filesNow, backlog, stale: staleLeft, docs,
      ...(await totals(env.DB)), errors: errors.slice(0, 10),
    });
  } finally {
    await env.DB.prepare("DELETE FROM board_state WHERE key = 'drive-lock'").run().catch(() => {});
  }
}

export const driveStatus = (DB) => readState(DB, KEY);

/** The folders whose meeting has an agenda an older reader filled from Drive, nobody's changed since (each read again once) */
async function staleFolders(DB) {
  const ids = new Set((await listMeetings(DB)).filter((m) => m.agendaFrom?.kind === 'drive' && readAgain(m)).map((m) => m.id));
  if (!ids.size) return new Set();
  const rows = (await DB.prepare('SELECT DISTINCT folder_id, meeting_id FROM board_drive').all()).results || [];
  return new Set(rows.filter((r) => ids.has(r.meeting_id)).map((r) => r.folder_id));
}

/**
 * On the heartbeat: every minute while meeting folders are still to read,
 * hourly after (sooner: minAgeMs), at once after an upgrade. → { busy: it
 * read a meeting folder this look (the heartbeat leaves board mail for the
 * next minute) }. Never throws.
 */
export async function maybeReadBoardDrive(env, { fetchImpl = fetch, now = Date.now(), minAgeMs = HOUR } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return { busy: false };
    await ensureDrive(env.DB);
    const st = await readState(env.DB, KEY);
    // (and every minute while agendas an older reader filled are still to read again)
    const due = st.version !== VERSION || st.backlog > 0 || st.stale > 0 || st.reader !== AGENDA_READER || !st.checkedAt || now - Date.parse(st.checkedAt) >= minAgeMs;
    if (!due) return { busy: false };
    const r = await readBoardDrive(env, { fetchImpl, now });
    return { busy: (r?.read || 0) > 0 && ((r?.brought || 0) > 0 || (r?.backlog || 0) > 0 || (r?.stale || 0) > 0) };
  } catch (err) {
    console.error('[board-drive]', err.message);
    return { busy: false };
  }
}
