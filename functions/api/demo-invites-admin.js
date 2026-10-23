/**
 * /api/demo-invites-admin (Cloudflare Access) — demo day calendar invites, for the admin's Demo Day page
 *
 * GET                          → settings, setup checks, every demo day ahead with its exact invite
 *                                and guests (the sponsor's people on each job), and the every-demo-day list
 * GET ?test=<jobId>            → send that job's invite to YOU only, as a separate TEST event
 * GET ?test-cancel=<jobId>     → take your TEST event back
 * GET ?sync=<jobId>            → bring that job's invite up to date now (Retry)
 *        &force=1               send it even though it was sent by hand or deleted in Google
 * POST { enabled }             → turn sending on / off
 * POST { template, startTime, minutes, updateExisting } → wording and the default time
 * POST { person: { email, name, role } }   → add someone to every demo day
 * POST { removePerson: { email } }          → take them off
 * A list change reaches invites already out right away. Everyone else on an
 * invite comes from JobTread (the sponsor is the Sponsor role on the job).
 *
 * Emails typed here live in D1 (demo_invite_people), never site_config.
 */

import {
  ensureSchema, readConfig, writeConfig, reconcileDemo, sendTestDemo, listDemos, maybeCheckDemos, checkAll, refreshOpen,
  listPeople, savePerson, removePerson, DEFAULT_TEMPLATE, TEMPLATE_LIMITS, DEFAULT_START, DEFAULT_MINUTES,
} from './_demo-invites.js';
import { logAudit } from './_audit.js';

const ID = /^[A-Za-z0-9]{6,32}$/;
const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });

export async function onRequestGet(context) {
  const { env } = context;
  const q = new URL(context.request.url).searchParams;
  const me = context.data?.userEmail || '';
  try {
    await ensureSchema(env.DB);

    if (q.has('test') || q.has('test-cancel')) {
      const jobId = q.get('test') || q.get('test-cancel');
      if (!ID.test(jobId)) return fail('A JobTread job id is required');
      if (!me.includes('@')) return fail('Could not tell who you are from Access', 403);
      const result = await sendTestDemo(env, jobId, me, { cancel: q.has('test-cancel') });
      return Response.json({ ok: true, sentTo: me, ...result });
    }

    if (q.has('sync')) {
      const jobId = q.get('sync');
      if (!ID.test(jobId)) return fail('A JobTread job id is required');
      const force = q.get('force') === '1';
      const result = await reconcileDemo(env, jobId, { force });
      if (force) {
        await logAudit(env.DB, {
          userEmail: me || 'unknown', action: 'updated', entityType: 'site-config', entitySlug: 'demo-invites',
          entityName: `Demo day invite sent anyway (job ${jobId})`, gitStatus: 'ok',
        }).catch(() => {});
      }
      return Response.json({ ok: result.action !== 'error', ...result, event: undefined });
    }

    context.waitUntil(maybeCheckDemos(env));
    const config = await readConfig(env.DB);
    let list = null;
    let listError = null;
    if (env.JOBTREAD_GRANT_KEY) {
      try { list = await listDemos(env); } catch (err) { listError = err.message; }
    }
    return Response.json({
      ok: true,
      config,
      defaults: { template: DEFAULT_TEMPLATE, startTime: DEFAULT_START, minutes: DEFAULT_MINUTES },
      limits: TEMPLATE_LIMITS,
      setup: { jobtread: Boolean(env.JOBTREAD_GRANT_KEY), google: Boolean(env.GOOGLE_CALENDAR_KEY) },
      organizer: list?.organizer || null,
      organizerName: list?.organizerName || null,
      staff: list?.staff || [],
      people: list?.people || await listPeople(env.DB),
      demos: list?.demos || [],
      ...(listError ? { listError } : {}),
    });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  const me = context.data?.userEmail || 'unknown';
  let body = {};
  try { body = await context.request.json(); } catch { /* empty */ }

  try {
    await ensureSchema(env.DB);

    // Someone added to (or taken off) a list: invites already out follow right away
    if (body.person && typeof body.person === 'object') {
      try { await savePerson(env.DB, body.person); } catch (e) { return fail(e.message); }
      await logAudit(env.DB, { userEmail: me, action: 'updated', entityType: 'site-config', entitySlug: 'demo-invites', entityName: 'Demo day invites: added to every demo day', gitStatus: 'ok' }).catch(() => {});
      context.waitUntil(refreshOpen(env));
      return Response.json({ ok: true, people: await listPeople(env.DB) });
    }
    if (body.removePerson && typeof body.removePerson === 'object') {
      try { await removePerson(env.DB, body.removePerson); } catch (e) { return fail(e.message); }
      await logAudit(env.DB, { userEmail: me, action: 'updated', entityType: 'site-config', entitySlug: 'demo-invites', entityName: 'Demo day invites: taken off every demo day', gitStatus: 'ok' }).catch(() => {});
      context.waitUntil(refreshOpen(env));
      return Response.json({ ok: true, people: await listPeople(env.DB) });
    }

    const patch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (body.template && typeof body.template === 'object') {
      const template = {};
      for (const [key, max] of Object.entries(TEMPLATE_LIMITS)) {
        const value = String(body.template[key] ?? DEFAULT_TEMPLATE[key]).replace(/\r\n/g, '\n').trim();
        if (!value) return fail('The title and message can\'t be empty');
        if (value.length > max) return fail(`That's too long (${max} characters at most)`);
        template[key] = value;
      }
      patch.template = template;
    }
    if (body.startTime !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.startTime))) return fail('The start time should look like 09:00');
      patch.startTime = body.startTime;
    }
    if (body.minutes !== undefined) {
      const m = Number(body.minutes);
      if (!Number.isInteger(m) || m < 15 || m > 600) return fail('How long should be between 15 minutes and 10 hours');
      patch.minutes = m;
    }
    if (!Object.keys(patch).length) return fail('Nothing to change');

    const before = await readConfig(env.DB);
    const config = await writeConfig(env.DB, patch);
    await logAudit(env.DB, {
      userEmail: me, action: 'updated', entityType: 'site-config', entitySlug: 'demo-invites', entityName: 'Demo day calendar invites',
      changes: Object.keys(patch).map((field) => ({
        field,
        from: field === 'template' ? 'previous wording' : before[field],
        to: field === 'template' ? 'new wording' : config[field],
      })), gitStatus: 'ok',
    }).catch(() => {});

    // A new default time is a fact (guests are emailed); new wording reaches invites
    // out when their facts next change, or now when asked
    const rewrite = !!patch.template && body.updateExisting === true;
    const touched = config.enabled && (rewrite || patch.startTime || patch.minutes);
    const updated = touched ? await checkAll(env, { rewrite }) : null;
    return Response.json({ ok: true, config, ...(updated ? { updated } : {}) });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
