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
 * of doubled, and so is each admin's own copy of the same meeting: one meeting
 * per day, named and timed by the copy that organized it. A meeting whose event is gone stays, marked gone for the admins.
 * New meetings start from Settings' agenda, not shared, like any new meeting.
 *
 * It reads through the site's Google service account (GOOGLE_CALENDAR_KEY,
 * domain-wide delegation, the same one reveal invites go out with) and never
 * writes to anyone's calendar.
 */

import { accessToken, listEvents } from './_google-calendar.js';
import { easternParts } from './_reveals.js';
import { boardAdmins, activeBoard, readState, writeState } from './_board-roles.js';
import { listMeetings, saveMeeting, createMeeting, deleteMeeting, ensureSchema } from './_board.js';
import { todayEastern, cleanMeeting } from '../../public/admin/board-shared.js';

const KEY = 'calendar';
const EVERY_MS = 60 * 60 * 1000;
const AHEAD_DAYS = 400;
// A look by older code is redone at once (2: one meeting per day across calendars)
const VERSION = 2;
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
const TBD = /^(tbd|tba|to be (determined|announced|confirmed))\.?$/i;
/** "TBD", "To be determined": no place yet */
export const isTbd = (s) => TBD.test(String(s || '').trim());

/** An invite's notes (often Outlook's HTML) as plain lines */
export function plainText(s) {
  return String(s || '')
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/\s*(p|div|li|tr|h\d)\s*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&rsquo;/gi, '’').replace(/&quot;/gi, '"')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

const STREET = '(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Pkwy|Parkway|Hwy|Highway|Ct|Court|Pl|Place|Cir|Circle|Trl|Trail|Ter|Terrace|Sq|Square|Pike|Row|Crossing|Xing|Point|Pt|Ridge|Loop|Bend|Walk|Commons)';
const ADDRESS = new RegExp(`\\b(\\d{1,6}\\s+(?:[A-Za-z0-9.'’-]+\\s){0,5}${STREET}\\.?(?:,?\\s*(?:Suite|Ste\\.?|Unit|Bldg|Building|#)\\s*[\\w-]+)?(?:,?\\s+[A-Za-z .'’-]+?){1,3},?\\s+(?:[A-Z]{2}|Georgia)\\s+\\d{5}(?:-\\d{4})?)\\b`);
/** A street address in an invite's notes, and the place name before it (on its line or the line above): { location, address } or null */
export function addressIn(notes) {
  const lines = plainText(notes).split('\n');
  const label = /^(location|where|address|place)\s*[:\-–]?\s*/i;
  const looksLikePlace = (t) => !!t && t.length < 70 && !/https?:|teams|zoom|meeting id|passcode|join|dial|please|agenda/i.test(t)
    && !/\b(at|in|on|to|is|are|be|will|meet|held|located|address)\s*[:\-–]?$/i.test(t);
  for (let i = 0; i < lines.length; i++) {
    // On one line, or a street on this line with its city, state and ZIP on the next
    let m = lines[i].match(ADDRESS);
    let line = lines[i];
    if (!m && lines[i + 1]) {
      const both = `${lines[i]}, ${lines[i + 1]}`;
      const joined = both.match(ADDRESS);
      if (joined && joined.index < lines[i].length) { m = joined; line = both; }
    }
    if (!m) continue;
    const before = line.slice(0, m.index).replace(label, '').replace(/[:\-–,\s]+$/, '').trim();
    const above = i > 0 ? lines[i - 1].replace(label, '').replace(/[:\s]+$/, '').trim() : '';
    const location = looksLikePlace(before) ? before : !before && looksLikePlace(above) ? above : '';
    return { location, address: m[1].replace(/\s+/g, ' ').trim() };
  }
  return null;
}

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
  if (isTbd(location)) location = '';
  // No place on the invite ("TBD"): an address written in its notes
  if (!location && !address) {
    const found = addressIn(ev?.description);
    if (found) ({ location, address } = found);
  }
  return { location, address, video: video.replace(/[).,]+$/, ''), said: raw.slice(0, 200) };
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
  // One meeting per day. Peter's and Holly's copies of the same meeting are one meeting: the copy that
  // organized it names it and sets its times, and a video link or a real place comes from whichever copy has one
  const days = new Map(); // date → [{ uid, ev, from, when, place }]
  for (const [uid, { ev, from }] of found) {
    const when = eventWhen(ev);
    if (!when.date || when.date < today) continue;
    if (!days.has(when.date)) days.set(when.date, []);
    days.get(when.date).push({ uid, ev, from, when, place: eventPlace(ev) });
  }
  const counts = { added: 0, moved: 0, linked: 0, gone: 0, merged: 0 };
  const onCalendar = new Set();
  let meetings = await listMeetings(env.DB);
  for (const [date, copies] of days) {
    const lead = copies.find((c) => c.ev.organizer?.self) || copies[0];
    const uids = [lead.uid, ...copies.filter((c) => c !== lead).map((c) => c.uid)];
    uids.forEach((u) => onCalendar.add(u));
    const hasPlace = (c) => !!(c.place.location || c.place.address);
    const place = hasPlace(lead) ? lead.place : (copies.find(hasPlace)?.place || lead.place);
    const video = lead.place.video || copies.find((c) => c.place.video)?.place.video || '';
    const { when, ev, from } = lead;
    // Who's invited and how they answered the invite (the organizer's copy knows), by board member
    const bySlug = Object.fromEntries(board.filter((p) => p.email).map((p) => [p.email, p.slug]));
    const replies = {};
    for (const c of [lead, ...copies.filter((x) => x !== lead)]) {
      for (const a of c.ev.attendees || []) {
        const slug = bySlug[String(a.email || '').toLowerCase()];
        if (slug && !replies[slug]) replies[slug] = ['accepted', 'declined', 'tentative'].includes(a.responseStatus) ? a.responseStatus : 'invited';
      }
    }
    // Its meeting: one a person has worked on, else the oldest. An untouched extra copy goes (one per calendar, before)
    const linked = meetings.filter((x) => x.calendar && [x.calendar.uid, ...(x.calendar.others || [])].some((u) => uids.includes(u)))
      .sort((a, b) => (Number(b.updatedBy !== CALENDAR_BY) - Number(a.updatedBy !== CALENDAR_BY)) || String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const extra of linked.slice(1)) {
      if (extra.updatedBy !== CALENDAR_BY || extra.shared || extra.files.length) continue;
      await deleteMeeting(env, extra.id);
      counts.merged += 1;
    }
    let m = linked[0] || meetings.find((x) => !x.calendar?.uid && x.date === date) || null;
    // What the calendar says wins; what it leaves out stays as typed here (place: it has a place; call: it has a video link)
    const link = {
      uid: lead.uid, others: uids.slice(1), title: String(ev.summary || '').slice(0, 200), from,
      link: /^https:\/\//.test(ev.htmlLink || '') ? ev.htmlLink : '', gone: false, place: !!(place.location || place.address), call: !!video,
      said: copies.map((c) => c.place.said).find(Boolean) || '',
      replies,
    };
    if (!m) {
      m = await createMeeting(env, { date, by: CALENDAR_BY });
      counts.added += 1;
    } else if (!m.calendar?.uid) counts.linked += 1;
    const next = {
      ...m, date, start: when.start, end: when.end,
      title: !m.title || m.title === m.calendar?.title ? link.title : m.title,
      location: place.location || (isTbd(m.location) ? '' : m.location),
      address: place.address || (place.location && place.location !== m.location ? '' : m.address),
      video: video || m.video,
      calendar: link,
    };
    // Compared as the stored record has it (cleanMeeting's field order), or every look would save again
    const sameLink = JSON.stringify(cleanMeeting({ calendar: link }).calendar) === JSON.stringify(cleanMeeting({ calendar: m.calendar }).calendar);
    const changed = ['date', 'start', 'end', 'title', 'location', 'address', 'video'].some((k) => next[k] !== m[k]) || !sameLink;
    if (changed) {
      if (m.calendar?.uid && (m.date !== next.date || m.start !== next.start)) counts.moved += 1;
      await saveMeeting(env.DB, next, { by: CALENDAR_BY });
    }
  }
  // A meeting from today on whose event is on no calendar any more: kept, marked gone (only when every calendar was read)
  if (!errors.length) {
    meetings = await listMeetings(env.DB);
    for (const m of meetings) {
      if (!m.calendar?.uid || m.calendar.gone || m.date < today) continue;
      if ([m.calendar.uid, ...(m.calendar.others || [])].some((u) => onCalendar.has(u))) continue;
      await saveMeeting(env.DB, { ...m, calendar: { ...m.calendar, gone: true } }, { by: CALENDAR_BY });
      counts.gone += 1;
    }
  }
  return writeState(env.DB, KEY, {
    version: VERSION, ok: !errors.length, configured: true, checkedAt: new Date(now).toISOString(),
    found: days.size, ...counts, calendars: read, errors,
  });
}

export const calendarStatus = (DB) => readState(DB, KEY);

/** Every hour (or sooner: minAgeMs) at most. Never throws. */
export async function maybeSyncBoardCalendar(env, { fetchImpl = fetch, now = Date.now(), minAgeMs = EVERY_MS } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    const s = await readState(env.DB, KEY);
    if (s.version === VERSION && s.checkedAt && now - Date.parse(s.checkedAt) < minAgeMs) return null;
    return await syncBoardCalendar(env, { fetchImpl, now });
  } catch (err) {
    console.error('[board-calendar]', err.message);
    return null;
  }
}
