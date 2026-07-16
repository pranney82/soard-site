/**
 * GET /api/fb-live-videos — admin diagnostic for the Facebook connection
 * ======================================================================
 * Fetches the page's recent live videos (newest first, live or ended)
 * through the same FB_PAGE_ID + FB_PAGE_TOKEN the auto-detection uses.
 * Powers the "Test connection" button on the admin Go Live page: if this
 * returns videos, the whole chain — page id, token, permissions — works.
 *
 * Authenticated via Cloudflare Access (middleware default — not public).
 *
 * Env bindings: none beyond env vars FB_PAGE_ID, FB_PAGE_TOKEN
 */

const FB_GRAPH = 'https://graph.facebook.com/v25.0';

export async function onRequestGet(context) {
  const { FB_PAGE_ID, FB_PAGE_TOKEN } = context.env;

  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) {
    return Response.json({ success: true, configured: false, videos: [] });
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

    return Response.json({ success: true, configured: true, videos });
  } catch (err) {
    return Response.json({ success: false, configured: true, error: err.message });
  }
}
