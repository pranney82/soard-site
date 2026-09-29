/**
 * Facebook Live helpers for the broadcast system
 * ==============================================
 * Two modes, chosen in the admin (broadcast-config.facebook.mode):
 *
 *  "persistent" (works today, no Facebook approval needed)
 *    Stream pushes the video to the page's persistent stream key. The office
 *    schedules the live post in Live Producer ahead of time and Facebook
 *    auto-starts it when the stream arrives (or someone taps Go Live). We
 *    only READ from Facebook here, to find the live post's permalink so the
 *    site can link straight to it.
 *
 *  "api" (after Facebook approves the Live Video API for the app)
 *    We create the live post ourselves the moment the phone connects, point
 *    a Stream simulcast output at the ingest URL Facebook returns, and end
 *    the post when the phone disconnects. Zero taps.
 *
 * Reads use the /videos edge (live_status), never /live_videos, which is
 * gated behind App Review even for reading your own page (error #10).
 *
 * Env vars: FB_PAGE_ID, FB_PAGE_TOKEN
 */

const FB_GRAPH = 'https://graph.facebook.com/v25.0';

export function fbConfigured(env) {
  return !!(env.FB_PAGE_ID && env.FB_PAGE_TOKEN);
}

async function graph(env, method, path, params = {}) {
  const url = new URL(`${FB_GRAPH}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: env.FB_PAGE_TOKEN });
  const init = { method, signal: AbortSignal.timeout(15000) };
  if (method === 'GET') url.search = body.toString();
  else { init.body = body; init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    return { ok: false, status: res.status, error: data.error?.message || `Graph API returned ${res.status}`, code: data.error?.code || null };
  }
  return { ok: true, status: res.status, data };
}

/** Token + page health. */
export async function checkFbToken(env) {
  if (!fbConfigured(env)) return { ok: false, configured: false, error: 'FB_PAGE_ID / FB_PAGE_TOKEN not set' };
  try {
    const r = await graph(env, 'GET', env.FB_PAGE_ID, { fields: 'id,name,link' });
    if (!r.ok) return { ok: false, configured: true, error: r.error, code: r.code };
    return { ok: true, configured: true, name: r.data.name, link: r.data.link };
  } catch (e) {
    return { ok: false, configured: true, error: e.message };
  }
}

/**
 * What the page token can do: app id, granted scopes, expiry. Drives the
 * admin's App Review helper (which permissions are still missing, and a
 * direct link to the app's App Review page).
 */
export async function fbTokenInfo(env) {
  if (!fbConfigured(env)) return { ok: false, configured: false };
  try {
    const r = await graph(env, 'GET', 'debug_token', { input_token: env.FB_PAGE_TOKEN });
    if (!r.ok) return { ok: false, configured: true, error: r.error };
    const d = r.data.data || {};
    const scopes = d.scopes || [];
    const needed = ['pages_manage_posts', 'publish_video', 'pages_read_engagement', 'pages_show_list'];
    return {
      ok: !!d.is_valid,
      configured: true,
      appId: d.app_id || null,
      type: d.type || null,
      expiresAt: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
      scopes,
      missingForApiMode: needed.filter(s => !scopes.includes(s)),
      appReviewUrl: d.app_id ? `https://developers.facebook.com/apps/${d.app_id}/app-review/permissions/` : null,
      appSettingsUrl: d.app_id ? `https://developers.facebook.com/apps/${d.app_id}/settings/basic/` : null,
    };
  } catch (e) {
    return { ok: false, configured: true, error: e.message };
  }
}

/** The page's currently-LIVE video, if any: { id, permalink, title } or null. */
export async function fbCurrentLive(env) {
  if (!fbConfigured(env)) return null;
  try {
    const r = await graph(env, 'GET', `${env.FB_PAGE_ID}/videos`, { fields: 'live_status,permalink_url,title,created_time', limit: '5' });
    if (!r.ok) return null;
    const v = (r.data.data || []).find(x => x.live_status === 'LIVE' && x.permalink_url);
    if (!v) return null;
    const permalink = v.permalink_url.startsWith('http') ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`;
    return { id: v.id, permalink, title: v.title || null };
  } catch {
    return null;
  }
}

/** Recent videos with a live_status (LIVE or VOD), newest first. */
export async function fbRecentBroadcasts(env, limit = 5) {
  if (!fbConfigured(env)) return { ok: false, error: 'not configured', videos: [] };
  try {
    const r = await graph(env, 'GET', `${env.FB_PAGE_ID}/videos`, { fields: 'live_status,permalink_url,title,created_time', limit: '25' });
    if (!r.ok) return { ok: false, error: r.error, videos: [] };
    const videos = (r.data.data || []).filter(v => v.live_status).slice(0, limit).map(v => ({
      id: v.id,
      status: v.live_status,
      title: v.title || null,
      createdAt: v.created_time,
      url: v.permalink_url?.startsWith('http') ? v.permalink_url : `https://www.facebook.com${v.permalink_url || ''}`,
    }));
    return { ok: true, videos };
  } catch (e) {
    return { ok: false, error: e.message, videos: [] };
  }
}

/**
 * API mode: create a live post that goes live as soon as video arrives.
 * Returns { ok, id, ingestUrl, error, needsReview }.
 */
export async function createFbLiveVideo(env, { title, description }) {
  if (!fbConfigured(env)) return { ok: false, error: 'not configured' };
  try {
    const r = await graph(env, 'POST', `${env.FB_PAGE_ID}/live_videos`, {
      status: 'LIVE_NOW',
      title: String(title || '').slice(0, 254),
      description: String(description || '').slice(0, 5000),
    });
    if (!r.ok) {
      // (#10) or (#200): the app has not passed App Review for the Live Video API
      const needsReview = r.code === 10 || r.code === 200 || /reviewed|approved|permission/i.test(r.error || '');
      return { ok: false, error: r.error, code: r.code, needsReview };
    }
    return { ok: true, id: r.data.id, ingestUrl: r.data.secure_stream_url || r.data.stream_url || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function endFbLiveVideo(env, liveVideoId) {
  if (!fbConfigured(env) || !liveVideoId) return { ok: false, error: 'not configured' };
  try {
    const r = await graph(env, 'POST', liveVideoId, { end_live_video: 'true' });
    return r.ok ? { ok: true } : { ok: false, error: r.error, code: r.code };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Permalink for a live video object (works in API mode once it exists). */
export async function fbLiveVideoPermalink(env, liveVideoId) {
  if (!fbConfigured(env) || !liveVideoId) return null;
  try {
    const r = await graph(env, 'GET', liveVideoId, { fields: 'permalink_url,status,video{permalink_url}' });
    if (!r.ok) return null;
    const p = r.data.video?.permalink_url || r.data.permalink_url || null;
    if (!p) return null;
    return p.startsWith('http') ? p : `https://www.facebook.com${p}`;
  } catch {
    return null;
  }
}

/** Split Facebook's rtmps://host:443/rtmp/<key> ingest URL into a Stream output { url, streamKey }. */
export function splitIngestUrl(ingestUrl) {
  if (!ingestUrl) return null;
  const idx = ingestUrl.lastIndexOf('/');
  if (idx < 0) return null;
  return { url: ingestUrl.slice(0, idx + 1), streamKey: ingestUrl.slice(idx + 1) };
}
