/**
 * GET /api/reveals (public) — confirmed upcoming reveals for the kid pages
 * and the events page. See ./_reveals.js for where the dates come from.
 *
 * → { reveals: [{ slug, name, startsAt, date, time, image, kidUrl, liveUrl }],
 *     updatedAt, source: 'jobtread' | 'cache' | 'none', error? }
 *
 * Cached at the edge for EDGE_TTL seconds so visitors never wait on JobTread;
 * a reveal confirmed in JobTread shows up within a few minutes, no deploy.
 */

import { getReveals } from './_reveals.js';
import { maybeSweep } from './_reveal-invites.js';

const EDGE_TTL = 180;
const BROWSER_TTL = 60;

export async function onRequestGet(context) {
  const { env, request } = context;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/reveals', request.url).toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  const body = await getReveals(env);
  // Reveal invites safety net: re-check every open job every few hours, after
  // the response, so a missed JobTread webhook can't leave an invite stale
  context.waitUntil(maybeSweep(env));
  // Only a fresh read is worth holding for the full TTL; a fallback gets a short one
  const ttl = body.source === 'jobtread' ? EDGE_TTL : 30;
  const res = Response.json(body, {
    headers: {
      'Cache-Control': `public, max-age=${Math.min(BROWSER_TTL, ttl)}, s-maxage=${ttl}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
  if (cache) context.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}
