/**
 * /trade-partners/: what an insurance certificate has to show, in the page
 * before it arrives.
 *
 * The amounts are SOARD's minimums (Admin → Job Costs → W-9s & insurance),
 * kept in the database and changed without a rebuild, so the page script
 * listed them a moment after load and "Set up your account" grew three lines,
 * pushing the forms under it down. Now the server puts the same lines
 * (src/components/trade-partners/words.ts) in on the way out; the script's own
 * drawing then changes nothing, or puts them in Spanish for a Spanish visitor.
 * It also marks the quick check's box (data-on) when the check is switched on,
 * so the page keeps its room from the start instead of growing 92px when
 * Cloudflare draws it.
 *
 * The minimums are read from the database about every 5 minutes per edge, and
 * the page never waits on that more than 300 ms. If they can't be read in time,
 * the page goes out as built and the script fills the list as before. Every
 * other page under /trade-partners/ passes straight through.
 */

import { requirementLines } from '../../src/components/trade-partners/words.ts';
import { DEFAULTS } from '../api/_vendor-defaults.js';
import { fullPageRequest, PAGE_REUSE } from '../_apply-bar.js';
import { turnstileOn } from '../api/_secure.js';

const TTL = 300; // seconds an edge keeps the minimums: a change in admin reaches this page this soon
const WAIT_MS = 300; // longest the page waits on the database; then it goes out as built
const HOLDER = 'Sunshine on a Ranney Day';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** SOARD's minimums, as /api/trade-partner?config gives them (the saved ones over the defaults) */
export async function minimums(context) {
  const { env, request } = context;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = cache ? new Request(new URL('/api/trade-partner?edge=minimums', request.url).toString(), { method: 'GET' }) : null;
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) { try { return await hit.json(); } catch { /* read it fresh */ } }
  }
  if (!env.DB) return null;
  // Only the settings, not the whole vendor record they're kept in
  const row = await env.DB.prepare("SELECT json_extract(data, '$.docSettings') AS s FROM spend_state WHERE key = 'vendors'").first();
  const m = { ...DEFAULTS, ...(row?.s ? JSON.parse(row.s) : {}) };
  if (cache) {
    const put = cache.put(key, Response.json(m, { headers: { 'Cache-Control': `public, max-age=${TTL}, s-maxage=${TTL}` } })).catch(() => {});
    if (context.waitUntil) context.waitUntil(put);
  }
  return m;
}

/** The page with the list filled in (and the quick check's room kept when it's on). Anything but the whole HTML page passes through as it came. */
export function fillRequirements(res, lines, { turnstile = false } = {}) {
  if (!lines?.length || res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let rw = new HTMLRewriter()
    .on('#tp-reqs', { element(el) { el.setInnerContent(lines.map((l) => `<li>${esc(l)}</li>`).join(''), { html: true }); } });
  if (turnstile) rw = rw.on('#tp-turnstile', { element(el) { el.setAttribute('data-on', ''); } });
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  // Built from today's minimums: never answered with a 304 for an older copy, reused for half a minute at most
  headers.set('Cache-Control', PAGE_REUSE);
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
}

export async function onRequest(context, wait = WAIT_MS) {
  const { request, next } = context;
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/trade-partners/') return next();
  let lines = null;
  try {
    const m = await Promise.race([minimums(context), new Promise((ok) => setTimeout(() => ok(null), wait))]);
    lines = m && requirementLines(m, HOLDER, 'en');
  } catch { lines = null; }
  if (!lines) return next();
  // From here a fault serves the page as built, never an error page
  if (context.passThroughOnException) context.passThroughOnException();
  return fillRequirements(await next(fullPageRequest(request)), lines, { turnstile: turnstileOn(context.env) });
}
