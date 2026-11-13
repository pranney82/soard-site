/**
 * The SOARD connection's field work: daily logs, photos and the schedule in JobTread, as the person
 * (../_field.js does the JobTread side; this is what Claude sees).
 *
 * Christian talks; Claude writes the day's log on the job (daily_log), and the photo box opens right under it.
 * The box (ui://soard/photo-box, its page in public/mcp-app/photo-box-1.js) sends photos from the phone straight
 * to JobTread and puts them on that log, through two tools only the box calls (photo_slots, photos_done).
 * "What's coming up on Lizzie's?" opens the schedule window (ui://soard/schedule, public/mcp-app/schedule-1.js):
 * the job's tasks by week, where a tap changes a task's dates, who it's on or its name and ticks tasks done, saved
 * in JobTread only when they press Save (task_changes, the window's own tool). "Push Colin's tile to Friday" said in
 * the chat is job_tasks, their yes, then change_task, and the window opens again on the result. Everything is done
 * with the person's own JobTread connection, so JobTread shows their name; someone who hasn't connected gets the one
 * link to do it.
 */

import { done, refuse, READ, WRITE, SITE_URL } from './core.js';
import {
  asPerson, linkStatus, findJob, openJobs, writeLog, ownLog, readLogs, photoSlots, photosDone,
  scheduleView, changeTask, addTask, today, jobUrl, photosPage, CONNECT_URL, MAX_FILES,
} from '../_field.js';

export const PHOTO_URI = 'ui://soard/photo-box';
const SDK = `${SITE_URL}/mcp-app/ext-apps-1.7.5.js`;
const BOX = `${SITE_URL}/mcp-app/photo-box-1.js`;
/** The box loads its script from the site and sends photos to JobTread's storage, nothing else */
export const PHOTO_CSP = Object.freeze({ resourceDomains: [SITE_URL], connectDomains: ['https://storage.googleapis.com'] });
/** On a tool: the host draws the photo box under its result */
const OPENS_BOX = Object.freeze({ ui: { resourceUri: PHOTO_URI }, 'ui/resourceUri': PHOTO_URI });
/** On a tool only the box calls */
const BOX_ONLY = Object.freeze({ ui: { resourceUri: PHOTO_URI, visibility: ['app'] }, 'ui/resourceUri': PHOTO_URI });

export const SCHEDULE_URI = 'ui://soard/schedule';
const SCHEDULE_JS = `${SITE_URL}/mcp-app/schedule-1.js`;
/** The window loads its script from the site and talks to nothing else: every change goes through Claude */
export const SCHEDULE_CSP = Object.freeze({ resourceDomains: [SITE_URL] });
/** On a tool: the host draws the schedule window under its result */
const OPENS_SCHEDULE = Object.freeze({ ui: { resourceUri: SCHEDULE_URI }, 'ui/resourceUri': SCHEDULE_URI });
/** On a tool only the window calls */
const SCHEDULE_ONLY = Object.freeze({ ui: { resourceUri: SCHEDULE_URI, visibility: ['app'] }, 'ui/resourceUri': SCHEDULE_URI });
/** Changes saved at once from the window */
const MAX_CHANGES = 40;

const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const jobRow = (j, me) => ({ id: j.id, name: j.name, status: j.status, pm: j.pm, ...(me && j.pm && first(j.pm).toLowerCase() === first(me).toLowerCase() ? { yours: true } : {}) });

/**
 * Run a field tool as the person. Not connected (or JobTread stopped taking their key): the link to connect, as an
 * answer rather than a failure, so the chat still opens the photo box or the schedule window, which shows the button.
 */
const connectFirst = (err) => done({ connected: false, connect: CONNECT_URL, said: `${err.message} Give them this link as it is (the window above has the button too); after they connect, try again.` });
async function asThem(env, me, work) {
  let p;
  try { p = await asPerson(env, me); } catch (err) {
    if (err.code === 'LINK') return connectFirst(err);
    throw err;
  }
  try { return await work(p); } catch (err) {
    if (err.code === 'LINK') return connectFirst(err);
    return refuse(String(err.message || 'That didn’t work.'));
  }
}

/** A job named in passing → { job } or the answer that asks which one */
async function jobFrom(p, text) {
  const r = await findJob(p, text);
  if (r.job) return { job: r.job };
  if (r.closed) return { stop: refuse(`${r.closed.name} is closed in JobTread. Ask which open job they mean.`) };
  if (r.choices) return { stop: done({ ask: 'More than one open job matches. Ask which one, then use its id.', choices: r.choices.map((j) => jobRow(j, p.name)) }) };
  return { stop: done({ ask: `No open job matches “${text}”. Ask which one; these are SOARD’s open jobs.`, open: r.open.map((j) => jobRow(j, p.name)) }) };
}

/** What the photo box needs to open on a job's day */
const boxFor = (p, job, date, logId) => ({
  jobId: job.id, jobName: job.name, date, logId: logId || null, who: p.name || 'you',
  jobUrl: jobUrl(job.id), backupUrl: photosPage({ jobId: job.id, date }),
});

// ── The tools ─────────────────────────────────────────────────────────────

async function fieldJobs(env, { query }, me) {
  return asThem(env, me, async (p) => {
    const q = String(query || '').trim().toLowerCase();
    const jobs = (await openJobs(p)).filter((j) => !q || j.name.toLowerCase().includes(q)).map((j) => jobRow(j, p.name));
    return done({ as: p.name, today: today(), jobs: [...jobs.filter((j) => j.yours), ...jobs.filter((j) => !j.yours)] });
  });
}

async function dailyLog(env, { job, notes, date, replace }, me) {
  return asThem(env, me, async (p) => {
    const found = await jobFrom(p, job);
    if (found.stop) return found.stop;
    const r = await writeLog(p, { jobId: found.job.id, date, notes, replace: !!replace });
    const said = r.was === 'created' ? `Saved as ${p.name}’s daily log for ${r.date} on ${r.job.name}.`
      : r.was === 'replaced' ? `${p.name}’s log for ${r.date} on ${r.job.name} now says this instead.`
      : `Added to ${p.name}’s log for ${r.date} on ${r.job.name}.`;
    return done({
      said: `${said} The photo box is open under this for any photos.`,
      log: { id: r.logId, date: r.date, was: r.was, notes: r.notes, photos: r.photos }, job: { id: r.job.id, name: r.job.name, link: jobUrl(r.job.id) },
      photoBox: boxFor(p, r.job, r.date, r.logId),
    });
  });
}

async function readDailyLogs(env, { job, from, to }, me) {
  return asThem(env, me, async (p) => {
    let jobId = null;
    let name = null;
    if (job) {
      const found = await jobFrom(p, job);
      if (found.stop) return found.stop;
      ({ id: jobId, name } = found.job);
    }
    const r = await readLogs(p, { jobId, from, to });
    return done({ ...(name ? { job: name } : {}), from: r.from, to: r.to, logs: r.logs });
  });
}

async function addPhotos(env, { job, date }, me) {
  return asThem(env, me, async (p) => {
    const found = await jobFrom(p, job);
    if (found.stop) return found.stop;
    const r = await ownLog(p, found.job.id, date);
    return done({
      said: `The photo box is open above, for ${p.name}’s ${r.date} log on ${r.job.name}${r.log ? '' : ' (the log starts when the first photo goes on)'}. Photos go from the phone straight onto the log, under their name.`,
      job: { id: r.job.id, name: r.job.name }, date: r.date, log: r.log,
      photoBox: boxFor(p, r.job, r.date, r.log?.id),
    });
  });
}

async function slots(env, { files }, me) {
  return asThem(env, me, async (p) => done({ slots: await photoSlots(p, files) }));
}

async function placed(env, { jobId, date, logId, files }, me) {
  return asThem(env, me, async (p) => {
    const r = await photosDone(env, p, { jobId, date, logId, files });
    return done(r);
  });
}

const WINDOW_SAID = 'The schedule is open above as a window. They can tap a task to change its dates, who it’s on or its name, or tick tasks done, and Save puts it in JobTread as them. A change they ask for here in the chat: show it and wait for their yes before change_task.';

async function jobSchedule(env, { job, from, to }, me) {
  return asThem(env, me, async (p) => {
    const found = await jobFrom(p, job);
    if (found.stop) return found.stop;
    return done({ said: WINDOW_SAID, ...await scheduleView(p, found.job.id, { from, to }) });
  });
}

async function taskChange(env, args, me) {
  return asThem(env, me, async (p) => {
    const r = await changeTask(p, args);
    return done({
      said: `Changed in JobTread, as ${p.name}. Tasks linked after it move with it, as in the app. The schedule is open above with the change.`,
      job: r.job, before: r.before, after: r.after, changed: [args.taskId], view: await scheduleView(p, r.job.id),
    });
  });
}

/** The schedule window's Save: its changes, one by one, as the person, each on this job only; then the schedule again */
async function taskChanges(env, { jobId, changes, from, to }, me) {
  return asThem(env, me, async (p) => {
    const results = [];
    for (const c of changes) {
      try {
        const r = await changeTask(p, { ...c, onJob: jobId });
        results.push({ taskId: c.taskId, ok: true, before: r.before, after: r.after });
      } catch (err) {
        if (err?.code === 'LINK') throw err;
        results.push({ taskId: c.taskId, ok: false, problem: String(err?.message || 'That didn’t save') });
      }
    }
    return done({ results, view: await scheduleView(p, jobId, { from, to }) });
  });
}

async function taskAdd(env, { job, ...rest }, me) {
  return asThem(env, me, async (p) => {
    const found = await jobFrom(p, job);
    if (found.stop) return found.stop;
    const t = await addTask(p, { jobId: found.job.id, ...rest });
    return done({
      said: `Added to ${found.job.name}${t.kind === 'to-do' ? '’s to-dos' : '’s schedule'}, as ${p.name}. The schedule is open above with it.`,
      task: t, changed: [t.id], view: await scheduleView(p, found.job.id),
    });
  });
}

async function connection(env, _args, me) {
  const s = await linkStatus(env, me);
  if (s.linked && !s.likely) return done({ connected: true, as: s.name, since: s.since?.slice(0, 10) || null, connect: CONNECT_URL, looksLikeThem: false,
    said: `Connected as “${s.name}” in JobTread, which doesn’t look like them: everything they do here shows as ${s.name}. If that isn’t them, they sign out of JobTread in their browser, sign in as themselves, then connect again here: ${CONNECT_URL}` });
  if (s.linked) return done({ connected: true, as: s.name, since: s.since?.slice(0, 10) || null, said: `Connected: what they do here shows as ${s.name} in JobTread.` });
  return done({ connected: false, connect: CONNECT_URL, said: s.broken ? `Their JobTread connection stopped working. They connect it again, once: ${CONNECT_URL}` : `Not connected yet. They connect their JobTread once, here: ${CONNECT_URL}` });
}

const JOB = { type: 'string', minLength: 1, maxLength: 120, description: 'The job: the kid’s name as they say it (“Lizzie”, “Max Daniel”) or a job id' };
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD (leave out for today, Atlanta time)' };
const PEOPLE = { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 }, description: 'Who it’s on: names on SOARD’s team (“Christian”, “Clareece Cunningham”) or “me”. The whole list: anyone left out comes off.' };

export const TOOLS = [
  { name: 'field_jobs', title: 'Open jobs', annotations: { title: 'Open jobs', ...READ },
    description: 'SOARD’s open jobs in JobTread (one per kid’s makeover, named like “Lizzie Francis (2026)”), with each job’s status and project manager; the person’s own jobs come first. Use it when they don’t name a job, or to find one.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 80, description: 'Part of a name' } }, additionalProperties: false },
    run: fieldJobs },
  { name: 'daily_log', title: 'Write a daily log', annotations: { title: 'Write a daily log', ...WRITE, idempotentHint: false }, _meta: OPENS_BOX,
    description: 'Save what happened on a job today (or another day) as the person’s daily log in JobTread, under their own name. Their log for that day gets the new words after what it already says (replace: true puts these in its place); it’s started if there’s none. Keep their words, fixing only spelling. The photo box opens under the result for that day’s photos.',
    inputSchema: { type: 'object', properties: {
      job: JOB, notes: { type: 'string', minLength: 1, maxLength: 9000, description: 'What happened, in their words' }, date: DATE,
      replace: { type: 'boolean', description: 'true: these words take the place of what the log says' },
    }, required: ['job', 'notes'], additionalProperties: false },
    run: dailyLog },
  { name: 'read_daily_logs', title: 'Daily logs', annotations: { title: 'Daily logs', ...READ },
    description: 'Daily logs in JobTread from a day to a day (the last week if left out), newest first: who wrote each, what it says, and how many photos it has. One job, or every job.',
    inputSchema: { type: 'object', properties: { job: JOB, from: DATE, to: DATE }, additionalProperties: false },
    run: readDailyLogs },
  { name: 'add_photos', title: 'Add photos', annotations: { title: 'Add photos', ...READ }, _meta: OPENS_BOX,
    description: 'Open the photo box in the chat for a job’s daily log (today’s unless a date is given). The person takes or picks photos in it, and they go from their phone straight onto their log for that day in JobTread, under their name. Use it whenever they mention photos or pictures for a job. Nothing is sent until they pick photos in the box.',
    inputSchema: { type: 'object', properties: { job: JOB, date: DATE }, required: ['job'], additionalProperties: false },
    run: addPhotos },
  { name: 'photo_slots', title: 'Places for photos (the photo box)', annotations: { title: 'Places for photos (the photo box)', ...WRITE }, _meta: BOX_ONLY,
    description: 'Used by the photo box. To add photos, use add_photos.',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string', maxLength: 20 }, files: { type: 'array', maxItems: MAX_FILES, items: { type: 'object', properties: {
      name: { type: 'string', maxLength: 300 }, type: { type: 'string', maxLength: 100 }, size: { type: 'number', minimum: 0 },
    }, required: ['type', 'size'], additionalProperties: false } } }, required: ['files'], additionalProperties: false },
    run: slots },
  { name: 'photos_done', title: 'Photos onto the log (the photo box)', annotations: { title: 'Photos onto the log (the photo box)', ...WRITE }, _meta: BOX_ONLY,
    description: 'Used by the photo box. To add photos, use add_photos.',
    inputSchema: { type: 'object', properties: {
      jobId: { type: 'string', minLength: 10, maxLength: 20 }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, logId: { type: ['string', 'null'], maxLength: 20 },
      files: { type: 'array', maxItems: MAX_FILES, items: { type: 'object', properties: { uploadId: { type: 'string', maxLength: 20 }, name: { type: 'string', maxLength: 300 } }, required: ['uploadId'], additionalProperties: false } },
    }, required: ['jobId', 'date', 'files'], additionalProperties: false },
    run: placed },
  { name: 'job_tasks', title: 'A job’s schedule', annotations: { title: 'A job’s schedule', ...READ }, _meta: OPENS_SCHEDULE,
    description: 'A job’s schedule and to-dos in JobTread: everything not done that’s late or coming up, and what was done in the window (a week back to four weeks ahead if left out), with each task’s id, dates, who it’s on and whether it’s late. It opens in the chat as a window where they can change a task and save it themselves. Use it whenever they ask about a job’s schedule, what’s coming up or what’s late, and before changing a task.',
    inputSchema: { type: 'object', properties: { job: JOB, from: DATE, to: DATE }, required: ['job'], additionalProperties: false },
    run: jobSchedule },
  { name: 'change_task', title: 'Change a task', annotations: { title: 'Change a task', ...WRITE }, _meta: OPENS_SCHEDULE,
    description: 'Change one task on a job’s schedule in JobTread, as the person: move it (a new start alone keeps how long it takes; the tasks linked after it move with it, as in the app), mark it done or not, set how far along it is, who it’s on, or its name. Show them the change first and wait for their yes: JobTread tells the people on it.',
    inputSchema: { type: 'object', properties: {
      taskId: { type: 'string', minLength: 10, maxLength: 20, description: 'From job_tasks' }, startDate: DATE, endDate: DATE,
      done: { type: 'boolean' }, progress: { type: 'number', minimum: 0, maximum: 100, description: 'Percent done' },
      assignees: PEOPLE, name: { type: 'string', maxLength: 200 },
    }, required: ['taskId'], additionalProperties: false },
    run: taskChange },
  { name: 'task_changes', title: 'Save changes (the schedule window)', annotations: { title: 'Save changes (the schedule window)', ...WRITE }, _meta: SCHEDULE_ONLY,
    description: 'Used by the schedule window to save what the person changed there. To change a task from the chat, use change_task.',
    inputSchema: { type: 'object', properties: {
      jobId: { type: 'string', minLength: 10, maxLength: 20 }, from: DATE, to: DATE,
      changes: { type: 'array', minItems: 1, maxItems: MAX_CHANGES, items: { type: 'object', properties: {
        taskId: { type: 'string', minLength: 10, maxLength: 20 }, startDate: DATE, endDate: DATE, done: { type: 'boolean' },
        assignees: PEOPLE, name: { type: 'string', maxLength: 200 },
      }, required: ['taskId'], additionalProperties: false } },
    }, required: ['jobId', 'changes'], additionalProperties: false },
    run: taskChanges },
  { name: 'add_task', title: 'Add a task', annotations: { title: 'Add a task', ...WRITE, idempotentHint: false }, _meta: OPENS_SCHEDULE,
    description: 'Add a task to a job’s schedule in JobTread (or a to-do, with todo: true), as the person: its name, dates and who it’s on. Show them first and wait for their yes.',
    inputSchema: { type: 'object', properties: {
      job: JOB, name: { type: 'string', minLength: 1, maxLength: 200 }, startDate: DATE, endDate: DATE, assignees: PEOPLE, todo: { type: 'boolean' },
    }, required: ['job', 'name'], additionalProperties: false },
    run: taskAdd },
  { name: 'jobtread_connection', title: 'My JobTread connection', annotations: { title: 'My JobTread connection', ...READ },
    description: 'Whether the person has connected their own JobTread (so logs, photos and schedule changes show their name), and the link to connect it if not.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: connection },
];

/** The photo box, as the chat draws it */
export function photoBoxHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>SOARD photos</title>
<style>html, body { margin: 0; background: transparent; }</style></head>
<body><div id="box"></div>
<script type="module">
  import { App } from ${JSON.stringify(SDK)};
  import { mountPhotoBox } from ${JSON.stringify(BOX)};
  const app = new App({ name: 'SOARD photos', version: '1.0.0' });
  const call = async (name, args) => {
    const r = await app.callServerTool({ name, arguments: args });
    if (r?.isError) throw new Error(r?.content?.[0]?.text || 'That didn’t work. Try again.');
    const s = r?.structuredContent || {};
    if (s.connected === false && s.connect) throw new Error(\`Your JobTread connection stopped working. Connect it again, then try again: \${s.connect}\`);
    return s;
  };
  let target = null;
  const box = mountPhotoBox(document.getElementById('box'), {
    slots: async (files) => (await call('photo_slots', { jobId: target?.jobId, files })).slots || [],
    done: (a) => call('photos_done', a),
    openLink: (url) => { try { app.openLink({ url }); } catch { /* the host keeps links to itself */ } },
  });
  const CONNECT = ${JSON.stringify(CONNECT_URL)};
  app.ontoolresult = (r) => {
    const s = r?.structuredContent || {};
    if (s.photoBox) { target = s.photoBox; return box.setTarget(target); }
    const said = String(r?.content?.[0]?.text || '');
    // Not connected yet: the button goes where they connect, then they ask again
    if (s.connect || said.includes(CONNECT)) return box.waiting('Connect your JobTread once, so your photos and logs show your name. Then ask again.', { label: 'Connect JobTread', url: s.connect || CONNECT });
    box.waiting(r?.isError ? said.slice(0, 300) : '');
  };
  await app.connect();
</script>
</body></html>`;
}

/** The schedule window, as the chat draws it (its page: public/mcp-app/schedule-1.js) */
export function scheduleHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>SOARD schedule</title>
<style>html, body { margin: 0; background: transparent; }</style></head>
<body><div id="sched"></div>
<script type="module">
  import { App, applyDocumentTheme, applyHostStyleVariables } from ${JSON.stringify(SDK)};
  import { mountSchedule } from ${JSON.stringify(SCHEDULE_JS)};
  const app = new App({ name: 'SOARD schedule', version: '1.0.0' });
  const call = async (name, args) => {
    const r = await app.callServerTool({ name, arguments: args });
    if (r?.isError) throw new Error(r?.content?.[0]?.text || 'That didn’t work. Try again.');
    const s = r?.structuredContent || {};
    // JobTread stopped taking their key part-way (90 days unused): the window keeps the change and shows the button
    if (s.connected === false && s.connect) throw Object.assign(new Error('Your JobTread connection stopped working. Connect it again, then press Save again.'), { connect: s.connect });
    return s;
  };
  const CONNECT = ${JSON.stringify(CONNECT_URL)};
  const sched = mountSchedule(document.getElementById('sched'), {
    save: (a) => call('task_changes', a),
    add: (a) => call('add_task', a),
    reload: (a) => call('job_tasks', a),
    openLink: (url) => { try { app.openLink({ url }); } catch { /* the host keeps links to itself */ } },
    // Claude hears what was saved here, so the chat carries on from it
    tell: (text) => { try { app.updateModelContext({ content: [{ type: 'text', text }] }); } catch { /* a host without it */ } },
    expand: () => app.requestDisplayMode({ mode: 'fullscreen' }),
    shrink: () => app.requestDisplayMode({ mode: 'inline' }),
  });
  // Claude's light or dark, and its colors when it hands them over
  const follow = (c) => {
    if (!c) return;
    if (c.theme) applyDocumentTheme(c.theme);
    if (c.styles?.variables) applyHostStyleVariables(c.styles.variables);
    if (c.displayMode || c.availableDisplayModes) sched.setDisplay({ mode: c.displayMode || 'inline', modes: c.availableDisplayModes || [] });
  };
  app.onhostcontextchanged = (c) => follow(c);
  app.ontoolinput = () => sched.loading();
  app.ontoolresult = (r) => {
    const s = r?.structuredContent || {};
    const view = s.view || (s.job && Array.isArray(s.tasks) ? s : null);
    if (view) return sched.show(view, { changed: s.changed || [] });
    const said = String(r?.content?.[0]?.text || '');
    if (s.connect || said.includes(CONNECT)) return sched.waiting('Connect your JobTread once, so your schedule changes show your name. Then ask again.', { label: 'Connect JobTread', url: CONNECT });
    sched.waiting(r?.isError ? said.slice(0, 300) : '');
  };
  await app.connect();
  follow(app.getHostContext());
</script>
</body></html>`;
}
