/**
 * A board meeting's calendar invite, from Holly's calendar, with Google Meet
 * ===========================================================================
 * "Send the invite" in Board puts the meeting on the organizer's Google
 * calendar (Settings → Invites come from; the president among the founders
 * until saved) and Google sends the invitations:
 *   - guests: every active board member with an email on People → Board,
 *     and the Board area's admins (Holly and Peter)
 *   - Google Meet as the video call, with transcripts turned on when Google
 *     allows it (the Meet API's meetings.space.settings scope; Board says so
 *     when it doesn't)
 *   - the place and address when the meeting has them; added later, or
 *     changed, the invite updates two minutes after the typing stops
 *     (one email from Google to every guest, not one per word)
 * A meeting that came from the organizer's calendar (Holly already sent its
 * invite) gets that same event updated, never a second invite: the board
 * members missing from it are added, and so are Meet and the place.
 * The calendar stays where the day and time change (./_board-calendar.js).
 *
 * Writes only to the organizer's own calendar, through the site's service
 * account (GOOGLE_CALENDAR_KEY, domain-wide delegation, calendar.events).
 */

import { accessToken, eventIdFor, parseServiceAccount } from './_google-calendar.js';
import { boardAdmins, activeBoard, peopleRows, readSettings, readState, writeState, normEmail } from './_board-roles.js';
import { getMeeting, patchMeeting, SITE } from './_board.js';
import { meetingName, timeRange, longDate } from '../../public/admin/board-shared.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const MEET_API = 'https://meet.googleapis.com/v2';
export const MEET_SETTINGS_SCOPE = 'https://www.googleapis.com/auth/meetings.space.settings';
const TZ = 'America/New_York';

/** The service account's Google Cloud project (for the APIs it must have turned on), from its key */
export function projectOf(env) {
  try { const k = parseServiceAccount(env.GOOGLE_CALENDAR_KEY); return String(k.project_id || (k.client_email || '').split('@')[1]?.split('.')[0] || ''); } catch { return ''; }
}

/** Who sends the invite: Settings, else the founder who's president, else the first admin */
export async function organizerFor(DB) {
  const s = await readSettings(DB);
  const admins = await boardAdmins(DB, s);
  if (s.invitesFrom && admins.includes(normEmail(s.invitesFrom))) return normEmail(s.invitesFrom);
  const people = await peopleRows(DB);
  const president = people.find((p) => p.group !== 'board' && p.role === 'founder' && /president/i.test(p.title || '') && !/vice/i.test(p.title || ''));
  const first = president && String(president.name).toLowerCase().match(/[a-z]+/)?.[0];
  return admins.find((e) => first && e.startsWith(`${first}@`)) || admins[0] || '';
}

/** Everyone the invite goes to: the active board (with an email) and the Board area's admins */
export async function guestsFor(DB) {
  const [board, admins] = await Promise.all([activeBoard(DB), boardAdmins(DB)]);
  return [...new Set([...board.map((p) => p.email).filter(Boolean), ...admins])];
}

async function gcal(token, method, path, body, fetchImpl) {
  const res = await fetchImpl(`${CAL_API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`Google Calendar answered ${res.status}: ${data?.error?.message || ''}`.trim()), { status: res.status });
  return data;
}

const placeOf = (m) => [m.location, m.address].filter(Boolean).join(', ');
const whenOf = (m) => `${m.date} ${m.start || ''}-${m.end || ''}`;
const isTbd = (s) => /^(tbd|tba|to be (determined|announced|confirmed))?\.?$/i.test(String(s || '').trim());

function times(m) {
  if (!m.start) return { start: { date: m.date }, end: { date: m.date } };
  const end = m.end || `${String(Math.min(23, Number(m.start.slice(0, 2)) + 2)).padStart(2, '0')}${m.start.slice(2)}`;
  return { start: { dateTime: `${m.date}T${m.start}:00`, timeZone: TZ }, end: { dateTime: `${m.date}T${end}:00`, timeZone: TZ } };
}
const describe = (m) => `The agenda, the packet and the minutes are on the board page: ${SITE}/board (sign in with the email this invite came to).`;

/** Turn on transcripts for the event's Meet (Meet REST API). → 'on' | 'needs-setup' | 'error' */
async function transcriptOn(env, organizer, meetCode, fetchImpl, now) {
  if (!meetCode) return { transcript: 'error', error: 'No Meet code on the event' };
  let token;
  try { token = await accessToken(env, organizer, { fetchImpl, now, scope: MEET_SETTINGS_SCOPE }); } catch (err) {
    return { transcript: 'needs-setup', error: /unauthorized_client|access_denied/i.test(err.message) ? 'Google Admin hasn’t allowed meetings.space.settings yet' : String(err.message).slice(0, 200) };
  }
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${MEET_API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`Google Meet answered ${res.status}: ${data?.error?.message || ''}`.trim()), { status: res.status });
    return data;
  };
  try {
    const space = await call('GET', `/spaces/${encodeURIComponent(meetCode)}`);
    await call('PATCH', `/${space.name}?updateMask=config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration`, { config: { artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: 'ON' } } } });
    return { transcript: 'on', error: '' };
  } catch (err) {
    const setup = err.status === 403 && /has not been used|is disabled|insufficient|permission/i.test(err.message);
    return { transcript: setup ? 'needs-setup' : 'error', error: String(err.message).slice(0, 300) };
  }
}

/**
 * Send the meeting's invite, or bring the one it has (Board's, or the
 * organizer's own from the calendar) up to date: guests, Meet, the place,
 * and for Board's own invite the day and time. → the meeting
 */
export async function sendInvite(env, id, { fetchImpl = fetch, now = Date.now(), by = '' } = {}) {
  if (!env.GOOGLE_CALENDAR_KEY) throw Object.assign(new Error('Google Calendar isn’t set up (GOOGLE_CALENDAR_KEY)'), { status: 503 });
  const m = await getMeeting(env.DB, id);
  if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
  if (!m.date) throw Object.assign(new Error('Give the meeting a date first'), { status: 400 });
  // Holly's own event (the meeting came from her calendar), or Board's earlier invite, or a new one
  const theirs = m.calendar && !m.calendar.gone && m.calendar.eventId && m.calendar.organizer ? { eventId: m.calendar.eventId, organizer: m.calendar.organizer } : null;
  const admins = await boardAdmins(env.DB);
  if (theirs && !admins.includes(theirs.organizer)) {
    throw Object.assign(new Error(`This meeting’s invite comes from ${theirs.organizer}, whose calendar Board can’t change. Ask them to add the board, or delete that event and send Board’s invite.`), { status: 409 });
  }
  const organizer = theirs?.organizer || m.invite?.organizer || await organizerFor(env.DB);
  if (!organizer) throw Object.assign(new Error('No one to send it from: add yourself in Board → Settings'), { status: 409 });
  const token = await accessToken(env, organizer, { fetchImpl, now });
  const cal = `/calendars/${encodeURIComponent(organizer)}/events`;
  const eventId = theirs?.eventId || m.invite?.eventId || eventIdFor('board', m.id);
  // Board invited the board, then the meeting turned up on the organizer's own calendar too: one invite, theirs
  if (theirs && m.invite?.eventId && m.invite.eventId !== eventId) {
    try {
      const was = m.invite.organizer === organizer ? token : await accessToken(env, m.invite.organizer, { fetchImpl, now });
      await gcal(was, 'DELETE', `/calendars/${encodeURIComponent(m.invite.organizer)}/events/${encodeURIComponent(m.invite.eventId)}?sendUpdates=all`, null, fetchImpl);
    } catch (err) { if (err.status !== 404 && err.status !== 410) throw err; }
  }
  const prior = m.invite?.eventId === eventId ? m.invite : null;
  const guests = await guestsFor(env.DB);
  let existing = null;
  try { existing = await gcal(token, 'GET', `${cal}/${encodeURIComponent(eventId)}`, null, fetchImpl); } catch (err) { if (err.status !== 404 && err.status !== 410) throw err; }
  const ours = !theirs; // Board's own invite: Board sets its day and time too
  const have = new Set((existing?.attendees || []).map((a) => normEmail(a.email)));
  const attendees = [...(existing?.attendees || []), ...guests.filter((e) => !have.has(e) && e !== organizer).map((email) => ({ email }))];
  const place = placeOf(m);
  const title = /soard/i.test(meetingName(m)) ? meetingName(m) : `SOARD ${meetingName(m)}`;
  const body = {
    attendees,
    ...(place && (ours || isTbd(existing?.location)) ? { location: place } : {}),
    ...(existing?.hangoutLink ? {} : { conferenceData: { createRequest: { requestId: `board-${m.id}-${now}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }),
    ...(ours ? { summary: title, ...times(m) } : {}),
    ...(!existing?.description ? { description: describe(m) } : {}),
    guestsCanSeeOtherGuests: true,
  };
  // A deleted event keeps its id at Google (as cancelled): it's brought back, never made again
  const ev = existing
    ? await gcal(token, 'PATCH', `${cal}/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=all`, existing.status === 'cancelled' ? { status: 'confirmed', ...times(m), summary: title, ...body } : body, fetchImpl)
    : await gcal(token, 'POST', `${cal}?conferenceDataVersion=1&sendUpdates=all`, { id: eventId, ...times(m), summary: title, ...body }, fetchImpl);
  const meet = ev.hangoutLink || '';
  const code = ev.conferenceData?.conferenceId || (meet.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/) || [])[1] || '';
  const t = meet && !(prior?.transcript === 'on' && prior.meet === meet) ? await transcriptOn(env, organizer, code, fetchImpl, now) : { transcript: prior?.transcript || '', error: prior?.error || '' };
  const at = new Date(now).toISOString();
  const invite = {
    eventId: ev.id || eventId, organizer, sentAt: prior?.sentAt || at, updatedAt: at, meet, guests: (ev.attendees || attendees).length,
    emails: (ev.attendees || attendees).map((a) => normEmail(a.email)), place: ev.location || place, when: whenOf(m), ...t,
    replies: prior?.replies || {},
  };
  // Google Meet is the meeting's video call from now on (onto the meeting as it is now: a save made meanwhile stays)
  return patchMeeting(env.DB, id, (cur) => ({ ...cur, invite, video: meet || cur.video }));
}

const SETTLE_MS = 2 * 60 * 1000;
const PENDING = 'invite-pending';
/** What changed since the invite went out: its place, or (Board's own invite) its day or time; '' when nothing */
const changeOf = (m) => {
  if (!m?.invite?.eventId) return '';
  const place = placeOf(m) && placeOf(m) !== m.invite.place ? placeOf(m) : '';
  const when = !m.calendar && whenOf(m) !== m.invite.when ? whenOf(m) : '';
  return place || when ? `${place}|${when}` : '';
};

/**
 * After a save: a new place (or day or time) for an invite that's out is
 * noted, and goes to Google once it has stood for two minutes
 * (maybeRefreshInvites, on the heartbeat), so a place typed a word at a time
 * sends the board Google's update email once. Never throws.
 */
export async function noteInviteChange(env, m, { now = Date.now() } = {}) {
  try {
    const key = changeOf(m);
    const pending = await readState(env.DB, PENDING);
    if (!key) {
      if (pending[m.id]) { delete pending[m.id]; await writeState(env.DB, PENDING, pending); }
      return;
    }
    if (pending[m.id]?.key === key) return;
    await writeState(env.DB, PENDING, { ...pending, [m.id]: { key, at: new Date(now).toISOString() } });
  } catch (err) {
    console.error('[board-invite] note', err.message);
  }
}

/** The heartbeat: each change that has settled, onto its invite. → the meeting ids updated. Never throws. */
export async function maybeRefreshInvites(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return [];
    const due = Object.entries(await readState(env.DB, PENDING)).filter(([, p]) => now - Date.parse(p.at) >= SETTLE_MS);
    if (!due.length) return [];
    const sent = [];
    for (const [id] of due) {
      try {
        if (changeOf(await getMeeting(env.DB, id))) { await sendInvite(env, id, { fetchImpl, now }); sent.push(id); }
      } catch (err) {
        console.error('[board-invite]', id, err.message);
      }
    }
    // Only what was looked at goes: a change noted meanwhile waits its turn
    const latest = await readState(env.DB, PENDING);
    for (const [id, p] of due) if (latest[id]?.key === p.key) delete latest[id];
    await writeState(env.DB, PENDING, latest);
    return sent;
  } catch (err) {
    console.error('[board-invite] refresh', err.message);
    return [];
  }
}

/** Who's on the invite but not the board any more, and who's on the board but not the invite */
export async function inviteGaps(DB, m) {
  if (!m?.invite) return { missing: [], count: 0 };
  const guests = await guestsFor(DB);
  const on = new Set(m.invite.emails || []);
  return { missing: guests.filter((e) => !on.has(e) && e !== m.invite.organizer), count: on.size };
}

