/**
 * GET /api/fb-live-videos — admin diagnostic for the Facebook connection
 * ======================================================================
 * Fetches the page's recent live videos (newest first, live or ended)
 * through the same FB_PAGE_ID + FB_PAGE_TOKEN the auto-detection uses.
 * Powers the "Test connection" button on the admin Go Live page: if this
 * returns videos, the whole chain — page id, token, permissions — works.
 *
 * Public for GET (see middleware PUBLIC_GET_ROUTES): the response is only the
 * page's public video permalinks — the token never leaves the server. A short
 * module-scope cache keeps anonymous traffic from burning Graph API quota;
 * pass ?fresh=1 (the admin button does) to bypass it.
 *
 * Env bindings: none beyond env vars FB_PAGE_ID, FB_PAGE_TOKEN
 */

const FB_GRAPH = 'https://graph.facebook.com/v25.0';
const CACHE_TTL_MS = 2 * 60 * 1000;
let _cache = { at: 0, body: null };

export async function onRequestGet(context) {
  const { FB_PAGE_ID, FB_PAGE_TOKEN } = context.env;

  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) {
    return Response.json({ success: true, configured: false, videos: [] });
  }

  const fresh = new URL(context.request.url).searchParams.get('fresh') === '1';
  if (!fresh && _cache.body && Date.now() - _cache.at < CACHE_TTL_MS) {
    return Response.json(_cache.body);
  }

  try {
    const qs = new URLSearchParams({
      fields: 'status,permalink_url,title,creation_time',
      limit: '5',
      access_token: FB_PAGE_TOKEN,
    });
    const res = await fetch(`${FB_GRAPH}/${FB_PAGE_ID}/live_videos?${qs}`);
    const data = await res.json();

    if (!res.ok || data.error) {
      // Surface Facebook's own message — it says exactly what's wrong
      // (expired token, missing permission, wrong page id, ...)
      return Response.json({
        success: false,
        configured: true,
        error: data.error?.message || `Graph API returned ${res.status}`,
      });
    }

    const videos = (data.data || []).map(v => ({
      status: v.status,
      title: v.title || null,
      createdAt: v.creation_time || null,
      url: v.permalink_url
        ? (v.permalink_url.startsWith('http') ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`)
        : null,
    }));

    const body = { success: true, configured: true, videos };
    _cache = { at: Date.now(), body };
    return Response.json(body);
  } catch (err) {
    return Response.json({ success: false, configured: true, error: err.message });
  }
}
