/**
 * /api/reveal-invites-admin (Cloudflare Access) — reveal calendar invites, for Reveals → Invites
 *
 * GET                         → settings, setup checks, every upcoming reveal with its invite,
 *                               and which one the live countdown follows
 * GET ?test=<jobId>           → send that job's invite to YOU only, as a separate TEST event
 *        &date=YYYY-MM-DD       try a moved date
 *        &time=HH:MM | none     try a time (or back to all day)
 * GET ?test-cancel=<jobId>    → cancel your TEST event
 * GET ?preview=<jobId>        → what the real invite would be and who gets it (sends nothing)
 * GET ?sync=<jobId>           → bring that reveal's invite up to date now (Retry)
 * GET ?sweep=1                → reconcile every open job (dry run while sending is off)
 * GET ?enable=1 | ?enable=0   → turn sending on / off
 * GET ?checks=preview         → what this morning's reveal checks would post (posts nothing)
 * GET ?checks=run             → run the reveal checks now (posts comments)
 * GET ?checks=test            → run them on the office sandbox job only
 * GET ?checks-enable=1 | 0    → turn the weekday reveal checks on / off
 * GET ?board=1               → the website's board with each member's private reveal email
 * POST { boardEmail: { slug, email } } → set or clear one (empty email) and update open invites
 * POST { enabled, organizer } → turn sending on/off, change the organizer
 *
 * Test links are GETs on purpose: open them in a browser signed in to Access.
 */

import {
  ensureSchema, readConfig, writeConfig, reconcileJob, reconcileAll, sendTestInvite,
  listUpcoming, maybeSweep, boardRoster, setBoardEmail, refreshForBoardChange, DEFAULT_TEMPLATE, TEMPLATE_LIMITS,
} from './_reveal-invites.js';
import { readNudgeConfig, writeNudgeConfig, runNudges, maybeNudge, summarize, SANDBOX_JOB_ID } from './_reveal-nudges.js';
import { logAudit } from './_audit.js';
import { readState, readConfig as readBroadcastConfig, ensureSchema as ensureBroadcastSchema } from './_broadcast.js';
import { readScheduleRecord } from './_broadcast-schedule.js';
import { kitConfigured } from './_kit.js';

const ID = /^[A-Za-z0-9]{6,32}$/;
const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });

/**
 * Everything that went out for each upcoming reveal besides its invite, for the
 * tracker on Reveals → Now: its live broadcast (countdown) with the reminder
 * sends and the Kit email, how many people asked for reminders, and the last
 * reveal-check comment. Adds r.broadcast, r.reminderSignups and r.checkComment.
 */
export async function addTracking(env, upcoming) {
  const DB = env.DB;
  if (!upcoming.length) return;
  await ensureBroadcastSchema(DB);
  const ids = upcoming.map((r) => r.jobId);
  const since = new Date(Date.now() - 180 * 86400e3).toISOString();
  const [rows, signups, nudges] = await Promise.all([
    DB.prepare('SELECT id, kid_slug, phase, scheduled_at, live_at, ended_at, data, created_at FROM broadcasts WHERE created_at >= ? ORDER BY created_at').bind(since).all(),
    DB.prepare('SELECT kid_slug, COUNT(*) AS n FROM broadcast_reminders WHERE unsubscribed_at IS NULL GROUP BY kid_slug').all(),
    // The reveal checks make their table on first run; until then there are no comments
    (async () => DB.prepare(`SELECT job_id, message, posted_at FROM reveal_nudges WHERE job_id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all())().catch(() => ({ results: [] })),
  ]);
  // The latest broadcast planned from each job (cancelled ones count: a reveal can be taken down and put back)
  const byJob = {};
  for (const b of rows.results || []) {
    let d = {};
    try { d = JSON.parse(b.data || '{}'); } catch { /* no job */ }
    if (d.jobId && ids.includes(d.jobId)) byJob[d.jobId] = { ...b, data: d };
  }
  const bIds = Object.values(byJob).map((b) => b.id);
  const sends = bIds.length
    ? (await DB.prepare(`SELECT broadcast_id, kind, channel, recipients, sent, failed, error, created_at FROM broadcast_sends WHERE broadcast_id IN (${bIds.map(() => '?').join(', ')})`).bind(...bIds).all()).results || []
    : [];
  const signupCounts = Object.fromEntries((signups.results || []).map((r) => [r.kid_slug || '', r.n]));
  const nudgeBy = Object.fromEntries((nudges.results || []).map((n) => [n.job_id, n]));
  for (const r of upcoming) {
    const b = byJob[r.jobId];
    r.broadcast = b ? {
      id: b.id, phase: b.phase, scheduledAt: b.scheduled_at, liveAt: b.live_at, endedAt: b.ended_at, createdAt: b.created_at,
      kitLiveEmail: b.data.kitLiveEmail ?? null,
      kit: { scheduledDraft: !!b.data.kit?.scheduledDraftId, live: b.data.kit?.live || null },
      sends: sends.filter((x) => x.broadcast_id === b.id).map(({ broadcast_id, ...x }) => x),
    } : null;
    // Reminders go to people who asked about this kid plus everyone who asked about every reveal
    r.reminderSignups = (signupCounts[''] || 0) + (r.slug ? signupCounts[r.slug] || 0 : 0);
    const n = nudgeBy[r.jobId];
    r.checkComment = n?.posted_at ? { at: new Date(Number(n.posted_at)).toISOString(), message: n.message } : null;
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const q = url.searchParams;
  const me = context.data?.userEmail || '';
  try {
    await ensureSchema(env.DB);

    if (q.has('test') || q.has('test-cancel')) {
      const jobId = q.get('test') || q.get('test-cancel');
      if (!ID.test(jobId)) return fail('A JobTread job id is required');
      if (!me.includes('@')) return fail('Could not tell who you are from Access', 403);
      const date = q.get('date');
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('date must be YYYY-MM-DD');
      const timeParam = q.get('time');
      if (timeParam && timeParam !== 'none' && !/^\d{2}:\d{2}$/.test(timeParam)) return fail('time must be HH:MM or none');
      const result = await sendTestInvite(env, jobId, me, {
        date: date || undefined,
        time: timeParam === null ? undefined : (timeParam === 'none' ? null : timeParam),
        cancel: q.has('test-cancel'),
      });
      return Response.json({ ok: true, sentTo: me, ...result });
    }

    // Bring one reveal's invite up to date now (the admin's Retry / Sync now)
    if (q.has('sync')) {
      const jobId = q.get('sync');
      if (!ID.test(jobId)) return fail('A JobTread job id is required');
      const result = await reconcileJob(env, jobId);
      return Response.json({ ok: result.action !== 'error', ...result, ...(result.event ? { event: undefined } : {}) });
    }

    if (q.has('preview')) {
      const jobId = q.get('preview');
      if (!ID.test(jobId)) return fail('A JobTread job id is required');
      return Response.json({ ok: true, ...(await reconcileJob(env, jobId, { dryRun: true })) });
    }

    if (q.has('enable')) {
      const enabled = q.get('enable') === '1';
      const before = await readConfig(env.DB);
      const config = await writeConfig(env.DB, { enabled });
      await logAudit(env.DB, {
        userEmail: me || 'unknown', action: 'updated', entityType: 'site-config', entitySlug: 'reveal-invites',
        entityName: 'Reveal calendar invites', changes: [{ field: 'enabled', from: before.enabled, to: enabled }], gitStatus: 'ok',
      }).catch(() => {});
      return Response.json({ ok: true, config });
    }

    // Reveal checks (the weekday comments for Project Managers)
    if (q.has('checks')) {
      const mode = q.get('checks');
      if (!['preview', 'run', 'test'].includes(mode)) return fail('checks must be preview, run or test');
      const results = await runNudges(env, { dryRun: mode === 'preview', jobIds: mode === 'test' ? [SANDBOX_JOB_ID] : null });
      if (mode === 'run') await writeNudgeConfig(env.DB, { lastRun: summarize(results, Date.now()), lastError: null });
      return Response.json({ ok: true, mode, results: results.filter(r => r.action !== 'skip'), skipped: results.filter(r => r.action === 'skip').length });
    }

    if (q.has('checks-enable')) {
      const enabled = q.get('checks-enable') === '1';
      const before = await readNudgeConfig(env.DB);
      const checks = await writeNudgeConfig(env.DB, { enabled });
      await logAudit(env.DB, {
        userEmail: me || 'unknown', action: 'updated', entityType: 'site-config', entitySlug: 'reveal-nudges',
        entityName: 'Reveal checks', changes: [{ field: 'enabled', from: before.enabled, to: enabled }], gitStatus: 'ok',
      }).catch(() => {});
      return Response.json({ ok: true, checks });
    }

    if (q.get('sweep') === '1') {
      const results = await reconcileAll(env);
      return Response.json({ ok: true, results });
    }

    if (q.get('board') === '1') return Response.json({ ok: true, board: await boardRoster(env.DB) });

    context.waitUntil(maybeSweep(env));
    context.waitUntil(maybeNudge(env));
    const [config, checks, broadcast, schedule, board] = await Promise.all([
      readConfig(env.DB), readNudgeConfig(env.DB),
      readState(env.DB).catch(() => null), readScheduleRecord(env.DB),
      boardRoster(env.DB).catch(() => []),
    ]);
    let upcoming = [];
    let organizerName = null;
    let upcomingError = null;
    if (env.JOBTREAD_GRANT_KEY) {
      try { ({ reveals: upcoming, organizerName } = await listUpcoming(env)); } catch (err) { upcomingError = err.message; }
    }
    await addTracking(env, upcoming).catch(() => {});
    const bcConfig = await readBroadcastConfig(env.DB).catch(() => null);
    return Response.json({
      ok: true,
      config,
      checks,
      organizerName,
      defaults: DEFAULT_TEMPLATE,
      limits: TEMPLATE_LIMITS,
      setup: { jobtread: Boolean(env.JOBTREAD_GRANT_KEY), google: Boolean(env.GOOGLE_CALENDAR_KEY) },
      upcoming,
      ...(upcomingError ? { upcomingError } : {}),
      // Who confirmed invites add from the website's board, and who still needs an email
      board: board.filter((m) => !m.memorial).map(({ slug, name, email }) => ({ slug, name, hasEmail: !!email })),
      // The live countdown: which job it follows, and confirmed reveals it can't follow yet (and why)
      live: {
        phase: broadcast?.phase || 'idle',
        jobId: broadcast?.jobId || null,
        scheduledAt: broadcast?.scheduledAt || null,
        waiting: Object.fromEntries((schedule?.waiting || []).map((w) => [w.jobId, { problem: w.problem, nearMiss: w.nearMiss || null }])),
        checkedAt: schedule?.checkedAt || null,
        reminders: {
          enabled: bcConfig?.reminders?.enabled !== false,
          hoursBefore: bcConfig?.reminders?.hoursBefore || [24, 1],
        },
        kit: { configured: kitConfigured(env), enabled: bcConfig?.kitLive?.enabled !== false, audience: bcConfig?.kitLive?.audience?.name || 'All subscribers' },
      },
    });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST { enabled?, organizer?, template?, updateExisting? } → settings
 * (A reveal's notes are edited only in JobTread, "Reveal Invite Details".)
 */
export async function onRequestPost(context) {
  const { env } = context;
  const me = context.data?.userEmail || 'unknown';
  let body = {};
  try { body = await context.request.json(); } catch { /* empty */ }

  try {
    await ensureSchema(env.DB);

    // A board member's private reveal email (People → Board): open invites follow right away
    if (body.boardEmail && typeof body.boardEmail === 'object') {
      const slug = String(body.boardEmail.slug || '').trim();
      const member = (await boardRoster(env.DB)).find((m) => m.slug === slug);
      if (!member) return fail('Not a board member on the website');
      try { await setBoardEmail(env.DB, slug, body.boardEmail.email); } catch (e) { return fail(e.message); }
      await logAudit(env.DB, { userEmail: me, action: 'updated', entityType: 'team', entitySlug: slug, entityName: `Reveal invite email for ${member.name}`, gitStatus: 'ok' }).catch(() => {});
      context.waitUntil(refreshForBoardChange(env));
      return Response.json({ ok: true, board: await boardRoster(env.DB) });
    }

    const patch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.organizer === 'string') {
      const o = body.organizer.trim().toLowerCase();
      if (!/^[^\s@]+@soardcharity\.com$/.test(o)) return fail('organizer must be a soardcharity.com address');
      patch.organizer = o;
    }
    if (body.template && typeof body.template === 'object') {
      const template = {};
      for (const [key, max] of Object.entries(TEMPLATE_LIMITS)) {
        const value = String(body.template[key] ?? DEFAULT_TEMPLATE[key]).replace(/\r\n/g, '\n').trim();
        if (!value) return fail('Titles and messages can\'t be empty');
        if (value.length > max) return fail(`That's too long (${max} characters at most)`);
        template[key] = value;
      }
      patch.template = template;
    }
    if (!Object.keys(patch).length) return fail('Nothing to change');

    const before = await readConfig(env.DB);
    const config = await writeConfig(env.DB, patch);
    await logAudit(env.DB, {
      userEmail: me, action: 'updated', entityType: 'site-config', entitySlug: 'reveal-invites', entityName: 'Reveal calendar invites',
      changes: Object.keys(patch).map(field => ({
        field,
        from: field === 'template' ? 'previous wording' : before[field],
        to: field === 'template' ? 'new wording' : config[field],
      })), gitStatus: 'ok',
    }).catch(() => {});

    // New wording reaches existing invites on their next change, or right now when asked
    const updated = patch.template && body.updateExisting === true && config.enabled ? await reconcileAll(env) : null;
    return Response.json({ ok: true, config, ...(updated ? { updated } : {}) });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
