/**
 * GET /api/live-gifts — the running total of gifts during the current reveal
 * ==========================================================================
 * Public: { ok, configured, broadcastId, cents, count, lastEventAt }.
 * configured: Zeffy is connected (the live page shows nothing until it is).
 * Totals are for the reveal that is on now (or just ended), from
 * _live-gifts.js. Cached at the edge for 10 seconds, since every viewer of
 * a busy reveal polls this when the real-time hub can't push it.
 */

import { readState, readConfig } from './_broadcast.js';
import { totalsFor, readMeta, broadcastFor } from './_live-gifts.js';

export async function onRequestGet({ request, env, waitUntil }) {
  const headers = { 'Content-Type': 'application/json' };
  if (!env.DB) return new Response(JSON.stringify({ ok: false }), { status: 500, headers });
  const cache = caches.default;
  const key = new Request(new URL('/api/live-gifts', request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const [state, config, meta] = await Promise.all([readState(env.DB), readConfig(env.DB), readMeta(env.DB)]);
  const broadcastId = broadcastFor(state, Date.now());
  const totals = await totalsFor(env.DB, broadcastId);
  const res = new Response(JSON.stringify({
    ok: true,
    configured: !!config.zeffy?.webhookSecret,
    broadcastId,
    ...totals,
    lastEventAt: meta.lastEventAt || null,
  }), { headers: { ...headers, 'Cache-Control': 'public, max-age=10' } });
  const put = cache.put(key, res.clone());
  if (waitUntil) waitUntil(put); else await put;
  return res;
}
