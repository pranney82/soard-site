/**
 * GET /api/fb-live-videos — admin diagnostic for the Facebook connection
 * ======================================================================
 * Fetches the page's recent live videos (newest first, live or ended)
 * through the same FB_PAGE_ID + FB_PAGE_TOKEN the auto-detection uses.
 * Powers the "Test connection" button on the admin Go Live page: if this
 * returns videos, the whole chain — page id, token, permissions — works.
 *
 * Public for GET (see middleware PUBLIC_GET_ROUTES), but anonymous callers
 * only see broadcasts that are live now or published replays (LIVE, VOD),
 * always from a short module-scope cache, so anonymous traffic can't burn
 * Graph API quota. A signed-in admin (Cloudflare Access) sees every broadcast
 * and may pass ?fresh=1 to skip the cache. The token never leaves the server,
 * and Facebook's own error text is never passed on: errors are reported by
 * kind (token, permission, page id) and Facebook's numeric code.
 *
 * Env bindings: none beyond env vars FB_PAGE_ID, FB_PAGE_TOKEN
 */

import { annotateArchived } from './_fb-archive.js';
import { isAuthenticated } from './_middleware.js';

const FB_GRAPH = 'https://graph.facebook.com/v25.0';
const CACHE_TTL_MS = 2 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;
// What anyone may see: live right now, or a published replay
const PUBLIC_STATUSES = new Set(['LIVE', 'VOD']);
// The cache holds every broadcast; each response is cut down for its audience
let _cache = { at: 0, videos: null, error: null };

/** Facebook's error as our own words, by its numeric code (the message itself is never echoed) */
export function graphError(err, status) {
  const code = Number.isFinite(Number(err?.code)) ? Number(err.code) : null;
  const what = code === 190 ? 'The Facebook token expired or was revoked'
    : code === 10 || code === 200 || (code >= 200 && code < 300) ? 'The Facebook token is missing a permission'
    : code === 100 || code === 803 ? 'Facebook does not recognize the page id'
    : code === 4 || code === 17 || code === 32 || code === 613 ? 'Facebook is rate limiting requests right now'
    : `Facebook returned an error${status ? ` (HTTP ${status})` : ''}`;
  return code != null ? `${what} (code ${code})` : what;
}

function respond(videos, error, admin) {
  if (error) return Response.json({ success: false, configured: true, error: admin ? error : 'Facebook is not answering right now' });
  return Response.json({ success: true, configured: true, videos: admin ? videos : videos.filter((v) => PUBLIC_STATUSES.has(v.status)) });
}

export async function onRequestGet(context) {
  const { FB_PAGE_ID, FB_PAGE_TOKEN } = context.env;

  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) {
    return Response.json({ success: true, configured: false, videos: [] });
  }

  const admin = await isAuthenticated(context.request, context.env);
  const fresh = admin && new URL(context.request.url).searchParams.get('fresh') === '1';
  const age = Date.now() - _cache.at;
  if (!fresh && (_cache.videos || _cache.error) && age < (_cache.error ? ERROR_TTL_MS : CACHE_TTL_MS)) {
    return respond(_cache.videos, _cache.error, admin);
  }

  try {
    // /videos + live_status filter, NOT /live_videos — see live-status.js:
    // the live_videos edge requires Facebook App Review even for your own
    // page; the videos edge doesn't. Fetch a wider window since reels and
    // regular uploads (no live_status) get filtered out below.
    const qs = new URLSearchParams({
      fields: 'live_status,permalink_url,title,description,created_time',
      limit: '25',
      access_token: FB_PAGE_TOKEN,
    });
    const res = await fetch(`${FB_GRAPH}/${FB_PAGE_ID}/videos?${qs}`, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();

    if (!res.ok || data.error) {
      // Say what kind of problem it is (expired token, missing permission, wrong page id), never Facebook's text
      _cache = { at: Date.now(), videos: null, error: graphError(data.error, res.status) };
      return respond(null, _cache.error, admin);
    }

    // Annotate which broadcasts the auto-archiver has already saved to Stream,
    // and which kid page each one landed on
    const videos = await annotateArchived(context.env.DB, (data.data || [])
      .filter(v => v.live_status) // only broadcasts — reels/uploads have no live_status
      .slice(0, 5)
      .map(v => ({
        id: v.id || null,
        status: v.live_status,
        title: v.title || (v.description ? v.description.slice(0, 80) : null),
        createdAt: v.created_time || null,
        url: v.permalink_url
          ? (v.permalink_url.startsWith('http') ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`)
          : null,
      })));

    _cache = { at: Date.now(), videos, error: null };
    return respond(videos, null, admin);
  } catch {
    _cache = { at: Date.now(), videos: null, error: 'Could not reach Facebook' };
    return respond(null, _cache.error, admin);
  }
}
