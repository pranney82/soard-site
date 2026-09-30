/**
 * GET /api/stream-videos — browse the Cloudflare Stream library from the admin
 * ============================================================================
 * Powers "Choose from Stream" in the kid, event and community editors, so a
 * video already in Stream (a live reveal recording, an archived Facebook
 * replay, something uploaded elsewhere) can be linked without having the
 * file on this computer.
 *
 * Query: ?search=<text in the video name>  ?before=<ISO created date, for the next page>
 * Returns: { success, videos: [{ uid, name, created, duration, state, ready,
 *            thumbnail, watch, usedBy: [{ type, slug, name, field }] }], next }
 *
 * Authenticated via Cloudflare Access (middleware default — not public).
 * Env: CF_ACCOUNT_ID, CF_STREAM_TOKEN
 */

import * as stream from './_stream-live.js';

const PAGE = 36;

/** Which kid / event / community pages already point at each Stream uid. */
async function usageMap(DB) {
  const map = {};
  const add = (uid, entry) => { if (uid) (map[uid] ||= []).push(entry); };
  const uidOf = (url) => (url ? String(url).split('/').filter(Boolean).pop() : null);
  const sources = [
    ['kid', 'SELECT slug, name, data FROM kids'],
    ['event', 'SELECT slug, title AS name, data FROM events'],
    ['community', 'SELECT slug, name, data FROM community'],
  ];
  for (const [type, sql] of sources) {
    try {
      const rows = (await DB.prepare(sql).all()).results || [];
      for (const r of rows) {
        let d = {};
        try { d = JSON.parse(r.data || '{}'); } catch { /* skip */ }
        add(d.streamVideoId, { type, slug: r.slug, name: r.name, field: 'video' });
        if (type === 'kid') add(uidOf(d.revealVideoUrl), { type, slug: r.slug, name: r.name, field: 'reveal' });
      }
    } catch { /* table missing locally — usage is a hint only */ }
  }
  return map;
}

export async function onRequestGet(context) {
  const { env } = context;
  try {
    if (!stream.streamConfigured(env)) {
      return Response.json({ success: false, error: 'CF_ACCOUNT_ID / CF_STREAM_TOKEN not configured' }, { status: 500 });
    }
    const url = new URL(context.request.url);
    const search = (url.searchParams.get('search') || '').trim().slice(0, 100);
    const before = url.searchParams.get('before') || '';
    const qs = new URLSearchParams({ limit: String(PAGE + 1), include_counts: 'false' });
    if (search) qs.set('search', search);
    if (before && !Number.isNaN(Date.parse(before))) qs.set('end', before);

    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream?${qs}`, {
      headers: { Authorization: `Bearer ${env.CF_STREAM_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok || data.success === false) {
      const r = { status: res.status, errors: data.errors || [{ message: `Stream API returned ${res.status}` }] };
      return Response.json({ success: false, error: stream.errorMessage(r) }, { status: 500 });
    }

    const all = (data.result || []).filter((v) => !v.isInput && v.status?.state !== 'live-inprogress');
    const pageRows = all.slice(0, PAGE);
    const used = await usageMap(env.DB);
    const code = stream.DEFAULT_CUSTOMER_CODE;
    const videos = pageRows.map((v) => ({
      uid: v.uid,
      name: v.meta?.name || null,
      created: v.created || null,
      duration: v.duration > 0 ? v.duration : null,
      state: v.status?.state || null,
      ready: !!v.readyToStream,
      thumbnail: v.thumbnail || stream.thumbnailUrl(code, v.uid, { width: 320, height: 180 }),
      watch: stream.watchUrl(v.uid),
      usedBy: used[v.uid] || [],
    }));
    const next = all.length > PAGE && pageRows.length ? pageRows[pageRows.length - 1].created : null;
    return Response.json({ success: true, videos, next }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502/504 bodies with its own HTML page.
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
