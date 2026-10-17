/**
 * /api/reveal-invites-admin (Cloudflare Access) — reveal calendar invites
 *
 * GET                         → settings, setup checks, and every job's invite record
 * GET ?test=<jobId>           → send that job's invite to YOU only, as a separate TEST event
 *        &date=YYYY-MM-DD       try a moved date
 *        &time=HH:MM | none     try a time (or back to all day)
 * GET ?test-cancel=<jobId>    → cancel your TEST event
 * GET ?preview=<jobId>        → what the real invite would be and who gets it (sends nothing)
 * GET ?sweep=1                → reconcile every open job (dry run while sending is off)
 * GET ?enable=1 | ?enable=0   → turn sending on / off
 * POST { enabled, organizer } → turn sending on/off, change the organizer
 *
 * Test links are GETs on purpose: open them in a browser signed in to Access.
 */

import {
  ensureSchema, readConfig, writeConfig, reconcileJob, reconcileAll, sendTestInvite,
  listUpcoming, setInviteDetails, DEFAULT_TEMPLATE, TEMPLATE_LIMITS,
} from './_reveal-invites.js';
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

    if (q.get('sweep') === '1') {
      const results = await reconcileAll(env);
      return Response.json({ ok: true, results });
    }

    const config = await readConfig(env.DB);
    let upcoming = [];
    let upcomingError = null;
    if (env.JOBTREAD_GRANT_KEY) {
      try { upcoming = await listUpcoming(env); } catch (err) { upcomingError = err.message; }
    }
    return Response.json({
      ok: true,
      config,
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
 * POST { jobId, details }                                   → a reveal's notes, saved to JobTread
 */
export async function onRequestPost(context) {
  const { env } = context;
  const me = context.data?.userEmail || 'unknown';
  let body = {};
  try { body = await context.request.json(); } catch { /* empty */ }

  try {
    await ensureSchema(env.DB);

    if (typeof body.jobId === 'string') {
      if (!ID.test(body.jobId)) return fail('A JobTread job id is required');
      const result = await setInviteDetails(env, body.jobId, body.details);
      await logAudit(env.DB, {
        userEmail: me, action: 'updated', entityType: 'reveal-invite', entitySlug: body.jobId, entityName: 'Reveal invite notes',
        changes: [{ field: 'Reveal Invite Details', from: null, to: String(body.details || '').slice(0, 200) }], gitStatus: 'ok',
      }).catch(() => {});
      return Response.json({ ok: result.action !== 'error', result, ...(result.error ? { error: result.error } : {}) });
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
