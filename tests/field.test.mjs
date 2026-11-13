/**
 * Field work in JobTread as the person (functions/api/_field.js, the SOARD connection's field tools in
 * functions/api/_mcp/field.js, /api/field-admin and /api/jobtread-callback): connecting their own JobTread once,
 * daily logs under their name, photos onto the day's log once each, and schedule changes. JobTread is faked.
 * Run: node --test tests/field.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  startLink, finishLink, asPerson, linkStatus, findJob, writeLog, readLogs, photoSlots, photosDone, jobTasks,
  changeTask, addTask, fileName, CONNECT_URL, CALLBACK,
} from '../functions/api/_field.js';
import { TOOLS, callTool } from '../functions/api/_mcp-tools.js';
import { readResource } from '../functions/api/_mcp/guide.js';
import { PHOTO_URI } from '../functions/api/_mcp/field.js';
import * as fieldAdmin from '../functions/api/field-admin.js';
import * as callback from '../functions/api/jobtread-callback.js';

const ORG = '22NJw42j5GLg';
const ME = 'cnielsen@soardcharity.com';
const CHRISTIAN = { id: '22Np33yErAWi', name: 'Christian Nielsen', emailAddress: 'cnielsen@soardcharity.com', membership: '22Np33yEqmcR', internal: true };
const CLAREECE = { id: '22NMyXFKXgN8', name: 'Clareece Cunningham', emailAddress: 'ccunningham@soardcharity.com', membership: '22NMyXFKY5GR', internal: true };
const GRACIE = { id: '22PhY3AgmSXA', name: 'Agent Gracie', emailAddress: 'automation@soardcharity.com', membership: '22PhY3AgkgiZ', internal: true };
const FAMILY = { id: '22FamilyUsr01', name: 'A Parent', emailAddress: 'parent@example.com', membership: '22FamilyMem01', internal: false };

/** A small JobTread: jobs, daily logs, files, upload slots and tasks; every write recorded */
function fakeJobTread() {
  const w = {
    keys: { 'key-christian': CHRISTIAN, 'key-clareece': CLAREECE, 'key-gracie': GRACIE, 'key-family': FAMILY },
    codes: { 'code-christian': 'key-christian', 'code-gracie': 'key-gracie', 'code-family': 'key-family' },
    jobs: [
      { id: '22PRvFGCAdMM', name: 'Lizzie Francis (2026)', closedOn: null, pm: 'Christian', status: 'Build' },
      { id: '22PRvFFCCvET', name: 'Peter Raish (2026)', closedOn: null, pm: 'Christian', status: 'Build' },
      { id: '22PMaxDaniel1', name: 'Max Daniel (2026)', closedOn: null, pm: 'Christian', status: 'Build' },
      { id: '22PMaxwell001', name: 'Maxwell Stone (2026)', closedOn: null, pm: 'Clareece', status: 'Design' },
      { id: '22POldJob0001', name: 'Emery Old (2024)', closedOn: '2025-01-10', pm: null, status: 'Closed Done' },
    ],
    logs: [{ id: '22LogClareece', jobId: '22PRvFGCAdMM', date: '2026-11-12', notes: 'Clareece dropped off tile.', user: CLAREECE, files: [] }],
    uploads: {}, files: [], tasks: [
      { id: '22TaskFrame01', jobId: '22PRvFGCAdMM', name: 'Framing', startDate: '2026-11-12', endDate: '2026-11-13', progress: null, isToDo: false, assignees: [] },
      { id: '22TaskTile001', jobId: '22PRvFGCAdMM', name: 'Tile', startDate: '2026-11-16', endDate: '2026-11-18', progress: null, isToDo: false, assignees: [CHRISTIAN] },
      { id: '22TaskDone001', jobId: '22PRvFGCAdMM', name: 'Demo', startDate: '2026-11-11', endDate: '2026-11-11', progress: 1, isToDo: false, assignees: [] },
    ],
    calls: [], n: 0, failFileFor: new Set(),
  };
  const nid = () => `22Made${String(++w.n).padStart(6, '0')}`;
  const jobOut = (j, sel) => {
    const out = { id: j.id, name: j.name, closedOn: j.closedOn };
    if (sel.customFieldValues) out.customFieldValues = { nodes: [{ value: j.pm, customField: { id: '22NMZbwAM7X5' } }, { value: j.status, customField: { id: '22P52qfFub9b' } }].filter((n) => n.value) };
    if (sel.dailyLogs) {
      const where = sel.dailyLogs.$?.where;
      let logs = w.logs.filter((l) => l.jobId === j.id);
      if (Array.isArray(where) && where[0] === 'date') logs = logs.filter((l) => l.date === where[2]);
      if (where?.and) { const [[, , a], [, , b]] = where.and; logs = logs.filter((l) => l.date >= a && l.date <= b); }
      out.dailyLogs = { nodes: logs.map(logOut) };
    }
    if (sel.tasks) out.tasks = { nextPage: null, nodes: w.tasks.filter((t) => t.jobId === j.id).map(taskOut) };
    return out;
  };
  const logOut = (l) => ({ id: l.id, date: l.date, notes: l.notes, createdAt: '2026-11-12T15:00:00Z', user: { id: l.user.id, name: l.user.name }, files: { count: l.files.length }, job: { id: l.jobId, name: w.jobs.find((j) => j.id === l.jobId)?.name } });
  const taskOut = (t) => ({ id: t.id, name: t.name, startDate: t.startDate, endDate: t.endDate, startTime: null, endTime: null, progress: t.progress, isToDo: t.isToDo, taskType: null,
    job: { id: t.jobId, name: w.jobs.find((j) => j.id === t.jobId)?.name }, assignedMemberships: { nodes: t.assignees.map((u) => ({ id: u.membership, user: { name: u.name } })) } });
  const bad = (text) => new Response(text, { status: 400 });

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url === 'https://api.jobtread.com/oauth/token') {
      const key = w.codes[body.code];
      return key ? Response.json({ access_token: key, token_type: 'bearer' }) : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    const { $, ...q } = body.query;
    const user = w.keys[$.grantKey];
    if (!user) return bad('Supplied key is invalid or expired');
    const out = {};
    for (const [k, v] of Object.entries(q)) {
      w.calls.push({ as: user.name, k, args: v.$ });
      if (k === 'currentGrant') out.currentGrant = { user: { id: user.id, name: user.name, emailAddress: user.emailAddress, memberships: { nodes: [{ id: user.membership, isInternal: user.internal, organization: { id: ORG } }] } } };
      else if (k === 'organization') {
        const o = {};
        if (v.jobs) o.jobs = { nextPage: null, nodes: w.jobs.filter((j) => !j.closedOn).map((j) => jobOut(j, v.jobs.nodes)) };
        if (v.memberships) o.memberships = { nodes: [CHRISTIAN, CLAREECE, GRACIE].map((u) => ({ id: u.membership, user: { name: u.name } })) };
        if (v.dailyLogs) { const [[, , a], [, , b]] = v.dailyLogs.$.where.and; o.dailyLogs = { nodes: w.logs.filter((l) => l.date >= a && l.date <= b).map(logOut) }; }
        out.organization = o;
      } else if (k === 'job') { const j = w.jobs.find((x) => x.id === v.$.id); out.job = j ? jobOut(j, v) : null; }
      else if (k === 'dailyLog') { const l = w.logs.find((x) => x.id === v.$.id); out.dailyLog = l ? { id: l.id, job: { id: l.jobId } } : null; }
      else if (k === 'task') { const t = w.tasks.find((x) => x.id === v.$.id); out.task = t ? taskOut(t) : null; }
      else if (k === 'createDailyLog') { const id = nid(); w.logs.push({ id, jobId: v.$.jobId, date: v.$.date, notes: v.$.notes, user, files: [] }); out.createDailyLog = { createdDailyLog: { id } }; }
      else if (k === 'updateDailyLog') { const l = w.logs.find((x) => x.id === v.$.id); if (l.user.id !== user.id) return bad('Not yours'); l.notes = v.$.notes; out.updateDailyLog = {}; }
      else if (k === 'createUploadRequest') { const id = nid(); w.uploads[id] = { size: v.$.size, type: v.$.type, used: false }; out.createUploadRequest = { createdUploadRequest: { id, url: `https://storage.googleapis.com/jobtread/files/${id}?sig=x`, method: 'PUT', headers: { 'content-type': v.$.type, 'x-goog-content-length-range': `${v.$.size},${v.$.size}` } } }; }
      else if (k === 'createFile') {
        const u = w.uploads[v.$.uploadRequestId];
        if (w.failFileFor.has(v.$.uploadRequestId)) return bad('Upload not finished');
        if (!u || u.used) return bad('Upload request not found or already used');
        u.used = true;
        const id = nid();
        w.files.push({ id, targetType: v.$.targetType, targetId: v.$.targetId, name: v.$.name, by: user.name });
        w.logs.find((l) => l.id === v.$.targetId)?.files.push(id);
        out.createFile = { createdFile: { id } };
      } else if (k === 'updateTask') {
        const t = w.tasks.find((x) => x.id === v.$.id);
        if (v.$.startDate) t.startDate = v.$.startDate;
        if (v.$.endDate) t.endDate = v.$.endDate;
        if (v.$.progress !== undefined) t.progress = v.$.progress;
        if (v.$.assignedMembershipIds) t.assignees = [CHRISTIAN, CLAREECE, GRACIE].filter((u) => v.$.assignedMembershipIds.includes(u.membership));
        if (v.$.name) t.name = v.$.name;
        out.updateTask = {};
      } else if (k === 'createTask') {
        const id = nid();
        w.tasks.push({ id, jobId: v.$.targetId, name: v.$.name, startDate: v.$.startDate || null, endDate: v.$.endDate || null, progress: null, isToDo: v.$.isToDo, assignees: [CHRISTIAN, CLAREECE].filter((u) => (v.$.assignedMembershipIds || []).includes(u.membership)) });
        out.createTask = { createdTask: { id } };
      } else return bad(`Unknown field ${k}`);
    }
    return Response.json(out);
  };
  return { w, fetchImpl };
}

const NOW = Date.parse('2026-11-12T16:00:00Z');
let env;
let jt;
let realFetch;
beforeEach(async () => {
  env = { DB: await createD1() };
  jt = fakeJobTread();
  if (!realFetch) realFetch = globalThis.fetch;
  globalThis.fetch = jt.fetchImpl;
});

async function connectChristian() {
  const url = await startLink(env, ME, { now: NOW });
  const state = new URL(url).searchParams.get('state');
  return finishLink(env, { code: 'code-christian', state }, { now: NOW });
}

// ─── Connecting their own JobTread ───

test('connecting: JobTread’s sign-in comes back here, the key is kept for someone on SOARD’s team, once per sign-in', async () => {
  const url = new URL(await startLink(env, ME, { back: '/admin/photos/?job=22PRvFGCAdMM', now: NOW }));
  assert.equal(url.origin + url.pathname, 'https://app.jobtread.com/oauth/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  const state = url.searchParams.get('state');
  assert.match(state, /^[a-f0-9]{48}$/);
  const got = await finishLink(env, { code: 'code-christian', state }, { now: NOW });
  assert.deepEqual(got, { email: ME, name: 'Christian Nielsen', back: '/admin/photos/?job=22PRvFGCAdMM' });
  assert.deepEqual(await linkStatus(env, ME), { linked: true, name: 'Christian Nielsen', since: new Date(NOW).toISOString(), broken: false });
  // The same sign-in can't be used again
  await assert.rejects(finishLink(env, { code: 'code-christian', state }, { now: NOW }), { code: 'STATE' });
  // Too old
  const old = new URL(await startLink(env, ME, { now: NOW })).searchParams.get('state');
  await assert.rejects(finishLink(env, { code: 'code-christian', state: old }, { now: NOW + 16 * 60000 }), { code: 'STATE' });
  // Never the website’s own login, never someone outside SOARD’s team
  const s1 = new URL(await startLink(env, 'linzi@soardcharity.com', { now: NOW })).searchParams.get('state');
  await assert.rejects(finishLink(env, { code: 'code-gracie', state: s1 }, { now: NOW }), { code: 'SITE_LOGIN' });
  const s2 = new URL(await startLink(env, 'linzi@soardcharity.com', { now: NOW })).searchParams.get('state');
  await assert.rejects(finishLink(env, { code: 'code-family', state: s2 }, { now: NOW }), { code: 'NOT_STAFF' });
  assert.equal((await linkStatus(env, 'linzi@soardcharity.com')).linked, false);
  // An outside page in `back` is dropped
  const s3 = new URL(await startLink(env, ME, { back: 'https://evil.example/', now: NOW })).searchParams.get('state');
  assert.equal((await finishLink(env, { code: 'code-christian', state: s3 }, { now: NOW })).back, '');
});

test('not connected, or JobTread stopped taking the key: the one link to connect, and nothing done as anyone else', async () => {
  await assert.rejects(asPerson(env, ME), (err) => err.code === 'LINK' && err.message.includes(CONNECT_URL));
  await connectChristian();
  await env.DB.prepare('UPDATE jt_links SET grant_key = ? WHERE email = ?').bind('key-gone', ME).run();
  const p = await asPerson(env, ME);
  await assert.rejects(p.q({ currentGrant: { user: { id: {} } } }), (err) => err.code === 'LINK' && /stopped working/.test(err.message));
  assert.equal((await linkStatus(env, ME)).broken, true);
  await assert.rejects(asPerson(env, ME), (err) => err.code === 'LINK');
});

// ─── Jobs, logs ───

test('a job named in passing: “Lizzie’s”, “Max” (not Maxwell), and a question when it could be more than one', async () => {
  await connectChristian();
  const p = await asPerson(env, ME);
  assert.equal((await findJob(p, "Lizzie's")).job.id, '22PRvFGCAdMM');
  assert.equal((await findJob(p, 'max')).job.name, 'Max Daniel (2026)');
  assert.equal((await findJob(p, 'Max Daniel job')).job.id, '22PMaxDaniel1');
  const both = await findJob(p, '2026');
  assert.ok(both.choices.length >= 3);
  assert.ok((await findJob(p, 'Nobody Here')).none);
  assert.ok((await findJob(p, '22POldJob0001')).closed, 'a closed job is named as closed, never written to');
});

test('daily logs: theirs is started, then added to; someone else’s that day is left alone', async () => {
  await connectChristian();
  const p = await asPerson(env, ME);
  const a = await writeLog(p, { jobId: '22PRvFGCAdMM', notes: 'Demo done. Both doors and the casing are out.' }, NOW);
  assert.equal(a.was, 'created');
  assert.equal(a.date, '2026-11-12');
  const b = await writeLog(p, { jobId: '22PRvFGCAdMM', notes: 'Pella has the window measurements.' }, NOW);
  assert.equal(b.logId, a.logId);
  assert.equal(b.notes, 'Demo done. Both doors and the casing are out.\n\nPella has the window measurements.');
  // Saying the same thing again doesn't repeat it
  assert.equal((await writeLog(p, { jobId: '22PRvFGCAdMM', notes: 'Pella has the window measurements.' }, NOW)).notes, b.notes);
  const c = await writeLog(p, { jobId: '22PRvFGCAdMM', notes: 'Only this.', replace: true }, NOW);
  assert.equal(c.notes, 'Only this.');
  assert.equal(jt.w.logs.find((l) => l.id === '22LogClareece').notes, 'Clareece dropped off tile.');
  assert.equal(jt.w.logs.filter((l) => l.jobId === '22PRvFGCAdMM' && l.date === '2026-11-12').length, 2);
  assert.equal(jt.w.logs.find((l) => l.id === a.logId).user.name, 'Christian Nielsen');
  await assert.rejects(writeLog(p, { jobId: '22PRvFGCAdMM', notes: '  ' }, NOW), /needs what happened/);
  const read = await readLogs(p, { jobId: '22PRvFGCAdMM' }, NOW);
  assert.equal(read.from, '2026-11-06');
  assert.equal(read.logs.length, 2);
});

// ─── Photos ───

test('photos: a slot each in JobTread’s storage, then onto their log once each, the log started when there isn’t one', async () => {
  await connectChristian();
  const p = await asPerson(env, ME);
  const slots = await photoSlots(p, [
    { name: 'IMG_2843.jpeg', type: 'image/jpeg', size: 3_200_000 },
    { name: 'clip.mov', type: 'video/quicktime', size: 40_000_000 },
    { name: 'notes.pdf', type: 'application/pdf', size: 1000 },
    { name: 'C:\\fakepath\\IMG_2844.jpeg', type: 'image/jpeg', size: 2_900_000 },
  ]);
  assert.equal(slots[0].name, 'IMG_2843.jpeg');
  assert.match(slots[0].url, /^https:\/\/storage\.googleapis\.com\/jobtread\/files\//);
  assert.deepEqual(slots[0].headers, { 'content-type': 'image/jpeg', 'x-goog-content-length-range': '3200000,3200000' });
  assert.equal(slots[2].problem, 'Only photos and videos go on a log');
  assert.equal(slots[3].name, 'IMG_2844.jpeg', 'never a path');
  await assert.rejects(photoSlots(p, Array.from({ length: 31 }, () => ({ type: 'image/jpeg', size: 1 }))), /Up to 30/);

  const files = [slots[0], slots[1], slots[3]].map((s) => ({ uploadId: s.uploadId, name: s.name }));
  const r = await photosDone(env, p, { jobId: '22PRvFGCAdMM', date: '2026-11-12', files }, NOW);
  assert.equal(r.added, 3);
  const log = jt.w.logs.find((l) => l.id === r.logId);
  assert.equal(log.user.name, 'Christian Nielsen');
  assert.equal(log.notes, null, 'started for the photos; their words come with daily_log');
  assert.deepEqual(jt.w.files.map((f) => [f.targetType, f.targetId, f.by]), files.map(() => ['dailyLog', r.logId, 'Christian Nielsen']));
  // Trying again (the box lost the answer) never adds a photo twice
  const again = await photosDone(env, p, { jobId: '22PRvFGCAdMM', date: '2026-11-12', logId: r.logId, files }, NOW);
  assert.deepEqual([again.added, again.already, again.failed.length], [0, 3, 0]);
  assert.equal(jt.w.files.length, 3);
  // Their words later go on the same log
  assert.equal((await writeLog(p, { jobId: '22PRvFGCAdMM', notes: 'Demo day.' }, NOW)).logId, r.logId);
});

test('photos: one JobTread won’t take is named and can be tried again; a log from another job is refused', async () => {
  await connectChristian();
  const p = await asPerson(env, ME);
  const [a, b] = await photoSlots(p, [{ name: 'a.jpg', type: 'image/jpeg', size: 10 }, { name: 'b.jpg', type: 'image/jpeg', size: 10 }]);
  jt.w.failFileFor.add(b.uploadId);
  const r = await photosDone(env, p, { jobId: '22PRvFGCAdMM', date: '2026-11-12', files: [a, b] }, NOW);
  assert.equal(r.added, 1);
  assert.deepEqual(r.failed, [{ uploadId: b.uploadId, name: 'b.jpg', problem: 'Upload not finished' }]);
  jt.w.failFileFor.clear();
  const r2 = await photosDone(env, p, { jobId: '22PRvFGCAdMM', date: '2026-11-12', logId: r.logId, files: [b] }, NOW);
  assert.equal(r2.added, 1);
  await assert.rejects(photosDone(env, p, { jobId: '22PRvFFCCvET', date: '2026-11-12', logId: r.logId, files: [a] }, NOW), /isn’t this job’s/);
  assert.equal(fileName('', 'video/quicktime', 3), 'Photo 3.mov');
});

// ─── The schedule ───

test('the schedule: late and coming up; a new start keeps the task’s length; done, who, and a new task, all as them', async () => {
  await connectChristian();
  const p = await asPerson(env, ME);
  const s = await jobTasks(p, '22PRvFGCAdMM', {}, NOW);
  assert.deepEqual(s.tasks.map((t) => t.name), ['Demo', 'Framing', 'Tile']);
  assert.equal(s.tasks[2].who[0], 'Christian Nielsen');
  const moved = await changeTask(p, { taskId: '22TaskTile001', startDate: '2026-11-20' }, NOW);
  assert.deepEqual([moved.before.start, moved.before.end, moved.after.start, moved.after.end], ['2026-11-16', '2026-11-18', '2026-11-20', '2026-11-22']);
  const update = jt.w.calls.find((c) => c.k === 'updateTask');
  assert.equal(update.as, 'Christian Nielsen');
  assert.equal((await changeTask(p, { taskId: '22TaskFrame01', done: true }, NOW)).after.done, true);
  assert.deepEqual((await changeTask(p, { taskId: '22TaskFrame01', assignees: ['Clareece', 'me'] }, NOW)).after.who, ['Christian Nielsen', 'Clareece Cunningham']);
  await assert.rejects(changeTask(p, { taskId: '22TaskFrame01', assignees: ['Bob'] }, NOW), /isn’t one person on SOARD’s team/);
  await assert.rejects(changeTask(p, { taskId: '22TaskFrame01', startDate: '2026-11-20', endDate: '2026-11-19' }, NOW), /can’t end before it starts/);
  await assert.rejects(changeTask(p, { taskId: '22TaskFrame01' }, NOW), /Say what to change/);
  const t = await addTask(p, { jobId: '22PRvFGCAdMM', name: 'Order the Pella pane', startDate: '2026-11-13', assignees: ['me'], todo: true }, NOW);
  assert.equal(t.kind, 'to-do');
  assert.deepEqual(t.who, ['Christian Nielsen']);
});

// ─── Through Claude ───

const data = (r) => r.structuredContent;

test('through Claude: not connected gives the link; connected, a log opens the photo box on that day’s log', async () => {
  const none = await callTool(env, 'daily_log', { job: 'Lizzie', notes: 'Demo done.' }, ME);
  assert.equal(none.isError, true);
  assert.ok(none.content[0].text.includes(CONNECT_URL));
  await connectChristian();
  const r = data(await callTool(env, 'daily_log', { job: 'Lizzie', notes: 'Demo done.' }, ME));
  assert.equal(r.log.was, 'created');
  assert.deepEqual(Object.keys(r.photoBox).sort(), ['backupUrl', 'date', 'jobId', 'jobName', 'jobUrl', 'logId', 'who']);
  assert.equal(r.photoBox.logId, r.log.id);
  assert.equal(r.photoBox.backupUrl, `https://sunshineonaranneyday.com/admin/photos/?job=22PRvFGCAdMM&date=${r.log.date}`);
  const box = data(await callTool(env, 'add_photos', { job: 'Raish' }, ME));
  assert.equal(box.photoBox.jobName, 'Peter Raish (2026)');
  assert.equal(box.photoBox.logId, null);
  const ask = data(await callTool(env, 'add_photos', { job: '2026' }, ME));
  assert.ok(ask.ask && ask.choices.length > 1, 'more than one: Claude asks which');
  const slots = data(await callTool(env, 'photo_slots', { jobId: '22PRvFFCCvET', files: [{ name: 'x.jpg', type: 'image/jpeg', size: 5 }] }, ME)).slots;
  const placed = data(await callTool(env, 'photos_done', { jobId: '22PRvFFCCvET', date: box.photoBox.date, logId: null, files: [{ uploadId: slots[0].uploadId, name: 'x.jpg' }] }, ME));
  assert.equal(placed.added, 1);
  const sched = data(await callTool(env, 'job_tasks', { job: 'Lizzie' }, ME));
  assert.ok(sched.tasks.length >= 3);
  const conn = data(await callTool(env, 'jobtread_connection', {}, ME));
  assert.equal(conn.as, 'Christian Nielsen');
});

test('the photo box: drawn by the chat under daily_log and add_photos; its two tools are the box’s only; it sends only to JobTread’s storage', async () => {
  const by = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  for (const n of ['daily_log', 'add_photos']) assert.equal(by[n]._meta.ui.resourceUri, PHOTO_URI, n);
  for (const n of ['photo_slots', 'photos_done']) assert.deepEqual(by[n]._meta.ui.visibility, ['app'], n);
  const [res] = await readResource(env, PHOTO_URI);
  assert.equal(res.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(res._meta.ui.csp.connectDomains, ['https://storage.googleapis.com']);
  assert.ok(res.text.includes('/mcp-app/photo-box-1.js'));
  assert.ok(res.text.includes('/mcp-app/ext-apps-1.7.5.js'));
});

// ─── The admin side ───

const ctx = (url, { method = 'GET', body, email = ME } = {}) => ({
  env, request: new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }), data: { userEmail: email },
});

test('admin: Connect JobTread goes to JobTread and comes back to the photo page; the page adds photos the same way', async () => {
  const go = await fieldAdmin.onRequestGet(ctx('https://sunshineonaranneyday.com/api/field-admin?connect=1&back=%2Fadmin%2Fphotos%2F%3Fjob%3D22PRvFGCAdMM'));
  assert.equal(go.status, 302);
  const to = new URL(go.headers.get('Location'));
  assert.equal(to.host, 'app.jobtread.com');
  const back = await callback.onRequestGet({ env, request: new Request(`https://sunshineonaranneyday.com/api/jobtread-callback?code=code-christian&state=${to.searchParams.get('state')}`) });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('Location'), 'https://sunshineonaranneyday.com/admin/photos/?job=22PRvFGCAdMM&jobtread=connected');
  const cancelled = await callback.onRequestGet({ env, request: new Request('https://sunshineonaranneyday.com/api/jobtread-callback?error=access_denied') });
  assert.equal(cancelled.headers.get('Location'), 'https://sunshineonaranneyday.com/admin/photos/?jobtread=declined');
  const page = await (await fieldAdmin.onRequestGet(ctx('https://sunshineonaranneyday.com/api/field-admin?job=22PRvFGCAdMM&date=2026-11-12'))).json();
  assert.equal(page.job.name, 'Lizzie Francis (2026)');
  assert.equal(page.who, 'Christian Nielsen');
  const { slots } = await (await fieldAdmin.onRequestPost(ctx('https://sunshineonaranneyday.com/api/field-admin', { method: 'POST', body: { action: 'slots', files: [{ name: 'a.jpg', type: 'image/jpeg', size: 9 }] } }))).json();
  const done = await (await fieldAdmin.onRequestPost(ctx('https://sunshineonaranneyday.com/api/field-admin', { method: 'POST', body: { action: 'done', jobId: '22PRvFGCAdMM', date: '2026-11-12', files: [{ uploadId: slots[0].uploadId, name: 'a.jpg' }] } }))).json();
  assert.equal(done.added, 1);
  // Someone not connected gets the link, not an error page
  const other = await fieldAdmin.onRequestGet(ctx('https://sunshineonaranneyday.com/api/field-admin?job=22PRvFGCAdMM', { email: 'linzi@soardcharity.com' }));
  assert.equal(other.status, 409);
  assert.equal((await other.json()).connect, CONNECT_URL);
  // Never anyone outside SOARD
  assert.equal((await fieldAdmin.onRequestGet(ctx('https://sunshineonaranneyday.com/api/field-admin', { email: 'someone@gmail.com' }))).status, 403);
});

test('the connect link opens behind the admin sign-in, never on an /api/ route a fresh phone browser can’t sign in to', () => {
  const u = new URL(CONNECT_URL);
  assert.equal(u.origin, 'https://sunshineonaranneyday.com');
  assert.equal(u.pathname, '/admin/photos/');
  assert.equal(u.searchParams.get('connect'), '1');
});
