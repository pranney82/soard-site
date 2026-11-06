/**
 * What board members do on the board page, for Board → Members
 * =============================================================
 * Who has signed in and when, when each was last on the page and on what, and
 * what they looked at: the page they were on and the files they read, each for
 * the time they were actually there (the page in front, someone at it), plus
 * the page's own answers as they happen (will you be there, signing a paper,
 * a report, a check-in, a vote, a document put with an item).
 *
 * Board members only, from their own sign-ins: an admin looking at the board
 * page is never recorded, nor is a preview or the screen an admin presents.
 *
 *   board_signins   one row per Cloudflare Access sign-in: the token's iat (when they typed the code), the device
 *   board_activity  one row per thing they did: kind, ref (a page, file, meeting or document), sub (which item,
 *                   which answer), secs (time there), at → until, the device; look (the tracker's id for a look),
 *                   added (when the row was written)
 *
 * Written from /api/board-portal (GET: the sign-in, and once the page answered, the calendar file and following a
 * meeting while it's held; POST: the answers, and { action: 'activity' } from ../../public/admin/board/activity.js);
 * read by /api/board-admin. Kept two years.
 */

import { ID, ensureSchema, getMeeting, cleanDoc, onBoardPage } from './_board.js';
import { todayEastern, isNothingNew } from '../../public/admin/board-shared.js';
import { limit } from './_rate-limit.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS board_signins (slug TEXT NOT NULL, iat INTEGER NOT NULL, at TEXT NOT NULL, device TEXT, added TEXT, PRIMARY KEY (slug, iat))',
  'CREATE TABLE IF NOT EXISTS board_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT, sub TEXT, secs INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, until TEXT NOT NULL, device TEXT, look TEXT, added TEXT)',
  'CREATE INDEX IF NOT EXISTS board_activity_slug_at ON board_activity (slug, at)',
  // One row a look, however many reports of it come at once
  'CREATE UNIQUE INDEX IF NOT EXISTS board_activity_look ON board_activity (slug, look)',
  'CREATE INDEX IF NOT EXISTS board_activity_slug_added ON board_activity (slug, added)',
  // A member's last row of one thing (a live meeting followed every few seconds), and Members' sums by kind
  'CREATE INDEX IF NOT EXISTS board_activity_thing ON board_activity (slug, kind, ref, sub, id)',
  'CREATE INDEX IF NOT EXISTS board_activity_kind ON board_activity (kind, slug, ref)',
  // When each was last on (Members), and the rows two years old to let go
  'CREATE INDEX IF NOT EXISTS board_activity_slug_until ON board_activity (slug, until)',
  'CREATE INDEX IF NOT EXISTS board_activity_at ON board_activity (at)',
  // When each member's tracker last reported (and the report before): the time its next report can claim
  'CREATE TABLE IF NOT EXISTS board_activity_reports (slug TEXT PRIMARY KEY, at TEXT NOT NULL, prev TEXT)',
];
const ready = new WeakSet();
export async function ensureActivitySchema(DB) {
  if (ready.has(DB)) return;
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  ready.add(DB);
}

const KEEP_MS = 2 * 365 * 86_400_000;
const MAX_SECS = 4 * 3600;
// One sitting: activity with no gap longer than this
export const VISIT_GAP_MS = 30 * 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** The pages of the board page as the tracker names them (#/meetings/<id> → meeting/<id>) */
const PAGES = ['home', 'meetings', 'financials', 'gifts', 'people', 'documents', 'introductions', 'fundraise'];
const idOk = (x) => typeof x === 'string' && ID.test(x);
const str = (x) => (typeof x === 'string' ? x : '');
const parse = (x) => { try { return JSON.parse(x || '{}'); } catch { return {}; } };
// A query's ?s for a list (each report names at most 60 things: within D1's 100)
const marks = (list) => list.map(() => '?').join(', ');
export function pageOk(ref) {
  const parts = str(ref).split('/');
  const [page, id, item] = parts;
  if (PAGES.includes(page)) return parts.length === 1;
  // A meeting's page, its screen, the chair's review of its agenda; a paper written in Board, on its own page
  if (['meeting', 'screen', 'review', 'paper'].includes(page)) return parts.length === 2 && idOk(id);
  if (page === 'report') return parts.length === 3 && idOk(id) && idOk(item);
  return false;
}

/**
 * A device as a person says it: "iPhone · Safari", "Windows · Edge". `touch`: the page's own word that the
 * screen is touch (an iPad asks for the Mac site, so its browser says Mac)
 */
export function deviceOf(ua = '', { touch = false } = {}) {
  const u = String(ua);
  let os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? (/Mobile/.test(u) ? 'Android phone' : 'Android tablet')
    : /Windows/.test(u) ? 'Windows' : /CrOS/.test(u) ? 'Chromebook' : /Macintosh|Mac OS X/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : '';
  if (os === 'Mac' && touch) os = 'iPad';
  const app = /\bGSA\//.test(u) ? 'the Google app' : /FBAN|FBAV|FB_IAB/.test(u) ? 'Facebook' : /Instagram/.test(u) ? 'Instagram' : /LinkedInApp/.test(u) ? 'LinkedIn'
    : /Edg(A|iOS)?\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Firefox|FxiOS/.test(u) ? 'Firefox'
      : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
  return [os, app].filter(Boolean).join(' · ') || 'A browser';
}

/** When this sign-in happened: its Access token's iat (the middleware has checked the token already) */
export function accessIat(request) {
  const tok = request.headers.get('Cf-Access-Jwt-Assertion') || (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1] || '';
  try {
    const part = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const iat = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4))).iat;
    return Number.isInteger(iat) && iat > 1_600_000_000 ? iat : null;
  } catch {
    return null;
  }
}

/** This request's device, an iPad once the page has said so for this sign-in (its browser asks for the Mac site) */
async function deviceFor(DB, member, request) {
  const d = deviceOf(request.headers.get('User-Agent'));
  const iat = /^Mac/.test(d) ? accessIat(request) : null;
  if (!iat) return d;
  const row = await DB.prepare('SELECT device FROM board_signins WHERE slug = ? AND iat = ?').bind(member.slug, iat).first();
  return /^iPad/.test(row?.device || '') ? row.device : d;
}

async function signedIn(DB, member, request, now) {
  const iat = accessIat(request);
  if (!iat || iat * 1000 > now + 300_000) return;
  await DB.prepare('INSERT OR IGNORE INTO board_signins (slug, iat, at, device, added) VALUES (?, ?, ?, ?, ?)')
    .bind(member.slug, iat, iso(iat * 1000), deviceOf(request.headers.get('User-Agent')), iso(now)).run();
}

/**
 * Rows in, each { kind, ref, sub, secs, at (ms) }: a look at the same page or file as the member's last row, soon
 * after it, adds its time to that row instead
 */
// Looks the board page's tracker reports: each by its id, with when it began and ended and its time so far
const LOOKS = ['view', 'file'];
const LOOK_ID = /^[a-z0-9]{6,24}$/;
// What a print was when it wasn't one file: Print it all, the minutes form, a meeting's page, a paper written in Board
const PRINTS = ['all', 'form', 'page', 'paper'];
const sameThing = (a, b) => a.kind === b.kind && (a.ref || '') === (b.ref || '') && (a.sub || '') === (b.sub || '');
const lastRow = (DB, slug, kind, ref, sub = '') => DB.prepare('SELECT id, until FROM board_activity WHERE slug = ? AND kind = ? AND ref = ? AND sub = ? ORDER BY id DESC LIMIT 1').bind(slug, kind, ref || '', sub || '').first();
// A new row, only while there's room for it: the count is read as the row is written (one statement), so reports
// sent at once can't each find room and go past the caps together
const insert = (DB, slug, r, until, device, now = Date.now()) => DB.prepare(`INSERT OR IGNORE INTO board_activity (slug, kind, ref, sub, secs, at, until, device, look, added)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM board_activity WHERE slug = ? AND added >= ?) < ? AND (SELECT COUNT(*) FROM board_activity WHERE slug = ? AND added >= ?) < ?`)
  .bind(slug, r.kind, r.ref || '', r.sub || '', r.secs, iso(r.at), until, device, r.look || null, iso(now), slug, iso(now - 60_000), ROWS_A_MINUTE, slug, iso(now - 86_400_000), ROWS_A_DAY).run();
// New rows a member can write in a minute, and in a day (a page open all day makes a few an hour; a long sitting, a
// few dozen)
const ROWS_A_MINUTE = 60;
const ROWS_A_DAY = 1500;
/** How many more rows they can write now, in one read */
async function roomFor(DB, slug, now = Date.now()) {
  const c = await DB.prepare('SELECT COUNT(*) AS day, SUM(CASE WHEN added >= ? THEN 1 ELSE 0 END) AS minute FROM board_activity WHERE slug = ? AND added >= ?')
    .bind(iso(now - 60_000), slug, iso(now - 86_400_000)).first();
  return Math.max(0, Math.min(ROWS_A_MINUTE - (Number(c?.minute) || 0), ROWS_A_DAY - (Number(c?.day) || 0)));
}

/**
 * Rows in, each { kind, ref, sub, secs, at, end (ms), look? }. A look keeps one row by its id: each report of it
 * carries its time so far and the row keeps the most it was told, so a report sent twice or out of order changes
 * nothing; it lasts until its last counted second. Anything else (a click, an answer) is a row of its own. At most
 * ROWS_A_MINUTE new rows a minute and ROWS_A_DAY a day, by when they're written. `stored`: each look's row so far, by
 * its id (noteEvents read them)
 */
async function add(DB, slug, rows, device, now = Date.now(), stored = new Map()) {
  let room = await roomFor(DB, slug, now);
  for (const r of rows) {
    const until = iso(Math.min(now, Math.max(r.at, r.end ?? r.at)));
    const row = r.look ? stored.get(r.look) : null;
    if (row && !sameThing(row, r)) continue; // an id once used for something else
    if (row && LOOKS.includes(r.kind)) await DB.prepare('UPDATE board_activity SET secs = MIN(?, MAX(secs, ?)), until = MAX(until, ?), device = ? WHERE id = ?').bind(MAX_SECS, r.secs, until, device, row.id).run();
    else if (!row && room-- > 0) await insert(DB, slug, r, until, device, now);
  }
}

const eastern = (date, hm) => {
  const probe = new Date(`${date}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(probe).find((x) => x.type === 'timeZoneName')?.value || 'GMT-5';
  const [, sign, hh] = off.match(/GMT([+-])(\d{1,2})/) || [null, '-', '5'];
  return Date.parse(`${date}T${hm}:00Z`) + (sign === '-' ? 1 : -1) * Number(hh) * 3_600_000;
};
function meetingHours(m) {
  if (!m?.date) return null;
  const start = /^\d{2}:\d{2}$/.test(m.start || '') ? m.start : '07:00';
  const end = /^\d{2}:\d{2}$/.test(m.end || '') ? m.end : '23:00';
  return [eastern(m.date, start) - 30 * 60_000, eastern(m.date, end) + 60 * 60_000];
}

/** A member's GET of the board page: the sign-in it came with. Never throws */
export async function noteGet(env, member, request, { now = Date.now() } = {}) {
  if (!member?.slug || !env.DB) return;
  try {
    await ensureActivitySchema(env.DB);
    await signedIn(env.DB, member, request, now);
  } catch (err) {
    console.error('[board-activity] get', err.message);
  }
}

/**
 * What a GET the page answered was for: `calendar` (they took a meeting's calendar file) or `live` (they're
 * following a meeting while it's held: each look adds the time since the last, up to a minute, ending now). Never throws
 */
export async function noteLook(env, member, request, kind, ref, { now = Date.now() } = {}) {
  if (!member?.slug || !env.DB || !idOk(ref) || !['calendar', 'live'].includes(kind)) return;
  try {
    await ensureActivitySchema(env.DB);
    const device = await deviceFor(env.DB, member, request);
    if (kind === 'calendar') {
      const was = await lastRow(env.DB, member.slug, 'calendar', ref);
      const full = (await roomFor(env.DB, member.slug, now)) <= 0;
      if (!full && !(was && now - Date.parse(was.until) < 10 * 60_000)) await insert(env.DB, member.slug, { kind, ref, secs: 0, at: now }, iso(now), device, now);
      return;
    }
    // A page in the background still looks: its time counts only while the member is at it (their tracker has
    // reported a page or a file in the last two minutes), or while it's in view (a page in view looks every few
    // seconds: beside the video call, someone in the meeting on video follows it without touching it)
    const last = await lastRow(env.DB, member.slug, 'live', ref);
    const gap = last ? Math.round((now - Date.parse(last.until)) / 1000) : Infinity;
    if (gap > 10) {
      const used = (await env.DB.prepare('SELECT at AS u FROM board_activity_reports WHERE slug = ?').bind(member.slug).first())?.u;
      if (!used || now - Date.parse(used) > 120_000) return;
    }
    if (gap > 0 && gap <= 60) await env.DB.prepare('UPDATE board_activity SET secs = MIN(?, secs + ?), until = ?, device = ? WHERE id = ?').bind(MAX_SECS, gap, iso(now), device, last.id).run();
    // A slowed background tab looks now and then: the same following, its time only what came a minute at a time
    else if (gap > 60 && gap <= 30 * 60) await env.DB.prepare('UPDATE board_activity SET until = ?, device = ? WHERE id = ?').bind(iso(now), device, last.id).run();
    else if (gap > 60 && (await roomFor(env.DB, member.slug, now)) > 0) await insert(env.DB, member.slug, { kind, ref, secs: 0, at: now }, iso(now), device, now);
  } catch (err) {
    console.error('[board-activity] look', err.message);
  }
}

/**
 * A file a member's browser opened on its own, as a page (Sec-Fetch-Dest: document: a middle-click, Open in new tab, a
 * long-press), not the board page's viewer or a thumbnail: opened, once in a minute. Never throws
 */
export async function noteFileOpen(env, member, request, fileId, { now = Date.now() } = {}) {
  if (!member?.slug || !env.DB || !idOk(fileId) || request.headers.get('Sec-Fetch-Dest') !== 'document') return;
  try {
    await ensureActivitySchema(env.DB);
    const was = await env.DB.prepare("SELECT until FROM board_activity WHERE slug = ? AND kind = 'file' AND ref = ? ORDER BY id DESC LIMIT 1").bind(member.slug, fileId).first();
    if (was && now - Date.parse(was.until) < 60_000) return;
    await add(env.DB, member.slug, [{ kind: 'file', ref: fileId, sub: '', secs: 0, at: now, end: now, look: `nt${now.toString(36)}` }], await deviceFor(env.DB, member, request), now);
  } catch (err) {
    console.error('[board-activity] open', err.message);
  }
}

/** The board page's own answers, as an activity row, once one worked: the request's body (JSON) or query */
const ANSWERS = {
  'action-done': (b) => idOk(b.actionId) && { kind: 'action', ref: b.actionId, sub: b.done ? 'done' : 'open' },
  sign: (b) => idOk(b.docId) && { kind: 'sign', ref: b.docId },
  checkin: (b) => idOk(b.meetingId) && { kind: 'checkin', ref: b.meetingId, sub: ['present', 'remote'].includes(b.how) ? b.how : '' },
  // That they voted, never how: the motion's own tally says the rest
  vote: (b) => idOk(b.meetingId) && { kind: 'vote', ref: b.meetingId, sub: idOk(b.motionId) ? b.motionId : '' },
  // A report (or "nothing new" in its place) once it has words; a report emptied while typing is no answer yet
  report: (b) => idOk(b.meetingId) && idOk(b.itemId) && str(b.text).trim() && { kind: isNothingNew(b.text) ? 'nothing' : 'report', ref: b.meetingId, sub: b.itemId },
  motion: (b) => idOk(b.meetingId) && idOk(b.itemId) && { kind: str(b.text).trim() ? 'motion' : 'unmotion', ref: b.meetingId, sub: b.itemId },
  detach: (b) => idOk(b.meetingId) && { kind: 'detach', ref: b.meetingId, sub: idOk(b.itemId) ? b.itemId : '' },
  'line-note': (b) => idOk(b.meetingId) && { kind: str(b.text).trim() ? 'note' : 'unnote', ref: b.meetingId, sub: idOk(b.itemId) ? b.itemId : '' },
  'chair-note': (b) => idOk(b.meetingId) && { kind: str(b.text).trim() ? 'note' : 'unnote', ref: b.meetingId, sub: idOk(b.itemId) ? b.itemId : '' },
  'chair-approve': (b) => idOk(b.meetingId) && { kind: 'approve', ref: b.meetingId },
  // The minutes typed beside the agenda, sent (saving them as they're typed is no answer)
  'notes-send': (b) => idOk(b.meetingId) && { kind: 'minutes', ref: b.meetingId },
  'ask-presenter': (b) => idOk(b.meetingId) && { kind: 'ask', ref: b.meetingId, sub: idOk(b.itemId) ? b.itemId : '' },
};
export function answerOf(body, query) {
  // In the order board-portal.js reads them (the one it acted on is the one that happened)
  if (query?.has('minutes')) return idOk(query.get('minutes')) ? { kind: 'minutes', ref: query.get('minutes') } : null;
  if (query?.has('signed')) return idOk(query.get('signed')) ? { kind: 'sign', ref: query.get('signed'), sub: 'copy' } : null;
  if (query?.has('attach')) return idOk(query.get('attach')) ? { kind: 'attach', ref: query.get('attach'), sub: idOk(query.get('item')) ? query.get('item') : '' } : null;
  return (body && ANSWERS[body.action]?.(body)) || null;
}
export async function noteAnswer(env, member, request, row, { now = Date.now() } = {}) {
  if (!member?.slug || !row || !env.DB) return;
  try {
    await ensureActivitySchema(env.DB);
    const device = await deviceFor(env.DB, member, request);
    // One row for what's one answer: a report or a note saved as it's typed (30 minutes), a vote (its motion, whatever
    // it was changed to: the tally keeps no changes), an action item ticked and unticked (a minute)
    const mins = { report: 30, nothing: 30, note: 30, unnote: 30, motion: 30, unmotion: 30, vote: Infinity, action: 1 }[row.kind];
    const was = mins ? (row.kind === 'action'
      ? await env.DB.prepare("SELECT id, until FROM board_activity WHERE slug = ? AND kind = 'action' AND ref = ? ORDER BY id DESC LIMIT 1").bind(member.slug, row.ref).first()
      : await lastRow(env.DB, member.slug, row.kind, row.ref, row.sub)) : null;
    if (was && now - Date.parse(was.until) < mins * 60_000) { await env.DB.prepare('UPDATE board_activity SET until = ?, sub = ?, device = ? WHERE id = ?').bind(iso(now), row.sub || '', device, was.id).run(); return; }
    const full = (await roomFor(env.DB, member.slug, now)) <= 0;
    if (!full) await insert(env.DB, member.slug, { ...row, secs: 0, at: now }, iso(now), device, now);
  } catch (err) {
    console.error('[board-activity] answer', err.message);
  }
}

/**
 * The tracker's report (../../public/admin/board/activity.js): { events: [{ id, kind: view|file|video|print, ref, sub?,
 * at, end (ms), secs }], touch, now (its clock) }. Only what it could have seen: a page of the board page, a file
 * it may open, a meeting by its id; at most a day back, 60 at a time. A phone's clock that's off is set right by
 * its `now`. A look's time (its total so far) is never more than its own span, nor past when the next one began
 * (one thing is in front at a time), and a report adds no more time than has passed since the last one (two tabs,
 * a report sent again)
 */
export async function noteEvents(env, member, request, body, { now = Date.now() } = {}) {
  if (!member?.slug) return { kept: 0 };
  await ensureActivitySchema(env.DB);
  if (!(await limit(env.DB, `board-activity:${member.slug}`, 120, 600, { now })).ok) return { kept: 0, later: true };
  const device = deviceOf(request.headers.get('User-Agent'), { touch: body?.touch === true });
  const theirs = Number(body?.now);
  const skew = Number.isFinite(theirs) && Math.abs(now - theirs) > 2000 ? now - theirs : 0;
  const rows = (Array.isArray(body?.events) ? body.events : []).slice(0, 60).map((e) => {
    const at0 = Number(e?.at) + skew;
    if (!Number.isFinite(at0) || at0 < now - 86_400_000 || at0 > now + 60_000) return null;
    const at = Math.min(now, at0);
    const end = Math.min(now, Math.max(at, Number.isFinite(Number(e?.end)) ? Number(e.end) + skew : at));
    const secs = Math.max(0, Math.min(MAX_SECS, Math.round(Number(e?.secs) || 0), Math.round((end - at) / 1000) + 1));
    const touched = Math.max(0, Math.min(secs, Math.round(Number(e?.touched) || 0)));
    const ref = str(e?.ref).slice(0, 120); // (no page or id is longer: pageOk and idOk say what one is)
    const sub = idOk(e?.sub) ? e.sub : '';
    const look = LOOK_ID.test(str(e?.id)) ? e.id : null;
    if (e?.kind === 'view') return pageOk(ref) && look ? { kind: 'view', ref, sub: '', secs, touched, at, end, look } : null;
    if (e?.kind === 'file') return idOk(ref) && look ? { kind: 'file', ref, sub, secs, at, end, look } : null;
    if (e?.kind === 'video') return !ref || idOk(ref) ? { kind: 'video', ref, sub, secs: 0, at, end: at, look } : null;
    if (e?.kind === 'print') return !ref || idOk(ref) ? { kind: 'print', ref, sub: PRINTS.includes(e?.sub) ? e.sub : sub, secs: 0, at, end: at, look } : null;
    return null;
  }).filter(Boolean).sort((a, b) => a.at - b.at);
  const byLook = new Map();
  const one = [];
  for (const r of rows) {
    const had = r.look && byLook.get(r.look);
    if (had) { had.secs = Math.max(had.secs, r.secs); had.touched = Math.max(had.touched || 0, r.touched || 0); had.end = Math.max(had.end, r.end); continue; }
    if (r.look) byLook.set(r.look, r);
    one.push(r);
  }
  // Each look's row so far, in one read: a look carries on from it (its id once used for something else, it doesn't)
  const lookIds = [...new Set(one.map((r) => r.look).filter(Boolean))];
  const stored = new Map(lookIds.length ? ((await env.DB.prepare(`SELECT id, look, kind, ref, sub, secs FROM board_activity WHERE slug = ? AND look IN (${marks(lookIds)})`)
    .bind(member.slug, ...lookIds).all()).results || []).map((x) => [x.look, x]) : []);
  // Something new began after their last report, or near it: a page shows up in a report within about six minutes of
  // opening (a page not touched yet waits for its first second, five minutes at most, then the next minute's), and a
  // report that didn't get through goes again within the half hour. Nobody's open is dated the night before
  const lastAt = Date.parse((await env.DB.prepare('SELECT at FROM board_activity_reports WHERE slug = ?').bind(member.slug).first())?.at || '') || now - 30 * 60_000;
  const floor = Math.max(Math.min(lastAt, now) - 7 * 60_000, now - 30 * 60_000);
  // (a page they've been on since before it: from then on, never earlier)
  const fresh = one.filter((r) => {
    if ((r.look && stored.has(r.look)) || r.at >= floor) return true;
    if (!LOOKS.includes(r.kind) || r.end < floor) return false;
    r.secs = Math.min(r.secs, Math.round((r.end - floor) / 1000));
    r.touched = Math.min(r.touched || 0, r.secs);
    r.at = floor;
    return true;
  });
  // What a row names is there for them, or the row isn't kept: a file they may open (never a staff-only one, or an id
  // made up), a meeting on their board page, a paper written in Board the board has. The chair's review and a
  // presenter's report page come before the board has the meeting: the review is the chair's, of a meeting ahead; a
  // report page is one of the meeting's own items
  const fileRef = (r) => (r.kind === 'file' || (r.kind === 'print' && r.ref && !PRINTS.includes(r.sub)) ? r.ref : '');
  const meetingRef = (r) => (r.kind === 'view' ? (/^(meeting|screen|review|report)\//.test(r.ref) ? r.ref.split('/')[1] : '')
    : r.kind === 'video' || (r.kind === 'print' && ['all', 'form', 'page'].includes(r.sub)) ? r.ref : '');
  const paperRef = (r) => (r.kind === 'view' && r.ref.startsWith('paper/') ? r.ref.slice(6) : r.kind === 'print' && r.sub === 'paper' ? r.ref : '');
  const fileIds = [...new Set(fresh.map(fileRef).filter(Boolean))];
  if (fresh.length) await ensureSchema(env.DB);
  const fileRows = fileIds.length ? (await env.DB.prepare(`SELECT id, owner_type, owner_id, staff_only FROM board_files WHERE id IN (${marks(fileIds)})`).bind(...fileIds).all()).results || [] : [];
  const meetingIds = [...new Set([...fresh.map(meetingRef), ...fresh.filter((r) => r.kind === 'file').map((r) => r.sub), ...fileRows.filter((f) => f.owner_type === 'meeting').map((f) => f.owner_id)].filter(Boolean))];
  const docIds = [...new Set([...fresh.map(paperRef), ...fileRows.filter((f) => f.owner_type === 'doc').map((f) => f.owner_id)].filter(Boolean))];
  const signedIds = fileRows.filter((f) => f.owner_type === 'signed').map((f) => f.id);
  const [meetings, docs, theirCopies] = await Promise.all([
    Promise.all(meetingIds.map(async (id) => [id, await getMeeting(env.DB, id)])).then((x) => new Map(x.filter(([, m]) => m))),
    docIds.length ? env.DB.prepare(`SELECT id, data FROM board_docs WHERE id IN (${marks(docIds)})`).bind(...docIds).all().then((r) => new Map((r.results || []).map((d) => [d.id, cleanDoc(parse(d.data))]))) : new Map(),
    signedIds.length ? env.DB.prepare(`SELECT file_id FROM board_signatures WHERE slug = ? AND file_id IN (${marks(signedIds)})`).bind(member.slug, ...signedIds).all().then((r) => new Set((r.results || []).map((x) => x.file_id))) : new Set(),
  ]);
  // A file they may open, as fileFor (./_board.js) says: their own signed copy; else never staff-only, and the board's meeting or paper
  const byFile = new Map(fileRows.map((f) => [f.id, f]));
  const mayOpen = (id) => {
    const f = byFile.get(id);
    if (!f) return false;
    if (f.owner_type === 'signed') return theirCopies.has(f.id);
    if (f.staff_only) return false;
    return f.owner_type === 'meeting' ? !!meetings.get(f.owner_id)?.shared : !!docs.get(f.owner_id)?.shared;
  };
  const today = todayEastern(now);
  const meetingOk = (r, id) => {
    const m = meetings.get(id);
    if (!m) return false;
    const [page, , item] = r.kind === 'view' ? r.ref.split('/') : [];
    if (page === 'review') return member.seat === 'chair' && !m.notBoard && m.date >= today;
    if (page === 'report') return !m.notBoard && (m.sections || []).some((x) => (x.items || []).some((it) => it.id === item));
    return onBoardPage(m, today);
  };
  const paperOk = (id) => { const d = docs.get(id); return !!d?.shared && !!d.body; };
  // A file opened from a meeting that isn't one: the file, from nowhere in particular
  for (const r of fresh) if (r.kind === 'file' && r.sub && !meetings.has(r.sub)) r.sub = '';
  const seen = fresh.filter((r) => (!fileRef(r) || mayOpen(r.ref)) && (!meetingRef(r) || meetingOk(r, meetingRef(r))) && (!paperRef(r) || paperOk(paperRef(r))));
  // A meeting's screen watched untouched counts only in the meeting's own hours
  for (const r of seen.filter((x) => x.kind === 'view' && x.ref.startsWith('screen/'))) {
    const hours = meetingHours(meetings.get(r.ref.split('/')[1]));
    const overlap = hours ? Math.max(0, Math.round((Math.min(r.end, hours[1]) - Math.max(r.at, hours[0])) / 1000)) : 0;
    r.secs = Math.min(r.secs, (r.touched || 0) + overlap);
    // (a screen left on, untouched, isn't "on the board page" all night: it lasted as long as it counted, in the
    // meeting's hours when that's when it counted)
    r.end = Math.min(r.end, overlap ? Math.max(r.at + r.secs * 1000, hours[1]) : r.at + r.secs * 1000);
  }
  const looks = seen.filter((r) => LOOKS.includes(r.kind));
  // One thing in front at a time: a look never runs past when the next one began
  looks.forEach((r, i) => {
    const next = looks.slice(i + 1).find((x) => x.at > r.at + 2000 && x.look !== r.look);
    if (next) r.secs = Math.min(r.secs, Math.max(0, Math.round((next.at - r.at) / 1000) + 1));
  });
  // Print it all, once in ten minutes a meeting (a slow packet, a second click)
  for (const pr of seen.filter((r) => r.kind === 'print' && r.sub === 'all' && r.ref)) {
    const was = await lastRow(env.DB, member.slug, 'print', pr.ref, 'all');
    if ((was && pr.at - Date.parse(was.until) < 10 * 60_000) || seen.some((x) => x !== pr && x.kind === 'print' && x.sub === 'all' && x.ref === pr.ref && Math.abs(x.at - pr.at) < 10 * 60_000 && seen.indexOf(x) < seen.indexOf(pr))) seen.splice(seen.indexOf(pr), 1);
  }
  // No more time than has passed since their last report (up to half an hour: a connection that dropped for a while
  // sends it all when it's back), claimed in one step: reports sent at once share it, the first taking what's passed
  // and the rest what's left. Only a report that adds time claims it (a screen left on elsewhere takes none)
  const adds = looks.some((r) => r.secs > Number(stored.get(r.look)?.secs || 0));
  const claim = adds ? await env.DB.prepare('INSERT INTO board_activity_reports (slug, at) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET prev = board_activity_reports.at, at = excluded.at RETURNING prev')
    .bind(member.slug, iso(now)).first() : null;
  const before = Date.parse(claim?.prev || '') || 0;
  const passed = Math.min(30 * 60_000, Math.max(0, now - before));
  // (two seconds' grace for a minute's report and its rounding: none for reports sent seconds apart)
  let budget = Math.round(passed / 1000) + (passed >= 30_000 ? 2 : 0);
  for (const r of looks) {
    const had = Number(stored.get(r.look)?.secs || 0);
    const more = Math.min(Math.max(0, r.secs - had), budget);
    budget -= more;
    r.secs = Math.max(had, had + more);
  }
  await signedIn(env.DB, member, request, now);
  // The page knows an iPad that the browser called a Mac: its sign-in says so too
  const iat = accessIat(request);
  if (iat && body?.touch === true) await env.DB.prepare("UPDATE board_signins SET device = ? WHERE slug = ? AND iat = ? AND device LIKE 'Mac%'").bind(device, member.slug, iat).run();
  await add(env.DB, member.slug, seen, device, now, stored);
  if (Math.random() < 0.02) await env.DB.batch([env.DB.prepare('DELETE FROM board_activity WHERE at < ?').bind(iso(now - KEEP_MS)), env.DB.prepare('DELETE FROM board_signins WHERE at < ?').bind(iso(now - KEEP_MS))]);
  return { kept: seen.length };
}

// ─── Reading it (Board → Members) ───────────────────────────────────

/** Sittings: activity times (ms, sorted) split wherever nothing happened for VISIT_GAP_MS */
export function visitsOf(points) {
  const out = [];
  for (const p of points) {
    const cur = out.at(-1);
    if (cur && p.at - cur.until <= VISIT_GAP_MS) { cur.until = Math.max(cur.until, p.until); cur.secs += p.secs; } else out.push({ at: p.at, until: p.until, secs: p.secs });
  }
  return out;
}

/**
 * Each member's summary: { [slug]: { signIns, firstSignIn, lastSignIn, lastAt, device, days: { YYYY-MM-DD (Eastern):
 * secs } for each day of the last 35 they were on the page, visits35, secs35, files: { [fileId]: secs } (every file
 * they've opened, all time) } }
 */
export async function activityOverview(DB, { now = Date.now() } = {}) {
  await ensureActivitySchema(DB);
  const since = iso(now - 35 * 86_400_000);
  const [signins, recent, files] = await Promise.all([
    DB.prepare('SELECT s.slug, COUNT(*) AS n, MIN(s.at) AS first, MAX(s.at) AS last, (SELECT device FROM board_signins x WHERE x.slug = s.slug ORDER BY x.at DESC LIMIT 1) AS device, SUM(CASE WHEN s.at >= (SELECT MIN(added) FROM board_signins) THEN 1 ELSE 0 END) AS since FROM board_signins s GROUP BY s.slug').all().then((r) => r.results || []),
    // Each member's newest first, so one member's many rows can't crowd out the rest
    // (by when: the planner would rather read every row in member order)
    DB.prepare('SELECT slug, kind, secs, at, until, device FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY at DESC) AS n FROM board_activity INDEXED BY board_activity_at WHERE at >= ?) WHERE n <= 5000 ORDER BY at').bind(since).all().then((r) => r.results || []),
    // Every file they've opened (Print it all is kept apart, as printedAll: which documents it drew isn't known)
    DB.prepare("SELECT slug, ref, SUM(secs) AS secs FROM board_activity WHERE kind = 'file' GROUP BY slug, ref").all().then((r) => r.results || []),
  ]);
  // When each was last on, and on what: their newest row, one look each (a member, not every row)
  const lasts = await Promise.all([...new Set([...signins, ...recent].map((x) => x.slug))].map((slug) => DB.prepare('SELECT slug, until, device FROM board_activity WHERE slug = ? ORDER BY until DESC LIMIT 1').bind(slug).first())).then((x) => x.filter(Boolean));
  const out = {};
  const of = (slug) => (out[slug] ||= { signIns: 0, firstSignIn: null, lastSignIn: null, lastAt: null, device: '', days: {}, visits35: 0, secs35: 0, files: {}, printedAll: {} });
  for (const s of signins) Object.assign(of(s.slug), { signIns: Number(s.n) || 0, signInsSince: Number(s.since) || 0, firstSignIn: s.first, lastSignIn: s.last, signInDevice: s.device || '' });
  for (const l of lasts) Object.assign(of(l.slug), { lastAt: l.until, device: l.device || '' });
  for (const f of files) of(f.slug).files[f.ref] = Number(f.secs) || 0;
  for (const pr of (await DB.prepare("SELECT slug, ref, MAX(at) AS at FROM board_activity WHERE kind = 'print' AND sub = 'all' GROUP BY slug, ref").all()).results || []) of(pr.slug).printedAll[pr.ref] = pr.at;
  const month = now - 35 * 86_400_000;
  const by = {};
  for (const r of recent) (by[r.slug] ||= []).push({ at: Date.parse(r.at), until: Date.parse(r.until), secs: ['view', 'file'].includes(r.kind) ? Number(r.secs) || 0 : 0 });
  for (const [slug, points] of Object.entries(by)) {
    const o = of(slug);
    for (const p of points) { const d = todayEastern(p.at); o.days[d] = (o.days[d] || 0) + p.secs; }
    const m = points.filter((p) => p.until >= month);
    o.visits35 = visitsOf(m).length;
    o.secs35 = m.reduce((t, p) => t + p.secs, 0);
  }
  // A day they only signed in is a day on the page too, and a sitting
  const signedDays = await DB.prepare('SELECT slug, at FROM board_signins WHERE at >= ?').bind(since).all().then((r) => r.results || []);
  for (const s of signedDays) { const o = of(s.slug); const d = todayEastern(Date.parse(s.at)); o.days[d] = o.days[d] || 0; (by[s.slug] ||= []).push({ at: Date.parse(s.at), until: Date.parse(s.at), secs: 0, signin: true }); }
  for (const [slug, points] of Object.entries(by)) {
    if (!points.some((p) => p.signin)) continue;
    points.sort((a, b) => a.at - b.at);
    out[slug].visits35 = visitsOf(points.filter((p) => p.until >= month)).length;
  }
  // When Board began keeping these: the first row it wrote (a sign-in's own time can be days older: tokens last a week)
  const began = (await DB.prepare('SELECT MIN(at) AS at FROM (SELECT * FROM (SELECT added AS at FROM board_signins ORDER BY rowid LIMIT 1) UNION ALL SELECT * FROM (SELECT added AS at FROM board_activity ORDER BY id LIMIT 1))').first())?.at || null;
  if (began) Object.defineProperty(out, 'began', { value: began, enumerable: false });
  // A sign-in later than anything they did since (they signed in, then left)
  for (const o of Object.values(out)) if (o.lastSignIn && (!o.lastAt || o.lastSignIn > o.lastAt)) { o.lastAt = o.lastSignIn; o.device = o.signInDevice || o.device; }
  return out;
}

/**
 * One member's sign-ins and everything they did, newest first (the last 180 days, at most 1,500 rows), and the files
 * those name: { [id]: { name, ownerType, ownerId } } (an earlier copy of a paper is still a file of its own)
 */
export async function memberActivity(DB, slug, { now = Date.now() } = {}) {
  await ensureActivitySchema(DB);
  const since = iso(now - 180 * 86_400_000);
  const [signIns, events] = await Promise.all([
    DB.prepare('SELECT at, device FROM board_signins WHERE slug = ? AND at >= ? ORDER BY at DESC LIMIT 300').bind(slug, since).all().then((r) => r.results || []),
    DB.prepare('SELECT kind, ref, sub, secs, at, until, device FROM board_activity WHERE slug = ? AND at >= ? ORDER BY at DESC LIMIT 1500').bind(slug, since).all().then((r) => r.results || []),
  ]);
  // At most 1,500 events: then it starts at the oldest of them, sign-ins too
  const from = events.length >= 1500 ? events.at(-1).at : since;
  const ids = [...new Set(events.filter((e) => e.kind === 'file' || e.kind === 'print').map((e) => e.ref).filter(idOk))];
  const files = {};
  if (ids.length) await ensureSchema(DB);
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    for (const f of (await DB.prepare(`SELECT id, name, owner_type, owner_id FROM board_files WHERE id IN (${marks(part)})`).bind(...part).all()).results || []) files[f.id] = { name: f.name, ownerType: f.owner_type, ownerId: f.owner_id };
  }
  return { from, signIns: signIns.filter((x) => x.at >= from), events: events.map((e) => ({ ...e, secs: Number(e.secs) || 0 })), files };
}
