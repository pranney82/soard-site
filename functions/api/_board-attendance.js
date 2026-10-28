/**
 * Who was at a board meeting, from Google Meet
 * ===========================================================================
 * After a meeting with a Google Meet link ends, Board reads who joined
 * (Meet REST API: the space, its conference records, their participants)
 * as the organizer, matches each name to the board and staff on the
 * meeting, and marks them "By video" where nobody has marked them yet. A
 * mark someone made is never changed; who joined is kept on the meeting
 * (fromMeet) for the attendance to show.
 *
 * Needs https://www.googleapis.com/auth/meetings.space.readonly on the
 * service account's domain-wide delegation (Board → Meetings asks for it
 * until it's there). Runs on the heartbeat: from half an hour after a
 * meeting ends, hourly for two days (people who join late, a record Google
 * finishes late), then never again.
 */

import { accessToken } from './_google-calendar.js';
import { readState, writeState } from './_board-roles.js';
import { listMeetings, patchMeeting } from './_board.js';
import { todayEastern } from '../../public/admin/board-shared.js';

const MEET_API = 'https://meet.googleapis.com/v2';
export const MEET_READ_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';
const TZ = 'America/New_York';
const HOUR = 60 * 60 * 1000;
const AFTER_MS = 30 * 60 * 1000;
const FOR_MS = 2 * 24 * HOUR;

export const meetCode = (url) => (String(url || '').match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/) || [])[1] || '';

/** When the meeting ended, as a time (its end, else two hours after its start, else the end of its day) */
export function endOf(m) {
  if (!m?.date) return NaN;
  // How far New York is behind UTC that day (EST or EDT), whatever zone this runs in
  const probe = new Date(`${m.date}T12:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(probe).map((x) => [x.type, x.value]));
  const offset = probe - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  const at = (hm) => Date.parse(`${m.date}T${hm}:00Z`) + offset;
  if (m.end) return at(m.end);
  if (m.start) return at(m.start) + 2 * HOUR;
  return at('23:59');
}

/** "Dr. Jane Q. Doe" → "jane doe"; the words of a name, for matching */
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, ' ').replace(/[^a-z\s'-]/g, ' ')
  .split(/\s+/).filter((w) => w && !['dr', 'mr', 'mrs', 'ms', 'jr', 'sr', 'ii', 'iii'].includes(w));

/**
 * A Meet name to one person on the meeting: first and last name, else a
 * first name only one person has. → that person, or null
 */
export function matchName(name, people) {
  const w = words(name);
  if (!w.length) return null;
  const first = w[0];
  const last = w.length > 1 ? w[w.length - 1] : '';
  const full = people.filter((p) => { const pw = words(p.name); return pw[0] === first && last && pw[pw.length - 1] === last; });
  if (full.length === 1) return full[0];
  if (last) {
    // "Jen Crosby" for Jennifer Crosby: the last name, and a first name that starts the same
    const near = people.filter((p) => { const pw = words(p.name); return pw[pw.length - 1] === last && (pw[0].startsWith(first) || first.startsWith(pw[0])); });
    if (near.length === 1) return near[0];
  }
  if (!last) {
    const byFirst = people.filter((p) => words(p.name)[0] === first);
    if (byFirst.length === 1) return byFirst[0];
  }
  return null;
}

async function meet(token, path, fetchImpl) {
  const res = await fetchImpl(`${MEET_API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`Google Meet answered ${res.status}: ${data?.error?.message || ''}`.trim()), { status: res.status });
  return data || {};
}

/**
 * Who joined the meeting's Google Meet: [{ name, minutes }] (one per person,
 * their time across every record and rejoin) → { status, joined, error }
 */
export async function whoJoined(env, { organizer, code }, { fetchImpl = fetch, now = Date.now() } = {}) {
  let token;
  try { token = await accessToken(env, organizer, { fetchImpl, now, scope: MEET_READ_SCOPE }); } catch (err) {
    return { status: 'needs-setup', joined: [], error: /unauthorized_client|access_denied/i.test(err.message) ? 'Google Admin hasn’t allowed meetings.space.readonly yet' : String(err.message).slice(0, 200) };
  }
  try {
    const space = await meet(token, `/spaces/${encodeURIComponent(code)}`, fetchImpl);
    const records = [];
    let page = '';
    do {
      const r = await meet(token, `/conferenceRecords?filter=${encodeURIComponent(`space.name="${space.name}"`)}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, fetchImpl);
      records.push(...(r.conferenceRecords || []));
      page = r.nextPageToken || '';
    } while (page && records.length < 50);
    const time = new Map(); // name → minutes
    for (const rec of records) {
      let next = '';
      do {
        const r = await meet(token, `/${rec.name}/participants?pageSize=250${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`, fetchImpl);
        for (const p of r.participants || []) {
          const name = String((p.signedinUser || p.anonymousUser || p.phoneUser || {}).displayName || '').trim();
          if (!name) continue;
          const mins = Math.max(0, (Date.parse(p.latestEndTime || rec.endTime || new Date(now).toISOString()) - Date.parse(p.earliestStartTime || rec.startTime)) / 60000) || 0;
          time.set(name, (time.get(name) || 0) + mins);
        }
        next = r.nextPageToken || '';
      } while (next);
    }
    const joined = [...time].map(([name, minutes]) => ({ name, minutes: Math.round(minutes) }));
    return { status: records.length ? 'ok' : 'none', joined, error: '' };
  } catch (err) {
    const setup = err.status === 403 && /has not been used|is disabled|insufficient/i.test(err.message);
    return { status: setup ? 'needs-setup' : 'error', joined: [], error: String(err.message).slice(0, 300) };
  }
}

/**
 * The meeting's attendance with who joined by Meet: each match not marked
 * yet becomes "By video" (a mark someone made stays). → { attendance, joined }
 */
export function withJoined(m, joined) {
  const people = m.attendance.filter((p) => p.kind !== 'guest');
  const named = joined.map((j) => ({ ...j, person: matchName(j.name, people) }));
  const byKey = new Map(named.filter((j) => j.person && j.minutes >= 1).map((j) => [j.person.key, j]));
  return {
    attendance: m.attendance.map((p) => (byKey.has(p.key) && !p.status ? { ...p, status: 'remote' } : p)),
    joined: named.map(({ person, ...j }) => ({ ...j, slug: person?.slug || '' })),
  };
}

/** The heartbeat: meetings with a Google Meet that ended, read for who joined (see the top). Never throws. */
export async function maybeFillAttendance(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return [];
    const runs = await readState(env.DB, 'attendance-runs');
    if (runs.at && now - Date.parse(runs.at) < 10 * 60 * 1000) return [];
    await writeState(env.DB, 'attendance-runs', { at: new Date(now).toISOString() });
    const oldest = todayEastern(now - FOR_MS - 2 * 24 * HOUR);
    const due = (await listMeetings(env.DB)).filter((m) => {
      const code = meetCode(m.invite?.meet || m.video);
      const end = endOf(m);
      if (!code || !(m.date >= oldest) || !(now >= end + AFTER_MS) || now > end + FOR_MS + HOUR) return false;
      return !m.fromMeet || now - Date.parse(m.fromMeet.at) >= HOUR;
    });
    const done = [];
    for (const m of due) {
      const organizer = m.invite?.organizer || m.calendar?.organizer || '';
      if (!organizer) continue;
      const code = meetCode(m.invite?.meet || m.video);
      const r = await whoJoined(env, { organizer, code }, { fetchImpl, now });
      await patchMeeting(env.DB, m.id, (cur) => {
        const at = new Date(now).toISOString();
        if (r.status !== 'ok') return { ...cur, fromMeet: { at, status: r.status, error: r.error, joined: cur.fromMeet?.joined || [] } };
        const { attendance, joined } = withJoined(cur, r.joined);
        return { ...cur, attendance, fromMeet: { at, status: 'ok', error: '', joined } };
      });
      done.push(m.id);
    }
    return done;
  } catch (err) {
    console.error('[board-attendance]', err.message);
    return [];
  }
}
