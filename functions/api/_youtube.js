/**
 * YouTube live check (Data API v3, API key only)
 * ==============================================
 * Answers "is the channel live on YouTube right now?" for the broadcast
 * monitor. Stream pushes to the channel's persistent stream key; YouTube
 * only goes live if Auto-start is on (or someone presses Go live), so the
 * simulcast output being "on" proves nothing by itself.
 *
 * Quota-cheap: the uploads playlist (1 unit) + videos.list (1 unit) per
 * check, cached ~25 s per isolate. search.list (100 units) is a fallback at
 * most every 5 minutes, for a live video the uploads playlist hasn't
 * listed yet.
 *
 * Env: YOUTUBE_API_KEY (Google Cloud → APIs & Services → YouTube Data API v3
 * → Credentials → API key). Read-only public data; no OAuth.
 */

const API = 'https://www.googleapis.com/youtube/v3';
const CACHE_MS = 25 * 1000;
const SEARCH_EVERY_MS = 5 * 60 * 1000;

const cache = new Map(); // channelId → { at, value }
const lastSearch = new Map(); // channelId → ms

export function youtubeConfigured(env) {
  return !!env.YOUTUBE_API_KEY;
}

async function yt(env, path, params) {
  const url = new URL(`${API}/${path}`);
  url.search = new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) return { ok: false, error: data.error?.message || `YouTube API returned ${res.status}`, status: res.status };
  return { ok: true, data };
}

/** What a channel URL points at: { id } for /channel/UC…, { handle } for /@name, else null. */
export function channelRef(url) {
  const s = String(url || '').trim();
  const id = s.match(/\/channel\/(UC[\w-]{22})/);
  if (id) return { id: id[1] };
  const handle = s.match(/\/(@[\w.-]+)/) || s.match(/^(@[\w.-]+)$/);
  if (handle) return { handle: handle[1] };
  return null;
}

/** Channel id (UC…) and title for the configured channel URL. */
export async function resolveChannel(env, channelUrl) {
  if (!youtubeConfigured(env)) return { ok: false, error: 'YOUTUBE_API_KEY is not set' };
  const ref = channelRef(channelUrl);
  if (!ref) return { ok: false, error: 'The YouTube channel URL needs to look like youtube.com/@handle or youtube.com/channel/UC…' };
  try {
    const r = await yt(env, 'channels', { part: 'id,snippet', ...(ref.id ? { id: ref.id } : { forHandle: ref.handle }) });
    if (!r.ok) return { ok: false, error: r.error };
    const ch = r.data.items?.[0];
    if (!ch) return { ok: false, error: `No YouTube channel found for ${ref.id || ref.handle}` };
    return { ok: true, id: ch.id, title: ch.snippet?.title || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function describe(v) {
  const d = v.liveStreamingDetails || {};
  return {
    videoId: v.id,
    title: v.snippet?.title || null,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    embed: `https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&mute=1`,
    viewers: d.concurrentViewers != null ? Number(d.concurrentViewers) : null,
    startedAt: d.actualStartTime || null,
    scheduledFor: d.scheduledStartTime || null,
  };
}

/**
 * The channel's current live broadcast, and any upcoming one waiting for video.
 * → { ok, live: {videoId,title,url,embed,viewers,startedAt} | null, upcoming: {...} | null, error }
 */
export async function liveNow(env, channelId, { fresh = false } = {}) {
  if (!youtubeConfigured(env)) return { ok: false, error: 'YOUTUBE_API_KEY is not set', live: null, upcoming: null };
  const hit = cache.get(channelId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value;
  try {
    const uploads = `UU${channelId.slice(2)}`;
    const items = await yt(env, 'playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '6' });
    if (!items.ok) throw new Error(items.error);
    const ids = (items.data.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    const vids = ids.length ? await yt(env, 'videos', { part: 'snippet,liveStreamingDetails', id: ids.join(',') }) : { ok: true, data: { items: [] } };
    if (!vids.ok) throw new Error(vids.error);
    let list = vids.data.items || [];
    let live = list.find((v) => v.snippet?.liveBroadcastContent === 'live');
    // A brand-new live can take a while to reach the uploads playlist; search is 100 units, so rarely
    if (!live && Date.now() - (lastSearch.get(channelId) || 0) > SEARCH_EVERY_MS) {
      lastSearch.set(channelId, Date.now());
      const s = await yt(env, 'search', { part: 'id', channelId, eventType: 'live', type: 'video', maxResults: '1' });
      const id = s.ok ? s.data.items?.[0]?.id?.videoId : null;
      if (id) {
        const v = await yt(env, 'videos', { part: 'snippet,liveStreamingDetails', id });
        if (v.ok && v.data.items?.[0]) { live = v.data.items[0]; list = [live, ...list]; }
      }
    }
    const upcoming = list.find((v) => v.snippet?.liveBroadcastContent === 'upcoming');
    value = { ok: true, live: live ? describe(live) : null, upcoming: upcoming ? describe(upcoming) : null, error: null };
  } catch (e) {
    value = { ok: false, live: null, upcoming: null, error: e.message };
  }
  cache.set(channelId, { at: Date.now(), value });
  return value;
}
