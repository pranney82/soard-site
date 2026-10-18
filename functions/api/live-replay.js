/**
 * GET /api/live-replay — what the live page's replay player needs besides the video
 * =================================================================================
 * Public, for the current replay only (never an arbitrary video, so this is
 * not an open door onto the Stream API):
 *
 *   GET          → { ok, uid, revealAt, captions }
 *                  revealAt: seconds into the recording where the child first
 *                  sees the room (null until known, or when unsure)
 *                  captions: an English caption track is ready
 *   GET ?vtt=en  → that track as WebVTT, cached at the edge for an hour
 *
 * The reveal moment comes from the Instagram Reel pipeline when it found one
 * (state.reel: the admin's override, or captions + Workers AI). Reveals short
 * enough to post whole skip that pipeline's caption step, so otherwise this
 * works the moment out itself from Stream's captions with the same detection,
 * once, and keeps it in site_config under replay-meta:<uid>. If the recording
 * has no English captions yet it asks Stream to generate them, once. At most
 * one viewer every two minutes triggers any Stream call; everyone else reads
 * the stored answer.
 */

import { readState as readFullState, visibleState } from './_broadcast.js';

const readState = (DB) => readFullState(DB).then(visibleState);
import { parseVtt, detectByKeywords, detectByAi, chooseMoment } from './_broadcast-reel.js';
import * as stream from './_stream-live.js';

const RECHECK_MS = 2 * 60 * 1000;
const metaKey = (uid) => `replay-meta:${uid}`;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/** A moment worth jumping to: the admin said so, two methods agree, or the keywords are strong. */
export function trustedMoment(m) {
  if (!m || m.seconds == null || !Number.isFinite(Number(m.seconds))) return null;
  if (m.method === 'override' || m.method === 'captions+ai' || (Number(m.confidence) || 0) >= 0.5) return Math.max(0, Math.round(Number(m.seconds)));
  return null;
}

/** The Reel pipeline's answer for this recording, if it has one. */
export function reelMoment(state, uid) {
  const r = state?.reel;
  if (!r || r.sourceUid !== uid) return null;
  if (r.overrideSeconds != null) return trustedMoment({ seconds: r.overrideSeconds, method: 'override' });
  return trustedMoment({ seconds: r.momentSeconds, method: r.method, confidence: r.confidence });
}

async function readMeta(DB, uid) {
  try {
    const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(metaKey(uid)).first();
    return row?.data ? JSON.parse(row.data) : {};
  } catch { return {}; }
}

async function writeMeta(DB, uid, meta) {
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(metaKey(uid), JSON.stringify(meta), new Date().toISOString()).run();
}

/** One look at Stream: caption status, and the reveal moment once captions exist. Never throws. */
async function refresh(env, uid, meta, needMoment) {
  const next = { ...meta, checkedAt: new Date().toISOString() };
  try {
    const list = await stream.listCaptions(env, uid);
    const tracks = Array.isArray(list.result) ? list.result : [];
    const en = tracks.find((t) => (t.language || '').startsWith('en'));
    if (!en) {
      next.captions = 'requested';
      if (!meta.requestedAt) { await stream.requestCaptions(env, uid); next.requestedAt = next.checkedAt; }
    } else if (en.status && en.status !== 'ready') {
      next.captions = en.status === 'error' ? 'error' : 'requested';
    } else {
      next.captions = 'ready';
      next.language = en.language || 'en';
      if (needMoment && !meta.detectedAt) {
        const vtt = await stream.getCaptionsVtt(env, uid, next.language);
        const cues = parseVtt(vtt);
        if (cues.length) {
          const duration = cues[cues.length - 1].end;
          const pick = chooseMoment(detectByKeywords(cues), await detectByAi(env, cues, duration));
          next.moment = pick ? { seconds: pick.seconds, method: pick.method, confidence: pick.confidence } : null;
          next.detectedAt = next.checkedAt;
        }
      }
    }
  } catch { /* try again next time */ }
  return next;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return json({ ok: false, error: 'Not configured' }, 500);
  const url = new URL(request.url);
  const state = await readState(env.DB);
  const uid = state.phase === 'replay' ? state.replayUid : null;

  if (url.searchParams.has('vtt')) {
    if (!uid || !stream.streamConfigured(env)) return new Response('Not found', { status: 404 });
    const lang = /^[a-z]{2}(-[A-Za-z]{2})?$/.test(url.searchParams.get('vtt') || '') ? url.searchParams.get('vtt') : 'en';
    const cache = caches.default;
    const key = new Request(`${url.origin}/api/live-replay?vtt=${lang}&uid=${encodeURIComponent(uid)}`);
    const hit = await cache.match(key);
    if (hit) return hit;
    const vtt = await stream.getCaptionsVtt(env, uid, lang);
    if (!vtt) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const res = new Response(vtt, { headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    context.waitUntil(cache.put(key, res.clone()));
    return res;
  }

  if (!uid) return json({ ok: true, uid: null, revealAt: null, captions: false });

  const fromReel = reelMoment(state, uid);
  let meta = await readMeta(env.DB, uid);
  const settled = meta.captions === 'ready' && (fromReel != null || meta.detectedAt) || meta.captions === 'error';
  const due = !meta.checkedAt || Date.now() - Date.parse(meta.checkedAt) > RECHECK_MS;
  if (!settled && due && stream.streamConfigured(env)) {
    meta = await refresh(env, uid, meta, fromReel == null);
    try { await writeMeta(env.DB, uid, meta); } catch { /* answer anyway */ }
  }
  return json({
    ok: true,
    uid,
    revealAt: fromReel ?? trustedMoment(meta.moment),
    captions: meta.captions === 'ready',
  });
}
