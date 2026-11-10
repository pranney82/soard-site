/**
 * POST /api/live-watch — "this browser watched N more seconds" (public)
 * =====================================================================
 * { broadcastId, vid, kind: 'live'|'replay', sec, who?, src?, ref? } → 204.
 * The live page sends it while the reveal or its replay actually plays with
 * the tab showing: every 20 s live, every 60 s on the replay, and once more
 * when it stops. Reveal stats (_reveal-stats.js) adds the seconds to that
 * browser's row for the reveal, capped at the time since its last report.
 *
 * Its own path, outside the beacon rate limit (60 posts per 10 s per address),
 * because a whole watch party shares one house Wi-Fi. Whether a report is
 * live or replay is the broadcast's call, not the page's; anything for a
 * broadcast we never had is dropped. Bots are dropped; staff and tests are
 * kept apart and never counted.
 */

import { readState, ensureSchema } from './_broadcast.js';
import { ensureStatsSchema, visitor, recordWatch, watchKind } from './_reveal-stats.js';

const BROADCAST_ID = /^live-\d{1,16}$/;
const STATE_CACHE_MS = 3000;
let cached = { at: 0, state: null };
const KNOWN_MS = 60 * 1000;
const known = new Map(); // broadcastId → { row: { ended_at, live_at }, at } for past broadcasts (a replay page), kept a minute

const done = () => new Response(null, { status: 204 });

async function currentState(DB) {
  if (cached.state && Date.now() - cached.at < STATE_CACHE_MS) return cached.state;
  const state = await readState(DB);
  cached = { at: Date.now(), state };
  return state;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body = {};
  try { body = await request.json(); } catch { return done(); }
  if (!body || typeof body !== 'object') return done();
  const broadcastId = typeof body.broadcastId === 'string' && BROADCAST_ID.test(body.broadcastId) ? body.broadcastId : null;
  const claimed = body.kind === 'live' || body.kind === 'replay' ? body.kind : null;
  const sec = Number(body.sec);
  if (!broadcastId || !claimed || !(sec > 0)) return done();
  const who = visitor(request, body);
  if (who.drop || !who.vid) return done();
  try {
    await ensureSchema(env.DB);
    await ensureStatsSchema(env.DB);
    const state = await currentState(env.DB);
    const current = state.broadcastId === broadcastId ? state : null;
    if (current?.test) return done(); // a rehearsal (JobTread TEST job) is never the public's
    let row = null;
    if (!current) {
      const hit = known.get(broadcastId);
      row = hit && Date.now() - hit.at < KNOWN_MS ? hit.row : await env.DB.prepare('SELECT live_at, ended_at FROM broadcasts WHERE id = ?').bind(broadcastId).first();
      if (!row) return done();
      if (known.size > 50) known.clear();
      known.set(broadcastId, { row, at: hit && hit.row === row ? hit.at : Date.now() });
    }
    const now = Date.now();
    const kind = watchKind(claimed, { current, endedAt: row?.ended_at || null, now });
    if (!kind) return done();
    await recordWatch(env.DB, { broadcastId, vid: who.vid, kind, sec, liveAt: current?.liveAt || row?.live_at || null, who: who.who, src: who.src, now });
  } catch { /* counting only */ }
  return done();
}
