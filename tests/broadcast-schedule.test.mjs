/**
 * The live broadcast follows JobTread (functions/api/_broadcast-schedule.js)
 * Run: node --test tests/
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { confirmedReveals, planBroadcast, syncBroadcastSchedule } from '../functions/api/_broadcast-schedule.js';
import { FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED, easternToUtcIso, easternParts } from '../functions/api/_reveals.js';
import * as b from '../functions/api/_broadcast.js';
import { addTracking } from '../functions/api/reveal-invites-admin.js';
import { reminderEmail, reminderPush, isRevealToday } from '../functions/api/_broadcast-notify.js';
import { renderSlack } from './lib/slack-render.mjs';

const H = 3600e3, D = 24 * H;
const SANDBOX = '22P3HTX9cXn4';

// Eastern wall clock N days from now at HH:MM, as JobTread stores it (UTC)
const at = (days, time = '16:00') => easternToUtcIso(easternParts(new Date(Date.now() + days * D).toISOString()).date, time);
const job = (id, name, { startsAt = null, confirmed = true } = {}) => ({
  id, name, customFieldValues: { nodes: [
    ...(startsAt ? [{ value: startsAt, customField: { id: FIELD_REVEAL_DATE } }] : []),
    ...(confirmed ? [{ value: 'Yes 👍', customField: { id: FIELD_REVEAL_CONFIRMED } }] : []),
  ] },
});
const KIDS = [
  { slug: 'max', name: 'Max', year: 2026, draft: false },
  { slug: 'lizzie', name: 'Lizzie', year: 2026, draft: false },
  { slug: 'dylan', name: 'Dylan', year: 2026, draft: true },
  { slug: 'adrian', name: 'Adrian', year: 2026, draft: false },
  { slug: 'isla', name: 'Isla', year: 2026, draft: false },
];
const reveal = (o) => ({ jobId: 'jobMax0001', jobName: 'Max Sample (2026)', slug: 'max', name: 'Max', startsAt: at(3), date: 'x', time: '16:00', problem: null, ...o });

// ─── Which reveals count ────────────────────────────────────────────

test('confirmed reveals: matched to published kids, with the reason when one cannot be planned', () => {
  const list = confirmedReveals([
    job('jobMax0001', 'Max Sample (2026)', { startsAt: at(5) }),
    job('jobLiz0001', 'Lizzie Francis (2026)', { startsAt: easternToUtcIso(easternParts(new Date(Date.now() + 2 * D).toISOString()).date, null) }),
    job('jobDyl0001', 'Dylan Marchena (2026)', { startsAt: at(7) }),
    job('jobXyz0001', 'Perfect Harmony Health (2026)', { startsAt: at(8) }),
    job('jobUnc0001', 'Max Sample (2026)', { startsAt: at(1), confirmed: false }),
    job('jobOld0001', 'Max Sample (2026)', { startsAt: at(-3) }),
    job(SANDBOX, 'Sunshine Office 2025', { startsAt: at(1) }),
  ], KIDS);
  assert.deepEqual(list.map((r) => [r.jobId, r.slug, r.problem]), [
    ['jobLiz0001', 'lizzie', 'no-time'],
    ['jobMax0001', 'max', null],
    ['jobDyl0001', 'dylan', 'draft'],
    ['jobXyz0001', null, 'no-kid'],
  ], 'soonest first; unconfirmed, past and the office sandbox are left out');
  assert.equal(list[0].time, null, 'midnight Eastern means no time yet');
});

// ─── What to do ─────────────────────────────────────────────────────

test('plan: nothing planned → schedule the next confirmed reveal with a time and a published kid', () => {
  const p = planBroadcast({ phase: 'idle' }, [reveal({ problem: 'no-time', startsAt: at(1), jobId: 'a' }), reveal()]);
  assert.equal(p.action, 'schedule');
  assert.equal(p.target.jobId, 'jobMax0001', 'a reveal waiting for a time is skipped, not blocking the next');
});

test('plan: following the reveal already planned', () => {
  const r = reveal();
  const state = { phase: 'scheduled', jobId: r.jobId, kidSlug: 'max', scheduledAt: r.startsAt };
  assert.equal(planBroadcast(state, [r]).action, 'none', 'already matches');
  const moved = planBroadcast(state, [{ ...r, startsAt: at(3, '17:30') }]);
  assert.equal(moved.action, 'update', 'time changed in JobTread');
  assert.equal(moved.target.startsAt, at(3, '17:30'));
  assert.equal(planBroadcast(state, []).action, 'cancel', 'unconfirmed or time cleared → countdown comes down');
  const sooner = reveal({ jobId: 'jobLiz0001', slug: 'lizzie', name: 'Lizzie', startsAt: at(1) });
  const p = planBroadcast(state, [sooner, r]);
  assert.equal(p.action, 'schedule', 'another reveal is now sooner');
  assert.equal(p.target.jobId, 'jobLiz0001');
});

test('plan: a reveal planned before JobTread drove the countdown is adopted by kid, not replaced', () => {
  const r = reveal();
  const p = planBroadcast({ phase: 'scheduled', jobId: null, kidSlug: 'max', scheduledAt: r.startsAt }, [r]);
  assert.equal(p.action, 'update', 'links it to its job');
  assert.equal(p.target.jobId, r.jobId);
});

test('plan: past its start time, only a new time for the same reveal moves it', () => {
  const started = { phase: 'armed', jobId: 'jobMax0001', kidSlug: 'max', scheduledAt: new Date(Date.now() - 10 * 60e3).toISOString() };
  const next = reveal({ jobId: 'jobLiz0001', slug: 'lizzie', startsAt: at(2) });
  assert.equal(planBroadcast(started, [next]).action, 'none', 'never swapped for the next reveal, never cancelled, while the crew may be starting');
  const later = reveal({ startsAt: new Date(Date.now() + 2 * H).toISOString() });
  assert.equal(planBroadcast(started, [later, next]).action, 'update', 'the same reveal pushed back an hour or two');
});

test('plan: live is never touched', () => {
  for (const phase of ['live', 'ending']) assert.equal(planBroadcast({ phase, jobId: 'x' }, [reveal()]).action, 'none');
});

test('plan: a replay hands over in the last day before the next reveal, once its work is done', () => {
  const soon = reveal({ startsAt: new Date(Date.now() + 20 * H).toISOString() });
  const replay = { phase: 'replay', source: 'stream', endedAt: new Date(Date.now() - H).toISOString(), replayUid: null };
  assert.equal(planBroadcast(replay, [soon]).action, 'none', 'recording not saved yet');
  assert.equal(planBroadcast({ ...replay, replayUid: 'v1', reel: { stage: 'clipping' } }, [soon]).action, 'none', 'Reel still being made');
  assert.equal(planBroadcast({ ...replay, replayUid: 'v1', reel: { stage: 'done' } }, [soon]).action, 'schedule');
  assert.equal(planBroadcast({ ...replay, endedAt: new Date(Date.now() - 7 * H).toISOString() }, [soon]).action, 'schedule', 'stuck work never blocks the next reveal for long');
  assert.equal(planBroadcast({ ...replay, replayUid: 'v1' }, [reveal({ startsAt: at(3) })]).action, 'none', 'the replay stays up until the day before');
});

test('plan: a reveal that went live early is not planned again', () => {
  const r = reveal({ startsAt: new Date(Date.now() + H).toISOString() });
  const happened = [{ kidSlug: 'max', liveAt: new Date(Date.now() - 30 * 60e3).toISOString() }];
  assert.equal(planBroadcast({ phase: 'replay', source: 'manual' }, [r], { happened }).action, 'none');
});

// ─── End to end, against D1 and a fake JobTread ─────────────────────

let env, jobs, jtStatus, emails, slack, kit;
const realFetch = globalThis.fetch;
const jtFetch = async (url, init) => {
  if (jtStatus !== 200) return new Response('down', { status: jtStatus });
  const q = JSON.parse(init.body).query;
  if (!q.organization?.jobs) throw new Error('unexpected JobTread query');
  return Response.json({ organization: { jobs: { nextPage: null, nodes: jobs } } });
};
const sync = (o = {}) => syncBroadcastSchedule(env, { fetchImpl: jtFetch, force: true, ...o });

before(async () => {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/emails/batch')) { emails.push(...JSON.parse(init.body)); return Response.json({ data: [] }); }
    if (u.startsWith('https://hooks.slack.test/')) { slack.push(renderSlack(JSON.parse(init.body))); return new Response('ok'); }
    if (u.startsWith('https://api.kit.com/v4/broadcasts')) {
      const method = init.method || 'GET';
      kit.calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : null });
      if (method === 'POST') return Response.json({ broadcast: { id: ++kit.lastId } }, { status: 201 });
      if (method === 'GET') return Response.json({ broadcast: { id: Number(u.split('/').pop()), status: kit.status, send_at: null, published_at: null } });
      if (method === 'PUT') return Response.json({ broadcast: {} });
    }
    return new Response('not mocked', { status: 599 });
  };
  // One database for the file: the broadcast module creates its tables once per process
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const k of KIDS) {
    await DB.prepare('INSERT INTO kids (slug, data, name, year, status) VALUES (?, ?, ?, ?, ?)')
      .bind(k.slug, JSON.stringify({ name: k.name, slug: k.slug, ...(k.draft ? { publishStatus: 'draft' } : {}) }), k.name, k.year, 'building').run();
  }
  env = { DB, JOBTREAD_GRANT_KEY: 'grant', RESEND_API_KEY: 're_test', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' };
  await b.ensureSchema(DB);
  await DB.prepare("INSERT INTO broadcast_reminders (id, channel, address, kid_slug, token, created_at) VALUES ('r1', 'email', 'fan@example.com', NULL, 'tok1', ?)").bind(new Date().toISOString()).run();
});
after(() => { globalThis.fetch = realFetch; });

beforeEach(async () => {
  for (const t of ['broadcasts', 'broadcast_sends', 'broadcast_events', 'site_config']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  jobs = [job('jobMax0001', 'Max Sample (2026)', { startsAt: at(5) })];
  jtStatus = 200;
  emails = [];
  slack = [];
  kit = { calls: [], lastId: 100, status: 'draft' };
  delete env.KIT_API_KEY;
});

test('sync: a confirmed reveal puts the countdown up, as JobTread, with a save-the-date', async () => {
  const r = await sync();
  assert.equal(r.action, 'schedule', r.error);
  const st = await b.readState(env.DB);
  assert.equal(st.phase, 'scheduled');
  assert.equal(st.kidSlug, 'max');
  assert.equal(st.jobId, 'jobMax0001');
  assert.equal(st.scheduledAt, at(5));
  assert.equal(st.updatedBy, 'JobTread');
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /Save the date: Max's room reveal/);
  const row = await env.DB.prepare('SELECT data FROM broadcasts WHERE id = ?').bind(st.broadcastId).first();
  assert.equal(JSON.parse(row.data).jobId, 'jobMax0001', 'History rows know their job (the tracker matches sends by it)');
  assert.equal(r.record.next.jobId, 'jobMax0001');
  assert.equal((await sync()).action, 'none', 'a second check changes nothing');
  assert.equal((await syncBroadcastSchedule(env, { fetchImpl: jtFetch })).action, 'skipped', 'the heartbeat checks at most every 5 minutes');
});

test('sync: a new time the same day moves it quietly; a new day re-arms reminders and tells subscribers', async () => {
  await sync();
  const first = await b.readState(env.DB);
  jobs = [job('jobMax0001', 'Max Sample (2026)', { startsAt: at(5, '18:00') })];
  assert.equal((await sync()).action, 'update');
  let st = await b.readState(env.DB);
  assert.equal(st.broadcastId, first.broadcastId, 'same broadcast');
  assert.equal(st.scheduledAt, at(5, '18:00'));
  assert.equal(emails.length, 1, 'same day: no new email');

  await env.DB.prepare("INSERT INTO broadcast_sends (broadcast_id, kind, channel, created_at) VALUES (?, 'day', 'email', ?)").bind(st.broadcastId, new Date().toISOString()).run();
  jobs = [job('jobMax0001', 'Max Sample (2026)', { startsAt: at(9) })];
  assert.equal((await sync()).action, 'update');
  st = await b.readState(env.DB);
  assert.equal(st.scheduledAt, at(9));
  assert.equal(emails.length, 2);
  assert.match(emails[1].subject, /New date: Max's room reveal/);
  const kinds = (await env.DB.prepare('SELECT kind FROM broadcast_sends WHERE broadcast_id = ?').bind(st.broadcastId).all()).results.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['moved', 'scheduled'], 'the day-before reminder goes out again for the new date');
  const ev = await env.DB.prepare("SELECT meta FROM broadcast_events WHERE broadcast_id = ? AND type = 'moved'").bind(st.broadcastId).first();
  assert.equal(JSON.parse(ev.meta).to, at(9));
});

test('sync: unconfirming in JobTread takes the countdown down', async () => {
  await sync();
  jobs = [job('jobMax0001', 'Max Sample (2026)', { startsAt: at(5), confirmed: false })];
  const r = await sync();
  assert.equal(r.action, 'cancel');
  assert.equal((await b.readState(env.DB)).phase, 'idle');
  assert.equal(r.record.last.action, 'cancel');
});

test('sync: JobTread down changes nothing and says so', async () => {
  await sync();
  jtStatus = 500;
  const r = await sync();
  assert.equal(r.action, 'error');
  assert.match(r.record.error, /JobTread returned 500/);
  assert.equal((await b.readState(env.DB)).phase, 'scheduled', 'the countdown stays up');
  assert.equal(r.record.next.jobId, 'jobMax0001', 'last known plan kept for the admin');
});

test('sync: reveals that cannot have a countdown are listed for the admin', async () => {
  jobs = [
    job('jobLiz0001', 'Lizzie Francis (2026)', { startsAt: easternToUtcIso(easternParts(new Date(Date.now() + 2 * D).toISOString()).date, null) }),
    job('jobDyl0001', 'Dylan Marchena (2026)', { startsAt: at(3) }),
  ];
  const r = await sync();
  assert.equal(r.action, 'none');
  assert.equal((await b.readState(env.DB)).phase, 'idle');
  assert.deepEqual(r.record.waiting.map((w) => [w.name, w.problem]), [['Lizzie', 'no-time'], ['Dylan', 'draft']]);
});

test('sync: two JobTread wake-ups at once plan the reveal once (one save-the-date)', async () => {
  const [a, c] = await Promise.all([sync(), sync()]);
  assert.deepEqual([a.action, c.action].sort(), ['none', 'schedule'], 'the second waits its turn, then finds it done');
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM broadcasts').first();
  assert.equal(rows.n, 1);
  assert.equal(emails.length, 1);
});

test('public wake-ups check JobTread at most once a minute site-wide; one turned away is owed to the next heartbeat', async () => {
  let reads = 0;
  const counted = async (url, init) => { reads++; return jtFetch(url, init); };
  const t0 = Date.now();
  const wake = (now) => syncBroadcastSchedule(env, { fetchImpl: counted, wake: true, now });
  const beat = (now) => syncBroadcastSchedule(env, { fetchImpl: counted, now });
  assert.equal((await wake(t0)).action, 'schedule', 'the first wake-up checks at once');
  assert.equal(reads, 1);
  // A flood of wake-ups inside the minute: no JobTread reads, no second save-the-date
  for (let i = 1; i <= 20; i++) assert.equal((await wake(t0 + i * 1000)).action, 'skipped');
  assert.equal(reads, 1);
  assert.equal(emails.length, 1);
  // The change a turned-away wake-up was about: the reveal moved
  jobs = [job('jobMax0001', 'Max Sample (2026)', { startsAt: at(5, '18:00') })];
  assert.equal((await beat(t0 + 30_000)).action, 'skipped', 'inside the minute, even the owed check waits');
  assert.equal(reads, 1);
  const owed = await beat(t0 + 61_000);
  assert.equal(owed.action, 'update', 'the next heartbeat after the minute runs the owed check, well before its usual 5 minutes');
  assert.equal(reads, 2);
  assert.equal((await b.readState(env.DB)).scheduledAt, at(5, '18:00'));
  // Paid: heartbeats go back to every 5 minutes
  assert.equal((await beat(t0 + 120_000)).action, 'skipped');
  assert.equal(reads, 2);
  // Staff (force) aren't held to the wake-up minute
  assert.notEqual((await syncBroadcastSchedule(env, { fetchImpl: counted, force: true, now: t0 + 121_000 })).action, 'skipped');
  assert.equal(reads, 3);
});

test('tracker: each upcoming reveal gets its broadcast, reminder sends, signups and reveal-check comment', async () => {
  await sync();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS reveal_nudges (job_id TEXT PRIMARY KEY, issues_key TEXT, message TEXT, posted_at INTEGER, updated_at TEXT)').run();
  await env.DB.prepare('INSERT OR REPLACE INTO reveal_nudges (job_id, issues_key, message, posted_at) VALUES (?, ?, ?, ?)').bind('jobLiz0001', 'k', 'Reveal check: no time yet', Date.now() - D).run();
  const upcoming = [{ jobId: 'jobMax0001', slug: 'max' }, { jobId: 'jobLiz0001', slug: 'lizzie' }];
  await addTracking(env, upcoming);
  const [max, liz] = upcoming;
  assert.equal(max.broadcast.phase, 'scheduled');
  assert.equal(max.broadcast.scheduledAt, at(5));
  assert.deepEqual(max.broadcast.sends.map((x) => [x.kind, x.channel, x.sent]), [['scheduled', 'email', 1]], 'the save-the-date, counted');
  assert.equal(max.reminderSignups, 1, 'people who asked about every reveal count for each kid');
  assert.equal(max.checkComment, null);
  assert.equal(liz.broadcast, null, 'no countdown yet');
  assert.match(liz.checkComment.message, /no time yet/);
});

test('staff hear when the countdown goes up, moves and comes down', async () => {
  await sync();
  assert.ok(slack.some((t) => t.includes("Countdown is up: Max's reveal")), slack.join('\n'));
  jobs = [job('jobMax0001', 'Max Sample (2026)', { startsAt: at(8) })];
  await sync();
  assert.ok(slack.some((t) => t.includes('Reveal moved: Max') && t.includes('Everyone who signed up for reminders hears about the new date')));
  jobs = [job('jobMax0001', 'Max Sample (2026)', { startsAt: at(8), confirmed: false })];
  await sync();
  assert.ok(slack.some((t) => t.includes('Countdown taken down: Max')));
  const n = slack.length;
  await sync();
  assert.equal(slack.length, n, 'nothing changed, nothing said');
});

test('a stuck confirmed reveal alerts once, and points at the kid filed under the next year', async () => {
  jobs = [job('jobAdr0001', 'Adrian Scala (2025)', { startsAt: at(6) })];
  const r = await sync();
  assert.equal((await b.readState(env.DB)).phase, 'idle', 'a suggestion is never used: no countdown on a maybe');
  assert.deepEqual(r.record.waiting[0].nearMiss, { slug: 'adrian', name: 'Adrian', year: 2026 });
  const alert = slack.find((t) => t.includes('No countdown yet: Adrian Scala (2025)'));
  assert.ok(alert && alert.includes("Adrian's page is filed under 2026") && alert.includes('Make the years agree'), slack.join('\n'));
  await sync();
  assert.equal(slack.filter((t) => t.includes('No countdown yet')).length, 1, 'once per problem');
  jobs = [job('jobAdr0001', 'Adrian Scala (2025)', { startsAt: at(40) })];
  await sync();
  assert.equal(slack.filter((t) => t.includes('No countdown yet')).length, 1, 'more than three weeks out: not yet worth an alert');
});

test('a new day rewrites the Kit save-the-date draft while it is a draft, or makes a new-date draft once sent', async () => {
  env.KIT_API_KEY = 'kit_test';
  await sync();
  const st = await b.readState(env.DB);
  assert.equal(st.kit.scheduledDraftId, 101, 'save-the-date draft made when the countdown went up');
  jobs = [job('jobMax0001', 'Max Sample (2026)', { startsAt: at(9) })];
  await sync();
  const put = kit.calls.find((c) => c.method === 'PUT');
  assert.ok(put && put.url.endsWith('/broadcasts/101'), 'the same draft is rewritten');
  assert.match(put.body.content, new RegExp(new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' }).format(new Date(at(9)))));
  assert.equal(kit.calls.filter((c) => c.method === 'POST').length, 1, 'no second draft');

  kit.status = 'completed';
  jobs = [job('jobMax0001', 'Max Sample (2026)', { startsAt: at(12) })];
  await sync();
  const posts = kit.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2, 'the old one went out already: a new-date draft instead');
  assert.match(posts[1].body.subject, /New date: Max's room reveal/);
  assert.equal(kit.calls.filter((c) => c.method === 'PUT').length, 1, 'a sent broadcast is never edited');
  assert.equal((await b.readState(env.DB)).kit.scheduledDraftId, 102);
});

test('a countdown that goes up on the day itself says today, not tomorrow', () => {
  const tz = 'America/New_York';
  const later = new Date(Date.now() + 60e3).toISOString();
  const tomorrow = at(1);
  if (isRevealToday(later, tz)) {
    const common = { kind: 'day', kidName: 'Max', scheduledAt: later, tz, liveUrl: 'https://x/live/max/', unsubscribeUrl: 'u' };
    assert.match(reminderEmail(common).subject, /^Today: Max's room reveal/);
    assert.equal(reminderPush(common).title, 'Today is reveal day');
  }
  assert.equal(isRevealToday(tomorrow, tz), false);
  assert.match(reminderEmail({ kind: 'day', kidName: 'Max', scheduledAt: tomorrow, tz, liveUrl: 'x', unsubscribeUrl: 'u' }).subject, /^Tomorrow: /);
});

// ─── Rehearsals: a JobTread "TEST …" job ────────────────────────────

test('plan: a rehearsal only gets the slot when nothing real is planned, and gives it up to a real reveal', () => {
  const rehearsal = reveal({ jobId: 'jobTst0001', jobName: 'TEST Isla Example (2026)', slug: 'isla', name: 'Isla', startsAt: at(1), test: true });
  const real = reveal({ startsAt: at(4) });
  assert.equal(planBroadcast({ phase: 'idle' }, [rehearsal, real]).target.jobId, 'jobMax0001', 'real first, even when the rehearsal is sooner');
  assert.equal(planBroadcast({ phase: 'idle' }, [rehearsal]).target.jobId, 'jobTst0001');
  const p = planBroadcast({ phase: 'scheduled', test: true, jobId: 'jobTst0001', kidSlug: 'isla', scheduledAt: rehearsal.startsAt }, [rehearsal, real]);
  assert.equal(p.action, 'schedule', 'a real reveal takes the slot from a rehearsal');
  assert.equal(p.target.jobId, 'jobMax0001');
});

test('rehearsal end to end: the real path runs, the public sees nothing, reminders reach only the test address, Kit untouched', async () => {
  env.KIT_API_KEY = 'kit_test';
  jobs = [job('jobTst0001', 'TEST Isla Example (2026)', { startsAt: at(5) })];
  const r = await sync();
  assert.equal(r.action, 'schedule', r.error);
  const st = await b.readState(env.DB);
  assert.equal(st.test, true);
  assert.equal(st.kidSlug, 'isla');
  assert.equal(st.title, "TEST · Isla's room reveal");
  // Public views
  const cfg = await b.readConfig(env.DB);
  for (const view of [b.publicState(st, cfg), b.legacyState(st, cfg), (await b.publicPayload(env)).state]) {
    assert.equal(view.phase, 'idle', 'the public sees nothing scheduled');
    assert.equal(view.upcoming, false);
    assert.ok(!view.title && !view.kidName && !view.scheduledAt, 'no name, title or time leaks');
  }
  assert.equal(b.publicState(st, cfg, { includeTest: true }).phase, 'scheduled', 'the admin sees it');
  // Reminders: the test address only, marked TEST
  const toOf = (e) => [].concat(e.to).join(',');
  assert.deepEqual(emails.map(toOf), ['peter@soardcharity.com'], 'the subscriber gets nothing');
  assert.match(emails[0].subject, /^TEST · Save the date: Isla's room reveal/);
  assert.equal(kit.calls.length, 0, 'no Kit drafts for a rehearsal');
  assert.ok(slack.some((t) => t.includes("Countdown is up: Isla's reveal") && t.includes('Test reveal · not a real family') && t.includes('rehearsal')), slack.join('\n'));
  // Moves and take-down follow JobTread the same way
  jobs = [job('jobTst0001', 'TEST Isla Example (2026)', { startsAt: at(8) })];
  assert.equal((await sync()).action, 'update');
  assert.equal(toOf(emails.at(-1)), 'peter@soardcharity.com');
  assert.match(emails.at(-1).subject, /^TEST · New date/);
  jobs = [job('jobTst0001', 'TEST Isla Example (2026)', { startsAt: at(8), confirmed: false })];
  assert.equal((await sync()).action, 'cancel');
  assert.equal((await b.readState(env.DB)).phase, 'idle');
  assert.ok(emails.every((e) => toOf(e) === 'peter@soardcharity.com'), 'nothing ever went to a subscriber');
});

test('a real stream during a rehearsal goes out publicly as its own broadcast', () => {
  const rehearsal = { ...b.defaultState(), phase: 'armed', broadcastId: 'live-test', test: true, kidSlug: 'isla', kidName: 'Isla', title: "TEST · Isla's room reveal", scheduledAt: new Date().toISOString() };
  const live = b.tStartLive(rehearsal, { videoUid: 'v1', source: 'stream' }, b.defaultConfig());
  assert.equal(live.test, false);
  assert.notEqual(live.broadcastId, 'live-test');
  assert.equal(live.kidSlug, null, 'it does not borrow the rehearsal\'s kid');
  assert.equal(b.publicState(live, b.defaultConfig()).live, true);
});

test('a rehearsal follows the reminder switches like a real reveal: reminders off means nothing, not even to the test address', async () => {
  const cfg = await b.readConfig(env.DB);
  await b.writeConfig(env.DB, { ...cfg, reminders: { ...cfg.reminders, enabled: false } });
  try {
    jobs = [job('jobTst0001', 'TEST Isla Example (2026)', { startsAt: at(5) })];
    assert.equal((await sync()).action, 'schedule');
    assert.equal((await b.readState(env.DB)).test, true, 'the rehearsal countdown still goes up');
    assert.equal(emails.length, 0, 'no save-the-date while reminders are off');
  } finally {
    await b.writeConfig(env.DB, cfg);
  }
});
