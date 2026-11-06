/**
 * The board's next four meetings are always on everyone's calendar, 9 to 12 months ahead, with no end date (Peter,
 * Nov 5 2026: "yes and so that would go on forever right?"). The board meets the second Thursday of each quarter's first
 * month (board-shared.js boardDays). The day after each of those dates, the same quarter next year is added and its
 * calendar invite goes out: 8 to 10 AM (Board's usual time), on the agenda template, no place yet (it moves meeting to
 * meeting, and goes on when it's added).
 *
 * Each quarter once: after that, a meeting moved or cancelled stays that way. A quarter that already has a meeting keeps
 * it, so a date someone chose by hand never gets a second meeting beside it, and an invite someone deleted isn't brought
 * back. A hub that was down catches up. If Google fails it tries again each hour, and if it's still failing a day later
 * the staff hear about it, because a job that runs forever can't rely on someone looking at a page.
 */

import { listMeetings, createMeeting, ensureSchema } from './_board.js';
import { readState, writeState } from './_board-roles.js';
import { sendInvite, sayInviteProblem, sayInviteFixed } from './_board-invite.js';
import { sendingHours } from './_board-asks.js';
import { logAudit } from './_audit.js';
import { boardDays, quarterOf, todayEastern, longDate } from '../../public/admin/board-shared.js';

const KEY = 'board-ahead';
const CLAIM = 'board-ahead-claim';
const AHEAD = 4;
const EVERY_MS = 60 * 60 * 1000;
const TELL_AFTER_MS = 24 * 60 * 60 * 1000;
/** 2027 was scheduled by hand on Nov 5 2026: shipping this sends nothing, and 2028's first goes out Jan 15 2027 */
export const FIRST_DAY = '2028-01-01';

const dayAfter = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
const yearOf = (d) => Number(String(d).slice(0, 4));
/** The board's next four dates by the rule, today's included until it's over */
export function daysAhead(today) {
  const y = yearOf(today);
  return [...boardDays(y), ...boardDays(y + 1), ...boardDays(y + 2)].filter((d) => d >= today).slice(0, AHEAD);
}
/** The day a meeting's invite goes out: the day after the same quarter's date the year before */
export const sendsOn = (date) => {
  const days = [...boardDays(yearOf(date) - 1), ...boardDays(yearOf(date))];
  return dayAfter(days[days.indexOf(date) - AHEAD]);
};

/** Only one heartbeat at a time, and only hourly: the same row is the turn and the wait */
async function takeTurn(DB, now) {
  const at = new Date(now).toISOString();
  const r = await DB.prepare("INSERT INTO board_state (key, data, updated_at) VALUES (?, '{}', ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at WHERE board_state.updated_at < ?")
    .bind(CLAIM, at, new Date(now - EVERY_MS).toISOString()).run();
  return !!r?.meta?.changes;
}

/** Keep the next four meetings out, on the heartbeat, in sending hours. Never throws. → what it did, or null */
export async function maybeScheduleAhead(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    const due = daysAhead(todayEastern(now)).filter((d) => d >= FIRST_DAY);
    if (!due.length || !sendingHours(now)) return null;
    await ensureSchema(env.DB);
    const had = (await readState(env.DB, KEY)).quarters || {};
    const open = due.filter((d) => !had[quarterOf(d)]?.doneAt);
    if (!open.length || !(await takeTurn(env.DB, now))) return null;
    const meetings = (await listMeetings(env.DB)).filter((m) => !m.notBoard && !m.practice);
    const quarters = { ...had };
    const at = new Date(now).toISOString();
    let added = 0;
    let invited = 0;
    let error = '';
    for (const date of open) {
      const q = quarterOf(date);
      try {
        const there = meetings.find((m) => m.date && quarterOf(m.date) === q);
        const m = there || await createMeeting(env, { date, by: 'Board', usual: true });
        if (!there) added += 1;
        if (!m.invite?.eventId && !m.inviteGone) {
          await sendInvite(env, m.id, { fetchImpl, now, by: 'Board' });
          invited += 1;
        }
        quarters[q] = { doneAt: at, date };
        if (had[q]?.toldAt) await sayInviteFixed(env, `ahead:${q}`, `${q} board meeting invite is out`);
      } catch (err) {
        const since = had[q]?.since || at;
        error = String(err.message).replace(/\S+@\S+/g, '…').slice(0, 200);
        console.error('[board-schedule]', date, err.message);
        const late = now - Date.parse(since) >= TELL_AFTER_MS;
        if (late && !had[q]?.toldAt) await sayInviteProblem(env, `ahead:${q}`, { title: `The ${q} board meeting invite hasn’t gone out`, detail: `It should have gone to the board by itself for ${longDate(date)}, and Google has refused for a day: ${error}`, fix: 'It keeps trying each hour. If it doesn’t clear, open the meeting in Board and press Send the invite to see what’s wrong.' });
        quarters[q] = { date, since, error, errorAt: at, toldAt: had[q]?.toldAt || (late ? at : '') };
      }
    }
    await writeState(env.DB, KEY, { ...(await readState(env.DB, KEY)), quarters });
    if (added || invited) await logAudit(env.DB, { userEmail: 'Board', action: 'created', entityType: 'board', entitySlug: 'board', entityName: `Board meetings added ahead: ${open.map(quarterOf).join(', ')}`, gitStatus: 'ok' }).catch(() => {});
    return { added, invited, error };
  } catch (err) {
    console.error('[board-schedule]', err.message);
    return null;
  }
}

/** For Site → Automations: the last meeting to go, the next and when, and anything stuck (dates only, never a name) */
export async function scheduleStatus(DB, { now = Date.now() } = {}) {
  const quarters = (await readState(DB, KEY)).quarters || {};
  const today = todayEastern(now);
  const done = Object.values(quarters).filter((q) => q.doneAt).sort((a, b) => a.date.localeCompare(b.date));
  const stuck = Object.entries(quarters).find(([, q]) => !q.doneAt);
  // The first date after the ones out, by the rule
  const y = yearOf(today);
  const next = [...boardDays(y), ...boardDays(y + 1), ...boardDays(y + 2), ...boardDays(y + 3)].find((d) => d >= FIRST_DAY && d >= today && !quarters[quarterOf(d)]?.doneAt);
  return { next, on: sendsOn(next), last: done.at(-1)?.date || null, lastAt: done.at(-1)?.doneAt || null, error: stuck ? `${stuck[0]}: ${stuck[1].error}` : null, errorAt: stuck?.[1].errorAt || null };
}
