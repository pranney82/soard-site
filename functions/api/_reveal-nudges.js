/**
 * Reveal checks (replaces the DataX "SOARD Reveal Nudges" agent)
 * ===========================================================================
 * Once each weekday after 8 AM Eastern, look at every open SOARD job's reveal
 * and leave one internal comment for the Project Manager when something needs
 * attention:
 *   1. the reveal date has passed but the Reveal task isn't marked complete
 *   2. the reveal is within 14 days and not confirmed
 *   3. it's confirmed but has no time
 *   4. schedule work ends after the reveal
 *   5. the Reveal Date field and the Reveal task disagree (not confirmed, so
 *      there's no telling which one is right)
 * The same issues are repeated every 3 days at most, or as soon as they
 * change. Comments are internal only (families can see customer-visible
 * comments) and titled "Reveal check (automatic)".
 *
 * The same run is the date sync's safety net: when a JobTread webhook was
 * missed and the answer is clear (the reveal is confirmed, so the field wins,
 * or one side is empty), it fixes the mismatch through ./_reveal-sync.js.
 *
 * Runs piggyback on site traffic (/api/reveals, admin loads), like the invite
 * safety sweep. Off until enabled in Reveals → Invites.
 */

import {
  SOARD_ORG_ID, FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED, todayEastern, longDay, daysBetween, easternParts, pave,
} from './_reveals.js';
import { planSync, syncJob, whenLabel } from './_reveal-sync.js';

const REVEAL_TASK_TYPE = '22NZSbkR5rZw';
const FIELD_STATUS = '22P52qfFub9b';
export const FIELD_PM = '22NMZbwAM7X5';
export const SANDBOX_JOB_ID = '22P3HTX9cXn4';
const SKIP_STATUSES = new Set(['Closed Done', 'Denied', 'Warranty', 'Awaiting Funding']);
const FOLLOW_UP = /check-?\s?up|warranty|survey|follow/i;
export const COMMENT_TITLE = 'Reveal check (automatic)';
const REPEAT_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 30 * 60 * 1000;
const CONFIG_KEY = 'reveal-nudges';
const RUN_FROM_HOUR = 8; // Eastern
const MAX_PAGES = 5;
const PARALLEL = 4;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reveal_nudges (
    job_id TEXT PRIMARY KEY, issues_key TEXT, message TEXT, posted_at INTEGER, updated_at TEXT)`,
];
const _schemaReady = new WeakSet();
async function ensureSchema(DB) {
  if (_schemaReady.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _schemaReady.add(DB);
}

export async function readNudgeConfig(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(CONFIG_KEY).first();
  let data = {};
  try { data = row ? JSON.parse(row.data) : {}; } catch { /* default */ }
  return { enabled: false, ...data };
}

export async function writeNudgeConfig(DB, patch) {
  const next = { ...(await readNudgeConfig(DB)), ...patch };
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(CONFIG_KEY, JSON.stringify(next), new Date().toISOString()).run();
  return next;
}

const fieldValues = (nodes) => Object.fromEntries((nodes || []).map(v => [v.customField?.id, v.value]));
const isYes = (v) => String(v || '').trim().toLowerCase().startsWith('yes');
const hhmm = (t) => (t && t !== 'null' ? String(t).slice(0, 5) : null);
const monthDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

/**
 * Should this job be checked at all? → { skip: reason } | { reveal, values, confirmed }
 */
export function screenJob(job, { allowSandbox = false } = {}) {
  if (!job) return { skip: 'job not found' };
  if (job.organization?.id && job.organization.id !== SOARD_ORG_ID) return { skip: 'not a SOARD job' };
  if (job.id === SANDBOX_JOB_ID && !allowSandbox) return { skip: 'office job' };
  if (job.closedOn) return { skip: 'closed' };
  const values = fieldValues(job.customFieldValues?.nodes);
  if (SKIP_STATUSES.has(values[FIELD_STATUS])) return { skip: `status is ${values[FIELD_STATUS]}` };
  const reveal = (job.tasks?.nodes || []).find(t => (t.progress ?? 0) < 1);
  if (!reveal) return { skip: 'no open Reveal task' };
  return { reveal, values, confirmed: isYes(values[FIELD_REVEAL_CONFIRMED]) };
}

/**
 * The issues for one job, in order. Pure.
 * `scheduleTasks` (the job's schedule) is needed for check 4 only.
 * → { skip } | { issues: [{ key, text }], pm, date }
 * `key` names the problem without the wording that changes daily ("11 days
 * away"), so the repeat rule compares problems, not sentences.
 */
export function checkJob(job, scheduleTasks, { today, allowSandbox = false } = {}) {
  const screen = screenJob(job, { allowSandbox });
  if (screen.skip) return screen;
  const { reveal, values, confirmed } = screen;
  const pm = String(values[FIELD_PM] || '').trim().split(/\s+/)[0] || '';
  const issues = [];

  const fieldIso = values[FIELD_REVEAL_DATE] || null;
  const field = fieldIso ? easternParts(fieldIso) : null;
  const R = reveal.startDate || null;
  const time = hhmm(reveal.startTime);

  // 5 first: when the two disagree, the other checks may be reading the wrong one
  if (!confirmed && R && field && (field.date !== R || (field.time || null) !== time)) {
    issues.push({
      key: `mismatch:${R} ${time || ''}|${field.date} ${field.time || ''}`,
      text: `The Reveal Date field says ${whenLabel(field.date, field.time)} but the Reveal task on the schedule says ${whenLabel(R, time)}. Change whichever one is wrong and the other will follow.`,
    });
  }
  if (!R) return { issues, pm, date: null };

  const days = daysBetween(today, R);
  if (R < today) {
    issues.push({
      key: `passed:${R}`,
      text: `The reveal date on the schedule (${longDay(R)}) has passed and the Reveal task isn't marked complete. If the reveal happened, mark the Reveal task complete. If it moved, update the Reveal Date.`,
    });
  }
  if (R >= today && days <= 14 && !confirmed) {
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `${days} days away`;
    issues.push({
      key: `unconfirmed:${R}`,
      text: `The reveal is ${longDay(R)}, ${when}, and isn't confirmed yet. Once the family confirms, set the time and mark Reveal Date Confirmed as Yes.`,
    });
  }
  if (confirmed && !time && R >= today) {
    issues.push({
      key: `no-time:${R}`,
      text: `The reveal is confirmed for ${longDay(R)} but doesn't have a time yet. Set the time on the Reveal task or the Reveal Date field.`,
    });
  }
  if (R >= today && scheduleTasks) {
    const late = scheduleTasks
      .filter(t => !t.isGroup && (t.progress ?? 0) < 1 && t.endDate && t.endDate > R && t.taskType?.id !== REVEAL_TASK_TYPE && !FOLLOW_UP.test(t.name || ''))
      .sort((a, b) => a.endDate.localeCompare(b.endDate));
    if (late.length) {
      const shown = late.slice(0, 5).map(t => `${t.name} (${monthDay(t.endDate)})`).join(', ');
      const more = late.length > 5 ? `, and ${late.length - 5} more` : '';
      issues.push({
        key: `late:${R}:${late.map(t => `${t.name}@${t.endDate}`).join(',')}`,
        text: `These tasks end after the reveal (${monthDay(R)}): ${shown}${more}. Move the reveal or the work so the room is finished first.`,
      });
    }
  }
  return { issues, pm, date: R };
}

/** The comment text: "Christian," (or "Team,") then one line per issue */
export function nudgeMessage(pm, issues) {
  return [`${pm || 'Team'},`, ...issues.map(i => i.text)].join('\n\n');
}

/**
 * A mismatch the date sync can settle on its own (a missed webhook):
 * confirmed means the field wins; one side empty means copy the other.
 * → the source to replay through syncJob, or null.
 */
export function repairSource(job) {
  const plan = planSync(job, 'task');
  if (!['write-field', 'write-task', 'snap-back'].includes(plan.action)) return null;
  const values = fieldValues(job.customFieldValues?.nodes);
  const task = (job.tasks?.nodes || []).find(t => (t.progress ?? 0) < 1);
  if (!values[FIELD_REVEAL_DATE]) return 'task';
  if (!task?.startDate) return 'field';
  // Confirmed: replaying as a task change puts the task back, with a comment saying so
  return isYes(values[FIELD_REVEAL_CONFIRMED]) ? 'task' : null;
}

const JOB_FIELDS = {
  id: {}, name: {}, closedOn: {}, organization: { id: {} },
  customFieldValues: { $: { size: 50 }, nodes: { value: {}, customField: { id: {} } } },
  tasks: {
    $: { size: 20, where: [['taskType', 'id'], '=', REVEAL_TASK_TYPE] },
    nodes: { id: {}, name: {}, startDate: {}, startTime: {}, endDate: {}, endTime: {}, progress: {}, taskType: { id: {} } },
  },
};

async function fetchJobById(key, id, fetchImpl) {
  const b = await pave(key, { job: { $: { id }, ...JOB_FIELDS } }, fetchImpl);
  return b?.job || null;
}

async function fetchOpenJobs(key, fetchImpl) {
  const jobs = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const b = await pave(key, {
      organization: {
        $: { id: SOARD_ORG_ID },
        jobs: { $: { size: 100, where: ['closedOn', '=', null], ...(page ? { page } : {}) }, nextPage: {}, nodes: JOB_FIELDS },
      },
    }, fetchImpl);
    const conn = b?.organization?.jobs;
    if (!conn) throw new Error('JobTread response had no jobs');
    jobs.push(...(conn.nodes || []));
    page = conn.nextPage || null;
    if (!page) break;
  }
  return jobs;
}

async function scheduleOf(key, jobId, fetchImpl) {
  const b = await pave(key, {
    job: { $: { id: jobId }, tasks: { $: { size: 100, where: ['isToDo', '=', false] }, nodes: { name: {}, endDate: {}, progress: {}, isGroup: {}, taskType: { id: {} } } } },
  }, fetchImpl);
  return b?.job?.tasks?.nodes || [];
}

/** Run `fn` over `items`, `n` at a time, keeping order */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * Check jobs, repair what the date sync can settle, and post comments.
 * `jobIds` limits it (the office sandbox can only be checked this way);
 * `dryRun` reports what would happen without writing anything.
 * → [{ jobId, name, action: 'skip'|'ok'|'repeat-skipped'|'would-post'|'posted'|'error', ... }]
 */
export async function runNudges(env, { fetchImpl = fetch, now = Date.now(), jobIds = null, dryRun = false } = {}) {
  const { DB, JOBTREAD_GRANT_KEY: key } = env;
  if (!key) throw new Error('JOBTREAD_GRANT_KEY is not set');
  await ensureSchema(DB);
  const today = todayEastern(now);
  const jobs = jobIds
    ? (await Promise.all(jobIds.map(id => fetchJobById(key, id, fetchImpl)))).filter(Boolean)
    : await fetchOpenJobs(key, fetchImpl);

  return pool(jobs, PARALLEL, async (job0) => {
    const allowSandbox = !!jobIds?.includes(job0.id);
    const base = { jobId: job0.id, name: job0.name };
    try {
      let job = job0;
      const screen = screenJob(job, { allowSandbox });
      if (screen.skip) return { ...base, action: 'skip', reason: screen.skip };

      // Safety net for the date sync: settle a clear mismatch first
      let repaired = null;
      const source = repairSource(job);
      if (source) {
        if (dryRun) {
          repaired = `would sync from the ${source === 'task' ? 'Reveal task' : 'Reveal Date field'}`;
        } else {
          const r = await syncJob(env, { jobId: job.id, source }, { fetchImpl, now });
          repaired = r.action;
          job = (await fetchJobById(key, job.id, fetchImpl)) || job;
        }
      }

      const first = checkJob(job, null, { today, allowSandbox });
      if (first.skip) return { ...base, action: 'skip', reason: first.skip, ...(repaired ? { repaired } : {}) };
      const schedule = first.date && first.date >= today ? await scheduleOf(key, job.id, fetchImpl) : null;
      const { issues, pm } = checkJob(job, schedule, { today, allowSandbox });
      const extra = { ...(repaired ? { repaired } : {}), date: first.date };
      if (!issues.length) return { ...base, action: 'ok', ...extra };

      const message = nudgeMessage(pm, issues);
      const issuesKey = issues.map(i => i.key).join('\n');
      const row = await DB.prepare('SELECT * FROM reveal_nudges WHERE job_id = ?').bind(job.id).first();
      if (row?.issues_key === issuesKey && now - (row.posted_at || 0) < REPEAT_AFTER_MS) {
        return { ...base, action: 'repeat-skipped', issues: issues.map(i => i.key.split(':')[0]), ...extra };
      }
      if (dryRun) return { ...base, action: 'would-post', message, ...extra };

      await pave(key, {
        createComment: {
          $: {
            targetType: 'job', targetId: job.id, name: COMMENT_TITLE, message,
            isVisibleToInternalRoles: true, isVisibleToCustomerRoles: false, isVisibleToVendorRoles: false,
          },
        },
      }, fetchImpl);
      await DB.prepare('INSERT OR REPLACE INTO reveal_nudges (job_id, issues_key, message, posted_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(job.id, issuesKey, message, now, new Date(now).toISOString()).run();
      return { ...base, action: 'posted', message, ...extra };
    } catch (err) {
      return { ...base, action: 'error', error: err.message };
    }
  });
}

/** Eastern weekday (0 Sun … 6 Sat) and hour at an instant */
function easternClock(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: Number(p.hour) };
}

export function summarize(results, now) {
  return {
    day: todayEastern(now), at: new Date(now).toISOString(),
    checked: results.filter(r => r.action !== 'skip').length,
    posted: results.filter(r => r.action === 'posted').length,
    repaired: results.filter(r => r.repaired && !String(r.repaired).startsWith('would')).length,
    errors: results.filter(r => r.action === 'error').length,
  };
}

/**
 * Once per weekday, the first site request after 8 AM Eastern runs the checks.
 * Claims the day before running so overlapping requests don't double up; if
 * JobTread is down, the claim is released and the next request after 30
 * minutes tries again. Never throws.
 */
export async function maybeNudge(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
  let config;
  try {
    config = await readNudgeConfig(env.DB);
    if (!config.enabled) return null;
    const { weekday, hour } = easternClock(now);
    if (weekday === 0 || weekday === 6 || hour < RUN_FROM_HOUR) return null;
    if (config.lastRun?.day === todayEastern(now)) return null;
    if (config.lastError && now - Date.parse(config.lastError.at) < RETRY_AFTER_MS) return null;
    await writeNudgeConfig(env.DB, { lastRun: { day: todayEastern(now), at: new Date(now).toISOString(), running: true } });
    const results = await runNudges(env, { fetchImpl, now });
    const lastRun = summarize(results, now);
    await writeNudgeConfig(env.DB, { lastRun, lastError: null });
    return lastRun;
  } catch (err) {
    // Release the day so a later request retries
    await writeNudgeConfig(env.DB, { lastRun: config?.lastRun || null, lastError: { at: new Date(now).toISOString(), error: err.message } }).catch(() => {});
    return null;
  }
}
