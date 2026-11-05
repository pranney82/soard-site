/**
 * Next year's board meetings, by themselves, every year with no end date (Peter, Nov 5 2026: "yes and so that would go
 * on forever right?"). The board meets the second Thursday of each quarter's first month (board-shared.js boardDays).
 * The day after the second Thursday of July, next year's four are added and their calendar invites go out: 8 to 10 AM
 * (Board's usual time), on the agenda template, no place yet (it moves meeting to meeting, and goes on when it's added).
 *
 * Each year once: once it's done, a meeting moved or deleted afterward stays that way. A quarter that already has a
 * meeting keeps it, so a date someone chose by hand never gets a second meeting beside it, and an invite someone
 * deleted isn't brought back. If Google fails, it tries again each hour until all four have gone.
 */

import { listMeetings, createMeeting, ensureSchema } from './_board.js';
import { readState, writeState } from './_board-roles.js';
import { sendInvite } from './_board-invite.js';
import { sendingHours } from './_board-asks.js';
import { logAudit } from './_audit.js';
import { boardDays, secondThursday, quarterOf, todayEastern } from '../../public/admin/board-shared.js';

const KEY = 'next-year';
const CLAIM = 'next-year-claim';
const EVERY_MS = 60 * 60 * 1000;
/** 2027 was scheduled by hand on Nov 5 2026: shipping this does nothing until 2028's turn, on July 9 2027 */
export const FIRST_YEAR = 2028;

const dayAfter = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
/** The day a year's meetings go out: the day after the second Thursday of the July before */
export const sendsOn = (year) => dayAfter(secondThursday(year - 1, 7));
/** The latest year whose day to go out has come */
export const yearToSchedule = (today) => {
  const y = Number(String(today).slice(0, 4));
  return today >= sendsOn(y + 1) ? y + 1 : y;
};

/** Only one heartbeat at a time, and only hourly: the same row is the turn and the wait */
async function takeTurn(DB, now) {
  const at = new Date(now).toISOString();
  const r = await DB.prepare("INSERT INTO board_state (key, data, updated_at) VALUES (?, '{}', ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at WHERE board_state.updated_at < ?")
    .bind(CLAIM, at, new Date(now - EVERY_MS).toISOString()).run();
  return !!r?.meta?.changes;
}

/** Next year's meetings and invites, once a year on the heartbeat, in sending hours. Never throws. → what it did, or null */
export async function maybeScheduleNextYear(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    const year = yearToSchedule(todayEastern(now));
    if (year < FIRST_YEAR || !sendingHours(now)) return null;
    await ensureSchema(env.DB);
    if ((await readState(env.DB, KEY)).years?.[year]?.doneAt) return null;
    if (!(await takeTurn(env.DB, now))) return null;
    const meetings = (await listMeetings(env.DB)).filter((m) => !m.notBoard && !m.practice);
    let added = 0;
    let invited = 0;
    let error = '';
    for (const date of boardDays(year)) {
      try {
        const there = meetings.find((m) => m.date && quarterOf(m.date) === quarterOf(date));
        const m = there || await createMeeting(env, { date, by: 'Board', usual: true });
        if (!there) added += 1;
        if (m.invite?.eventId || m.inviteGone) continue;
        await sendInvite(env, m.id, { fetchImpl, now, by: 'Board' });
        invited += 1;
      } catch (err) {
        error = `${date}: ${String(err.message).slice(0, 200)}`;
        console.error('[board-schedule]', date, err.message);
      }
    }
    const at = new Date(now).toISOString();
    const state = await readState(env.DB, KEY);
    await writeState(env.DB, KEY, { ...state, years: { ...(state.years || {}), [year]: error ? { error, errorAt: at } : { doneAt: at, added, invited } } });
    if (!error) await logAudit(env.DB, { userEmail: 'Board', action: 'created', entityType: 'board', entitySlug: 'board', entityName: `Board meetings for ${year} added and invited`, gitStatus: 'ok' }).catch(() => {});
    return { year, added, invited, error };
  } catch (err) {
    console.error('[board-schedule]', err.message);
    return null;
  }
}

/** For Site → Automations: the last year that went, the next to go and when, and anything stuck (dates only, never a name) */
export async function scheduleStatus(DB, { now = Date.now() } = {}) {
  const years = (await readState(DB, KEY)).years || {};
  const done = Object.keys(years).filter((y) => years[y].doneAt).map(Number).sort((a, b) => a - b);
  const last = done.at(-1) || null;
  let next = Math.max(FIRST_YEAR, yearToSchedule(todayEastern(now)));
  if (years[next]?.doneAt) next += 1;
  return { next, on: sendsOn(next), last, lastAt: last ? years[last].doneAt : null, error: years[next]?.error ? String(years[next].error).replace(/\S+@\S+/g, '…').slice(0, 200) : null, errorAt: years[next]?.errorAt || null };
}
