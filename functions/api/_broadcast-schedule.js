/**
 * The live broadcast follows JobTread
 * ===========================================================================
 * JobTread decides the next reveal: an open job whose Reveal Date Confirmed is
 * Yes and whose Reveal Date has a time. This keeps the live broadcast (the
 * countdown, reminder signup, starting-soon screen, reminders and the Kit
 * "we're live" email) in step with it, so nobody schedules reveals in the admin:
 *
 *   nothing planned               → plan the next confirmed reveal
 *   its time moves on the same day → move it (reminders already sent stand)
 *   its date moves                → move it; reminders re-arm, subscribers hear the new date
 *   another reveal is now sooner  → plan that one instead
 *   unconfirmed, or time cleared  → take the countdown down
 *   live, or past its start time  → leave it alone (the stream decides now),
 *                                   except to follow a new time for the same reveal
 *   replay showing                → the next reveal takes over in its last 24 hours,
 *                                   once the replay is saved and its Reel is finished
 *
 * Only published kids are planned: the countdown names the kid, and the public
 * reveal feed (./_reveals.js) has the same rule. Confirmed reveals that can't be
 * planned yet (no time, no kid page matches the job name, the kid page isn't
 * published) are listed for the admin on Reveals → Now.
 *
 * Runs on the live hub's heartbeat at most every 5 minutes, right away when a
 * JobTread workflow reports a reveal change (/api/reveal-sync, /api/reveal-invites),
 * and when staff open Reveals. Changes go through adminAction() as "JobTread",
 * so reminders, Kit drafts, History and the audit log behave as they always did.
 * A JobTread read that fails changes nothing. Never throws.
 *
 * Last result: D1 site_config "broadcast-schedule".
 */

import { FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED, easternParts, todayEastern, matchKid, fetchJobs } from './_reveals.js';
import { SANDBOX_JOB_ID } from './_reveal-invites.js';
import { adminAction, readState, ensureSchema } from './_broadcast.js';

const RECORD_KEY = 'broadcast-schedule';
const LOCK_KEY = 'broadcast-schedule-lock';
const LOCK_MS = 60 * 1000;
const EVERY_MS = 5 * 60 * 1000;
// A replay hands the live page to the next reveal this close to its start
const REPLAY_HANDOFF_MS = 24 * 3600e3;
// ...once its recording is saved and its Reel is finished, or this long after it ended regardless
const REPLAY_WORK_MAX_MS = 6 * 3600e3;
// A stream this close before a reveal's start already was that reveal (it started early)
const HAPPENED_WINDOW_MS = 12 * 3600e3;
const REEL_FINISHED = new Set(['done', 'failed', 'skipped', 'blocked']);
const BY = 'JobTread';

/** Every kid, drafts too, so a reveal can say "the kid page isn't published" */
async function allKids(DB) {
  const { results } = await DB.prepare('SELECT slug, name, year, data FROM kids').all();
  return (results || []).map((row) => {
    let d = {};
    try { d = JSON.parse(row.data || '{}'); } catch { /* columns are enough */ }
    return { slug: row.slug, name: d.name || row.name, year: row.year ?? d.year, draft: d.publishStatus === 'draft' };
  });
}

/**
 * Confirmed reveals from today on, soonest first:
 * { jobId, jobName, slug, name, startsAt, date, time, problem }
 * problem: null (can be planned) | 'no-time' | 'no-kid' | 'draft'
 */
export function confirmedReveals(jobs, kids, now = Date.now()) {
  const today = todayEastern(now);
  const published = kids.filter((k) => !k.draft);
  const drafts = kids.filter((k) => k.draft);
  const out = [];
  for (const job of jobs) {
    if (job.id === SANDBOX_JOB_ID) continue;
    const values = {};
    for (const v of job.customFieldValues?.nodes || []) values[v.customField?.id] = v.value;
    if (!String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes')) continue;
    const parts = values[FIELD_REVEAL_DATE] ? easternParts(values[FIELD_REVEAL_DATE]) : null;
    if (!parts || parts.date < today) continue;
    const kid = matchKid(job.name, published);
    const draft = kid ? null : matchKid(job.name, drafts);
    out.push({
      jobId: job.id,
      jobName: job.name,
      slug: (kid || draft)?.slug || null,
      name: (kid || draft)?.name || null,
      startsAt: new Date(values[FIELD_REVEAL_DATE]).toISOString(),
      date: parts.date,
      time: parts.time,
      problem: draft ? 'draft' : !kid ? 'no-kid' : !parts.time ? 'no-time' : null,
    });
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** The replay's own work (saving the recording, the Instagram Reel) is finished */
function replayDone(state, now) {
  if (state.source !== 'stream') return true;
  if (state.endedAt && now - Date.parse(state.endedAt) > REPLAY_WORK_MAX_MS) return true;
  if (!state.replayUid) return false;
  return !state.reel || REEL_FINISHED.has(state.reel.stage);
}

/**
 * What the broadcast should do, given its state and JobTread's confirmed reveals.
 * happened: recent streams [{ kidSlug, liveAt }], so a reveal that went live
 * early isn't planned a second time.
 * → { action: 'none' | 'schedule' | 'update' | 'cancel', target, next, reason }
 */
export function planBroadcast(state, reveals, { now = Date.now(), happened = [] } = {}) {
  const phase = state.phase || 'idle';
  const wentLive = (r) => happened.some((h) => h.kidSlug === r.slug && Date.parse(h.liveAt) >= Date.parse(r.startsAt) - HAPPENED_WINDOW_MS);
  const next = reveals.find((r) => !r.problem && Date.parse(r.startsAt) > now && !wentLive(r)) || null;
  const none = (reason) => ({ action: 'none', target: null, next, reason });

  if (phase === 'live' || phase === 'ending') return none('live now');

  if (phase === 'scheduled' || phase === 'armed') {
    // The reveal planned now, as JobTread has it (matched by job; by kid for one planned before JobTread did this)
    const mine = (r) => (state.jobId ? r.jobId === state.jobId : !!state.kidSlug && r.slug === state.kidSlug);
    const current = reveals.find((r) => !r.problem && mine(r)) || null;
    const follow = (r) => (r.startsAt === state.scheduledAt && state.jobId === r.jobId
      ? none('up to date')
      : { action: 'update', target: r, next, reason: r.startsAt === state.scheduledAt ? 'linked to its job' : 'time changed in JobTread' });
    if (state.scheduledAt && Date.parse(state.scheduledAt) <= now) {
      // Past its start: the crew may be about to stream, so only follow a new time for this same reveal
      return current ? follow(current) : none('past its start time');
    }
    if (!next) return { action: 'cancel', target: null, next, reason: 'no confirmed reveal with a time in JobTread' };
    if (current && current.jobId === next.jobId) return follow(current);
    return { action: 'schedule', target: next, next, reason: current ? 'another reveal is sooner' : 'not confirmed in JobTread any more' };
  }

  if (!next) return none('no confirmed reveal with a time in JobTread');
  if (phase === 'replay') {
    if (Date.parse(next.startsAt) - now > REPLAY_HANDOFF_MS) return none('replay showing until the day before the next reveal');
    if (!replayDone(state, now)) return none('replay still being saved');
  }
  return { action: 'schedule', target: next, next, reason: 'next confirmed reveal' };
}

async function readRecord(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(RECORD_KEY).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

async function writeRecord(DB, record) {
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(RECORD_KEY, JSON.stringify(record), record.checkedAt).run();
}

export const readScheduleRecord = (DB) => readRecord(DB).catch(() => null);

/**
 * One run at a time. A date and Confirmed set together send two JobTread
 * wake-ups at once, and two runs planning the same reveal would send two
 * save-the-date emails. The lock is a site_config row holding its expiry, so a
 * crashed run frees it within a minute.
 */
async function takeLock(DB) {
  const now = Date.now();
  const until = String(now + LOCK_MS);
  const at = new Date(now).toISOString();
  const ins = await DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(LOCK_KEY, until, at).run();
  if ((ins?.meta?.changes || 0) > 0) return true;
  const upd = await DB.prepare('UPDATE site_config SET data = ?, updated_at = ? WHERE key = ? AND CAST(data AS INTEGER) < ?').bind(until, at, LOCK_KEY, now).run();
  return (upd?.meta?.changes || 0) > 0;
}

const releaseLock = (DB) => DB.prepare("UPDATE site_config SET data = '0' WHERE key = ?").bind(LOCK_KEY).run().catch(() => {});

/** A JobTread wake-up waits its turn (it may carry the newer change); a heartbeat just skips */
async function waitForLock(DB, wait) {
  for (let i = 0; i < (wait ? 8 : 1); i++) {
    if (i) await new Promise((r) => setTimeout(r, 2500));
    if (await takeLock(DB)) return true;
  }
  return false;
}

const brief = (r) => (r ? { jobId: r.jobId, jobName: r.jobName, slug: r.slug, name: r.name, startsAt: r.startsAt, date: r.date, time: r.time, ...(r.problem ? { problem: r.problem } : {}) } : null);

/**
 * Bring the live broadcast in line with JobTread. Skips when it ran in the last
 * `minIntervalMs` unless `force`. Returns { action, record } (action 'skipped'
 * or 'error' included); never throws.
 */
export async function syncBroadcastSchedule(env, { fetchImpl = fetch, now = Date.now(), force = false, minIntervalMs = EVERY_MS } = {}) {
  const DB = env.DB;
  let prev = null;
  let locked = false;
  try {
    prev = await readRecord(DB);
    if (!force && prev?.checkedAt && now - Date.parse(prev.checkedAt) < minIntervalMs) return { action: 'skipped', record: prev };
    if (!env.JOBTREAD_GRANT_KEY) throw new Error('JOBTREAD_GRANT_KEY is not set');
    if (!(await waitForLock(DB, force))) return { action: 'skipped', reason: 'another check is running', record: prev };
    locked = true;
    prev = await readRecord(DB);
    await ensureSchema(DB);
    const [jobs, kids, state, recent] = await Promise.all([
      fetchJobs(env.JOBTREAD_GRANT_KEY, fetchImpl),
      allKids(DB),
      readState(DB),
      DB.prepare('SELECT kid_slug, live_at FROM broadcasts WHERE live_at IS NOT NULL AND live_at >= ?').bind(new Date(now - 2 * 86400e3).toISOString()).all(),
    ]);
    const reveals = confirmedReveals(jobs, kids, now);
    const happened = (recent.results || []).map((r) => ({ kidSlug: r.kid_slug, liveAt: r.live_at }));
    const plan = planBroadcast(state, reveals, { now, happened });

    let result = null;
    if (plan.action === 'schedule') result = await adminAction(env, 'schedule', { kidSlug: plan.target.slug, scheduledAt: plan.target.startsAt, jobId: plan.target.jobId }, BY);
    else if (plan.action === 'update') result = await adminAction(env, 'update', { scheduledAt: plan.target.startsAt, jobId: plan.target.jobId }, BY);
    else if (plan.action === 'cancel') result = await adminAction(env, 'cancel', {}, BY);

    const at = new Date(now).toISOString();
    const record = {
      checkedAt: at,
      error: null,
      next: brief(plan.next),
      waiting: reveals.filter((r) => r.problem).map(brief),
      last: plan.action === 'none' ? prev?.last || null : {
        action: plan.action, at, reason: plan.reason, reveal: brief(plan.target),
        ...(result && !result.success ? { error: result.error } : {}),
      },
    };
    await writeRecord(DB, record);
    return { action: result && !result.success ? 'error' : plan.action, reason: plan.reason, record };
  } catch (err) {
    // Keep what was last known; the admin shows the error and the next run tries again
    const record = { ...(prev || {}), checkedAt: new Date(now).toISOString(), error: err.message };
    await writeRecord(DB, record).catch(() => {});
    return { action: 'error', error: err.message, record };
  } finally {
    if (locked) await releaseLock(DB);
  }
}
