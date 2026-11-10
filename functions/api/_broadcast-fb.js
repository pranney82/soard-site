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

/** The Page's live video as fbCurrentLive finds it, and whether Facebook answered at all → { ok, live, error } */
export async function fbCurrentLiveRead(env) {
  if (!fbConfigured(env)) return { ok: false, live: null, error: 'not configured' };
  try {
    const r = await graph(env, 'GET', `${env.FB_PAGE_ID}/videos`, { fields: 'live_status,permalink_url,title,created_time', limit: '5' });
    if (!r.ok) return { ok: false, live: null, error: r.error };
    const v = (r.data.data || []).find(x => x.live_status === 'LIVE' && x.permalink_url);
    if (!v) return { ok: true, live: null, error: null };
    const permalink = v.permalink_url.startsWith('http') ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`;
    return { ok: true, live: { id: v.id, permalink, title: v.title || null }, error: null };
  } catch (e) {
    return { ok: false, live: null, error: e.message };
  }
}

/**
 * Text that might name the kid being revealed right now: the Page's live
 * (or just-started) video title + description, then the Page's own posts
 * from the last day, newest first. Best effort; missing permissions or
 * errors just mean fewer clues. Returns [{ source, text, lead, at }].
 */
export async function fbRevealClues(env, { sinceMs = 24 * 3600e3 } = {}) {
  if (!fbConfigured(env)) return [];
  const since = Date.now() - sinceMs;
  const clues = [];
  try {
    const [vids, posts] = await Promise.all([
      graph(env, 'GET', `${env.FB_PAGE_ID}/videos`, { fields: 'live_status,title,description,created_time', limit: '5' }),
      graph(env, 'GET', `${env.FB_PAGE_ID}/posts`, { fields: 'message,created_time', limit: '10' }),
    ]);
    for (const v of (vids.ok ? vids.data.data || [] : [])) {
      if (v.live_status !== 'LIVE' && Date.parse(v.created_time) < Date.now() - 2 * 3600e3) continue;
      clues.push({ source: 'facebook-live', lead: v.title || '', text: `${v.title || ''} ${v.description || ''}`, at: v.created_time });
    }
    for (const p of (posts.ok ? posts.data.data || [] : [])) {
      if (!p.message || Date.parse(p.created_time) < since) continue;
      clues.push({ source: 'facebook-post', lead: p.message.split('\n')[0], text: p.message, at: p.created_time });
    }
  } catch { /* no clues */ }
  return clues;
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

/**
 * API mode only: what Facebook's ingest is receiving for a live video.
 * Facebook refreshes stream_health every 2 s. Persistent-key mode can't read
 * this (/live_videos needs App Review), so callers fall back to fbCurrentLive.
 * → { ok, status, health: { videoBitrate, audioBitrate, fps, width, height, gopMs } | null, error }
 */
export async function fbLiveVideoHealth(env, liveVideoId) {
  if (!fbConfigured(env) || !liveVideoId) return { ok: false, error: 'not configured' };
  try {
    const r = await graph(env, 'GET', liveVideoId, { fields: 'status,ingest_streams{is_master,stream_health}' });
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    const streams = r.data.ingest_streams?.data || [];
    const h = (streams.find((s) => s.is_master) || streams[0])?.stream_health || null;
    return {
      ok: true,
      status: r.data.status || null,
      health: h ? {
        videoBitrate: h.video_bitrate ?? null,
        audioBitrate: h.audio_bitrate ?? null,
        fps: h.video_framerate ?? null,
        width: h.video_width ?? null,
        height: h.video_height ?? null,
        gopMs: h.video_gop_size ?? null,
      } : null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * How many are watching on Facebook right now (Reveal stats' "watching at
 * once"), from the live video (API mode) or the Page's live video. Its own
 * request, so a refused field can never make the feed monitor think the Page
 * isn't live. → a number, or null when Facebook won't say.
 */
export async function fbLiveViewers(env, liveVideoId = null) {
  if (!fbConfigured(env)) return null;
  try {
    let v = null;
    if (liveVideoId) {
      const r = await graph(env, 'GET', liveVideoId, { fields: 'live_views' });
      v = r.ok ? r.data.live_views : null;
    } else {
      const r = await graph(env, 'GET', `${env.FB_PAGE_ID}/live_videos`, { broadcast_status: '["LIVE"]', fields: 'live_views,status', limit: '1' });
      v = r.ok ? r.data.data?.[0]?.live_views : null;
    }
    return Number.isFinite(Number(v)) && v !== null ? Number(v) : null;
  } catch {
    return null;
  }
}

// Facebook's numbers for a finished live video (video_insights; read_insights + pages_manage_engagement)
const INSIGHT_METRICS = ['total_video_views', 'total_video_views_unique', 'total_video_avg_time_watched', 'total_video_views_live'];

/** Facebook's "Object with ID … does not exist" (deleted, never the Page's) */
const notThere = (r) => !r.ok && /\b(does|do) not exist\b/i.test(r.error || '');

/**
 * A finished live video's totals, for Reveal stats → { ok, totals, partial, missing, error }
 *   totals: { videoId, views, unique, avgSec, liveUnique, reactions, comments }
 *   missing: the permission Facebook said it needs for the view totals (the
 *   reactions and comments still come back without it)
 * Finds the video from the live video (API mode) or the post's permalink.
 */
export async function fbVideoTotals(env, { liveVideoId = null, permalink = null, videoId = null } = {}) {
  if (!fbConfigured(env)) return { ok: false, error: 'FB_PAGE_ID / FB_PAGE_TOKEN not set' };
  // Its video: known already, or from the post's link (/videos/123, /videos/name/123, ?v=123), or the live video's
  const link = String(permalink || '');
  let id = videoId || (link.match(/\/videos\/(?:[^/?#]+\/)?(\d{6,})/) || link.match(/[?&]v=(\d{6,})/) || [])[1] || null;
  if (!id && liveVideoId) {
    const lv = await graph(env, 'GET', liveVideoId, { fields: 'video{id}' });
    if (!lv.ok) return { ok: false, error: lv.error, gone: notThere(lv) };
    id = lv.data.video?.id || null;
  }
  if (!id) return { ok: false, error: 'Facebook has no video for this reveal', gone: true };
  const [ins, eng] = await Promise.all([
    graph(env, 'GET', `${id}/video_insights`, { metric: INSIGHT_METRICS.join(','), period: 'lifetime' }),
    graph(env, 'GET', id, { fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)' }),
  ]);
  const totals = { videoId: id };
  if (ins.ok) {
    const val = (name) => { const m = (ins.data.data || []).find((x) => x.name === name); const v = m?.values?.[0]?.value; return v != null && Number.isFinite(Number(v)) ? Number(v) : null; };
    totals.views = val('total_video_views');
    totals.unique = val('total_video_views_unique');
    const avg = val('total_video_avg_time_watched');
    totals.avgSec = avg != null ? Math.round(avg / 1000) : null;
    totals.liveUnique = val('total_video_views_live');
  }
  if (eng.ok) {
    // Only counts Facebook actually gave (a missing summary isn't a zero)
    const n = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
    totals.reactions = n(eng.data.reactions?.summary?.total_count);
    totals.comments = n(eng.data.comments?.summary?.total_count);
  }
  // The token can't read insights: (#10)/(#200)/(#283), or a message naming the permission. Not (#100) "does not exist,
  // cannot be loaded due to missing permissions": that's a deleted or wrong video, and a new token wouldn't help
  const blocked = !ins.ok && ins.code !== 100 && !/does not exist/i.test(ins.error || '')
    && ([10, 200, 283].includes(ins.code) || /read_insights|pages_manage_engagement|pages_read_engagement|\(#(10|200|283)\)/i.test(ins.error || ''));
  // gone: Facebook says the video isn't there (deleted, or not the Page's), so asking again won't help
  if (!ins.ok && !eng.ok) return { ok: false, error: ins.error, missing: blocked ? 'read_insights' : null, gone: notThere(ins) && notThere(eng) };
  return { ok: true, totals, partial: ins.ok ? null : ins.error, missing: blocked ? 'read_insights' : null };
}

/**
 * A scheduled (not yet live) live post on the Page, if Facebook lists one on
 * the /videos edge. Best effort for the go/no-go: not finding one doesn't
 * prove there isn't one. → { ok, found, title, error }
 */
export async function fbScheduledLive(env) {
  if (!fbConfigured(env)) return { ok: false, found: false, error: 'not configured' };
  try {
    const r = await graph(env, 'GET', `${env.FB_PAGE_ID}/videos`, { fields: 'live_status,title,created_time', limit: '15' });
    if (!r.ok) return { ok: false, found: false, error: r.error };
    const v = (r.data.data || []).find((x) => /^SCHEDULED_(UNPUBLISHED|LIVE)$/.test(x.live_status || ''));
    return { ok: true, found: !!v, title: v?.title || null };
  } catch (e) {
    return { ok: false, found: false, error: e.message };
  }
}

/** Split Facebook's rtmps://host:443/rtmp/<key> ingest URL into a Stream output { url, streamKey }. */
export function splitIngestUrl(ingestUrl) {
  if (!ingestUrl) return null;
  const idx = ingestUrl.lastIndexOf('/');
  if (idx < 0) return null;
  return { url: ingestUrl.slice(0, idx + 1), streamKey: ingestUrl.slice(idx + 1) };
}
