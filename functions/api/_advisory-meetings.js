/**
 * The Advisory Board's meetings
 * ===========================================================================
 * Four or more a year, added here and only here. Whoever runs the group (Mary
 * Atchley, a board member; the Board area's admins) builds them through
 * /api/advisory-admin; advisors see one on their page once it's shared.
 *
 * advisory_meetings is the advisors' own table, the way board_practice is its
 * own: getMeeting, listMeetings, portalData and everything else that reads
 * board_meetings can never reach one, and this module never reads theirs. A
 * meeting has the board's shape (board-shared.js cleanMeeting), so the agenda
 * and the presentation (board/screen.js, at /admin/advisory/screen.html) work
 * the same way, with what the board has and advisors don't left out: no votes,
 * quorum, minutes, chair, committee reports, live numbers or following along.
 * The recap takes the minutes' place: a few lines and files, shared when
 * whoever runs it says so.
 *
 * The invite is Google Calendar's, from whoever sends the board's (organizerFor),
 * always Google Meet, with guests hidden from each other because an advisor's
 * email is private. It goes out only when a person presses Send invite. After
 * that it follows the meeting as the board's does: a new day, time or place
 * goes to Google once it has stood two minutes, words alone go quietly, someone
 * who joins or leaves is added or taken off alone, and a change made in Google
 * Calendar is put back once. The invite is the only RSVP.
 */

import {
  cleanMeeting, newMeeting, isFilled, isDate, todayEastern, FILE_KINDS,
} from '../../public/admin/board-shared.js';
import { accessToken, eventIdFor } from './_google-calendar.js';
import { ensureSchema, filesOf, putFile, updateFile, deleteFile } from './_board.js';
import {
  organizerFor, gcal, times, whenOf, placeOf, meetReady, driftOf, changeGuests, followOf, whoOf, cancelInvite,
} from './_board-invite.js';
import { activeAdvisors, boardAdmins, normEmail, peopleRows, privateEmails, readState, writeState } from './_board-roles.js';
import { isEmail } from './_broadcast-notify.js';
import { photoUrl } from '../../public/admin/team-shared.js';
import { getSettings, ensureAdvisory } from './_advisory.js';

const SITE = 'https://sunshineonaranneyday.com';
const SCHEMA = 'CREATE TABLE IF NOT EXISTS advisory_meetings (id TEXT PRIMARY KEY, date TEXT, data TEXT NOT NULL, updated_at TEXT, updated_by TEXT)';
const STATE_KEY = 'advisory-meetings';
const LOOK_MS = 5 * 60 * 1000;
const READ_MS = 60 * 60 * 1000;
const SETTLE_MS = 2 * 60 * 1000;
// A Google event id is lower-case a to v and digits: "advisory" has a y, so the prefix can't be that word
export const EVENT_PREFIX = 'advisorboard';
// The file that belongs to the recap rather than the agenda
const RECAP_KIND = 'minutes';

/** How a new meeting's agenda starts: the five things an advisory meeting is for. Never typed from scratch */
export const TEMPLATE = [
  { title: 'Welcome', items: [{ title: 'Welcome and what’s new at SOARD' }] },
  { title: 'The goal', items: [{ title: 'Where the makeover goal stands' }] },
  { title: 'Introductions', items: [{ title: 'Who we’ve met and who we’re looking for' }] },
  { title: 'The makeover', items: [{ title: 'The group’s makeover' }] },
  { title: 'The ask', items: [{ title: 'What we’re asking of you next' }] },
];
// A weekday evening: of eight applicants, four asked for evenings or weekends, three are flexible
export const DEFAULT_TIME = { start: '18:30', end: '20:00' };

// `ours`: a message written for a person, as opposed to whatever Google or the network said (./fromGoogle turns those into words)
const err = (message, status = 400) => Object.assign(new Error(message), { status, ours: true });
/** Something that talks to Google: anything it says goes out in plain words, with what did and didn't happen */
async function fromGoogle(fn, what) {
  try { return await fn(); } catch (e) {
    if (e.ours) throw e;
    console.error('[advisory-meetings] Google', e.message);
    throw err(`Google isn’t answering right now, so ${what}. Try again in a few minutes.`, 503);
  }
}
const nowIso = (now = Date.now()) => new Date(now).toISOString();
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const fail = (error, status = 400, extra = {}) => Response.json({ ok: false, error, ...extra }, { status });
// Anything not written for a person stays in the logs: what they read is always plain words
const fromError = (e) => {
  if (e.ours || (e.status && e.status < 500)) return fail(e.message, e.status || 400, e.current ? { current: e.current } : {});
  console.error('[advisory-meetings]', e.message);
  return fail('That didn’t go through. Try again in a moment.', 500);
};
const cleanText = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

const ready = new WeakSet();
async function ensure(DB) {
  await ensureSchema(DB);
  await ensureAdvisory(DB);
  if (ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  ready.add(DB);
}

// ─── Names and words ────────────────────────────────────────────────

/** "Q1 2027 Advisory Board Meeting", or the name typed */
export function advisoryName(m) {
  const typed = String(m?.title || '').trim();
  if (typed) return typed;
  if (!isDate(m?.date)) return 'Advisory Board meeting';
  const [y, mo] = m.date.split('-').map(Number);
  return `Q${Math.ceil(mo / 3)} ${y} Advisory Board Meeting`;
}
export const inviteTitleOf = (m) => `SOARD ${advisoryName(m)}`;
/** Its short link (public/_redirects): a query survives Cloudflare's sign-in, where a #/ link lands on Home */
export const inviteUrl = (m) => `${SITE}/advisory/${m.id}`;
export function inviteNotesOf(m) {
  return [
    `The agenda and documents: ${inviteUrl(m)}`,
    'Sign in with the email this invite went to. A code comes by email.',
    ...(m.inviteNote ? ['', m.inviteNote] : []),
  ].join('\n');
}
const notesKey = (m) => {
  let h = 0x811c9dc5;
  for (const c of `${inviteTitleOf(m)}\n${inviteNotesOf(m)}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
};

// ─── The table ──────────────────────────────────────────────────────

/** Words, or a file an advisor could open */
export const hasRecap = (m) => !!String(m?.recap || '').trim() || (m?.files || []).some((f) => f.kind === RECAP_KIND && !f.staffOnly);

/** A meeting as the board's rules allow it, with what advisors have and the board doesn't, and none of what the board has and they don't */
function shape(raw) {
  const m = cleanMeeting({ ...raw, attendance: [], motions: [], actions: [], practice: false, minutes: 'draft', approvedOn: '', calendar: null, fromMeet: null, minutesFrom: null, snapshot: null, live: null, notBoard: false, noSince: true });
  const recap = cleanText(raw?.recap, 6000);
  return {
    ...m,
    sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => ({ ...it, live: '', also: [], motion: '', about: '', confidential: false })) })),
    advisory: true,
    recap,
    // An empty recap is never on the page: emptied, it comes off by itself
    recapShared: raw?.recapShared === true && hasRecap({ recap, files: m.files }),
  };
}
function stored(m) {
  const { files, ...rest } = m;
  return JSON.stringify(rest);
}
const hydrate = (row, files) => {
  const raw = parse(row.data);
  return shape({ ...raw, files: files[raw.id] || [] });
};

async function listAll(DB) {
  await ensure(DB);
  const [rows, files] = await Promise.all([
    DB.prepare('SELECT data FROM advisory_meetings ORDER BY date DESC').all().then((r) => r.results || []),
    filesOf(DB, 'advisory-meeting'),
  ]);
  return rows.map((r) => hydrate(r, files));
}
export async function getAdvisoryMeeting(DB, id) {
  await ensure(DB);
  const row = await DB.prepare('SELECT data FROM advisory_meetings WHERE id = ?').bind(id).first();
  return row ? hydrate(row, await filesOf(DB, 'advisory-meeting', [id])) : null;
}
async function write(DB, m) {
  await DB.prepare('INSERT OR REPLACE INTO advisory_meetings (id, date, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)')
    .bind(m.id, m.date || '', stored(m), m.updatedAt, m.updatedBy || '').run();
}
/** A change that's the server's own (the invite, sharing), onto the meeting as it is now: a save made meanwhile stays */
async function patch(DB, id, fn, { by = '' } = {}) {
  for (let i = 0; i < 5; i++) {
    const cur = await getAdvisoryMeeting(DB, id);
    if (!cur) return null;
    const next = { ...fn(cur), id, updatedAt: nowIso(), updatedBy: by || cur.updatedBy || '' };
    const r = await DB.prepare('UPDATE advisory_meetings SET date = ?, data = ?, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ?')
      .bind(next.date || '', stored(next), next.updatedAt, next.updatedBy, id, cur.updatedAt).run();
    if ((r?.meta?.changes ?? r?.changes ?? 0) > 0) return getAdvisoryMeeting(DB, id);
  }
  throw new Error('The meeting kept changing; try again');
}

/** A whole date a meeting could be on: a year still being typed reads as 0202 */
const sensibleDay = (d) => isDate(d) && Number(d.slice(0, 4)) >= 2000 && Number(d.slice(0, 4)) <= 2100;

/** A new meeting on a day: the template's agenda, and the time and place of the nearest one before it (else after it) */
export async function createAdvisoryMeeting(env, { date, by = '' }, { now = Date.now() } = {}) {
  await ensure(env.DB);
  if (!sensibleDay(date)) throw err('Pick the meeting’s date');
  const meetings = await listAll(env.DB);
  const same = meetings.find((x) => x.date === date);
  if (same) return { meeting: same, existing: true };
  const nearest = [...meetings.filter((x) => x.date <= date).sort((a, b) => b.date.localeCompare(a.date)), ...meetings.filter((x) => x.date > date).sort((a, b) => a.date.localeCompare(b.date))];
  const timed = nearest.find((x) => x.start && x.end);
  const placed = nearest.find((x) => x.location);
  const m = shape({
    ...newMeeting({ date, template: TEMPLATE, defaults: { ...DEFAULT_TIME, ...(timed ? { start: timed.start, end: timed.end } : {}), ...(placed ? { location: placed.location, address: placed.address || '' } : {}) } }),
    createdAt: nowIso(now), updatedAt: nowIso(now), updatedBy: by,
  });
  await write(env.DB, m);
  return { meeting: await getAdvisoryMeeting(env.DB, m.id), existing: false };
}

/** A save from the editor. What's the server's stays the server's: sharing, the invite. `base`: the updatedAt it started from */
export async function saveAdvisoryMeeting(DB, raw, { by = '', base = null, now = Date.now() } = {}) {
  await ensure(DB);
  const cur = await getAdvisoryMeeting(DB, String(raw?.id || ''));
  if (!cur) throw err('That meeting is gone', 404);
  if (base !== null && cur.updatedAt && cur.updatedAt !== base) {
    throw Object.assign(err(`${cur.updatedBy || 'Someone'} saved this meeting since you opened it`, 409), { current: cur });
  }
  // Which files are on which item is the file actions' (attach-file, upload): an upload finishing while someone types
  // is never undone by the save that follows. A new item starts with none
  const onItems = new Map(cur.sections.flatMap((s) => s.items).map((it) => [it.id, it.docs]));
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).map((s) => ({ ...s, items: (s?.items || []).map((it) => ({ ...it, docs: onItems.get(it?.id) || [] })) }));
  const m = shape({
    ...cur,
    date: raw.date, start: raw.start, end: raw.end, title: raw.title, location: raw.location, address: raw.address, inviteNote: raw.inviteNote, sections, recap: raw.recap,
    updatedAt: nowIso(now), updatedBy: by,
  });
  if (!m.date || !sensibleDay(m.date)) throw err('Check the meeting’s date');
  if (m.start && m.end && m.end <= m.start) throw err('A meeting has to end after it starts. Check the times.');
  const clash = (await listAll(DB)).find((x) => x.id !== m.id && x.date === m.date);
  if (clash) throw err(`${advisoryName(clash)} is already on that day`, 409);
  await write(DB, m);
  return getAdvisoryMeeting(DB, m.id);
}

/** Deleted: its invite comes off the calendar first (a refusal stops the delete), then its files */
export async function deleteAdvisoryMeeting(env, id, { fetchImpl = fetch, now = Date.now() } = {}) {
  const m = await getAdvisoryMeeting(env.DB, id);
  if (!m) throw err('That meeting is gone', 404);
  await cancelInvite(env, m, { fetchImpl, now });
  for (const f of m.files) await deleteFile(env, f.id);
  await env.DB.prepare('DELETE FROM advisory_meetings WHERE id = ?').bind(id).run();
}

// ─── What each person sees ──────────────────────────────────────────

export async function isSharedAdvisoryMeeting(DB, id) {
  return !!(await getAdvisoryMeeting(DB, id))?.shared;
}

/**
 * A meeting as an advisor sees it, or null until it's shared: filled items only, no staff notes or staff files, the
 * Meet link and their own answer. Never who else is coming, or anything of the invite but that.
 */
export function advisorView(m, { slug = '' } = {}) {
  if (!m?.shared) return null;
  const all = m.files.filter((f) => !f.staffOnly);
  const open = new Set(all.map((f) => f.id));
  const recapFiles = all.filter((f) => f.kind === RECAP_KIND);
  return {
    id: m.id, title: advisoryName(m), date: m.date, start: m.start, end: m.end, location: m.location, address: m.address, inviteNote: m.inviteNote,
    sections: m.sections.map((s) => ({ id: s.id, title: s.title, minutes: s.minutes, items: s.items.filter(isFilled).map(({ staffNote, reportBy, reportAt, ...it }) => ({ ...it, docs: it.docs.filter((d) => open.has(d)) })) })).filter((s) => s.items.length),
    files: all.filter((f) => f.kind !== RECAP_KIND),
    meet: m.invite?.meet || '',
    invited: !!m.invite?.eventId,
    myAnswer: slug ? m.invite?.replies?.[slug] || '' : '',
    recap: m.recapShared && (m.recap || recapFiles.length) ? { text: m.recap, files: recapFiles } : null,
  };
}

/** The page's meetings, newest first: only shared ones, whoever's looking (GET /api/advisory-portal) */
export async function meetingsFor(env, who = {}, { now = Date.now() } = {}) {
  const slug = who?.answers ? who.slug : '';
  return (await listAll(env.DB)).map((m) => advisorView(m, { slug })).filter(Boolean);
}

/** Everything for whoever runs the group: every meeting, whose answer each reply is */
export async function adminMeetings(env) {
  const [list, people] = await Promise.all([listAll(env.DB), peopleRows(env.DB)]);
  const names = Object.fromEntries(people.map((p) => [p.slug, p.name]));
  return list.map((m) => ({
    ...m,
    name: advisoryName(m),
    canInvite: !!env.GOOGLE_CALENDAR_KEY,
    replies: Object.entries(m.invite?.replies || {}).map(([slug, answer]) => ({ slug, name: names[slug] || slug, answer })).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** What board/screen.js needs to draw one meeting. It reads the page's copy (it has no live view here): ./board/screen.js LOCAL */
async function screenData(env, id) {
  const [list, people, settings] = await Promise.all([listAll(env.DB), peopleRows(env.DB), getSettings(env.DB)]);
  const m = list.find((x) => x.id === id);
  if (!m) throw err('That meeting is gone', 404);
  // The screen's people: the advisors, and from anywhere else only someone leading an item or the person running the group
  const named = new Set([settings.lead, ...list.flatMap((x) => x.sections.flatMap((s) => s.items.flatMap((it) => it.who)))]);
  const view = (x) => {
    const v = advisorView({ ...x, shared: true });
    return { ...v, shared: x.shared, files: [...v.files, ...x.files.filter((f) => !f.staffOnly && f.kind === RECAP_KIND)], video: x.invite?.meet || '', invite: x.invite?.meet ? { meet: x.invite.meet } : null, noSince: true };
  };
  const later = list.filter((x) => x.shared && x.date > m.date).map(view);
  const card = (p) => ({ slug: p.slug, name: p.name, title: p.title || '', organization: p.organization || '', since: p.since || null, group: p.group, photo: p.photo ? photoUrl(p, 160) : '' });
  return {
    ok: true, today: todayEastern(), meetings: [view(m), ...later], previews: [], presenting: [], numbers: {}, lineNotes: {},
    people: people.filter((p) => p.status === 'active' && !p.draft && (p.group === 'advisory' || named.has(p.slug))).map(card),
  };
}

// ─── The invite ─────────────────────────────────────────────────────

/** Who an invite goes to: active advisors with an email, whoever runs the group, and the Board area's admins */
export async function guestsOf(DB, settings = null) {
  const s = settings || await getSettings(DB);
  const [advisors, admins, emails] = await Promise.all([activeAdvisors(DB), boardAdmins(DB), privateEmails(DB)]);
  const lead = isEmail(emails[s.lead] || '') ? [{ slug: s.lead, email: normEmail(emails[s.lead]) }] : [];
  const people = [...advisors.filter((a) => isEmail(a.email || '')).map((a) => ({ slug: a.slug, email: normEmail(a.email) })), ...lead.filter((l) => !advisors.some((a) => a.slug === l.slug))];
  return { people, emails: [...new Set([...people.map((p) => p.email), ...admins.map(normEmail)])] };
}

const answerOf = (a) => (['accepted', 'declined', 'tentative'].includes(a.responseStatus) ? a.responseStatus : 'invited');
const repliesFrom = (attendees, people) => {
  const bySlug = Object.fromEntries(people.map((p) => [p.email, p.slug]));
  const out = {};
  for (const a of attendees || []) { const slug = bySlug[normEmail(a.email)]; if (slug) out[slug] = answerOf(a); }
  return out;
};

/**
 * Sent when a person presses Send invite, and only then for a first send: new, or brought up to date. `quiet`: only
 * the words changed and nobody's new, so Google emails no one. → the meeting
 */
export async function sendAdvisoryInvite(env, id, { fetchImpl = fetch, now = Date.now(), quiet = false } = {}) {
  if (!env.GOOGLE_CALENDAR_KEY) throw err('Google Calendar isn’t connected yet. Peter or Holly can connect it.', 503);
  const m = await getAdvisoryMeeting(env.DB, id);
  if (!m) throw err('That meeting is gone', 404);
  const organizer = m.invite?.organizer || await organizerFor(env.DB);
  if (!organizer) throw err('Nobody is set to send invites yet. Peter or Holly can set that.', 409);
  const token = await accessToken(env, organizer, { fetchImpl, now });
  const cal = `/calendars/${encodeURIComponent(organizer)}/events`;
  const eventId = m.invite?.eventId || eventIdFor(EVENT_PREFIX, m.id);
  const path = `${cal}/${encodeURIComponent(eventId)}`;
  const { people, emails } = await guestsOf(env.DB);
  let existing = null;
  try { existing = await gcal(token, 'GET', path, null, fetchImpl); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
  const have = new Set((existing?.attendees || []).map((a) => normEmail(a.email)));
  const added = emails.filter((e) => !have.has(e) && e !== normEmail(organizer));
  const attendees = [...(existing?.attendees || []), ...added.map((email) => ({ email }))];
  const place = placeOf(m);
  const body = {
    attendees,
    ...(place ? { location: place } : {}),
    ...(existing?.hangoutLink ? {} : { conferenceData: { createRequest: { requestId: `advisory-${m.id}-${now}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }),
    summary: inviteTitleOf(m),
    ...times(m),
    description: inviteNotesOf(m),
    // An advisor's email is private: nobody sees who else is on it
    guestsCanSeeOtherGuests: false,
  };
  const send = quiet && existing && !added.length ? 'none' : 'all';
  const ev = await meetReady(token, path, existing
    ? await gcal(token, 'PATCH', `${path}?conferenceDataVersion=1&sendUpdates=${send}`, existing.status === 'cancelled' ? { status: 'confirmed', ...body } : body, fetchImpl)
    : await gcal(token, 'POST', `${cal}?conferenceDataVersion=1&sendUpdates=all`, { id: eventId, ...body }, fetchImpl), fetchImpl);
  const at = nowIso(now);
  const on = (ev.attendees || attendees).map((a) => normEmail(a.email));
  const invite = {
    eventId: ev.id || eventId, organizer, sentAt: m.invite?.sentAt || at, updatedAt: at, meet: ev.hangoutLink || '', guests: on.length, emails: on,
    place, location: ev.location || '', when: whenOf(m), notes: notesKey(m), replies: repliesFrom(ev.attendees || attendees, people), who: whoOf(m.invite, people, on),
  };
  return patch(env.DB, id, (cur) => ({ ...cur, invite, inviteGone: '' }));
}

const loudChange = (m) => (placeOf(m) && placeOf(m) !== m.invite.place) || whenOf(m) !== m.invite.when;
const changed = (m) => loudChange(m) || notesKey(m) !== m.invite.notes;

/**
 * The heartbeat, every five minutes: a change that has stood two minutes goes onto its invite; someone who joined or
 * left the group comes on or goes off (only they hear); and hourly each invite ahead is read: answers, deleted in
 * Google Calendar, or changed there (Board's way: put back once, then left for a person). Never throws.
 */
export async function maybeSyncAdvisoryMeetings(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB) return null;
    await ensure(env.DB);
    const state = await readState(env.DB, STATE_KEY);
    if (state.at && now - Date.parse(state.at) < LOOK_MS) return null;
    const read = !state.readAt || now - Date.parse(state.readAt) >= READ_MS;
    const at = nowIso(now);
    await writeState(env.DB, STATE_KEY, { ...state, at, ...(read ? { readAt: at } : {}) });
    if (!env.GOOGLE_CALENDAR_KEY) return null;
    const today = todayEastern(now);
    const did = { updated: 0, added: 0, removed: 0, held: 0, gone: 0, putBack: 0, replies: 0, failed: 0 };
    const { people } = await guestsOf(env.DB);
    // With the emails switch off nothing goes out on its own: a change waits, and replies are still read
    const sending = (await getSettings(env.DB)).emails === true;
    for (const m of (await listAll(env.DB)).filter((x) => x.invite?.eventId && isDate(x.date) && x.date >= today)) {
      try {
        if (sending && changed(m) && now - Date.parse(m.updatedAt) >= SETTLE_MS) {
          await sendAdvisoryInvite(env, m.id, { fetchImpl, now, quiet: !loudChange(m) });
          did.updated += 1;
        }
        const plan = followOf(m.invite, people);
        if (plan.drop.length > Object.keys(m.invite.who || {}).length / 2) did.held += 1;
        else if (sending && (plan.add.length || plan.drop.length)) {
          const emails = await changeGuests(env, m, plan, { fetchImpl, now });
          if (emails) {
            const keep = new Set(people.map((p) => p.slug));
            await patch(env.DB, m.id, (cur) => (cur.invite?.eventId !== m.invite.eventId ? cur : {
              ...cur,
              invite: {
                ...cur.invite, emails, guests: emails.length, updatedAt: at, who: whoOf(cur.invite, people, emails),
                replies: { ...Object.fromEntries(people.filter((p) => emails.includes(p.email)).map((p) => [p.slug, 'invited'])), ...Object.fromEntries(Object.entries(cur.invite.replies || {}).filter(([s]) => keep.has(s))) },
              },
            }));
            did.added += plan.add.length;
            did.removed += plan.drop.length;
          }
        }
        if (read) await readInvite(env, m.id, people, did, { fetchImpl, now, sending });
      } catch (e) {
        did.failed += 1;
        console.error('[advisory-meetings]', m.id, e.message);
      }
    }
    return did;
  } catch (e) {
    console.error('[advisory-meetings]', e.message);
    return null;
  }
}

async function readInvite(env, id, people, did, { fetchImpl, now, sending = true }) {
  const m = await getAdvisoryMeeting(env.DB, id);
  const inv = m?.invite;
  if (!inv?.eventId) return;
  const token = await accessToken(env, inv.organizer, { fetchImpl, now });
  const path = `/calendars/${encodeURIComponent(inv.organizer)}/events/${encodeURIComponent(inv.eventId)}`;
  let ev = null;
  try { ev = await gcal(token, 'GET', path, null, fetchImpl); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
  // Deleted in Google Calendar: the meeting stays, its invite doesn't (Send invite puts it back)
  if (!ev || ev.status === 'cancelled') {
    await patch(env.DB, id, (cur) => (cur.invite?.eventId === inv.eventId ? { ...cur, invite: null, inviteGone: nowIso(now) } : cur));
    did.gone += 1;
    return;
  }
  const drift = driftOf(ev, m);
  if (sending && drift && inv.putBackFor !== drift) {
    await sendAdvisoryInvite(env, id, { fetchImpl, now });
    await patch(env.DB, id, (cur) => (cur.invite ? { ...cur, invite: { ...cur.invite, putBackAt: nowIso(now), putBackFor: drift } } : cur));
    did.putBack += 1;
    return;
  }
  const replies = { ...(inv.replies || {}), ...repliesFrom(ev.attendees, people) };
  if (JSON.stringify(replies) !== JSON.stringify(inv.replies || {}) || (drift || '') !== (inv.differs || '')) {
    await patch(env.DB, id, (cur) => (cur.invite?.eventId === inv.eventId ? { ...cur, invite: { ...cur.invite, replies, differs: drift } } : cur));
    did.replies += 1;
  }
}

// ─── The actions ────────────────────────────────────────────────────

const fileOfMeeting = async (DB, id) => {
  if (!/^[a-z0-9_]{3,40}$/i.test(String(id || ''))) return null;
  return DB.prepare("SELECT id, owner_id FROM board_files WHERE id = ? AND owner_type = 'advisory-meeting'").bind(id).first();
};
/** Everywhere an item lists a file, or one item only */
const withDoc = (m, fileId, itemId) => ({
  ...m,
  sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => {
    const rest = it.docs.filter((d) => d !== fileId);
    return { ...it, docs: it.id === itemId ? [...rest, fileId] : rest };
  }) })),
});
const KINDS = new Set(FILE_KINDS.map((k) => k.id));

/**
 * /api/advisory-admin's meeting actions, for whoever runs the group (`w.runs`; the route has checked):
 *   new-meeting { date }, save-meeting { meeting, base }, delete-meeting { id }, send-invite { id },
 *   share-meeting { id, shared }, share-recap { id, shared }, meeting-view { id } (what the screen draws),
 *   attach-file { id, fileId, itemId }, update-meeting-file { fileId, name, staffOnly, kind }, delete-meeting-file { fileId },
 *   upload (multipart: meetingId, file, itemId?, kind?, staffOnly?).
 */
export async function meetingAction(context, { action, body = {}, form = null, by = '', w = null }) {
  const { env } = context;
  try {
    if (!w?.runs) return fail('Only the people who run the Advisory Board can do this', 403);
    await ensure(env.DB);
    const id = String(body.id || '');
    switch (action) {
      case 'new-meeting': {
        const out = await createAdvisoryMeeting(env, { date: body.date, by });
        return Response.json({ ok: true, ...out });
      }
      case 'save-meeting': {
        const base = typeof body.base === 'string' ? body.base : null;
        return Response.json({ ok: true, meeting: await saveAdvisoryMeeting(env.DB, body.meeting || {}, { by, base }) });
      }
      case 'delete-meeting':
        await fromGoogle(() => deleteAdvisoryMeeting(env, id), 'the meeting is still here and its invite is still out');
        return Response.json({ ok: true });
      case 'send-invite':
        // An invite is an email to people outside SOARD: it waits for the same switch as the rest
        if (!(await getSettings(env.DB)).emails) throw err('Turn on emails to advisors on Members first. Until then, this meeting stays on the page.', 409);
        {
          // Pressed again with nothing different: nothing goes to anyone. A new day, time or place emails everyone;
          // words alone update the calendar quietly
          const cur = await getAdvisoryMeeting(env.DB, id);
          const out = !!cur?.invite?.eventId;
          if (out && !changed(cur) && !cur.invite.differs && !followOf(cur.invite, (await guestsOf(env.DB)).people).add.length) return Response.json({ ok: true, meeting: cur, unchanged: true });
          const quiet = out && !loudChange(cur) && !cur.invite.differs;
          return Response.json({ ok: true, quiet, meeting: await fromGoogle(() => sendAdvisoryInvite(env, id, { quiet }), 'the invite didn’t go out') });
        }
      case 'share-meeting':
      case 'share-recap': {
        const field = action === 'share-meeting' ? 'shared' : 'recapShared';
        if (field === 'recapShared' && body.shared === true && !hasRecap(await getAdvisoryMeeting(env.DB, id))) return fail('Write the recap or add a file first');
        const meeting = await patch(env.DB, id, (cur) => ({ ...cur, [field]: body.shared === true }), { by });
        if (!meeting) return fail('That meeting is gone', 404);
        return Response.json({ ok: true, meeting });
      }
      case 'meeting-view':
        return Response.json(await screenData(env, id));
      case 'attach-file': {
        const f = await fileOfMeeting(env.DB, body.fileId);
        if (!f || f.owner_id !== id) return fail('That file is gone', 404);
        return Response.json({ ok: true, meeting: await patch(env.DB, id, (cur) => withDoc(cur, f.id, String(body.itemId || '')), { by }) });
      }
      case 'update-meeting-file': {
        const f = await fileOfMeeting(env.DB, body.fileId);
        if (!f) return fail('That file is gone', 404);
        const file = await updateFile(env.DB, f.id, { name: body.name, staffOnly: body.staffOnly, kind: KINDS.has(body.kind) ? body.kind : undefined });
        return Response.json({ ok: true, file, meeting: await getAdvisoryMeeting(env.DB, f.owner_id) });
      }
      case 'delete-meeting-file': {
        const f = await fileOfMeeting(env.DB, body.fileId);
        if (!f) return fail('That file is gone', 404);
        await deleteFile(env, f.id);
        return Response.json({ ok: true, meeting: await patch(env.DB, f.owner_id, (cur) => withDoc(cur, f.id, ''), { by }) });
      }
      case 'upload': {
        const meetingId = String(form?.get('meetingId') || '');
        if (!(await getAdvisoryMeeting(env.DB, meetingId))) return fail('Save the meeting first', 404);
        const kind = String(form.get('kind') || 'other');
        const file = await putFile(env, { ownerType: 'advisory-meeting', ownerId: meetingId, file: form.get('file'), kind: KINDS.has(kind) ? kind : 'other', staffOnly: form.get('staffOnly') === 'true', by });
        const itemId = String(form.get('itemId') || '');
        const meeting = itemId ? await patch(env.DB, meetingId, (cur) => withDoc(cur, file.id, itemId), { by }) : await getAdvisoryMeeting(env.DB, meetingId);
        return Response.json({ ok: true, file, meeting });
      }
      default:
        return fail('Unknown action');
    }
  } catch (e) { return fromError(e); }
}
