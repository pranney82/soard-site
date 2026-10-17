/**
 * /api/reveal-invites-admin (Cloudflare Access) — reveal calendar invites, for Reveals → Invites
 *
 * GET                         → settings, setup checks, and every job's invite record
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
 * POST { enabled, organizer } → turn sending on/off, change the organizer
 *
 * Test links are GETs on purpose: open them in a browser signed in to Access.
 */

import {
  ensureSchema, readConfig, writeConfig, reconcileJob, reconcileAll, sendTestInvite,
  listUpcoming, maybeSweep, DEFAULT_TEMPLATE, TEMPLATE_LIMITS,
} from './_reveal-invites.js';
import { readNudgeConfig, writeNudgeConfig, runNudges, maybeNudge, summarize, SANDBOX_JOB_ID } from './_reveal-nudges.js';
import { logAudit } from './_audit.js';

const ID = /^[A-Za-z0-9]{6,32}$/;
const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });

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

    context.waitUntil(maybeSweep(env));
    context.waitUntil(maybeNudge(env));
    const [config, checks] = await Promise.all([readConfig(env.DB), readNudgeConfig(env.DB)]);
    let upcoming = [];
    let organizerName = null;
    let upcomingError = null;
    if (env.JOBTREAD_GRANT_KEY) {
      try { ({ reveals: upcoming, organizerName } = await listUpcoming(env)); } catch (err) { upcomingError = err.message; }
    }
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
