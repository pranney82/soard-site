/**
 * Board meetings from Peter and Holly's calendars
 * ===========================================================================
 * Board meetings are already on the calendar (it's how the board is invited),
 * so Board takes them from there, the way reveals follow JobTread. Every event
 * from today on that's named like a board meeting, on the Google calendar of
 * each of the Board area's admins, becomes a meeting with its day, time,
 * place and video link:
 *   - "SOARD Q4 Board Meeting", "Board Meeting", "Board of Directors mtg" and
 *     "Q4 Board" all count, as does any event with "board" in its name and
 *     three or more board members invited.
 *   - Advisory Board, reveal and demo day events never count.
 * The event's name is the meeting's name ("SOARD Q4 Board Meeting": SOARD's
 * own quarter numbering, not one worked out from the date) until someone types
 * another one in Board. A moved event moves its meeting: the calendar is where the day changes. A
 * meeting added here by hand on the same day is linked to the event instead
 * of doubled. A meeting whose event is gone stays, marked gone for the admins.
 * New meetings start from Settings' agenda, not shared, like any new meeting.
 *
 * It reads through the site's Google service account (GOOGLE_CALENDAR_KEY,
 * domain-wide delegation, the same one reveal invites go out with) and never
 * writes to anyone's calendar.
 */

import { accessToken, listEvents } from './_google-calendar.js';
import { easternParts } from './_reveals.js';
import { boardAdmins, activeBoard, readState, writeState } from './_board-roles.js';
import { listMeetings, saveMeeting, createMeeting, ensureSchema } from './_board.js';
import { todayEastern } from '../../public/admin/board-shared.js';

const KEY = 'calendar';
const EVERY_MS = 60 * 60 * 1000;
const AHEAD_DAYS = 400;
export const CALENDAR_BY = 'the calendar';

const NAMED = /\b(meeting|mtg)\b|\bQ[1-4]\b/i;
const NEVER = /\b(advisory|reveal|demo)\b/i;

/** An event that's a board meeting: "board" in its name, never an advisory, reveal or demo day event */
export function isBoardMeetingEvent(ev, boardEmails = []) {
  const title = String(ev?.summary || '');
  if (ev?.status === 'cancelled' || !/\bboard\b/i.test(title) || NEVER.test(title)) return false;
  if (NAMED.test(title)) return true;
  const invited = new Set((ev.attendees || []).map((a) => String(a.email || '').toLowerCase()));
  return boardEmails.filter((e) => invited.has(e)).length >= 3;
}

/** The event's day and times in Atlanta: { date, start, end } (no times for an all-day event) */
export function eventWhen(ev) {
  if (ev?.start?.date) return { date: ev.start.date, start: '', end: '' };
  const s = easternParts(ev?.start?.dateTime);
  if (!s) return { date: '', start: '', end: '' };
  const e = easternParts(ev?.end?.dateTime);
  return { date: s.date, start: s.time || '00:00', end: e && e.date === s.date ? (e.time || '') : '' };
}

const URL_RE = /https:\/\/[^\s<>"]+/i;
/** Where: { location, address, video } from the event's location, its Meet link or a meeting link in its notes */
export function eventPlace(ev) {
  const raw = String(ev?.location || '').trim();
  const entry = (ev?.conferenceData?.entryPoints || []).find((p) => p.entryPointType === 'video' && /^https:\/\//.test(p.uri || ''));
  const inText = (s) => (String(s || '').match(URL_RE) || [])[0] || '';
  const looksLikeCall = (u) => /zoom\.us|teams\.microsoft|teams\.live|meet\.google|webex/i.test(u);
  let video = ev?.hangoutLink || entry?.uri || '';
  let location = raw;
  if (URL_RE.test(raw) && raw.match(URL_RE)[0] === raw) { video ||= raw; location = ''; }
  if (!video) { const u = inText(ev?.description); if (looksLikeCall(u)) video = u; }
  // "Crosby Design Group, 123 Main St, Roswell, GA" → the place, then its address
  let address = '';
  const comma = location.indexOf(',');
  if (comma > 0 && /\d/.test(location.slice(comma))) { address = location.slice(comma + 1).trim(); location = location.slice(0, comma).trim(); }
  else if (/^\d/.test(location)) { address = location; location = ''; }
  return { location, address, video: video.replace(/[).,]+$/, '') };
}

/**
 * Look at the admins' calendars and bring Board's meetings up to them.
 * → the saved state: { ok, checkedAt, found, added, moved, linked, gone, calendars, errors }
 */
export async function syncBoardCalendar(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  if (!env.GOOGLE_CALENDAR_KEY) return writeState(env.DB, KEY, { ok: false, configured: false, checkedAt: new Date(now).toISOString() });
  // One look at a time (the heartbeat and someone opening Board can arrive together), or a new event would be added twice
  const last = await readState(env.DB, KEY); // (makes board_state on a new database)
  if (!(await takeLock(env.DB, now))) return last;
  try { return await look(env, { fetchImpl, now }); } finally { await env.DB.prepare("DELETE FROM board_state WHERE key = 'calendar-lock'").run().catch(() => {}); }
}

async function takeLock(DB, now) {
  const r = await DB.prepare(`INSERT INTO board_state (key, data, updated_at) VALUES ('calendar-lock', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE CAST(json_extract(board_state.data, '$.until') AS INTEGER) < ?`)
    .bind(JSON.stringify({ until: now + 2 * 60 * 1000 }), new Date(now).toISOString(), now).run();
  return (r?.meta?.changes ?? r?.changes ?? 0) > 0;
}

async function look(env, { fetchImpl, now }) {
  const today = todayEastern(now);
  const [admins, board] = await Promise.all([boardAdmins(env.DB), activeBoard(env.DB)]);
  const boardEmails = board.map((p) => p.email).filter(Boolean);
  const timeMin = new Date(now - 86_400_000).toISOString();
  const timeMax = new Date(now + AHEAD_DAYS * 86_400_000).toISOString();
  const found = new Map(); // iCalUID → { ev, from }
  const errors = [];
  let read = 0;
  for (const email of admins) {
    try {
      const token = await accessToken(env, email, { fetchImpl, now });
      for (const ev of await listEvents(token, email, { timeMin, timeMax, q: 'board', fetchImpl })) {
        if (!isBoardMeetingEvent(ev, boardEmails)) continue;
        const uid = ev.iCalUID || ev.id;
        if (uid && !found.has(uid)) found.set(uid, { ev, from: email });
      }
      read += 1;
    } catch (err) {
      errors.push(`${email.split('@')[0]}’s calendar: ${String(err.message).slice(0, 200)}`);
    }
  }
  const counts = { added: 0, moved: 0, linked: 0, gone: 0 };
  let meetings = await listMeetings(env.DB);
  for (const [uid, { ev, from }] of found) {
    const when = eventWhen(ev);
    if (!when.date || when.date < today) continue;
    const place = eventPlace(ev);
    let m = meetings.find((x) => x.calendar?.uid === uid)
      || meetings.find((x) => !x.calendar?.uid && x.date === when.date);
    // What the calendar says wins; what it leaves out stays as typed here (place: it has a place; call: it has a video link)
    const link = { uid, title: String(ev.summary || '').slice(0, 200), from, link: /^https:\/\//.test(ev.htmlLink || '') ? ev.htmlLink : '', gone: false, place: !!(place.location || place.address), call: !!place.video };
    if (!m) {
      m = await createMeeting(env, { date: when.date, by: CALENDAR_BY });
      counts.added += 1;
    } else if (!m.calendar?.uid) counts.linked += 1;
    const next = {
      ...m, date: when.date, start: when.start, end: when.end,
      title: !m.title || m.title === m.calendar?.title ? link.title : m.title,
      location: place.location || m.location,
      address: place.address || (place.location && place.location !== m.location ? '' : m.address),
      video: place.video || m.video,
      calendar: link,
    };
    const changed = ['date', 'start', 'end', 'title', 'location', 'address', 'video'].some((k) => next[k] !== m[k]) || JSON.stringify(m.calendar || null) !== JSON.stringify(link);
    if (changed) {
      if (m.calendar?.uid && (m.date !== next.date || m.start !== next.start)) counts.moved += 1;
      await saveMeeting(env.DB, next, { by: CALENDAR_BY });
    }
  }
  // A meeting from today on whose event is no longer on any calendar: kept, marked gone (only when every calendar was read)
  if (!errors.length) {
    meetings = await listMeetings(env.DB);
    for (const m of meetings) {
      if (!m.calendar?.uid || m.calendar.gone || m.date < today || found.has(m.calendar.uid)) continue;
      await saveMeeting(env.DB, { ...m, calendar: { ...m.calendar, gone: true } }, { by: CALENDAR_BY });
      counts.gone += 1;
    }
  }
  return writeState(env.DB, KEY, {
    ok: !errors.length, configured: true, checkedAt: new Date(now).toISOString(),
    found: [...found.values()].filter(({ ev }) => eventWhen(ev).date >= today).length, ...counts, calendars: read, errors,
  });
}

export const calendarStatus = (DB) => readState(DB, KEY);

/** Every hour (or sooner: minAgeMs) at most. Never throws. */
export async function maybeSyncBoardCalendar(env, { fetchImpl = fetch, now = Date.now(), minAgeMs = EVERY_MS } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    const s = await readState(env.DB, KEY);
    if (s.checkedAt && now - Date.parse(s.checkedAt) < minAgeMs) return null;
    return await syncBoardCalendar(env, { fetchImpl, now });
  } catch (err) {
    console.error('[board-calendar]', err.message);
    return null;
  }
}
