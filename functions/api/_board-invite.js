/**
 * A board meeting's calendar invite, from Holly's calendar, with Google Meet
 * ===========================================================================
 * "Send the invite" in Board puts the meeting on the organizer's Google
 * calendar (Board → Members: whose calendar invites come from; the president
 * among the founders until one is chosen) and Google sends the invitations:
 *   - guests: every active board member with an email on People → Board,
 *     and the Board area's admins (Holly and Peter)
 *   - Google Meet as the video call (no transcripts: SOARD's Google plan
 *     doesn't have them)
 *   - the place and address when the meeting has them; added later, or
 *     changed, the invite updates two minutes after the typing stops
 *     (one email from Google to every guest, not one per word)
 *   - notes (plain text): the way to the meeting's page, where the agenda
 *     and every document are (inviteNotes in ./_board.js); when only the
 *     notes change, they update without Google emailing anyone
 * Meetings are added in Board only, and Board is where their day, time and
 * place change (Peter, Nov 2 2026): a change goes onto the invite, and Google
 * emails the guests once. A meeting deleted in Board takes its invite off
 * the calendar, and Google tells the guests (cancelInvite).
 * A meeting older code took from the organizer's calendar keeps that event
 * as its invite: Board updates it the same way, and the organizer's own
 * notes stay above Board's. The answers come back by ./_board-calendar.js.
 *
 * Writes only to the organizer's own calendar, through the site's service
 * account (GOOGLE_CALENDAR_KEY, domain-wide delegation, calendar.events).
 */

import { accessToken, eventIdFor, parseServiceAccount } from './_google-calendar.js';
import { boardAdmins, activeBoard, peopleRows, readSettings, readState, writeState, normEmail } from './_board-roles.js';
import { getMeeting, listMeetings, patchMeeting, inviteNotes, inviteTitle, NOTES_START, OLD_NOTES_STARTS } from './_board.js';
import { meetingName, timeRange, longDate, todayEastern, isDate } from '../../public/admin/board-shared.js';
import { isEmail } from './_broadcast-notify.js';
import { easternParts } from './_reveals.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const TZ = 'America/New_York';

/** The service account's Google Cloud project (for the APIs it must have turned on), from its key */
export function projectOf(env) {
  try { const k = parseServiceAccount(env.GOOGLE_CALENDAR_KEY); return String(k.project_id || (k.client_email || '').split('@')[1]?.split('.')[0] || ''); } catch { return ''; }
}

/** Who sends the invite: the admin chosen on Board → Members, else the founder who's president, else the first admin */
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

export const placeOf = (m) => [m.location, m.address].filter(Boolean).join(', ');
const whenOf = (m) => `${m.date} ${m.start || ''}-${m.end || ''}`;

const CALL_LINK = /^https:\/\/\S*(zoom\.us|teams\.microsoft|teams\.live|webex)\S*$/i;
const dayAfter = (date) => new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

function times(m) {
  // An all-day event ends the day after (Google refuses one that ends the day it starts)
  if (!m.start) return { start: { date: m.date }, end: { date: dayAfter(m.date) } };
  const end = m.end || `${String(Math.min(23, Number(m.start.slice(0, 2)) + 2)).padStart(2, '0')}${m.start.slice(2)}`;
  return { start: { dateTime: `${m.date}T${m.start}:00`, timeZone: TZ }, end: { dateTime: `${m.date}T${end}:00`, timeZone: TZ } };
}

/** A start or end on an event, as "YYYY-MM-DDTHH:MM" in Atlanta (or "YYYY-MM-DD" all day): as Board writes it, or as Google answers with an offset */
function slotOf(t) {
  if (t?.date) return t.date;
  const s = String(t?.dateTime || '');
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(s)) return s.slice(0, 16);
  const p = easternParts(s);
  return p ? `${p.date}T${p.time || '00:00'}` : '';
}

/**
 * What someone changed on the invite in Google Calendar since Board last put it there: its day or time, or the place
 * Board gave it. '' when it's as Board left it (a change typed in Board and not sent yet isn't one: the event is
 * compared with what Board last sent, never with the meeting)
 */
export function driftOf(ev, m) {
  const inv = m?.invite;
  if (!ev?.start || !inv?.when) return '';
  const [date, span = ''] = String(inv.when).split(' ');
  const [start = '', end = ''] = span.split('-');
  const want = times({ date, start, end });
  const when = slotOf(ev.start) !== slotOf(want.start) || slotOf(ev.end) !== slotOf(want.end) ? `${slotOf(ev.start)}/${slotOf(ev.end)}` : '';
  const place = placeOf(m) && String(ev.location || '') !== (inv.location || inv.place) ? String(ev.location || '') : '';
  return when || place ? `${when}|${place}`.slice(0, 200) : '';
}

/**
 * An invite's notes with Board's part brought up to date: Board's own invite
 * is all Board's; on the organizer's own event, what they wrote stays, and
 * Board's part (from NOTES_START on) follows it. Google keeps notes edited in
 * Calendar as HTML, so Board's part goes in the same way there.
 */
export function withNotes(existing, notes) {
  const was = String(existing || '');
  const html = /<\/?(br|p|div|span|b|i|u|ul|ol|li|a)\b/i.test(was);
  // Board's part as it reads now, or as it read before (replaced the same way, never added twice)
  const at = [NOTES_START, ...OLD_NOTES_STARTS].map((k) => was.indexOf(k)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  const before = (at >= 0 ? was.slice(0, at) : was).replace(/(\s|&nbsp;|<br\s*\/?>|<(p|div|span)[^>]*>)+$/i, '');
  const ours = html ? notes.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>') : notes;
  return before ? `${before}${html ? '<br><br>' : '\n\n'}${ours}` : ours;
}

/**
 * The organizer's own notes without another call's joining details, since Google Meet is the board's call (Peter,
 * Nov 2 2026): Teams' block (between its two long rules), a line that's only a Teams, Zoom or Webex link, and a
 * "Teams link" in their words is the Google Meet link now
 */
export function withoutCall(text) {
  return String(text || '')
    .replace(/_{60,}(?:\s|&nbsp;|<br\s*\/?>|<\/?(?:p|div|span|b|strong|font)[^>]*>)*Microsoft Teams[\s\S]*?_{60,}/gi, '')
    .replace(/^[ \t]*https:\/\/\S*(?:zoom\.us|teams\.microsoft|teams\.live|webex)\S*[ \t]*$/gim, '')
    .replace(/\b(?:Microsoft )?Teams link\b/g, 'Google Meet link')
    .replace(/\n{3,}/g, '\n\n');
}
/** A short fingerprint of what Board puts on the invite quietly (its name and its notes), to see when either has changed since */
const notesKey = (m) => {
  let h = 0x811c9dc5;
  for (const c of `${inviteTitle(m)}\n${inviteNotes(m)}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
};

const meetCodeOf = (ev) => ev?.conferenceData?.conferenceId || (String(ev?.hangoutLink || '').match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/) || [])[1] || '';

/** Google sometimes answers a new Meet as still being made: asked again (three times, a second apart) until it has its link */
async function meetReady(token, path, ev, fetchImpl) {
  for (let i = 0; i < 3 && !ev?.hangoutLink && ev?.conferenceData?.createRequest?.status?.statusCode === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ev = await gcal(token, 'GET', path, null, fetchImpl);
  }
  return ev;
}

/**
 * Send the meeting's invite, or bring the one it has (Board's, or the
 * organizer's own from the calendar) up to date: guests, Meet, the place,
 * and for Board's own invite the day and time. → the meeting
 */
export async function sendInvite(env, id, { fetchImpl = fetch, now = Date.now(), by = '', quiet = false } = {}) {
  if (!env.GOOGLE_CALENDAR_KEY) throw Object.assign(new Error('Google Calendar isn’t set up (GOOGLE_CALENDAR_KEY)'), { status: 503 });
  const m = await getMeeting(env.DB, id);
  if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
  if (!m.date) throw Object.assign(new Error('Give the meeting a date first'), { status: 400 });
  // Board's invite (sent before, or new), from whoever it came from
  const organizer = m.invite?.organizer || await organizerFor(env.DB);
  if (!organizer) throw Object.assign(new Error('No one to send it from: add yourself in Board → Members'), { status: 409 });
  const token = await accessToken(env, organizer, { fetchImpl, now });
  const cal = `/calendars/${encodeURIComponent(organizer)}/events`;
  const eventId = m.invite?.eventId || eventIdFor('board', m.id);
  const prior = m.invite;
  const guests = await guestsFor(env.DB);
  let existing = null;
  try { existing = await gcal(token, 'GET', `${cal}/${encodeURIComponent(eventId)}`, null, fetchImpl); } catch (err) { if (err.status !== 404 && err.status !== 410) throw err; }
  // Google Meet is every board meeting's call (Peter, Nov 2 2026): a Teams or Zoom call on the organizer's event comes
  // off it first, without emailing anyone, so Meet replaces it instead of sitting beside it (Google's docs don't say a
  // Meet request alone swaps one out). Their notes lose its joining details below. Should Google refuse to take it off,
  // the invite still goes out with Meet asked for, as it did before, rather than not at all
  if (existing && !existing.hangoutLink && existing.conferenceData && existing.status !== 'cancelled') {
    try {
      existing = await gcal(token, 'PATCH', `${cal}/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`, { conferenceData: null }, fetchImpl);
    } catch (err) { if (err.status !== 400 && err.status !== 403) throw err; }
  }
  // Board made the event, so its notes are all Board's; on the organizer's own event (taken from their calendar before
  // Nov 2 2026), their words stay above Board's
  const ours = eventId === eventIdFor('board', m.id);
  const have = new Set((existing?.attendees || []).map((a) => normEmail(a.email)));
  const added = guests.filter((e) => !have.has(e) && e !== organizer);
  const attendees = [...(existing?.attendees || []), ...added.map((email) => ({ email }))];
  // Only the agenda changed and nobody's new: the invite's notes change without Google emailing the board
  const send = quiet && existing && !added.length ? 'none' : 'all';
  const notes = ours ? inviteNotes(m) : withNotes(withoutCall(existing?.description), inviteNotes(m));
  const place = placeOf(m);
  // Its name says which meeting and how to come, on the organizer's own event too (Peter, Nov 2 2026)
  const title = inviteTitle(m);
  // A Teams or Zoom link written as the place: Google Meet is the call now, so the place is the place (or nothing)
  const callAsPlace = !existing?.hangoutLink && CALL_LINK.test(String(existing?.location || '').trim());
  // The day, time and place are Board's, on the organizer's own event too (an event's own place stays while Board has none)
  const body = {
    attendees,
    ...(place ? { location: place } : callAsPlace ? { location: '' } : {}),
    ...(existing?.hangoutLink ? {} : { conferenceData: { createRequest: { requestId: `board-${m.id}-${now}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }),
    summary: title,
    ...times(m),
    ...(notes !== (existing?.description || '') ? { description: notes } : {}),
    guestsCanSeeOtherGuests: true,
  };
  // A deleted event keeps its id at Google (as cancelled): it's brought back, never made again
  const ev = await meetReady(token, `${cal}/${encodeURIComponent(eventId)}`, existing
    ? await gcal(token, 'PATCH', `${cal}/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=${send}`, existing.status === 'cancelled' ? { status: 'confirmed', ...times(m), summary: title, ...body } : body, fetchImpl)
    : await gcal(token, 'POST', `${cal}?conferenceDataVersion=1&sendUpdates=all`, { id: eventId, ...times(m), summary: title, ...body }, fetchImpl), fetchImpl);
  const meet = ev.hangoutLink || '';
  const at = new Date(now).toISOString();
  // Who's on it now and how they answered, by board member, as Google has it: someone just added is invited at once,
  // not only once the calendar is next read (up to an hour)
  const bySlug = Object.fromEntries((await activeBoard(env.DB)).filter((p) => p.email).map((p) => [normEmail(p.email), p.slug]));
  const replies = {};
  for (const a of ev.attendees || attendees) {
    const slug = bySlug[normEmail(a.email)];
    if (slug) replies[slug] = ['accepted', 'declined', 'tentative'].includes(a.responseStatus) ? a.responseStatus : 'invited';
  }
  const on = new Set((ev.attendees || attendees).map((a) => normEmail(a.email)));
  const who = Object.fromEntries(Object.entries(bySlug).filter(([e]) => on.has(e)).map(([e, slug]) => [slug, e]));
  const invite = {
    eventId: ev.id || eventId, organizer, sentAt: prior?.sentAt || at, updatedAt: at, meet, guests: (ev.attendees || attendees).length,
    emails: (ev.attendees || attendees).map((a) => normEmail(a.email)), place: place || ev.location || '', location: ev.location || '', when: whenOf(m), notes: notesKey(m),
    replies, who,
  };
  // Google Meet is the meeting's video call from now on (onto the meeting as it is now: a save made meanwhile stays)
  return patchMeeting(env.DB, id, (cur) => ({ ...cur, invite, inviteGone: '', video: meet || cur.video }));
}

/**
 * A meeting deleted in Board: its invite comes off the calendar, and Google tells everyone on it. Nothing for a
 * meeting already held (its invite is a record) or never invited. → whether an invite was cancelled
 */
export async function cancelInvite(env, m, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!m?.invite?.eventId || !m.invite.organizer || m.practice || !m.date || m.date < todayEastern(now)) return false;
  if (!env.GOOGLE_CALENDAR_KEY) throw Object.assign(new Error('Google Calendar isn’t set up (GOOGLE_CALENDAR_KEY), so its invite can’t come off the calendar'), { status: 503 });
  const token = await accessToken(env, m.invite.organizer, { fetchImpl, now });
  try {
    await gcal(token, 'DELETE', `/calendars/${encodeURIComponent(m.invite.organizer)}/events/${encodeURIComponent(m.invite.eventId)}?sendUpdates=all`, null, fetchImpl);
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) throw err;
  }
  return true;
}

const SETTLE_MS = 2 * 60 * 1000;
const PENDING = 'invite-pending';
/** What changed since the invite went out: its place, its day or time, or its name and notes; '' when nothing (or once it's held) */
const changeOf = (m) => {
  if (!m?.invite?.eventId || !m.date || m.date < todayEastern()) return '';
  const loud = loudChange(m);
  const notes = notesKey(m) !== m.invite.notes ? notesKey(m) : '';
  return loud || notes ? `${loud}|${notes}` : '';
};
/** A change the board is emailed about (the place, the day or time); the name and notes alone aren't one */
const loudChange = (m) => {
  const place = placeOf(m) && placeOf(m) !== m.invite.place ? placeOf(m) : '';
  const when = whenOf(m) !== m.invite.when ? whenOf(m) : '';
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
    const reworded = await rewordInvites(env, { fetchImpl, now });
    const due = Object.entries(await readState(env.DB, PENDING)).filter(([, p]) => now - Date.parse(p.at) >= SETTLE_MS);
    if (!due.length) return reworded;
    const sent = [...reworded];
    for (const [id] of due) {
      try {
        const m = await getMeeting(env.DB, id);
        if (changeOf(m)) { await sendInvite(env, id, { fetchImpl, now, quiet: !loudChange(m) }); sent.push(id); }
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

const FOLLOW = 'invite-follow';
const FOLLOW_MS = 5 * 60 * 1000;

/**
 * Who an invite needs now, for the board with an address on file ([{ slug, email }], lower case): `add`, and `drop`.
 * invite.who is who Board put on it, so only they ever come off: a guest added by hand in Google stays. And someone
 * Board put on who was taken off by hand isn't put back.
 */
export function followOf(invite, board) {
  const had = invite?.who || {};
  const on = new Set((invite?.emails || []).map(normEmail));
  const wanted = new Set(board.map((p) => p.email));
  return {
    add: board.filter((p) => !on.has(p.email) && had[p.slug] !== p.email && p.email !== normEmail(invite?.organizer)).map((p) => p.email),
    drop: [...new Set(Object.values(had))].filter((e) => !wanted.has(e) && on.has(e)),
  };
}
/** Who of the board an invite has now (slug → email), keeping anyone taken off it by hand so they aren't put back */
const whoOf = (invite, board, emails) => {
  const on = new Set(emails);
  return Object.fromEntries(board.filter((p) => on.has(p.email) || invite?.who?.[p.slug] === p.email).map((p) => [p.slug, p.email]));
};
/** A meeting's attendance list for the board as it is now, or null when it already is: anyone marked or from an old agenda stays */
export function followRoll(attendance, board) {
  const here = new Set(board.map((p) => p.slug));
  const had = new Set((attendance || []).map((a) => a.slug).filter(Boolean));
  const stays = (a) => a.kind !== 'board' || !a.slug || here.has(a.slug) || !!a.status;
  const fresh = board.filter((p) => !had.has(p.slug)).map((p) => ({ slug: p.slug, name: p.name, org: p.organization || '', kind: 'board' }));
  if (!fresh.length && (attendance || []).every(stays)) return null;
  const list = (attendance || []).filter(stays);
  return [...list.filter((a) => a.kind === 'board'), ...fresh, ...list.filter((a) => a.kind !== 'board')];
}

/**
 * The guest list alone, on an invite that's there: a change to the list is all Google sees, so only who came on or went
 * off hears about it (adding proven Oct 19 2026, see the guest-add note). Nothing else on the invite is touched, and an
 * invite deleted in Google isn't brought back. → the guest list as Google has it, or null when the invite is gone
 */
async function changeGuests(env, m, { add, drop }, { fetchImpl, now }) {
  const { organizer, eventId } = m.invite;
  const token = await accessToken(env, organizer, { fetchImpl, now });
  const path = `/calendars/${encodeURIComponent(organizer)}/events/${encodeURIComponent(eventId)}`;
  let ev;
  try { ev = await gcal(token, 'GET', path, null, fetchImpl); } catch (err) { if (err.status === 404 || err.status === 410) return null; throw err; }
  if (!ev || ev.status === 'cancelled') return null;
  const gone = new Set(drop);
  const kept = (ev.attendees || []).filter((a) => !gone.has(normEmail(a.email)));
  const have = new Set(kept.map((a) => normEmail(a.email)));
  const attendees = [...kept, ...add.filter((e) => !have.has(e)).map((email) => ({ email }))];
  const out = await gcal(token, 'PATCH', `${path}?sendUpdates=all`, { attendees }, fetchImpl);
  return (out.attendees || attendees).map((a) => normEmail(a.email));
}

/**
 * The invites ahead follow People → Board (Peter, Nov 5 2026), now that they go out a year early: someone new goes on
 * every one and Google sends it to them, someone who left comes off them, and a new address replaces the old one. The
 * attendance lists follow too, or a new member would be missing from the roll call and the quorum. A meeting under way
 * is left as it is. A list that reads empty, or that would take over half of an invite's board off at once, is taken
 * for a bad read: nothing comes off, and Site → Automations says so. Every 5 minutes at most. Never throws.
 */
export async function maybeFollowBoard(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB) return null;
    const state = await readState(env.DB, FOLLOW);
    if (state.at && now - Date.parse(state.at) < FOLLOW_MS) return null;
    const at = new Date(now).toISOString();
    await writeState(env.DB, FOLLOW, { ...state, at });
    const everyone = await activeBoard(env.DB);
    if (!everyone.length) return null;
    const board = everyone.filter((p) => isEmail(normEmail(p.email))).map((p) => ({ slug: p.slug, email: normEmail(p.email) }));
    const today = todayEastern(now);
    const ahead = (await listMeetings(env.DB)).filter((m) => isDate(m.date) && m.date >= today && !m.notBoard && !m.practice && !m.live?.startedAt && !m.live?.endedAt);
    const did = { added: 0, removed: 0, held: 0, failed: 0 };
    let error = '';
    for (const m of ahead) {
      if (followRoll(m.attendance, everyone)) await patchMeeting(env.DB, m.id, (cur) => ({ ...cur, attendance: followRoll(cur.attendance, everyone) || cur.attendance }), { by: 'Board' });
      if (!m.invite?.eventId || !env.GOOGLE_CALENDAR_KEY) continue;
      const plan = followOf(m.invite, board);
      if (plan.drop.length > Object.keys(m.invite.who || {}).length / 2) { did.held += 1; continue; }
      if (!plan.add.length && !plan.drop.length) {
        const who = whoOf(m.invite, board, m.invite.emails || []);
        if (JSON.stringify(who) !== JSON.stringify(m.invite.who || {})) await patchMeeting(env.DB, m.id, (cur) => (cur.invite?.eventId === m.invite.eventId ? { ...cur, invite: { ...cur.invite, who } } : cur), { by: 'Board' });
        continue;
      }
      try {
        const emails = await changeGuests(env, m, plan, { fetchImpl, now });
        if (!emails) continue;
        const bySlug = new Map(board.map((p) => [p.slug, p.email]));
        await patchMeeting(env.DB, m.id, (cur) => {
          if (cur.invite?.eventId !== m.invite.eventId) return cur;
          const replies = Object.fromEntries(Object.entries(cur.invite.replies || {}).filter(([slug]) => bySlug.has(slug)));
          for (const p of board) if (emails.includes(p.email) && !replies[p.slug]) replies[p.slug] = 'invited';
          return { ...cur, invite: { ...cur.invite, emails, guests: emails.length, replies, who: whoOf(cur.invite, board, emails), updatedAt: at } };
        }, { by: 'Board' });
        did.added += plan.add.length;
        did.removed += plan.drop.length;
      } catch (err) {
        did.failed += 1;
        error = String(err.message).slice(0, 200);
        console.error('[board-invite] follow', m.id, err.message);
      }
    }
    const moved = did.added || did.removed;
    await writeState(env.DB, FOLLOW, { ...(await readState(env.DB, FOLLOW)), at, held: did.held, error, ...(moved ? { lastChangeAt: at, lastAdded: did.added, lastRemoved: did.removed } : {}) });
    return did;
  } catch (err) {
    console.error('[board-invite] follow', err.message);
    return null;
  }
}

// Board's own words on the invite (inviteNotes in ./_board.js). Raised when they change, so every invite still ahead
// gets them once, quietly, on the next heartbeat, without anyone saving a meeting.
// 2: the short link, no "Your reply to this invite shows on the board page", and a name that says which meeting and
// how to come, on the organizer's own event too (Peter, Nov 2 2026). 3: the name without "(in person or Google Meet)"
const NOTES_VERSION = 3;
const REWORDED = 'invite-notes';
/** Each invite still ahead whose only change is Board's words: updated without Google emailing anyone. → the meeting ids */
async function rewordInvites(env, { fetchImpl, now }) {
  if ((await readState(env.DB, REWORDED)).version === NOTES_VERSION) return [];
  const today = todayEastern(now);
  const sent = [];
  let failed = 0;
  for (const m of (await listMeetings(env.DB)).filter((x) => x.date >= today && changeOf(x) && !loudChange(x))) {
    try { await sendInvite(env, m.id, { fetchImpl, now, quiet: true }); sent.push(m.id); } catch (err) { failed += 1; console.error('[board-invite] reword', m.id, err.message); }
  }
  // One that Google turned away is tried again on the next heartbeat
  if (!failed) await writeState(env.DB, REWORDED, { version: NOTES_VERSION, at: new Date(now).toISOString() });
  return sent;
}

const CHECK = 'invite-check';
// 2: who joined by Meet (the attendance) is checked too; 3: transcripts aren't (SOARD's Google plan has none)
const CHECK_VERSION = 3;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The invite's Google parts, proved without inviting anyone: a private event
 * on the organizer's calendar with Google Meet (no guests, no emails, no
 * reminders), its attendance readable (./_board-attendance.js), then the
 * event deleted.
 * → { ok (all of it), calendar, meet, attendance ('ok' | 'needs-setup' | 'error'), error, attendanceError, leftover }
 */
export async function checkInvites(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const organizer = await organizerFor(env.DB);
  const out = { ok: false, organizer, calendar: '', meet: '', attendance: '', error: '', attendanceError: '', leftover: '' };
  if (!organizer) return { ...out, error: 'No one to send invites from: add one of Board’s admins on Board → Members' };
  let token;
  try { token = await accessToken(env, organizer, { fetchImpl, now }); } catch (err) { return { ...out, calendar: 'error', error: String(err.message).slice(0, 300) }; }
  const cal = `/calendars/${encodeURIComponent(organizer)}/events`;
  const id = eventIdFor('boardcheck', now);
  const day = todayEastern(now + 86400000);
  let made = false;
  try {
    const ev = await meetReady(token, `${cal}/${id}`, await gcal(token, 'POST', `${cal}?conferenceDataVersion=1&sendUpdates=none`, {
      id, summary: 'Board invite check (Board deletes this in a moment)',
      description: 'Board checks it can send board meeting invites with Google Meet. Nobody was invited, and Board deletes this event by itself.',
      start: { dateTime: `${day}T03:00:00`, timeZone: TZ }, end: { dateTime: `${day}T03:15:00`, timeZone: TZ },
      transparency: 'transparent', visibility: 'private', reminders: { useDefault: false, overrides: [] },
      conferenceData: { createRequest: { requestId: `board-check-${now}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    }, fetchImpl), fetchImpl);
    made = true;
    out.calendar = 'ok';
    const code = meetCodeOf(ev);
    if (!code) return { ...out, meet: 'error', error: 'Google Calendar made the event without a Google Meet' };
    out.meet = 'ok';
    const { whoJoined } = await import('./_board-attendance.js');
    const a = await whoJoined(env, { organizer, code }, { fetchImpl, now });
    const attendance = a.status === 'needs-setup' ? 'needs-setup' : a.status === 'error' ? 'error' : 'ok';
    Object.assign(out, { ok: attendance === 'ok', attendance, attendanceError: a.error });
  } catch (err) {
    out.calendar ||= 'error';
    out.error = String(err.message).slice(0, 300);
  } finally {
    if (made) {
      try { await gcal(token, 'DELETE', `${cal}/${id}?sendUpdates=none`, null, fetchImpl); } catch (err) {
        if (err.status !== 404 && err.status !== 410) out.leftover = id;
      }
    }
  }
  return out;
}

/**
 * The heartbeat: the check above until it passes (hourly while a Google
 * setting is missing; daily when Google says no for another reason; and when
 * Board is opened, at most every ten minutes, while it hasn't passed), then
 * hourly, a check event Google wouldn't delete. → the check's state. Never throws.
 */
export async function maybeCheckInvites(env, { fetchImpl = fetch, now = Date.now(), retryMs = 0 } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    const st = await readState(env.DB, CHECK);
    const fresh = st.version === CHECK_VERSION;
    const fixable = st.ok || st.attendance === 'needs-setup' || st.calendar === 'error' || st.leftover;
    // Board opened (retryMs): a check that didn't pass is tried again sooner, so a change in Google shows on the next open
    const wait = fixable ? HOUR : DAY;
    if (fresh && now - Date.parse(st.at || 0) < (retryMs && !st.ok ? Math.min(retryMs, wait) : wait)) return st;
    const at = new Date(now).toISOString();
    let next = { ...st, version: CHECK_VERSION, at };
    // A check event Google wouldn't delete last time goes first
    if (st.leftover && st.organizer) {
      try {
        const token = await accessToken(env, st.organizer, { fetchImpl, now });
        await gcal(token, 'DELETE', `/calendars/${encodeURIComponent(st.organizer)}/events/${st.leftover}?sendUpdates=none`, null, fetchImpl);
        next.leftover = '';
      } catch (err) { if (err.status === 404 || err.status === 410) next.leftover = ''; }
    }
    if (!fresh || !st.ok) {
      const c = await checkInvites(env, { fetchImpl, now });
      // The new check takes the old one's place whole (nothing of an older version's stays); a leftover from before stays
      // with its organizer until it's gone
      next = next.leftover ? { version: CHECK_VERSION, at, ...c, organizer: next.organizer, leftover: next.leftover, checkedAt: at } : { version: CHECK_VERSION, at, ...c, checkedAt: at };
    }
    await writeState(env.DB, CHECK, next);
    return next;
  } catch (err) {
    console.error('[board-invite] check', err.message);
    return null;
  }
}

/** The check, for Board's setup card and Site → Automations (no email addresses) */
export async function inviteCheck(DB) {
  const { organizer, leftover, ...st } = await readState(DB, CHECK);
  return st.version ? { ...st, leftover: !!leftover } : null;
}

/** Who's on the invite but not the board any more, and who's on the board but not the invite */
export async function inviteGaps(DB, m) {
  if (!m?.invite) return { missing: [], count: 0 };
  const guests = await guestsFor(DB);
  const on = new Set(m.invite.emails || []);
  return { missing: guests.filter((e) => !on.has(e) && e !== m.invite.organizer), count: on.size };
}

