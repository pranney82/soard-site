/**
 * /reveals/ and /events/: what the reveal schedule shows on them, drawn on the way out from the schedule as it
 * is now, so nothing moves when the page script reads it after load.
 *
 *   /reveals/: the hero (the next live reveal, or the latest video), ./_reveals-hero.js
 *   both: the Coming up band and its "Get every reveal by email" card, ./_upcoming-band.js
 *
 * The schedule is the edge copy of /api/reveals the kid pages read (./_kid-reveal.js): it answers at once from
 * the edge, or from the last one this edge read, and only an edge that has never read one waits, briefly. One
 * that can't be read serves the page as built, and the page script brings it up to date as before. Times are in
 * the visitor's own zone as Cloudflare knows it, as the page script shows them.
 */

import { edgeSchedule } from './_kid-reveal.js';
import { fullPageRequest, PAGE_REUSE } from './_apply-bar.js';
import { onBands } from './_upcoming-band.js';
import { onRevealsHero } from './_reveals-hero.js';

const PAGES = { '/reveals/': { hero: true }, '/events/': { hero: false } };
const TZ = 'America/New_York';

/** The page with the schedule's parts drawn; anything but the whole HTML page passes through as it came.
 *  schedule: { upcoming, signup } as the page script reads /api/reveals */
export function drawSchedule(res, schedule, { hero, tz, origin }) {
  if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let rw = onBands(new HTMLRewriter(), schedule, tz);
  if (hero) rw = onRevealsHero(rw, schedule.upcoming, tz, origin, schedule.signup);
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  // It follows JobTread, not the build: never answered with the build's 304, reused for half a minute at most
  if (!/no-store|private/i.test(headers.get('Cache-Control') || '')) headers.set('Cache-Control', PAGE_REUSE);
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
}

export async function schedulePagesMiddleware(context) {
  const { request, next } = context;
  if (request.method !== 'GET') return next();
  const url = new URL(request.url);
  const page = PAGES[url.pathname];
  if (!page) return next();
  let schedule = null;
  try { schedule = await edgeSchedule(context); } catch { schedule = null; }
  if (!Array.isArray(schedule?.upcoming)) return next();
  // From here a fault serves the page as built, never an error page
  if (context.passThroughOnException) context.passThroughOnException();
  return drawSchedule(await next(fullPageRequest(request)), schedule, { hero: page.hero, tz: request.cf?.timezone || TZ, origin: url.origin });
}
