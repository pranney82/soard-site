/**
 * /api/kid-kit-emails — the "Emails in Kit" card on a kid in Admin → Kids
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET  ?slug=&jobId=           → { ok, off, page, invite, watch, kickoff, reveal }: where each email stands, read from Kit;
 *                                page: { published, completed }, the kid's page as the emails see it
 * POST { slug, kind, jobId? }  → that email drafted in Kit now. kind 'invite' or 'watch' (the
 *                                whole-list invite; both need the JobTread job), 'kickoff' or 'reveal'.
 *
 * Drafts only, like every Kit email the site makes: staff review and send them
 * from Kit. The reveal invite is the same draft as Draft invite email on
 * Reveals → Now (./_reveal-invites.js draftInviteEmailNow); Kickoff and Project
 * Reveal are ./_project-emails.js draftProjectEmailNow.
 */

import { draftInviteEmailNow } from './_reveal-invites.js';
import { kitInviteStatus } from './_reveal-invite-kit.js';
import { draftProjectEmailNow, projectEmailStatus } from './_project-emails.js';
import { logAudit } from './_audit.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const ID = /^[A-Za-z0-9]{6,32}$/;
const KIND_NAMES = { invite: 'reveal invite', watch: 'whole-list invite', kickoff: 'Project Kickoff', reveal: 'Project Reveal' };
const fail = (error, status = 400) => Response.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });
const kitUrl = (id) => `https://app.kit.com/campaigns/${encodeURIComponent(id)}`;

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('DB not bound', 500);
  const q = new URL(request.url).searchParams;
  const slug = q.get('slug') || '';
  const jobId = q.get('jobId') || '';
  if (!SLUG_RE.test(slug)) return fail('A kid is required');
  if (jobId && !ID.test(jobId)) return fail('Not a JobTread job');
  try {
    const [project, invites, watches] = await Promise.all([
      projectEmailStatus(env, slug),
      jobId ? kitInviteStatus(env, [jobId]) : Promise.resolve({}),
      jobId ? kitInviteStatus(env, [jobId], 'watch') : Promise.resolve({}),
    ]);
    const stand = (got) => {
      const x = jobId ? got[jobId] || { state: 'none' } : { state: 'nojob' };
      // Nothing in Kit to open: say what would stop a draft, as Kickoff and Project Reveal do
      if (['none', 'waiting', 'deleted'].includes(x.state)) {
        x.block = !project.page.published ? 'Publish the page first: the email links to it'
          : project.page.completed ? 'The reveal is over' : null;
      }
      return x;
    };
    const withUrl = (x) => (x?.id ? { ...x, url: kitUrl(x.id) } : x);
    return Response.json({ ok: true, off: project.off, page: project.page, invite: withUrl(stand(invites)), watch: withUrl(stand(watches)), kickoff: withUrl(project.kickoff), reveal: withUrl(project.reveal) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return fail(err.message, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const me = context.data?.userEmail || '';
  if (!me.includes('@')) return fail('Could not tell who you are from Access', 403);
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  const slug = String(body?.slug || '');
  const kind = String(body?.kind || '');
  if (!SLUG_RE.test(slug)) return fail('A kid is required');
  if (!KIND_NAMES[kind]) return fail('Not one of the kid’s Kit emails');

  try {
    let result;
    if (kind === 'invite' || kind === 'watch') {
      const jobId = String(body.jobId || '');
      if (!ID.test(jobId)) return fail('This kid has no JobTread job, so there’s no reveal to invite to');
      const r = await draftInviteEmailNow(env, jobId, { kind });
      // Same answers as Draft invite email on Reveals → Now
      result = { ...r, made: ['drafted', 'redesigned', 'check'].includes(r.kit), ok: !['error', 'skip', 'off'].includes(r.kit) };
    } else {
      const r = await draftProjectEmailNow(env, { slug, kind, by: me });
      result = { ...r, made: r.project === 'drafted', ok: ['drafted', 'unchanged'].includes(r.project) };
    }
    if (result.made && result.id) {
      await logAudit(env.DB, { userEmail: me, action: 'created', entityType: 'newsletter', entitySlug: String(result.id), entityName: `Kit ${KIND_NAMES[kind]} draft: ${result.name || slug}`, gitStatus: 'ok' }).catch(() => {});
    }
    return Response.json({ ...result, ...(result.id ? { url: kitUrl(result.id) } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return fail(err.message, 500);
  }
}
