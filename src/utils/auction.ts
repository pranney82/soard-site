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

/* ────────────────────────────────────────────────────────────────
   Catalog snapshot
   ────────────────────────────────────────────────────────────────
   Taken from the live Qtego catalog. Item names and descriptions are
   stable for the run of the auction, so they are safe to render from a
   static build. Current bids deliberately are NOT mirrored here: they
   move all night, and a stale "current bid" on a CDN-cached page is
   worse than showing none at all. Anyone who wants live numbers taps
   through to Qtego, which is the point of the CTA.

   This lives in code rather than src/content because the content
   collections are rebuilt from D1 at prebuild, which would clobber it.
   ──────────────────────────────────────────────────────────────── */

export const AUCTION_ITEM_COUNT = 72;

export interface AuctionCategory { name: string; count: number; icon: string }

export const AUCTION_CATEGORIES: AuctionCategory[] = [
  { name: 'Sports & Tickets',    count: 14, icon: 'ticket'   },
  { name: 'Getaways',            count: 6,  icon: 'beach'    },
  { name: 'Food, Wine & Spirits',count: 15, icon: 'grill'    },
  { name: 'Home & Jewelry',      count: 24, icon: 'gem'      },
  { name: 'Family Fun',          count: 6,  icon: 'family'   },
  { name: 'Wellness & Services', count: 7,  icon: 'wellness' },
];

export type AuctionTone = 'sport' | 'escape' | 'rare';
export type AuctionIcon = 'trophy' | 'ticket' | 'water' | 'beach' | 'plane';

export interface AuctionHighlight {
  /** Real Qtego lot number. Catalogs lead with these; so do we. */
  lot: string;
  name: string;
  detail: string;
  tone: AuctionTone;
  icon: AuctionIcon;
  /** Marquee lots get double width and a larger panel on wide screens. */
  hero?: boolean;
}

export const AUCTION_HIGHLIGHTS: AuctionHighlight[] = [
  { lot: '505', name: 'Falcons VIP Suite',     tone: 'sport',  icon: 'trophy', hero: true,
    detail: 'Two suite tickets to Falcons vs. Panthers, with food, drinks and parking' },
  { lot: '606', name: 'Delta Bar Cart',        tone: 'rare',   icon: 'plane',  hero: true,
    detail: 'A one-of-a-kind Delta galley cart rebuilt as a custom home bar' },
  { lot: '510', name: 'SEC Championship',      tone: 'sport',  icon: 'ticket',
    detail: 'Two tickets, December in Atlanta' },
  { lot: '202', name: 'A Week on Lake Lanier', tone: 'escape', icon: 'water',
    detail: 'Seven nights at Covenant Cove' },
  { lot: '203', name: 'Myrtle Beach',          tone: 'escape', icon: 'beach',
    detail: 'Seven nights oceanfront, sleeps ten' },
  { lot: '607', name: 'Boeing 737 Fan Blade',  tone: 'rare',   icon: 'plane',
    detail: 'Titanium jet engine blade off a Delta 737' },
];

/** Short, concrete teaser for the site-wide bar. */
export const AUCTION_TEASER = 'Falcons suites, SEC Championship, beach weeks';

