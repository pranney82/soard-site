/**
 * /api/process-admin (Cloudflare Access): Site → Automations → Process
 * ===========================================================================
 * GET  → { success, checkedAt, docs: { makeover, community, policy }, now: { makeover, community }, checks }
 *        each Doc's steps as SOARD's process Docs have them (./_process-docs.js),
 *        the board's Financial Policy Manual by section, who's at each stage
 *        right now, and the money settings against the manual. ?fresh=1 asks Drive now.
 * POST { track, link } → follow that Doc for the track ('' goes back to the
 *        one found by name), then the same as GET
 * POST { review: 'makeover'|'community'|'policy' } → that Doc was looked over
 *        and needs no changes (its yearly review), then the same as GET
 *
 * The automations at each step are pinned in the admin (process-shared.js),
 * from Site → Automations' own map and its live facts.
 */

import { processDocs, pipelineNow, policyChecks, setOverride, readReviews, markReviewed } from './_process-docs.js';
import { logAudit } from './_audit.js';
import { TRACK_LABEL } from '../../public/admin/process-shared.js';

const headers = { 'Cache-Control': 'private, no-store' };

async function payload(context, { fresh = false } = {}) {
  const { env } = context;
  const user = context.data?.userEmail || '';
  const [docs, now] = await Promise.all([
    processDocs(env, { user, fresh }),
    pipelineNow(env).catch(() => null),
  ]);
  const [checks, reviews] = await Promise.all([
    policyChecks(env, docs.policy).catch(() => ({ approvals: null })),
    readReviews(env.DB).catch(() => ({})),
  ]);
  return { success: true, checkedAt: new Date().toISOString(), docs, now, checks, reviews };
}

export async function onRequestGet(context) {
  try {
    const fresh = new URL(context.request.url).searchParams.get('fresh') === '1';
    return Response.json(await payload(context, { fresh }), { headers });
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502 bodies with its own error page
    return Response.json({ success: false, error: err.message }, { status: 500, headers });
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    const body = await request.json().catch(() => ({}));
    if (body.review !== undefined) {
      const doc = String(body.review || '');
      await markReviewed(env.DB, doc, context.data?.userEmail || null);
      await logAudit(env.DB, {
        userEmail: context.data?.userEmail, action: 'updated', entityType: 'site-config', entitySlug: `process-${doc}`,
        entityName: `Process: ${TRACK_LABEL[doc] || 'the financial policy'} reviewed for the year, no changes`, gitStatus: 'ok',
      });
      return Response.json(await payload(context), { headers });
    }
    const track = String(body.track || '');
    const link = String(body.link || '').trim();
    const id = await setOverride(env.DB, track, link);
    await logAudit(env.DB, {
      userEmail: context.data?.userEmail, action: 'updated', entityType: 'site-config', entitySlug: `process-${track}`,
      entityName: `Process: ${TRACK_LABEL[track] || 'the financial policy'} follows ${id ? 'a pasted Google Doc' : 'the Doc found by name'}`, gitStatus: 'ok',
    });
    return Response.json(await payload(context), { headers });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: err.status || 500, headers });
  }
}
