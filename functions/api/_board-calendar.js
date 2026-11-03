/**
 * The board's answers to each meeting's calendar invite
 * ===========================================================================
 * A board meeting is added in Board, and only there (Peter, Nov 2 2026: "the
 * ONLY way should be to add it to the board in admin"). Its day, time, place
 * and notes are typed there, and Board's invite carries them to the board
 * (./_board-invite.js). A calendar event never makes, moves or renames a
 * meeting.
 *
 * Hourly (and at most every ten minutes while Board is open) it reads each
 * invite still ahead from the event itself:
 *   - who is on it and how each board member answered: yes, no or maybe,
 *     the only answer SOARD goes by
 *   - its day, time or place changed in Google Calendar: Board puts its own
 *     back on the invite (Google emails the guests the correction) and says
 *     so on the meeting; once for each change, never back and forth
 *   - the event deleted in Google Calendar: the meeting stays, its invite is
 *     marked gone, and Board offers to send it again
 * and looks on the admins' calendars for board meeting invites Board didn't
 * send (named like one: isBoardMeetingEvent), only to say so: another invite
 * on a meeting's day (the board would have two, with two calls: whoever sent
 * it should cancel it), or a board meeting on a day Board has none (add it in
 * Board, then delete that event). Neither ever makes or changes a meeting.
 *
 * Meetings ahead that older code took from Holly's calendar are Board's from
 * the first look (VERSION 8): their link to the calendar comes off, their
 * invite stays the event Board already added the board to, and its place is
 * read as Board has it, so nobody is emailed about a place that didn't
 * change. Past meetings keep theirs as a record.
 *
 * It reads through the site's Google service account (GOOGLE_CALENDAR_KEY,
 * domain-wide delegation), and writes only Board's own day, time and place
 * back onto Board's invite (./_board-invite.js).
 */

import { accessToken } from './_google-calendar.js';
import { easternParts } from './_reveals.js';
import { activeBoard, boardAdmins, readState, writeState, normEmail } from './_board-roles.js';
import { listMeetings, patchMeeting, ensureSchema } from './_board.js';
import { placeOf, driftOf, sendInvite } from './_board-invite.js';
import { todayEastern, isDate, meetingName } from '../../public/admin/board-shared.js';

const KEY = 'calendar';
const EVERY_MS = 60 * 60 * 1000;
const AHEAD_DAYS = 400;
const CAL_API = 'https://www.googleapis.com/calendar/v3';
// A look by older code is redone at once (2–7: meetings taken from the admins' calendars; 8: meetings are added in
// Board only, and the calendar sends back the answers to Board's invites)
const VERSION = 8;
export const CALENDAR_BY = 'the calendar';
const REPLIES = ['accepted', 'declined', 'tentative'];

const NAMED = /\b(meeting|mtg)\b|\bQ[1-4]\b/i;
const NEVER = /\b(advisory|reveal|demo)\b/i;
// Time with someone about the board, not the board meeting: a coffee with a prospective member, a social night, the prep beforehand
const NOT_A_MEETING = /\b(coffee|lunch|breakfast|dinner|drinks|happy hour|wine|social|party|celebration|game night|call with|1:1|1-on-1|one[- ]on[- ]one|prospect\w*|potential|candidate|interview|prep|pre[- ]?meeting|debrief|reminder|to[- ]?do)\b/i;
// A reminder to do something for the meeting: "get Paul all docs for board meeting", "Send board packet"
const TODO = /^\s*(get|send|print|email|e-mail|prepare|finish|review|update|book|order|call|follow up|schedule|reserve|pick up|drop off|bring|remind|make|draft|copy|upload|share|ask)\b/i;
// The words a SOARD board meeting's own name is made of: what's before "board" in any other name is someone else's board
const OURS = new Set(['soard', 'sunshine', 'on', 'a', 'ranney', 'day', 'q1', 'q2', 'q3', 'q4', 'quarterly', 'annual', 'full', 'regular', 'special', 'the', 'of', 'staff', 'end', 'year', 'end-of-year', 'and', 'our', 'fall', 'spring', 'summer', 'winter', 'virtual', 'zoom', 'teams']);

/**
 * An event that's a board meeting: "board" in its name and either named as a
 * meeting ("Q4", "meeting", "mtg") or with three or more of SOARD's board
 * invited. Never an Advisory Board, reveal or demo day event, a coffee or a
 * social night, a reminder to do something, or another organization's board
 * ("REDT Full Board Meeting", "Cottage School Board meeting") unless three or
 * more of SOARD's board are invited to it.
 */
export function isBoardMeetingEvent(ev, boardEmails = []) {
  const title = String(ev?.summary || '');
  if (ev?.status === 'cancelled' || !/\bboard\b/i.test(title) || NEVER.test(title)) return false;
  if (NOT_A_MEETING.test(title) || TODO.test(title)) return false;
  const invited = new Set((ev.attendees || []).map((a) => String(a.email || '').toLowerCase()));
  const boardInvited = boardEmails.filter((e) => invited.has(String(e).toLowerCase())).length >= 3;
  if (!ownBoard(title) && !boardInvited) return false;
  return NAMED.test(title) || boardInvited;
}

/** Whether a name is SOARD's board's own ("Q4 SOARD Board Meeting", "Board Meeting": SOARD numbers its meetings by quarter), not another organization's */
function ownBoard(title) {
  const before = title.replace(/\([^)]*\)/g, ' ').split(/\bboard\b/i)[0];
  if (/\b(soard|sunshine on a ranney day|q[1-4])\b/i.test(before)) return true;
  return before.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean).every((w) => OURS.has(w) || /^\d{4}$/.test(w));
}

/** An event's day in Atlanta */
function dayOf(ev) {
  if (ev?.start?.date) return ev.start.date;
  const s = String(ev?.start?.dateTime || '');
  return /(Z|[+-]\d\d:?\d\d)$/i.test(s) ? easternParts(s)?.date || '' : s.slice(0, 10);
}

/**
 * The events matching `q` between two instants, every page of them (four
 * years of a calendar is more than one page). Repeating events come back as
 * their single days; cancelled ones are left out.
 */
async function eventsBetween(token, calendarId, { timeMin, timeMax, q, fetchImpl }) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250', timeMin, timeMax, q, ...(pageToken ? { pageToken } : {}) });
    const res = await fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Google Calendar read failed (${res.status}): ${data?.error?.message || ''}`.trim());
    out.push(...(data?.items || []).filter((e) => e.status !== 'cancelled'));
    pageToken = data?.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}


/**
 * Look at each invite still ahead and bring its answers onto its meeting.
 * → the saved state: { ok, checkedAt, invites, replies, gone, handedOver, rehomed, errors }
 */
export async function syncBoardCalendar(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  if (!env.GOOGLE_CALENDAR_KEY) return writeState(env.DB, KEY, { ok: false, configured: false, checkedAt: new Date(now).toISOString() });
  // One look at a time (the heartbeat and someone opening Board can arrive together)
  const last = await readState(env.DB, KEY); // (makes board_state on a new database)
  if (!(await takeLock(env.DB, now))) return last;
  try { return await look(env, { fetchImpl, now, handOver: last.version !== VERSION }); } finally { await env.DB.prepare("DELETE FROM board_state WHERE key = 'calendar-lock'").run().catch(() => {}); }
}

async function takeLock(DB, now) {
  const r = await DB.prepare(`INSERT INTO board_state (key, data, updated_at) VALUES ('calendar-lock', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE CAST(json_extract(board_state.data, '$.until') AS INTEGER) < ?`)
    .bind(JSON.stringify({ until: now + 2 * 60 * 1000 }), new Date(now).toISOString(), now).run();
  return (r?.meta?.changes ?? r?.changes ?? 0) > 0;
}

/**
 * Once: each meeting ahead older code took from an admin's calendar becomes Board's. The invite Board sent onto that
 * event stays its invite, with the event's latest answers and the place as Board has it (Holly's "Name (street, city,
 * United States)" is the same place). A meeting whose event was deleted stays as it was: off the board page
 */
async function handOver(DB, today) {
  let n = 0;
  for (const m of await listMeetings(DB)) {
    if (!m.calendar || m.calendar.gone || m.practice || !isDate(m.date) || m.date < today) continue;
    await patchMeeting(DB, m.id, (cur) => {
      const same = !!cur.invite?.eventId && cur.invite.eventId === cur.calendar?.eventId;
      // (location: the event's own words for its place, as Board last saw them, so the place isn't taken for a change made
      // in Google Calendar either)
      const invite = same ? { ...cur.invite, replies: { ...(cur.invite.replies || {}), ...(cur.calendar.replies || {}) }, location: cur.invite.location || cur.invite.place, place: placeOf(cur) || cur.invite.place } : cur.invite;
      return { ...cur, calendar: null, invite };
    });
    n += 1;
  }
  return n;
}

async function look(env, { fetchImpl, now, handOver: first }) {
  const today = todayEastern(now);
  const at = new Date(now).toISOString();
  const handedOver = first ? await handOver(env.DB, today) : 0;
  const [board, admins] = await Promise.all([activeBoard(env.DB), boardAdmins(env.DB)]);
  const bySlug = Object.fromEntries(board.filter((p) => p.email).map((p) => [normEmail(p.email), p.slug]));
  const counts = { invites: 0, replies: 0, gone: 0, putBack: 0 };
  const errors = [];
  const tokens = new Map();
  const tokenFor = async (email) => {
    if (!tokens.has(email)) tokens.set(email, await accessToken(env, email, { fetchImpl, now }));
    return tokens.get(email);
  };
  for (const m of await listMeetings(env.DB)) {
    const inv = m.invite;
    if (!inv?.eventId || !inv.organizer || m.practice || !isDate(m.date) || m.date < today) continue;
    counts.invites += 1;
    try {
      const token = await tokenFor(inv.organizer);
      const res = await fetchImpl(`${CAL_API}/calendars/${encodeURIComponent(inv.organizer)}/events/${encodeURIComponent(inv.eventId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
      const ev = await res.json().catch(() => null);
      // Deleted in Google Calendar: the meeting stays, its invite doesn't (Send the invite puts it back)
      if (res.status === 404 || res.status === 410 || (res.ok && ev?.status === 'cancelled')) {
        const done = await patchMeeting(env.DB, m.id, (cur) => (cur.invite?.eventId === inv.eventId ? { ...cur, invite: null, inviteGone: at } : cur));
        if (!done?.invite) counts.gone += 1;
        continue;
      }
      if (!res.ok) throw new Error(`Google Calendar read failed (${res.status}): ${ev?.error?.message || ''}`.trim());
      // Its day, time or place changed in Google Calendar: Board's go back on it, once for each change. The same change
      // again (made again, or kept by Google) is never fought over by email: the meeting says so, for a person to decide
      const drift = driftOf(ev, m);
      if (drift && inv.putBackFor !== drift) {
        await sendInvite(env, m.id, { fetchImpl, now });
        await patchMeeting(env.DB, m.id, (cur) => (cur.invite ? { ...cur, invite: { ...cur.invite, putBackAt: at, putBackFor: drift } } : cur));
        counts.putBack += 1;
        continue;
      }
      if ((drift || '') !== (inv.differs || '')) {
        await patchMeeting(env.DB, m.id, (cur) => (cur.invite?.eventId === inv.eventId ? { ...cur, invite: { ...cur.invite, differs: drift } } : cur));
      }
      // Who's on it now and how they answered, by board member
      const attendees = ev?.attendees || [];
      const replies = {};
      for (const a of attendees) {
        const slug = bySlug[normEmail(a.email)];
        if (slug && !replies[slug]) replies[slug] = REPLIES.includes(a.responseStatus) ? a.responseStatus : 'invited';
      }
      const emails = attendees.map((a) => normEmail(a.email)).filter(Boolean);
      if (JSON.stringify(replies) === JSON.stringify(inv.replies || {}) && JSON.stringify(emails) === JSON.stringify(inv.emails || [])) continue;
      await patchMeeting(env.DB, m.id, (cur) => (cur.invite?.eventId === inv.eventId ? { ...cur, invite: { ...cur.invite, replies, emails, guests: emails.length } } : cur));
      counts.replies += 1;
    } catch (err) {
      errors.push(`${meetingName(m)}: ${String(err.message).slice(0, 200)}`);
    }
  }
  // Board meeting invites Board didn't send, on the admins' calendars: on a meeting's day (another invite for it), or on
  // a day with none (a meeting to add in Board). Said, never made into a meeting
  const meetings = await listMeetings(env.DB);
  const ours = new Set(meetings.filter((x) => x.invite?.eventId).flatMap((x) => [x.invite.eventId, `${x.invite.eventId}@google.com`]));
  const onDay = new Map(meetings.filter((x) => !x.practice && !x.notBoard && isDate(x.date) && x.date >= today).map((x) => [x.date, x.id]));
  const boardEmails = board.map((p) => p.email).filter(Boolean);
  const others = {};
  const strays = [];
  const seen = new Set();
  for (const email of admins) {
    try {
      const events = await eventsBetween(await tokenFor(email), email, { timeMin: new Date(now).toISOString(), timeMax: new Date(now + AHEAD_DAYS * 86_400_000).toISOString(), q: 'board', fetchImpl });
      for (const ev of events) {
        const uid = ev.iCalUID || ev.id;
        if (ours.has(ev.id) || ours.has(uid) || seen.has(uid) || !isBoardMeetingEvent(ev, boardEmails)) continue;
        seen.add(uid);
        const date = dayOf(ev);
        if (!isDate(date) || date < today) continue;
        const one = { title: String(ev.summary || '').slice(0, 200), on: email, by: normEmail(ev.organizer?.email), date, link: /^https:\/\//.test(ev.htmlLink || '') ? ev.htmlLink : '' };
        // On a meeting's day, only an invite counts (a time held on someone's own calendar, with no one invited, confuses no one)
        const invites = (ev.attendees || []).some((a) => !a.self && !a.organizer && !a.resource);
        if (onDay.has(date)) { if (invites) (others[onDay.get(date)] ||= []).push(one); } else strays.push(one);
      }
    } catch (err) {
      errors.push(`${email.split('@')[0]}’s calendar: ${String(err.message).slice(0, 200)}`);
    }
  }
  strays.sort((x, y) => x.date.localeCompare(y.date));
  const rehomed = (await rehomeStranded(env, { now })).moved;
  return writeState(env.DB, KEY, {
    version: VERSION, ok: !errors.length, configured: true, checkedAt: at,
    ...counts, handedOver, rehomed, others, strays: strays.slice(0, 20), errors,
  });
}

export const calendarStatus = (DB) => readState(DB, KEY);

// ─── Files on a meeting that isn't one ──────────────────────────────

const REHOME = 'rehome';
const REHOME_DAYS = 60;
// Papers that go with the meeting ahead of them: a budget, the financials, an agenda, a packet
const PACKET_KINDS = ['financials', 'packet', 'agenda'];
const PACKET_WORDS = /budget|financ|statement|balance sheet|\bfs\b|agenda|packet/i;
const titleKey = (name) => String(name || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/\(\d+\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The board meeting a file on a meeting dated `date` belongs with (within 60 days), or null */
export function homeFor(real, date, file) {
  const near = real.filter((x) => Math.abs(daysApart(x.date, date)) <= REHOME_DAYS);
  if (!near.length) return null;
  if (PACKET_KINDS.includes(file.kind) || PACKET_WORDS.test(file.name || '')) {
    const next = near.filter((x) => x.date >= date).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (next) return next;
  }
  // The nearest; on a tie, the one after
  return near.sort((a, b) => Math.abs(daysApart(a.date, date)) - Math.abs(daysApart(b.date, date)) || b.date.localeCompare(a.date))[0];
}

/**
 * Files on meetings that aren't board meetings (older rules filed SOARD papers onto coffees and other
 * organizations' boards, and those are off the board page now): each moves to the board meeting it belongs
 * with, up to 60 days off, the next one after for packet papers (homeFor). A copy of a file that meeting has
 * already stays put. With no board meeting that near, the file stays where it is and the email that brought it
 * waits for a meeting again: Board → Meetings lists it as waiting, and board mail reads it once a meeting is
 * added. Never deletes a file or a row; keeps staff-only as it was. Each meeting once, and again only when a
 * meeting has been added since (board_state 'rehome'). → { moved, waiting, same }
 */
export async function rehomeStranded(env, { now = Date.now() } = {}) {
  const meetings = await listMeetings(env.DB);
  const real = meetings.filter((x) => !x.notBoard && !x.practice && /^\d{4}-\d{2}-\d{2}$/.test(x.date || ''));
  const newest = meetings.reduce((a, x) => (String(x.createdAt || '') > a ? String(x.createdAt) : a), '');
  const state = await readState(env.DB, REHOME);
  const done = { ...(state.meetings || {}) };
  const out = { moved: 0, waiting: 0, same: 0 };
  const at = new Date(now).toISOString();
  for (const m of meetings.filter((x) => x.notBoard && x.files.length)) {
    const rec = done[m.id] || null;
    const again = !rec || String(rec.at) < newest;
    const same = [...(rec?.same || [])];
    const waiting = [];
    const newlyWaiting = [];
    for (const f of m.files) {
      if (same.includes(f.id)) continue;
      if (rec?.waiting?.includes(f.id) && !again) { waiting.push(f.id); continue; }
      const home = homeFor(real, m.date, f);
      if (!home) { waiting.push(f.id); if (!rec?.waiting?.includes(f.id)) newlyWaiting.push(f.name); continue; }
      if (home.files.some((x) => x.kind === f.kind && titleKey(x.name) === titleKey(f.name))) { same.push(f.id); out.same += 1; continue; }
      await env.DB.prepare("UPDATE board_files SET owner_id = ? WHERE id = ? AND owner_type = 'meeting' AND owner_id = ?").bind(home.id, f.id, m.id).run();
      home.files.push(f);
      out.moved += 1;
    }
    // The emails that brought them wait for a meeting again (the table is board mail's: absent when it never ran)
    if (newlyWaiting.length) {
      const said = `waiting for a board meeting near it: ${newlyWaiting.join(', ')} (it had gone onto ${meetingName(m)}, which isn’t a SOARD board meeting)`;
      try {
        await env.DB.prepare("UPDATE board_mail SET outcome = 'waiting', result = ?, at = ? WHERE meeting_id = ? AND COALESCE(outcome, '') NOT IN ('waiting', 'started', 'duplicate')")
          .bind(said.slice(0, 1000), at, m.id).run();
      } catch { /* board mail never ran here */ }
    }
    out.waiting += waiting.length;
    done[m.id] = { at, waiting, same };
  }
  await writeState(env.DB, REHOME, { at, meetings: done });
  return out;
}

const daysApart = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);

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
