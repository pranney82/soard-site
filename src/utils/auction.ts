/**
 * auction.ts — single source of truth for the online bidding link.
 *
 * Lives in code (not src/content) on purpose: the content collections are
 * rebuilt from D1 by the prebuild step, so a JSON edit here would be clobbered
 * on the next build. Change the two constants below to retire or re-point the
 * auction; nothing else needs touching.
 *
 * BID_URL   — Qtego bidding portal for Evening of Sunshine.
 * BID_CLOSES — when the banner and CTAs stop showing. Bidding closes during
 *   the gala on the night of Aug 22 2026; this is midnight at the end of that
 *   day (Eastern), so nothing lingers as a dead link on Sunday morning.
 *
 * The cutoff is enforced twice: at build time (the banner is not emitted at
 * all once it has passed) and at runtime in the browser (the site is static
 * and CDN-cached, so a page built before the cutoff can still be served after
 * it — the inline script hides the bar in that case).
 */

export const BID_URL = 'https://qtego.us/l/soard/r';

/** Midnight ending Sat Aug 22 2026, Eastern (EDT, UTC-4). */
export const BID_CLOSES_ISO = '2026-08-23T00:00:00-04:00';

export const BID_CLOSES_MS = Date.parse(BID_CLOSES_ISO);

/** True while bidding should be promoted on the site. */
export function auctionIsOpen(now: number = Date.now()): boolean {
  return now < BID_CLOSES_MS;
}
