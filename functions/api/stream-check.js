/**
 * GET /api/stream-check?uid=<32-hex Stream uid>
 * =============================================
 * Will a kid page play this Stream video? The same check the build makes in
 * src/utils/reveals.ts (fetch the HLS manifest): 200 = playable, 4xx = gone
 * (purged, still processing, or the subscription lapsed), anything else =
 * unknown. The admin's Preview uses it to pick the video the page will show;
 * browsers can't make the check themselves because Stream's manifest CORS
 * only allows videodelivery.net.
 *
 * Returns { success, uid, state: 'playable' | 'gone' | 'unknown' }.
 * Authenticated via Cloudflare Access (middleware default, not public).
 */

import { playbackHost } from './_stream-live.js';

const UID_RE = /^[a-f0-9]{32}$/i;

export async function checkStreamUid(uid, fetchImpl = fetch) {
  if (!UID_RE.test(uid || '')) return 'gone';
  try {
    const res = await fetchImpl(`${playbackHost()}/${uid.toLowerCase()}/manifest/video.m3u8`, {
      signal: AbortSignal.timeout(8000),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status === 200) return 'playable';
    return res.status >= 400 && res.status < 500 ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function onRequestGet(context) {
  const uid = new URL(context.request.url).searchParams.get('uid') || '';
  const state = await checkStreamUid(uid);
  return Response.json({ success: true, uid, state }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
