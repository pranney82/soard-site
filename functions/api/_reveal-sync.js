/**
 * Reveal date sync (replaces the DataX "SOARD Reveal Date Sync" agent)
 * ===========================================================================
 * Keeps two things on a SOARD JobTread job the same:
 *   - the "Reveal Date" job field (a UTC date-time), and
 *   - the job's Reveal task (task type Reveal): Eastern local start date/time.
 * A Reveal task with no time is the field at 12:00 AM Eastern ("no time yet").
 *
 * JobTread workflows POST { eventId, source: 'task' | 'field', jobId, ... } to
 * /api/reveal-sync when either side changes. Everything is re-read from
 * JobTread before deciding, so the post only says "look at this job".
 *
 * Who wins:
 *   - Not confirmed: the side that just changed. Copy it to the other.
 *   - Confirmed ("Reveal Date Confirmed" = Yes): the field is the authority.
 *     A field change moves the task. A task move (usually JobTread shifting
 *     it because an earlier task moved) is put back, with an internal comment.
 *   - One side empty: copy the side that has a date.
 *
 * Echoes: writing one side makes JobTread fire the workflow for that side.
 * We remember what we wrote (D1 reveal_sync) and ignore exactly that event,
 * so it can never undo a person's quick second edit.
 */

import {
  SOARD_ORG_ID, FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED,
  easternParts, easternToUtcIso, longDay, clockTime, pave,
} from './_reveals.js';

const REVEAL_TASK_TYPE = '22NZSbkR5rZw';
const ECHO_WINDOW_MS = 10 * 60 * 1000;
const COMMENT_TITLE = 'Reveal date sync (automatic)';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reveal_sync (
    job_id TEXT PRIMARY KEY, wrote_side TEXT, wrote_value TEXT, wrote_at INTEGER,
    last_action TEXT, last_note TEXT, note_at INTEGER, updated_at TEXT)`,
];
const _schemaReady = new WeakSet();
async function ensureSchema(DB) {
  if (_schemaReady.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _schemaReady.add(DB);
}

const hhmm = (t) => (t && t !== 'null' ? String(t).slice(0, 5) : null);
const fieldValues = (nodes) => Object.fromEntries((nodes || []).map(v => [v.customField?.id, v.value]));
const isYes = (v) => String(v || '').trim().toLowerCase().startsWith('yes');

/** How a side's value is remembered, so its echo can be recognised */
export const taskKey = (date, time) => `${date || ''} ${hhmm(time) || ''}`.trim();
export const fieldKey = (iso) => {
  const d = iso && iso !== 'null' ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
};

function plusHour(time) {
  const [h, m] = time.split(':').map(Number);
  return `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "Tuesday, November 18 at 3:00 PM" or "Tuesday, November 18 (time not set yet)" */
export function whenLabel(date, time) {
  return time ? `${longDay(date)} at ${clockTime(time)}` : `${longDay(date)} (time not set yet)`;
}

export async function fetchSyncJob(grantKey, jobId, fetchImpl = fetch) {
  const body = await pave(grantKey, {
    job: {
      $: { id: jobId },
      id: {}, name: {}, closedOn: {}, organization: { id: {} },
      customFieldValues: { $: { size: 50 }, nodes: { value: {}, customField: { id: {} } } },
      tasks: {
        $: { size: 20, where: [['taskType', 'id'], '=', REVEAL_TASK_TYPE] },
        nodes: { id: {}, name: {}, startDate: {}, startTime: {}, endDate: {}, endTime: {}, progress: {} },
      },
    },
  }, fetchImpl);
  return body?.job || null;
}

/**
 * Decide what to do. Pure. Returns one of:
 *   { action: 'none', reason }
 *   { action: 'write-field', value }                       copy the task to the field
 *   { action: 'write-task', task, date, time, endTime }    copy the field to the task
 *   { action: 'snap-back', task, date, time, endTime, moved }  confirmed: put the task back
 *   { action: 'note', reason, message }                    can't sync; tell the team once
 */
export function planSync(job, source) {
  if (!job) return { action: 'none', reason: 'job not found' };
  if (job.organization?.id && job.organization.id !== SOARD_ORG_ID) return { action: 'none', reason: 'not a SOARD job' };

  const reveals = job.tasks?.nodes || [];
  const open = reveals.filter(t => (t.progress ?? 0) < 1);
  const values = fieldValues(job.customFieldValues?.nodes);
  if (!reveals.length) {
    // Nothing on either side is nothing to sync, not a problem worth a note
    if (!values[FIELD_REVEAL_DATE]) return { action: 'none', reason: 'no Reveal task and no Reveal Date' };
    return { action: 'note', reason: 'no Reveal task', message: 'There\'s no Reveal task on this job, so the Reveal Date can\'t sync to the schedule. Add a task with the task type "Reveal".' };
  }
  if (!open.length) return { action: 'none', reason: 'the reveal is marked complete' };
  if (open.length > 1) {
    return { action: 'note', reason: 'several open Reveal tasks', message: `This job has ${open.length} open Reveal tasks, so the Reveal Date can't tell which one to follow. Delete the extra one or mark it complete.` };
  }
  const task = open[0];
  const confirmed = isYes(values[FIELD_REVEAL_CONFIRMED]);
  const fieldIso = values[FIELD_REVEAL_DATE] || null;
  const field = fieldIso ? easternParts(fieldIso) : null;
  const taskSide = { date: task.startDate || null, time: hhmm(task.startTime) };

  if (!taskSide.date && !field) return { action: 'none', reason: 'no date on either side' };
  if (field && taskSide.date === field.date && (taskSide.time || null) === (field.time || null)) return { action: 'none', reason: 'already in sync' };

  const toField = () => ({ action: 'write-field', value: easternToUtcIso(taskSide.date, taskSide.time) });
  const toTask = (action = 'write-task', extra = {}) => {
    // Keep the task's own end time when it's later the same day; otherwise an hour
    const endTime = field.time
      ? (hhmm(task.endTime) && hhmm(task.endTime) > field.time && (task.endDate || task.startDate) === field.date ? hhmm(task.endTime) : plusHour(field.time))
      : null;
    return { action, task, date: field.date, time: field.time, endTime, ...extra };
  };

  if (!field) return toField();
  if (!taskSide.date) return toTask();
  if (confirmed) {
    return source === 'field' ? toTask() : toTask('snap-back', { moved: { date: taskSide.date, time: taskSide.time } });
  }
  return source === 'field' ? toTask() : toField();
}

async function readRow(DB, jobId) {
  return DB.prepare('SELECT * FROM reveal_sync WHERE job_id = ?').bind(jobId).first();
}

async function writeRow(DB, jobId, patch) {
  const row = (await readRow(DB, jobId)) || {};
  const next = { ...row, ...patch };
  await DB.prepare(`INSERT OR REPLACE INTO reveal_sync (job_id, wrote_side, wrote_value, wrote_at, last_action, last_note, note_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(jobId, next.wrote_side ?? null, next.wrote_value ?? null, next.wrote_at ?? null, next.last_action ?? null,
      next.last_note ?? null, next.note_at ?? null, new Date().toISOString()).run();
}

async function postComment(grantKey, jobId, message, fetchImpl) {
  await pave(grantKey, {
    createComment: {
      $: {
        targetType: 'job', targetId: jobId, name: COMMENT_TITLE, message,
        isVisibleToInternalRoles: true, isVisibleToCustomerRoles: false, isVisibleToVendorRoles: false,
      },
    },
  }, fetchImpl);
}

/**
 * Handle one wake-up from JobTread. `payload` is what the workflow sent:
 * { source, jobId, taskStartDate?, taskStartTime?, revealDate? }.
 */
export async function syncJob(env, payload, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB, JOBTREAD_GRANT_KEY: key } = env;
  const jobId = payload.jobId;
  const source = payload.source === 'field' ? 'field' : 'task';
  await ensureSchema(DB);

  // Our own write coming back? Ignore exactly that, nothing else.
  const row = await readRow(DB, jobId);
  const incoming = source === 'task' ? taskKey(payload.taskStartDate, payload.taskStartTime) : fieldKey(payload.revealDate);
  if (incoming && row?.wrote_side === source && row.wrote_value === incoming && now - (row.wrote_at || 0) < ECHO_WINDOW_MS) {
    await writeRow(DB, jobId, { wrote_side: null, wrote_value: null, wrote_at: null });
    return { jobId, action: 'echo' };
  }

  const job = await fetchSyncJob(key, jobId, fetchImpl);
  const plan = planSync(job, source);

  if (plan.action === 'none') return { jobId, action: 'none', reason: plan.reason };

  if (plan.action === 'note') {
    // Say it once per problem, not on every change
    if (row?.last_note !== plan.message) {
      await postComment(key, jobId, plan.message, fetchImpl);
      await writeRow(DB, jobId, { last_action: `note: ${plan.reason}`, last_note: plan.message, note_at: now });
      return { jobId, action: 'noted', reason: plan.reason };
    }
    return { jobId, action: 'none', reason: plan.reason };
  }

  if (plan.action === 'write-field') {
    await pave(key, { updateJob: { $: { id: jobId, customFieldValues: { [FIELD_REVEAL_DATE]: plan.value } } } }, fetchImpl);
    await writeRow(DB, jobId, { wrote_side: 'field', wrote_value: fieldKey(plan.value), wrote_at: now, last_action: `field set to ${plan.value}`, last_note: null });
    return { jobId, action: 'task-to-field', value: plan.value };
  }

  // write-task or snap-back
  await pave(key, {
    updateTask: {
      $: {
        id: plan.task.id, notify: false,
        startDate: plan.date, endDate: plan.date,
        startTime: plan.time || null, endTime: plan.time ? plan.endTime : null,
      },
    },
  }, fetchImpl);
  await writeRow(DB, jobId, { wrote_side: 'task', wrote_value: taskKey(plan.date, plan.time), wrote_at: now, last_action: `${plan.action === 'snap-back' ? 'task put back to' : 'task moved to'} ${taskKey(plan.date, plan.time)}`, last_note: null });

  if (plan.action === 'snap-back') {
    const message = `This reveal is confirmed for ${whenLabel(plan.date, plan.time)}. The schedule moved it to ${whenLabel(plan.moved.date, plan.moved.time)}, usually because an earlier task moved. I put it back. To reschedule a confirmed reveal, change the Reveal Date field.`;
    await postComment(key, jobId, message, fetchImpl);
    return { jobId, action: 'snapped-back', date: plan.date, time: plan.time };
  }
  return { jobId, action: 'field-to-task', date: plan.date, time: plan.time };
}
