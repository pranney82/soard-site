/**
 * POST /api/fb-archive-video — manually copy a Facebook live replay into Stream
 * ==============================================================================
 * Manual override for the automatic archiver (see _fb-archive.js — replays are
 * normally saved to Cloudflare Stream by the background sweep within hours of a
 * broadcast ending). Powers the "Save to Stream" button on the admin Go Live
 * page for archiving something immediately or re-trying a failed sweep.
 *
 * Body: { videoId: "1043114978402332" }   (numeric Facebook video id)
 * Returns: { success, uid, name, watch }  (uid = Stream video id)
 *
 * Authenticated via Cloudflare Access (middleware default — not public).
 * Env vars: FB_PAGE_TOKEN, CF_ACCOUNT_ID, CF_STREAM_TOKEN (Stream:Edit)
 */

import { logAudit } from './_audit.js';
import { archiveOne, recordArchived } from './_fb-archive.js';

export async function onRequestPost(context) {
  try {
    const { DB, FB_PAGE_TOKEN, CF_ACCOUNT_ID, CF_STREAM_TOKEN } = context.env;
    const userEmail = context.data?.userEmail || 'unknown';

    if (!FB_PAGE_TOKEN) {
      return Response.json({ success: false, error: 'FB_PAGE_TOKEN not configured' }, { status: 500 });
    }
    if (!CF_ACCOUNT_ID || !CF_STREAM_TOKEN) {
      return Response.json({ success: false, error: 'CF_ACCOUNT_ID / CF_STREAM_TOKEN not configured' }, { status: 500 });
    }

    const { videoId } = await context.request.json();
    if (!/^\d{6,20}$/.test(String(videoId || ''))) {
      return Response.json({ success: false, error: 'videoId must be the numeric Facebook video id' }, { status: 400 });
    }

    let result;
    try {
      result = await archiveOne(context.env, String(videoId));
    } catch (err) {
      return Response.json({ success: false, error: err.message }, { status: 502 });
    }

    await recordArchived(DB, String(videoId), result);
    await logAudit(DB, {
      userEmail,
      action: 'created',
      entityType: 'stream-video',
      entitySlug: result.uid,
      entityName: `Archived FB live: ${result.name}`,
      changes: [{ field: 'source', from: null, to: `facebook video ${videoId}` }],
      gitStatus: 'ok',
    });

    return Response.json({
      success: true,
      uid: result.uid,
      name: result.name,
      watch: `https://iframe.videodelivery.net/${result.uid}`,
    });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
