/**
 * POST /api/fb-attach-video — put an archived Facebook replay on a kid's page
 * ===========================================================================
 * The human override for the archiver's kid matching (see _fb-archive.js).
 * Powers the kid picker next to each saved broadcast on the admin Broadcast
 * page (History → Facebook-only broadcasts).
 *
 * Body: { videoId: "1635000014874417", kidSlug: "remi-and-nico" }  → move/attach
 *       { videoId: "1635000014874417", kidSlug: null }             → take it off every page
 * Returns: { success, uid, kidSlug, kidName, deployed }
 *
 * Writes the kid record(s) in D1 and fires the deploy hook so the page
 * updates without a manual Deploy Now.
 *
 * Authenticated via Cloudflare Access (middleware default — not public).
 */

import { assignArchivedVideo } from './_fb-archive.js';

export async function onRequestPost(context) {
  try {
    let body = {};
    try { body = await context.request.json(); } catch { /* empty */ }
    const videoId = String(body.videoId || '');
    const kidSlug = body.kidSlug == null || body.kidSlug === '' ? null : String(body.kidSlug);
    if (!/^\d{6,20}$/.test(videoId)) {
      return Response.json({ success: false, error: 'videoId must be the numeric Facebook video id' }, { status: 400 });
    }
    if (kidSlug !== null && !/^[a-z0-9-]{1,80}$/.test(kidSlug)) {
      return Response.json({ success: false, error: 'kidSlug must be a kid page slug' }, { status: 400 });
    }
    const userEmail = context.data?.userEmail || 'admin';
    const result = await assignArchivedVideo(context.env, { videoId, kidSlug, by: userEmail });
    return Response.json({ success: true, ...result });
  } catch (err) {
    // 500, not 502: Cloudflare replaces the body of any 502/504 with its own HTML error page.
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
