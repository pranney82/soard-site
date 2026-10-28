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
 * reveal feed (./_reveals.js) has the same rule. An organization's job that
 * belongs to its Community project has no kid page and no countdown, so it's
 * left out altogether rather than listed as a problem. Confirmed reveals that can't be
 * planned yet (no time, no kid page matches the job name, the kid page isn't
 * published) are listed for the admin on Reveals → Now, with the kid page filed
 * under the neighboring year when that's the likely mix-up (jobs carry the
 * application year, kid pages the reveal year). That stays a suggestion: a
 * countdown on the wrong kid's page is worse than none.
 *
 * Rehearsals: a job named "TEST …" (named after a kid, "TEST Isla Example (2026)")
 * runs the same path end to end, but its countdown is marked test: the public
 * never sees it (visibleState in _broadcast.js), reminders go to the test
 * address only, Kit is left alone, and any real reveal takes the slot first.
 *
 * Staff hear about it (Slack and the alert emails): the countdown going up,
 * moving or coming down, and once per problem, a confirmed reveal in the next
 * three weeks that can't have one.
 *
 * Runs on the live hub's heartbeat at most every 5 minutes, right away when a
 * JobTread workflow reports a reveal change (/api/reveal-sync, /api/reveal-invites),
 * and when staff open Reveals. Those two routes are public, so their wake-ups
 * (`wake`) read JobTread at most once a minute across the site; one turned away
 * inside that minute leaves a note, and the next heartbeat after it runs the
 * check. Changes go through adminAction() as "JobTread",
 * so reminders, Kit drafts, History and the audit log behave as they always did.
 * A JobTread read that fails changes nothing. Never throws.
 *
 * Last result: D1 site_config "broadcast-schedule".
 */

import { FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED, easternParts, todayEastern, matchKid, matchProject, isProject, parseJobName, fetchJobs, longDay, clockTime, loadProjects } from './_reveals.js';
import { SANDBOX_JOB_ID, isTestJob } from './_reveal-invites.js';
import { adminAction, readState, readConfig, ensureSchema, SITE_ORIGIN } from './_broadcast.js';
import { alertAdmins, slackResolved } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';

const RECORD_KEY = 'broadcast-schedule';
const LOCK_KEY = 'broadcast-schedule-lock';
const LOCK_MS = 60 * 1000;
const EVERY_MS = 5 * 60 * 1000;
// JobTread wake-ups (public routes) check JobTread at most this often, site-wide
const WAKE_KEY = 'broadcast-schedule-wake';         // when the next wake-up may check (ms)
const WAKE_OWED_KEY = 'broadcast-schedule-wake-owed'; // a wake-up turned away at this time (ms)
const WAKE_EVERY_MS = 60 * 1000;
// A replay hands the live page to the next reveal this close to its start
const REPLAY_HANDOFF_MS = 24 * 3600e3;
// ...once its recording is saved and its Reel is finished, or this long after it ended regardless
const REPLAY_WORK_MAX_MS = 6 * 3600e3;
// A stream this close before a reveal's start already was that reveal (it started early)
const HAPPENED_WINDOW_MS = 12 * 3600e3;
const REEL_FINISHED = new Set(['done', 'failed', 'skipped', 'blocked']);
const BY = 'JobTread';
// A confirmed reveal this close that can't have a countdown gets one alert per problem
const STUCK_ALERT_DAYS = 21;
const ADMIN_URL = `${SITE_ORIGIN}/admin/#broadcast`;
const jtSchedule = (jobId) => `https://app.jobtread.com/jobs/${jobId}/schedule`;

/** Every kid, drafts too, so a reveal can say "the kid page isn't published" */
async function allKids(DB) {
  const { results } = await DB.prepare('SELECT slug, name, year, data FROM kids').all();
  return (results || []).map((row) => {
    let d = {};
    try { d = JSON.parse(row.data || '{}'); } catch { /* columns are enough */ }
    return { slug: row.slug, name: d.name || row.name, year: row.year ?? d.year, draft: d.publishStatus === 'draft', jobtreadJobId: d.jobtreadJobId || null };
  });
}

/**
 * Confirmed reveals from today on, soonest first:
 * { jobId, jobName, slug, name, startsAt, date, time, problem }
 * problem: null (can be planned) | 'no-time' | 'no-kid' | 'draft'
 * `projects` (community projects, kind 'community'): their jobs are left out.
 */
export function confirmedReveals(jobs, kids, now = Date.now(), projects = []) {
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
    if (projects.length && isProject(matchProject(job.name, [...kids, ...projects], job.id))) continue;
    const kid = matchKid(job.name, published, job.id);
    const draft = kid ? null : matchKid(job.name, drafts, job.id);
    // No kid that year: is there exactly one under the year before or after? (suggested, never used)
    const year = parseJobName(job.name).year;
    const near = kid || draft || !year ? null : matchKid(job.name, published.filter((k) => Math.abs(Number(k.year) - year) === 1).map((k) => ({ ...k, year, filedUnder: Number(k.year) })));
    out.push({
      jobId: job.id,
      jobName: job.name,
      slug: (kid || draft)?.slug || null,
      name: (kid || draft)?.name || null,
      startsAt: new Date(values[FIELD_REVEAL_DATE]).toISOString(),
      date: parts.date,
      time: parts.time,
      problem: draft ? 'draft' : !kid ? 'no-kid' : !parts.time ? 'no-time' : null,
      ...(near ? { nearMiss: { slug: near.slug, name: near.name, year: near.filedUnder } } : {}),
      ...(isTestJob(job) ? { test: true } : {}),
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
  // A real reveal always comes first; a rehearsal only gets the slot when nothing real is planned
  const ready = reveals.filter((r) => !r.problem && Date.parse(r.startsAt) > now && !wentLive(r));
  const next = ready.find((r) => !r.test) || ready[0] || null;
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

/**
 * The wake-up slot: true for the first wake-up in a minute (one conditional
 * write, so simultaneous wake-ups can't both take it).
 */
async function claimWake(DB, now) {
  const next = String(now + WAKE_EVERY_MS);
  const at = new Date(now).toISOString();
  const ins = await DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(WAKE_KEY, next, at).run();
  if ((ins?.meta?.changes || 0) > 0) return true;
  const upd = await DB.prepare('UPDATE site_config SET data = ?, updated_at = ? WHERE key = ? AND CAST(data AS INTEGER) <= ?').bind(next, at, WAKE_KEY, now).run();
  return (upd?.meta?.changes || 0) > 0;
}

/** A wake-up turned away: the next heartbeat owes a check (the earliest note stands) */
const oweWake = (DB, now) => DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(WAKE_OWED_KEY, String(now), new Date(now).toISOString()).run();
const wakeOwed = async (DB) => Number((await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(WAKE_OWED_KEY).first())?.data) || 0;
/** A check that started at `startedAt` covers every wake-up turned away before it */
const payWake = (DB, startedAt) => DB.prepare('DELETE FROM site_config WHERE key = ? AND CAST(data AS INTEGER) <= ?').bind(WAKE_OWED_KEY, startedAt).run();

/** A JobTread wake-up waits its turn (it may carry the newer change); a heartbeat just skips */
async function waitForLock(DB, wait) {
  for (let i = 0; i < (wait ? 8 : 1); i++) {
    if (i) await new Promise((r) => setTimeout(r, 2500));
    if (await takeLock(DB)) return true;
  }
  return false;
}

const brief = (r) => (r ? { jobId: r.jobId, jobName: r.jobName, slug: r.slug, name: r.name, startsAt: r.startsAt, date: r.date, time: r.time, ...(r.problem ? { problem: r.problem } : {}), ...(r.nearMiss ? { nearMiss: r.nearMiss } : {}), ...(r.test ? { test: true } : {}) } : null);

const whenText = (r) => `${longDay(r.date)}${r.time ? ` at ${clockTime(r.time)}` : ''}`;

/** What's wrong with a confirmed reveal that can't have a countdown, and the fix (also shown in the admin) */
export function stuckText(r) {
  const when = longDay(r.date);
  if (r.problem === 'no-time') return { detail: `${r.name}'s reveal is confirmed for ${when} but has no time, so its countdown can't go up.`, fix: 'Add the time to the Reveal task in JobTread.' };
  if (r.problem === 'draft') return { detail: `${r.name}'s reveal is confirmed for ${when}, but ${r.name}'s kid page isn't published, so the countdown can't go up.`, fix: `Publish ${r.name}'s page under Kids in the admin.` };
  if (r.nearMiss) return { detail: `"${r.jobName}" is confirmed for ${when}, but no kid page is filed under ${parseJobName(r.jobName).year} with that name. ${r.nearMiss.name}'s page is filed under ${r.nearMiss.year}.`, fix: `Make the years agree: change the year in the JobTread job name, or on ${r.nearMiss.name}'s kid page.` };
  return { detail: `"${r.jobName}" is confirmed for ${when}, but no published kid page matches that job name, so the countdown can't go up.`, fix: 'The job name needs the kid\'s name and year, like "Max Sample (2026)". A room for an organization has no kid page and no countdown.' };
}

/** Tell staff what the countdown did on its own, and about reveals it can't follow. Never throws. */
async function tellStaff(env, { plan, before, result, reveals, alerted, now }) {
  const config = await readConfig(env.DB).catch(() => null);
  const sends = [];
  const t = plan.target;
  const tag = (x) => (x?.test ? 'TEST · ' : '');
  const rehearsal = ' This is a rehearsal from a TEST job: nothing shows on the public site, and reminders go only to the test address.';
  if (result?.success && plan.action === 'schedule') {
    sends.push({ level: 'info', kind: t.test ? 'attention' : 'news', icon: '⏳', title: `${tag(t)}Countdown is up: ${t.name}'s reveal`, detail: `${whenText(t)}. It's confirmed in JobTread, so the site put up the countdown and reminder signup. Reminders go out the day before and an hour before.${t.test ? rehearsal : ''}${before.phase === 'scheduled' || before.phase === 'armed' ? ` It replaces ${before.kidName || 'the reveal'} planned before it.` : ''}`, url: ADMIN_URL, links: [{ label: 'Live page', url: `${SITE_ORIGIN}/live/${t.slug}/` }, { label: 'JobTread schedule', url: jtSchedule(t.jobId) }] });
  } else if (result?.success && plan.action === 'update' && before.scheduledAt !== t.startsAt) {
    const from = easternParts(before.scheduledAt);
    const fromText = from ? `${longDay(from.date)}${from.time ? ` at ${clockTime(from.time)}` : ''}` : 'its old time';
    const newDay = from?.date !== t.date;
    sends.push({ level: 'info', kind: before.test ? 'attention' : 'news', icon: '📅', title: `${tag(before)}Reveal moved: ${t.name}`, detail: `From ${fromText} to ${whenText(t)}, as changed in JobTread. The countdown follows.${newDay ? ' Everyone who signed up for reminders hears about the new date, and the day-before and hour-before reminders go out for it.' : ''}`, url: ADMIN_URL, links: [{ label: 'JobTread schedule', url: jtSchedule(t.jobId) }] });
  } else if (result?.success && plan.action === 'cancel') {
    sends.push({ level: before.test ? 'info' : 'warn', title: `${tag(before)}Countdown taken down: ${before.kidName || 'the reveal'}`, detail: 'It is no longer confirmed with a time in JobTread, so the countdown and reminder signup came off the site. Reminders already sent can\'t be recalled.', url: ADMIN_URL, links: before.jobId ? [{ label: 'JobTread schedule', url: jtSchedule(before.jobId) }] : [] });
  }
  if (result && !result.success) {
    sends.push({ level: 'warn', title: 'Countdown couldn\'t follow JobTread', detail: `Tried to ${plan.action} ${t?.name ? `${t.name}'s reveal` : 'the countdown'}: ${result.error}`, url: ADMIN_URL });
  }
  // Confirmed reveals in the next three weeks that can't have a countdown: once per problem
  const soon = new Date(now + STUCK_ALERT_DAYS * 86400e3).toISOString().slice(0, 10);
  const next = {};
  for (const r of reveals.filter((x) => x.problem && x.date <= soon)) {
    const key = `${r.jobId}:${r.problem}:${r.date}`;
    next[key] = alerted?.[key] || new Date(now).toISOString();
    if (alerted?.[key]) continue;
    const { detail, fix } = stuckText(r);
    sends.push({ level: 'warn', title: `${tag(r)}No countdown yet: ${r.name || r.jobName}`, detail, fix, url: ADMIN_URL, links: [{ label: 'JobTread schedule', url: jtSchedule(r.jobId) }], issue: `countdown:${key}` });
  }
  for (const a of sends) await alertAdmins(env, config, a).catch(() => {});
  // A problem that went away: its Slack post turns ✅ (Slack only; the email said nothing needs undoing)
  for (const key of Object.keys(alerted || {}).filter((k) => !next[k])) {
    const jobId = key.split(':')[0];
    const r = reveals.find((x) => String(x.jobId) === jobId);
    const name = r?.name || r?.jobName || 'the reveal';
    const [title, why] = !r ? [`Nothing to fix now: ${name}`, 'It\'s no longer a confirmed reveal in the next three weeks.']
      : r.problem ? [`Changed: ${name}`, 'It has a different problem now: see the newer post.']
      : [`Countdown unblocked: ${name}`, 'JobTread and the site agree now, so the countdown goes up when it\'s the next reveal.'];
    await slackResolved(env, `countdown:${key}`, slackCard({ icon: '✅', title, lead: why }), { summary: why }).catch(() => null);
  }
  return next;
}

/**
 * Bring the live broadcast in line with JobTread. Skips when it ran in the last
 * `minIntervalMs` unless `force` (staff). `wake`: a JobTread wake-up from a
 * public route, which checks at once if no wake-up has in the last minute,
 * and otherwise leaves the check owed to the next heartbeat. Returns
 * { action, record } (action 'skipped' or 'error' included); never throws.
 */
export async function syncBroadcastSchedule(env, { fetchImpl = fetch, now = Date.now(), force = false, wake = false, minIntervalMs = EVERY_MS } = {}) {
  const DB = env.DB;
  let prev = null;
  let locked = false;
  try {
    prev = await readRecord(DB);
    if (wake && !force) {
      if (!(await claimWake(DB, now))) {
        await oweWake(DB, now);
        return { action: 'skipped', reason: 'a wake-up checked in the last minute', record: prev };
      }
      force = true;
    } else if (!force) {
      // A wake-up was turned away since the last check: run as soon as the slot frees
      const owed = await wakeOwed(DB);
      if (owed && owed >= Date.parse(prev?.checkedAt || 0) && await claimWake(DB, now)) force = true;
    }
    if (!force && prev?.checkedAt && now - Date.parse(prev.checkedAt) < minIntervalMs) return { action: 'skipped', record: prev };
    if (!env.JOBTREAD_GRANT_KEY) throw new Error('JOBTREAD_GRANT_KEY is not set');
    if (!(await waitForLock(DB, force))) return { action: 'skipped', reason: 'another check is running', record: prev };
    locked = true;
    prev = await readRecord(DB);
    await ensureSchema(DB);
    const [jobs, kids, projects, state, recent] = await Promise.all([
      fetchJobs(env.JOBTREAD_GRANT_KEY, fetchImpl),
      allKids(DB),
      loadProjects(DB, { drafts: true }),
      readState(DB),
      DB.prepare('SELECT kid_slug, live_at FROM broadcasts WHERE live_at IS NOT NULL AND live_at >= ?').bind(new Date(now - 2 * 86400e3).toISOString()).all(),
    ]);
    const reveals = confirmedReveals(jobs, kids, now, projects);
    const happened = (recent.results || []).map((r) => ({ kidSlug: r.kid_slug, liveAt: r.live_at }));
    const plan = planBroadcast(state, reveals, { now, happened });

    let result = null;
    const before = { ...state };
    if (plan.action === 'schedule') result = await adminAction(env, 'schedule', { kidSlug: plan.target.slug, scheduledAt: plan.target.startsAt, jobId: plan.target.jobId, test: !!plan.target.test }, BY);
    else if (plan.action === 'update') result = await adminAction(env, 'update', { scheduledAt: plan.target.startsAt, jobId: plan.target.jobId }, BY);
    else if (plan.action === 'cancel') result = await adminAction(env, 'cancel', {}, BY);

    const at = new Date(now).toISOString();
    const alerted = await tellStaff(env, { plan, before, result, reveals, alerted: prev?.alerted || {}, now }).catch(() => prev?.alerted || {});
    const record = {
      checkedAt: at,
      error: null,
      next: brief(plan.next),
      waiting: reveals.filter((r) => r.problem).map(brief),
      alerted,
      last: plan.action === 'none' ? prev?.last || null : {
        action: plan.action, at, reason: plan.reason, reveal: brief(plan.target),
        ...(result && !result.success ? { error: result.error } : {}),
      },
    };
    await writeRecord(DB, record);
    await payWake(DB, now);
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
