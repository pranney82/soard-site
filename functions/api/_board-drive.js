/**
 * Board's past meetings from Google Drive
 * ===========================================================================
 * SOARD keeps each board meeting's minutes (and, lately, its whole packet)
 * in Google Drive: the "Board" folder (Settings → the Drive folder; SOARD's
 * Leadership folder until saved), a "2025 Board" folder for each year, and in
 * it a folder for each meeting named by its date ("7.24.25 Meeting",
 * "8.6.26 Board Meeting"). Every hour, and every minute while there's a
 * backlog, Board reads them:
 *   - each meeting folder is one meeting on its date: the meeting already in
 *     Board within three days (the calendar may have it), else a past record
 *   - its files go on that meeting for the board (Google Docs, Sheets and
 *     Slides as PDFs): minutes, the agenda, financial statements, the rest as
 *     packet files. Pictures, Pages files, resumes, anything over 15 MB and
 *     the loose files beside the meeting folders (expectations, nominees,
 *     birthdays) are left alone
 *   - the minutes fill in who was there (when nobody marked it), the
 *     meeting's sections and notes (when its agenda is still a draft), and
 *     mark the minutes approved once a later meeting exists
 *   - a past meeting nobody here worked on goes on the board page
 *   - a file is brought in once; one changed in Drive replaces its copy
 * Meetings ahead are left alone: their agendas are written in Board.
 * It never writes, moves, shares or deletes anything in Drive.
 *
 * Reads as one of Board's admins through the site's service account (domain-
 * wide delegation, drive.readonly), which Google Admin must allow next to the
 * calendar scope (Board → Meetings says how until it does).
 */

import { accessToken } from './_google-calendar.js';
import { boardAdmins, peopleRows, readSettings, readState, writeState } from './_board-roles.js';
import { ensureSchema, listMeetings, getMeeting, saveMeeting, patchMeeting, putFile, deleteFile, roster } from './_board.js';
import { fileText, attendanceIn } from './_board-mail.js';
import { parseAgendaText, cleanMeeting, agendaIsDraft, todayEastern, isDate } from '../../public/admin/board-shared.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** SOARD's "Board" folder in the Sunshine - Leadership shared drive */
export const DEFAULT_DRIVE_FOLDER = '18UkzUWI1x_NZiGKt5CAeWYINCaRYVGgZ';
export const DRIVE_BY = 'Google Drive';
const KEY = 'drive';
const DONE = 'drive-done';
const VERSION = 1;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BUDGET_MS = 8000;
const MAX_BYTES = 15 * 1024 * 1024;
const ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
const FOLDER = 'application/vnd.google-apps.folder';
// Google's own files, as PDFs (a Doc's text is read too)
const GOOGLE = {
  'application/vnd.google-apps.document': 'Doc',
  'application/vnd.google-apps.spreadsheet': 'Sheet',
  'application/vnd.google-apps.presentation': 'Slides',
};
const DOC = 'application/vnd.google-apps.document';
// A meeting folder checked again each hour while it's this recent (older minutes don't change)
const RECENT_MS = 400 * DAY;
// Never the meetings' own: the year folders' loose files never come through here, these are what a meeting folder can hold that isn't
const RESUME = /\b(resume|résumé|curriculum vitae|cv)\b/i;
const IMAGE = /\.(jpe?g|png|gif|heic|heif|webp|tiff?|bmp|svg)$/i;
const APPLE = /\.(pages|numbers|key)$/i;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS board_drive (drive_id TEXT PRIMARY KEY, meeting_id TEXT, board_file_id TEXT, modified TEXT, name TEXT, folder_id TEXT, at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_board_drive_meeting ON board_drive(meeting_id)',
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

/** What a file is, by its name: minutes, agenda, financials, or a packet file */
export function driveKind(name) {
  const n = String(name || '');
  if (/minutes|\bnotes\b/i.test(n)) return 'minutes';
  if (/agenda/i.test(n)) return 'agenda';
  if (/statement of|financial|budget|balance sheet|profit|p\s*&\s*l\b|\bp&l\b|income/i.test(n)) return 'financials';
  return 'packet';
}

/** Why a file in a meeting folder isn't brought in (in words), or '' */
export function driveSkip(f) {
  const name = String(f.name || '');
  if (f.mimeType === FOLDER) return 'a folder';
  if (/^image\//.test(f.mimeType || '') || IMAGE.test(name)) return 'a picture';
  if (/^(video|audio)\//.test(f.mimeType || '')) return 'a video or recording';
  if (APPLE.test(name) || /iwork|apple\.(pages|numbers|keynote)/i.test(f.mimeType || '')) return 'an Apple Pages, Numbers or Keynote file';
  if (RESUME.test(name)) return 'a resume';
  if (/^application\/vnd\.google-apps\./.test(f.mimeType || '') && !GOOGLE[f.mimeType]) return 'a Google file that can’t be a document';
  if (!GOOGLE[f.mimeType] && Number(f.size) > MAX_BYTES) return 'over 15 MB';
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

/** Everything in a folder (not in the trash), every page */
async function children(token, id, fetchImpl) {
  const out = [];
  let page = '';
  do {
    const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
    const r = await drive(token, `/files?q=${q}&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,size)')}&pageSize=1000&${ALL}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, fetchImpl);
    out.push(...(r.files || []));
    page = r.nextPageToken || '';
  } while (page && out.length < 5000);
  return out;
}

/** The meeting folders: under each "2025 Board" folder, and any sitting right in the root. → [{ id, name, date }], newest first */
async function meetingFolders(token, root, fetchImpl) {
  const top = await children(token, root, fetchImpl);
  const found = [];
  for (const f of top.filter((x) => x.mimeType === FOLDER)) {
    const y = f.name.trim().match(/^(\d{4}) Board$/);
    if (y) {
      for (const c of (await children(token, f.id, fetchImpl)).filter((x) => x.mimeType === FOLDER)) {
        const date = folderDate(c.name, Number(y[1]));
        if (date) found.push({ id: c.id, name: c.name, date });
      }
    } else {
      const date = folderDate(f.name);
      if (date) found.push({ id: f.id, name: f.name, date });
    }
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
    const text = wantText && f.mimeType === DOC ? await drive(token, `/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent('text/plain')}`, fetchImpl, { text: true }).catch(() => '') : '';
    const name = /\.pdf$/i.test(f.name) ? f.name : `${f.name}.pdf`;
    return { name, bytes, type: 'application/pdf', text: text || (wantText ? await fileText(env, { name, bytes }) : '') };
  }
  const bytes = await drive(token, `/files/${encodeURIComponent(f.id)}?alt=media&${ALL.split('&')[0]}`, fetchImpl, { bytes: true });
  if (bytes.byteLength > MAX_BYTES) return null;
  return { name: f.name, bytes, type: f.mimeType || 'application/octet-stream', text: wantText ? await fileText(env, { name: f.name, bytes }) : '' };
}

// ─── One meeting folder ─────────────────────────────────────────────

const untouched = (m) => ['the calendar', 'board email', DRIVE_BY, ''].includes(m.updatedBy || '');
const ORDER = { minutes: 0, agenda: 1, financials: 2, packet: 3 };

/**
 * A meeting folder onto its meeting. → { meetingId, made, files (brought in or
 * replaced), skipped: [names with why] }
 */
async function bringFolder(env, { token, folder, fetchImpl, people, now }) {
  const today = todayEastern(now);
  let meetings = await listMeetings(env.DB);
  const near = meetings.filter((m) => m.date && Math.abs(Date.parse(`${m.date}T12:00:00Z`) - Date.parse(`${folder.date}T12:00:00Z`)) <= 3 * DAY)
    .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(folder.date)) - Math.abs(Date.parse(b.date) - Date.parse(folder.date)));
  let m = near[0] || null;
  const files = await folderFiles(token, folder.id, fetchImpl);
  const skipped = [];
  const wanted = [];
  for (const f of files) {
    const why = driveSkip(f);
    if (why) { skipped.push(`${f.name} (${why})`); continue; }
    wanted.push({ ...f, kind: driveKind(f.name) });
  }
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
    if (row && row.modified === (f.modifiedTime || '') && row.meeting_id === m.id) continue;
    const got = await fetchFile(env, token, f, fetchImpl, { wantText: f.kind === 'minutes' || f.kind === 'agenda' });
    if (!got) { skipped.push(`${f.name} (over 15 MB)`); continue; }
    const current = await getMeeting(env.DB, m.id);
    // Changed in Drive: the old copy goes. The same file already here (board email brought it): kept, not doubled
    if (row?.board_file_id) await deleteFile(env, row.board_file_id);
    const same = current.files.find((x) => x.name === got.name && x.size === got.bytes.byteLength && x.id !== row?.board_file_id);
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
    // What the minutes (or the agenda) say: who was there, the sections and notes, approved once a later meeting exists
    if ((f.kind === 'minutes' || f.kind === 'agenda') && got.text) {
      const parsed = parseAgendaText(got.text, people);
      const who = f.kind === 'minutes' ? (parsed.attendance.length ? parsed.attendance : attendanceIn(got.text, people)) : [];
      const enough = parsed.sections.filter((s) => s.items.length).length >= 2;
      const later = meetings.filter((x) => x.date > folder.date).sort((a, b) => a.date.localeCompare(b.date))[0];
      await patchMeeting(env.DB, m.id, (cur) => {
        const next = { ...cur };
        if (who.length && !cur.attendance.some((p) => p.status)) next.attendance = who;
        if (enough && agendaIsDraft(cur)) Object.assign(next, { sections: parsed.sections, agendaFrom: { kind: 'drive', name: got.name, at: new Date(now).toISOString() } });
        if (f.kind === 'minutes' && later && untouched(cur) && cur.minutes !== 'approved') Object.assign(next, { minutes: 'approved', approvedOn: later.date <= today ? later.date : today });
        return next;
      });
    }
  }
  // The board's own packet and minutes: a past meeting nobody here worked on goes on the board page
  if (brought || made) await patchMeeting(env.DB, m.id, (cur) => (untouched(cur) && cur.date < today && !cur.shared ? { ...cur, shared: true } : cur));
  return { meetingId: m.id, made, files: brought, skipped };
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
    const base = { version: VERSION, configured: true, root, checkedAt: new Date(now).toISOString(), read: 0 };
    if (!token) {
      return await writeState(env.DB, KEY, { ...base, ok: false, needsScope: needsScope && !apiOff, apiOff, folders: last.folders || 0, backlog: 0, ...(await totals(env.DB)), errors: errors.slice(0, 10) });
    }
    // The meeting folders: walked again hourly (and after an upgrade), else the list from the last walk
    const done = await readState(env.DB, DONE);
    const fresh = done.version === VERSION && done.root === root && done.walkedAt && now - Date.parse(done.walkedAt) < HOUR;
    const folders = fresh ? done.folders : await meetingFolders(token, root, fetchImpl);
    const seen = done.version === VERSION && done.root === root ? { ...(done.seen || {}) } : {};
    const today = todayEastern(now);
    const past = folders.filter((f) => f.date < today);
    // First the folders never read; then, hourly, the recent ones again (minutes come in after the meeting)
    const todo = past.filter((f) => !seen[f.id]);
    const again = past.filter((f) => seen[f.id] && now - Date.parse(`${f.date}T12:00:00Z`) < RECENT_MS && now - Date.parse(seen[f.id]) >= HOUR);
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
    return await writeState(env.DB, KEY, {
      ...base, ok: !errors.length, needsScope: false, apiOff: false, folders: folders.length, read, brought: filesNow, backlog,
      ...(await totals(env.DB)), errors: errors.slice(0, 10),
    });
  } finally {
    await env.DB.prepare("DELETE FROM board_state WHERE key = 'drive-lock'").run().catch(() => {});
  }
}

export const driveStatus = (DB) => readState(DB, KEY);

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
    const due = st.version !== VERSION || st.backlog > 0 || !st.checkedAt || now - Date.parse(st.checkedAt) >= minAgeMs;
    if (!due) return { busy: false };
    const r = await readBoardDrive(env, { fetchImpl, now });
    return { busy: (r?.read || 0) > 0 && ((r?.brought || 0) > 0 || (r?.backlog || 0) > 0) };
  } catch (err) {
    console.error('[board-drive]', err.message);
    return { busy: false };
  }
}
