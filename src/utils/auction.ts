/**
 * auction.ts — single source of truth for the online bidding link.
 *
 * Lives in code (not src/content) on purpose: the content collections are
 * rebuilt from D1 by the prebuild step, so a JSON edit here would be clobbered
 * on the next build. Change the two constants below to retire or re-point the
 * auction; nothing else needs touching.
 *
 * BID_URL    — Qtego bidding portal for Evening of Sunshine.
 * BID_CLOSES — when bidding ends. Doubles as the retirement time for every
 *   bid CTA on the site, so nothing lingers as a dead link afterwards.
 *
 * The cutoff is enforced twice: at build time (CTAs are not emitted at all
 * once it has passed) and at runtime in the browser (the site is static and
 * CDN-cached, so a page built before the cutoff can still be served after it).
 */

export const BID_URL = 'https://qtego.us/l/soard/r';

/** Bidding closes 10:00 PM Sat Aug 22 2026, Eastern (EDT, UTC-4). */
export const BID_CLOSES_ISO = '2026-08-22T22:00:00-04:00';

export const BID_CLOSES_MS = Date.parse(BID_CLOSES_ISO);

/** True while bidding should be promoted on the site. */
export function auctionIsOpen(now: number = Date.now()): boolean {
  return now < BID_CLOSES_MS;
}

/**
 * Absolute phrasing of the close time, e.g. "Saturday at 10 PM".
 *
 * Rendered server-side rather than a relative countdown because pages are
 * CDN-cached: a baked-in "closes in 4h" goes stale, an absolute time never
 * does. The browser upgrades this to a live countdown on load.
 */
export function bidClosesLabel(): string {
  const d = new Date(BID_CLOSES_MS);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const minute = get('minute');
  const time = minute === '00'
    ? `${get('hour')} ${get('dayPeriod')}`
    : `${get('hour')}:${minute} ${get('dayPeriod')}`;
  return `${get('weekday')} at ${time}`;
}
