/**
 * A kid's reveal day, in the page before it arrives.
 *
 * Kid pages are built saying "Building"; the reveal date lives in JobTread
 * (/api/reveals) and changes without a rebuild. The page script used to fill it
 * in a moment after load ("Reveal Nov 20" on the badge, a "Reveal day" line
 * with Add to calendar under the details), which pushed the page down while
 * people were reading. Now the server puts the same words in on the way out,
 * from the same cached schedule the page script reads, and the script sees
 * they're there (data-reveal-shown) and leaves them.
 *
 * /kids/<slug>/: the hero badge and the reveal line. /kids/: the card badges.
 * The words come from src/utils/reveals-client.ts, so they're the page's own.
 *
 * Never holds a page for the schedule: the edge copy of /api/reveals answers
 * at once. Once those few minutes are up (most pages, on a site this size),
 * the last schedule this edge read answers instead, while a fresh one is
 * fetched for the next visitor. Only an edge that has never read one waits,
 * briefly; then the page goes out as built and the page script fills it in as
 * before. Anything that goes wrong serves the page as built.
 */

import { revealShortDate, revealWhen, windowShort, inviteData, possessive } from '../src/utils/reveals-client.ts';
import { fullPageRequest, PAGE_REUSE } from './_apply-bar.js';

const WAIT_MS = 350; // longest a page waits for a schedule the edge doesn't have yet
const LAST_KNOWN_TTL = 86400; // seconds the edge keeps the last schedule it read, for pages after the 3-minute copy expires
// The edge key that last schedule is kept under (the cache API only; no visitor request reads it)
const lastKnownKey = (url) => new Request(`${url}?edge=last-known`, { method: 'GET' });
const SLUG = /^[a-z0-9-]+$/;
const CALENDAR = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** "Reveal Nov 20", or "Reveal mid Nov" while only the third of the month is known */
export const badgeText = (r) => (r.confirmed ? `Reveal ${revealShortDate(r)}` : `Reveal ${windowShort(r.window).replace(/^\w/, (c) => c.toLowerCase())}`);

/** The line under a kid's details: the reveal day (to the live page) and Add to calendar */
export function revealLine(r) {
  const day = r.confirmed
    ? { text: `Reveal day: ${revealWhen(r, 'short')}`, aria: `${r.name}'s reveal day is ${revealWhen(r)}. Watch it live.` }
    : { text: `Reveal planned for ${r.window.label}`, aria: `${r.name}'s reveal is planned for ${r.window.label}, streamed live. See the live page.` };
  const invite = Object.entries(inviteData(r)).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return `<div class="hero__reveal"><a class="hero__reveal-day" href="${esc(r.liveUrl)}" aria-label="${esc(day.aria)}">${esc(day.text)}</a>`
    + `<button type="button" class="hero__reveal-add"${invite} aria-label="${esc(`Add to calendar: ${possessive(r.name)} reveal`)}">${CALENDAR(16)}<span>Add to calendar</span></button></div>`;
}

/** The schedule's upcoming reveals, as the page script reads them, or null when not known in time */
export async function upcomingReveals(context, waitMs = WAIT_MS) {
  const url = new URL('/api/reveals', context.request.url).toString();
  const read = (body) => {
    if (!body) return null;
    if (Array.isArray(body.upcoming)) return body.upcoming;
    return Array.isArray(body.reveals) ? body.reveals.map((r) => ({ ...r, confirmed: true, rooms: [] })) : null;
  };
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(new Request(url, { method: 'GET' })).catch(() => null);
    if (hit) { try { return read(await hit.json()); } catch { /* ask below */ } }
  }
  // The endpoint reads JobTread and keeps the answer at the edge; what it says is kept as the last known schedule too
  const ask = fetch(url, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).then(async (body) => {
    if (cache && body && body.source !== 'none' && read(body)) {
      await cache.put(lastKnownKey(url), Response.json(body, { headers: { 'Cache-Control': `public, max-age=${LAST_KNOWN_TTL}` } })).catch(() => {});
    }
    return read(body);
  }).catch(() => null);
  if (context.waitUntil) context.waitUntil(ask);
  // The last schedule this edge read: the page goes out now, and the next one has the fresh answer
  if (cache) {
    const last = await cache.match(lastKnownKey(url)).catch(() => null);
    if (last) { try { const known = read(await last.json()); if (known) return known; } catch { /* wait below */ } }
  }
  // An edge that has never read one waits only briefly
  return Promise.race([ask, new Promise((done) => setTimeout(() => done(null), waitMs))]);
}

/** The kid page or the kids list with the reveal days in it; anything else exactly as it came */
export function addReveals(res, { kid = null, cards = [] } = {}) {
  if ((!kid && !cards.length) || res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let rw = new HTMLRewriter();
  if (kid) {
    const line = revealLine(kid);
    const text = badgeText(kid);
    let completed = false;
    let placed = false;
    rw = rw
      .on('[data-kid-slug]', { element(el) { completed = el.getAttribute('data-kid-status') === 'completed'; if (!completed) el.setAttribute('data-reveal-shown', ''); } })
      .on('.hero__badge--building svg', { element(el) { if (!completed) el.replace(CALENDAR(16), { html: true }); } })
      .on('[data-kid-reveal-badge]', { element(el) { if (!completed) el.setInnerContent(text); } })
      .on('.hero__meta', { element(el) { if (!completed && !placed) { placed = true; el.after(line, { html: true }); } } });
  }
  for (const { slug, html } of cards.map((r) => ({ slug: r.slug, html: `${CALENDAR(14)}${esc(badgeText(r))}` }))) {
    rw = rw.on(`a.kid-card[href="/kids/${slug}/"] .kid-card__badge--building`, {
      element(el) { el.setAttribute('data-reveal', '1'); el.setInnerContent(html, { html: true }); },
    });
  }
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  // The words follow JobTread, not the build: never answered with the build's 304,
  // and reused for half a minute at most
  if (!/no-store|private/i.test(headers.get('Cache-Control') || '')) headers.set('Cache-Control', PAGE_REUSE);
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
}

/** /kids/ and /kids/<slug>/ (functions/kids/_middleware.js) */
export async function kidRevealMiddleware(context) {
  const { request, next } = context;
  if (request.method !== 'GET') return next();
  const path = new URL(request.url).pathname;
  const page = path.match(/^\/kids\/([^/]+)\/$/);
  if (path !== '/kids/' && !page) return next();
  let reveals = null;
  try { reveals = await upcomingReveals(context); } catch { reveals = null; }
  const usable = (reveals || []).filter((r) => r && SLUG.test(String(r.slug || '')) && (r.confirmed ? r.date : r.window?.label));
  const kid = page ? usable.find((r) => r.slug === page[1]) || null : null;
  const cards = page ? [] : usable;
  if (!kid && !cards.length) return next();
  if (context.passThroughOnException) context.passThroughOnException();
  return addReveals(await next(fullPageRequest(request)), { kid, cards });
}
