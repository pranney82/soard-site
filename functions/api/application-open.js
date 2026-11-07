/**
 * GET /api/application-open (public): is the family application open right now?
 * The floating banner on every page reads this (LiveIndicator.astro), so the
 * switch in Admin → Applications → Settings reaches the whole site with no Publish.
 *
 * → { open: true, year: '2027' }
 *
 * Only those two fields ever leave here. Every page asks, so the edge answers for
 * EDGE_TTL seconds and the database is read about twice a minute however busy it gets.
 * Closing by hand, at the close date (the heartbeat, every minute) or at the application
 * limit all turn the same switch off, so the banner leaves within about a minute of any of them.
 */

import { applicationSettings, cleanYear } from './_applications.js';

const EDGE_TTL = 30;
const BROWSER_TTL = 30;

export async function onRequestGet(context) {
  const { env, request } = context;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/application-open', request.url).toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  const app = env.DB ? await applicationSettings(env.DB) : {};
  const res = Response.json({ open: app.open === true, year: cleanYear(app.year) }, {
    headers: { 'Cache-Control': `public, max-age=${BROWSER_TTL}, s-maxage=${EDGE_TTL}` },
  });
  if (cache) context.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}
