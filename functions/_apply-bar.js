/**
 * The application bar: the strip above the menu that says the family
 * application is open (src/components/global/ApplicationBar.astro).
 *
 * Every page carries an empty, hidden bar. On the pages about SOARD, the
 * server fills it in on the way out while the switch in Admin → Applications
 * → Settings is on, so it's there from the first paint and nothing below it
 * moves. Those pages run this through a small `_middleware.js` in their own
 * folder (functions/kids/, functions/about/, …, and functions/index.js for the
 * home page); /live/ runs it from functions/live/[[path]].js, and only while no
 * reveal is starting or live. Pages where someone is doing something (Apply,
 * Donate, a partner's sign-up, the advisor application, a profile update) have
 * no folder here, and the skip list below keeps them out anyway.
 *
 * Closing it by hand, at the close date or at the application limit all turn
 * the same switch off, so the next page anyone loads has no bar. A page left
 * open drops it within about a minute (the page script asks /api/application-open).
 *
 * The X is remembered for the season: in the browser (checked before the bar
 * paints) and in a cookie the server reads, set by /api/application-bar-closed.
 *
 * Anything that goes wrong serves the page exactly as it was built: the bar
 * stays hidden. Everything the page needs is worked out before the page starts
 * streaming, so nothing can fail halfway through it.
 */

import { cleanYear } from './api/_application-year.js';

export const BAR_COOKIE = 'soard_apply_bar';
export const BAR_STORAGE_KEY = 'soard-application-dismissed';
const STATE_TTL = 30; // seconds the edge keeps the answer: a close reaches new pages this soon
/**
 * How a page this server filled in may be kept: by this visitor's browser only,
 * for half a minute. That's what lets a click show the copy the link fetched on
 * hover (Astro's prefetch) instead of asking the server again. With no-cache the
 * prefetch was thrown away and every click waited on a second full request. The
 * bar's own before-swap check still hides a bar closed since (ApplicationBar.astro).
 */
export const PAGE_REUSE = 'private, max-age=30';
const ZONE = 'America/New_York';

// Doing something, not reading about SOARD: never a bar here
const SKIP = [/^\/apply(\/|$)/, /^\/donate(\/|$)/, /^\/trade-partners(\/|$)/, /^\/advisory-board\/apply(\/|$)/, /^\/profile-update(\/|$)/, /^\/admin(\/|$)/, /^\/api(\/|$)/];
export const barSkips = (path) => SKIP.some((re) => re.test(String(path || '/')));

/** The close day as people read it, in Atlanta's time: a midnight close is the day before. null without one. */
export function closeDay(closesAt, now = Date.now()) {
  const at = Date.parse(closesAt || '');
  if (!Number.isFinite(at) || at <= now) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const day = Number(parts.hour) === 0 && Number(parts.minute) === 0 ? new Date(at - 60_000) : new Date(at);
  const fmt = (month) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, month, day: 'numeric' }).format(day);
  return { long: fmt('long'), short: fmt('short') };
}

/** What the bar says for an open season */
export function barWords({ year, closesAt }, now = Date.now()) {
  const close = closeDay(closesAt, now);
  const msg = `Now open for room makeovers in the greater Atlanta area${close ? `, through ${close.long}` : ''}.`;
  return {
    year: String(year),
    label: `${year} application`,
    msg,
    short: close ? `Open through ${close.short}` : 'Now open',
    aria: `${year} application. ${msg} Apply.`,
  };
}

/** Whether this visitor closed the bar for this season (the cookie /api/application-bar-closed sets) */
export function barDismissed(request, year) {
  const cookie = request.headers.get('Cookie') || '';
  return cookie.split(';').some((c) => c.trim() === `${BAR_COOKIE}=${year}`);
}

/**
 * Open or closed, the season, and the close time, read about twice a minute
 * however busy the site is. /api/application-open answers from this too.
 * A database that can't be read throws (and nothing is kept): not knowing
 * isn't "closed", so open pages keep their bar and new ones go without it.
 */
export async function applicationState(context) {
  const { env, request } = context;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = cache ? new Request(new URL('/api/application-open?state=1', request.url).toString(), { method: 'GET' }) : null;
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) { try { return await hit.json(); } catch { /* read it fresh */ } }
  }
  let app = {};
  if (env.DB) {
    const row = await env.DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first();
    try { app = JSON.parse(row?.data || '{}')?.application || {}; } catch { app = {}; }
  }
  const state = { open: app.open === true, year: cleanYear(app.year), closesAt: app.closesAt ? String(app.closesAt) : '' };
  if (cache) {
    const res = Response.json(state, { headers: { 'Cache-Control': `public, max-age=${STATE_TTL}, s-maxage=${STATE_TTL}` } });
    const put = cache.put(key, res).catch(() => {});
    if (context.waitUntil) context.waitUntil(put);
  }
  return state;
}

/** The bar's words for this visitor on this page, or null for no bar */
export async function barFor(context, path) {
  if (barSkips(path)) return null;
  const state = await applicationState(context);
  if (!state.open || barDismissed(context.request, state.year)) return null;
  return barWords(state);
}

/** The request with no "is my copy still good?" question, so a bar never comes back from an old copy */
export function fullPageRequest(request) {
  const fresh = new Request(request);
  fresh.headers.delete('If-None-Match');
  fresh.headers.delete('If-Modified-Since');
  return fresh;
}

/** The page with the bar filled in. Anything but a whole HTML page passes through as it came. */
export function addBar(res, w) {
  if (!w || res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  const text = (value) => ({ element(el) { el.setInnerContent(value); } });
  const out = new HTMLRewriter()
    .on('#apply-bar', { element(el) { el.removeAttribute('hidden'); el.setAttribute('data-year', w.year); } })
    .on('#apply-bar .apply-bar__link', { element(el) { el.setAttribute('aria-label', w.aria); } })
    .on('#apply-bar .apply-bar__label', text(w.label))
    .on('#apply-bar .apply-bar__msg', text(w.msg))
    .on('#apply-bar .apply-bar__short', text(w.short))
    .on('script[data-apply-bar]', { element(el) { el.setAttribute('data-year', w.year); } })
    .transform(res);
  const headers = new Headers(out.headers);
  // This copy is this visitor's: never stored for others, never answered with a 304,
  // reused for half a minute at most (a page that already says never store it, like
  // /live/ for a reveal, keeps saying so)
  if (!/no-store/i.test(headers.get('Cache-Control') || '')) headers.set('Cache-Control', PAGE_REUSE);
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
}

/** For the pages about SOARD: the folder middlewares and the home page all use this */
export async function applyBarMiddleware(context) {
  const { request, next } = context;
  if (request.method !== 'GET') return next();
  const path = new URL(request.url).pathname;
  if (barSkips(path)) return next();
  let words = null;
  try { words = await barFor(context, path); } catch { words = null; }
  if (!words) return next();
  // From here a fault serves the page as built, never an error page
  if (context.passThroughOnException) context.passThroughOnException();
  return addBar(await next(fullPageRequest(request)), words);
}
